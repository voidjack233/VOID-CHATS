import crypto from 'crypto';
import { getTwoFactorCodeSecret } from './authSecrets.js';

export function hashEmailVerificationCode(userId, code) {
  return crypto
    .createHmac('sha256', getTwoFactorCodeSecret())
    .update(`${userId}:email_verification:${String(code).trim()}`)
    .digest('hex');
}

export function verifyEmailVerificationCode(userId, submittedCode, storedCode) {
  if (typeof submittedCode !== 'string' || typeof storedCode !== 'string') {
    return false;
  }

  const submittedHash = hashEmailVerificationCode(userId, submittedCode);
  const left = Buffer.from(storedCode, 'hex');
  const right = Buffer.from(submittedHash, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
