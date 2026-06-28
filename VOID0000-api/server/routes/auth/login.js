import { Router } from 'express';
import { pool } from '../../db.js';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { IPSecurity, DeviceManager, getClientIP } from '../../utils/securityUtils.js';
import { accessCookieOptions, refreshCookieOptions } from '../../utils/cookieConfig.js';
import { hashToken } from '../../utils/hashToken.js';
import { updateTrustScore } from '../../middleware/captcha/trustScore.js';
import { DeviceFingerprint } from '../../utils/deviceFingerprint.js';
import { create2FASession } from './2fa/verify-login.js';
import { sessionStore } from '../../middleware/sessionStore.js';
import { getAccessSecret, getRefreshSecret } from '../../utils/authSecrets.js';

const router = Router();

const normalizeIP = (ip) => {
  if (!ip) return null;
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
};

router.post('/', async (req, res) => {
  let { identifier, password } = req.body;

  if (typeof identifier !== 'string' || identifier.length > 255 ||
    typeof password !== 'string' || password.length > 128) {
    await IPSecurity.logIPActivity(req, 'LOGIN_FAILURE_BAD_INPUT');
    return res.status(400).json({ success: false, message: "Invalid credentials format" });
  }

  let userIp = normalizeIP(getClientIP(req));
  const userAgent = req.get('User-Agent') || 'unknown';
  const trustDeviceId = DeviceFingerprint.ensureFingerprint(req, res);

  let client;

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = $1 OR LOWER(username) = $1',
      [identifier.trim().toLowerCase()]
    );

    const user = result.rows[0];

    if (!user) {
      await IPSecurity.logIPActivity(req, 'LOGIN_FAILURE_USER_NOT_FOUND');
      await updateTrustScore(trustDeviceId, 'LOGIN_FAILED', req);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const match = await argon2.verify(user.password_hash, password);
    if (!match) {
      await IPSecurity.logIPActivity(req, 'LOGIN_FAILURE_WRONG_PASSWORD', user.id);
      await updateTrustScore(trustDeviceId, 'LOGIN_FAILED', req);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (!user.is_verified) {
      await IPSecurity.logIPActivity(req, 'LOGIN_FAILURE_EMAIL_NOT_VERIFIED', user.id);
      return res.status(403).json({
        success: false,
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email before logging in.',
        email: user.email
      });
    }

    // Check if user has 2FA enabled
    const twoFAResult = await pool.query(
      `SELECT method FROM user_2fa WHERE user_id = $1 AND is_enabled = true`,
      [user.id]
    );

    if (twoFAResult.rows.length > 0) {
      const methods = twoFAResult.rows.map(r => r.method);
      const twoFactorToken = await create2FASession(user.id, req);

      // Record successful password auth for trust scoring
      await updateTrustScore(trustDeviceId, 'LOGIN_SUCCESS', req);

      return res.json({
        success: true,
        requires2FA: true,
        twoFactorToken,
        methods, // ['totp', 'email'] or ['totp'] or ['email']
        defaultMethod: methods.includes('totp') ? 'totp' : 'email',
      });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    await IPSecurity.logIPActivity(req, 'LOGIN_SUCCESS', user.id, client);

    const deviceId = DeviceManager.generateDeviceId(req, res);
    const deviceInfo = DeviceManager.getDeviceInfo(req);

    await client.query(
      `DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at < NOW()`,
      [user.id]
    );

    const needRehash = await argon2.needsRehash(user.password_hash, {
      type: argon2.argon2id, memoryCost: 2 ** 16, timeCost: 3, parallelism: 1
    });

    if (needRehash) {
      const newHash = await argon2.hash(password, {
        type: argon2.argon2id, memoryCost: 2 ** 16, timeCost: 3, parallelism: 1
      });
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);
    }

    const jtiAccess = uuidv4();
    const jtiRefresh = uuidv4();

    const tokenPayload = {
      id: user.id,
      profile_id: user.profile_id,
      device_id: deviceId
    };

    const accessToken = jwt.sign(
      { ...tokenPayload, jti: jtiAccess, type: 'access' },
      getAccessSecret(),
      { expiresIn: '15m' }
    );

    const refreshToken = jwt.sign(
      { ...tokenPayload, jti: jtiRefresh, type: 'refresh' },
      getRefreshSecret(),
      { expiresIn: '30d' }
    );

    const tokenHash = hashToken(refreshToken);

    await client.query(
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
      [
        user.id,
        tokenHash,
        jtiRefresh,
        userIp,
        userAgent,
        deviceId,
        deviceInfo.deviceName,
        deviceInfo.deviceType
      ]
    );

  await client.query('COMMIT');

  await sessionStore.create(user.id, deviceId, {
      ip: userIp,
      userAgent,
      deviceName: deviceInfo.deviceName,
      deviceType: deviceInfo.deviceType,
    });

    // Record successful login for trust scoring
    await updateTrustScore(trustDeviceId, 'LOGIN_SUCCESS', req);

    res.cookie('accessToken', accessToken, accessCookieOptions(req));
    res.cookie('refreshToken', refreshToken, refreshCookieOptions(req));

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        profile_id: user.profile_id,
        is_verified: user.is_verified
      },
      device: {
        id: deviceId,
        name: deviceInfo.deviceName,
        type: deviceInfo.deviceType
      }
    });

  } catch (err) {
    if (client) await client.query('ROLLBACK');

    console.error('Login error:', err);
    await IPSecurity.logIPActivity(req, 'LOGIN_ERROR_SERVER');

    let errorMessage = 'An error occurred during login';
    if (err.code === '23505') errorMessage = 'Session conflict detected. Please try again.';

    res.status(500).json({ success: false, message: errorMessage });
  } finally {
    if (client) client.release();
    password = null;
    identifier = null;
  }
});

export default router;
