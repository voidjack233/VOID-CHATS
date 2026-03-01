// server/routes/conversations/dm.js
import { Router } from 'express';
import { pool } from '../../db.js';

const router = Router();

// POST /api/conversations/dm/:userId — get or create DM
router.post('/:userId', async (req, res) => {
  const currentUserId = req.user.id;
  const targetUserId = req.params.userId;

  if (currentUserId === targetUserId) {
    return res.status(400).json({ error: 'Cannot DM yourself' });
  }

  // Ensure consistent ordering for dm_pairs
  const [userA, userB] = [currentUserId, targetUserId].sort();

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Check if DM already exists
    const existing = await client.query(
      `SELECT conversation_id FROM dm_pairs
       WHERE user_a = $1 AND user_b = $2`,
      [userA, userB]
    );

    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return res.json({
        success: true,
        conversation_id: existing.rows[0].conversation_id,
        created: false,
      });
    }

    // Verify friendship
    const friendCheck = await client.query(
      `SELECT id FROM friendships
       WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
         AND status = 'accepted'`,
      [currentUserId, targetUserId]
    );

    if (friendCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only DM friends' });
    }

    // Create conversation
    const convResult = await client.query(
      `INSERT INTO conversations (type) VALUES ('dm') RETURNING id`
    );

    const conversationId = convResult.rows[0].id;

    // Add both members
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [conversationId, currentUserId, targetUserId]
    );

    // Create DM pair lookup
    await client.query(
      `INSERT INTO dm_pairs (user_a, user_b, conversation_id)
       VALUES ($1, $2, $3)`,
      [userA, userB, conversationId]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      conversation_id: conversationId,
      created: true,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    console.error('DM create error:', err);
    res.status(500).json({ error: 'Failed to create DM' });
  } finally {
    if (client) client.release();
  }
});

export default router;