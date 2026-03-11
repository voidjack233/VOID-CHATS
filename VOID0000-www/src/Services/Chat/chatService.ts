// src/Services/Chat/chatService.ts
import { fetchWithAuth } from '../Auth/authServiceApi';
import { keyManager } from '../Crypto/keyManager';
import { encryptMessage, decryptMessages } from '../Crypto/messageEncryption';

const API_PREFIX = '/api/conversations';

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
  icon_filename: string | null;
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

export interface ConversationMember {
  user_id: string;
  role: string;
  nickname: string | null;
  joined_at: string;
  username: string;
  display_name: string | null;
  avatar_url: string;
  profile_id: string;
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
  const error = new Error(data?.error || 'Request failed') as Error & Record<string, any>;
  if (data && typeof data === 'object') {
    Object.assign(error, data);
  }
  return error;
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

// ============== Messages ==============

export async function sendMessage(
  conversationId: string,
  plaintext: string,
  encryptionKey: CryptoKey,
  options?: { reply_to?: string; key_version?: number; attachments?: string[] }
): Promise<Message> {
  const { encrypted_content, iv } = await encryptMessage(plaintext, encryptionKey);

  const res = await fetchWithAuth(`${API_PREFIX}/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      encrypted_content,
      iv,
      key_version: options?.key_version || 1,
      message_type: 'text',
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
  options?: { before?: string; after?: string; limit?: number }
): Promise<{ messages: Message[]; has_more: boolean }> {
  const params = new URLSearchParams();
  if (options?.before) params.set('before', options.before);
  if (options?.after) params.set('after', options.after);
  if (options?.limit) params.set('limit', options.limit.toString());

  const url = `${API_PREFIX}/${conversationId}/messages${params.toString() ? '?' + params.toString() : ''}`;
  const res = await fetchWithAuth(url, { cache: 'no-store' });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);

  const decrypted = await decryptMessages(data.messages, encryptionKey);

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
): Promise<Array<{ encrypted_group_key: string; key_version: number }>> {
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
  const distributions = [];

  for (const targetUserId of allParticipants) {
    try {
      const targetUserKeys = await getUserPublicKey(targetUserId);
      const sharedSecret = await keyManager.getSharedSecret(
        currentUserId, 
        targetUserId, 
        targetUserKeys.public_key
      );

      const { encrypted, iv } = await keyManager.encryptGroupKeyForUser(roomKey, sharedSecret);
      const combinedKeyData = `${iv}.${encrypted}`;

      distributions.push({
        user_id: targetUserId,
        encrypted_group_key: combinedKeyData
      });
    } catch (err) {
      console.error(`Failed to generate key for user ${targetUserId}:`, err);
    }
  }

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
  peerUserId?: string
): Promise<{ key: CryptoKey; version: number }> {
  // --- 1-ON-1 DM LOGIC ---
  if (conversation.type === 'dm' && peerUserId) {
    const peerKey = await getUserPublicKey(peerUserId);
    const sharedKey = await keyManager.getSharedSecret(userId, peerUserId, peerKey.public_key);
    return { key: sharedKey, version: 1 };
  }

  // --- GROUP CHAT LOGIC ---
  const keyConversationId = conversation.parent_conversation_id || conversation.id;
  const groupKeys = await getGroupKeys(keyConversationId);
  if (groupKeys.length === 0) {
    throw new Error('No group key available — wait for owner to distribute');
  }

  const latest = groupKeys[0]!;
  
  // 1. Check if we already unlocked it and saved it to IndexedDB
  const cachedGroupKey = await keyManager.getGroupKey(keyConversationId, latest.key_version);
  if (cachedGroupKey) {
    return { key: cachedGroupKey, version: latest.key_version };
  }

  // 2. If not, we need to unlock it using the shared secret with the group owner
  if (!conversation.owner_id) {
    throw new Error('Cannot decrypt group key without knowing the owner');
  }

  // We need the owner's public key to recreate the shared secret lock
  const ownerKeyData = await getUserPublicKey(conversation.owner_id);
  const sharedSecret = await keyManager.getSharedSecret(userId, conversation.owner_id, ownerKeyData.public_key);

  // Split our combined string back into IV and Encrypted Key
  const [iv, encryptedBase64] = latest.encrypted_group_key.split('.');
  
  if (!iv || !encryptedBase64) {
    throw new Error('Group key data is corrupted or missing IV');
  }

  // Unlock the Room Key
  const decryptedRoomKey = await keyManager.decryptGroupKey(encryptedBase64, iv, sharedSecret);

  // Save it to IndexedDB so we don't have to do this math again
  await keyManager.storeGroupKey(keyConversationId, latest.key_version, decryptedRoomKey);

  return { key: decryptedRoomKey, version: latest.key_version };
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

export async function fetchKeyBackup(): Promise<{
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
} | null> {
  const res = await fetchWithAuth('/api/conversations/keys/backup');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to fetch key backup');
  const data = await res.json();
  return data.backup || null;
}

export async function getMessageById(
  conversationId: string,
  messageId: string,
  encryptionKey: CryptoKey
): Promise<Message | null> {
  try {
    const res = await fetchWithAuth(
      `${API_PREFIX}/${conversationId}/messages/${messageId}`
    );
    const data = await res.json();
    if (!data.success || !data.message) return null;

    const [decrypted] = await decryptMessages([data.message], encryptionKey);
    return decrypted as Message;
  } catch (err) {
    console.error('Failed to fetch single message:', err);
    return null;
  }
}
