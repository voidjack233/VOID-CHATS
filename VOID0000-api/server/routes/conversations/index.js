// server/routes/conversations/index.js
import { Router } from 'express';
import { pool } from '../../db.js';
import { authenticateUser } from '../../middleware/jwt.js';
import { conversationSnowflake } from '../../utils/snowflake.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { EVENTS } from '../../gateway/index.js';
import { sendLiveEventToUser } from '../../gateway/client.js';
import {
  ensureDefaultCategory,
  getGroupCategories,
  resolveGroupCategory,
} from '../../utils/conversationCategories.js';
import dmRouter from './dm.js';
import membersRouter from './members.js';
import messagesRouter from './messages.js';
import reactionsRouter from './reactions.js';
import batchReactionsRouter from './batchReactions.js';
import keysRouter from './keys.js';
import attachmentsRouter from './attachments.js';
import categoriesRouter from './categories.js';

const router = Router();

const CHANNEL_SLOWMODE_OPTIONS = new Set([0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600]);

router.use('/dm', authenticateUser, dmRouter);
router.use('/:conversationId/members', authenticateUser, membersRouter);
router.use('/:conversationId/messages', authenticateUser, messagesRouter);
router.use('/:conversationId/messages/:messageId/reactions', authenticateUser, reactionsRouter);
router.use('/:conversationId/reactions', authenticateUser, batchReactionsRouter);
router.use('/:conversationId/attachments', authenticateUser, attachmentsRouter);
router.use('/:conversationId/categories', authenticateUser, categoriesRouter);
router.use('/keys', authenticateUser, keysRouter);

const baseUrl = process.env.CDN_URL || 'https://cdn.void0000.online';

function normalizeConversationRow(conv) {
  return {
    ...conv,
    public_id: conv.public_id ? String(conv.public_id) : null,
    parent_public_id: conv.parent_public_id ? String(conv.parent_public_id) : null,
    member_count: conv.member_count != null ? parseInt(conv.member_count, 10) : 0,
    slowmode_seconds: conv.slowmode_seconds != null ? parseInt(conv.slowmode_seconds, 10) : 0,
    is_age_restricted: !!conv.is_age_restricted,
    dm_avatar_url: conv.dm_avatar
      ? `${baseUrl}/avatars/${conv.dm_avatar}`
      : conv.dm_username
        ? `https://api.dicebear.com/7.x/avataaars/svg?seed=${conv.dm_username}`
        : null,
  };
}

