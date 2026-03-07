// server/routes/conversations/messages.js
import { Router } from 'express';
import { pool } from '../../db.js';
import scylla, { generateTimeUUID, cassandra } from '../../scylla.js';
import { sendToUser, EVENTS } from '../../gateway/index.js';

const router = Router({ mergeParams: true });

async function verifyMembership(conversationId, userId) {
  const result = await pool.query(
    `SELECT role FROM conversation_members
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

      // Two parallel queries: counts from counter table + current user's own reactions
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
  const { conversationId } = req.params;
  const { encrypted_content, iv, key_version, message_type, reply_to, attachments } = req.body;

  // Allow image-only messages (no text) if attachments are present
  if (!encrypted_content && !iv && (!attachments || attachments.length === 0)) {
    return res.status(400).json({ error: 'encrypted_content/iv or attachments required' });
  }
  if ((encrypted_content || iv) && (!encrypted_content || !iv)) {
    return res.status(400).json({ error: 'encrypted_content and iv must both be present' });
  }

  // Validate attachments list
  if (attachments !== undefined) {
    if (!Array.isArray(attachments) || attachments.length > 5) {
      return res.status(400).json({ error: 'attachments must be an array of up to 5 URLs' });
    }
  }

  try {
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });
    if (member.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot send messages' });

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
        encrypted_content || null, iv || null, key_version || 1, message_type || 'text',
        reply_to ? cassandra.types.TimeUuid.fromString(reply_to) : null,
        attachList,
        now,
      ],
      { prepare: true }
    );

    await pool.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);

    const message = {
      conversation_id: conversationId,
      message_id: messageId.toString(),
      sender_id: userId,
      encrypted_content: encrypted_content || null,
      iv: iv || null,
      key_version: key_version || 1,
      message_type: message_type || 'text',
      reply_to: reply_to || null,
      attachments: attachList || [],
      is_edited: false, is_deleted: false,
      created_at: now.toISOString(),
    };

    const members = await getConversationMembers(conversationId);
    members.forEach((memberId) => {
      if (memberId !== userId) sendToUser(memberId, 'MESSAGE_CREATE', message);
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
  const { conversationId } = req.params;
  const { before, after, limit } = req.query;
  const pageSize = Math.min(parseInt(limit) || 50, 100);

  try {
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

    let query, params;

    if (after) {
      // Fetch newer messages (ascending), then reverse to keep newest-first order
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

    // after query was ASC, reverse to keep consistent newest-first order
    if (after) messages = messages.reverse();

    // Batch fetch reactions for ALL messages in one go
    const messageIds = messages.map((m) => m.message_id);
    const reactions = await batchFetchReactions(conversationId, messageIds, userId);

    const messagesWithReactions = messages.map((m) => ({
      ...m,
      reactions: reactions[m.message_id] || {},
    }));

    res.json({
      success: true,
      messages: messagesWithReactions,
      has_more: messages.length === pageSize,
    });
  } catch (err) {
    console.error('Message history error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET single message by ID
router.get('/:messageId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId, messageId } = req.params;

  try {
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

    const result = await scylla.execute(
      `SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(conversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Message not found' });

    const row = result.rows[0];
    const message = {
      conversation_id: row.conversation_id.toString(),
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

    res.json({ success: true, message });
  } catch (err) {
    console.error('Single message fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch message' });
  }
});

// PUT — edit message
router.put('/:messageId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId, messageId } = req.params;
  const { encrypted_content, iv, key_version } = req.body;

  if (!encrypted_content || !iv) return res.status(400).json({ error: 'encrypted_content and iv are required' });

  try {
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const msgResult = await scylla.execute(
      `SELECT sender_id, is_deleted FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(conversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (msgResult.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

    const msg = msgResult.rows[0];
    if (msg.sender_id.toString() !== userId) return res.status(403).json({ error: 'Can only edit your own messages' });
    if (msg.is_deleted) return res.status(400).json({ error: 'Cannot edit a deleted message' });

    const now = new Date();
    const editId = generateTimeUUID();

    await scylla.execute(
      `INSERT INTO message_edits (conversation_id, message_id, edit_id, encrypted_content, iv, key_version, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [cassandra.types.Uuid.fromString(conversationId), cassandra.types.TimeUuid.fromString(messageId),
       editId, encrypted_content, iv, key_version || 1, now],
      { prepare: true }
    );

    await scylla.execute(
      `UPDATE messages SET encrypted_content = ?, iv = ?, key_version = ?, is_edited = true, edited_at = ?
       WHERE conversation_id = ? AND message_id = ?`,
      [encrypted_content, iv, key_version || 1, now,
       cassandra.types.Uuid.fromString(conversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    const update = {
      conversation_id: conversationId, message_id: messageId,
      encrypted_content, iv, key_version: key_version || 1,
      is_edited: true, edited_at: now.toISOString(),
    };

    const members = await getConversationMembers(conversationId);
    members.forEach((memberId) => {
      if (memberId !== userId) sendToUser(memberId, 'MESSAGE_UPDATE', update);
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
  const { conversationId, messageId } = req.params;

  try {
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

    const deletion = { conversation_id: conversationId, message_id: messageId, deleted_by: userId };

    const members = await getConversationMembers(conversationId);
    members.forEach((memberId) => {
      if (memberId !== userId) sendToUser(memberId, 'MESSAGE_DELETE', deletion);
    });

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    console.error('Message delete error:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Mark as read
router.put('/read', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { message_id } = req.body;

  try {
    await pool.query(
      `UPDATE conversation_members SET last_read_message_id = $1
       WHERE conversation_id = $2 AND user_id = $3`,
      [message_id, conversationId, userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Read receipt error:', err);
    res.status(500).json({ error: 'Failed to update read receipt' });
  }
});

export default router;