import { Router } from 'express';
import { sendLiveEventToUser } from '../../../gateway/client.js';
import { messageEventId } from '../../../utils/eventIdentity.js';
import {
  cassandra,
  getConversationKeyState,
  getConversationMembers,
  normalizeKeyVersion,
  pool,
  resolveConversationContexts,
  scylla,
  verifyMembership,
} from './shared.js';

const router = Router({ mergeParams: true });

router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier } = req.params;
  const { encrypted_content, iv, key_version, message_type, reply_to, attachments, content } = req.body;

  const isPlaintextSystem = message_type === 'system' && typeof content === 'string' && content.trim().length > 0;

  if (!isPlaintextSystem) {
    if (!encrypted_content && !iv && (!attachments || attachments.length === 0)) {
      return res.status(400).json({ error: 'encrypted_content/iv or attachments required' });
    }
    if ((encrypted_content || iv) && (!encrypted_content || !iv)) {
      return res.status(400).json({ error: 'encrypted_content and iv must both be present' });
    }
  }

  if (attachments !== undefined) {
    if (!Array.isArray(attachments) || attachments.length > 5) {
      return res.status(400).json({ error: 'attachments must be an array of up to 5 URLs' });
    }
  }

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) return res.status(404).json({ error: 'Conversation not found' });

    const {
      conversation,
      conversationId,
      conversationPublic,
      storageConversationId,
    } = resolvedConversation;
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member of this conversation' });
    if (member.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot send messages' });

    const keyState = await getConversationKeyState(conversation, userId);
    if (!keyState) {
      return res.status(403).json({ error: 'Missing group key membership state' });
    }

    const requestedKeyVersion = conversation.type === 'dm'
      ? 1
      : normalizeKeyVersion(key_version, 0);

    if (requestedKeyVersion !== keyState.currentKeyVersion) {
      return res.status(409).json({
        error: `Expected key_version ${keyState.currentKeyVersion}`,
        code: 'STALE_KEY_VERSION',
        current_key_version: keyState.currentKeyVersion,
      });
    }

    const messageId = cassandra.types.TimeUuid.now();
    const now = new Date();
    const attachList = Array.isArray(attachments) && attachments.length > 0 ? attachments : null;

    const storedContent = isPlaintextSystem ? content.trim() : (encrypted_content || null);
    const storedIv = isPlaintextSystem ? null : (iv || null);

    await scylla.execute(
      `INSERT INTO messages (
        conversation_id, message_id, sender_id, encrypted_content, iv,
        key_version, message_type, reply_to, attachments, is_edited, is_deleted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, false, false, ?)`,
      [
        cassandra.types.Uuid.fromString(storageConversationId),
        messageId,
        cassandra.types.Uuid.fromString(userId),
        storedContent,
        storedIv,
        requestedKeyVersion,
        message_type || 'text',
        reply_to ? cassandra.types.TimeUuid.fromString(reply_to) : null,
        attachList,
        now,
      ],
      { prepare: true }
    );

    await pool.query('UPDATE conversations SET updated_at = NOW(), first_message_at = COALESCE(first_message_at, NOW()) WHERE id = $1', [conversationId]);
    await pool.query(
      `UPDATE conversation_members
       SET last_message_sent_at = NOW()
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    const message = {
      event_id: messageEventId(messageId.toString()),
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId.toString(),
      sender_id: userId,
      encrypted_content: storedContent,
      iv: storedIv,
      key_version: requestedKeyVersion,
      message_type: message_type || 'text',
      reply_to: reply_to || null,
      attachments: attachList || [],
      is_edited: false,
      is_deleted: false,
      created_at: now.toISOString(),
      ...(isPlaintextSystem ? { content: storedContent } : {}),
    };

    const members = await getConversationMembers(conversationId);
    console.log('[WS_FANOUT] MESSAGE_CREATE', {
      conversation_id: conversationId,
      sender_id: userId,
      recipient_count: members.length,
      includes_sender_sessions: true,
    });
    members.forEach((memberId) => {
      sendLiveEventToUser(memberId, 'MESSAGE_CREATE', message);
    });

    res.status(201).json({ success: true, message });
  } catch (err) {
    console.error('Message send error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

export default router;
