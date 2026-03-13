// src/Services/Chat/chatService.ts
import { fetchWithAuth } from '../Auth/authServiceApi';
import { keyManager } from '../Crypto/keyManager';
import { encryptMessage, decryptMessages } from '../Crypto/messageEncryption';

const API_PREFIX = '/api/conversations';
const KEY_ROTATION_ENABLED = true;

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
}

export interface MessageDecryptionContext {
  conversation?: Conversation;
  userId?: string;
  peerUserId?: string;
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

export interface GroupKeyDistribution {
  encrypted_group_key: string;
  key_version: number;
  wrapped_by_user_id?: string | null;
}

export interface GroupKeyDistributionPayload {
  user_id: string;
  encrypted_group_key: string;
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
  if (!context?.conversation || !context.userId || context.conversation.type === 'dm') {
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
          context.peerUserId,
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

async function createGroupKeyDistributions(
  participantIds: string[],
  currentUserId: string,
  roomKey: CryptoKey
): Promise<GroupKeyDistributionPayload[]> {
  const distributions: GroupKeyDistributionPayload[] = [];

  for (const targetUserId of [...new Set(participantIds)]) {
    const targetUserKeys = await getUserPublicKey(targetUserId);
    const sharedSecret = await keyManager.getSharedSecret(
      currentUserId,
      targetUserId,
      targetUserKeys.public_key
    );

    const { encrypted, iv } = await keyManager.encryptGroupKeyForUser(roomKey, sharedSecret);
    distributions.push({
      user_id: targetUserId,
      encrypted_group_key: `${iv}.${encrypted}`,
    });
  }

  return distributions;
}

/**
 * Best-effort key distribution — skips members whose public keys
 * are unavailable instead of throwing.  Used for background
 * owner-side redistribution only.
 */
async function createGroupKeyDistributionsBestEffort(
  participantIds: string[],
  currentUserId: string,
  roomKey: CryptoKey
): Promise<GroupKeyDistributionPayload[]> {
  const distributions: GroupKeyDistributionPayload[] = [];

  for (const targetUserId of [...new Set(participantIds)]) {
    try {
      const targetUserKeys = await getUserPublicKey(targetUserId);
      const sharedSecret = await keyManager.getSharedSecret(
        currentUserId,
        targetUserId,
        targetUserKeys.public_key
      );

      const { encrypted, iv } = await keyManager.encryptGroupKeyForUser(roomKey, sharedSecret);
      distributions.push({
        user_id: targetUserId,
        encrypted_group_key: `${iv}.${encrypted}`,
      });
    } catch {
      // Member's keys might not be available yet — skip silently
    }
  }

  return distributions;
}

/**
 * Called in the background after the owner's handshake succeeds.
 * Re-wraps the current group key for every member using fresh
 * shared secrets, ensuring that members whose identity keys changed
 * (or who were added without a distribution) can decrypt.
 *
 * This is idempotent — the server uses ON CONFLICT DO UPDATE.
 */
export async function ensureGroupKeyDistribution(
  conversation: Conversation,
  currentUserId: string,
  memberIds: string[]
): Promise<void> {
  if (conversation.owner_id !== currentUserId) return;

  const keyConversationId = conversation.parent_conversation_id || conversation.id;
  const currentVersion = normalizeKeyVersion(conversation.current_key_version, 1);

  const groupKey = await keyManager.getGroupKey(keyConversationId, currentVersion);
  if (!groupKey) return;

  const allParticipants = [...new Set(memberIds)];
  if (allParticipants.length === 0) return;

  const distributions = await createGroupKeyDistributionsBestEffort(
    allParticipants,
    currentUserId,
    groupKey
  );

  if (distributions.length > 0) {
    await distributeGroupKey(keyConversationId, distributions, currentVersion);
  }
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
  const roomKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const distributions = await createGroupKeyDistributions(finalMemberIds, currentUserId, roomKey);
  const res = await fetchWithAuth(`${API_PREFIX}/${keyConversationId}/members/rotate-add`, {
    method: 'POST',
    body: JSON.stringify({
      members: additions,
      new_key_version: nextKeyVersion,
      distributions,
    }),
  });
  const data = await res.json();
  if (!data.success) throw createApiError(data);

  await keyManager.storeGroupKey(keyConversationId, nextKeyVersion, roomKey);

  return {
    added: data.added || additions,
    key_version: data.key_version || nextKeyVersion,
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
  const roomKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const distributions = await createGroupKeyDistributions(survivors, currentUserId, roomKey);
  const res = await fetchWithAuth(`${API_PREFIX}/${keyConversationId}/members/rotate-remove`, {
    method: 'POST',
    body: JSON.stringify({
      target_user_id: targetUserId,
      new_key_version: nextKeyVersion,
      distributions,
    }),
  });
  const data = await res.json();
  if (!data.success) throw createApiError(data);

  if (survivors.includes(currentUserId) && targetUserId !== currentUserId) {
    await keyManager.storeGroupKey(keyConversationId, nextKeyVersion, roomKey);
  }

  return { key_version: data.key_version || nextKeyVersion };
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
  const roomKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const distributions = await createGroupKeyDistributions(finalMemberIds, currentUserId, roomKey);
  const res = await fetchWithAuth(`${API_PREFIX}/${keyConversationId}/invites/requests/${requestId}/approve`, {
    method: 'POST',
    body: JSON.stringify({
      new_key_version: nextKeyVersion,
      distributions,
    }),
  });
  const data = await res.json();
  if (!data.success) throw createApiError(data);

  await keyManager.storeGroupKey(keyConversationId, nextKeyVersion, roomKey);

  return {
    approved_user_id: data.approved_user_id || requesterUserId,
    key_version: data.key_version || nextKeyVersion,
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
  options?: { reply_to?: string; key_version?: number; attachments?: string[]; message_type?: string }
): Promise<Message> {
  const { encrypted_content, iv } = await encryptMessage(plaintext, encryptionKey);

  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      encrypted_content,
      iv,
      key_version: options?.key_version || 1,
      message_type: options?.message_type || 'text',
      reply_to: options?.reply_to || null,
      attachments: options?.attachments || [],
    }),
  });

