import { Router } from 'express';
import { pool } from '../../db.js';
import { randomBytes } from 'crypto';
import { IPSecurity } from '../../utils/securityUtils.js';
import { sendPasswordResetEmail } from '../../middleware/emailService.js';
import { hashToken } from '../../utils/hashToken.js';

const router = Router();
const GENERIC_SUCCESS_MESSAGE = 'If that email exists, a reset link has been sent.';

router.post('/', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    await IPSecurity.logIPActivity(req, 'PASSWORD_RESET_FAILURE_MISSING_EMAIL');
    return res.status(400).json({ success: false, message: 'Email is required' });
  }

  try {
    // CHECK IF USER EXISTS
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);

    if (userResult.rows.length === 0) {
      await IPSecurity.logIPActivity(req, 'PASSWORD_RESET_ATTEMPT_UNKNOWN_EMAIL');
      return res.json({
        success: true,
        message: GENERIC_SUCCESS_MESSAGE
      });
    }

    const user_id = userResult.rows[0].id;

    // CHECK FOR RECENT RESET ATTEMPTS BY USER (prevents spamming one user's inbox)
    const recentUserAttempt = await pool.query(
      `SELECT created_at FROM password_resets 
       WHERE user_id = $1 
       AND created_at > NOW() - INTERVAL '1 hour'
       ORDER BY created_at DESC LIMIT 1`,
      [user_id]
    );

    if (recentUserAttempt.rows.length > 0) {
      await IPSecurity.logIPActivity(req, 'PASSWORD_RESET_FAILURE_USER_COOLDOWN', user_id);
      return res.json({
        success: true,
        message: GENERIC_SUCCESS_MESSAGE
      });
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expires_at = new Date(Date.now() + 3600000); // 1 hour

    // Clean up old tokens for this user
    await pool.query('DELETE FROM password_resets WHERE user_id = $1', [user_id]);

    // Store new token
    await pool.query(
      `INSERT INTO password_resets (user_id, token, expires_at, ip_address) 
       VALUES ($1, $2, $3, $4)`,
      [user_id, tokenHash, expires_at, req.ip]
    );

    const resetUrl = `${process.env.FRONT_URL}/auth?view=reset-password&token=${token}`;

    // Use emailService instead of creating transporter here
    await sendPasswordResetEmail(email, resetUrl);

    await IPSecurity.logIPActivity(req, 'PASSWORD_RESET_SUCCESS', user_id);

    res.json({
      success: true,
      message: GENERIC_SUCCESS_MESSAGE
    });

  } catch (err) {
    console.error('Forgot password error:', err);
    await IPSecurity.logIPActivity(req, 'PASSWORD_RESET_ERROR_SERVER');
    res.status(500).json({
      success: false,
      message: 'Failed to send reset email'
    });
  }
});

export default router;
