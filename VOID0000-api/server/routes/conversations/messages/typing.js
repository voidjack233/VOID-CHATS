import { Router } from 'express';
import { sendLiveEventToUser } from '../../../gateway/client.js';
import {
  getConversationMembers,
  resolveConversationContexts,
  verifyMembership,
} from './shared.js';

const router = Router({ mergeParams: true });

router.post('/typing', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier } = req.params;

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) return res.status(404).json({ error: 'Conversation not found' });

    const {
      conversationId,
      conversationPublic,
    } = resolvedConversation;
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });
    if (member.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot send typing indicators' });

    const payload = {
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      user_id: userId,
      started_at: new Date().toISOString(),
    };

    const members = await getConversationMembers(conversationId);
    members.forEach((memberId) => {
      if (memberId !== userId) sendLiveEventToUser(memberId, 'TYPING_START', payload);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Typing indicator error:', err);
    res.status(500).json({ error: 'Failed to send typing indicator' });
  }
});

export default router;
