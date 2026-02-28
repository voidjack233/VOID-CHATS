// middleware/sessionStore.js
import valkey from '../valkey.js';

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days (matches refresh token expiry)

/**
 * Valkey-backed session store
 * Works alongside your existing JWT refresh tokens to provide:
 * - Fast session lookups without DB queries
 * - Instant session revocation
 * - Active session tracking per user
 */
export const sessionStore = {
  /**
   * Create/update a session when tokens are issued
   */
  async create(userId, deviceId, metadata = {}) {
    try {
      const sessionKey = `session:${userId}:${deviceId}`;
      const session = {
        userId,
        deviceId,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        ip: metadata.ip || 'unknown',
        userAgent: metadata.userAgent || 'unknown',
        deviceName: metadata.deviceName || 'Unknown',
        deviceType: metadata.deviceType || 'unknown',
      };

      await valkey.set(sessionKey, JSON.stringify(session), 'EX', SESSION_TTL);

      // Track all sessions for this user
      await valkey.sadd(`user_sessions:${userId}`, deviceId);
      await valkey.expire(`user_sessions:${userId}`, SESSION_TTL);

      return session;
    } catch (err) {
      console.error('Session create error:', err);
      return null;
    }
  },

  /**
   * Quick session validation (used by auth middleware instead of DB query)
   */
  async validate(userId, deviceId) {
    try {
      const sessionKey = `session:${userId}:${deviceId}`;
      const raw = await valkey.get(sessionKey);
      if (!raw) return null;

      // Update last seen
      const session = JSON.parse(raw);
      session.lastSeenAt = Date.now();
      await valkey.set(sessionKey, JSON.stringify(session), 'EX', SESSION_TTL);

      return session;
    } catch (err) {
      console.error('Session validate error:', err);
      return null;
    }
  },

  /**
   * Revoke a single session (logout from one device)
   */
  async revoke(userId, deviceId) {
    try {
      await valkey.del(`session:${userId}:${deviceId}`);
      await valkey.srem(`user_sessions:${userId}`, deviceId);
      return true;
    } catch (err) {
      console.error('Session revoke error:', err);
      return false;
    }
  },

  /**
   * Revoke all sessions for a user (logout everywhere)
   */
  async revokeAll(userId) {
    try {
      const deviceIds = await valkey.smembers(`user_sessions:${userId}`);
      if (deviceIds.length > 0) {
        const keys = deviceIds.map((d) => `session:${userId}:${d}`);
        await valkey.del(...keys);
      }
      await valkey.del(`user_sessions:${userId}`);
      return true;
    } catch (err) {
      console.error('Session revokeAll error:', err);
      return false;
    }
  },

  /**
   * Get all active sessions for a user
   */
  async getAll(userId) {
    try {
      const deviceIds = await valkey.smembers(`user_sessions:${userId}`);
      if (deviceIds.length === 0) return [];

      const pipeline = valkey.pipeline();
      deviceIds.forEach((d) => pipeline.get(`session:${userId}:${d}`));
      const results = await pipeline.exec();

      return results
        .map(([err, raw]) => (err || !raw ? null : JSON.parse(raw)))
        .filter(Boolean);
    } catch (err) {
      console.error('Session getAll error:', err);
      return [];
    }
  },

  /**
   * Touch session — update last seen without full validation
   */
  async touch(userId, deviceId) {
    try {
      const sessionKey = `session:${userId}:${deviceId}`;
      const raw = await valkey.get(sessionKey);
      if (!raw) return false;

      const session = JSON.parse(raw);
      session.lastSeenAt = Date.now();
      await valkey.set(sessionKey, JSON.stringify(session), 'EX', SESSION_TTL);
      return true;
    } catch (err) {
      console.error('Session touch error:', err);
      return false;
    }
  },
};