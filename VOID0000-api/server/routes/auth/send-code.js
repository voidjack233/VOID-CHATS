import { Router } from 'express';
import { pool } from '../../db.js';
import crypto from 'crypto';
import { VerificationService } from '../../middleware/emailService.js';
import { hashToken } from '../../utils/hashToken.js';
import { hashEmailVerificationCode } from '../../utils/emailVerificationSecurity.js';

const router = Router();

router.post('/', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, message: 'Token is required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const tokenHash = hashToken(token);

    const result = await client.query(
      `SELECT ev.user_id, ev.expires_at, ev.code, u.email, u.is_verified
       FROM email_verifications ev
       JOIN users u ON u.id = ev.user_id
       WHERE ev.token = $1`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Invalid token' });
    }

    const record = result.rows[0];

    if (record.is_verified) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Email already verified' });
    }

    if (new Date(record.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Token expired. Please register again.' });
    }

    // Rate limit: if code already exists, check if expires_at was set less than 60 seconds ago
    // (expires_at is set to 15 min from now each time, so if 15min - remaining > 60s hasn't passed)
    if (record.code) {
      const expiresAt = new Date(record.expires_at).getTime();
      const codeSetAt = expiresAt - (15 * 60 * 1000); // when the code was generated
      const secondsSinceSent = Math.floor((Date.now() - codeSetAt) / 1000);

      if (secondsSinceSent < 60) {
        await client.query('ROLLBACK');
        return res.status(429).json({
          success: false,
          message: 'Please wait before requesting another code',
          cooldown: 60 - secondsSinceSent
        });
      }
    }

    const code = crypto.randomInt(100000, 999999).toString();
    const newExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await client.query(
      `UPDATE email_verifications 
       SET code = $1, expires_at = $2, token = $3
       WHERE user_id = $4`,
      [hashEmailVerificationCode(record.user_id, code), newExpiresAt, tokenHash, record.user_id]
    );

    await VerificationService.sendVerificationEmail(record.email, code);

    await client.query('COMMIT');

    res.json({ success: true, message: 'Verification code sent' });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Send code error:', err);
    res.status(500).json({ success: false, message: 'Failed to send verification code' });
  } finally {
    client.release();
  }
});

export default router;
