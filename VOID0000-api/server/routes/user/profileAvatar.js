// server/routes/user/profileAvatar.js
import express from 'express';
import { pool as db } from '../../db.js';
import sharp from 'sharp';
import { EVENTS } from '../../gateway/protocol.js';
import { broadcastLiveEventToFriends } from '../../gateway/client.js';
import { profileCache } from '../../middleware/profileCache.js';
import { avatarUploadLimiter } from '../../middleware/rate_limit.js';
import { queueImageUpload, imageQueueEvents } from '../../queues/imageQueue.js';
import { minioClient, BUCKET } from '../../minio.js';
import { resolveUserAvatarUrl } from '../../utils/avatarFallback.js';

const router = express.Router();

// ==================== CONFIG ====================

const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5MB raw base64
const MAX_IMAGE_DIMENSION = 4096;
const ALLOWED_MIME_PREFIXES = [
  'data:image/jpeg',
  'data:image/jpg',
  'data:image/png',
  'data:image/gif',
  'data:image/webp',
];

const MAGIC_BYTES = {
  jpeg: [0xFF, 0xD8, 0xFF],
  png: [0x89, 0x50, 0x4E, 0x47],
  gif: [0x47, 0x49, 0x46],
  webp: [0x52, 0x49, 0x46, 0x46],
};

const isValidImage = (buffer) => {
  if (buffer.length < 4) return false;
  return Object.values(MAGIC_BYTES).some((magic) =>
    magic.every((byte, i) => buffer[i] === byte)
  );
};

// ==================== AUTH ====================

const authenticateUser = (req, res, next) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.userId = req.user.id;
  req.userProfileId = req.user.profile_id;
  next();
};

router.use(authenticateUser);

// ==================== UPLOAD ====================

// PUT /api/users/profile/avatar
router.put('/profile/avatar', avatarUploadLimiter, async (req, res) => {
  const { avatar } = req.body;
  const profile_id = req.userProfileId;

  // 1. Check presence
  if (!avatar || typeof avatar !== 'string') {
    return res.status(400).json({ error: 'No avatar data provided' });
  }

  // 2. Check base64 size
  if (avatar.length > MAX_AVATAR_SIZE) {
    return res.status(400).json({ error: 'Image too large. Maximum 5MB.' });
  }

  // 3. Validate MIME prefix
  const hasValidPrefix = ALLOWED_MIME_PREFIXES.some((prefix) =>
    avatar.toLowerCase().startsWith(prefix)
  );
  if (!hasValidPrefix) {
    return res.status(400).json({ error: 'Invalid image format. Use JPG, PNG, GIF, or WebP.' });
  }

  try {
    // 4. Decode and validate magic bytes
    const imageBuffer = Buffer.from(
      avatar.replace(/^data:image\/\w+;base64,/, ''),
      'base64'
    );

    if (!isValidImage(imageBuffer)) {
      return res.status(400).json({ error: 'File is not a valid image' });
    }

    // 5. Check image dimensions (prevent decompression bombs)
    const metadata = await sharp(imageBuffer).metadata();
    if (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION) {
      return res.status(400).json({ error: `Image dimensions too large. Maximum ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}px.` });
    }

    // 6. Fetch current profile
    const userResult = await db.query(
      `SELECT up.id AS profile_id, up.avatar_filename, u.username
       FROM user_profiles up
       JOIN users u ON u.profile_id = up.id
       WHERE up.id = $1`,
      [profile_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { avatar_filename: oldFilename, username } = userResult.rows[0];

    // 7. Queue the image for processing and wait for result
    const imageData = imageBuffer.toString('base64');
    const { jobId, job } = await queueImageUpload({
      userId: req.userId,
      profileId: profile_id,
      imageData,
      oldFilename,
    });

    // 8. Wait for the worker to finish (timeout after 30s)
    const result = await job.waitUntilFinished(imageQueueEvents, 30000);

    const baseUrl = process.env.CDN_URL || 'https://cdn.void0000.online';
    const newAvatarUrl = `${baseUrl}/avatars/${result.filename}`;

    // 9. Get updated profile from DB
    const updatedResult = await db.query(
      `SELECT id AS profile_id, avatar_filename, display_name, bio, created_at, updated_at
       FROM user_profiles WHERE id = $1`,
      [profile_id]
    );

    const updatedProfile = updatedResult.rows[0];
    updatedProfile.avatar_url = newAvatarUrl;

    // 10. Broadcast to friends
    broadcastLiveEventToFriends(req.userId, EVENTS.PROFILE_UPDATE, {
      user_id: req.userId,
      profile_id: updatedProfile.profile_id,
      display_name: updatedProfile.display_name,
      avatar_url: newAvatarUrl,
      bio: updatedProfile.bio,
    });

    res.json({
      ...updatedProfile,
      username,
    });

  } catch (error) {
    console.error('Avatar upload error:', error);
    res.status(500).json({ error: 'Failed to queue avatar upload' });
  }
});

// ==================== DELETE ====================

router.delete('/profile/avatar', async (req, res) => {
  const profile_id = req.userProfileId;

  try {
    const userResult = await db.query(
      `SELECT up.avatar_filename, u.username
       FROM user_profiles up
       JOIN users u ON u.profile_id = up.id
       WHERE up.id = $1`,
      [profile_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { avatar_filename: oldFilename, username } = userResult.rows[0];

    // Delete from MinIO
    if (oldFilename) {
      try {
        await minioClient.removeObject(BUCKET, oldFilename);
      } catch (err) {
        console.warn('Could not delete avatar from MinIO:', err.message);
      }
    }

    // Update database
    const updateResult = await db.query(
      `UPDATE user_profiles
       SET avatar_filename = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id AS profile_id, display_name, bio, created_at, updated_at`,
      [profile_id]
    );

    const updatedProfile = updateResult.rows[0];
    updatedProfile.avatar_url = resolveUserAvatarUrl(null, { username });

    // Invalidate cache
    await profileCache.invalidate(profile_id);

    // Broadcast
    broadcastLiveEventToFriends(req.userId, EVENTS.PROFILE_UPDATE, {
      user_id: req.userId,
      profile_id: updatedProfile.profile_id,
      display_name: updatedProfile.display_name,
      avatar_url: updatedProfile.avatar_url,
      bio: updatedProfile.bio,
    });

    res.json({
      ...updatedProfile,
      username,
    });
  } catch (error) {
    console.error('Avatar deletion error:', error);
    res.status(500).json({ error: 'Failed to remove avatar' });
  }
});

// ==================== SERVE (legacy fallback) ====================

router.get('/profile/avatar/:filename', async (req, res) => {
  const { filename } = req.params;

  if (!/^avatar-\d+-\d+\.webp$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename format' });
  }

  // Redirect to CDN/MinIO
  const baseUrl = process.env.CDN_URL || 'https://cdn.void0000.online';
  res.redirect(301, `${baseUrl}/avatars/${filename}`);
});

export default router;
