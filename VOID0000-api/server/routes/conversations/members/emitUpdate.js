import { pool } from '../../../db.js';
import {
  emitConversationUpdate,
  getGroupMembership,
  normalizeKeyVersion,
  resolveMembershipConversation,
} from '../../../utils/groupMembership.js';

export function registerMemberEmitUpdateRoute(router) {
  router.post('/emit-update', async (req, res) => {
    const userId = req.user.id;
    const { conversationId } = req.params;

    try {
      const conversation = await resolveMembershipConversation(pool, conversationId);
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      const membership = await getGroupMembership(pool, conversation.id, userId);
      if (!membership) {
        return res.status(403).json({ error: 'Not a member' });
      }

      const membersResult = await pool.query(
        'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
        [conversation.id]
      );
      const memberIds = membersResult.rows.map((row) => row.user_id);
      const currentKeyVersion = normalizeKeyVersion(conversation.current_key_version, 1);

      await emitConversationUpdate(conversation, memberIds, currentKeyVersion, memberIds.length);

      res.json({ success: true });
    } catch (err) {
      console.error('Emit-update error:', err);
      res.status(500).json({ error: 'Failed to emit update' });
    }
  });
}
