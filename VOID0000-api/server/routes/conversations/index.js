// server/routes/conversations/index.js
import { Router } from 'express';
import sharp from 'sharp';
import { pool } from '../../db.js';
import { authenticateUser } from '../../middleware/jwt.js';
import { conversationSnowflake } from '../../utils/snowflake.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { EVENTS } from '../../gateway/index.js';
import { sendLiveEventToUser } from '../../gateway/client.js';
import { minioClient, BUCKET, GROUP_AVATAR_BUCKET } from '../../minio.js';
import { resolveUserAvatarUrl } from '../../utils/avatarFallback.js';
import dmRouter from './dm.js';
import membersRouter from './members.js';
import messagesRouter from './messages.js';
import reactionsRouter from './reactions.js';
import batchReactionsRouter from './batchReactions.js';
import keysRouter from './keys.js';
import mlsRouter from './mls.js';
import attachmentsRouter from './attachments.js';
import invitesRouter from './invites.js';
import inviteLinksRouter from './inviteLinks.js';

const router = Router();

const MAX_ICON_PAYLOAD_SIZE = 10 * 1024 * 1024;
const MAX_ICON_DIMENSION = 4096;
const ALLOWED_ICON_MIME_PREFIXES = [
  'data:image/jpeg',
  'data:image/jpg',
  'data:image/png',
  'data:image/gif',
  'data:image/webp',
];
const ICON_MAGIC_BYTES = {
  jpeg: [0xFF, 0xD8, 0xFF],
  png: [0x89, 0x50, 0x4E, 0x47],
  gif: [0x47, 0x49, 0x46],
  webp: [0x52, 0x49, 0x46, 0x46],
};

router.use('/dm', authenticateUser, dmRouter);
router.use('/mls', authenticateUser, mlsRouter);
router.use('/invite-links', inviteLinksRouter);
router.use('/:conversationId/invites', authenticateUser, invitesRouter);
router.use('/:conversationId/members', authenticateUser, membersRouter);
router.use('/:conversationId/messages', authenticateUser, messagesRouter);
router.use('/:conversationId/messages/:messageId/reactions', authenticateUser, reactionsRouter);
router.use('/:conversationId/reactions', authenticateUser, batchReactionsRouter);
router.use('/:conversationId/attachments', authenticateUser, attachmentsRouter);
router.use('/keys', authenticateUser, keysRouter);

const baseUrl = process.env.CDN_URL || 'https://cdn.void0000.online';
const buildObjectUrl = (bucket, filename) => (
  filename ? `${baseUrl}/${bucket}/${filename}` : null
);
const buildAvatarUrl = (filename) => (
  filename ? `${baseUrl}/${BUCKET}/${filename}` : null
);
const resolveGroupIconBucket = (filename) => (
  filename?.startsWith('groups/')
    ? BUCKET
    : GROUP_AVATAR_BUCKET
);
const buildGroupIconUrl = (filename) => (
  filename ? buildObjectUrl(resolveGroupIconBucket(filename), filename) : null
);

const isValidImage = (buffer) => {
  if (buffer.length < 4) return false;
  return Object.values(ICON_MAGIC_BYTES).some((magic) =>
    magic.every((byte, index) => buffer[index] === byte)
  );
};

async function getConversationMemberIds(conversationId) {
  const result = await pool.query(
    `SELECT user_id
     FROM conversation_members
     WHERE conversation_id = $1`,
    [conversationId]
  );

  return result.rows.map(({ user_id }) => user_id);
}

async function broadcastConversationUpdate(conversationId, conversation) {
  const memberIds = await getConversationMemberIds(conversationId);
  const payload = { conversation };

  memberIds.forEach((userId) => {
    sendLiveEventToUser(userId, EVENTS.CONVERSATION_UPDATE, payload);
  });
}

function normalizeConversationRow(conv) {
  return {
    ...conv,
    public_id: conv.public_id ? String(conv.public_id) : null,
    parent_public_id: conv.parent_public_id ? String(conv.parent_public_id) : null,
    current_key_version: conv.current_key_version != null ? parseInt(conv.current_key_version, 10) : null,
    member_count: conv.member_count != null ? parseInt(conv.member_count, 10) : 0,
    slowmode_seconds: conv.slowmode_seconds != null ? parseInt(conv.slowmode_seconds, 10) : 0,
    is_age_restricted: !!conv.is_age_restricted,
    icon_url: buildGroupIconUrl(conv.icon_filename),
    dm_avatar_url: resolveUserAvatarUrl(conv.dm_avatar, {
      displayName: conv.dm_display_name,
      username: conv.dm_username,
    }),
  };
}

