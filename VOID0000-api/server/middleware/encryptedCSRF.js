import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { getCsrfEncryptionKey } from '../utils/authSecrets.js';

const ALGORITHM = 'aes-256-gcm';

export const generateEncryptedCSRFToken = () => {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, getCsrfEncryptionKey(), iv);
  
  const plainToken = randomBytes(32).toString('base64url');
  
  const payload = {
    token: plainToken,
    timestamp: Date.now(),
    expires: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days
  };

  let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'base64url');
  encrypted += cipher.final('base64url');
  const authTag = cipher.getAuthTag();

  const encryptedToken = `${iv.toString('base64url')}:${encrypted}:${authTag.toString('base64url')}`;
  
  return {
    plainToken,
    encryptedToken
  };
};

export const verifyEncryptedCSRFToken = (encryptedToken) => {
  try {
    
    const parts = encryptedToken.split(':');
    if (parts.length !== 3) {
      return null;
    }

    const [iv, encrypted, authTag] = parts;

    const decipher = createDecipheriv(ALGORITHM, getCsrfEncryptionKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64url'));

    let decrypted = decipher.update(encrypted, 'base64url', 'utf8');
    decrypted += decipher.final('utf8');

    const payload = JSON.parse(decrypted);

    if (Date.now() > payload.expires) {
      return null;
    }

    return payload.token;
  } catch (error) {
    return null;
  }
};

export const encryptedCSRFProtection = (req, res, next) => {
  const publicEndpoints = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/forgot-password',
    '/api/auth/refresh',
    '/api/auth/verify-email',
    '/api/auth/resend-email-code',
    '/api/auth/reset-password',
    '/api/auth/check-reset-token',
    '/api/auth/validate-token',
    '/api/auth/send-code',
    '/api/auth/2fa/verify-login',
    '/api/auth/2fa/verify-login/send-email',
  ];
  
  if (publicEndpoints.includes(req.path)) {
    return next();
  }
  
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const csrfTokenCookie = req.cookies._csrf;
  const csrfTokenHeader = req.headers['x-csrf-token'];

  if (!csrfTokenCookie || !csrfTokenHeader) {
    return res.status(403).json({
      success: false,
      message: 'CSRF token required',
      code: 'CSRF_TOKEN_MISSING'
    });
  }

  const decryptedToken = verifyEncryptedCSRFToken(csrfTokenCookie);

  if (!decryptedToken) {
    return res.status(403).json({
      success: false,
      message: 'CSRF token validation failed',
      code: 'CSRF_TOKEN_INVALID'
    });
  }

  if (decryptedToken !== csrfTokenHeader) {
    return res.status(403).json({
      success: false,
      message: 'CSRF token validation failed',
      code: 'CSRF_TOKEN_MISMATCH'
    });
  }

  next();
};
