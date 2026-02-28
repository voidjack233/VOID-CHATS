// middleware/profileCache.js
import valkey from '../valkey.js';

const CACHE_TTL = 300;       // 5 minutes fresh
const STALE_TTL = 600;       // 10 minutes stale (still servable while revalidating)

/**
 * Cache user profile data in Valkey with stale-while-revalidate
 */
export const profileCache = {
  /**
   * Get cached profile — returns { data, stale } or null
   */
  async get(userId) {
    try {
      const raw = await valkey.get(`profile:${userId}`);
      if (!raw) return null;

      const cached = JSON.parse(raw);
      const age = Date.now() - cached.cachedAt;

      return {
        data: cached.data,
        stale: age > CACHE_TTL * 1000,
      };
    } catch (err) {
      console.error('Profile cache get error:', err);
      return null;
    }
  },

  /**
   * Store profile in cache
   */
  async set(userId, data) {
    try {
      const payload = {
        data,
        cachedAt: Date.now(),
      };
      await valkey.set(`profile:${userId}`, JSON.stringify(payload), 'EX', STALE_TTL);
    } catch (err) {
      console.error('Profile cache set error:', err);
    }
  },

  /**
   * Invalidate a user's cached profile (call after profile updates)
   */
  async invalidate(userId) {
    try {
      await valkey.del(`profile:${userId}`);
    } catch (err) {
      console.error('Profile cache invalidate error:', err);
    }
  },

  /**
   * Invalidate multiple users (e.g., after batch updates)
   */
  async invalidateMany(userIds) {
    try {
      if (userIds.length === 0) return;
      const keys = userIds.map((id) => `profile:${id}`);
      await valkey.del(...keys);
    } catch (err) {
      console.error('Profile cache invalidateMany error:', err);
    }
  },
};

/**
 * Express middleware for profile read endpoints
 * Usage: router.get('/profile/:id', profileCacheMiddleware, handler)
 */
export const profileCacheMiddleware = async (req, res, next) => {
  const userId = req.params.id || req.user?.id;
  if (!userId) return next();

  try {
    const cached = await profileCache.get(userId);

    if (cached && !cached.stale) {
      // Fresh cache — serve directly
      return res.json({ success: true, ...cached.data, fromCache: true });
    }

    if (cached && cached.stale) {
      // Stale cache — serve stale, revalidate in background
      res.json({ success: true, ...cached.data, fromCache: true });

      // Attach flag so route handler knows to update cache in background
      req._revalidateCache = true;
      req._cacheUserId = userId;
      // Don't return — let the handler run in background to update cache
      // But we already sent the response, so the handler should just update cache
      return;
    }

    // No cache — let handler run normally
    req._cacheUserId = userId;
    next();
  } catch (err) {
    console.error('Profile cache middleware error:', err);
    next();
  }
};