router.get('/', authenticateUser, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT
         c.id,
         c.public_id,
         c.type,
         c.name,
         c.topic,
         c.slowmode_seconds,
         c.is_age_restricted,
         c.icon_filename,
         c.owner_id,
         c.parent_conversation_id,
         c.current_key_version,
         c.category_id,
         parent.public_id AS parent_public_id,
         c.created_at,
         c.updated_at,
         cm.role,
         cm.last_read_message_id,
         CASE
           WHEN c.type = 'dm' THEN (
             SELECT u.username FROM conversation_members cm2
             JOIN users u ON u.id = cm2.user_id
             WHERE cm2.conversation_id = c.id AND cm2.user_id != $1
             LIMIT 1
           )
           ELSE NULL
         END AS dm_username,
         CASE
           WHEN c.type = 'dm' THEN (
             SELECT up.avatar_filename FROM conversation_members cm2
             JOIN users u ON u.id = cm2.user_id
             JOIN user_profiles up ON up.id = u.profile_id
             WHERE cm2.conversation_id = c.id AND cm2.user_id != $1
             LIMIT 1
           )
           ELSE NULL
         END AS dm_avatar,
         CASE
           WHEN c.type = 'dm' THEN (
             SELECT up.display_name FROM conversation_members cm2
             JOIN users u ON u.id = cm2.user_id
             JOIN user_profiles up ON up.id = u.profile_id
             WHERE cm2.conversation_id = c.id AND cm2.user_id != $1
             LIMIT 1
           )
           ELSE NULL
         END AS dm_display_name,
         (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count
       FROM conversations c
       LEFT JOIN conversations parent ON parent.id = c.parent_conversation_id
       JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE cm.user_id = $1
         AND c.type != 'channel'
       ORDER BY c.updated_at DESC`,
      [userId]
    );

    res.json({ success: true, conversations: result.rows.map(normalizeConversationRow) });
  } catch (err) {
    console.error('Conversations GET error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

router.post('/', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const {
    type,
    name,
    members = [],
  } = req.body;

  if (type !== 'group') {
    return res.status(400).json({ error: 'Type must be "group"' });
  }

  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    return res.status(400).json({ error: 'Name is required (max 100 characters)' });
  }

  if (type === 'group' && Array.isArray(members) && members.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 members on creation' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const convResult = await client.query(
      `INSERT INTO conversations (type, name, owner_id, parent_conversation_id, public_id, current_key_version)
       VALUES ('group', $1, $2, NULL, $3, 1)
       RETURNING *`,
      [name.trim(), userId, conversationSnowflake.nextId()]
    );

    const conversation = convResult.rows[0];

    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, joined_key_version, history_start_version)
       VALUES ($1, $2, 'owner', 1, 1)`,
      [conversation.id, userId]
    );

    const uniqueMembers = [...new Set(members.filter((id) => id !== userId))];

    for (const memberId of uniqueMembers) {
      const friendCheck = await client.query(
        `SELECT id FROM friendships
         WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
           AND status = 'accepted'`,
        [userId, memberId]
      );

      if (friendCheck.rows.length > 0) {
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role, joined_key_version, history_start_version)
           VALUES ($1, $2, 'member', 1, 1)
           ON CONFLICT DO NOTHING`,
          [conversation.id, memberId]
        );
      }
    }

    await client.query(
      `INSERT INTO conversation_key_rotations (
         conversation_id,
         previous_key_version,
         new_key_version,
         rotated_by_user_id,
         reason,
         affected_user_id
       )
       VALUES ($1, NULL, 1, $2, 'create', NULL)`,
      [conversation.id, userId]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      conversation: {
        ...conversation,
        public_id: conversation.public_id ? String(conversation.public_id) : null,
      },
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('Conversation create error:', err);
    res.status(500).json({ error: 'Failed to create conversation' });
  } finally {
    if (client) client.release();
  }
});

router.get('/:conversationId', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const resolvedConversation = await findConversationByIdentifier(conversationId);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const memberCheck = await pool.query(
      `SELECT role FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [resolvedConversation.id, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const result = await pool.query(
      `SELECT c.*, parent.public_id AS parent_public_id,
              (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count,
              json_agg(json_build_object(
                'user_id', cm.user_id,
                'role', cm.role,
                'nickname', cm.nickname,
                'joined_at', cm.joined_at,
                'joined_key_version', cm.joined_key_version,
                'history_start_version', cm.history_start_version,
                'username', u.username,
                'display_name', up.display_name,
                'avatar_filename', up.avatar_filename,
                'profile_id', u.profile_id
              )) AS members
       FROM conversations c
       LEFT JOIN conversations parent ON parent.id = c.parent_conversation_id
       JOIN conversation_members cm ON cm.conversation_id = c.id
       JOIN users u ON u.id = cm.user_id
       JOIN user_profiles up ON up.id = u.profile_id
       WHERE c.id = $1
       GROUP BY c.id, parent.public_id`,
      [resolvedConversation.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conversation = normalizeConversationRow(result.rows[0]);

    conversation.members = conversation.members.map((member) => ({
      ...member,
      joined_key_version: member.joined_key_version != null ? parseInt(member.joined_key_version, 10) : null,
      history_start_version: member.history_start_version != null ? parseInt(member.history_start_version, 10) : null,
      avatar_url: resolveUserAvatarUrl(member.avatar_filename),
    }));

    if (conversation.type === 'dm') {
      const peer = conversation.members.find((member) => member.user_id !== userId) || null;
      conversation.dm_user_id = peer?.user_id || null;
      conversation.dm_username = peer?.username || null;
      conversation.dm_display_name = peer?.display_name || null;
      conversation.dm_avatar_url = peer?.avatar_url || null;
    }

    conversation.channels = [];

    res.json({ success: true, conversation });
  } catch (err) {
    console.error('Conversation GET error:', err);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

router.put('/:conversationId', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { name } = req.body;
  const hasName = Object.prototype.hasOwnProperty.call(req.body, 'name');

  try {
    const resolvedConversation = await findConversationByIdentifier(conversationId);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const memberCheck = await pool.query(
      `SELECT role FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [resolvedConversation.id, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member' });
    }

    if (!['owner', 'admin'].includes(memberCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Only owner or admin can update' });
    }

    if (!hasName) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const normalizedName = hasName ? name?.trim() : undefined;
    if (hasName && (!normalizedName || typeof name !== 'string' || normalizedName.length > 100)) {
      return res.status(400).json({ error: 'Name is required (max 100 characters)' });
    }

    const result = await pool.query(
      `UPDATE conversations
       SET name = CASE WHEN $1 THEN $2 ELSE name END,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [
        hasName,
        normalizedName || null,
        resolvedConversation.id,
      ]
    );

    const normalizedConversation = normalizeConversationRow(result.rows[0]);

    await broadcastConversationUpdate(resolvedConversation.id, normalizedConversation);

    res.json({ success: true, conversation: normalizedConversation });
  } catch (err) {
    console.error('Conversation PUT error:', err);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

router.put('/:conversationId/icon', authenticateUser, async (req, res) => {
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

    const memberCheck = await pool.query(
      `SELECT role
       FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [resolvedConversation.id, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member' });
    }

    if (!['owner', 'admin'].includes(memberCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Only owner or admin can update the group profile' });
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

router.delete('/:conversationId/icon', authenticateUser, async (req, res) => {
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

    const memberCheck = await pool.query(
      `SELECT role
       FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [resolvedConversation.id, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member' });
    }

    if (!['owner', 'admin'].includes(memberCheck.rows[0].role)) {
      return res.status(403).json({ error: 'Only owner or admin can update the group profile' });
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

router.delete('/:conversationId', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const resolvedConversation = await findConversationByIdentifier(conversationId);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const memberCheck = await pool.query(
      `SELECT role FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [resolvedConversation.id, userId]
    );

    if (memberCheck.rows.length === 0 || memberCheck.rows[0].role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can delete this conversation' });
    }

    await pool.query('DELETE FROM conversations WHERE id = $1', [resolvedConversation.id]);

    res.json({ success: true, message: 'Conversation deleted' });
  } catch (err) {
    console.error('Conversation DELETE error:', err);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

export default router;
