// middleware/rate_limit.js
import { IPSecurity } from '../utils/securityUtils.js';
import { DeviceFingerprint } from '../utils/deviceFingerprint.js';

// AUTH-SPECIFIC Device-aware rate limiting
export const authDeviceLimiter = (() => {
  const DURATIONS_SEC = [60, 300, 900]; // 1st limit=60s, 2nd limit=5min, 3rd limit=15min
  const store = new Map();
  const WINDOW_MS = 15 * 60 * 1000; // 15 minutes window
  const MAX_ATTEMPTS = 5; // 5 attempts per window

  return async (req, res, next) => {
    try {
      const deviceId = DeviceFingerprint.generateFingerprint(req);
      const key = `auth:login:${deviceId}`;
      const now = Date.now();

      let entry = store.get(key);
      
      if (!entry || (entry.windowStart && now - entry.windowStart > WINDOW_MS)) {
        entry = { 
          count: 0, 
          blockedUntil: 0, 
          timeout: null,
          windowStart: now,
          limitHits: 0
        };
      }

      if (entry.blockedUntil && now < entry.blockedUntil) {
        await IPSecurity.logIPActivity(req, 'LOGIN_RATE_LIMIT_HIT');
        const retrySeconds = Math.ceil((entry.blockedUntil - now) / 1000);
        return res.status(429).json({
          success: false,
          message: 'Too many login attempts from this device. Please wait.',
          code: 'LOGIN_RATE_LIMIT_EXCEEDED',
          retryAfter: `${retrySeconds} seconds`,
          retryAfterSeconds: retrySeconds,
          resetTime: entry.blockedUntil
        });
      }

      entry.count += 1;

      if (entry.count > MAX_ATTEMPTS) {
        entry.limitHits += 1;
        const idx = Math.min(entry.limitHits - 1, DURATIONS_SEC.length - 1);
        const blockSec = DURATIONS_SEC[idx];
        
        entry.blockedUntil = now + blockSec * 1000;

        if (entry.timeout) clearTimeout(entry.timeout);
        entry.timeout = setTimeout(() => {
          entry.count = 0;
          entry.blockedUntil = 0;
          entry.windowStart = now + blockSec * 1000;
        }, blockSec * 1000);

        store.set(key, entry);

        await IPSecurity.logIPActivity(req, 'LOGIN_RATE_LIMIT_HIT');

        return res.status(429).json({
          success: false,
          message: 'Too many login attempts from this device. Please wait.',
          code: 'LOGIN_RATE_LIMIT_EXCEEDED',
          retryAfter: `${blockSec} seconds`,
          retryAfterSeconds: blockSec,
          resetTime: entry.blockedUntil
        });
      }

      store.set(key, entry);
      next();

    } catch (err) {
      console.error('authDeviceLimiter error:', err);
      return next();
    }
  };
})();

// FORGOT PASSWORD Limiter
export const forgotPasswordLimiter = (() => {
  const store = new Map();
  const WINDOW_MS = 60 * 60 * 1000;
  const MAX_ATTEMPTS = 3;

  return async (req, res, next) => {
    try {
      const deviceId = DeviceFingerprint.generateFingerprint(req);
      const key = `auth:forgot:${deviceId}`;
      const now = Date.now();

      let entry = store.get(key);
      
      if (!entry || (entry.windowStart && now - entry.windowStart > WINDOW_MS)) {
        entry = { count: 0, blockedUntil: 0, timeout: null, windowStart: now };
      }

      if (entry.blockedUntil && now < entry.blockedUntil) {
        await IPSecurity.logIPActivity(req, 'FORGOT_RATE_LIMIT_HIT');
        const retrySeconds = Math.ceil((entry.blockedUntil - now) / 1000);
        return res.status(429).json({
          success: false,
          message: 'Too many password reset requests from this device. Please wait.',
          code: 'FORGOT_RATE_LIMIT_EXCEEDED',
          retryAfter: `${retrySeconds} seconds`,
          retryAfterSeconds: retrySeconds,
          resetTime: entry.blockedUntil
        });
      }

      entry.count += 1;

      if (entry.count > MAX_ATTEMPTS) {
        entry.blockedUntil = now + WINDOW_MS;

        if (entry.timeout) clearTimeout(entry.timeout);
        entry.timeout = setTimeout(() => {
          entry.count = 0;
          entry.blockedUntil = 0;
          entry.windowStart = now + WINDOW_MS;
        }, WINDOW_MS);

        store.set(key, entry);
        await IPSecurity.logIPActivity(req, 'FORGOT_RATE_LIMIT_HIT');

        return res.status(429).json({
          success: false,
          message: 'Too many password reset requests from this device. Please wait.',
          code: 'FORGOT_RATE_LIMIT_EXCEEDED',
          retryAfter: `${WINDOW_MS / 1000} seconds`,
          retryAfterSeconds: WINDOW_MS / 1000,
          resetTime: entry.blockedUntil
        });
      }

      store.set(key, entry);
      next();

    } catch (err) {
      console.error('forgotPasswordLimiter error:', err);
      return next();
    }
  };
})();

