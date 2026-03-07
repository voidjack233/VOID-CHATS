// server/routes/conversations/attachments.js
// POST /api/conversations/:conversationId/attachments
// Uploads images directly to MinIO and returns CDN URLs.
// Images are uploaded before the message is sent so the URL
// can be included in the encrypted message payload.

import { Router } from 'express';
import sharp from 'sharp';
import { pool } from '../../db.js';
import { minioClient } from '../../minio.js';

const router = Router({ mergeParams: true });

const ATTACH_BUCKET = process.env.MINIO_ATTACH_BUCKET || 'chat-attachments';
const CDN_BASE = process.env.CDN_URL || 'https://cdn.void0000.online';
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB base64 string length
const MAX_DIMENSION = 2000;

const ALLOWED_MIME_PREFIXES = [
  'data:image/jpeg',
  'data:image/jpg',
  'data:image/png',
  'data:image/gif',
  'data:image/webp',
];

const MAGIC_BYTES = {
  jpeg: [0xff, 0xd8, 0xff],
  png:  [0x89, 0x50, 0x4e, 0x47],
  gif:  [0x47, 0x49, 0x46],
  webp: [0x52, 0x49, 0x46, 0x46],
};

const isValidImage = (buf) =>
  buf.length >= 4 &&
  Object.values(MAGIC_BYTES).some((magic) =>
    magic.every((byte, i) => buf[i] === byte)
  );

const isGif = (buf) =>
  MAGIC_BYTES.gif.every((byte, i) => buf[i] === byte);

// Public read policy for CDN access
const PUBLIC_READ_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow',
    Principal: { AWS: ['*'] },
    Action: ['s3:GetObject'],
    Resource: [`arn:aws:s3:::${ATTACH_BUCKET}/*`],
  }],
});

// Ensure bucket exists with public read policy (run once on first import)
(async () => {
  try {
    const exists = await minioClient.bucketExists(ATTACH_BUCKET);
    if (!exists) {
      await minioClient.makeBucket(ATTACH_BUCKET);
      console.log(`✅ MinIO bucket '${ATTACH_BUCKET}' created`);
    }
    // Always ensure public read policy is set
    await minioClient.setBucketPolicy(ATTACH_BUCKET, PUBLIC_READ_POLICY);
    console.log(`✅ MinIO bucket '${ATTACH_BUCKET}' public read policy set`);
  } catch (err) {
    console.error('❌ MinIO attach bucket error:', err.message);
  }
})();

// POST /api/conversations/:conversationId/attachments
// Body: { files: [{ data: 'data:image/...;base64,...', name: 'optional.jpg' }] }
// Returns: { urls: ['https://cdn.../chat-attachments/...'] }
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { files } = req.body;

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files array required' });
  }

  if (files.length > MAX_FILES) {
    return res.status(400).json({ error: `Maximum ${MAX_FILES} files per message` });
  }

  // Verify membership
  try {
    const member = await pool.query(
      `SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );
    if (member.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Membership check failed' });
  }

  const urls = [];

  for (const file of files) {
    const { data } = file;

    if (!data || typeof data !== 'string') {
      return res.status(400).json({ error: 'Each file must have a data field' });
    }

    if (data.length > MAX_FILE_BYTES) {
      return res.status(400).json({ error: 'File too large. Maximum 10MB per image.' });
    }

    const hasValidPrefix = ALLOWED_MIME_PREFIXES.some((p) =>
      data.toLowerCase().startsWith(p)
    );
    if (!hasValidPrefix) {
      return res.status(400).json({ error: 'Invalid image format. Use JPG, PNG, GIF, or WebP.' });
    }

    // Strip data URL prefix and decode
    const base64 = data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');

    if (!isValidImage(buffer)) {
      return res.status(400).json({ error: 'File is not a valid image' });
    }

    try {
      let processed;
      let contentType;
      let ext;

      if (isGif(buffer)) {
        // Keep GIFs as-is to preserve animation
        processed = buffer;
        contentType = 'image/gif';
        ext = 'gif';
      } else {
        // Resize and convert to WebP
        const meta = await sharp(buffer).metadata();
        const needsResize = meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION;

        const pipeline = sharp(buffer).rotate(); // strip EXIF, auto-orient
        if (needsResize) {
          pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true });
        }
        processed = await pipeline.webp({ quality: 85 }).toBuffer();
        contentType = 'image/webp';
        ext = 'webp';
      }

      const filename = `msg-${userId.substring(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;

      await minioClient.putObject(
        ATTACH_BUCKET,
        filename,
        processed,
        processed.length,
        { 'Content-Type': contentType }
      );

      urls.push(`${CDN_BASE}/${ATTACH_BUCKET}/${filename}`);
    } catch (err) {
      console.error('Attachment upload error:', err);
      return res.status(500).json({ error: 'Failed to process image' });
    }
  }

  res.json({ success: true, urls });
});

export default router;
