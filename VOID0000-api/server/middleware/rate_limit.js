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
      const deviceId = DeviceFingerprint.ensureFingerprint(req, res);
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

// ── API Endpoints ──

// FRIENDS LIST / PRESENCE: 30 per minute
export const friendsListLimiter = createRateLimiter({
  prefix: 'friends:list',
  windowSec: 60,
  maxAttempts: 30,
});

// FRIENDS PRESENCE: 180 per minute
export const friendsPresenceLimiter = createRateLimiter({
  prefix: 'friends:presence',
  windowSec: 60,
  maxAttempts: 180,
});

// FRIEND ACTIONS (request, accept, reject, cancel, remove): 20 per minute
export const friendActionLimiter = createRateLimiter({
  prefix: 'friends:action',
  windowSec: 60,
  maxAttempts: 20,
});

// MESSAGES FETCH: 60 per minute (pagination, initial load, reconciliation)
export const messagesFetchLimiter = createRateLimiter({
  prefix: 'messages:fetch',
  windowSec: 60,
  maxAttempts: 60,
});

// MESSAGES SEND: 30 per minute
export const messagesSendLimiter = createRateLimiter({
  prefix: 'messages:send',
  windowSec: 60,
  maxAttempts: 30,
});

// MLS SYNC: 30 per minute
export const mlsSyncLimiter = createRateLimiter({
  prefix: 'mls:sync',
  windowSec: 60,
  maxAttempts: 30,
});

// MLS KEY PACKAGE CHECK: 20 per minute
export const mlsKeyPackageCheckLimiter = createRateLimiter({
  prefix: 'mls:kp-check',
  windowSec: 60,
  maxAttempts: 20,
});

// MLS GROUP KEY ARCHIVE: 10 per minute
export const mlsGroupKeyArchiveLimiter = createRateLimiter({
  prefix: 'mls:archive',
  windowSec: 60,
  maxAttempts: 10,
});

// USER SEARCH: 20 per minute
export const userSearchLimiter = createRateLimiter({
  prefix: 'users:search',
  windowSec: 60,
  maxAttempts: 20,
});

// ── DM Anti-Spam Guard ──
//
// Two-layer behavioral spam detection keyed by authenticated user ID.
// Layer 1: Per-user message rate (burst + sustained + backstop windows)
// Layer 2: Fan-out detector (unique conversations in a time window)
// All Valkey work runs in a single pipeline (one round trip).

const SPAM_MSG_LIMITS = [
  { windowMs: 10_000, max: 15 },   // burst: 15 msgs in 10s
  { windowMs: 60_000, max: 60 },   // sustained: 60 msgs in 60s
  { windowMs: 900_000, max: 300 }, // backstop: 300 msgs in 15min
];
const SPAM_MSG_TTL = 900;           // 15 min (matches longest window)
const SPAM_MSG_BLOCKS = [30, 300, 1800]; // 30s → 5min → 30min

const SPAM_FANOUT_LIMITS = [
  { windowMs: 300_000, max: 10 },   // 10 unique conversations in 5min
  { windowMs: 3_600_000, max: 25 }, // 25 unique conversations in 1hr
];
const SPAM_FANOUT_TTL = 3600;       // 1 hr (matches longest window)
const SPAM_FANOUT_BLOCKS = [120, 900, 3600]; // 2min → 15min → 1hr

