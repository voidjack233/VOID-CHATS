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
import { sessionStore } from '../../../middleware/sessionStore.js';
import valkey from '../../../valkey.js';
import crypto from 'crypto';
import { DeviceFingerprint } from '../../../utils/deviceFingerprint.js';
import {
  getAccessSecret,
  getRefreshSecret,
  getTwoFactorCodeSecret,
} from '../../../utils/authSecrets.js';

const router = Router();
const TWO_FACTOR_VERIFY_WINDOW_SEC = 5 * 60;
const TWO_FACTOR_VERIFY_MAX_ATTEMPTS = 5;
const TWO_FACTOR_EMAIL_WINDOW_SEC = 10 * 60;
const TWO_FACTOR_EMAIL_MAX_SENDS = 3;
const TWO_FACTOR_SESSION_WINDOW_SEC = 5 * 60;

const normalizeIP = (ip) => {
  if (!ip) return null;
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
};

function getTwoFactorSessionKey(twoFactorToken) {
  return `auth:2fa:session:${twoFactorToken}`;
}

function getRequestBinding(req) {
  return {
    deviceFingerprint: DeviceFingerprint.generateFingerprint(req),
    userAgent: req.get('User-Agent') || 'unknown',
  };
}

function isSameRequestBinding(session, req) {
  const current = getRequestBinding(req);
  return (
    session?.deviceFingerprint === current.deviceFingerprint &&
    session?.userAgent === current.userAgent
  );
}

function generateEmailCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function hashEmailCode(twoFactorToken, code) {
  return crypto
    .createHmac('sha256', getTwoFactorCodeSecret())
    .update(`${twoFactorToken}:${String(code).trim()}`)
    .digest('hex');
}

function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function getPendingTwoFactorSession(twoFactorToken) {
  const raw = await valkey.get(getTwoFactorSessionKey(twoFactorToken));
  return raw ? JSON.parse(raw) : null;
}

async function savePendingTwoFactorSession(twoFactorToken, session) {
  await valkey.set(
    getTwoFactorSessionKey(twoFactorToken),
    JSON.stringify(session),
    'EX',
    TWO_FACTOR_SESSION_WINDOW_SEC,
  );
}

async function deletePendingTwoFactorSession(twoFactorToken) {
  await valkey.del(getTwoFactorSessionKey(twoFactorToken));
}

// Store a pending 2FA session (called from login.js)
export async function create2FASession(userId, req) {
  const token = uuidv4();

  await savePendingTwoFactorSession(token, {
    userId,
    ip: getClientIP(req),
    ...getRequestBinding(req),
    userAgent: req.get('User-Agent') || 'unknown',
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  });

  return token;
}

function getTwoFactorVerifyKey(twoFactorToken) {
  return `auth:2fa:verify:${twoFactorToken}`;
}

function getTwoFactorEmailKey(twoFactorToken) {
  return `auth:2fa:email:${twoFactorToken}`;
}

async function clearTwoFactorAttemptState(twoFactorToken) {
  await valkey.del(
    getTwoFactorSessionKey(twoFactorToken),
    getTwoFactorVerifyKey(twoFactorToken),
    getTwoFactorEmailKey(twoFactorToken),
  );
}

async function getTwoFactorVerifyState(twoFactorToken) {
  const raw = await valkey.get(getTwoFactorVerifyKey(twoFactorToken));
  return raw ? JSON.parse(raw) : { attempts: 0, blockedUntil: 0 };
}

async function recordTwoFactorFailure(twoFactorToken) {
  const state = await getTwoFactorVerifyState(twoFactorToken);
  state.attempts = (state.attempts || 0) + 1;
  if (state.attempts >= TWO_FACTOR_VERIFY_MAX_ATTEMPTS) {
    state.blockedUntil = Date.now() + TWO_FACTOR_VERIFY_WINDOW_SEC * 1000;
  }
  await valkey.set(
    getTwoFactorVerifyKey(twoFactorToken),
    JSON.stringify(state),
    'EX',
    TWO_FACTOR_VERIFY_WINDOW_SEC,
  );
  return state;
}

async function checkTwoFactorBlocked(twoFactorToken) {
  const state = await getTwoFactorVerifyState(twoFactorToken);
  const now = Date.now();
  if (state.blockedUntil && now < state.blockedUntil) {
    return {
      blocked: true,
      retryAfterSeconds: Math.ceil((state.blockedUntil - now) / 1000),
    };
  }
  return { blocked: false, retryAfterSeconds: 0 };
}

async function recordTwoFactorEmailSend(twoFactorToken) {
  const key = getTwoFactorEmailKey(twoFactorToken);
  const count = await valkey.incr(key);
  if (count === 1) {
    await valkey.expire(key, TWO_FACTOR_EMAIL_WINDOW_SEC);
  }
  return count;
}

