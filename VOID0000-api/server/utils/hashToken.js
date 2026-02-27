import { createHash } from 'crypto';

/**
 * Hash a refresh token using SHA-256.
 * SHA-256 is appropriate here because refresh tokens are already
 * high-entropy (UUIDs + JWT signing), so we don't need bcrypt/argon2.
 * This protects against DB leaks — an attacker can't use stolen hashes
 * to forge valid cookie tokens.
 */
export const hashToken = (token) => {
  return createHash('sha256').update(token).digest('hex');
};