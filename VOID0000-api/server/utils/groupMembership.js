import { EVENTS } from '../gateway/index.js';
import { sendLiveEventToUser } from '../gateway/client.js';
import { findConversationByIdentifier } from './conversationIdentity.js';

export function normalizeKeyVersion(value, fallback = 1) {
  const parsed = parseInt(String(value ?? fallback), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function uniqueUserIds(values = []) {
  return [...new Set(
    values
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
  )];
}

export function normalizeDistributions(distributions) {
  if (!Array.isArray(distributions)) return [];

  return distributions
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      user_id: typeof entry.user_id === 'string' ? entry.user_id.trim() : '',
      encrypted_group_key: typeof entry.encrypted_group_key === 'string'
        ? entry.encrypted_group_key.trim()
        : '',
    }))
    .filter((entry) => entry.user_id && entry.encrypted_group_key);
}

export function hasExactDistributionSet(expectedUserIds, distributions) {
  if (expectedUserIds.length !== distributions.length) {
    return false;
  }

  const expected = new Set(expectedUserIds);
  const actual = new Set(distributions.map((entry) => entry.user_id));

  if (expected.size !== actual.size) {
    return false;
  }

  return expectedUserIds.every((userId) => actual.has(userId));
}

export async function getChildChannelIds(db, conversationId) {
  const result = await db.query(
    `SELECT id FROM conversations WHERE parent_conversation_id = $1`,
    [conversationId]
  );
  return result.rows.map((row) => row.id);
}

export async function resolveMembershipConversation(db, requestedConversationId) {
  const requestedConversation = await findConversationByIdentifier(requestedConversationId, db);
  if (!requestedConversation) {
    return null;
  }

  if (requestedConversation.type !== 'channel' || !requestedConversation.parent_conversation_id) {
    return requestedConversation;
  }

  const parentResult = await db.query(
    `SELECT id, public_id, type, owner_id, parent_conversation_id, current_key_version
     FROM conversations
     WHERE id = $1
     LIMIT 1`,
    [requestedConversation.parent_conversation_id]
  );

  return parentResult.rows[0] || null;
}

export async function getGroupMembership(db, conversationId, userId) {
  const result = await db.query(
    `SELECT role
     FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId]
  );

  return result.rows[0] || null;
}

export async function validateFriendships(db, requesterId, memberIds) {
  for (const memberId of memberIds) {
    const friendCheck = await db.query(
      `SELECT id FROM friendships
       WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
         AND status = 'accepted'
       LIMIT 1`,
      [requesterId, memberId]
    );

    if (friendCheck.rows.length === 0) {
      return memberId;
    }
  }

  return null;
}

export async function insertGroupKeyDistributions(db, conversationId, distributions, keyVersion, wrappedByUserId) {
  for (const distribution of distributions) {
    await db.query(
      `INSERT INTO group_key_distribution (
         conversation_id,
         user_id,
         encrypted_group_key,
         key_version,
         wrapped_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (conversation_id, user_id, key_version)
       DO UPDATE SET
         encrypted_group_key = EXCLUDED.encrypted_group_key,
         wrapped_by_user_id = EXCLUDED.wrapped_by_user_id`,
      [conversationId, distribution.user_id, distribution.encrypted_group_key, keyVersion, wrappedByUserId]
    );
  }
}

export async function emitConversationUpdate(conversation, memberIds, currentKeyVersion, memberCount) {
  const payload = {
    conversation: {
      id: conversation.id,
      public_id: conversation.public_id ? String(conversation.public_id) : null,
      type: conversation.type,
      owner_id: conversation.owner_id || null,
      current_key_version: currentKeyVersion,
      member_count: memberCount,
      updated_at: new Date().toISOString(),
    },
  };

  memberIds.forEach((memberId) => {
    sendLiveEventToUser(memberId, EVENTS.CONVERSATION_UPDATE, payload);
  });
}
