import { Router } from 'express';
import { pool } from '../../db.js';
import { findConversationByIdentifier } from '../../utils/conversationIdentity.js';
import { resolvePermissions, validatePermissions } from '../../utils/groupPermissions.js';
import { broadcastConversationUpdate, getConversationMemberRole, normalizeConversationRow } from './root/shared.js';

const router = Router({ mergeParams: true });

// GET /api/conversations/:conversationId/permissions
// Any member can read permissions.
router.get('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const conversation = await findConversationByIdentifier(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (conversation.type !== 'group') {
      return res.status(400).json({ error: 'Permissions are only supported for groups' });
    }

    const role = await getConversationMemberRole(conversation.id, userId);
    if (!role) {
      return res.status(403).json({ error: 'Not a member' });
    }

    const permissions = resolvePermissions(conversation.permissions);
    res.json({ success: true, permissions });
  } catch (err) {
    console.error('Permissions GET error:', err);
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
});

// PUT /api/conversations/:conversationId/permissions
// Owner only.
router.put('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const conversation = await findConversationByIdentifier(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (conversation.type !== 'group') {
      return res.status(400).json({ error: 'Permissions are only supported for groups' });
    }

    const role = await getConversationMemberRole(conversation.id, userId);
    if (role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can update permissions' });
    }

    const { valid, permissions: validated, error } = validatePermissions(req.body.permissions);
    if (!valid) {
      return res.status(400).json({ error });
    }

    // Merge with existing stored permissions (partial updates allowed)
    const current = conversation.permissions || {};
    const merged = { ...current, ...validated };

    const result = await pool.query(
      `UPDATE conversations
       SET permissions = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(merged), conversation.id]
    );

    const normalizedConversation = normalizeConversationRow(result.rows[0]);
    await broadcastConversationUpdate(conversation.id, normalizedConversation);

    res.json({ success: true, permissions: resolvePermissions(merged) });
  } catch (err) {
    console.error('Permissions PUT error:', err);
    res.status(500).json({ error: 'Failed to update permissions' });
  }
});

export default router;
