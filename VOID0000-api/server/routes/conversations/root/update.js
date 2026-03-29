import { Router } from 'express';
import { pool } from '../../../db.js';
import { findConversationByIdentifier } from '../../../utils/conversationIdentity.js';
import { meetsWhoThreshold, resolvePermissions } from '../../../utils/groupPermissions.js';
import {
  broadcastConversationUpdate,
  getConversationMemberRole,
  normalizeConversationRow,
} from './shared.js';

const router = Router();

router.put('/:conversationId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;
  const { name } = req.body;
  const hasName = Object.prototype.hasOwnProperty.call(req.body, 'name');

  try {
    const resolvedConversation = await findConversationByIdentifier(conversationId);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const memberRole = await getConversationMemberRole(resolvedConversation.id, userId);
    if (!memberRole) {
      return res.status(403).json({ error: 'Not a member' });
    }

    if (resolvedConversation.type === 'group') {
      const perms = resolvePermissions(resolvedConversation.permissions);
      if (!meetsWhoThreshold(memberRole, perms.who_can_edit_group_profile)) {
        return res.status(403).json({ error: 'You do not have permission to edit the group profile' });
      }
    } else if (!['owner', 'admin'].includes(memberRole)) {
      return res.status(403).json({ error: 'Only owner or admin can update' });
    }

    if (!hasName) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const normalizedName = hasName ? name?.trim() : undefined;
    if (hasName && (!normalizedName || typeof name !== 'string' || normalizedName.length > 100)) {
      return res.status(400).json({ error: 'Name is required (max 100 characters)' });
    }

    const result = await pool.query(
      `UPDATE conversations
       SET name = CASE WHEN $1 THEN $2 ELSE name END,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [
        hasName,
        normalizedName || null,
        resolvedConversation.id,
      ]
    );

    const normalizedConversation = normalizeConversationRow(result.rows[0]);

    await broadcastConversationUpdate(resolvedConversation.id, normalizedConversation);

    res.json({ success: true, conversation: normalizedConversation });
  } catch (err) {
    console.error('Conversation PUT error:', err);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

export default router;
