export const RATE_LIMIT_ALGORITHMS = Object.freeze({
  AUTH_LOCKOUT: 'auth_lockout',
  MULTI_BUCKET: 'multi_bucket',
  TOKEN_BUCKET: 'token_bucket',
});

export const RATE_LIMIT_SCOPES = Object.freeze({
  DEVICE: 'device',
  IP: 'ip',
  SUBJECT: 'subject',
  USER: 'user',
});
