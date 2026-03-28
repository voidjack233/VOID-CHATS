import express from 'express';
import { pool as db } from '../../db.js';
import { EVENTS } from '../../gateway/protocol.js';
import {
  getLiveUserPresence,
  sendLiveEventToUser,
} from '../../gateway/client.js';
import { friendshipEventId } from '../../utils/eventIdentity.js';
import { resolveUserAvatarUrl } from '../../utils/avatarFallback.js';

const router = express.Router();

// POST /api/friends/request/:profileId - Send friend request
router.post('/request/:profileId', async (req, res) => {
  const requesterId = req.user.id;
  const { profileId } = req.params;

  try {
    const userResult = await db.query(
      'SELECT id FROM users WHERE profile_id = $1',
      [profileId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const addresseeId = userResult.rows[0].id;

    if (requesterId === addresseeId) {
      return res.status(400).json({ error: 'Cannot send friend request to yourself' });
    }

    const existingResult = await db.query(
      `SELECT * FROM friendships 
       WHERE (requester_id = $1 AND addressee_id = $2)
          OR (requester_id = $2 AND addressee_id = $1)`,
      [requesterId, addresseeId]
    );

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      
      if (existing.status === 'accepted') {
        return res.status(400).json({ error: 'Already friends' });
      }
      if (existing.status === 'pending') {
        return res.status(400).json({ error: 'Friend request already pending' });
      }
      if (existing.status === 'blocked') {
        return res.status(400).json({ error: 'Cannot send request' });
      }
    }

    const result = await db.query(
      `INSERT INTO friendships (requester_id, addressee_id, status)
       VALUES ($1, $2, 'pending')
       RETURNING *`,
      [requesterId, addresseeId]
    );

    const requesterInfo = await db.query(
      `SELECT u.username, u.profile_id, up.display_name, up.avatar_filename
       FROM users u
       LEFT JOIN user_profiles up ON u.profile_id = up.id
       WHERE u.id = $1`,
      [requesterId]
    );

    sendLiveEventToUser(addresseeId, EVENTS.FRIEND_REQUEST, {
      event_id: friendshipEventId('request', result.rows[0].id),
      friendship_id: result.rows[0].id,
      from: {
        id: requesterId,
        username: requesterInfo.rows[0].username,
        profile_id: requesterInfo.rows[0].profile_id,
        display_name: requesterInfo.rows[0].display_name,
        avatar_url: resolveUserAvatarUrl(requesterInfo.rows[0].avatar_filename, {
          displayName: requesterInfo.rows[0].display_name,
          username: requesterInfo.rows[0].username,
        }),
      },
      timestamp: Date.now(),
    });

    res.status(201).json({
      success: true,
      message: 'Friend request sent',
      friendship: result.rows[0]
    });

  } catch (err) {
    console.error('Send friend request error:', err);
    res.status(500).json({ error: 'Failed to send friend request' });
  }
});

// POST /api/friends/accept/:friendshipId
router.post('/accept/:friendshipId', async (req, res) => {
  const userId = req.user.id;
  const { friendshipId } = req.params;

  try {
    const result = await db.query(
      `UPDATE friendships 
       SET status = 'accepted', updated_at = NOW()
       WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
       RETURNING *`,
      [friendshipId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Friend request not found or already handled' });
    }

    const friendship = result.rows[0];

    const accepterInfo = await db.query(
      `SELECT u.username, u.profile_id, u.created_at, up.display_name, up.avatar_filename, up.bio
       FROM users u
       LEFT JOIN user_profiles up ON u.profile_id = up.id
       WHERE u.id = $1`,
      [userId]
    );

    const requesterInfo = await db.query(
      `SELECT u.username, u.profile_id, u.created_at, up.display_name, up.avatar_filename, up.bio
       FROM users u
       LEFT JOIN user_profiles up ON u.profile_id = up.id
       WHERE u.id = $1`,
      [friendship.requester_id]
    );

    const [accepterPresence, requesterPresence] = await Promise.all([
      getLiveUserPresence(userId),
      getLiveUserPresence(friendship.requester_id),
    ]);
    sendLiveEventToUser(friendship.requester_id, EVENTS.FRIEND_ACCEPT, {
      event_id: friendshipEventId('accept', friendship.id),
      friendship_id: friendship.id,
      friend: {
        id: userId,
        username: accepterInfo.rows[0].username,
        profile_id: accepterInfo.rows[0].profile_id,
        display_name: accepterInfo.rows[0].display_name,
        avatar_url: resolveUserAvatarUrl(accepterInfo.rows[0].avatar_filename, {
          displayName: accepterInfo.rows[0].display_name,
          username: accepterInfo.rows[0].username,
        }),
        bio: accepterInfo.rows[0].bio,
        member_since: accepterInfo.rows[0].created_at,
        status: accepterPresence.status,
        last_active: accepterPresence.lastActive,
      },
      timestamp: Date.now(),
    });

    sendLiveEventToUser(userId, EVENTS.FRIEND_ACCEPT, {
      event_id: friendshipEventId('accept', friendship.id),
      friendship_id: friendship.id,
      friend: {
        id: friendship.requester_id,
        username: requesterInfo.rows[0].username,
        profile_id: requesterInfo.rows[0].profile_id,
        display_name: requesterInfo.rows[0].display_name,
        avatar_url: resolveUserAvatarUrl(requesterInfo.rows[0].avatar_filename, {
          displayName: requesterInfo.rows[0].display_name,
          username: requesterInfo.rows[0].username,
        }),
        bio: requesterInfo.rows[0].bio,
        member_since: requesterInfo.rows[0].created_at,
        status: requesterPresence.status,
        last_active: requesterPresence.lastActive,
      },
      timestamp: Date.now(),
    });

    res.json({
      success: true,
      message: 'Friend request accepted',
      friendship
    });

  } catch (err) {
    console.error('Accept friend request error:', err);
    res.status(500).json({ error: 'Failed to accept friend request' });
  }
});

// POST /api/friends/reject/:friendshipId
router.post('/reject/:friendshipId', async (req, res) => {
  const userId = req.user.id;
  const { friendshipId } = req.params;

  try {
    const result = await db.query(
      `DELETE FROM friendships 
       WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
       RETURNING *`,
      [friendshipId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Friend request not found' });
    }

    res.json({
      success: true,
      message: 'Friend request rejected'
    });

  } catch (err) {
    console.error('Reject friend request error:', err);
    res.status(500).json({ error: 'Failed to reject friend request' });
  }
});

// POST /api/friends/cancel/:friendshipId
router.post('/cancel/:friendshipId', async (req, res) => {
  const userId = req.user.id;
  const { friendshipId } = req.params;

  try {
    const result = await db.query(
      `DELETE FROM friendships 
       WHERE id = $1 AND requester_id = $2 AND status = 'pending'
       RETURNING *`,
      [friendshipId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Friend request not found' });
    }

    res.json({
      success: true,
      message: 'Friend request cancelled'
    });

  } catch (err) {
    console.error('Cancel friend request error:', err);
    res.status(500).json({ error: 'Failed to cancel friend request' });
  }
});

export default router;
