// middleware/rate_limit.js
import { IPSecurity } from '../utils/securityUtils.js';
import { DeviceFingerprint } from '../utils/deviceFingerprint.js';
import valkey from '../valkey.js';

/**
 * Generic Valkey-backed rate limiter factory
 * Replaces all in-memory Map stores with Valkey for persistence across restarts
 */
function createRateLimiter({ prefix, windowSec, maxAttempts, escalatingBlocks = null, logAction = null }) {
  return async (req, res, next) => {
    try {
      const deviceId = DeviceFingerprint.generateFingerprint(req);
      const key = `rl:${prefix}:${deviceId}`;

      // Get current state from Valkey
      const raw = await valkey.get(key);
      let entry = raw ? JSON.parse(raw) : null;
      const now = Date.now();

      // Reset if expired
      if (!entry || (now - entry.windowStart > windowSec * 1000)) {
        entry = { count: 0, blockedUntil: 0, windowStart: now, limitHits: 0 };
      }

      // Check if currently blocked
      if (entry.blockedUntil && now < entry.blockedUntil) {
        if (logAction) await IPSecurity.logIPActivity(req, logAction);
        const retrySeconds = Math.ceil((entry.blockedUntil - now) / 1000);
        return res.status(429).json({
          success: false,
          message: 'Too many requests. Please wait.',
          code: `${prefix.toUpperCase()}_RATE_LIMIT_EXCEEDED`,
          retryAfter: `${retrySeconds} seconds`,
          retryAfterSeconds: retrySeconds,
          resetTime: entry.blockedUntil,
        });
      }

      entry.count += 1;

      // Over limit
      if (entry.count > maxAttempts) {
        let blockSec;
        if (escalatingBlocks) {
          entry.limitHits = (entry.limitHits || 0) + 1;
          const idx = Math.min(entry.limitHits - 1, escalatingBlocks.length - 1);
          blockSec = escalatingBlocks[idx];
        } else {
          blockSec = windowSec;
        }

        entry.blockedUntil = now + blockSec * 1000;

        // Store with TTL = block duration + window
        const ttl = blockSec + windowSec;
        await valkey.set(key, JSON.stringify(entry), 'EX', ttl);

        if (logAction) await IPSecurity.logIPActivity(req, logAction);

        return res.status(429).json({
          success: false,
          message: 'Too many requests. Please wait.',
          code: `${prefix.toUpperCase()}_RATE_LIMIT_EXCEEDED`,
          retryAfter: `${blockSec} seconds`,
          retryAfterSeconds: blockSec,
          resetTime: entry.blockedUntil,
        });
      }

      // Store updated count with TTL = window duration
      await valkey.set(key, JSON.stringify(entry), 'EX', windowSec);
      next();

    } catch (err) {
      console.error(`${prefix} rateLimiter error:`, err);
      // Fail open — don't block requests if Valkey is down
      next();
    }
  };
}

// AUTH LOGIN: 5 attempts per 15min, escalating blocks (1min, 5min, 15min)
export const authDeviceLimiter = createRateLimiter({
  prefix: 'auth:login',
  windowSec: 15 * 60,
  maxAttempts: 5,
  escalatingBlocks: [60, 300, 900],
  logAction: 'LOGIN_RATE_LIMIT_HIT',
});

// FORGOT PASSWORD: 3 attempts per hour
export const forgotPasswordLimiter = createRateLimiter({
  prefix: 'auth:forgot',
  windowSec: 60 * 60,
  maxAttempts: 3,
  logAction: 'FORGOT_RATE_LIMIT_HIT',
});

// PASSWORD RESET: 3 attempts per hour
export const resetDeviceLimiter = createRateLimiter({
  prefix: 'auth:reset',
  windowSec: 60 * 60,
  maxAttempts: 3,
  logAction: 'RESET_RATE_LIMIT_HIT',
});

// REGISTRATION: 5 attempts per 24 hours
export const registerDeviceLimiter = createRateLimiter({
  prefix: 'auth:register',
  windowSec: 24 * 60 * 60,
  maxAttempts: 5,
  logAction: 'REGISTER_RATE_LIMIT_HIT',
});

// AUTH CHECK: 20 attempts per 10 minutes
export const authCheckLimiter = createRateLimiter({
  prefix: 'auth:check',
  windowSec: 10 * 60,
  maxAttempts: 20,
  logAction: 'AUTH_CHECK_RATE_LIMIT_HIT',
});

// REFRESH TOKEN: 100 attempts per 15 minutes
export const refreshTokenLimiter = createRateLimiter({
  prefix: 'auth:refresh',
  windowSec: 15 * 60,
  maxAttempts: 100,
  logAction: 'REFRESH_RATE_LIMIT_HIT',
});

// PROFILE UPDATE: 5 per minute
export const profileUpdateLimiter = createRateLimiter({
  prefix: 'profile:update',
  windowSec: 60,
  maxAttempts: 5,
});

// AVATAR UPLOAD: 3 per 5 minutes
export const avatarUploadLimiter = createRateLimiter({
  prefix: 'profile:avatar',
  windowSec: 5 * 60,
  maxAttempts: 3,
});

// CAPTCHA GENERATE: 10 per minute
export const captchaGenerateLimiter = createRateLimiter({
  prefix: 'captcha:generate',
  windowSec: 60,
  maxAttempts: 10,
});