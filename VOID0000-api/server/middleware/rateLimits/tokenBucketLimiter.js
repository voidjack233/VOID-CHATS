import { getClientIP, IPSecurity } from '../../utils/securityUtils.js';
import { DeviceFingerprint } from '../../utils/deviceFingerprint.js';
import valkey from '../../valkey.js';
import { RATE_LIMIT_SCOPES } from './algorithms.js';

const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local keyType = redis.call('TYPE', key).ok
if keyType ~= 'none' and keyType ~= 'hash' then
  redis.call('DEL', key)
end

local now = tonumber(ARGV[1])
local windowSec = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local blockCount = tonumber(ARGV[4])
local windowMs = windowSec * 1000
local refillPerMs = capacity / windowMs

local state = redis.call('HMGET', key, 'tokens', 'updatedAt', 'blockedUntil', 'limitHits', 'lastLimitedAt')
local tokens = tonumber(state[1]) or capacity
local updatedAt = tonumber(state[2]) or now
local blockedUntil = tonumber(state[3]) or 0
local limitHits = tonumber(state[4]) or 0
local lastLimitedAt = tonumber(state[5]) or 0

if lastLimitedAt > 0 and now - lastLimitedAt > windowMs then
  limitHits = 0
  lastLimitedAt = 0
end

if blockedUntil > now then
  local retrySeconds = math.max(1, math.ceil((blockedUntil - now) / 1000))
  redis.call('EXPIRE', key, retrySeconds + windowSec)
  return {0, retrySeconds, blockedUntil, limitHits}
end

local elapsedMs = math.max(0, now - updatedAt)
tokens = math.min(capacity, tokens + (elapsedMs * refillPerMs))
updatedAt = now

if tokens < 1 then
  local retryMs = math.ceil((1 - tokens) / refillPerMs)
  local retrySeconds = math.max(1, math.ceil(retryMs / 1000))
  local resetTime = now + retrySeconds * 1000

  if blockCount > 0 then
    limitHits = limitHits + 1
    local blockIndex = math.min(limitHits, blockCount)
    local blockSec = tonumber(ARGV[4 + blockIndex]) or retrySeconds
    retrySeconds = math.max(1, blockSec)
    resetTime = now + retrySeconds * 1000
    blockedUntil = resetTime
  else
    blockedUntil = 0
  end

  lastLimitedAt = now
  redis.call(
    'HSET',
    key,
    'tokens', tokens,
    'updatedAt', updatedAt,
    'blockedUntil', blockedUntil,
    'limitHits', limitHits,
    'lastLimitedAt', lastLimitedAt
  )
  redis.call('EXPIRE', key, retrySeconds + windowSec)
  return {0, retrySeconds, resetTime, limitHits}
end

tokens = tokens - 1
redis.call(
  'HSET',
  key,
  'tokens', tokens,
  'updatedAt', updatedAt,
  'blockedUntil', 0,
  'limitHits', limitHits,
  'lastLimitedAt', lastLimitedAt
)
redis.call('EXPIRE', key, windowSec)
return {1, 0, 0, limitHits}
`;

function toPositiveInteger(value, fallback) {
  const parsed = Math.ceil(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBlockSeconds(blockSeconds) {
  if (!Array.isArray(blockSeconds)) {
    return [];
  }

  return blockSeconds
    .map((value) => Math.ceil(Number(value)))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function normalizePolicy(policy) {
  const keyPrefix = policy.keyPrefix ?? policy.prefix;
  if (!keyPrefix) {
    throw new Error('Rate limit policy is missing keyPrefix.');
  }

  return {
    keyPrefix,
    scope: policy.scope ?? RATE_LIMIT_SCOPES.DEVICE,
    refillWindowSec: toPositiveInteger(policy.refillWindowSec ?? policy.windowSec, 1),
    bucketSize: toPositiveInteger(policy.bucketSize ?? policy.maxAttempts, 1),
    blockSeconds: normalizeBlockSeconds(policy.blockSeconds ?? policy.escalatingBlocks),
    logAction: policy.logAction ?? null,
    message: policy.message ?? 'Too many requests. Please wait.',
    code: policy.code ?? `${keyPrefix.toUpperCase()}_RATE_LIMIT_EXCEEDED`,
  };
}

function getScopeId(req, res, scope) {
  if (scope === RATE_LIMIT_SCOPES.USER && req.user?.id) {
    return `user:${req.user.id}`;
  }

  if (scope === RATE_LIMIT_SCOPES.IP) {
    return `ip:${getClientIP(req) || 'unknown'}`;
  }

  return DeviceFingerprint.ensureFingerprint(req, res);
}

function logLimitHit(req, logAction) {
  if (!logAction) {
    return;
  }

  void IPSecurity.logIPActivity(req, logAction).catch((err) => {
    console.error(`${logAction} logging failed:`, err);
  });
}

function sendRateLimitResponse(res, policy, retrySeconds, resetTime) {
  res.set('Retry-After', String(retrySeconds));
  res.set('X-RateLimit-Limit', String(policy.bucketSize));

  return res.status(429).json({
    success: false,
    message: policy.message,
    code: policy.code,
    retryAfter: `${retrySeconds} seconds`,
    retryAfterSeconds: retrySeconds,
    resetTime,
  });
}

export async function consumeTokenBucket({ key, refillWindowSec, bucketSize, blockSeconds }) {
  const result = await valkey.eval(
    TOKEN_BUCKET_SCRIPT,
    1,
    key,
    Date.now(),
    refillWindowSec,
    bucketSize,
    blockSeconds.length,
    ...blockSeconds,
  );

  const allowed = Number(result?.[0]) === 1;
  const retrySeconds = Math.max(1, Number(result?.[1]) || refillWindowSec);
  const resetTime = Number(result?.[2]) || Date.now() + retrySeconds * 1000;

  return {
    allowed,
    retrySeconds,
    resetTime,
    limitHits: Number(result?.[3]) || 0,
  };
}

export function createTokenBucketLimiter(rawPolicy) {
  const policy = normalizePolicy(rawPolicy);

  return async (req, res, next) => {
    try {
      const scopeId = getScopeId(req, res, policy.scope);
      const key = `rl:${policy.keyPrefix}:${scopeId}`;

      const result = await consumeTokenBucket({
        key,
        refillWindowSec: policy.refillWindowSec,
        bucketSize: policy.bucketSize,
        blockSeconds: policy.blockSeconds,
      });

      if (result.allowed) {
        return next();
      }

      logLimitHit(req, policy.logAction);
      return sendRateLimitResponse(res, policy, result.retrySeconds, result.resetTime);
    } catch (err) {
      console.error(`${policy.keyPrefix} rateLimiter error:`, err);
      return next();
    }
  };
}
