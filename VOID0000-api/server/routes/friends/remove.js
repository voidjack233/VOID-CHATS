import express from 'express';
import { pool as db } from '../../db.js';
import { EVENTS } from '../../gateway/index.js';
import { invalidateLiveFriendCachePair, sendLiveEventToUser } from '../../gateway/client.js';

const router = express.Router();

// DELETE /api/friends/:friendshipId
router.delete('/:friendshipId', async (req, res) => {
  const userId = req.user.id;
  const { friendshipId } = req.params;

  try {
    const result = await db.query(
      `DELETE FROM friendships 
       WHERE id = $1 
         AND (requester_id = $2 OR addressee_id = $2)
         AND status = 'accepted'
       RETURNING *`,
      [friendshipId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Friendship not found' });
    }

    const friendship = result.rows[0];

    const otherUserId = friendship.requester_id === userId 
      ? friendship.addressee_id 
      : friendship.requester_id;

    // Invalidate friend cache for both users
    invalidateLiveFriendCachePair(userId, otherUserId);

    sendLiveEventToUser(otherUserId, EVENTS.FRIEND_REMOVE, {
      friendship_id: friendship.id,
      removed_by: userId,
      timestamp: Date.now(),
    });

    res.json({
      success: true,
      message: 'Friend removed'
    });

  } catch (err) {
    console.error('Remove friend error:', err);
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

export default router;
