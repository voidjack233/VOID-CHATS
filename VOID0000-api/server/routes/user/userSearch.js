import express from 'express';
import { pool as db } from '../../db.js';
import { authenticateUser } from '../../middleware/jwt.js';
import { userSearchLimiter } from '../../middleware/rate_limit.js';
import { resolveUserAvatarUrl } from '../../utils/avatarFallback.js';

const router = express.Router();

// GET /api/users/search?q=username
router.get('/', authenticateUser, userSearchLimiter, async (req, res) => {
  const { q } = req.query;
  const currentUserId = req.user.id;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  const searchTerm = q.trim().toLowerCase();

  try {
    // Uses pg_trgm GIN indexes for fast similarity search
    // Falls back to prefix match (uses btree index) when query is short
    const result = await db.query(
      `SELECT 
        u.id,
        u.username,
        u.profile_id,
        up.display_name,
        up.avatar_filename,
        similarity(u.username, $2) AS rank
       FROM users u
       LEFT JOIN user_profiles up ON u.profile_id = up.id
       WHERE u.id != $1 
         AND (u.username % $2 OR up.display_name % $2)
       ORDER BY rank DESC
       LIMIT 10`,
      [currentUserId, searchTerm]
    );

    const users = result.rows.map(user => ({
      id: user.id,
      username: user.username,
      profile_id: user.profile_id,
      display_name: user.display_name,
      avatar_filename: user.avatar_filename,
      avatar_url: resolveUserAvatarUrl(user.avatar_filename, {
        displayName: user.display_name,
        username: user.username,
      })
    }));

    res.json({
      success: true,
      users
    });
  } catch (err) {
    console.error('User search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

export default router;
