import { sendLiveEventToUser } from '../../../gateway/client.js';
import { dispatchMessagePushNotifications } from '../../../notifications/webPush.js';
import { messageEventId } from '../../../utils/eventIdentity.js';
import { debugLog } from '../../../utils/debugLog.js';
import { emitConversationUpdate } from '../../../utils/groupMembership.js';
import { meetsWhoThreshold, resolvePermissions } from '../../../utils/groupPermissions.js';
import {
  cassandra,
  getConversationKeyState,
  getConversationMembers,
  mapStoredMessageRow,
  normalizeKeyVersion,
  normalizeForwardedMetadata,
  normalizeMentionMetadata,
  pool,
  resolveConversationContexts,
  scylla,
  serializeStoredMessageMetadata,
  verifyMembership,
} from './shared.js';
import valkey from '../../../valkey.js';
import { hasPendingMembershipRotation } from './membershipRotationGuard.js';

export class MessageSendError extends Error {
  constructor(status, body) {
    super(body?.error || 'Message send failed');
    this.status = status;
    this.body = body;
  }
}

export function isMessageSendError(error) {
  return error instanceof MessageSendError;
}

function fail(status, body) {
  throw new MessageSendError(status, body);
}

const MESSAGE_IDEMPOTENCY_TTL_SEC = 7 * 24 * 60 * 60;

function getClientMessageIdempotencyKey(userId, conversationId, clientMessageId) {
  return `message:idempotency:${userId}:${conversationId}:${clientMessageId}`;
}

async function restoreIdempotentMessage({
  userId,
  conversationId,
  conversationPublic,
  storageConversationId,
  clientMessageId,
}) {
  if (!clientMessageId) {
    return null;
  }

  try {
    const raw = await valkey.get(
      getClientMessageIdempotencyKey(userId, conversationId, clientMessageId)
    );
    if (!raw) {
      return null;
    }

    const cached = JSON.parse(raw);
    const storedConversationId = cached?.storageConversationId || storageConversationId;
    const storedMessageId = cached?.messageId;
    if (!storedMessageId || !storedConversationId) {
      return null;
    }

    const result = await scylla.execute(
      `SELECT * FROM messages WHERE conversation_id = ? AND message_id = ?`,
      [
        cassandra.types.Uuid.fromString(String(storedConversationId)),
        cassandra.types.TimeUuid.fromString(String(storedMessageId)),
      ],
      { prepare: true }
    );

    const row = result.rows[0];
    if (!row) {
      await valkey.del(
        getClientMessageIdempotencyKey(userId, conversationId, clientMessageId)
      ).catch(() => {});
      return null;
    }

    return mapStoredMessageRow(row, conversationPublic);
  } catch (error) {
    console.warn('[MESSAGE_IDEMPOTENCY] failed to restore cached message', {
      conversation_id: conversationId,
      client_message_id: clientMessageId,
      error: error instanceof Error ? error.message : String(error || ''),
    });
    return null;
  }
}

async function findMissingDmDeliveryStateMembers(conversationId, recipientMemberIds, keyVersion) {
  if (!recipientMemberIds.length) return [];

  const result = await pool.query(
    `SELECT recipients.user_id::text AS user_id,
            EXISTS (
              SELECT 1
              FROM mls_welcome_messages welcomes
              WHERE welcomes.conversation_id = $1::UUID
                AND welcomes.user_id = recipients.user_id
                AND COALESCE(welcomes.key_version, 1) >= $3::int
            ) AS has_welcome,
            EXISTS (
              SELECT 1
              FROM mls_group_states states
              WHERE states.conversation_id = $1::UUID
                AND states.user_id = recipients.user_id
                AND COALESCE(states.key_version, states.epoch, 0) >= $3::int
            ) AS has_group_state
     FROM unnest($2::UUID[]) AS recipients(user_id)`,
    [conversationId, recipientMemberIds, keyVersion]
  );

  return result.rows
    .filter((row) => !row.has_welcome && !row.has_group_state)
    .map((row) => row.user_id);
}

