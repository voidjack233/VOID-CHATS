import { Router } from 'express';
import { pool } from '../../../db.js';
import { findConversationByIdentifier } from '../../../utils/conversationIdentity.js';
import { getConversationMemberRole } from './shared.js';

const router = Router();

router.delete('/:conversationId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId } = req.params;

  try {
    const resolvedConversation = await findConversationByIdentifier(conversationId);
    if (!resolvedConversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const memberRole = await getConversationMemberRole(resolvedConversation.id, userId);
    if (memberRole !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can delete this conversation' });
    }

    await pool.query('DELETE FROM conversations WHERE id = $1', [resolvedConversation.id]);

    res.json({ success: true, message: 'Conversation deleted' });
  } catch (err) {
    console.error('Conversation DELETE error:', err);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

export default router;
