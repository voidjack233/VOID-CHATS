import { Router } from 'express';
import { pool } from '../db.js';
import { getBulkUserPresence } from '../gateway/client.js';
import { getUserConversations } from './conversations/root/list.js';
import { resolveUserAvatarUrl } from '../utils/avatarFallback.js';

const router = Router();

async function getAccount(userId) {
  const result = await pool.query(
    `SELECT id, email, username, profile_id, created_at
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function getPreferences(userId) {
  const result = await pool.query(
    `SELECT theme, accent_color, bg_color, text_color, hover_color, density, message_group_spacing, chat_font_scale, message_notifications_enabled
     FROM user_preferences
     WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function getFriends(userId) {
  const result = await pool.query(
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

  const friendIds = result.rows.map((row) => row.id);
  const presenceMap = await getBulkUserPresence(friendIds);

  return result.rows.map((friend) => {
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
}

function mapFriendRequest(row) {
  return {
    ...row,
    avatar_url: resolveUserAvatarUrl(row.avatar_filename, {
      displayName: row.display_name,
      username: row.username,
    }),
  };
}

async function getIncomingRequests(userId) {
  const result = await pool.query(
    `SELECT
       f.id as friendship_id,
       f.created_at,
       u.id,
       u.username,
       u.profile_id,
       up.display_name,
       up.avatar_filename
     FROM friendships f
     JOIN users u ON f.requester_id = u.id
     LEFT JOIN user_profiles up ON u.profile_id = up.id
     WHERE f.addressee_id = $1 AND f.status = 'pending'
     ORDER BY f.created_at DESC`,
    [userId]
  );

  return result.rows.map(mapFriendRequest);
}

async function getOutgoingRequests(userId) {
  const result = await pool.query(
    `SELECT
       f.id as friendship_id,
       f.created_at,
       u.id,
       u.username,
       u.profile_id,
       up.display_name,
       up.avatar_filename
     FROM friendships f
     JOIN users u ON f.addressee_id = u.id
     LEFT JOIN user_profiles up ON u.profile_id = up.id
     WHERE f.requester_id = $1 AND f.status = 'pending'
     ORDER BY f.created_at DESC`,
    [userId]
  );

  return result.rows.map(mapFriendRequest);
}

router.get('/', async (req, res) => {
  const userId = req.user.id;

  try {
    const [
      account,
      preferences,
      friends,
      incomingRequests,
      outgoingRequests,
      conversations,
    ] = await Promise.all([
      getAccount(userId),
      getPreferences(userId),
      getFriends(userId),
      getIncomingRequests(userId),
      getOutgoingRequests(userId),
      getUserConversations(userId),
    ]);

    if (!account) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        ...req.user,
        ...account,
      },
      account,
      preferences,
      friends,
      friend_requests: {
        incoming: incomingRequests,
        outgoing: outgoingRequests,
      },
      conversations,
    });
  } catch (err) {
    console.error('Bootstrap GET error:', err);
    res.status(500).json({ success: false, error: 'Failed to load app bootstrap' });
  }
});

export default router;
