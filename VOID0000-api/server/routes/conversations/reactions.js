// server/routes/conversations/reactions.js
import { Router } from 'express';
import { pool } from '../../db.js';
import scylla, { cassandra } from '../../scylla.js';
import { sendToUser } from '../../gateway/index.js';

const router = Router({ mergeParams: true });

// Verify membership helper
async function verifyMembership(conversationId, userId) {
  const result = await pool.query(
    `SELECT role FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  return result.rows[0] || null;
}

// Get all member user_ids
async function getConversationMembers(conversationId) {
  const result = await pool.query(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
    [conversationId]
  );
  return result.rows.map((r) => r.user_id);
}

// PUT /api/conversations/:conversationId/messages/:messageId/reactions/:emoji — toggle reaction
router.put('/:emoji', async (req, res) => {
  const userId = req.user.id;
  const { conversationId, messageId } = req.params;
  const emoji = decodeURIComponent(req.params.emoji);

  // Basic emoji validation (1-10 chars, prevents abuse)
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

    // Check if reaction already exists
    const existing = await scylla.execute(
      `SELECT user_id FROM message_reactions
       WHERE conversation_id = ? AND message_id = ? AND emoji = ? AND user_id = ?`,
      [convUuid, msgUuid, emoji, userUuid],
      { prepare: true }
    );

    let action;

    if (existing.rows.length > 0) {
      // Remove reaction
      await scylla.execute(
        `DELETE FROM message_reactions
         WHERE conversation_id = ? AND message_id = ? AND emoji = ? AND user_id = ?`,
        [convUuid, msgUuid, emoji, userUuid],
        { prepare: true }
      );
      action = 'remove';
    } else {
      // Add reaction
      await scylla.execute(
        `INSERT INTO message_reactions (conversation_id, message_id, emoji, user_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [convUuid, msgUuid, emoji, userUuid, new Date()],
        { prepare: true }
      );
      action = 'add';
    }

    const payload = {
      conversation_id: conversationId,
      message_id: messageId,
      emoji,
      user_id: userId,
      action,
    };

    // Broadcast to all members
    const members = await getConversationMembers(conversationId);
    members.forEach((memberId) => {
      sendToUser(memberId, action === 'add' ? 'REACTION_ADD' : 'REACTION_REMOVE', payload);
    });

    res.json({ success: true, ...payload });
  } catch (err) {
    console.error('Reaction toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle reaction' });
  }
});

// GET /api/conversations/:conversationId/messages/:messageId/reactions — get all reactions
router.get('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId, messageId } = req.params;

  try {
    const member = await verifyMembership(conversationId, userId);
    if (!member) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const result = await scylla.execute(
      `SELECT emoji, user_id, created_at FROM message_reactions
       WHERE conversation_id = ? AND message_id = ?`,
      [
        cassandra.types.Uuid.fromString(conversationId),
        cassandra.types.TimeUuid.fromString(messageId),
      ],
      { prepare: true }
    );

    // Group by emoji: { "👍": ["user1", "user2"], "❤️": ["user3"] }
    const reactions = {};
    for (const row of result.rows) {
      const em = row.emoji;
      if (!reactions[em]) reactions[em] = [];
      reactions[em].push(row.user_id.toString());
    }

    res.json({ success: true, reactions });
  } catch (err) {
    console.error('Fetch reactions error:', err);
    res.status(500).json({ error: 'Failed to fetch reactions' });
  }
});

export default router;