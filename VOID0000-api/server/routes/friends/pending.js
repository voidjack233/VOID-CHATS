import express from 'express';
import { pool as db } from '../../db.js';

const router = express.Router();

const getAvatarUrl = (avatarFilename, username) => {
  const APIBASE = process.env.CDN_URL || 'https://cdn.void0000.online';

  return avatarFilename
    ? `${APIBASE}/avatars/${avatarFilename}`
    : `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`;
};

// GET /api/friends/requests/incoming
router.get('/incoming', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await db.query(
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

    const requests = result.rows.map(request => ({
      ...request,
      avatar_url: getAvatarUrl(request.avatar_filename, request.username)
    }));

    res.json({
      success: true,
      requests
    });

  } catch (err) {
    console.error('Get incoming requests error:', err);
    res.status(500).json({ error: 'Failed to get incoming requests' });
  }
});

// GET /api/friends/requests/outgoing
router.get('/outgoing', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await db.query(
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

    const requests = result.rows.map(request => ({
      ...request,
      avatar_url: getAvatarUrl(request.avatar_filename, request.username)
    }));

    res.json({
      success: true,
      requests
    });

  } catch (err) {
    console.error('Get outgoing requests error:', err);
    res.status(500).json({ error: 'Failed to get outgoing requests' });
  }
});

export default router;