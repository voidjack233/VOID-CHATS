import { Router } from 'express';
import { pool } from '../../../db.js';
import { normalizeConversationRow } from './shared.js';

const router = Router();

router.get('/', async (req, res) => {
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
         c.current_key_version,
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
         AND c.type != 'channel'
       ORDER BY c.updated_at DESC`,
      [userId]
    );

    res.json({ success: true, conversations: result.rows.map(normalizeConversationRow) });
  } catch (err) {
    console.error('Conversations GET error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

export default router;
