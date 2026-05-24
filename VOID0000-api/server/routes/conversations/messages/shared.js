import { pool } from '../../../db.js';
import scylla, { cassandra } from '../../../scylla.js';
import { findConversationByIdentifier } from '../../../utils/conversationIdentity.js';
import { resolveMessageStorageConversation } from '../../../utils/messageConversation.js';

export { pool, scylla, cassandra };

export async function verifyMembership(conversationId, userId) {
  const result = await pool.query(
    `SELECT role, last_message_sent_at FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  return result.rows[0] || null;
}

export async function getConversationMembers(conversationId) {
  const result = await pool.query(
    `SELECT user_id FROM conversation_members WHERE conversation_id = $1`,
    [conversationId]
  );
  return result.rows.map((row) => row.user_id);
}

export function conversationPublicId(conversation) {
  return conversation?.public_id ? String(conversation.public_id) : null;
}

export function normalizeKeyVersion(value, fallback = 1) {
  const parsed = parseInt(String(value ?? fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function getConversationKeyState(conversation, userId) {
  if (!conversation || conversation.type === 'dm') {
    return {
      currentKeyVersion: normalizeKeyVersion(conversation?.current_key_version, 1),
      historyStartVersion: 1,
      joinedAt: null,
      role: null,
    };
  }

  const keyConversationId = conversation.parent_conversation_id || conversation.id;
  const result = await pool.query(
    `SELECT c.current_key_version, cm.history_start_version, cm.joined_at, cm.role
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE c.id = $1 AND cm.user_id = $2
     LIMIT 1`,
    [keyConversationId, userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    currentKeyVersion: normalizeKeyVersion(result.rows[0].current_key_version, 1),
    historyStartVersion: normalizeKeyVersion(result.rows[0].history_start_version, 1),
    joinedAt: result.rows[0].joined_at ? new Date(result.rows[0].joined_at).toISOString() : null,
    role: result.rows[0].role || null,
  };
}

export async function resolveConversationContexts(conversationIdentifier) {
  const conversation = await findConversationByIdentifier(conversationIdentifier);
  if (!conversation) {
    return null;
  }

  const storageConversation = await resolveMessageStorageConversation(conversation);

  return {
    conversation,
    storageConversation,
    conversationId: conversation.id,
    conversationPublic: conversationPublicId(conversation),
    storageConversationId: storageConversation?.id || conversation.id,
  };
}

export function canAccessMessageForHistory(message, keyState) {
  if (!keyState) return false;

  if (normalizeKeyVersion(message.key_version, 1) < keyState.historyStartVersion) {
    return false;
  }

  if (keyState.role === 'owner') {
    return true;
  }

  if (!keyState.joinedAt || !message.created_at) {
    return true;
  }

  const joinedAt = Date.parse(keyState.joinedAt);
  const createdAt = Date.parse(message.created_at);

  if (Number.isNaN(joinedAt) || Number.isNaN(createdAt)) {
    return true;
  }

  return createdAt >= joinedAt;
}

export function mapStoredMessageRow(row, conversationPublic) {
  return {
    conversation_id: row.conversation_id.toString(),
    conversation_public_id: conversationPublic,
    message_id: row.message_id.toString(),
    sender_id: row.sender_id.toString(),
    encrypted_content: row.is_deleted ? null : row.encrypted_content,
    iv: row.is_deleted ? null : row.iv,
    key_version: row.key_version,
    encrypted_link_preview: row.is_deleted ? null : row.encrypted_link_preview,
    link_preview_iv: row.is_deleted ? null : row.link_preview_iv,
    link_preview_key_version: row.is_deleted ? null : row.link_preview_key_version,
    message_type: row.message_type,
    reply_to: row.reply_to?.toString() || null,
    attachments: row.is_deleted ? [] : (row.attachments || []),
    forwarded: row.is_deleted ? null : parseStoredMessageMetadata(row.forwarded),
    mentions: row.is_deleted ? [] : parseStoredMessageMetadata(row.mentions, []),
    is_edited: row.is_edited,
    edited_at: row.edited_at?.toISOString() || null,
    is_deleted: row.is_deleted,
    created_at: row.created_at?.toISOString(),
  };
}

export function parseStoredMessageMetadata(value, fallback = null) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizeForwardedMetadata(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value;
  const normalized = {};

  if (typeof candidate.original_message_id === 'string' && candidate.original_message_id.trim()) {
    normalized.original_message_id = candidate.original_message_id.trim();
  }
  if (typeof candidate.original_sender_id === 'string' && candidate.original_sender_id.trim()) {
    normalized.original_sender_id = candidate.original_sender_id.trim();
  }
  if (typeof candidate.original_sender_name === 'string' && candidate.original_sender_name.trim()) {
    normalized.original_sender_name = candidate.original_sender_name.trim();
  }
  if (
    typeof candidate.original_conversation_id === 'string' &&
    candidate.original_conversation_id.trim()
  ) {
    normalized.original_conversation_id = candidate.original_conversation_id.trim();
  }
  if (
    typeof candidate.original_conversation_name === 'string' &&
    candidate.original_conversation_name.trim()
  ) {
    normalized.original_conversation_name = candidate.original_conversation_name.trim();
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

export async function normalizeMentionMetadata(conversationId, conversationType, mentions) {
  if (mentions == null) {
    return [];
  }

  if (!Array.isArray(mentions)) {
    throw new Error('mentions must be an array');
  }

  if (mentions.length === 0) {
    return [];
  }

  if (conversationType !== 'group') {
    throw new Error('Mentions are only supported in group conversations');
  }

  if (mentions.length > 25) {
    throw new Error('Too many mentions in one message');
  }

  const orderedIds = [];
  const seenIds = new Set();

  for (const entry of mentions) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Invalid mention entry');
    }

    const userId = typeof entry.user_id === 'string' ? entry.user_id.trim() : '';
    if (!userId) {
      throw new Error('Each mention must include a user_id');
    }

    if (seenIds.has(userId)) {
      continue;
    }

    seenIds.add(userId);
    orderedIds.push(userId);
  }

  if (orderedIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT cm.user_id::text AS user_id, u.username
     FROM conversation_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = $1 AND cm.user_id = ANY($2::uuid[])`,
    [conversationId, orderedIds]
  );

  const usernamesById = new Map(result.rows.map((row) => [row.user_id, row.username]));
  if (usernamesById.size !== orderedIds.length) {
    throw new Error('One or more mentioned users are not members of this group');
  }

  return orderedIds.map((userId) => ({
    user_id: userId,
    username: usernamesById.get(userId),
  }));
}