function createDmSpamGuard() {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id;
      const conversationId = req.params?.conversationId;
      if (!userId) return next();

      const now = Date.now();
      const msgKey = `spam:msgs:${userId}`;
      const fanoutKey = `spam:fanout:${userId}`;
      const blockKey = `spam:block:${userId}`;

      // ── Check existing block ──
      const blockRaw = await valkey.get(blockKey);
      if (blockRaw) {
        const block = JSON.parse(blockRaw);
        if (block.blockedUntil && now < block.blockedUntil) {
          const retrySeconds = Math.ceil((block.blockedUntil - now) / 1000);
          return res.status(429).json({
            success: false,
            message: block.reason === 'fanout'
              ? "You're messaging too many people too quickly. Please wait."
              : 'Too many messages. Please wait.',
            code: block.reason === 'fanout' ? 'DM_SPAM_FANOUT_LIMIT' : 'DM_SPAM_RATE_LIMIT',
            retryAfter: `${retrySeconds} seconds`,
            retryAfterSeconds: retrySeconds,
            resetTime: block.blockedUntil,
          });
        }
      }

      // ── Single pipeline: trim, count, record ──
      const pipeline = valkey.pipeline();

      // Message rate: trim entries older than 15min
      pipeline.zremrangebyscore(msgKey, '-inf', now - SPAM_MSG_LIMITS[2].windowMs);
      // Message rate: count per window
      for (const limit of SPAM_MSG_LIMITS) {
        pipeline.zcount(msgKey, now - limit.windowMs, '+inf');
      }
      // Message rate: add this message
      pipeline.zadd(msgKey, now, `${now}:${Math.random().toString(36).slice(2, 8)}`);
      pipeline.expire(msgKey, SPAM_MSG_TTL);

      // Fan-out: trim entries older than 1hr
      pipeline.zremrangebyscore(fanoutKey, '-inf', now - SPAM_FANOUT_LIMITS[1].windowMs);
      // Fan-out: record this conversation (ZADD updates score if member exists)
      if (conversationId) {
        pipeline.zadd(fanoutKey, now, conversationId);
      }
      // Fan-out: count per window
      for (const limit of SPAM_FANOUT_LIMITS) {
        pipeline.zcount(fanoutKey, now - limit.windowMs, '+inf');
      }
      pipeline.expire(fanoutKey, SPAM_FANOUT_TTL);

      const results = await pipeline.exec();

      // ── Parse results ──
      // Pipeline order: [trimMsg, count10s, count60s, count15m, addMsg, expireMsg,
      //                  trimFanout, addFanout?, countFanout5m, countFanout1h, expireFanout]
      const msgCounts = [
        Number(results[1]?.[1] || 0), // 10s window
        Number(results[2]?.[1] || 0), // 60s window
        Number(results[3]?.[1] || 0), // 15min window
      ];

      const fanoutOffset = conversationId ? 8 : 7;
      const fanoutCounts = [
        Number(results[fanoutOffset]?.[1] || 0),     // 5min window
        Number(results[fanoutOffset + 1]?.[1] || 0), // 1hr window
      ];

      // ── Evaluate message rate limits ──
      for (let i = 0; i < SPAM_MSG_LIMITS.length; i++) {
        if (msgCounts[i] >= SPAM_MSG_LIMITS[i].max) {
          const block = blockRaw ? JSON.parse(blockRaw) : { msgHits: 0, fanoutHits: 0 };
          block.msgHits = (block.msgHits || 0) + 1;
          const idx = Math.min(block.msgHits - 1, SPAM_MSG_BLOCKS.length - 1);
          const blockSec = SPAM_MSG_BLOCKS[idx];
          block.blockedUntil = now + blockSec * 1000;
          block.reason = 'rate';

          await valkey.set(blockKey, JSON.stringify(block), 'EX', blockSec);

          return res.status(429).json({
            success: false,
            message: 'Too many messages. Please wait.',
            code: 'DM_SPAM_RATE_LIMIT',
            retryAfter: `${blockSec} seconds`,
            retryAfterSeconds: blockSec,
            resetTime: block.blockedUntil,
          });
        }
      }

      // ── Evaluate fan-out limits ──
      for (let i = 0; i < SPAM_FANOUT_LIMITS.length; i++) {
        if (fanoutCounts[i] >= SPAM_FANOUT_LIMITS[i].max) {
          const block = blockRaw ? JSON.parse(blockRaw) : { msgHits: 0, fanoutHits: 0 };
          block.fanoutHits = (block.fanoutHits || 0) + 1;
          const idx = Math.min(block.fanoutHits - 1, SPAM_FANOUT_BLOCKS.length - 1);
          const blockSec = SPAM_FANOUT_BLOCKS[idx];
          block.blockedUntil = now + blockSec * 1000;
          block.reason = 'fanout';

          await valkey.set(blockKey, JSON.stringify(block), 'EX', blockSec);

          return res.status(429).json({
            success: false,
            message: "You're messaging too many people too quickly. Please wait.",
            code: 'DM_SPAM_FANOUT_LIMIT',
            retryAfter: `${blockSec} seconds`,
            retryAfterSeconds: blockSec,
            resetTime: block.blockedUntil,
          });
        }
      }

      next();
    } catch (err) {
      console.error('dmSpamGuard error:', err);
      // Fail open — don't block legitimate traffic on Valkey failure
      next();
    }
  };
}

export const dmSpamGuard = createDmSpamGuard();
