import { pool } from '../../../db.js';
import { resolveMembershipConversation } from '../../../utils/groupMembership.js';

export function registerLegacyMemberRoutes(router) {
  router.post('/', async (req, res) => {
    try {
      const conversation = await resolveMembershipConversation(pool, req.params.conversationId);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      if (conversation.type === 'dm') {
        return res.status(400).json({ error: 'Cannot add members to a DM' });
      }

      return res.status(409).json({
        error: 'Adding group members now requires key rotation',
        code: 'KEY_ROTATION_REQUIRED',
        endpoint: 'POST /api/conversations/:conversationId/members/rotate-add',
      });
    } catch (err) {
      console.error('Members POST error:', err);
      res.status(500).json({ error: 'Failed to add members' });
    }
  });

  router.delete('/:targetUserId', async (req, res) => {
    try {
      const conversation = await resolveMembershipConversation(pool, req.params.conversationId);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      if (conversation.type === 'dm') {
        return res.status(400).json({ error: 'Cannot remove members from a DM' });
      }

      return res.status(409).json({
        error: 'Removing group members now requires key rotation by the owner',
        code: req.user.id === req.params.targetUserId ? 'SELF_LEAVE_ROTATION_UNAVAILABLE' : 'KEY_ROTATION_REQUIRED',
        endpoint: 'POST /api/conversations/:conversationId/members/rotate-remove',
      });
    } catch (err) {
      console.error('Members DELETE error:', err);
      res.status(500).json({ error: 'Failed to remove member' });
    }
  });
}
