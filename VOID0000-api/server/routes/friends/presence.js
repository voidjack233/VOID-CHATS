import express from 'express';
import { pool as db } from '../../db.js';
import { getBulkUserPresence } from '../../gateway/client.js';

const router = express.Router();

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

// GET /api/friends/presence — lightweight presence-only endpoint.
router.get('/', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await db.query(FRIENDS_QUERY, [userId]);
    const friendIds = result.rows.map((row) => row.id);
    const presenceMap = await getBulkUserPresence(friendIds);

    const presences = friendIds.map((id) => {
      const presence = presenceMap.get(id) || { status: 'offline', lastActive: null };
      return { user_id: id, status: presence.status, last_active: presence.lastActive };
    });

    res.json({ success: true, presences });
  } catch (err) {
    console.error('Get friend presences error:', err);
    res.status(500).json({ error: 'Failed to get presences' });
  }
});

export default router;
