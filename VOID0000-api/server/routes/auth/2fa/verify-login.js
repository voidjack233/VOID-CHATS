import { Router } from 'express';
import { pool } from '../../../db.js';
import jwt from 'jsonwebtoken';
import { totp } from '../../../middleware/2fa/totp.js';
import { decrypt } from './setup-totp.js';
import { accessCookieOptions, refreshCookieOptions } from '../../../utils/cookieConfig.js';
import { hashToken } from '../../../utils/hashToken.js';
import { DeviceManager, getClientIP } from '../../../utils/securityUtils.js';
import { v4 as uuidv4 } from 'uuid';
import argon2 from 'argon2';
import { sendVerificationEmail } from '../../../middleware/emailService.js';

const router = Router();
const ACCESS_SECRET = process.env.ACCESS_SECRET;
const REFRESH_SECRET = process.env.REFRESH_SECRET;

// In-memory store for pending 2FA sessions
const pending2FA = new Map();

// Cleanup expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pending2FA) {
    if (now > value.expiresAt) pending2FA.delete(key);
  }
}, 5 * 60 * 1000);

const normalizeIP = (ip) => {
  if (!ip) return null;
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
};

// Store a pending 2FA session (called from login.js)
export function create2FASession(userId, req) {
  const token = uuidv4();

  pending2FA.set(token, {
    userId,
    ip: getClientIP(req),
    userAgent: req.get('User-Agent') || 'unknown',
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  });

  return token;
}

// POST /api/auth/2fa/verify-login/send-email — Send email code during login
router.post('/send-email', async (req, res) => {
  try {
    const { twoFactorToken } = req.body;

    if (!twoFactorToken) {
      return res.status(400).json({ success: false, message: 'Invalid session' });
    }

    const session = pending2FA.get(twoFactorToken);
    if (!session || Date.now() > session.expiresAt) {
      pending2FA.delete(twoFactorToken);
      return res.status(401).json({ success: false, message: 'Session expired. Please login again.' });
    }

    // Get user email
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [session.userId]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'User not found' });
    }

    const email = userResult.rows[0].email;
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Store code in session
    session.emailCode = code;
    session.emailCodeExpiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    await sendVerificationEmail(email, code);

    res.json({ success: true, message: 'Verification code sent to your email.' });
  } catch (err) {
    console.error('2FA send email error:', err);
    res.status(500).json({ success: false, message: 'Failed to send code' });
  }
});

// POST /api/auth/2fa/verify-login — Verify 2FA code and complete login
router.post('/', async (req, res) => {
  try {
    const { twoFactorToken, code, method } = req.body;

    if (!twoFactorToken || !code || !method) {
      return res.status(400).json({
        success: false,
        message: 'Token, code, and method are required.',
      });
    }

    // Validate pending session
    const session = pending2FA.get(twoFactorToken);
    if (!session || Date.now() > session.expiresAt) {
      pending2FA.delete(twoFactorToken);
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please login again.',
        code: 'TWO_FA_SESSION_EXPIRED',
      });
    }

    const userId = session.userId;

    // Check if method is backup code
    if (method === 'backup') {
      const backupCodes = await pool.query(
        `SELECT id, code_hash FROM user_2fa_backup_codes WHERE user_id = $1 AND is_used = false`,
        [userId]
      );

      let validBackup = false;
      let usedCodeId = null;

      for (const row of backupCodes.rows) {
        const match = await argon2.verify(row.code_hash, code.trim().toUpperCase());
        if (match) {
          validBackup = true;
          usedCodeId = row.id;
          break;
        }
      }

      if (!validBackup) {
        return res.status(400).json({
          success: false,
          message: 'Invalid backup code.',
        });
      }

      // Mark code as used
      await pool.query(
        `UPDATE user_2fa_backup_codes SET is_used = true, used_at = NOW() WHERE id = $1`,
        [usedCodeId]
      );
    } else if (method === 'totp') {
      // Verify TOTP
      const result = await pool.query(
        `SELECT totp_secret FROM user_2fa WHERE user_id = $1 AND method = 'totp' AND is_enabled = true`,
        [userId]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Authenticator app is not set up.',
        });
      }

      const secret = decrypt(result.rows[0].totp_secret);
      const isValid = totp.verifyToken(code, secret);

      if (!isValid) {
        return res.status(400).json({
          success: false,
          message: 'Invalid code. Please try again.',
        });
      }
    } else if (method === 'email') {
      // Verify email code
      if (!session.emailCode || Date.now() > session.emailCodeExpiresAt) {
        return res.status(400).json({
          success: false,
          message: 'Email code expired. Please request a new one.',
        });
      }

      if (session.emailCode !== code.trim()) {
        return res.status(400).json({
          success: false,
          message: 'Invalid code. Please try again.',
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid verification method.',
      });
    }

    // 2FA passed — complete login (issue tokens)
    pending2FA.delete(twoFactorToken);

    const userResult = await pool.query(
      'SELECT id, email, username, profile_id, is_verified FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];

    const deviceId = DeviceManager.generateDeviceId(req);
    const deviceInfo = DeviceManager.getDeviceInfo(req);
    const userIp = normalizeIP(getClientIP(req));
    const userAgent = req.get('User-Agent') || 'unknown';

    const jtiAccess = uuidv4();
    const jtiRefresh = uuidv4();

    const tokenPayload = {
      id: user.id,
      profile_id: user.profile_id,
      device_id: deviceId,
    };

    const accessToken = jwt.sign(
      { ...tokenPayload, jti: jtiAccess, type: 'access' },
      ACCESS_SECRET,
      { expiresIn: '15m' }
    );

    const refreshToken = jwt.sign(
      { ...tokenPayload, jti: jtiRefresh, type: 'refresh' },
      REFRESH_SECRET,
      { expiresIn: '30d' }
    );

    const tokenHash = hashToken(refreshToken);

    await pool.query(
      `INSERT INTO refresh_tokens 
        (user_id, token_hash, jti, expires_at, ip_address, user_agent, device_id, device_name, device_type, last_used_at) 
       VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', $4, $5, $6, $7, $8, NOW())
       ON CONFLICT ON CONSTRAINT unique_user_device 
       DO UPDATE SET 
         token_hash = EXCLUDED.token_hash,
         jti = EXCLUDED.jti,
         expires_at = EXCLUDED.expires_at,
         ip_address = EXCLUDED.ip_address,
         user_agent = EXCLUDED.user_agent,
         device_name = EXCLUDED.device_name,
         device_type = EXCLUDED.device_type,
         is_revoked = FALSE,
         last_used_at = NOW(),
         created_at = NOW()`,
      [user.id, tokenHash, jtiRefresh, userIp, userAgent, deviceId, deviceInfo.deviceName, deviceInfo.deviceType]
    );

    res.cookie('accessToken', accessToken, accessCookieOptions());
    res.cookie('refreshToken', refreshToken, refreshCookieOptions());

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        profile_id: user.profile_id,
        is_verified: user.is_verified,
      },
      device: {
        id: deviceId,
        name: deviceInfo.deviceName,
        type: deviceInfo.deviceType,
      },
    });
  } catch (err) {
    console.error('2FA verify login error:', err);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

export default router;