export function serializeStoredMessageMetadata(value) {
  if (value == null) {
    return null;
  }

  if (Array.isArray(value) && value.length === 0) {
    return null;
  }

  return JSON.stringify(value);
}

export async function batchFetchReactions(conversationId, messageIds, currentUserId) {
  if (!messageIds || messageIds.length === 0) return {};

  const convUuid = cassandra.types.Uuid.fromString(conversationId);
  const userUuid = currentUserId ? cassandra.types.Uuid.fromString(currentUserId) : null;
  const reactions = {};

  messageIds.forEach((id) => {
    reactions[id] = {};
  });

  const chunkSize = 50;
  const chunks = [];
  for (let index = 0; index < messageIds.length; index += chunkSize) {
    chunks.push(messageIds.slice(index, index + chunkSize));
  }

  try {
    for (const chunk of chunks) {
      const messageUuids = chunk.map((id) => cassandra.types.TimeUuid.fromString(id));

      const [countsResult, meResult] = await Promise.all([
        scylla.execute(
          `SELECT message_id, emoji, count FROM reaction_counts
           WHERE conversation_id = ? AND message_id IN ?`,
          [convUuid, messageUuids],
          { prepare: true }
        ),
        userUuid
          ? scylla.execute(
              `SELECT message_id, emoji FROM user_reactions
               WHERE conversation_id = ? AND user_id = ? AND message_id IN ?`,
              [convUuid, userUuid, messageUuids],
              { prepare: true }
            )
          : { rows: [] },
      ]);

      const meSet = new Set();
      for (const row of meResult.rows) {
        meSet.add(`${row.message_id.toString()}:${row.emoji}`);
      }

      for (const row of countsResult.rows) {
        const messageId = row.message_id.toString();
        const emoji = row.emoji;
        const count = row.count.toNumber ? row.count.toNumber() : Number(row.count);

        if (count <= 0) continue;

        reactions[messageId][emoji] = {
          count,
          me: meSet.has(`${messageId}:${emoji}`),
        };
      }
    }
  } catch (err) {
    console.error(`[ScyllaDB] Failed to batch fetch reactions for conversation ${conversationId}:`, err);
    throw err;
  }

  return reactions;
}
