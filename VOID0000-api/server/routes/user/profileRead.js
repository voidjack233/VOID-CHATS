import express from 'express';
import { pool as db } from '../../db.js';

const router = express.Router();

// GET /api/users/:profile_id
router.get('/:profile_id', async (req, res) => {
  const { profile_id } = req.params;

  try {
    const result = await db.query(
      `SELECT 
      users.id,
      users.username,
      user_profiles.display_name,
      user_profiles.bio,
      user_profiles.avatar_filename,
      users.created_at,
      users.profile_id
   FROM users
   JOIN user_profiles 
     ON user_profiles.id = users.profile_id
   WHERE users.profile_id = $1`,
      [profile_id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = result.rows[0];

    const baseUrl = process.env.CDN_URL || 'https://cdn.void0000.online';

    user.avatar_url = user.avatar_filename
      ? `${baseUrl}/avatars/${user.avatar_filename}`
      : `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.username}`;

    res.json(user);
  } catch (err) {
    console.error('ProfileRead GET error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;