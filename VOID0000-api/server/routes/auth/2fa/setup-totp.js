import { Router } from 'express';
import { pool } from '../../../db.js';
import { totp } from '../../../middleware/2fa/totp.js';
import QRCode from 'qrcode';
import crypto from 'crypto';
import argon2 from 'argon2';
import { getTotpEncryptionKey } from '../../../utils/authSecrets.js';

const router = Router();

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const key = getTotpEncryptionKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(encryptedText) {
  const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const key = getTotpEncryptionKey();

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
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
      'SELECT email, username, password_hash FROM users WHERE id = $1',
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
      `SELECT is_enabled FROM user_2fa WHERE user_id = $1 AND method = 'totp'`,
      [userId]
    );

    if (existing.rows.length > 0 && existing.rows[0].is_enabled) {
      return res.status(400).json({
        success: false,
        message: 'Authenticator app is already enabled. Disable it first to reconfigure.',
      });
    }

    const secret = totp.generateSecret();
    const otpauthUri = totp.generateOTPAuthURL(secret, user.email, 'VOID0000');
    const qrCode = await QRCode.toDataURL(otpauthUri, { width: 300, margin: 2 });
    const encryptedSecret = encrypt(secret);

    await pool.query(
      `INSERT INTO user_2fa (user_id, method, totp_secret, is_enabled, created_at)
       VALUES ($1, 'totp', $2, false, NOW())
       ON CONFLICT ON CONSTRAINT unique_user_method
       DO UPDATE SET totp_secret = $2, is_enabled = false, enabled_at = NULL, created_at = NOW()`,
      [userId, encryptedSecret]
    );

    res.json({
      success: true,
      secret,
      qrCode,
    });
  } catch (err) {
    console.error('TOTP setup error:', err);
    res.status(500).json({ success: false, message: 'Failed to set up authenticator' });
  }
});

export { encrypt, decrypt };
export default router;
