import express from 'express';
import { pool as db } from '../../db.js';
import { getBulkUserPresence } from '../../gateway/client.js';
import { resolveUserAvatarUrl } from '../../utils/avatarFallback.js';

const router = express.Router();

// Shared query: returns friend user IDs for the given user.
const FRIENDS_QUERY = `
  SELECT u.id
  FROM friendships f
  JOIN users u ON (
    CASE
      WHEN f.requester_id = $1 THEN f.addressee_id = u.id
      ELSE f.requester_id = u.id
    END
  )
  WHERE (f.requester_id = $1 OR f.addressee_id = $1)
    AND f.status = 'accepted'`;

// GET /api/friends — full friend list with profiles + presence
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

    const friendIds = result.rows.map((r) => r.id);
    const presenceMap = await getBulkUserPresence(friendIds);

    const friends = result.rows.map((friend) => {
      const presence = presenceMap.get(friend.id) || { status: 'offline', lastActive: null };
      return {
        ...friend,
        avatar_url: resolveUserAvatarUrl(friend.avatar_filename, {
          displayName: friend.display_name,
          username: friend.username,
        }),
        status: presence.status,
        last_active: presence.lastActive,
      };
    });

    res.json({ success: true, friends });
  } catch (err) {
    console.error('Get friends error:', err);
    res.status(500).json({ error: 'Failed to get friends' });
  }
});

// GET /api/friends/presence — lightweight presence-only endpoint.
// Returns only { user_id, status, last_active } for each friend.
// No profile data, no avatar resolution — just the status map.
router.get('/presence', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await db.query(FRIENDS_QUERY, [userId]);
    const friendIds = result.rows.map((r) => r.id);
    const presenceMap = await getBulkUserPresence(friendIds);

    const presences = friendIds.map((id) => {
      const p = presenceMap.get(id) || { status: 'offline', lastActive: null };
      return { user_id: id, status: p.status, last_active: p.lastActive };
    });

    res.json({ success: true, presences });
  } catch (err) {
    console.error('Get friend presences error:', err);
    res.status(500).json({ error: 'Failed to get presences' });
  }
});

export default router;
