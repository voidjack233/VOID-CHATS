// src/Services/Chat/chatService.ts
import { fetchWithAuth } from '../Auth/authServiceApi';
import { keyManager } from '../Crypto/keyManager';
import { encryptMessage, decryptMessages } from '../Crypto/messageEncryption';
import { chatCryptoProtocolService } from '../Crypto/protocols/chatCryptoProtocolService';

const API_PREFIX = '/api/conversations';
const KEY_ROTATION_ENABLED = true;
const DEFAULT_MLS_MESSAGE_TYPE = 'mls_application';
const MLS_ROLLOUT_DATE_MS = Date.parse('2026-03-15T00:00:00.000Z');

// ============== Types ==============

export interface Conversation {
  id: string;
  public_id?: string | null;
  type: 'dm' | 'group' | 'channel';
  name: string | null;
  topic?: string | null;
  slowmode_seconds?: number;
  is_age_restricted?: boolean;
  owner_id: string | null;
  current_key_version?: number | null;
  icon_filename: string | null;
  icon_url?: string | null;
  parent_conversation_id?: string | null;
  parent_public_id?: string | null;
  category_id?: string | null;
  created_at: string;
  updated_at: string;
  role: string;
  last_read_message_id: string | null;
  dm_user_id?: string;
  dm_username: string | null;
  dm_display_name: string | null;
  dm_avatar_url: string | null;
  member_count: number;
  channels?: Conversation[];
  categories?: ConversationCategory[];
  default_channel_id?: string;
  default_channel_public_id?: string | null;
}

export interface Attachment {
  url: string;
  blurhash?: string;
}

/** Parse a raw attachment string (plain URL or JSON `{url,blurhash}`) */
export function parseAttachment(raw: string): Attachment {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.url === 'string') return parsed as Attachment;
  } catch {}
  return { url: raw };
}

export function parseAttachments(raws?: string[]): Attachment[] {
  return (raws || []).map(parseAttachment);
}

export type MessageCryptoProtocol = 'legacy_aes' | 'mls';

export interface Message {
  conversation_id: string;
  conversation_public_id?: string | null;
  message_id: string;
  sender_id: string;
  encrypted_content: string | null;
  iv: string | null;
  key_version: number;
  message_type: string;
  reply_to: string | null;
  attachments?: string[];
  is_edited: boolean;
  edited_at: string | null;
  is_deleted: boolean;
  created_at: string;
  content?: string;
  reactions?: ReactionMap;
  protocol?: MessageCryptoProtocol | null;
  protocol_version?: number | null;
  local_status?: 'sending' | 'sent' | 'failed';
  local_client_id?: string;
}

export interface KeyBackupRecord {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
  created_at?: string;
  recovery_encrypted_private_key?: string | null;
  recovery_iv?: string | null;
  recovery_salt?: string | null;
  recovery_key_id?: string | null;
  recovery_configured_at?: string | null;
  mls_state_encrypted?: string | null;
  mls_state_iv?: string | null;
  mls_state_salt?: string | null;
}

export interface MessageDecryptionContext {
  conversation?: Conversation;
  userId?: string;
  currentKeyVersion?: number;
}

export interface ConversationMember {
  user_id: string;
  role: string;
  nickname: string | null;
  joined_at: string;
  joined_key_version?: number | null;
  history_start_version?: number | null;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_id: string;
}

export interface ConversationInviteLink {
  id: number;
  code: string;
  url: string;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  is_revoked: boolean;
  created_at: string;
}

export interface ConversationJoinRequest {
  id: number;
  status: string;
  created_at: string;
  invite_link_id: number | null;
  requester_user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_id: string;
}

export interface InvitePreview {
  id: number;
  code: string;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  created_at: string;
  conversation_id: string;
  conversation_public_id?: string | null;
  conversation_name: string | null;
  conversation_icon_url?: string | null;
  owner_id: string | null;
  owner_display_name: string | null;
  owner_username: string | null;
  owner_avatar_url: string | null;
  member_count: number;
}

