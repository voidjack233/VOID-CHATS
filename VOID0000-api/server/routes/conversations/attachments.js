// server/routes/conversations/attachments.js
// POST /api/conversations/:conversationId/attachments
// Uploads images directly to MinIO and returns CDN URLs.
// Images are uploaded before the message is sent so the URL
// can be included in the encrypted message payload.

import { Router } from 'express';
import sharp from 'sharp';
import { encode } from 'blurhash';
import { pool } from '../../db.js';
import { minioClient, ATTACH_BUCKET } from '../../minio.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';

const router = Router({ mergeParams: true });

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
  png: [0x89, 0x50, 0x4e, 0x47],
  gif: [0x47, 0x49, 0x46],
  webp: [0x52, 0x49, 0x46, 0x46],
};

const isValidImage = (buf) =>
  buf.length >= 4 &&
  Object.values(MAGIC_BYTES).some((magic) =>
    magic.every((byte, i) => buf[i] === byte)
  );

const isGif = (buf) => MAGIC_BYTES.gif.every((byte, i) => buf[i] === byte);

// POST /api/conversations/:conversationId/attachments
// Body: { files: [{ data: 'data:image/...;base64,...', name: 'optional.jpg' }] }
// Returns: { urls: ['https://cdn.../chat-attachments/...'] }
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier } = req.params;
  const { files } = req.body;

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files array required' });
  }

  if (files.length > MAX_FILES) {
    return res.status(400).json({ error: `Maximum ${MAX_FILES} files per message` });
  }

  let conversation;

  try {
    conversation = await findConversationByIdentifier(conversationIdentifier);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const member = await pool.query(
      `SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [conversation.id, userId]
    );
    if (member.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Membership check failed' });
  }

  const urls = [];
  const blurhashes = [];

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
        processed = buffer;
        contentType = 'image/gif';
        ext = 'gif';
      } else {
        const meta = await sharp(buffer).metadata();
        const needsResize = meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION;

        const pipeline = sharp(buffer).rotate();
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

      try {
        const THUMB = 32;
        const { data: blurhashData, info } = await sharp(processed)
          .resize(THUMB, THUMB, { fit: 'inside' })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const hash = encode(new Uint8ClampedArray(blurhashData), info.width, info.height, 4, 4);
        blurhashes.push(hash);
      } catch {
        blurhashes.push('');
      }
    } catch (err) {
      console.error('Attachment upload error:', err);
      return res.status(500).json({ error: 'Failed to process image' });
    }
  }

  res.json({
    success: true,
    conversation_id: conversation.id,
    conversation_public_id: conversation.public_id ? String(conversation.public_id) : null,
    urls,
    blurhashes,
  });
});

export default router;
