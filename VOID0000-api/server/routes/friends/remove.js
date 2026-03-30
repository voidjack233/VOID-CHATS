import express from 'express';
import { pool as db } from '../../db.js';
import { EVENTS } from '../../gateway/protocol.js';
import { sendLiveEventToUser } from '../../gateway/client.js';
import { friendshipEventId } from '../../utils/eventIdentity.js';

async function hideDmForBoth(requesterId, addresseeId) {
  const [userA, userB] = [requesterId, addresseeId].sort();
  const result = await db.query(
    `UPDATE conversation_members cm
     SET is_hidden = TRUE
     FROM dm_pairs dp
     WHERE dp.conversation_id = cm.conversation_id
       AND dp.user_a = $1
       AND dp.user_b = $2
     RETURNING cm.conversation_id, cm.user_id`,
    [userA, userB]
  );
  return result.rows;
}

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

    sendLiveEventToUser(otherUserId, EVENTS.FRIEND_REMOVE, {
      event_id: friendshipEventId('remove', friendship.id),
      friendship_id: friendship.id,
      removed_by: userId,
      timestamp: Date.now(),
    });

    // Hide the shared DM (if any) for both users.
    try {
      const hidden = await hideDmForBoth(userId, otherUserId);
      if (hidden.length > 0) {
        const conversationId = hidden[0].conversation_id;
        sendLiveEventToUser(userId, EVENTS.DM_HIDDEN, { conversation_id: conversationId });
        sendLiveEventToUser(otherUserId, EVENTS.DM_HIDDEN, { conversation_id: conversationId });
      }
    } catch (dmErr) {
      // Non-fatal: friendship was already removed; just log.
      console.error('Remove friend: failed to hide DM:', dmErr);
    }

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