// PASSWORD RESET Limiter
export const resetDeviceLimiter = (() => {
  const store = new Map();
  const WINDOW_MS = 60 * 60 * 1000;
  const MAX_ATTEMPTS = 3;

  return async (req, res, next) => {
    try {
      const deviceId = DeviceFingerprint.generateFingerprint(req);
      const key = `auth:reset:${deviceId}`;
      const now = Date.now();

      let entry = store.get(key);
      
      if (!entry || (entry.windowStart && now - entry.windowStart > WINDOW_MS)) {
        entry = { count: 0, blockedUntil: 0, timeout: null, windowStart: now };
      }

      if (entry.blockedUntil && now < entry.blockedUntil) {
        await IPSecurity.logIPActivity(req, 'RESET_RATE_LIMIT_HIT');
        const retrySeconds = Math.ceil((entry.blockedUntil - now) / 1000);
        return res.status(429).json({
          success: false,
          message: 'Too many password reset attempts from this device. Please wait.',
          code: 'RESET_RATE_LIMIT_EXCEEDED',
          retryAfter: `${retrySeconds} seconds`,
          retryAfterSeconds: retrySeconds,
          resetTime: entry.blockedUntil
        });
      }

      entry.count += 1;

      if (entry.count > MAX_ATTEMPTS) {
        entry.blockedUntil = now + WINDOW_MS;

        if (entry.timeout) clearTimeout(entry.timeout);
        entry.timeout = setTimeout(() => {
          entry.count = 0;
          entry.blockedUntil = 0;
          entry.windowStart = now + WINDOW_MS;
        }, WINDOW_MS);

        store.set(key, entry);
        await IPSecurity.logIPActivity(req, 'RESET_RATE_LIMIT_HIT');

        return res.status(429).json({
          success: false,
          message: 'Too many password reset attempts from this device. Please wait.',
          code: 'RESET_RATE_LIMIT_EXCEEDED',
          retryAfter: `${WINDOW_MS / 1000} seconds`,
          retryAfterSeconds: WINDOW_MS / 1000,
          resetTime: entry.blockedUntil
        });
      }

      store.set(key, entry);
      next();

    } catch (err) {
      console.error('resetDeviceLimiter error:', err);
      return next();
    }
  };
})();

// REGISTRATION Limiter (was express-rate-limit)
export const registerDeviceLimiter = (() => {
  const store = new Map();
  const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
  const MAX_ATTEMPTS = 5;

  return async (req, res, next) => {
    try {
      const deviceId = DeviceFingerprint.generateFingerprint(req);
      const key = `auth:register:${deviceId}`;
      const now = Date.now();

      let entry = store.get(key);

      if (!entry || (entry.windowStart && now - entry.windowStart > WINDOW_MS)) {
        entry = { count: 0, blockedUntil: 0, timeout: null, windowStart: now };
      }

      if (entry.blockedUntil && now < entry.blockedUntil) {
        await IPSecurity.logIPActivity(req, 'REGISTER_RATE_LIMIT_HIT');
        const retrySeconds = Math.ceil((entry.blockedUntil - now) / 1000);
        return res.status(429).json({
          success: false,
          message: 'Too many registration attempts from this device. Please try again tomorrow.',
          code: 'REGISTER_RATE_LIMIT_EXCEEDED',
          retryAfter: `${retrySeconds} seconds`,
          retryAfterSeconds: retrySeconds,
        });
      }

      entry.count += 1;

      if (entry.count > MAX_ATTEMPTS) {
        entry.blockedUntil = now + WINDOW_MS;

        if (entry.timeout) clearTimeout(entry.timeout);
        entry.timeout = setTimeout(() => {
          entry.count = 0;
          entry.blockedUntil = 0;
          entry.windowStart = now + WINDOW_MS;
        }, WINDOW_MS);

        store.set(key, entry);
        await IPSecurity.logIPActivity(req, 'REGISTER_RATE_LIMIT_HIT');

        return res.status(429).json({
          success: false,
          message: 'Too many registration attempts from this device. Please try again tomorrow.',
          code: 'REGISTER_RATE_LIMIT_EXCEEDED',
          retryAfter: '24 hours',
        });
      }

      store.set(key, entry);
      next();

    } catch (err) {
      console.error('registerDeviceLimiter error:', err);
      return next();
    }
  };
})();

