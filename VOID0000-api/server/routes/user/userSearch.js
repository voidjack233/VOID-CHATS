import express from 'express';
import { pool as db } from '../../db.js';
import { authenticateUser } from '../../middleware/jwt.js';

const router = express.Router();

const getAvatarUrl = (avatarFilename, username) => {
  const APIBASE = process.env.CDN_URL || 'https://cdn.void0000.online';
  
  return avatarFilename
    ? `${APIBASE}/avatars/${avatarFilename}`
    : `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`;
};

// GET /api/users/search?q=username
router.get('/', authenticateUser, async (req, res) => {
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
      avatar_url: getAvatarUrl(user.avatar_filename, user.username)
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