export interface ConversationCategory {
  id: string;
  group_conversation_id: string;
  name: string;
  position: number;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

function createApiError(data: any): Error & Record<string, any> {
  const message =
    (typeof data?.error === 'string' && data.error.trim()) ||
    (typeof data?.message === 'string' && data.message.trim()) ||
    (typeof data?.code === 'string' && data.code.trim()) ||
    'Request failed';
  const error = new Error(message) as Error & Record<string, any>;
  if (data && typeof data === 'object') {
    Object.assign(error, data);
  }
  return error;
}

function normalizeKeyVersion(value: unknown, fallback = 1): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}

function ensureKeyRotationEnabled() {
  if (!KEY_ROTATION_ENABLED) {
    throw new Error('Membership updates are temporarily paused while encrypted key delivery is stabilized.');
  }
}

function normalizeMessageProtocol(value: unknown): MessageCryptoProtocol | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'mls') return 'mls';
  if (normalized === 'legacy_aes' || normalized === 'legacy' || normalized === 'aes' || normalized === 'aes_gcm') {
    return 'legacy_aes';
  }
  return null;
}

function normalizeProtocolVersion(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function inferMessageProtocol(
  messageType: string | null | undefined,
  createdAt?: string | null
): MessageCryptoProtocol | null {
  const normalizedType = typeof messageType === 'string'
    ? messageType.trim().toLowerCase()
    : '';

  if (normalizedType === 'mls_application') {
    return 'mls';
  }

  if (chatCryptoProtocolService.isDmMessageType(messageType)) {
    return 'mls';
  }

  // Keep explicit historical message types on legacy classification.
  if (normalizedType === 'signal_text') {
    return 'legacy_aes';
  }

  // Only classify "text" as legacy when it predates MLS rollout.
  if (normalizedType === 'text' && createdAt) {
    const createdAtMs = Date.parse(createdAt);
    if (Number.isFinite(createdAtMs) && createdAtMs < MLS_ROLLOUT_DATE_MS) {
      return 'legacy_aes';
    }
  }

  // MLS is now the default protocol for all other message types.
  return 'mls';
}

export function resolveMessageCryptoMetadata(message: {
  message_type?: string | null;
  created_at?: string | null;
  iv?: string | null;
  protocol?: unknown;
  protocol_version?: unknown;
}): { protocol: MessageCryptoProtocol | null; protocol_version: number | null } {
  const explicitProtocol = normalizeMessageProtocol(message.protocol);
  const protocol = explicitProtocol || inferMessageProtocol(message.message_type, message.created_at);
  const explicitVersion = normalizeProtocolVersion(message.protocol_version);

  if (explicitVersion != null) {
    return { protocol, protocol_version: explicitVersion };
  }

  if (protocol === 'mls') {
    return { protocol, protocol_version: chatCryptoProtocolService.protocolVersion };
  }

  if (protocol === 'legacy_aes') {
    return { protocol, protocol_version: 1 };
  }

  return { protocol, protocol_version: null };
}

type VersionedDecryptableMessage = {
  encrypted_content: string | null;
  iv: string | null;
  is_deleted: boolean;
  key_version?: number;
  [key: string]: any;
};

function createMessageKeyResolver(
  fallbackKey: CryptoKey,
  context?: MessageDecryptionContext
) {
  if (!context?.conversation || !context.userId) {
    return null;
  }

  const versionCache = new Map<number, Promise<CryptoKey>>();
  const currentVersion = normalizeKeyVersion(context.currentKeyVersion, 1);
  versionCache.set(currentVersion, Promise.resolve(fallbackKey));

  return async (message: VersionedDecryptableMessage) => {
    const targetVersion = normalizeKeyVersion(message.key_version, currentVersion);

    if (!versionCache.has(targetVersion)) {
      versionCache.set(
        targetVersion,
        getEncryptionKey(
          context.userId as string,
          context.conversation as Conversation,
          targetVersion
        ).then(({ key }) => key)
      );
    }

    return versionCache.get(targetVersion) as Promise<CryptoKey>;
  };
}

// ============== Conversations ==============

export async function getConversations(): Promise<Conversation[]> {
  const res = await fetchWithAuth(API_PREFIX);
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.conversations;
}

export async function getConversation(id: string): Promise<{
  conversation: Conversation & { members: ConversationMember[] };
}> {
  const res = await fetchWithAuth(`${API_PREFIX}/${id}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function createConversation(
  type: 'group' | 'channel',
  name: string,
  members: string[],
  parentConversationId?: string,
  categoryId?: string | null
): Promise<{ conversation: Conversation }> {
  const res = await fetchWithAuth(API_PREFIX, {
    method: 'POST',
    body: JSON.stringify({
      type,
      name,
      members,
      parent_conversation_id: parentConversationId || null,
      category_id: categoryId || null,
    }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function updateConversation(
  id: string,
  updates: {
    name?: string;
    topic?: string | null;
    slowmode_seconds?: number;
    is_age_restricted?: boolean;
  }
): Promise<{ conversation: Conversation }> {
  const res = await fetchWithAuth(`${API_PREFIX}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function uploadConversationIcon(
  id: string,
  icon: string
): Promise<{ conversation: Conversation }> {
  const res = await fetchWithAuth(`${API_PREFIX}/${id}/icon`, {
    method: 'PUT',
    body: JSON.stringify({ icon }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function removeConversationIcon(
  id: string
): Promise<{ conversation: Conversation }> {
  const res = await fetchWithAuth(`${API_PREFIX}/${id}/icon`, {
    method: 'DELETE',
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetchWithAuth(`${API_PREFIX}/${id}`, { method: 'DELETE' });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
}

export async function getConversationCategories(
  conversationId: string
): Promise<ConversationCategory[]> {
  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/categories`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.categories;
}

export async function createConversationCategory(
  conversationId: string,
  name: string
): Promise<{ category: ConversationCategory }> {
  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/categories`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

// ============== DMs ==============

export async function getOrCreateDM(userId: string): Promise<{
  conversation_id: string;
  conversation_public_id?: string | null;
  created: boolean;
}> {
  const res = await fetchWithAuth(`${API_PREFIX}/dm/${userId}`, {
    method: 'POST',
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

// ============== Members ==============

export async function addMembers(
  conversationId: string,
  members: string[]
): Promise<{ added: string[] }> {
  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/members`, {
    method: 'POST',
    body: JSON.stringify({ members }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

async function distributeGroupSenderKeyWithProtocol(
  conversation: Conversation,
  currentUserId: string,
  participantIds: string[]
): Promise<{ key: CryptoKey; version: number }> {
  const uniqueParticipants = [...new Set([...participantIds, currentUserId].filter(Boolean))];
  const result = await chatCryptoProtocolService.distributeGroupKey({
    userId: currentUserId,
    conversation,
    memberUserIds: uniqueParticipants,
  });
  return { key: result.key, version: result.keyVersion };
}

/**
 * Owner self-heal: when the owner opens a group on a device that cannot
 * access the current sender key material,
 * generate a brand-new room key, distribute it to every member, and
 * return the usable key.  This lets the owner recover without any
 * manual intervention.
 */
export async function ownerSelfHealGroupKey(
  conversation: Conversation,
  currentUserId: string,
  memberIds: string[]
): Promise<{ key: CryptoKey; version: number }> {
  const keyConversationId = conversation.parent_conversation_id || conversation.id;

  const allParticipants = [...new Set([...memberIds, currentUserId])];
  const { key, version } = await distributeGroupSenderKeyWithProtocol(
    { ...conversation, id: keyConversationId },
    currentUserId,
    allParticipants
  );

  return { key, version };
}

/**
 * Bootstrap a DM conversation's MLS group from scratch.
 *
 * Called when `getEncryptionKey` fails for a fresh DM because no local group
 * state exists yet.  Creates the group with the sender as the initiator and
 * includes the peer if they have published key packages.  If the peer is
 * offline / has not published packages yet the group is created solo — the peer
 * joins automatically when both sides are online and `syncInbox` processes the
 * pending welcome.
 *
 * DMs always use key_version=1 on the backend.  MLS epoch-0 solo groups produce
 * keyVersion=0, so we normalise the stored version to 1 so that `getEncryptionKey`
 * (which always targets version 1 for DMs) can find the key immediately.
 */
export async function bootstrapDmKey(
  conversation: Conversation,
  currentUserId: string,
  peerUserId: string | undefined
): Promise<{ key: CryptoKey; version: number }> {
  const participantIds = peerUserId
    ? [currentUserId, peerUserId]
    : [currentUserId];

  const result = await distributeGroupSenderKeyWithProtocol(
    { ...conversation, id: conversation.id },
    currentUserId,
    participantIds
  );

  // MLS epoch-0 solo group → keyVersion=0, but the backend/protocol convention
  // for DMs is always version 1.  Alias the key so lookups succeed.
  if (result.version !== 1) {
    await keyManager.storeGroupKey(conversation.id, 1, result.key);
    return { key: result.key, version: 1 };
  }

  return result;
}

/**
 * Called in the background after the owner's handshake succeeds.
 * Re-distributes the current sender key to member devices via the
 * active crypto protocol so lagging devices can catch up.
 */
export async function ensureGroupKeyDistribution(
  conversation: Conversation,
  currentUserId: string,
  memberIds: string[]
): Promise<void> {
  const keyConversationId = conversation.parent_conversation_id || conversation.id;

  const allParticipants = [...new Set(memberIds)];
  if (allParticipants.length === 0) return;

  await distributeGroupSenderKeyWithProtocol(
    { ...conversation, id: keyConversationId },
    currentUserId,
    allParticipants
  );
}

export async function rotateAddMembers(
  conversation: Conversation,
  currentUserId: string,
  currentMemberIds: string[],
  newMemberIds: string[]
): Promise<{ added: string[]; key_version: number }> {
  ensureKeyRotationEnabled();
  const keyConversationId = conversation.parent_conversation_id || conversation.id;
  const additions = [...new Set(newMemberIds.filter((memberId) => memberId && memberId !== currentUserId))];

  if (additions.length === 0) {
    throw new Error('Select at least one member to add');
  }

  const finalMemberIds = [...new Set([...currentMemberIds, ...additions, currentUserId])];
  const nextKeyVersion = normalizeKeyVersion(conversation.current_key_version, 1) + 1;

  const res = await fetchWithAuth(`${API_PREFIX}/${keyConversationId}/members/rotate-add`, {
    method: 'POST',
    body: JSON.stringify({
      members: additions,
      new_key_version: nextKeyVersion,
    }),
  });
  const data = await res.json();
  if (!data.success) throw createApiError(data);
  const resolvedKeyVersion = data.key_version || nextKeyVersion;

  const { key: mlsKey } = await distributeGroupSenderKeyWithProtocol(
    { ...conversation, id: keyConversationId, current_key_version: resolvedKeyVersion },
    currentUserId,
    finalMemberIds
  );
  await keyManager.storeGroupKey(keyConversationId, resolvedKeyVersion, mlsKey);

  return {
    added: data.added || additions,
    key_version: resolvedKeyVersion,
  };
}

export async function rotateRemoveMember(
  conversation: Conversation,
  currentUserId: string,
  remainingMemberIds: string[],
  targetUserId: string
): Promise<{ key_version: number }> {
  ensureKeyRotationEnabled();
  const keyConversationId = conversation.parent_conversation_id || conversation.id;
  const survivors = [...new Set(remainingMemberIds.filter(Boolean))];

  if (!targetUserId) {
    throw new Error('targetUserId required');
  }

  if (survivors.length === 0) {
    throw new Error('At least one member must remain in the group');
  }

  const nextKeyVersion = normalizeKeyVersion(conversation.current_key_version, 1) + 1;

  const res = await fetchWithAuth(`${API_PREFIX}/${keyConversationId}/members/rotate-remove`, {
    method: 'POST',
    body: JSON.stringify({
      target_user_id: targetUserId,
      new_key_version: nextKeyVersion,
    }),
  });
  const data = await res.json();
  if (!data.success) throw createApiError(data);
  const resolvedKeyVersion = data.key_version || nextKeyVersion;

  const { key: mlsKey } = await distributeGroupSenderKeyWithProtocol(
    { ...conversation, id: keyConversationId, current_key_version: resolvedKeyVersion },
    currentUserId,
    survivors
  );

  if (survivors.includes(currentUserId) && targetUserId !== currentUserId) {
    await keyManager.storeGroupKey(keyConversationId, resolvedKeyVersion, mlsKey);
  }

  return { key_version: resolvedKeyVersion };
}

export async function approveConversationJoinRequest(
  conversation: Conversation,
  currentUserId: string,
  currentMemberIds: string[],
  requestId: number,
  requesterUserId: string
): Promise<{ approved_user_id: string; key_version: number }> {
  ensureKeyRotationEnabled();
  const keyConversationId = conversation.parent_conversation_id || conversation.id;
  const finalMemberIds = [...new Set([...currentMemberIds, requesterUserId, currentUserId])];
  const nextKeyVersion = normalizeKeyVersion(conversation.current_key_version, 1) + 1;

  const res = await fetchWithAuth(`${API_PREFIX}/${keyConversationId}/invites/requests/${requestId}/approve`, {
    method: 'POST',
    body: JSON.stringify({
      new_key_version: nextKeyVersion,
    }),
  });
  const data = await res.json();
  if (!data.success) throw createApiError(data);
  const resolvedKeyVersion = data.key_version || nextKeyVersion;

  const { key: mlsKey } = await distributeGroupSenderKeyWithProtocol(
    { ...conversation, id: keyConversationId, current_key_version: resolvedKeyVersion },
    currentUserId,
    finalMemberIds
  );
  await keyManager.storeGroupKey(keyConversationId, resolvedKeyVersion, mlsKey);

  return {
    approved_user_id: data.approved_user_id || requesterUserId,
    key_version: resolvedKeyVersion,
  };
}

export async function declineConversationJoinRequest(
  conversationId: string,
  requestId: number
): Promise<void> {
  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/invites/requests/${requestId}/decline`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!data.success) throw createApiError(data);
}

export async function removeMember(
  conversationId: string,
  userId: string
): Promise<void> {
  const res = await fetchWithAuth(
    `${API_PREFIX}/${conversationId}/members/${userId}`,
    { method: 'DELETE' }
  );
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
}

export async function updateMemberRole(
  conversationId: string,
  userId: string,
  role: string
): Promise<void> {
  const res = await fetchWithAuth(
    `${API_PREFIX}/${conversationId}/members/${userId}`,
    {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }
  );
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
}

// ============== Invites ==============

export async function getConversationInvites(
  conversationId: string
): Promise<{
  invites: ConversationInviteLink[];
  pending_requests: ConversationJoinRequest[];
}> {
  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/invites`);
  const data = await res.json();
  if (!data.success) throw createApiError(data);
  return {
    invites: data.invites || [],
    pending_requests: data.pending_requests || [],
  };
}

export async function createConversationInviteLink(
  conversationId: string,
  options?: { expires_in_days?: number; max_uses?: number | null }
): Promise<ConversationInviteLink> {
  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/invites`, {
    method: 'POST',
    body: JSON.stringify({
      expires_in_days: options?.expires_in_days ?? 7,
      max_uses: options?.max_uses ?? null,
    }),
  });
  const data = await res.json();
  if (!data.success) throw createApiError(data);
  return data.invite as ConversationInviteLink;
}

export async function revokeConversationInviteLink(
  conversationId: string,
  inviteId: number
): Promise<void> {
  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/invites/${inviteId}/revoke`, {
    method: 'POST',
  });
  const data = await res.json();
  if (!data.success) throw createApiError(data);
}

export async function getInvitePreview(code: string): Promise<InvitePreview> {
  const res = await fetchWithAuth(`${API_PREFIX}/invite-links/${code}`);
  const data = await res.json();
  if (!data.success) throw createApiError(data);
  return data.invite as InvitePreview;
}

export async function getInviteRequestStatus(
  code: string
): Promise<{
  status: 'none' | 'pending' | 'declined' | 'approved' | 'member';
  conversation_public_id?: string | null;
  created_at?: string | null;
  resolved_at?: string | null;
}> {
  const res = await fetchWithAuth(`${API_PREFIX}/invite-links/${code}/status`);
  const data = await res.json();
  if (!data.success) throw createApiError(data);
  return data;
}

export async function requestJoinByInviteCode(
  code: string
): Promise<{ status: 'pending'; request_id: number; created_at: string }> {
  const res = await fetchWithAuth(`${API_PREFIX}/invite-links/${code}/request`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!data.success) throw createApiError(data);
  return data;
}

// ============== Messages ==============

export async function sendMessage(
  conversationId: string,
  plaintext: string,
  encryptionKey: CryptoKey,
  options?: {
    reply_to?: string;
    key_version?: number;
    attachments?: string[];
    message_type?: string;
  }
): Promise<Message> {
  let { encrypted_content, iv } = await encryptMessage(plaintext, encryptionKey);
  let keyVersion = options?.key_version || 1;
  let messageType = options?.message_type || DEFAULT_MLS_MESSAGE_TYPE;
  const protocol: MessageCryptoProtocol = 'mls';
  const protocolVersion: number = chatCryptoProtocolService.protocolVersion;

  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      encrypted_content,
      iv,
      key_version: keyVersion,
      message_type: messageType,
      ...(protocol ? { protocol } : {}),
      ...(protocolVersion ? { protocol_version: protocolVersion } : {}),
      reply_to: options?.reply_to || null,
      attachments: options?.attachments || [],
    }),
  });

  const data = await res.json();
  if (!data.success) throw createApiError(data);

  const cryptoMetadata = resolveMessageCryptoMetadata({
    ...data.message,
    message_type: messageType,
    iv,
    protocol,
    protocol_version: protocolVersion,
  });

  return {
    ...data.message,
    content: plaintext,
    protocol: cryptoMetadata.protocol,
    protocol_version: cryptoMetadata.protocol_version,
  };
}

export async function sendImageOnlyMessage(
  conversationId: string,
  attachments: string[],
  options?: { reply_to?: string; key_version?: number; message_type?: string }
): Promise<Message> {
  const messageType = options?.message_type || DEFAULT_MLS_MESSAGE_TYPE;
  const protocol: MessageCryptoProtocol = 'mls';
  const protocolVersion: number = chatCryptoProtocolService.protocolVersion;

  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      attachments,
      key_version: options?.key_version || 1,
      message_type: messageType,
      protocol,
      protocol_version: protocolVersion,
      reply_to: options?.reply_to || null,
    }),
  });

  const data = await res.json();
  if (!data.success) throw createApiError(data);

  const cryptoMetadata = resolveMessageCryptoMetadata({
    ...data.message,
    message_type: messageType,
    protocol,
    protocol_version: protocolVersion,
  });
  return {
    ...data.message,
    attachments,
    protocol: cryptoMetadata.protocol,
    protocol_version: cryptoMetadata.protocol_version,
  };
}

export async function sendTypingStart(
  conversationId: string
): Promise<void> {
  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/messages/typing`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!data.success) throw createApiError(data);
}

export async function uploadAttachments(
  conversationId: string,
  files: Array<{ data: string }>
): Promise<{ urls: string[]; blurhashes: string[] }> {
  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/attachments`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  });

  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Upload failed');
  return {
    urls: data.urls as string[],
    blurhashes: (data.blurhashes || data.urls.map(() => '')) as string[],
  };
}

export async function getMessages(
  conversationId: string,
  encryptionKey: CryptoKey,
  options?: { before?: string; after?: string; limit?: number } & MessageDecryptionContext
): Promise<{ messages: Message[]; has_more: boolean }> {
  const params = new URLSearchParams();
  if (options?.before) params.set('before', options.before);
  if (options?.after) params.set('after', options.after);
  if (options?.limit) params.set('limit', options.limit.toString());

  const url = `${API_PREFIX}/${conversationId}/messages${params.toString() ? '?' + params.toString() : ''}`;
  const res = await fetchWithAuth(url, { cache: 'no-store' });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);

  const keyResolver = createMessageKeyResolver(encryptionKey, options);
  const sourceMessages = ((data.messages || []) as Message[]).map((message) => {
    const cryptoMetadata = resolveMessageCryptoMetadata(message);
    return {
      ...message,
      protocol: cryptoMetadata.protocol,
      protocol_version: cryptoMetadata.protocol_version,
    };
  });
  const decryptedByIndex: Array<Record<string, any> | null> = new Array(sourceMessages.length).fill(null);

  const decrypted = await decryptMessages(sourceMessages, keyResolver || encryptionKey);
  decrypted.forEach((message, index) => {
    decryptedByIndex[index] = message || null;
  });

  const messagesWithReactions = sourceMessages.map((message, index) => ({
    ...(decryptedByIndex[index] || message),
    reactions: sourceMessages[index]?.reactions || {},
  }));

  return { messages: messagesWithReactions as Message[], has_more: data.has_more };
}

export async function editMessage(
  conversationId: string,
  messageId: string,
  newPlaintext: string,
  encryptionKey: CryptoKey,
  keyVersion?: number,
  options?: {
    messageType?: string | null;
  }
): Promise<void> {
  let { encrypted_content, iv } = await encryptMessage(newPlaintext, encryptionKey);
  let payloadMessageType: string = options?.messageType || DEFAULT_MLS_MESSAGE_TYPE;
  const protocol: MessageCryptoProtocol = 'mls';
  const protocolVersion: number = chatCryptoProtocolService.protocolVersion;

  const res = await fetchWithAuth(
    `${API_PREFIX}/${conversationId}/messages/${messageId}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        encrypted_content,
        iv,
        key_version: keyVersion || 1,
        message_type: payloadMessageType,
        protocol,
        protocol_version: protocolVersion,
      }),
    }
  );

  const data = await res.json();
  if (!data.success) throw new Error(data.error);
}

export async function deleteMessage(
  conversationId: string,
  messageId: string
): Promise<void> {
  const res = await fetchWithAuth(
    `${API_PREFIX}/${conversationId}/messages/${messageId}`,
    { method: 'DELETE' }
  );
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
}

export async function markAsRead(
  conversationId: string,
  messageId: string
): Promise<void> {
  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/read`, {
    method: 'PUT',
    body: JSON.stringify({ message_id: messageId }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
}

// ============== Reactions ==============

export interface ReactionMap {
  [emoji: string]: string[] | { count: number; me: boolean };
}

/**
 * Toggle a reaction on a message
 */
export async function toggleReaction(
  conversationId: string,
  messageId: string,
  emoji: string
): Promise<{ action: 'add' | 'remove'; emoji: string; user_id: string }> {
  const res = await fetchWithAuth(
    `${API_PREFIX}/${conversationId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    { method: 'PUT' }
  );
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

// ============== Keys ==============

export async function uploadPublicKey(
  publicKey: string,
  keyId: string
): Promise<void> {
  const res = await fetchWithAuth(`${API_PREFIX}/keys`, {
    method: 'POST',
    body: JSON.stringify({ public_key: publicKey, key_id: keyId }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
}

// ============== Secure Group =============
export async function createSecureGroup(
  name: string,
  memberIds: string[],
  currentUserId: string
): Promise<{ conversation: Conversation }> {
  // 1. Create the basic group in Postgres
  const { conversation } = await createConversation('group', name, memberIds);

  // 2. Create MLS group, add members, and derive the epoch key.
  const allParticipants = [...new Set([...memberIds, currentUserId])];
  const { key: mlsKey, version } = await distributeGroupSenderKeyWithProtocol(
    { ...conversation, current_key_version: 1 },
    currentUserId,
    allParticipants
  );

  // 3. Save local copy for immediate use.
  await keyManager.storeGroupKey(conversation.id, version, mlsKey);

  return { conversation };
}

// ============== High-Level Helpers ==============

export async function getEncryptionKey(
  userId: string,
  conversation: Conversation,
  requestedKeyVersion?: number
): Promise<{ key: CryptoKey; version: number }> {
  // --- GROUP / DM LOGIC (MLS for all conversation types) ---
  const keyConversationId = conversation.parent_conversation_id || conversation.id;
  const hasRequestedVersion = Number.isInteger(requestedKeyVersion) && (requestedKeyVersion as number) > 0;
  const requestedVersion = hasRequestedVersion ? (requestedKeyVersion as number) : null;

  // Local-first for explicit version lookups.
  if (requestedVersion != null) {
    const cachedRequestedGroupKey = await keyManager.getGroupKey(keyConversationId, requestedVersion);
    if (cachedRequestedGroupKey) {
      return { key: cachedRequestedGroupKey, version: requestedVersion };
    }
  }

  const targetVersion: number = hasRequestedVersion
    ? (requestedKeyVersion as number)
    : normalizeKeyVersion(conversation.current_key_version, 1);

  const cachedGroupKey = await keyManager.getGroupKey(keyConversationId, targetVersion);
  if (cachedGroupKey) {
    return { key: cachedGroupKey, version: targetVersion };
  }

  // Protocol inbox updates may arrive asynchronously via fanout.
  // Force one sync attempt before failing key resolution.
  await chatCryptoProtocolService.syncInbox(userId);

  const syncedGroupKey = await keyManager.getGroupKey(keyConversationId, targetVersion);
  if (syncedGroupKey) {
    return { key: syncedGroupKey, version: targetVersion };
  }

  // Fallback: the MLS epoch may have drifted from the server's current_key_version.
  // Scan for any key stored under a different version for this conversation.
  const fallback = await keyManager.findAnyGroupKey(keyConversationId);
  if (fallback) {
    // Alias the found key under the target version so future lookups hit directly.
    await keyManager.storeGroupKey(keyConversationId, targetVersion, fallback.key);
    return { key: fallback.key, version: targetVersion };
  }

  throw new Error(`No group sender key available for version ${targetVersion}`);
}

export async function backupKeyToServer(data: {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
  mls_state_encrypted?: string;
  mls_state_iv?: string;
  mls_state_salt?: string;
}): Promise<void> {
  const res = await fetchWithAuth('/api/conversations/keys/backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to backup key');
}

export async function backupRecoveryKeyToServer(data: {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
}): Promise<void> {
  const res = await fetchWithAuth('/api/conversations/keys/backup/recovery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to backup recovery key');
}

export async function fetchKeyBackup(): Promise<KeyBackupRecord | null> {
  const res = await fetchWithAuth('/api/conversations/keys/backup');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to fetch key backup');
  const data = await res.json();
  return data.backup || null;
}

export async function getMessageById(
  conversationId: string,
  messageId: string,
  encryptionKey: CryptoKey,
  options?: MessageDecryptionContext
): Promise<Message | null> {
  try {
    const res = await fetchWithAuth(
      `${API_PREFIX}/${conversationId}/messages/${messageId}`
    );
    const data = await res.json();
    if (!data.success || !data.message) return null;
    const cryptoMetadata = resolveMessageCryptoMetadata(data.message);
    const normalizedMessage: Message = {
      ...data.message,
      protocol: cryptoMetadata.protocol,
      protocol_version: cryptoMetadata.protocol_version,
    };

    const keyResolver = createMessageKeyResolver(encryptionKey, options);
    const [decrypted] = await decryptMessages([normalizedMessage], keyResolver || encryptionKey);
    return {
      ...(decrypted as Message),
      protocol: cryptoMetadata.protocol,
      protocol_version: cryptoMetadata.protocol_version,
    } as Message;
  } catch (err) {
    console.error('Failed to fetch single message:', err);
    return null;
  }
}
