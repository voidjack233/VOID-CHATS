import { Router } from 'express';
import { pool } from '../../../db.js';
import { totp } from '../../../middleware/2fa/totp.js';
import { decrypt } from './setup-totp.js';
import crypto from 'crypto';
import argon2 from 'argon2';
import { getTwoFactorCodeSecret } from '../../../utils/authSecrets.js';

const router = Router();

function hashSetupEmailCode(userId, code) {
  return crypto
    .createHmac('sha256', getTwoFactorCodeSecret())
    .update(`${userId}:setup_email:${String(code).trim()}`)
    .digest('hex');
}

function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

// POST /api/auth/2fa/verify-setup — Confirm 2FA setup with a test code
router.post('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { method, code } = req.body;

    if (!method || !code) {
      return res.status(400).json({
        success: false,
        message: 'Method and code are required.',
      });
    }

    const result = await pool.query(
      `SELECT * FROM user_2fa WHERE user_id = $1 AND method = $2`,
      [userId, method]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please start the setup process first.',
      });
    }

    const record = result.rows[0];

    if (record.is_enabled) {
      return res.status(400).json({
        success: false,
        message: '2FA is already enabled for this method.',
      });
    }

    // Verify based on method
    if (method === 'totp') {
      const secret = decrypt(record.totp_secret);
      const isValid = totp.verifyToken(code, secret);

      if (!isValid) {
        return res.status(400).json({
          success: false,
          message: 'Invalid code. Please try again.',
        });
      }
    } else if (method === 'email') {
      const stored = JSON.parse(record.totp_secret);

      if (Date.now() > new Date(stored.expiresAt).getTime()) {
        return res.status(400).json({
          success: false,
          message: 'Code has expired. Please request a new one.',
        });
      }

      const submittedCodeHash = hashSetupEmailCode(userId, code);
      const matchesHashedCode =
        stored.codeHash && safeEqualHex(stored.codeHash, submittedCodeHash);

      if (!matchesHashedCode) {
        return res.status(400).json({
          success: false,
          message: 'Invalid code. Please try again.',
        });
      }

      // Clear the temporary code
      await pool.query(
        `UPDATE user_2fa SET totp_secret = NULL WHERE user_id = $1 AND method = 'email'`,
        [userId]
      );
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid 2FA method.',
      });
    }

    // Enable 2FA
    await pool.query(
      `UPDATE user_2fa SET is_enabled = true, enabled_at = NOW() WHERE user_id = $1 AND method = $2`,
      [userId, method]
    );

    // Generate backup codes if this is the first 2FA method enabled
    const enabledMethods = await pool.query(
      `SELECT COUNT(*) as count FROM user_2fa WHERE user_id = $1 AND is_enabled = true`,
      [userId]
    );

    let backupCodes = null;

    // Generate backup codes on first 2FA enable (count was 0 before we just enabled)
    if (parseInt(enabledMethods.rows[0].count) === 1) {
      backupCodes = await generateBackupCodes(userId);
    }

    res.json({
      success: true,
      message: `${method === 'totp' ? 'Authenticator app' : 'Email 2FA'} has been enabled.`,
      backupCodes, // Only returned on first enable
    });
  } catch (err) {
    console.error('2FA verify setup error:', err);
    res.status(500).json({ success: false, message: 'Failed to verify 2FA setup' });
  }
});

async function generateBackupCodes(userId) {
  // Delete existing codes
  await pool.query('DELETE FROM user_2fa_backup_codes WHERE user_id = $1', [userId]);

  const codes = [];
  const plainCodes = [];

  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8-char codes like "A1B2C3D4"
    plainCodes.push(code);

    const codeHash = await argon2.hash(code, {
      type: argon2.argon2id,
      memoryCost: 2 ** 14,
      timeCost: 2,
      parallelism: 1,
    });

    codes.push({ userId, codeHash });
  }

  for (const { userId: uid, codeHash } of codes) {
    await pool.query(
      `INSERT INTO user_2fa_backup_codes (user_id, code_hash, created_at) VALUES ($1, $2, NOW())`,
      [uid, codeHash]
    );
  }

  return plainCodes; // Return plain codes to show user ONCE
}

export { generateBackupCodes };
export default router;
