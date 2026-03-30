// PATCH /api/conversations/:conversationId/dm-settings
// Per-user hidden and muted state for a DM conversation.
import { Router } from 'express';
import { pool } from '../../db.js';

const router = Router({ mergeParams: true });

router.patch('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { hidden, muted_until } = req.body;

  const hasHidden = typeof hidden === 'boolean';
  const hasMute = Object.prototype.hasOwnProperty.call(req.body, 'muted_until');

  if (!hasHidden && !hasMute) {
    return res.status(400).json({ error: 'No updates provided' });
  }

  try {
    // Verify this is a DM the user is a member of.
    const memberCheck = await pool.query(
      `SELECT cm.conversation_id
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       WHERE cm.conversation_id = $1 AND cm.user_id = $2 AND c.type = 'dm'`,
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ error: 'DM not found' });
    }

    const setClauses = [];
    const values = [];
    let idx = 1;

    if (hasHidden) {
      setClauses.push(`is_hidden = $${idx++}`);
      values.push(hidden);
    }

    if (hasMute) {
      setClauses.push(`muted_until = $${idx++}`);
      // Accept ISO string or null; anything else is treated as null.
      values.push(typeof muted_until === 'string' ? muted_until : null);
    }

    values.push(conversationId, userId);
    await pool.query(
      `UPDATE conversation_members
       SET ${setClauses.join(', ')}
       WHERE conversation_id = $${idx++} AND user_id = $${idx}`,
      values
    );

    res.json({ success: true });
  } catch (err) {
    console.error('DM settings error:', err);
    res.status(500).json({ error: 'Failed to update DM settings' });
  }
});

export default router;
