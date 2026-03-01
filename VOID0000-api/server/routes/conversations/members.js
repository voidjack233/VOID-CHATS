// server/routes/conversations/members.js
import { Router } from 'express';
import { pool } from '../../db.js';
import { sendToUser, EVENTS } from '../../gateway/index.js';

const router = Router({ mergeParams: true });

// POST /api/conversations/:conversationId/members — add members
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { members } = req.body;

  if (!Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'Members array required' });
  }

  try {
    // Check permission (owner or admin)
    const memberCheck = await pool.query(
      `SELECT c.type, cm.role FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE c.id = $1 AND cm.user_id = $2`,
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member' });
    }

    const { type, role } = memberCheck.rows[0];

    if (type === 'dm') {
      return res.status(400).json({ error: 'Cannot add members to a DM' });
    }

    if (!['owner', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'Only owner or admin can add members' });
    }

    const added = [];

    for (const memberId of members) {
      // Verify friendship with the adder
      const friendCheck = await pool.query(
        `SELECT id FROM friendships
         WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
           AND status = 'accepted'`,
        [userId, memberId]
      );

      if (friendCheck.rows.length > 0) {
        const insertResult = await pool.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT DO NOTHING
           RETURNING user_id`,
          [conversationId, memberId]
        );

        if (insertResult.rows.length > 0) {
          added.push(memberId);

          // Notify the added user
          sendToUser(memberId, EVENTS.CONVERSATION_CREATE || 'CONVERSATION_CREATE', {
            conversation_id: conversationId,
            added_by: userId,
          });
        }
      }
    }

    // Update conversation timestamp
    await pool.query(
      'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
      [conversationId]
    );

    res.json({ success: true, added });
  } catch (err) {
    console.error('Members POST error:', err);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// DELETE /api/conversations/:conversationId/members/:userId — remove member
router.delete('/:targetUserId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId, targetUserId } = req.params;

  try {
    const memberCheck = await pool.query(
      `SELECT c.type, cm.role FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE c.id = $1 AND cm.user_id = $2`,
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member' });
    }

    const { type, role } = memberCheck.rows[0];

    if (type === 'dm') {
      return res.status(400).json({ error: 'Cannot remove members from a DM' });
    }

    // Can remove self (leave) or others if owner/admin
    const isSelf = userId === targetUserId;

    if (!isSelf && !['owner', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'Only owner or admin can remove members' });
    }

    // Owner can't be removed
    const targetCheck = await pool.query(
      `SELECT role FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, targetUserId]
    );

    if (targetCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User is not a member' });
    }

    if (targetCheck.rows[0].role === 'owner' && !isSelf) {
      return res.status(403).json({ error: 'Cannot remove the owner' });
    }

    await pool.query(
      `DELETE FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, targetUserId]
    );

    // Notify removed user
    sendToUser(targetUserId, 'MEMBER_LEAVE', {
      conversation_id: conversationId,
      removed_by: isSelf ? null : userId,
    });

    res.json({ success: true, message: isSelf ? 'Left conversation' : 'Member removed' });
  } catch (err) {
    console.error('Members DELETE error:', err);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// PUT /api/conversations/:conversationId/members/:userId — update role
router.put('/:targetUserId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId, targetUserId } = req.params;
  const { role } = req.body;

  if (!role || !['admin', 'member', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Valid role required: admin, member, viewer' });
  }

  try {
    // Only owner can change roles
    const ownerCheck = await pool.query(
      `SELECT role FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can change roles' });
    }

    await pool.query(
      `UPDATE conversation_members SET role = $1
       WHERE conversation_id = $2 AND user_id = $3`,
      [role, conversationId, targetUserId]
    );

    res.json({ success: true, message: 'Role updated' });
  } catch (err) {
    console.error('Members PUT error:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

export default router;