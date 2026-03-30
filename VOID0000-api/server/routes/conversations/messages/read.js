import { Router } from 'express';
import {
  canAccessMessageForHistory,
  cassandra,
  conversationPublicId,
  getConversationKeyState,
  pool,
  resolveConversationContexts,
  scylla,
  verifyMembership,
} from './shared.js';

const router = Router({ mergeParams: true });

router.put('/read', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier } = req.params;
  const { message_id } = req.body;

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) return res.status(404).json({ error: 'Conversation not found' });

    const {
      conversation,
      storageConversationId,
    } = resolvedConversation;
    const membershipConversationId = conversation.parent_conversation_id || conversation.id;
    const member = await verifyMembership(membershipConversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });

    let parsedMessageId = null;
    if (message_id) {
      try {
        parsedMessageId = cassandra.types.TimeUuid.fromString(String(message_id));
      } catch {
        return res.status(400).json({ error: 'Invalid message_id' });
      }

      if (conversation.type !== 'dm') {
        const keyState = await getConversationKeyState(conversation, userId);
        if (!keyState) {
          return res.status(403).json({ error: 'Missing group key membership state' });
        }

        const result = await scylla.execute(
          'SELECT message_id, key_version, created_at FROM messages WHERE conversation_id = ? AND message_id = ?',
          [cassandra.types.Uuid.fromString(storageConversationId), parsedMessageId],
          { prepare: true }
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Message not found' });
        }

        const row = result.rows[0];
        const historyProbe = {
          key_version: row.key_version,
          created_at: row.created_at?.toISOString() || null,
        };

        if (!canAccessMessageForHistory(historyProbe, keyState)) {
          return res.status(404).json({ error: 'Message not found' });
        }
      }
    }

    await pool.query(
      `UPDATE conversation_members
       SET last_read_message_id = $1,
           unread_count = 0
       WHERE conversation_id = $2 AND user_id = $3`,
      [message_id || null, membershipConversationId, userId]
    );

    res.json({
      success: true,
      conversation_id: conversation.id,
      conversation_public_id: conversationPublicId(conversation),
    });
  } catch (err) {
    console.error('Read receipt error:', err);
    res.status(500).json({ error: 'Failed to update read receipt' });
  }
});

export default router;
