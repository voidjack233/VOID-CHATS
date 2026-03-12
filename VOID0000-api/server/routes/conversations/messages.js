// server/routes/conversations/messages.js
import { Router } from 'express';
import { pool } from '../../db.js';
import scylla, { generateTimeUUID, cassandra } from '../../scylla.js';
import { sendLiveEventToUser } from '../../gateway/client.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { messageEventId } from '../../utils/eventIdentity.js';

const router = Router({ mergeParams: true });

async function verifyMembership(conversationId, userId) {
  const result = await pool.query(
    `SELECT role, last_message_sent_at FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  return result.rows[0] || null;
}

async function getConversationMembers(conversationId) {
  const result = await pool.query(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
    [conversationId]
  );
  return result.rows.map((r) => r.user_id);
}

function conversationPublicId(conversation) {
  return conversation?.public_id ? String(conversation.public_id) : null;
}

function normalizeKeyVersion(value, fallback = 1) {
  const parsed = parseInt(String(value ?? fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function getConversationKeyState(conversation, userId) {
  if (!conversation || conversation.type === 'dm') {
    return {
      currentKeyVersion: 1,
      historyStartVersion: 1,
      joinedAt: null,
    };
  }

  const keyConversationId = conversation.parent_conversation_id || conversation.id;
  const result = await pool.query(
    `SELECT c.current_key_version, cm.history_start_version, cm.joined_at
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE c.id = $1 AND cm.user_id = $2
     LIMIT 1`,
    [keyConversationId, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    currentKeyVersion: normalizeKeyVersion(result.rows[0].current_key_version, 1),
    historyStartVersion: normalizeKeyVersion(result.rows[0].history_start_version, 1),
    joinedAt: result.rows[0].joined_at ? new Date(result.rows[0].joined_at).toISOString() : null,
  };
}

function canAccessMessageForHistory(message, keyState) {
  if (!keyState) return false;

  if (normalizeKeyVersion(message.key_version, 1) < keyState.historyStartVersion) {
    return false;
  }

  if (!keyState.joinedAt || !message.created_at) {
    return true;
  }

  const joinedAt = Date.parse(keyState.joinedAt);
  const createdAt = Date.parse(message.created_at);

  if (Number.isNaN(joinedAt) || Number.isNaN(createdAt)) {
    return true;
  }

  return createdAt >= joinedAt;
}

/**
 * Fetches reaction counts from the counter table + checks current user's reactions.
 * Returns: { messageId: { emoji: { count: Number, me: Boolean } } }
 */
async function batchFetchReactions(conversationId, messageIds, currentUserId) {
  if (!messageIds || messageIds.length === 0) return {};

  const convUuid = cassandra.types.Uuid.fromString(conversationId);
  const userUuid = currentUserId ? cassandra.types.Uuid.fromString(currentUserId) : null;
  const reactions = {};

  messageIds.forEach((id) => {
    reactions[id] = {};
  });

  const chunkSize = 50;
  const chunks = [];
  for (let i = 0; i < messageIds.length; i += chunkSize) {
    chunks.push(messageIds.slice(i, i + chunkSize));
  }

  try {
    for (const chunk of chunks) {
      const msgUuids = chunk.map((id) => cassandra.types.TimeUuid.fromString(id));

      const [countsResult, meResult] = await Promise.all([
        scylla.execute(
          `SELECT message_id, emoji, count FROM reaction_counts
           WHERE conversation_id = ? AND message_id IN ?`,
          [convUuid, msgUuids],
          { prepare: true }
        ),
        userUuid
          ? scylla.execute(
              `SELECT message_id, emoji FROM user_reactions
               WHERE conversation_id = ? AND user_id = ? AND message_id IN ?`,
              [convUuid, userUuid, msgUuids],
              { prepare: true }
            )
          : { rows: [] },
      ]);

      const meSet = new Set();
      for (const row of meResult.rows) {
        meSet.add(`${row.message_id.toString()}:${row.emoji}`);
      }

      for (const row of countsResult.rows) {
        const msgId = row.message_id.toString();
        const emoji = row.emoji;
        const count = row.count.toNumber ? row.count.toNumber() : Number(row.count);

        if (count <= 0) continue;

        reactions[msgId][emoji] = {
          count,
          me: meSet.has(`${msgId}:${emoji}`),
        };
      }
    }
  } catch (err) {
    console.error(`[ScyllaDB] Failed to batch fetch reactions for conversation ${conversationId}:`, err);
    throw err;
  }

  return reactions;
}

// POST — send message
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier } = req.params;
  const { encrypted_content, iv, key_version, message_type, reply_to, attachments } = req.body;

  if (!encrypted_content && !iv && (!attachments || attachments.length === 0)) {
    return res.status(400).json({ error: 'encrypted_content/iv or attachments required' });
  }
  if ((encrypted_content || iv) && (!encrypted_content || !iv)) {
    return res.status(400).json({ error: 'encrypted_content and iv must both be present' });
  }

  if (attachments !== undefined) {
    if (!Array.isArray(attachments) || attachments.length > 5) {
      return res.status(400).json({ error: 'attachments must be an array of up to 5 URLs' });
    }
  }

  try {
    const conversation = await findConversationByIdentifier(conversationIdentifier);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const conversationId = conversation.id;
    const conversationPublic = conversationPublicId(conversation);
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });
    if (member.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot send messages' });

    const keyState = await getConversationKeyState(conversation, userId);
    if (!keyState) {
      return res.status(403).json({ error: 'Missing group key membership state' });
    }

    const requestedKeyVersion = conversation.type === 'dm'
      ? 1
      : normalizeKeyVersion(key_version, 0);

    if (requestedKeyVersion !== keyState.currentKeyVersion) {
      return res.status(409).json({
        error: `Expected key_version ${keyState.currentKeyVersion}`,
        code: 'STALE_KEY_VERSION',
        current_key_version: keyState.currentKeyVersion,
      });
    }

    const slowmodeSeconds = Number(conversation.slowmode_seconds || 0);
    const isSlowmodeExempt = ['owner', 'admin'].includes(member.role);

    if (
      conversation.type === 'channel' &&
      slowmodeSeconds > 0 &&
      !isSlowmodeExempt &&
      member.last_message_sent_at
    ) {
      const elapsedSeconds = Math.floor((Date.now() - new Date(member.last_message_sent_at).getTime()) / 1000);
      const retryAfterSeconds = slowmodeSeconds - elapsedSeconds;

      if (retryAfterSeconds > 0) {
        return res.status(429).json({
          error: `Slowmode is enabled. Wait ${retryAfterSeconds}s before sending another message.`,
          retry_after_seconds: retryAfterSeconds,
          slowmode_seconds: slowmodeSeconds,
        });
      }
    }

    const messageId = generateTimeUUID();
    const now = new Date();
    const attachList = Array.isArray(attachments) && attachments.length > 0 ? attachments : null;

    await scylla.execute(
      `INSERT INTO messages (
        conversation_id, message_id, sender_id, encrypted_content, iv,
        key_version, message_type, reply_to, attachments, is_edited, is_deleted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, false, false, ?)`,
      [
        cassandra.types.Uuid.fromString(conversationId),
        messageId,
        cassandra.types.Uuid.fromString(userId),
        encrypted_content || null,
        iv || null,
        requestedKeyVersion,
        message_type || 'text',
        reply_to ? cassandra.types.TimeUuid.fromString(reply_to) : null,
        attachList,
        now,
      ],
      { prepare: true }
    );

    await pool.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);
    await pool.query(
      `UPDATE conversation_members
       SET last_message_sent_at = NOW()
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    const message = {
      event_id: messageEventId(messageId.toString()),
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId.toString(),
      sender_id: userId,
      encrypted_content: encrypted_content || null,
      iv: iv || null,
      key_version: requestedKeyVersion,
      message_type: message_type || 'text',
      reply_to: reply_to || null,
      attachments: attachList || [],
      is_edited: false,
      is_deleted: false,
      created_at: now.toISOString(),
    };

    const members = await getConversationMembers(conversationId);
    members.forEach((memberId) => {
      if (memberId !== userId) sendLiveEventToUser(memberId, 'MESSAGE_CREATE', message);
    });

    res.status(201).json({ success: true, message });
  } catch (err) {
    console.error('Message send error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// GET — message history WITH reactions bundled
router.get('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier } = req.params;
  const { before, after, limit } = req.query;
  const pageSize = Math.min(parseInt(limit, 10) || 50, 100);

  try {
    const conversation = await findConversationByIdentifier(conversationIdentifier);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const conversationId = conversation.id;
    const conversationPublic = conversationPublicId(conversation);
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

    const keyState = await getConversationKeyState(conversation, userId);
    if (!keyState) {
      return res.status(403).json({ error: 'Missing group key membership state' });
    }

    let query;
    let params;

    if (after) {
      query = `SELECT * FROM messages WHERE conversation_id = ? AND message_id > ? ORDER BY message_id ASC LIMIT ?`;
      params = [cassandra.types.Uuid.fromString(conversationId), cassandra.types.TimeUuid.fromString(after), pageSize];
    } else if (before) {
      query = `SELECT * FROM messages WHERE conversation_id = ? AND message_id < ? ORDER BY message_id DESC LIMIT ?`;
      params = [cassandra.types.Uuid.fromString(conversationId), cassandra.types.TimeUuid.fromString(before), pageSize];
    } else {
      query = `SELECT * FROM messages WHERE conversation_id = ? ORDER BY message_id DESC LIMIT ?`;
      params = [cassandra.types.Uuid.fromString(conversationId), pageSize];
    }

    const result = await scylla.execute(query, params, { prepare: true });

    let messages = result.rows.map((row) => ({
      conversation_id: row.conversation_id.toString(),
      conversation_public_id: conversationPublic,
      message_id: row.message_id.toString(),
      sender_id: row.sender_id.toString(),
      encrypted_content: row.is_deleted ? null : row.encrypted_content,
      iv: row.is_deleted ? null : row.iv,
      key_version: row.key_version,
      message_type: row.message_type,
      reply_to: row.reply_to?.toString() || null,
      attachments: row.is_deleted ? [] : (row.attachments || []),
      is_edited: row.is_edited,
      edited_at: row.edited_at?.toISOString() || null,
      is_deleted: row.is_deleted,
      created_at: row.created_at?.toISOString(),
    }));

    if (after) messages = messages.reverse();

    const visibleMessages = conversation.type === 'dm'
      ? messages
      : messages.filter((message) => canAccessMessageForHistory(message, keyState));

    const messageIds = visibleMessages.map((m) => m.message_id);
    const reactions = await batchFetchReactions(conversationId, messageIds, userId);

    const messagesWithReactions = visibleMessages.map((m) => ({
      ...m,
      reactions: reactions[m.message_id] || {},
    }));

    const hasVisibleMessages = visibleMessages.length > 0;
    const hasMore = conversation.type === 'dm'
      ? messages.length === pageSize
      : hasVisibleMessages
        ? messages.length === pageSize
        : false;

    res.json({
      success: true,
      messages: messagesWithReactions,
      has_more: hasMore,
    });
  } catch (err) {
    console.error('Message history error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET single message by ID
router.get('/:messageId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;

  try {
    const conversation = await findConversationByIdentifier(conversationIdentifier);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const conversationId = conversation.id;
    const conversationPublic = conversationPublicId(conversation);
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

    const keyState = await getConversationKeyState(conversation, userId);
    if (!keyState) {
      return res.status(403).json({ error: 'Missing group key membership state' });
    }

    const result = await scylla.execute(
      `SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(conversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Message not found' });

    const row = result.rows[0];
    const message = {
      conversation_id: row.conversation_id.toString(),
      conversation_public_id: conversationPublic,
      message_id: row.message_id.toString(),
      sender_id: row.sender_id.toString(),
      encrypted_content: row.is_deleted ? null : row.encrypted_content,
      iv: row.is_deleted ? null : row.iv,
      key_version: row.key_version,
      message_type: row.message_type,
      reply_to: row.reply_to?.toString() || null,
      is_edited: row.is_edited,
      edited_at: row.edited_at?.toISOString() || null,
      is_deleted: row.is_deleted,
      created_at: row.created_at?.toISOString(),
    };

    if (conversation.type !== 'dm' && !canAccessMessageForHistory(message, keyState)) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }

    res.json({ success: true, message });
  } catch (err) {
    console.error('Single message fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch message' });
  }
});

// Mark as read
router.put('/read', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier } = req.params;
  const { message_id } = req.body;

  try {
    const conversation = await findConversationByIdentifier(conversationIdentifier);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    await pool.query(
      `UPDATE conversation_members SET last_read_message_id = $1
       WHERE conversation_id = $2 AND user_id = $3`,
      [message_id, conversation.id, userId]
    );

    res.json({
      success: true,
      conversation_id: conversation.id,
      conversation_public_id: conversationPublicId(conversation),
    });
  } catch (err) {
    console.error('Read receipt error:', err);
    res.status(500).json({ error: 'Failed to update read receipt' });
  }
});

// PUT — edit message
router.put('/:messageId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;
  const { encrypted_content, iv, key_version } = req.body;

  if (!encrypted_content || !iv) {
    return res.status(400).json({ error: 'encrypted_content and iv are required' });
  }

  try {
    const conversation = await findConversationByIdentifier(conversationIdentifier);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const conversationId = conversation.id;
    const conversationPublic = conversationPublicId(conversation);
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const keyState = await getConversationKeyState(conversation, userId);
    if (!keyState) {
      return res.status(403).json({ error: 'Missing group key membership state' });
    }

    const requestedKeyVersion = conversation.type === 'dm'
      ? 1
      : normalizeKeyVersion(key_version, 0);

    if (requestedKeyVersion !== keyState.currentKeyVersion) {
      return res.status(409).json({
        error: `Expected key_version ${keyState.currentKeyVersion}`,
        code: 'STALE_KEY_VERSION',
        current_key_version: keyState.currentKeyVersion,
      });
    }

    const msgResult = await scylla.execute(
      `SELECT sender_id, is_deleted FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(conversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (msgResult.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

    const msg = msgResult.rows[0];
    if (msg.sender_id.toString() !== userId) {
      return res.status(403).json({ error: 'Can only edit your own messages' });
    }
    if (msg.is_deleted) return res.status(400).json({ error: 'Cannot edit a deleted message' });

    const now = new Date();
    const editId = generateTimeUUID();

    await scylla.execute(
      `INSERT INTO message_edits (conversation_id, message_id, edit_id, encrypted_content, iv, key_version, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        cassandra.types.Uuid.fromString(conversationId),
        cassandra.types.TimeUuid.fromString(messageId),
        editId,
        encrypted_content,
        iv,
        requestedKeyVersion,
        now,
      ],
      { prepare: true }
    );

    await scylla.execute(
      `UPDATE messages SET encrypted_content = ?, iv = ?, key_version = ?, is_edited = true, edited_at = ?
       WHERE conversation_id = ? AND message_id = ?`,
      [
        encrypted_content,
        iv,
        requestedKeyVersion,
        now,
        cassandra.types.Uuid.fromString(conversationId),
        cassandra.types.TimeUuid.fromString(messageId),
      ],
      { prepare: true }
    );

    const update = {
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId,
      encrypted_content,
      iv,
      key_version: requestedKeyVersion,
      is_edited: true,
      edited_at: now.toISOString(),
    };

    const members = await getConversationMembers(conversationId);
    members.forEach((memberId) => {
      if (memberId !== userId) sendLiveEventToUser(memberId, 'MESSAGE_UPDATE', update);
    });

    res.json({ success: true, ...update });
  } catch (err) {
    console.error('Message edit error:', err);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// DELETE — delete message
router.delete('/:messageId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;

  try {
    const conversation = await findConversationByIdentifier(conversationIdentifier);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const conversationId = conversation.id;
    const conversationPublic = conversationPublicId(conversation);
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const msgResult = await scylla.execute(
      `SELECT sender_id FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(conversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (msgResult.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

    const isSender = msgResult.rows[0].sender_id.toString() === userId;
    const canDelete = isSender || ['owner', 'admin'].includes(member.role);
    if (!canDelete) return res.status(403).json({ error: 'Cannot delete this message' });

    await scylla.execute(
      `UPDATE messages SET is_deleted = true, encrypted_content = null, iv = null
       WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(conversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    const deletion = {
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId,
      deleted_by: userId,
    };

    const members = await getConversationMembers(conversationId);
    members.forEach((memberId) => {
      if (memberId !== userId) sendLiveEventToUser(memberId, 'MESSAGE_DELETE', deletion);
    });

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    console.error('Message delete error:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

export default router;