async function getAccessibleChannels(groupId, userId) {
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
       c.category_id,
       parent.public_id AS parent_public_id,
       c.created_at,
       c.updated_at,
       cm.role,
       cm.last_read_message_id,
       NULL::text AS dm_username,
       NULL::text AS dm_avatar,
       NULL::text AS dm_display_name,
       (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count
     FROM conversations c
     LEFT JOIN conversations parent ON parent.id = c.parent_conversation_id
     JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE c.parent_conversation_id = $1
       AND cm.user_id = $2
     ORDER BY
       CASE WHEN LOWER(c.name) = 'general' THEN 0 ELSE 1 END,
       LOWER(c.name),
       c.created_at ASC`,
    [groupId, userId]
  );

  return result.rows.map(normalizeConversationRow);
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
    parent_conversation_id,
    category_id,
  } = req.body;

  if (!type || !['group', 'channel'].includes(type)) {
    return res.status(400).json({ error: 'Type must be "group" or "channel"' });
  }

  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    return res.status(400).json({ error: 'Name is required (max 100 characters)' });
  }

  if (type === 'group' && (!Array.isArray(members) || members.length === 0)) {
    return res.status(400).json({ error: 'At least one member required' });
  }

  if (type === 'group' && members.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 members on creation' });
  }

  if (type === 'channel' && !parent_conversation_id) {
    return res.status(400).json({ error: 'parent_conversation_id is required for channels' });
  }

  if (type === 'group' && parent_conversation_id) {
    return res.status(400).json({ error: 'Groups cannot have a parent conversation' });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    if (type === 'channel') {
      const parent = await findConversationByIdentifier(parent_conversation_id, client);
      if (!parent) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Parent group not found' });
      }

      const parentMemberResult = await client.query(
        `SELECT role FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2`,
        [parent.id, userId]
      );

      if (parentMemberResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Not allowed to create a channel in this group' });
      }

      if (parent.type !== 'group') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Channels can only be created under a group' });
      }

      if (!['owner', 'admin'].includes(parentMemberResult.rows[0].role)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only owner or admin can create channels' });
      }

      const targetCategory = category_id
        ? await resolveGroupCategory(client, parent.id, category_id)
        : null;
      if (category_id && !targetCategory) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Category not found for this group' });
      }

      const existingChannel = await client.query(
        `SELECT id
         FROM conversations
         WHERE parent_conversation_id = $1
           AND LOWER(name) = LOWER($2)
         LIMIT 1`,
        [parent.id, name.trim()]
      );

      if (existingChannel.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A channel with that name already exists in this group' });
      }

      const convResult = await client.query(
        `INSERT INTO conversations (type, name, owner_id, parent_conversation_id, category_id, public_id)
         VALUES ('channel', $1, $2, $3, $4, $5)
         RETURNING *`,
        [name.trim(), parent.owner_id || userId, parent.id, targetCategory?.id || null, conversationSnowflake.nextId()]
      );

      const channel = convResult.rows[0];

      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         SELECT $1, user_id, role
         FROM conversation_members
         WHERE conversation_id = $2
         ON CONFLICT DO NOTHING`,
        [channel.id, parent.id]
      );

      await client.query('COMMIT');
      return res.status(201).json({
        success: true,
        conversation: {
          ...channel,
          public_id: channel.public_id ? String(channel.public_id) : null,
          parent_public_id: parent.public_id ? String(parent.public_id) : null,
        },
      });
    }

    const convResult = await client.query(
      `INSERT INTO conversations (type, name, owner_id, parent_conversation_id, public_id)
       VALUES ('group', $1, $2, NULL, $3)
       RETURNING *`,
      [name.trim(), userId, conversationSnowflake.nextId()]
    );

    const conversation = convResult.rows[0];

    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
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
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT DO NOTHING`,
          [conversation.id, memberId]
        );
      }
    }

    const defaultChannelResult = await client.query(
      `INSERT INTO conversations (type, name, owner_id, parent_conversation_id, category_id, public_id)
       VALUES ('channel', 'general', $1, $2, NULL, $3)
       RETURNING *`,
      [userId, conversation.id, conversationSnowflake.nextId()]
    );

    const defaultChannel = defaultChannelResult.rows[0];

    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       SELECT $1, user_id, role
       FROM conversation_members
       WHERE conversation_id = $2
       ON CONFLICT DO NOTHING`,
      [defaultChannel.id, conversation.id]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      conversation: {
        ...conversation,
        public_id: conversation.public_id ? String(conversation.public_id) : null,
        default_channel_id: defaultChannel.id,
        default_channel_public_id: defaultChannel.public_id ? String(defaultChannel.public_id) : null,
        default_category_id: null,
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
              json_agg(json_build_object(
                'user_id', cm.user_id,
                'role', cm.role,
                'nickname', cm.nickname,
                'joined_at', cm.joined_at,
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
      avatar_url: member.avatar_filename
        ? `${baseUrl}/avatars/${member.avatar_filename}`
        : `https://api.dicebear.com/7.x/avataaars/svg?seed=${member.username}`,
    }));

    if (conversation.type === 'group') {
      conversation.categories = await getGroupCategories(pool, conversation.id);
      conversation.channels = await getAccessibleChannels(conversation.id, userId);
    } else {
      conversation.categories = [];
      conversation.channels = [];
    }

    res.json({ success: true, conversation });
  } catch (err) {
    console.error('Conversation GET error:', err);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

router.put('/:conversationId', authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { name, topic, slowmode_seconds, is_age_restricted } = req.body;
  const hasName = Object.prototype.hasOwnProperty.call(req.body, 'name');
  const hasTopic = Object.prototype.hasOwnProperty.call(req.body, 'topic');
  const hasSlowmode = Object.prototype.hasOwnProperty.call(req.body, 'slowmode_seconds');
  const hasAgeRestricted = Object.prototype.hasOwnProperty.call(req.body, 'is_age_restricted');

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

    if (!hasName && !hasTopic && !hasSlowmode && !hasAgeRestricted) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const normalizedName = hasName ? name?.trim() : undefined;
    if (hasName && (!normalizedName || typeof name !== 'string' || normalizedName.length > 100)) {
      return res.status(400).json({ error: 'Name is required (max 100 characters)' });
    }

    if ((hasTopic || hasSlowmode || hasAgeRestricted) && resolvedConversation.type !== 'channel') {
      return res.status(400).json({ error: 'Only channels support topic, slowmode, or age restriction' });
    }

    const normalizedTopic = hasTopic
      ? typeof topic === 'string'
        ? topic.trim() || null
        : topic == null
          ? null
          : undefined
      : undefined;

    if (hasTopic && (normalizedTopic === undefined || (typeof topic === 'string' && topic.length > 1024))) {
      return res.status(400).json({ error: 'Topic must be text up to 1024 characters' });
    }

    if (hasSlowmode && (!Number.isInteger(slowmode_seconds) || !CHANNEL_SLOWMODE_OPTIONS.has(slowmode_seconds))) {
      return res.status(400).json({ error: 'Invalid slowmode value' });
    }

    if (hasAgeRestricted && typeof is_age_restricted !== 'boolean') {
      return res.status(400).json({ error: 'is_age_restricted must be true or false' });
    }

    if (hasName && resolvedConversation.type === 'channel' && resolvedConversation.parent_conversation_id) {
      const duplicateChannel = await pool.query(
        `SELECT id
         FROM conversations
         WHERE parent_conversation_id = $1
           AND LOWER(name) = LOWER($2)
           AND id != $3
         LIMIT 1`,
        [resolvedConversation.parent_conversation_id, normalizedName, resolvedConversation.id]
      );

      if (duplicateChannel.rows.length > 0) {
        return res.status(400).json({ error: 'A channel with that name already exists in this group' });
      }
    }

    const result = await pool.query(
      `UPDATE conversations
       SET name = CASE WHEN $1 THEN $2 ELSE name END,
           topic = CASE WHEN $3 THEN $4 ELSE topic END,
           slowmode_seconds = CASE WHEN $5 THEN $6 ELSE slowmode_seconds END,
           is_age_restricted = CASE WHEN $7 THEN $8 ELSE is_age_restricted END,
           updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        hasName,
        normalizedName || null,
        hasTopic,
        normalizedTopic,
        hasSlowmode,
        slowmode_seconds ?? 0,
        hasAgeRestricted,
        is_age_restricted ?? false,
        resolvedConversation.id,
      ]
    );

    const normalizedConversation = normalizeConversationRow(result.rows[0]);

    const membersResult = await pool.query(
      `SELECT user_id
       FROM conversation_members
       WHERE conversation_id = $1`,
      [resolvedConversation.id]
    );

    const updatePayload = {
      conversation: normalizedConversation,
    };

    membersResult.rows.forEach(({ user_id }) => {
      sendLiveEventToUser(user_id, EVENTS.CONVERSATION_UPDATE, updatePayload);
    });

    res.json({ success: true, conversation: normalizedConversation });
  } catch (err) {
    console.error('Conversation PUT error:', err);
    res.status(500).json({ error: 'Failed to update conversation' });
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
