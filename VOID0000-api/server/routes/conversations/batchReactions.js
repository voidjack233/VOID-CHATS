// server/routes/conversations/batchReactions.js
// Mount in conversations/index.js as:
//   import batchReactionsRouter from './batchReactions.js';
//   router.get('/:conversationId/reactions', authenticateUser, batchReactionsRouter);

import { Router } from 'express';
import { pool } from '../../db.js';
import scylla, { cassandra } from '../../scylla.js';

const router = Router({ mergeParams: true });

// GET /api/conversations/:conversationId/reactions?message_ids=id1,id2,id3
router.get('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { message_ids } = req.query;

  if (!message_ids) {
    return res.status(400).json({ error: 'message_ids query param required' });
  }

  try {
    // Verify membership
    const memberCheck = await pool.query(
      `SELECT role FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    const ids = message_ids.split(',').filter(Boolean).slice(0, 100);

    if (ids.length === 0) {
      return res.json({ success: true, reactions: {} });
    }

    const convUuid = cassandra.types.Uuid.fromString(conversationId);

    // Query all reactions for these messages in parallel
    const results = await Promise.all(
      ids.map((id) =>
        scylla.execute(
          `SELECT message_id, emoji, user_id FROM message_reactions
           WHERE conversation_id = ? AND message_id = ?`,
          [convUuid, cassandra.types.TimeUuid.fromString(id)],
          { prepare: true }
        ).catch(() => ({ rows: [] }))
      )
    );

    // Build response: { messageId: { emoji: [userId, ...] } }
    const reactions = {};
    for (const result of results) {
      for (const row of result.rows) {
        const msgId = row.message_id.toString();
        const emoji = row.emoji;
        const uid = row.user_id.toString();

        if (!reactions[msgId]) reactions[msgId] = {};
        if (!reactions[msgId][emoji]) reactions[msgId][emoji] = [];
        reactions[msgId][emoji].push(uid);
      }
    }

    res.json({ success: true, reactions });
  } catch (err) {
    console.error('Batch reactions error:', err);
    res.status(500).json({ error: 'Failed to fetch reactions' });
  }
});

export default router;