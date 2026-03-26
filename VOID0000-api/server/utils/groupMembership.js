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

export async function emitConversationUpdate(
  conversation,
  memberIds,
  currentKeyVersion,
  memberCount,
  memberRolesById = null,
) {
  memberIds.forEach((memberId) => {
    const payload = {
      conversation: {
        id: conversation.id,
        public_id: conversation.public_id ? String(conversation.public_id) : null,
        type: conversation.type,
        owner_id: conversation.owner_id || null,
        current_key_version: currentKeyVersion,
        member_count: memberCount,
        updated_at: new Date().toISOString(),
        ...(memberRolesById && memberRolesById[memberId]
          ? { role: memberRolesById[memberId] }
          : {}),
      },
    };

    sendLiveEventToUser(memberId, EVENTS.CONVERSATION_UPDATE, payload);
  });
}
