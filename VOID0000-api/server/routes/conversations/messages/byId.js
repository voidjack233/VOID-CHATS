import { Router } from 'express';
import { sendLiveEventToUser } from '../../../gateway/client.js';
import { debugLog } from '../../../utils/debugLog.js';
import {
  canAccessMessageForHistory,
  cassandra,
  getConversationKeyState,
  getConversationMembers,
  mapStoredMessageRow,
  normalizeForwardedMetadata,
  normalizeMentionMetadata,
  normalizeKeyVersion,
  serializeStoredMessageMetadata,
  resolveConversationContexts,
  scylla,
  verifyMembership,
} from './shared.js';

const router = Router({ mergeParams: true });

router.get('/:messageId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;

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

    const keyState = await getConversationKeyState(conversation, userId);
    if (!keyState) {
      return res.status(403).json({ error: 'Missing group key membership state' });
    }

    const result = await scylla.execute(
      `SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(storageConversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Message not found' });

    const message = mapStoredMessageRow(result.rows[0], conversationPublic);

    if (conversation.type !== 'dm' && !canAccessMessageForHistory(message, keyState)) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }

    res.json({ success: true, message });
  } catch (err) {
    console.error('Single message fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch message' });
  }
});

router.patch('/:messageId/preview', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;
  const { encrypted_link_preview, iv, key_version } = req.body || {};

  if (
    typeof encrypted_link_preview !== 'string' ||
    encrypted_link_preview.trim().length === 0 ||
    typeof iv !== 'string' ||
    iv.trim().length === 0
  ) {
    return res.status(400).json({ error: 'encrypted_link_preview and iv are required' });
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
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const keyState = await getConversationKeyState(conversation, userId);
    if (!keyState) {
      return res.status(403).json({ error: 'Missing group key membership state' });
    }

    const messageResult = await scylla.execute(
      `SELECT sender_id, is_deleted, key_version FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(storageConversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (messageResult.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

    const messageRow = messageResult.rows[0];
    if (messageRow.sender_id.toString() !== userId) {
      return res.status(403).json({ error: 'Can only update previews for your own messages' });
    }
    if (messageRow.is_deleted) return res.status(400).json({ error: 'Cannot update a deleted message' });

    const messageKeyVersion = normalizeKeyVersion(messageRow.key_version, keyState.currentKeyVersion);
    const requestedKeyVersion = normalizeKeyVersion(key_version, messageKeyVersion);
    if (requestedKeyVersion !== messageKeyVersion) {
      return res.status(409).json({
        error: `Expected key_version ${messageKeyVersion}`,
        code: 'STALE_KEY_VERSION',
        current_key_version: messageKeyVersion,
      });
    }

    await scylla.execute(
      `UPDATE messages SET encrypted_link_preview = ?, link_preview_iv = ?, link_preview_key_version = ?
       WHERE conversation_id = ? AND message_id = ?`,
      [
        encrypted_link_preview,
        iv,
        requestedKeyVersion,
        cassandra.types.Uuid.fromString(storageConversationId),
        cassandra.types.TimeUuid.fromString(messageId),
      ],
      { prepare: true }
    );

    const update = {
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId,
      encrypted_link_preview,
      link_preview_iv: iv,
      link_preview_key_version: requestedKeyVersion,
    };

    const members = await getConversationMembers(conversationId);
    debugLog('[WS_FANOUT] MESSAGE_UPDATE preview', {
      conversation_id: conversationId,
      sender_id: userId,
      recipient_count: members.length,
      includes_sender_sessions: true,
    });
    members.forEach((memberId) => {
      sendLiveEventToUser(memberId, 'MESSAGE_UPDATE', update);
    });

    res.json({ success: true, ...update });
  } catch (err) {
    console.error('Message preview update error:', err);
    res.status(500).json({ error: 'Failed to update message preview' });
  }
});

router.put('/:messageId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;
  const { encrypted_content, iv, key_version, message_type, forwarded, mentions } = req.body;

  if (!encrypted_content || !iv) {
    return res.status(400).json({ error: 'encrypted_content and iv are required' });
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
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const keyState = await getConversationKeyState(conversation, userId);
    if (!keyState) {
      return res.status(403).json({ error: 'Missing group key membership state' });
    }

    let normalizedForwarded;
    let normalizedMentions;
    try {
      normalizedForwarded = normalizeForwardedMetadata(forwarded);
      normalizedMentions = await normalizeMentionMetadata(conversationId, conversation.type, mentions);
    } catch (metadataError) {
      return res.status(400).json({ error: metadataError.message || 'Invalid message metadata' });
    }

    const requestedKeyVersion = conversation.type === 'dm'
      ? normalizeKeyVersion(key_version, keyState.currentKeyVersion)
      : normalizeKeyVersion(key_version, 0);

    if (requestedKeyVersion !== keyState.currentKeyVersion) {
      return res.status(409).json({
        error: `Expected key_version ${keyState.currentKeyVersion}`,
        code: 'STALE_KEY_VERSION',
        current_key_version: keyState.currentKeyVersion,
      });
    }

    const messageResult = await scylla.execute(
      `SELECT sender_id, is_deleted, message_type FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(storageConversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (messageResult.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

    const messageRow = messageResult.rows[0];
    if (messageRow.sender_id.toString() !== userId) {
      return res.status(403).json({ error: 'Can only edit your own messages' });
    }
    if (messageRow.is_deleted) return res.status(400).json({ error: 'Cannot edit a deleted message' });
    const nextMessageType = typeof message_type === 'string' && message_type.trim()
      ? message_type.trim()
      : (messageRow.message_type || 'text');
    const storedForwarded = serializeStoredMessageMetadata(normalizedForwarded);
    const storedMentions = serializeStoredMessageMetadata(normalizedMentions);

    const now = new Date();
    const editId = cassandra.types.TimeUuid.now();

    await scylla.execute(
      `INSERT INTO message_edits (conversation_id, message_id, edit_id, encrypted_content, iv, key_version, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        cassandra.types.Uuid.fromString(storageConversationId),
        cassandra.types.TimeUuid.fromString(messageId),
        editId,
        encrypted_content,
        iv,
        requestedKeyVersion,
        now,
      ],
      { prepare: true }
    );

    await scylla.execute(
      `UPDATE messages SET encrypted_content = ?, iv = ?, key_version = ?, message_type = ?, forwarded = ?, mentions = ?,
         encrypted_link_preview = null, link_preview_iv = null, link_preview_key_version = null,
         is_edited = true, edited_at = ?
       WHERE conversation_id = ? AND message_id = ?`,
      [
        encrypted_content,
        iv,
        requestedKeyVersion,
        nextMessageType,
        storedForwarded,
        storedMentions,
        now,
        cassandra.types.Uuid.fromString(storageConversationId),
        cassandra.types.TimeUuid.fromString(messageId),
      ],
      { prepare: true }
    );

    const update = {
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId,
      encrypted_content,
      iv,
      key_version: requestedKeyVersion,
      message_type: nextMessageType,
      forwarded: normalizedForwarded || null,
      mentions: normalizedMentions,
      is_edited: true,
      edited_at: now.toISOString(),
    };

    const members = await getConversationMembers(conversationId);
    debugLog('[WS_FANOUT] MESSAGE_UPDATE', {
      conversation_id: conversationId,
      sender_id: userId,
      recipient_count: members.length,
      includes_sender_sessions: true,
    });
    members.forEach((memberId) => {
      sendLiveEventToUser(memberId, 'MESSAGE_UPDATE', update);
    });

    res.json({ success: true, ...update });
  } catch (err) {
    console.error('Message edit error:', err);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

router.delete('/:messageId', async (req, res) => {
  const userId = req.user.id;
  const { conversationId: conversationIdentifier, messageId } = req.params;

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) return res.status(404).json({ error: 'Conversation not found' });

    const {
      conversationId,
      conversationPublic,
      storageConversationId,
    } = resolvedConversation;
    const member = await verifyMembership(conversationId, userId);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const messageResult = await scylla.execute(
      `SELECT sender_id FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(storageConversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    if (messageResult.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

    const isSender = messageResult.rows[0].sender_id.toString() === userId;
    const canDelete = isSender || ['owner', 'admin'].includes(member.role);
    if (!canDelete) return res.status(403).json({ error: 'Cannot delete this message' });

    await scylla.execute(
      `UPDATE messages SET is_deleted = true, encrypted_content = null, iv = null,
         encrypted_link_preview = null, link_preview_iv = null, link_preview_key_version = null
       WHERE conversation_id = ? AND message_id = ?`,
      [cassandra.types.Uuid.fromString(storageConversationId), cassandra.types.TimeUuid.fromString(messageId)],
      { prepare: true }
    );

    const deletion = {
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageId,
      deleted_by: userId,
    };

    const members = await getConversationMembers(conversationId);
    debugLog('[WS_FANOUT] MESSAGE_DELETE', {
      conversation_id: conversationId,
      sender_id: userId,
      recipient_count: members.length,
      includes_sender_sessions: true,
    });
    members.forEach((memberId) => {
      sendLiveEventToUser(memberId, 'MESSAGE_DELETE', deletion);
    });

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    console.error('Message delete error:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

export default router;
