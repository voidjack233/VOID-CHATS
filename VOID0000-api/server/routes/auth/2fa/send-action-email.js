import { Router } from 'express';
import { pool } from '../../../db.js';
import { sendVerificationEmail } from '../../../middleware/emailService.js';
import { encryptedCSRFProtection } from '../../../middleware/encryptedCSRF.js';
import valkey from '../../../valkey.js';
import crypto from 'crypto';
import { getTwoFactorCodeSecret } from '../../../utils/authSecrets.js';

const router = Router();
const ACTION_WINDOW_SEC = 10 * 60;
const ACTION_MAX_SENDS = 3;

function getActionEmailKey(userId, action) {
  return `auth:2fa:action-email:${userId}:${action}`;
}

function getActionEmailRateKey(userId, action) {
  return `auth:2fa:action-email-rate:${userId}:${action}`;
}

function generateEmailCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function hashActionEmailCode(userId, action, code) {
  return crypto
    .createHmac('sha256', getTwoFactorCodeSecret())
    .update(`${userId}:${action}:${String(code).trim()}`)
    .digest('hex');
}

router.post('/', encryptedCSRFProtection, async (req, res) => {
  const userId = req.user.id;
  const action = req.body?.action;

  if (action !== 'change_password') {
    return res.status(400).json({
      success: false,
      message: 'Unsupported 2FA action',
    });
  }

  try {
    const enabledResult = await pool.query(
      `SELECT 1 FROM user_2fa WHERE user_id = $1 AND method = 'email' AND is_enabled = true LIMIT 1`,
      [userId]
    );

    if (enabledResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Email 2FA is not enabled on this account.',
      });
    }

    const rateKey = getActionEmailRateKey(userId, action);
    const sendCount = await valkey.incr(rateKey);
    if (sendCount === 1) {
      await valkey.expire(rateKey, ACTION_WINDOW_SEC);
    }

    if (sendCount > ACTION_MAX_SENDS) {
      const retryAfterSeconds = await valkey.ttl(rateKey);
      return res.status(429).json({
        success: false,
        message: 'Too many email code requests. Please wait before trying again.',
        code: 'TWO_FA_EMAIL_RATE_LIMIT',
        retryAfterSeconds: retryAfterSeconds > 0 ? retryAfterSeconds : ACTION_WINDOW_SEC,
      });
    }

    const userResult = await pool.query(
      'SELECT email FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    const code = generateEmailCode();
    await valkey.set(
      getActionEmailKey(userId, action),
      JSON.stringify({
        codeHash: hashActionEmailCode(userId, action, code),
        createdAt: Date.now(),
      }),
      'EX',
      ACTION_WINDOW_SEC,
    );

    await sendVerificationEmail(userResult.rows[0].email, code);

    return res.json({
      success: true,
      message: 'Verification code sent to your email.',
    });
  } catch (err) {
    console.error('2FA action email error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to send verification code.',
    });
  }
});

export default router;
