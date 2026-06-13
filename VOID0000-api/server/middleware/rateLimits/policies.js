import { RATE_LIMIT_ALGORITHMS, RATE_LIMIT_SCOPES } from './algorithms.js';

function deviceTokenBucket(policy) {
  return {
    algorithm: RATE_LIMIT_ALGORITHMS.TOKEN_BUCKET,
    scope: RATE_LIMIT_SCOPES.DEVICE,
    ...policy,
  };
}

function userTokenBucket(policy) {
  return {
    algorithm: RATE_LIMIT_ALGORITHMS.TOKEN_BUCKET,
    scope: RATE_LIMIT_SCOPES.USER,
    ...policy,
  };
}

function authLockout(policy) {
  return {
    algorithm: RATE_LIMIT_ALGORITHMS.AUTH_LOCKOUT,
    ...policy,
  };
}

function multiBucket(policy) {
  return {
    algorithm: RATE_LIMIT_ALGORITHMS.MULTI_BUCKET,
    ...policy,
  };
}

export const RATE_LIMIT_POLICIES = Object.freeze({
  authDevice: authLockout({
    keyPrefix: 'auth:login',
    code: 'LOGIN_RATE_LIMITED',
    message: 'Too many attempts. Try again later.',
    subjectFields: ['identifier'],
    dimensions: [
      {
        scope: RATE_LIMIT_SCOPES.IP,
        refillWindowSec: 15 * 60,
        bucketSize: 60,
        blockSeconds: [60, 300, 900],
      },
      {
        scope: RATE_LIMIT_SCOPES.SUBJECT,
        refillWindowSec: 15 * 60,
        bucketSize: 10,
        blockSeconds: [300, 900, 3600],
      },
      {
        scope: RATE_LIMIT_SCOPES.DEVICE,
        refillWindowSec: 15 * 60,
        bucketSize: 5,
        blockSeconds: [60, 300, 900],
      },
    ],
    logAction: 'LOGIN_RATE_LIMIT_HIT',
  }),

  forgotPassword: authLockout({
    keyPrefix: 'auth:forgot',
    subjectFields: ['email'],
    dimensions: [
      {
        scope: RATE_LIMIT_SCOPES.IP,
        refillWindowSec: 60 * 60,
        bucketSize: 30,
        blockSeconds: [300, 900, 3600],
      },
      {
        scope: RATE_LIMIT_SCOPES.SUBJECT,
        refillWindowSec: 60 * 60,
        bucketSize: 3,
        blockSeconds: [900, 3600],
      },
      {
        scope: RATE_LIMIT_SCOPES.DEVICE,
        refillWindowSec: 60 * 60,
        bucketSize: 5,
        blockSeconds: [300, 900, 3600],
      },
    ],
    logAction: 'FORGOT_RATE_LIMIT_HIT',
  }),

  resetDevice: authLockout({
    keyPrefix: 'auth:reset',
    subjectFields: ['token'],
    dimensions: [
      {
        scope: RATE_LIMIT_SCOPES.IP,
        refillWindowSec: 60 * 60,
        bucketSize: 30,
        blockSeconds: [300, 900, 3600],
      },
      {
        scope: RATE_LIMIT_SCOPES.SUBJECT,
        refillWindowSec: 60 * 60,
        bucketSize: 5,
        blockSeconds: [900, 3600],
      },
      {
        scope: RATE_LIMIT_SCOPES.DEVICE,
        refillWindowSec: 60 * 60,
        bucketSize: 5,
        blockSeconds: [300, 900, 3600],
      },
    ],
    logAction: 'RESET_RATE_LIMIT_HIT',
  }),

  checkResetToken: authLockout({
    keyPrefix: 'auth:check-reset',
    subjectFields: ['token'],
    dimensions: [
      {
        scope: RATE_LIMIT_SCOPES.IP,
        refillWindowSec: 60 * 60,
        bucketSize: 60,
        blockSeconds: [300, 900, 3600],
      },
      {
        scope: RATE_LIMIT_SCOPES.SUBJECT,
        refillWindowSec: 60 * 60,
        bucketSize: 10,
        blockSeconds: [900, 3600],
      },
      {
        scope: RATE_LIMIT_SCOPES.DEVICE,
        refillWindowSec: 60 * 60,
        bucketSize: 10,
        blockSeconds: [300, 900, 3600],
      },
    ],
    logAction: 'CHECK_RESET_RATE_LIMIT_HIT',
  }),

  registerDevice: authLockout({
    keyPrefix: 'auth:register',
    subjectFields: ['email', 'username'],
    dimensions: [
      {
        scope: RATE_LIMIT_SCOPES.IP,
        refillWindowSec: 24 * 60 * 60,
        bucketSize: 50,
        blockSeconds: [900, 3600, 24 * 60 * 60],
      },
      {
        scope: RATE_LIMIT_SCOPES.SUBJECT,
        refillWindowSec: 24 * 60 * 60,
        bucketSize: 3,
        blockSeconds: [3600, 24 * 60 * 60],
      },
      {
        scope: RATE_LIMIT_SCOPES.DEVICE,
        refillWindowSec: 24 * 60 * 60,
        bucketSize: 5,
        blockSeconds: [900, 3600, 24 * 60 * 60],
      },
    ],
    logAction: 'REGISTER_RATE_LIMIT_HIT',
  }),

  authCheck: deviceTokenBucket({
    keyPrefix: 'auth:check',
    refillWindowSec: 10 * 60,
    bucketSize: 20,
    logAction: 'AUTH_CHECK_RATE_LIMIT_HIT',
  }),

  refreshToken: deviceTokenBucket({
    keyPrefix: 'auth:refresh',
    refillWindowSec: 15 * 60,
    bucketSize: 100,
    logAction: 'REFRESH_RATE_LIMIT_HIT',
  }),

  profileUpdate: userTokenBucket({
    keyPrefix: 'profile:update',
    refillWindowSec: 60,
    bucketSize: 5,
  }),

  avatarUpload: userTokenBucket({
    keyPrefix: 'profile:avatar',
    refillWindowSec: 5 * 60,
    bucketSize: 3,
  }),

  captchaGenerate: multiBucket({
    keyPrefix: 'captcha:generate',
    dimensions: [
      {
        scope: RATE_LIMIT_SCOPES.IP,
        refillWindowSec: 60,
        bucketSize: 30,
        blockSeconds: [60, 300],
      },
      {
        scope: RATE_LIMIT_SCOPES.DEVICE,
        refillWindowSec: 60,
        bucketSize: 8,
        blockSeconds: [60, 300],
      },
    ],
    message: 'Too many captcha refreshes. Please wait.',
  }),

  captchaCheck: multiBucket({
    keyPrefix: 'captcha:check',
    dimensions: [
      {
        scope: RATE_LIMIT_SCOPES.IP,
        refillWindowSec: 60,
        bucketSize: 120,
        blockSeconds: [60, 300],
      },
      {
        scope: RATE_LIMIT_SCOPES.DEVICE,
        refillWindowSec: 60,
        bucketSize: 30,
        blockSeconds: [60, 300],
      },
    ],
    message: 'Too many captcha checks. Please wait.',
  }),

  friendsList: userTokenBucket({
    keyPrefix: 'friends:list',
    refillWindowSec: 60,
    bucketSize: 30,
  }),

  friendsPresence: userTokenBucket({
    keyPrefix: 'friends:presence',
    refillWindowSec: 60,
    bucketSize: 180,
  }),

  friendsRequests: userTokenBucket({
    keyPrefix: 'friends:requests',
    refillWindowSec: 60,
    bucketSize: 60,
  }),

  friendAction: userTokenBucket({
    keyPrefix: 'friends:action',
    refillWindowSec: 60,
    bucketSize: 20,
  }),

  messagesFetch: userTokenBucket({
    keyPrefix: 'messages:fetch',
    refillWindowSec: 10,
    bucketSize: 120,
  }),

  messagesSend: userTokenBucket({
    keyPrefix: 'messages:send',
    refillWindowSec: 60,
    bucketSize: 30,
  }),

  messageReactionToggle: userTokenBucket({
    keyPrefix: 'messages:reactions',
    refillWindowSec: 60,
    bucketSize: 80,
    logAction: 'REACTION_RATE_LIMIT_HIT',
  }),

  linkPreview: userTokenBucket({
    keyPrefix: 'link-preview',
    refillWindowSec: 60,
    bucketSize: 40,
    logAction: 'LINK_PREVIEW_RATE_LIMIT_HIT',
  }),

  mlsSync: userTokenBucket({
    keyPrefix: 'mls:sync',
    refillWindowSec: 60,
    bucketSize: 30,
  }),

  mlsKeyPackageCheck: userTokenBucket({
    keyPrefix: 'mls:kp-check',
    refillWindowSec: 60,
    bucketSize: 20,
  }),

  mlsKeyPackagePublish: userTokenBucket({
    keyPrefix: 'mls:kp-publish',
    refillWindowSec: 60,
    bucketSize: 30,
  }),

  mlsGroupKeyArchive: userTokenBucket({
    keyPrefix: 'mls:archive',
    refillWindowSec: 60,
    bucketSize: 10,
  }),

  userSearch: userTokenBucket({
    keyPrefix: 'users:search',
    refillWindowSec: 60,
    bucketSize: 20,
  }),
});