// AUTH CHECK Limiter
export const authCheckLimiter = (() => {
  const store = new Map();
  const WINDOW_MS = 10 * 60 * 1000;
  const MAX_ATTEMPTS = 20;

  return async (req, res, next) => {
    try {
      const deviceId = DeviceFingerprint.generateFingerprint(req);
      const key = `auth:check:${deviceId}`;
      const now = Date.now();

      let entry = store.get(key);
      
      if (!entry || (entry.windowStart && now - entry.windowStart > WINDOW_MS)) {
        entry = { count: 0, blockedUntil: 0, timeout: null, windowStart: now };
      }

      if (entry.blockedUntil && now < entry.blockedUntil) {
        await IPSecurity.logIPActivity(req, 'AUTH_CHECK_RATE_LIMIT_HIT');
        const retrySeconds = Math.ceil((entry.blockedUntil - now) / 1000);
        return res.status(429).json({
          success: false,
          message: 'Too many auth check requests. Please wait.',
          code: 'AUTH_CHECK_RATE_LIMIT_EXCEEDED',
          retryAfter: `${retrySeconds} seconds`,
          retryAfterSeconds: retrySeconds,
        });
      }

      entry.count += 1;

      if (entry.count > MAX_ATTEMPTS) {
        const blockMs = 5 * 60 * 1000;
        entry.blockedUntil = now + blockMs;

        if (entry.timeout) clearTimeout(entry.timeout);
        entry.timeout = setTimeout(() => {
          entry.count = 0;
          entry.blockedUntil = 0;
          entry.windowStart = now + blockMs;
        }, blockMs);

        store.set(key, entry);
        await IPSecurity.logIPActivity(req, 'AUTH_CHECK_RATE_LIMIT_HIT');

        return res.status(429).json({
          success: false,
          message: 'Too many auth check requests. Please wait.',
          code: 'AUTH_CHECK_RATE_LIMIT_EXCEEDED',
          retryAfter: '5 minutes',
          retryAfterSeconds: 300,
        });
      }

      store.set(key, entry);
      next();

    } catch (err) {
      console.error('authCheckLimiter error:', err);
      return next();
    }
  };
})();

// REFRESH TOKEN Limiter
export const refreshTokenLimiter = (() => {
  const store = new Map();
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_ATTEMPTS = 100;

  return async (req, res, next) => {
    try {
      const deviceId = DeviceFingerprint.generateFingerprint(req);
      const key = `auth:refresh:${deviceId}`;
      const now = Date.now();

      let entry = store.get(key);
      
      if (!entry || (entry.windowStart && now - entry.windowStart > WINDOW_MS)) {
        entry = { count: 0, blockedUntil: 0, timeout: null, windowStart: now };
      }

      if (entry.blockedUntil && now < entry.blockedUntil) {
        await IPSecurity.logIPActivity(req, 'REFRESH_RATE_LIMIT_HIT');
        const retrySeconds = Math.ceil((entry.blockedUntil - now) / 1000);
        return res.status(429).json({
          success: false,
          message: 'Too many token refresh attempts. Please wait.',
          code: 'REFRESH_RATE_LIMIT_EXCEEDED',
          retryAfter: `${retrySeconds} seconds`,
          retryAfterSeconds: retrySeconds,
        });
      }

      entry.count += 1;

      if (entry.count > MAX_ATTEMPTS) {
        const blockMs = 15 * 60 * 1000;
        entry.blockedUntil = now + blockMs;

        if (entry.timeout) clearTimeout(entry.timeout);
        entry.timeout = setTimeout(() => {
          entry.count = 0;
          entry.blockedUntil = 0;
          entry.windowStart = now + blockMs;
        }, blockMs);

        store.set(key, entry);
        await IPSecurity.logIPActivity(req, 'REFRESH_RATE_LIMIT_HIT');

        return res.status(429).json({
          success: false,
          message: 'Too many token refresh attempts. Please wait.',
          code: 'REFRESH_RATE_LIMIT_EXCEEDED',
          retryAfter: '15 minutes',
          retryAfterSeconds: 900,
        });
      }

      store.set(key, entry);
      next();

    } catch (err) {
      console.error('refreshTokenLimiter error:', err);
      return next();
    }
  };
})();

