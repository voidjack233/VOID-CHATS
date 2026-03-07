// server/routes/conversations/reactions.js
import { Router } from 'express';
import { pool } from '../../db.js';
import scylla, { cassandra } from '../../scylla.js';
import { sendToUser } from '../../gateway/index.js';

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

// PUT /:emoji — toggle reaction
router.put('/:emoji', async (req, res) => {
  const userId = req.user.id;
  const { conversationId, messageId } = req.params;
  const emoji = decodeURIComponent(req.params.emoji);

  if (!emoji || emoji.length > 10) {
    return res.status(400).json({ error: 'Invalid emoji' });
  }

  try {
    const member = await verifyMembership(conversationId, userId);
    if (!member) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const convUuid = cassandra.types.Uuid.fromString(conversationId);
    const msgUuid = cassandra.types.TimeUuid.fromString(messageId);
    const userUuid = cassandra.types.Uuid.fromString(userId);

    const existing = await scylla.execute(
      `SELECT user_id FROM message_reactions
       WHERE conversation_id = ? AND message_id = ? AND emoji = ? AND user_id = ?`,
      [convUuid, msgUuid, emoji, userUuid],
      { prepare: true }
    );

    let action;

    if (existing.rows.length > 0) {
      await Promise.all([
        scylla.execute(
          `DELETE FROM message_reactions
           WHERE conversation_id = ? AND message_id = ? AND emoji = ? AND user_id = ?`,
          [convUuid, msgUuid, emoji, userUuid],
          { prepare: true }
        ),
        scylla.execute(
          `UPDATE reaction_counts SET count = count - 1
           WHERE conversation_id = ? AND message_id = ? AND emoji = ?`,
          [convUuid, msgUuid, emoji],
          { prepare: true }
        ),
        scylla.execute(
          `DELETE FROM user_reactions
           WHERE conversation_id = ? AND user_id = ? AND message_id = ? AND emoji = ?`,
          [convUuid, userUuid, msgUuid, emoji],
          { prepare: true }
        ),
      ]);
      action = 'remove';
    } else {
      await Promise.all([
        scylla.execute(
          `INSERT INTO message_reactions (conversation_id, message_id, emoji, user_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [convUuid, msgUuid, emoji, userUuid, new Date()],
          { prepare: true }
        ),
        scylla.execute(
          `UPDATE reaction_counts SET count = count + 1
           WHERE conversation_id = ? AND message_id = ? AND emoji = ?`,
          [convUuid, msgUuid, emoji],
          { prepare: true }
        ),
        scylla.execute(
          `INSERT INTO user_reactions (conversation_id, user_id, message_id, emoji)
           VALUES (?, ?, ?, ?)`,
          [convUuid, userUuid, msgUuid, emoji],
          { prepare: true }
        ),
      ]);
      action = 'add';
    }

    const payload = {
      conversation_id: conversationId,
      message_id: messageId,
      emoji,
      user_id: userId,
      action,
    };

    const members = await getConversationMembers(conversationId);
    members.forEach((memberId) => {
      if (memberId !== userId) {
        sendToUser(memberId, action === 'add' ? 'REACTION_ADD' : 'REACTION_REMOVE', payload);
      }
    });

    res.json({ success: true, ...payload });
  } catch (err) {
    console.error('Reaction toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle reaction' });
  }
});

export default router;