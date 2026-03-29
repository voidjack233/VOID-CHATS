import { Router } from 'express';
import sharp from 'sharp';
import { pool } from '../../../db.js';
import { findConversationByIdentifier } from '../../../utils/conversationIdentity.js';
import { minioClient, GROUP_AVATAR_BUCKET } from '../../../minio.js';
import { meetsWhoThreshold, resolvePermissions } from '../../../utils/groupPermissions.js';
import {
  ALLOWED_ICON_MIME_PREFIXES,
  MAX_ICON_DIMENSION,
  MAX_ICON_PAYLOAD_SIZE,
  broadcastConversationUpdate,
  getConversationMemberRole,
  isValidImage,
  normalizeConversationRow,
  resolveGroupIconBucket,
} from './shared.js';

const router = Router();

router.put('/:conversationId/icon', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { icon } = req.body;

  if (!icon || typeof icon !== 'string') {
    return res.status(400).json({ error: 'No icon data provided' });
  }

  if (icon.length > MAX_ICON_PAYLOAD_SIZE) {
    return res.status(400).json({ error: 'Image too large. Maximum 10MB payload.' });
  }

  const hasValidPrefix = ALLOWED_ICON_MIME_PREFIXES.some((prefix) =>
    icon.toLowerCase().startsWith(prefix)
  );
  if (!hasValidPrefix) {
    return res.status(400).json({ error: 'Invalid image format. Use JPG, PNG, GIF, or WebP.' });
  }

  try {
    const resolvedConversation = await findConversationByIdentifier(conversationId);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (resolvedConversation.type !== 'group') {
      return res.status(400).json({ error: 'Only groups support profile icons' });
    }

    const memberRole = await getConversationMemberRole(resolvedConversation.id, userId);
    if (!memberRole) {
      return res.status(403).json({ error: 'Not a member' });
    }

    const perms = resolvePermissions(resolvedConversation.permissions);
    if (!meetsWhoThreshold(memberRole, perms.who_can_edit_group_profile)) {
      return res.status(403).json({ error: 'You do not have permission to edit the group profile' });
    }

    const buffer = Buffer.from(icon.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (!isValidImage(buffer)) {
      return res.status(400).json({ error: 'File is not a valid image' });
    }

    const metadata = await sharp(buffer).metadata();
    if (metadata.width > MAX_ICON_DIMENSION || metadata.height > MAX_ICON_DIMENSION) {
      return res.status(400).json({
        error: `Image dimensions too large. Maximum ${MAX_ICON_DIMENSION}x${MAX_ICON_DIMENSION}px.`,
      });
    }

    const processed = await sharp(buffer)
      .resize(512, 512, { fit: 'cover', position: 'center' })
      .rotate()
      .webp({ quality: 85 })
      .toBuffer();

    const iconFilename = `${resolvedConversation.id}/icon-${Date.now()}.webp`;

    await minioClient.putObject(
      GROUP_AVATAR_BUCKET,
      iconFilename,
      processed,
      processed.length,
      { 'Content-Type': 'image/webp' }
    );

    const updateResult = await pool.query(
      `UPDATE conversations
       SET icon_filename = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [iconFilename, resolvedConversation.id]
    );

    const normalizedConversation = normalizeConversationRow(updateResult.rows[0]);

    if (resolvedConversation.icon_filename && resolvedConversation.icon_filename !== iconFilename) {
      try {
        await minioClient.removeObject(
          resolveGroupIconBucket(resolvedConversation.icon_filename),
          resolvedConversation.icon_filename
        );
      } catch (err) {
        console.warn('Could not delete old group icon:', err.message);
      }
    }

    await broadcastConversationUpdate(resolvedConversation.id, normalizedConversation);

    res.json({ success: true, conversation: normalizedConversation });
  } catch (err) {
    console.error('Conversation icon PUT error:', err);
    res.status(500).json({ error: 'Failed to upload group icon' });
  }
});

router.delete('/:conversationId/icon', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const resolvedConversation = await findConversationByIdentifier(conversationId);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (resolvedConversation.type !== 'group') {
      return res.status(400).json({ error: 'Only groups support profile icons' });
    }

    const memberRole = await getConversationMemberRole(resolvedConversation.id, userId);
    if (!memberRole) {
      return res.status(403).json({ error: 'Not a member' });
    }

    const perms = resolvePermissions(resolvedConversation.permissions);
    if (!meetsWhoThreshold(memberRole, perms.who_can_edit_group_profile)) {
      return res.status(403).json({ error: 'You do not have permission to edit the group profile' });
    }

    const updateResult = await pool.query(
      `UPDATE conversations
       SET icon_filename = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [resolvedConversation.id]
    );

    const normalizedConversation = normalizeConversationRow(updateResult.rows[0]);

    if (resolvedConversation.icon_filename) {
      try {
        await minioClient.removeObject(
          resolveGroupIconBucket(resolvedConversation.icon_filename),
          resolvedConversation.icon_filename
        );
      } catch (err) {
        console.warn('Could not delete group icon:', err.message);
      }
    }

    await broadcastConversationUpdate(resolvedConversation.id, normalizedConversation);

    res.json({ success: true, conversation: normalizedConversation });
  } catch (err) {
    console.error('Conversation icon DELETE error:', err);
    res.status(500).json({ error: 'Failed to remove group icon' });
  }
});

export default router;
