import { Router } from 'express';
import { pool } from '../../../db.js';
import { conversationSnowflake } from '../../../utils/snowflake.js';

const router = Router();

router.post('/', async (req, res) => {
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

  if (Array.isArray(members) && members.length > 50) {
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

export default router;