export async function sendConversationMessage({ userId, conversationIdentifier, body }) {
  const {
    encrypted_content,
    iv,
    key_version,
    client_message_id,
    message_type,
    reply_to,
    attachments,
    content,
    forwarded,
    mentions,
  } = body || {};
  let storageConversationUuid = null;
  let messageId = null;
  let messagePersistedToScylla = false;

  const isPlaintextSystem = message_type === 'system' && typeof content === 'string' && content.trim().length > 0;

  if (!isPlaintextSystem) {
    if (!encrypted_content && !iv && (!attachments || attachments.length === 0)) {
      fail(400, { error: 'encrypted_content/iv or attachments required' });
    }
    if ((encrypted_content || iv) && (!encrypted_content || !iv)) {
      fail(400, { error: 'encrypted_content and iv must both be present' });
    }
  }

  if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 5)) {
    fail(400, { error: 'attachments must be an array of up to 5 URLs' });
  }

  try {
    const resolvedConversation = await resolveConversationContexts(conversationIdentifier);
    if (!resolvedConversation) fail(404, { error: 'Conversation not found' });

    const {
      conversation,
      conversationId,
      conversationPublic,
      storageConversationId,
    } = resolvedConversation;
    const membershipConversationId = conversation.parent_conversation_id || conversationId;
    const member = await verifyMembership(conversationId, userId);
    if (!member) fail(403, { error: 'Not a member of this conversation' });
    if (member.role === 'viewer') fail(403, { error: 'Viewers cannot send messages' });

    const normalizedClientMessageId =
      typeof client_message_id === 'string' && client_message_id.trim().length > 0
        ? client_message_id.trim().slice(0, 128)
        : null;

    if (normalizedClientMessageId) {
      const existingMessage = await restoreIdempotentMessage({
        userId,
        conversationId,
        conversationPublic,
        storageConversationId,
        clientMessageId: normalizedClientMessageId,
      });

      if (existingMessage) {
        return { message: existingMessage };
      }
    }

    if (conversation.type === 'group' || conversation.type === 'channel') {
      if (await hasPendingMembershipRotation(pool, membershipConversationId)) {
        fail(409, {
          success: false,
          error: 'Securing group membership. Try again in a moment.',
          code: 'MEMBERSHIP_ROTATION_PENDING',
        });
      }
    }

    if ((conversation.type === 'group' || conversation.type === 'channel') && Array.isArray(attachments) && attachments.length > 0) {
      let permissionsSource = conversation.permissions;
      if (conversation.type === 'channel' && conversation.parent_conversation_id) {
        const parentResult = await pool.query(
          'SELECT permissions FROM conversations WHERE id = $1 LIMIT 1',
          [conversation.parent_conversation_id]
        );
        if (parentResult.rows.length > 0) {
          permissionsSource = parentResult.rows[0].permissions;
        }
      }
      const perms = resolvePermissions(permissionsSource);
      if (!meetsWhoThreshold(member.role, perms.who_can_send_attachments)) {
        fail(403, { error: 'You do not have permission to send attachments' });
      }
    }

    const keyState = await getConversationKeyState(conversation, userId);
    if (!keyState) {
      fail(403, { error: 'Missing group key membership state' });
    }

    let normalizedForwarded;
    let normalizedMentions;
    try {
      normalizedForwarded = normalizeForwardedMetadata(forwarded);
      normalizedMentions = await normalizeMentionMetadata(conversationId, conversation.type, mentions);
    } catch (metadataError) {
      fail(400, { error: metadataError.message || 'Invalid message metadata' });
    }

    const requestedKeyVersion = conversation.type === 'dm'
      ? normalizeKeyVersion(key_version, keyState.currentKeyVersion)
      : normalizeKeyVersion(key_version, 0);
    const dmKeyVersionBump =
      conversation.type === 'dm' && requestedKeyVersion > keyState.currentKeyVersion;
    const isStaleKeyVersion = conversation.type === 'dm'
      ? requestedKeyVersion < keyState.currentKeyVersion
      : requestedKeyVersion !== keyState.currentKeyVersion;

    if (isStaleKeyVersion) {
      fail(409, {
        error: `Expected key_version ${keyState.currentKeyVersion}`,
        code: 'STALE_KEY_VERSION',
        current_key_version: keyState.currentKeyVersion,
      });
    }

    // For the first DM message, verify that bootstrap left durable delivery
    // state for each recipient. Do not require unused key packages here:
    // claiming a peer package during MLS bootstrap consumes one, so checking
    // package availability after bootstrap can reject a valid first message.
    if (conversation.type === 'dm' && !isPlaintextSystem) {
      const members = await getConversationMembers(conversationId);
      const recipientMemberIds = members.filter((memberId) => memberId !== userId);
      const firstMessageResult = await pool.query(
        `SELECT first_message_at
         FROM conversations
         WHERE id = $1`,
        [conversationId]
      );
      const isInitialDmMessage = !firstMessageResult.rows[0]?.first_message_at;

      if (isInitialDmMessage) {
        const missingDeliveryMembers = await findMissingDmDeliveryStateMembers(
          conversationId,
          recipientMemberIds,
          requestedKeyVersion
        );

        if (missingDeliveryMembers.length > 0) {
          fail(409, {
            error: 'One or more DM recipients do not have secure delivery state for this conversation yet',
            code: 'DM_RECIPIENT_KEY_DELIVERY_MISSING',
            missing_member_ids: missingDeliveryMembers,
          });
        }
      }
    }

    messageId = cassandra.types.TimeUuid.now();
    const messageIdString = messageId.toString();
    const now = new Date();
    const attachList = Array.isArray(attachments) && attachments.length > 0 ? attachments : null;
    const storedForwarded = serializeStoredMessageMetadata(normalizedForwarded);
    const storedMentions = serializeStoredMessageMetadata(normalizedMentions);

    const storedContent = isPlaintextSystem ? content.trim() : (encrypted_content || null);
    const storedIv = isPlaintextSystem ? null : (iv || null);
    storageConversationUuid = cassandra.types.Uuid.fromString(storageConversationId);

    await scylla.execute(
      `INSERT INTO messages (
        conversation_id, message_id, sender_id, encrypted_content, iv,
        key_version, message_type, reply_to, attachments, forwarded, mentions, is_edited, is_deleted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, false, ?)`,
      [
        storageConversationUuid,
        messageId,
        cassandra.types.Uuid.fromString(userId),
        storedContent,
        storedIv,
        requestedKeyVersion,
        message_type || 'text',
        reply_to ? cassandra.types.TimeUuid.fromString(reply_to) : null,
        attachList,
        storedForwarded,
        storedMentions,
        now,
      ],
      { prepare: true }
    );
    messagePersistedToScylla = true;

    const touchedConversationIds = [...new Set(
      [conversationId, storageConversationId, conversation.parent_conversation_id].filter(Boolean)
    )];

    const pgClient = await pool.connect();
    try {
      await pgClient.query('BEGIN');

      if (dmKeyVersionBump) {
        await pgClient.query(
          `UPDATE conversations
           SET current_key_version = GREATEST(COALESCE(current_key_version, 1), $2),
               updated_at = NOW()
           WHERE id = $1
             AND type = 'dm'`,
          [conversationId, requestedKeyVersion]
        );
      }

      await pgClient.query(
        `UPDATE conversations
         SET updated_at = NOW(),
             first_message_at = COALESCE(first_message_at, NOW())
         WHERE id = ANY($1::uuid[])`,
        [touchedConversationIds]
      );
      await pgClient.query(
        `UPDATE conversation_members
         SET unread_count = CASE
               WHEN user_id = $2 THEN 0
               ELSE COALESCE(unread_count, 0) + 1
             END,
             last_read_message_id = CASE
               WHEN user_id = $2 THEN $3
               ELSE last_read_message_id
             END,
             last_message_sent_at = CASE
               WHEN user_id = $2 THEN NOW()
               ELSE last_message_sent_at
             END
         WHERE conversation_id = $1`,
        [membershipConversationId, userId, messageIdString]
      );

      await pgClient.query('COMMIT');
    } catch (pgErr) {
      await pgClient.query('ROLLBACK');
      throw pgErr;
    } finally {
      pgClient.release();
    }

    const message = {
      event_id: messageEventId(messageId.toString()),
      conversation_id: conversationId,
      conversation_public_id: conversationPublic,
      message_id: messageIdString,
      client_message_id: normalizedClientMessageId,
      sender_id: userId,
      encrypted_content: storedContent,
      iv: storedIv,
      key_version: requestedKeyVersion,
      message_type: message_type || 'text',
      reply_to: reply_to || null,
      attachments: attachList || [],
      forwarded: normalizedForwarded || null,
      mentions: normalizedMentions,
      is_edited: false,
      is_deleted: false,
      created_at: now.toISOString(),
      ...(isPlaintextSystem ? { content: storedContent } : {}),
    };

    if (normalizedClientMessageId) {
      await valkey.set(
        getClientMessageIdempotencyKey(userId, conversationId, normalizedClientMessageId),
        JSON.stringify({
          storageConversationId,
          messageId: messageIdString,
        }),
        'EX',
        MESSAGE_IDEMPOTENCY_TTL_SEC,
      ).catch((error) => {
        console.warn('[MESSAGE_IDEMPOTENCY] failed to cache sent message mapping', {
          conversation_id: conversationId,
          client_message_id: normalizedClientMessageId,
          error: error instanceof Error ? error.message : String(error || ''),
        });
      });
    }

    const members = await getConversationMembers(conversationId);
    if (dmKeyVersionBump) {
      await emitConversationUpdate(
        { ...conversation, current_key_version: requestedKeyVersion },
        members,
        requestedKeyVersion,
        members.length
      );
    }
    debugLog('[WS_FANOUT] MESSAGE_CREATE', {
      conversation_id: conversationId,
      sender_id: userId,
      recipient_count: members.length,
      includes_sender_sessions: true,
    });
    members.forEach((memberId) => {
      sendLiveEventToUser(memberId, 'MESSAGE_CREATE', message);
    });
    void dispatchMessagePushNotifications({
      senderId: userId,
      recipientIds: members,
      conversation,
      mentions: normalizedMentions,
    });

    return { message };
  } catch (err) {
    if (messagePersistedToScylla && storageConversationUuid && messageId) {
      try {
        await scylla.execute(
          'DELETE FROM messages WHERE conversation_id = ? AND message_id = ?',
          [storageConversationUuid, messageId],
          { prepare: true }
        );
      } catch (cleanupErr) {
        console.error('Failed to roll back Scylla message after send error:', cleanupErr);
      }
    }

    throw err;
  }
}
