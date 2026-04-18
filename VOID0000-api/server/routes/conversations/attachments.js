// server/routes/conversations/attachments.js
// POST /api/conversations/:conversationId/attachments
// Uploads opaque encrypted blobs and returns URLs.
// Encrypted-media uploads store ciphertext only; the file key/iv lives in
// the message's encrypted payload, not in object storage.

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { pool } from '../../db.js';
import { minioClient, ATTACH_BUCKET } from '../../minio.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { meetsWhoThreshold, resolvePermissions } from '../../utils/groupPermissions.js';

const router = Router({ mergeParams: true });

const CDN_BASE = process.env.CDN_URL || 'https://cdn.void0000.online';
const MAX_FILES = 5;
const MAX_FILE_BYTES = 14 * 1024 * 1024; // ~10 MB source image after encryption + base64

// POST /api/conversations/:conversationId/attachments
// Body:
//   Encrypted: { files: [{ data: '<base64 ciphertext>', encrypted: true }] }
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

    if (conversation.type === 'group' || conversation.type === 'channel') {
      let permissionsSource = conversation.permissions;
      if (conversation.type === 'channel' && conversation.parent_conversation_id) {
        const parentResult = await pool.query(
          'SELECT permissions FROM conversations WHERE id = $1 LIMIT 1',
          [conversation.parent_conversation_id]
        );
        if (parentResult.rows.length > 0) {
          permissionsSource = parentResult.rows[0].permissions;
        }
      }
      const perms = resolvePermissions(permissionsSource);
      if (!meetsWhoThreshold(member.rows[0].role, perms.who_can_send_attachments)) {
        return res.status(403).json({ error: 'You do not have permission to send attachments' });
      }
    }
  } catch (err) {
    return res.status(500).json({ error: 'Membership check failed' });
  }

  const urls = [];
  const blurhashes = [];

  for (const file of files) {
    const { data } = file;
    const isEncryptedUpload = file?.encrypted === true;

    if (!data || typeof data !== 'string') {
      return res.status(400).json({ error: 'Each file must have a data field' });
    }

    if (data.length > MAX_FILE_BYTES) {
      return res.status(400).json({
        error: 'File too large. Maximum 10MB per image after client-side encryption overhead.',
        code: 'ATTACHMENT_TOO_LARGE',
      });
    }

    if (!isEncryptedUpload) {
      return res.status(400).json({
        error: 'Plaintext attachment uploads are disabled. Encrypt attachments client-side before upload.',
        code: 'PLAINTEXT_ATTACHMENTS_DISABLED',
      });
    }

    try {
      const encryptedBuffer = Buffer.from(data, 'base64');
      if (!encryptedBuffer.length) {
        return res.status(400).json({ error: 'Encrypted attachment payload was empty' });
      }

      const filename = `msg-${randomUUID()}.bin`;

      await minioClient.putObject(
        ATTACH_BUCKET,
        filename,
        encryptedBuffer,
        encryptedBuffer.length,
        {
          'Content-Type': 'application/octet-stream',
          'X-Amz-Meta-Encrypted': '1',
        }
      );

      urls.push(`${CDN_BASE}/${ATTACH_BUCKET}/${filename}`);
      blurhashes.push('');
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
