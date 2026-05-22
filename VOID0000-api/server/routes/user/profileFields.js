import express from 'express';
import { pool as db } from '../../db.js';
import { EVENTS } from '../../gateway/protocol.js';
import { broadcastLiveEventToFriends } from '../../gateway/client.js';
import { profileUpdateLimiter } from '../../middleware/rate_limit.js';
import { profileCache } from '../../middleware/profileCache.js';

const router = express.Router();

// AUTHENTICATION MIDDLEWARE
const authenticateUser = (req, res, next) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.userId = req.user.id;
  req.userProfileId = req.user.profile_id;
  next();
};

router.use(authenticateUser);

// PUT /api/users/profile
router.put('/profile', profileUpdateLimiter, async (req, res) => {
  const profile_id = req.userProfileId; // Use authenticated user's profile_id
  const { display_name, bio } = req.body;

  if (bio && bio.length > 200) {
    return res.status(400).json({ error: 'Bio must be 200 characters or less' });
  }

  try {
    const result = await db.query(
      `UPDATE user_profiles
       SET display_name = COALESCE($1, display_name),
           bio = COALESCE($2, bio),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING id AS profile_id, display_name, bio, created_at, updated_at`,
      [display_name, bio, profile_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    await profileCache.invalidate(profile_id);

    // Broadcast profile update to all friends
    broadcastLiveEventToFriends(req.userId, EVENTS.PROFILE_UPDATE, {
      user_id: req.userId,
      profile_id: result.rows[0].profile_id,
      display_name: result.rows[0].display_name,
      bio: result.rows[0].bio,
    });

    res.json(result.rows[0]);
  } catch (err) {
      console.error('ProfileFields PUT error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
