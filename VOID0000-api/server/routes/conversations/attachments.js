// server/routes/conversations/attachments.js
// POST /api/conversations/:conversationId/attachments
// Uploads opaque encrypted blobs and returns private API download URLs.
// Encrypted-media uploads store ciphertext only; the file key/iv lives in
// the message's encrypted payload, not in object storage.

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { pool } from '../../db.js';
import { minioClient, ATTACH_BUCKET } from '../../minio.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { meetsWhoThreshold, resolvePermissions } from '../../utils/groupPermissions.js';

const router = Router({ mergeParams: true });

const MAX_FILES = 5;
const MAX_FILE_BYTES = 14 * 1024 * 1024; // ~10 MB source image after encryption + base64
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_ATTACHMENT_KEY_PATTERN = /^msg-[0-9a-f-]{36}\.bin$/i;

function getConversationDownloadIdentifier(conversation) {
  return conversation.public_id ? String(conversation.public_id) : String(conversation.id);
}

function buildPrivateAttachmentUrl(conversation, attachmentId) {
  return `/api/conversations/${encodeURIComponent(getConversationDownloadIdentifier(conversation))}/attachments/${attachmentId}`;
}

async function resolveConversationForMember(conversationIdentifier, userId) {
  const conversation = await findConversationByIdentifier(conversationIdentifier);
  if (!conversation) {
    return { status: 404, body: { error: 'Conversation not found' } };
  }

  const member = await pool.query(
    `SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
    [conversation.id, userId]
  );
  if (member.rows.length === 0) {
    return { status: 403, body: { error: 'Not a member of this conversation' } };
  }

  return { conversation, member: member.rows[0] };
}

async function streamAttachmentObject(res, objectKey) {
  let objectStream;
  try {
    objectStream = await minioClient.getObject(ATTACH_BUCKET, objectKey);
  } catch (err) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  objectStream.on('error', (err) => {
    console.error('Attachment download stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Attachment download failed' });
      return;
    }
    res.destroy(err);
  });

  objectStream.pipe(res);
}

// POST /api/conversations/:conversationId/attachments
// Body:
//   Encrypted: { files: [{ data: '<base64 ciphertext>', encrypted: true }] }
// Returns: { urls: ['/api/conversations/:id/attachments/:attachmentId'] }
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
    const resolved = await resolveConversationForMember(conversationIdentifier, userId);
    if (!resolved.conversation) {
      return res.status(resolved.status).json(resolved.body);
    }

    conversation = resolved.conversation;

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
      if (!meetsWhoThreshold(resolved.member.role, perms.who_can_send_attachments)) {
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

      const attachmentId = randomUUID();
      const filename = `${conversation.id}/${attachmentId}.bin`;

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

      await pool.query(
        `INSERT INTO attachment_objects (id, conversation_id, uploader_id, bucket, object_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [attachmentId, conversation.id, userId, ATTACH_BUCKET, filename]
      );

      urls.push(buildPrivateAttachmentUrl(conversation, attachmentId));
      blurhashes.push('');
    } catch (err) {
      console.error('Attachment upload error:', err);
      return res.status(500).json({ error: 'Failed to process attachment' });
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

// GET /api/conversations/:conversationId/attachments/legacy/:objectName
// Compatibility path for old encrypted payloads that stored public MinIO URLs.
router.get('/legacy/:objectName', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, objectName } = req.params;

  if (!LEGACY_ATTACHMENT_KEY_PATTERN.test(objectName || '')) {
    return res.status(400).json({ error: 'Invalid attachment object key' });
  }

  try {
    const resolved = await resolveConversationForMember(conversationIdentifier, userId);
    if (!resolved.conversation) {
      return res.status(resolved.status).json(resolved.body);
    }

    return streamAttachmentObject(res, objectName);
  } catch (err) {
    console.error('Legacy attachment download error:', err);
    return res.status(500).json({ error: 'Attachment download failed' });
  }
});

// GET /api/conversations/:conversationId/attachments/:attachmentId
router.get('/:attachmentId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, attachmentId } = req.params;

  if (!UUID_PATTERN.test(attachmentId || '')) {
    return res.status(400).json({ error: 'Invalid attachment id' });
  }

  try {
    const resolved = await resolveConversationForMember(conversationIdentifier, userId);
    if (!resolved.conversation) {
      return res.status(resolved.status).json(resolved.body);
    }

    const attachmentResult = await pool.query(
      `SELECT object_key
       FROM attachment_objects
       WHERE id = $1
         AND conversation_id = $2
         AND bucket = $3
       LIMIT 1`,
      [attachmentId, resolved.conversation.id, ATTACH_BUCKET]
    );

    if (attachmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    return streamAttachmentObject(res, attachmentResult.rows[0].object_key);
  } catch (err) {
    console.error('Attachment download error:', err);
    return res.status(500).json({ error: 'Attachment download failed' });
  }
});

export default router;
