import express from 'express';
import { pool as db } from '../../db.js';
import { profileCache } from '../../middleware/profileCache.js';
import { resolveUserAvatarUrl } from '../../utils/avatarFallback.js';

const router = express.Router();

function sanitizeAvatarUrl(avatarUrl) {
  return typeof avatarUrl === 'string' && avatarUrl.startsWith('data:image/svg+xml')
    ? null
    : avatarUrl;
}

// GET /api/users/:profile_id
router.get('/:profile_id', async (req, res) => {
  const { profile_id } = req.params;

  try {
    // Check cache first
    const cached = await profileCache.get(profile_id);
    if (cached && !cached.stale) {
      const cachedData = {
        ...cached.data,
        avatar_url: sanitizeAvatarUrl(cached.data?.avatar_url),
      };
      return res.json(cachedData);
    }

    const result = await db.query(
      `SELECT 
        users.id,
        users.username,
        user_profiles.display_name,
        user_profiles.bio,
        user_profiles.avatar_filename,
        users.created_at,
        users.profile_id
       FROM users
       JOIN user_profiles 
         ON user_profiles.id = users.profile_id
       WHERE users.profile_id = $1`,
      [profile_id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = result.rows[0];
    user.avatar_url = resolveUserAvatarUrl(user.avatar_filename, {
      displayName: user.display_name,
      username: user.username,
    });
    user.avatar_url = sanitizeAvatarUrl(user.avatar_url);

    // Cache it
    await profileCache.set(profile_id, user);

    res.json(user);
  } catch (err) {
    console.error('ProfileRead GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
