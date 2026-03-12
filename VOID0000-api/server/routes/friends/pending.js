import express from 'express';
import { pool as db } from '../../db.js';
import { resolveUserAvatarUrl } from '../../utils/avatarFallback.js';

const router = express.Router();

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
      avatar_url: resolveUserAvatarUrl(request.avatar_filename, {
        displayName: request.display_name,
        username: request.username,
      })
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
      avatar_url: resolveUserAvatarUrl(request.avatar_filename, {
        displayName: request.display_name,
        username: request.username,
      })
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