async function getTwoFactorEmailRetryAfter(twoFactorToken) {
  const ttl = await valkey.ttl(getTwoFactorEmailKey(twoFactorToken));
  return ttl > 0 ? ttl : TWO_FACTOR_EMAIL_WINDOW_SEC;
}

// POST /api/auth/2fa/verify-login/send-email — Send email code during login
router.post('/send-email', async (req, res) => {
  try {
    const { twoFactorToken } = req.body;

    if (!twoFactorToken) {
      return res.status(400).json({ success: false, message: 'Invalid session' });
    }

    const session = await getPendingTwoFactorSession(twoFactorToken);
    if (!session || Date.now() > session.expiresAt) {
      await clearTwoFactorAttemptState(twoFactorToken);
      return res.status(401).json({ success: false, message: 'Session expired. Please login again.' });
    }

    if (!isSameRequestBinding(session, req)) {
      await clearTwoFactorAttemptState(twoFactorToken);
      return res.status(401).json({
        success: false,
        message: '2FA session changed devices. Please login again.',
        code: 'TWO_FA_DEVICE_MISMATCH',
      });
    }

    const emailSendCount = await recordTwoFactorEmailSend(twoFactorToken);
    if (emailSendCount > TWO_FACTOR_EMAIL_MAX_SENDS) {
      const retryAfterSeconds = await getTwoFactorEmailRetryAfter(twoFactorToken);
      return res.status(429).json({
        success: false,
        message: 'Too many email code requests. Please wait before trying again.',
        code: 'TWO_FA_EMAIL_RATE_LIMIT',
        retryAfterSeconds,
      });
    }

    // Get user email
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [session.userId]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'User not found' });
    }

    const email = userResult.rows[0].email;
    const code = generateEmailCode();

    // Store code in session
    session.emailCodeHash = hashEmailCode(twoFactorToken, code);
    session.emailCodeExpiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    await savePendingTwoFactorSession(twoFactorToken, session);

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
    const session = await getPendingTwoFactorSession(twoFactorToken);
    if (!session || Date.now() > session.expiresAt) {
      await clearTwoFactorAttemptState(twoFactorToken);
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please login again.',
        code: 'TWO_FA_SESSION_EXPIRED',
      });
    }

    if (!isSameRequestBinding(session, req)) {
      await clearTwoFactorAttemptState(twoFactorToken);
      return res.status(401).json({
        success: false,
        message: '2FA session changed devices. Please login again.',
        code: 'TWO_FA_DEVICE_MISMATCH',
      });
    }

    const blockedState = await checkTwoFactorBlocked(twoFactorToken);
    if (blockedState.blocked) {
      await deletePendingTwoFactorSession(twoFactorToken);
      return res.status(429).json({
        success: false,
        message: 'Too many invalid 2FA attempts. Please login again.',
        code: 'TWO_FA_RATE_LIMIT',
        retryAfterSeconds: blockedState.retryAfterSeconds,
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
        const failureState = await recordTwoFactorFailure(twoFactorToken);
        if (failureState.blockedUntil) {
          await deletePendingTwoFactorSession(twoFactorToken);
        }
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
        const failureState = await recordTwoFactorFailure(twoFactorToken);
        if (failureState.blockedUntil) {
          await deletePendingTwoFactorSession(twoFactorToken);
        }
        return res.status(400).json({
          success: false,
          message: 'Invalid code. Please try again.',
        });
      }
    } else if (method === 'email') {
      // Verify email code
      if (!session.emailCodeHash || Date.now() > session.emailCodeExpiresAt) {
        return res.status(400).json({
          success: false,
          message: 'Email code expired. Please request a new one.',
        });
      }

      const submittedCodeHash = hashEmailCode(twoFactorToken, code);
      if (!safeEqualHex(session.emailCodeHash, submittedCodeHash)) {
        const failureState = await recordTwoFactorFailure(twoFactorToken);
        if (failureState.blockedUntil) {
          await deletePendingTwoFactorSession(twoFactorToken);
        }
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
    await clearTwoFactorAttemptState(twoFactorToken);

    const userResult = await pool.query(
      'SELECT id, email, username, profile_id, is_verified FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];

    const deviceId = DeviceManager.generateDeviceId(req, res);
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
      getAccessSecret(),
      { expiresIn: '15m' }
    );

    const refreshToken = jwt.sign(
      { ...tokenPayload, jti: jtiRefresh, type: 'refresh' },
      getRefreshSecret(),
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

    await sessionStore.create(user.id, deviceId, {
      ip: userIp,
      userAgent,
      deviceName: deviceInfo.deviceName,
      deviceType: deviceInfo.deviceType,
    });

    res.cookie('accessToken', accessToken, accessCookieOptions(req));
    res.cookie('refreshToken', refreshToken, refreshCookieOptions(req));

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
