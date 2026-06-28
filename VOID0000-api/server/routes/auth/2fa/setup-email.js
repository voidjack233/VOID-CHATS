import { Router } from 'express';
import { pool } from '../../../db.js';
import argon2 from 'argon2';
import { sendVerificationEmail } from '../../../middleware/emailService.js';
import crypto from 'crypto';
import { getTwoFactorCodeSecret } from '../../../utils/authSecrets.js';

const router = Router();

function generateEmailCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function hashSetupEmailCode(userId, code) {
  return crypto
    .createHmac('sha256', getTwoFactorCodeSecret())
    .update(`${userId}:setup_email:${String(code).trim()}`)
    .digest('hex');
}

router.post('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required to set up 2FA.',
      });
    }

    const userResult = await pool.query(
      'SELECT email, password_hash FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];

    const match = await argon2.verify(user.password_hash, password);
    if (!match) {
      return res.status(401).json({
        success: false,
        message: 'Incorrect password.',
      });
    }

    const existing = await pool.query(
      `SELECT is_enabled FROM user_2fa WHERE user_id = $1 AND method = 'email'`,
      [userId]
    );

    if (existing.rows.length > 0 && existing.rows[0].is_enabled) {
      return res.status(400).json({
        success: false,
        message: 'Email 2FA is already enabled.',
      });
    }

    await pool.query(
      `INSERT INTO user_2fa (user_id, method, is_enabled, created_at)
       VALUES ($1, 'email', false, NOW())
       ON CONFLICT ON CONSTRAINT unique_user_method
       DO UPDATE SET is_enabled = false, enabled_at = NULL, created_at = NOW()`,
      [userId]
    );

    const code = generateEmailCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `UPDATE user_2fa SET totp_secret = $1 WHERE user_id = $2 AND method = 'email'`,
      [JSON.stringify({ codeHash: hashSetupEmailCode(userId, code), expiresAt }), userId]
    );

    await sendVerificationEmail(user.email, code);

    res.json({
      success: true,
      message: 'Verification code sent to your email.',
    });
  } catch (err) {
    console.error('Email 2FA setup error:', err);
    res.status(500).json({ success: false, message: 'Failed to set up email 2FA' });
  }
});

export default router;