  const data = await res.json();
  if (!data.success) throw createApiError(data);

  return { ...data.message, content: plaintext };
}

export async function sendImageOnlyMessage(
  conversationId: string,
  attachments: string[],
  options?: { reply_to?: string; key_version?: number }
): Promise<Message> {
  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      attachments,
      key_version: options?.key_version || 1,
      reply_to: options?.reply_to || null,
    }),
  });

  const data = await res.json();
  if (!data.success) throw createApiError(data);

  return { ...data.message, attachments };
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
  const decrypted = await decryptMessages(data.messages, keyResolver || encryptionKey);

  // Preserve reactions from server response onto decrypted messages
  const messagesWithReactions = decrypted.map((msg: any, i: number) => ({
    ...msg,
    reactions: data.messages[i]?.reactions || {},
  }));

  return { messages: messagesWithReactions as Message[], has_more: data.has_more };
}

export async function editMessage(
  conversationId: string,
  messageId: string,
  newPlaintext: string,
  encryptionKey: CryptoKey,
  keyVersion?: number
): Promise<void> {
  const { encrypted_content, iv } = await encryptMessage(newPlaintext, encryptionKey);

  const res = await fetchWithAuth(
    `${API_PREFIX}/${conversationId}/messages/${messageId}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        encrypted_content,
        iv,
        key_version: keyVersion || 1,
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

export async function getUserPublicKey(
  userId: string
): Promise<{ public_key: string; key_id: string }> {
  const res = await fetchWithAuth(`${API_PREFIX}/keys/${userId}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.key;
}

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

export async function getGroupKeys(
  conversationId: string
): Promise<GroupKeyDistribution[]> {
  const res = await fetchWithAuth(`${API_PREFIX}/keys/group/${conversationId}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.keys;
}

export async function distributeGroupKey(
  conversationId: string,
  distributions: Array<{ user_id: string; encrypted_group_key: string }>,
  keyVersion: number
): Promise<void> {
  const res = await fetchWithAuth(`${API_PREFIX}/keys/group/${conversationId}`, {
    method: 'POST',
    body: JSON.stringify({ distributions, key_version: keyVersion }),
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

  // 2. Generate a brand new Room Key (AES-256-GCM)
  const roomKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  // 3. Prepare to distribute it to everyone (including yourself!)
  const allParticipants = [...new Set([...memberIds, currentUserId])];
  const distributions = await createGroupKeyDistributions(allParticipants, currentUserId, roomKey);

  // 4. Send the locked boxes to the server
  if (distributions.length > 0) {
    await distributeGroupKey(conversation.id, distributions, 1);
  }

  // 5. Save your own copy to IndexedDB
  await keyManager.storeGroupKey(conversation.id, 1, roomKey);

  return { conversation };
}

// ============== High-Level Helpers ==============

export async function getEncryptionKey(
  userId: string,
  conversation: Conversation,
  peerUserId?: string,
  requestedKeyVersion?: number
): Promise<{ key: CryptoKey; version: number }> {
  // --- 1-ON-1 DM LOGIC ---
  if (conversation.type === 'dm' && peerUserId) {
    const peerKey = await getUserPublicKey(peerUserId);
    const sharedKey = await keyManager.getSharedSecret(userId, peerUserId, peerKey.public_key);
    return { key: sharedKey, version: 1 };
  }

  // --- GROUP CHAT LOGIC ---
  const keyConversationId = conversation.parent_conversation_id || conversation.id;
  const hasRequestedVersion = Number.isInteger(requestedKeyVersion) && (requestedKeyVersion as number) > 0;
  const requestedVersion = hasRequestedVersion ? (requestedKeyVersion as number) : null;

  // Local-first for explicit version lookups:
  // if we already unlocked this version before, do not fail just because
  // the server payload omits historical distributions.
  if (requestedVersion != null) {
    const cachedRequestedGroupKey = await keyManager.getGroupKey(keyConversationId, requestedVersion);
    if (cachedRequestedGroupKey) {
      return { key: cachedRequestedGroupKey, version: requestedVersion };
    }
  }

  const groupKeys = await getGroupKeys(keyConversationId);
  if (groupKeys.length === 0) {
    throw new Error('No group key available — wait for owner to distribute');
  }

  const sortedKeys = [...groupKeys].sort(
    (left, right) => normalizeKeyVersion(right.key_version, 0) - normalizeKeyVersion(left.key_version, 0)
  );
  const targetVersion: number = hasRequestedVersion
    ? (requestedKeyVersion as number)
    : normalizeKeyVersion(sortedKeys[0]?.key_version, 1);
  const candidateKeys = sortedKeys.filter(
    (entry) => normalizeKeyVersion(entry.key_version, 0) === targetVersion
  );

  if (candidateKeys.length === 0) {
    throw new Error(`Group key version ${targetVersion} is unavailable`);
  }

  // 1. Check if we already unlocked it and saved it to IndexedDB
  const cachedGroupKey = await keyManager.getGroupKey(keyConversationId, targetVersion);
  if (cachedGroupKey) {
    return { key: cachedGroupKey, version: targetVersion };
  }

  let lastError: Error | null = null;

  // 2. Try every candidate row for this version. This handles APIs that return
  // multiple distributions for a key version (one row per recipient).
  for (const candidate of candidateKeys) {
    const wrapperUserId = candidate.wrapped_by_user_id || conversation.owner_id;
    if (!wrapperUserId) {
      lastError = new Error('Cannot decrypt group key without wrapper metadata');
      continue;
    }

    const [iv, encryptedBase64] = candidate.encrypted_group_key.split('.');
    if (!iv || !encryptedBase64) {
      lastError = new Error('Group key data is corrupted or missing IV');
      continue;
    }

    // Attempt decryption twice: once with the cached shared secret, and
    // if that yields an OperationError (stale key material), clear the
    // cached shared secret and retry with a freshly derived one.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const wrapperKeyData = await getUserPublicKey(wrapperUserId);
        const sharedSecret = await keyManager.getSharedSecret(userId, wrapperUserId, wrapperKeyData.public_key);

        const decryptedRoomKey = await keyManager.decryptGroupKey(encryptedBase64, iv, sharedSecret);
        await keyManager.storeGroupKey(keyConversationId, targetVersion, decryptedRoomKey);

        return { key: decryptedRoomKey, version: targetVersion };
      } catch (err) {
        const isOperationError = err instanceof DOMException && err.name === 'OperationError';
        if (attempt === 0 && isOperationError) {
          // Shared secret cache might reference a stale peer public key —
          // evict it so the next iteration re-derives from the server.
          await keyManager.clearSharedSecret(userId, wrapperUserId);
          continue;
        }
        lastError = err instanceof Error ? err : new Error('Unknown group key decrypt error');
        break;
      }
    }
  }

  const details = lastError?.message ? `: ${lastError.message}` : '';
  throw new Error(`Group key version ${targetVersion} is not decryptable for this account${details}`);
}

export async function backupKeyToServer(data: {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
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

    const keyResolver = createMessageKeyResolver(encryptionKey, options);
    const [decrypted] = await decryptMessages([data.message], keyResolver || encryptionKey);
    return decrypted as Message;
  } catch (err) {
    console.error('Failed to fetch single message:', err);
    return null;
  }
}
