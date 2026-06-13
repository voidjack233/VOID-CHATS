import crypto from 'crypto';
import { getClientIP, IPSecurity } from '../../utils/securityUtils.js';
import { DeviceFingerprint } from '../../utils/deviceFingerprint.js';
import { RATE_LIMIT_SCOPES } from './algorithms.js';
import { consumeTokenBucket } from './tokenBucketLimiter.js';

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

function normalizeDimension(dimension) {
  return {
    scope: dimension.scope,
    refillWindowSec: toPositiveInteger(dimension.refillWindowSec, 60),
    bucketSize: toPositiveInteger(dimension.bucketSize, 5),
    blockSeconds: normalizeBlockSeconds(dimension.blockSeconds),
  };
}

function normalizePolicy(policy) {
  const keyPrefix = policy.keyPrefix ?? policy.prefix;
  if (!keyPrefix) {
    throw new Error('Auth lockout policy is missing keyPrefix.');
  }

  const dimensions = Array.isArray(policy.dimensions)
    ? policy.dimensions.map(normalizeDimension)
    : [];

  if (dimensions.length === 0) {
    throw new Error(`${keyPrefix} auth lockout policy needs at least one dimension.`);
  }

  return {
    keyPrefix,
    dimensions,
    subjectFields: Array.isArray(policy.subjectFields) ? policy.subjectFields : [],
    logAction: policy.logAction ?? null,
    message: policy.message ?? 'Too many attempts. Please wait.',
    code: policy.code ?? `${keyPrefix.toUpperCase()}_RATE_LIMIT_EXCEEDED`,
  };
}

function hashKeyPart(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 40);
}

function getSubject(req, fields) {
  for (const field of fields) {
    const value = req.body?.[field] ?? req.query?.[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim().toLowerCase();
    }
  }

  return null;
}

function getDimensionId(req, res, policy, scope) {
  if (scope === RATE_LIMIT_SCOPES.DEVICE) {
    return DeviceFingerprint.ensureFingerprint(req, res);
  }

  if (scope === RATE_LIMIT_SCOPES.IP) {
    return hashKeyPart(getClientIP(req) || 'unknown');
  }

  if (scope === RATE_LIMIT_SCOPES.SUBJECT) {
    const subject = getSubject(req, policy.subjectFields);
    return subject ? hashKeyPart(subject) : null;
  }

  return null;
}

function logLimitHit(req, logAction) {
  if (!logAction) {
    return;
  }

  void IPSecurity.logIPActivity(req, logAction).catch((err) => {
    console.error(`${logAction} logging failed:`, err);
  });
}

function sendLockoutResponse(res, policy, result) {
  const now = Date.now();
  const cooldownUntil = Math.max(
    now + (result.retrySeconds * 1000),
    Number(result.resetTime) || 0,
  );
  const retryAfterMs = Math.max(1_000, cooldownUntil - now);
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));

  res.set('Retry-After', String(retryAfterSeconds));

  return res.status(429).json({
    success: false,
    message: policy.message,
    code: policy.code,
    retryAfterMs,
    cooldownUntil,
    // Keep the legacy fields during rollout for older clients.
    retryAfter: `${retryAfterSeconds} seconds`,
    retryAfterSeconds,
    resetTime: cooldownUntil,
  });
}

export function createAuthLockoutLimiter(rawPolicy) {
  const policy = normalizePolicy(rawPolicy);

  return async (req, res, next) => {
    try {
      for (const dimension of policy.dimensions) {
        const dimensionId = getDimensionId(req, res, policy, dimension.scope);
        if (!dimensionId) {
          continue;
        }

        const result = await consumeTokenBucket({
          key: `rl:${policy.keyPrefix}:${dimension.scope}:${dimensionId}`,
          refillWindowSec: dimension.refillWindowSec,
          bucketSize: dimension.bucketSize,
          blockSeconds: dimension.blockSeconds,
        });

        if (!result.allowed) {
          logLimitHit(req, policy.logAction);
          return sendLockoutResponse(res, policy, result);
        }
      }

      return next();
    } catch (err) {
      console.error(`${policy.keyPrefix} authLockoutLimiter error:`, err);
      return next();
    }
  };
}
