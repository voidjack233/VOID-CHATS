import express from 'express';
import { pool as db } from '../../db.js';
import { getLiveUserPresence } from '../../gateway/client.js';
import { resolveUserAvatarUrl } from '../../utils/avatarFallback.js';

const router = express.Router();

// GET /api/friends
router.get('/', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await db.query(
      `SELECT 
        f.id as friendship_id,
        f.created_at as friends_since,
        u.id,
        u.username,
        u.profile_id,
        up.display_name,
        up.avatar_filename,
        up.bio,
        up.created_at as member_since
       FROM friendships f
       JOIN users u ON (
         CASE 
           WHEN f.requester_id = $1 THEN f.addressee_id = u.id
           ELSE f.requester_id = u.id
         END
       )
       LEFT JOIN user_profiles up ON u.profile_id = up.id
       WHERE (f.requester_id = $1 OR f.addressee_id = $1)
         AND f.status = 'accepted'
       ORDER BY f.updated_at DESC`,
      [userId]
    );

    const friends = await Promise.all(result.rows.map(async (friend) => {
      const presence = await getLiveUserPresence(friend.id);

      return {
        ...friend,
        avatar_url: resolveUserAvatarUrl(friend.avatar_filename, {
          displayName: friend.display_name,
          username: friend.username,
        }),
        status: presence.status,
        last_active: presence.lastActive,
      };
    }));

    res.json({
      success: true,
      friends
    });

  } catch (err) {
    console.error('Get friends error:', err);
    res.status(500).json({ error: 'Failed to get friends' });
  }
});

export default router;
