import { Router } from 'express';
import { pool } from '../../db.js';
import { IPSecurity } from '../../utils/securityUtils.js';
import { 
  VerificationService, 
  generateVerificationCode, 
  generateVerificationToken,
  getCodeExpiration 
} from '../../middleware/emailService.js';
import { hashToken } from '../../utils/hashToken.js';
import { hashEmailVerificationCode } from '../../utils/emailVerificationSecurity.js';

const router = Router();

router.post('/', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ 
      success: false, 
      message: 'Email is required' 
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Find user
    const userResult = await client.query(
      'SELECT id, email, is_verified FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.json({
        success: true,
        message: 'If that email needs verification, a new code has been sent.'
      });
    }

    const user = userResult.rows[0];
    const userId = user.id;

    // 2. Check if already verified
    if (user.is_verified) {
      await client.query('ROLLBACK');
      return res.json({
        success: true,
        message: 'If that email needs verification, a new code has been sent.'
      });
    }

    const existingTokenResult = await client.query(
      'SELECT 1 FROM email_verifications WHERE user_id = $1',
      [userId]
    );
    const verificationToken = generateVerificationToken();
    const verificationTokenHash = hashToken(verificationToken);

    // 5. Generate new code using emailService
    const code = generateVerificationCode();
    const expiresAt = getCodeExpiration();

    // 6. UPSERT: Update or insert
    if (existingTokenResult.rows.length > 0) {
      await client.query(
        `UPDATE email_verifications 
         SET code = $1, expires_at = $2 
         WHERE user_id = $3`,
        [hashEmailVerificationCode(userId, code), expiresAt, userId]
      );
      await client.query(
        `UPDATE email_verifications
         SET token = $1
         WHERE user_id = $2`,
        [verificationTokenHash, userId]
      );
    } else {
      await client.query(
        `INSERT INTO email_verifications (user_id, code, token, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [userId, hashEmailVerificationCode(userId, code), verificationTokenHash, expiresAt]
      );
    }

    // 7. Send email
    const frontUrl = process.env.FRONT_URL || 'https://void0000.online';
    const verificationUrl = `${frontUrl}/auth?view=email-verification&vtoken=${verificationToken}`;
    await VerificationService.sendVerificationEmail(email, code, verificationUrl);

    await client.query('COMMIT');

    await IPSecurity.logIPActivity(req, 'RESEND_VERIFICATION_SUCCESS', userId);

    // 8. Return token
    res.json({
      success: true,
      message: 'If that email needs verification, a new code has been sent.'
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Resend verification error:', err);
    await IPSecurity.logIPActivity(req, 'RESEND_VERIFICATION_ERROR');
    res.status(500).json({ 
      success: false, 
      message: 'Failed to resend verification' 
    });
  } finally {
    client.release();
  }
});

export default router;
