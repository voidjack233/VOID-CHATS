// server/routes/conversations/batchReactions.js

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
    const userUuid = cassandra.types.Uuid.fromString(userId);
    const msgUuids = ids.map((id) => cassandra.types.TimeUuid.fromString(id));

    // Counts from counter table + current user's own reactions in parallel
    const [countsResult, meResult] = await Promise.all([
      scylla.execute(
        `SELECT message_id, emoji, count FROM reaction_counts
         WHERE conversation_id = ? AND message_id IN ?`,
        [convUuid, msgUuids],
        { prepare: true }
      ).catch(() => ({ rows: [] })),
      scylla.execute(
        `SELECT message_id, emoji FROM user_reactions
         WHERE conversation_id = ? AND user_id = ? AND message_id IN ?`,
        [convUuid, userUuid, msgUuids],
        { prepare: true }
      ).catch(() => ({ rows: [] })),
    ]);

    const meSet = new Set();
    for (const row of meResult.rows) {
      meSet.add(`${row.message_id.toString()}:${row.emoji}`);
    }

    const reactions = {};
    for (const row of countsResult.rows) {
      const msgId = row.message_id.toString();
      const emoji = row.emoji;
      const count = row.count.toNumber ? row.count.toNumber() : Number(row.count);

      if (count <= 0) continue;

      if (!reactions[msgId]) reactions[msgId] = {};
      reactions[msgId][emoji] = {
        count,
        me: meSet.has(`${msgId}:${emoji}`),
      };
    }

    res.json({ success: true, reactions });
  } catch (err) {
    console.error('Batch reactions error:', err);
    res.status(500).json({ error: 'Failed to fetch reactions' });
  }
});

export default router;