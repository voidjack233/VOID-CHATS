const MIN_SECRET_LENGTH = 32;
const REQUIRED_AUTH_SECRET_NAMES = [
  'ACCESS_SECRET',
  'REFRESH_SECRET',
  'CSRF_ENCRYPTION_KEY',
  'TOTP_ENCRYPTION_KEY',
  'TWO_FACTOR_CODE_SECRET',
];

function isPlaceholderSecret(value) {
  const normalized = String(value).trim().toLowerCase();
  return normalized.startsWith('replace-') ||
    normalized.startsWith('change-me') ||
    normalized.startsWith('changeme') ||
    normalized.startsWith('your-secret') ||
    normalized === 'dev' ||
    normalized === 'test' ||
    normalized === 'void-dev-two-factor-code-secret';
}

function getRequiredSecret(name, { minLength = MIN_SECRET_LENGTH } = {}) {
  const value = process.env[name];

  if (!value || isPlaceholderSecret(value)) {
    throw new Error(`${name} is required and must not be a placeholder`);
  }

  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters`);
  }

  return value;
}

function getBase64Key(name, expectedBytes) {
  const value = getRequiredSecret(name);
  const key = Buffer.from(value, 'base64');

  if (key.length !== expectedBytes) {
    throw new Error(`${name} must be a base64-encoded ${expectedBytes}-byte key`);
  }

  return key;
}

function getHexKey(name, expectedBytes) {
  const value = getRequiredSecret(name, { minLength: expectedBytes * 2 });

  if (!/^[a-f0-9]+$/i.test(value) || value.length !== expectedBytes * 2) {
    throw new Error(`${name} must be a hex-encoded ${expectedBytes}-byte key`);
  }

  return Buffer.from(value, 'hex');
}

export function getAccessSecret() {
  return getRequiredSecret('ACCESS_SECRET');
}

export function getRefreshSecret() {
  return getRequiredSecret('REFRESH_SECRET');
}

export function getCsrfEncryptionKey() {
  return getBase64Key('CSRF_ENCRYPTION_KEY', 32);
}

export function getTotpEncryptionKey() {
  return getHexKey('TOTP_ENCRYPTION_KEY', 32);
}

export function getTwoFactorCodeSecret() {
  return getRequiredSecret('TWO_FACTOR_CODE_SECRET');
}

export function validateAuthSecrets() {
  REQUIRED_AUTH_SECRET_NAMES.forEach((name) => {
    if (name === 'CSRF_ENCRYPTION_KEY') {
      getCsrfEncryptionKey();
      return;
    }

    if (name === 'TOTP_ENCRYPTION_KEY') {
      getTotpEncryptionKey();
      return;
    }

    getRequiredSecret(name);
  });
}
