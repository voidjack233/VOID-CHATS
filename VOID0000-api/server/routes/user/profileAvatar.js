import express from 'express';
import { pool as db } from '../../db.js';
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { broadcastToFriends, EVENTS } from '../../gateway/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();
const AVATARS_DIR = path.join(__dirname, 'avatars');

await fs.mkdir(AVATARS_DIR, { recursive: true });

// ==================== CONFIG ====================

const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5MB raw base64
const MAX_IMAGE_DIMENSION = 4096; // Max input dimension before resize
const ALLOWED_MIME_PREFIXES = [
  'data:image/jpeg',
  'data:image/jpg',
  'data:image/png',
  'data:image/gif',
  'data:image/webp',
];

// Magic bytes for image format validation
const MAGIC_BYTES = {
  jpeg: [0xFF, 0xD8, 0xFF],
  png: [0x89, 0x50, 0x4E, 0x47],
  gif: [0x47, 0x49, 0x46],
  webp: [0x52, 0x49, 0x46, 0x46], // RIFF header
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

// PUT /api/users/avatar
router.put('/avatar', async (req, res) => {
  const { avatar } = req.body;
  const profile_id = req.userProfileId;

  // 1. Check presence
  if (!avatar || typeof avatar !== 'string') {
    return res.status(400).json({ error: 'No avatar data provided' });
  }

  // 2. Check base64 size (before decoding)
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

    // 7. Process image (strip EXIF, resize, convert)
    const processedImage = await sharp(imageBuffer)
      .resize(200, 200, { fit: 'cover', position: 'center' })
      .rotate() // Auto-rotate based on EXIF then strip it
      .webp({ quality: 80, effort: 6 })
      .toBuffer();

    const filename = `avatar-${profile_id}-${Date.now()}.webp`;
    const filepath = path.join(AVATARS_DIR, filename);
    await fs.writeFile(filepath, processedImage);

    // 8. Remove old avatar
    if (oldFilename) {
      const oldFilepath = path.join(AVATARS_DIR, oldFilename);
      await fs.unlink(oldFilepath).catch((err) =>
        console.warn('Could not delete old avatar:', err.message)
      );
    }

    // 9. Update database
    const updateResult = await db.query(
      `UPDATE user_profiles
       SET avatar_filename = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id AS profile_id, avatar_filename, display_name, bio, created_at, updated_at`,
      [filename, profile_id]
    );

    const updatedProfile = updateResult.rows[0];
    updatedProfile.avatar_url = `https://api.void0000.online/api/users/avatar/${filename}`;

    // 10. Broadcast to friends
    broadcastToFriends(req.userId, EVENTS.PROFILE_UPDATE, {
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
    console.error('Avatar upload error:', error);
    res.status(500).json({ error: 'Failed to process avatar' });
  }
});

// ==================== DELETE ====================

router.delete('/avatar', async (req, res) => {
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

    if (oldFilename) {
      const filepath = path.join(AVATARS_DIR, oldFilename);
      await fs.unlink(filepath).catch((err) =>
        console.warn('Could not delete avatar file:', err.message)
      );
    }

    const updateResult = await db.query(
      `UPDATE user_profiles
       SET avatar_filename = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id AS profile_id, display_name, bio, created_at, updated_at`,
      [profile_id]
    );

    const updatedProfile = updateResult.rows[0];
    updatedProfile.avatar_url = `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`;

    broadcastToFriends(req.userId, EVENTS.PROFILE_UPDATE, {
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

// ==================== SERVE ====================

router.get('/avatar/:filename', async (req, res) => {
  const { filename } = req.params;

  // Sanitize filename — only allow expected pattern
  if (!/^avatar-\d+-\d+\.webp$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename format' });
  }

  const filepath = path.join(AVATARS_DIR, filename);

  try {
    await fs.access(filepath);
    // Cache for 30 days — filename has timestamp so new uploads = new URLs
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.sendFile(filepath);
  } catch (error) {
    res.status(404).json({ error: 'Avatar not found' });
  }
});

export default router;