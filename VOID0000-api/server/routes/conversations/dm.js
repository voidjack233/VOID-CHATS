// server/routes/conversations/dm.js
import { Router } from 'express';
import { pool } from '../../db.js';
import { conversationSnowflake } from '../../utils/snowflake.js';

const router = Router();

// POST /api/conversations/dm/:userId — get or create DM
router.post('/:userId', async (req, res) => {
  const currentUserId = req.user.id;
  const targetUserId = req.params.userId;

  if (currentUserId === targetUserId) {
    return res.status(400).json({ error: 'Cannot DM yourself' });
  }

  const [userA, userB] = [currentUserId, targetUserId].sort();

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
      [`dm:${userA}:${userB}`]
    );

    const existing = await client.query(
      `SELECT dp.conversation_id, c.public_id
       FROM dm_pairs dp
       JOIN conversations c ON c.id = dp.conversation_id
       WHERE dp.user_a = $1 AND dp.user_b = $2`,
      [userA, userB]
    );

    // Friendship check runs for both paths: new DM and existing DM.
    // dm_pairs persists after unfriend, so we must gate here rather than
    // relying on the new-DM branch below being reached.
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

    if (existing.rows.length > 0) {
      // Unhide the DM for the requesting user if they had previously closed it.
      await client.query(
        `UPDATE conversation_members
         SET is_hidden = FALSE
         WHERE conversation_id = $1 AND user_id = $2 AND is_hidden = TRUE`,
        [existing.rows[0].conversation_id, currentUserId]
      );
      await client.query('COMMIT');
      return res.json({
        success: true,
        conversation_id: existing.rows[0].conversation_id,
        conversation_public_id: existing.rows[0].public_id ? String(existing.rows[0].public_id) : null,
        created: false,
      });
    }

    const convResult = await client.query(
      `INSERT INTO conversations (type, public_id, owner_id, current_key_version)
       VALUES ('dm', $1, $2, 1)
       RETURNING id, public_id`,
      [conversationSnowflake.nextId(), currentUserId]
    );

    const conversationId = convResult.rows[0].id;
    const conversationPublicId = convResult.rows[0].public_id ? String(convResult.rows[0].public_id) : null;

    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [conversationId, currentUserId, targetUserId]
    );

    await client.query(
      `INSERT INTO dm_pairs (user_a, user_b, conversation_id)
       VALUES ($1, $2, $3)`,
      [userA, userB, conversationId]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      conversation_id: conversationId,
      conversation_public_id: conversationPublicId,
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
