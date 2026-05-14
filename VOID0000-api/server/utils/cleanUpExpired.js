import { pool } from '../db.js';
import { debugLog } from './debugLog.js';

export async function cleanupExpiredEmailVerifications() {
  const result = await pool.query(
    `DELETE FROM email_verifications WHERE expires_at < NOW()`
  );
  return result.rowCount;
}

export async function cleanupExpiredPasswordResets() {
  const result = await pool.query(
    `DELETE FROM password_resets WHERE expires_at < NOW()`
  );
  return result.rowCount;
}

export async function cleanupExpiredRefreshTokens() {
  const result = await pool.query(
    `DELETE FROM refresh_tokens WHERE expires_at < NOW()`
  );
  return result.rowCount;
}

export async function cleanupAllExpired() {
  try {
    const emailVerifications = await cleanupExpiredEmailVerifications();
    const passwordResets = await cleanupExpiredPasswordResets();
    const refreshTokens = await cleanupExpiredRefreshTokens();

    debugLog(`🧹 Cleanup complete:
      - Email verifications: ${emailVerifications} deleted
      - Password resets: ${passwordResets} deleted
      - Refresh tokens: ${refreshTokens} deleted
    `);

    return {
      emailVerifications,
      passwordResets,
      refreshTokens
    };
  } catch (err) {
    console.error('Cleanup error:', err);
    throw err;
  }
}