// PROFILE UPDATE Limiter: 5 saves per minute (was express-rate-limit)
export const profileUpdateLimiter = (() => {
  const store = new Map();
  const WINDOW_MS = 60 * 1000;
  const MAX_ATTEMPTS = 5;

  return async (req, res, next) => {
    try {
      const deviceId = DeviceFingerprint.generateFingerprint(req);
      const key = `profile:update:${deviceId}`;
      const now = Date.now();

      let entry = store.get(key);

      if (!entry || (entry.windowStart && now - entry.windowStart > WINDOW_MS)) {
        entry = { count: 0, blockedUntil: 0, timeout: null, windowStart: now };
      }

      if (entry.blockedUntil && now < entry.blockedUntil) {
        const retrySeconds = Math.ceil((entry.blockedUntil - now) / 1000);
        return res.status(429).json({
          success: false,
          message: 'Too many profile updates. Try again in a minute.',
          code: 'PROFILE_UPDATE_RATE_LIMIT',
          retryAfterSeconds: retrySeconds,
        });
      }

      entry.count += 1;

      if (entry.count > MAX_ATTEMPTS) {
        entry.blockedUntil = now + WINDOW_MS;

        if (entry.timeout) clearTimeout(entry.timeout);
        entry.timeout = setTimeout(() => {
          entry.count = 0;
          entry.blockedUntil = 0;
          entry.windowStart = now + WINDOW_MS;
        }, WINDOW_MS);

        store.set(key, entry);

        return res.status(429).json({
          success: false,
          message: 'Too many profile updates. Try again in a minute.',
          code: 'PROFILE_UPDATE_RATE_LIMIT',
          retryAfterSeconds: 60,
        });
      }

      store.set(key, entry);
      next();

    } catch (err) {
      console.error('profileUpdateLimiter error:', err);
      return next();
    }
  };
})();

// AVATAR UPLOAD Limiter: 3 uploads per 5 minutes (was express-rate-limit)
export const avatarUploadLimiter = (() => {
  const store = new Map();
  const WINDOW_MS = 5 * 60 * 1000;
  const MAX_ATTEMPTS = 3;

  return async (req, res, next) => {
    try {
      const deviceId = DeviceFingerprint.generateFingerprint(req);
      const key = `profile:avatar:${deviceId}`;
      const now = Date.now();

      let entry = store.get(key);

      if (!entry || (entry.windowStart && now - entry.windowStart > WINDOW_MS)) {
        entry = { count: 0, blockedUntil: 0, timeout: null, windowStart: now };
      }

      if (entry.blockedUntil && now < entry.blockedUntil) {
        const retrySeconds = Math.ceil((entry.blockedUntil - now) / 1000);
        return res.status(429).json({
          success: false,
          message: 'Too many avatar uploads. Try again in 5 minutes.',
          code: 'AVATAR_UPLOAD_RATE_LIMIT',
          retryAfterSeconds: retrySeconds,
        });
      }

      entry.count += 1;

      if (entry.count > MAX_ATTEMPTS) {
        entry.blockedUntil = now + WINDOW_MS;

        if (entry.timeout) clearTimeout(entry.timeout);
        entry.timeout = setTimeout(() => {
          entry.count = 0;
          entry.blockedUntil = 0;
          entry.windowStart = now + WINDOW_MS;
        }, WINDOW_MS);

        store.set(key, entry);

        return res.status(429).json({
          success: false,
          message: 'Too many avatar uploads. Try again in 5 minutes.',
          code: 'AVATAR_UPLOAD_RATE_LIMIT',
          retryAfterSeconds: 300,
        });
      }

      store.set(key, entry);
      next();

    } catch (err) {
      console.error('avatarUploadLimiter error:', err);
      return next();
    }
  };
})();

// CAPTCHA GENERATE Limiter: 10 per minute per device
export const captchaGenerateLimiter = (() => {
  const store = new Map();
  const WINDOW_MS = 60 * 1000;
  const MAX_ATTEMPTS = 10;

  return async (req, res, next) => {
    try {
      const deviceId = DeviceFingerprint.generateFingerprint(req);
      const key = `captcha:generate:${deviceId}`;
      const now = Date.now();

      let entry = store.get(key);

      if (!entry || (entry.windowStart && now - entry.windowStart > WINDOW_MS)) {
        entry = { count: 0, blockedUntil: 0, timeout: null, windowStart: now };
      }

      if (entry.blockedUntil && now < entry.blockedUntil) {
        const retrySeconds = Math.ceil((entry.blockedUntil - now) / 1000);
        return res.status(429).json({
          success: false,
          message: 'Too many captcha requests. Please wait.',
          code: 'CAPTCHA_RATE_LIMIT_EXCEEDED',
          retryAfterSeconds: retrySeconds,
        });
      }

      entry.count += 1;

      if (entry.count > MAX_ATTEMPTS) {
        entry.blockedUntil = now + WINDOW_MS;

        if (entry.timeout) clearTimeout(entry.timeout);
        entry.timeout = setTimeout(() => {
          entry.count = 0;
          entry.blockedUntil = 0;
          entry.windowStart = now + WINDOW_MS;
        }, WINDOW_MS);

        store.set(key, entry);

        return res.status(429).json({
          success: false,
          message: 'Too many captcha requests. Please wait.',
          code: 'CAPTCHA_RATE_LIMIT_EXCEEDED',
          retryAfterSeconds: 60,
        });
      }

      store.set(key, entry);
      next();

    } catch (err) {
      console.error('captchaGenerateLimiter error:', err);
      return next();
    }
  };
})();