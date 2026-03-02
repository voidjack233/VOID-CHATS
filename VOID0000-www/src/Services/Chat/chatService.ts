// src/Services/Chat/chatService.ts
import { fetchWithAuth } from '../Auth/authServiceApi';
import { keyManager } from '../Crypto/keyManager';
import { encryptMessage, decryptMessages } from '../Crypto/messageEncryption';

const API_PREFIX = '/api/conversations';

// ============== Types ==============

export interface Conversation {
  id: string;
  type: 'dm' | 'group' | 'channel';
  name: string | null;
  owner_id: string | null;
  icon_filename: string | null;
  created_at: string;
  updated_at: string;
  role: string;
  last_read_message_id: string | null;
  dm_user_id?: string;
  dm_username: string | null;
  dm_display_name: string | null;
  dm_avatar_url: string | null;
  member_count: number;
}

export interface Message {
  conversation_id: string;
  message_id: string;
  sender_id: string;
  encrypted_content: string | null;
  iv: string | null;
  key_version: number;
  message_type: string;
  reply_to: string | null;
  is_edited: boolean;
  edited_at: string | null;
  is_deleted: boolean;
  created_at: string;
  content?: string; // decrypted plaintext (client-side only)
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
  members: string[]
): Promise<{ conversation: Conversation }> {
  const res = await fetchWithAuth(API_PREFIX, {
    method: 'POST',
    body: JSON.stringify({ type, name, members }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function updateConversation(
  id: string,
  updates: { name?: string }
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

// ============== DMs ==============

export async function getOrCreateDM(userId: string): Promise<{
  conversation_id: string;
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

/**
 * Send an encrypted message
 */
export async function sendMessage(
  conversationId: string,
  plaintext: string,
  encryptionKey: CryptoKey,
  options?: { reply_to?: string; key_version?: number }
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
    }),
  });

  const data = await res.json();
  if (!data.success) throw new Error(data.error);

  // Return with decrypted content for local display
  return { ...data.message, content: plaintext };
}

/**
 * Get message history (decrypted)
 */
export async function getMessages(
  conversationId: string,
  encryptionKey: CryptoKey,
  options?: { before?: string; limit?: number }
): Promise<{ messages: Message[]; has_more: boolean }> {
  const params = new URLSearchParams();
  if (options?.before) params.set('before', options.before);
  if (options?.limit) params.set('limit', options.limit.toString());

  const url = `${API_PREFIX}/${conversationId}/messages${params.toString() ? '?' + params.toString() : ''}`;
  const res = await fetchWithAuth(url);
  const data = await res.json();
  if (!data.success) throw new Error(data.error);

  // Decrypt all messages client-side
  const decrypted = await decryptMessages(data.messages, encryptionKey);

  return { messages: decrypted as Message[], has_more: data.has_more };
}

/**
 * Edit a message
 */
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

/**
 * Delete a message
 */
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

/**
 * Mark conversation as read
 */
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
  [emoji: string]: string[]; // emoji -> array of user_ids
}

/**
 * Toggle a reaction on a message (add if not present, remove if present)
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

/**
 * Get all reactions for a message
 */
export async function getReactions(
  conversationId: string,
  messageId: string
): Promise<ReactionMap> {
  const res = await fetchWithAuth(
    `${API_PREFIX}/${conversationId}/messages/${messageId}/reactions`
  );
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.reactions;
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

// ============== High-Level Helpers ==============

/**
 * Get the encryption key for a conversation
 * For DMs: derives shared secret from ECDH
 * For groups/channels: fetches distributed group key
 */
export async function getEncryptionKey(
  userId: string,
  conversation: Conversation,
  peerUserId?: string
): Promise<{ key: CryptoKey; version: number }> {
  if (conversation.type === 'dm' && peerUserId) {
    // DM: derive shared key from ECDH
    const peerKey = await getUserPublicKey(peerUserId);
    const sharedKey = await keyManager.getSharedSecret(userId, peerUserId, peerKey.public_key);
    return { key: sharedKey, version: 1 };
  }

  // Group/Channel: use distributed group key
  const groupKeys = await getGroupKeys(conversation.id);

  if (groupKeys.length === 0) {
    throw new Error('No group key available — owner must distribute keys');
  }

  const latest = groupKeys[0]!; // sorted DESC by key_version
  const groupKey = await keyManager.getGroupKey(conversation.id, latest.key_version);

  if (groupKey) {
    return { key: groupKey, version: latest.key_version };
  }

  // Need to decrypt the group key using our shared secret with the owner
  throw new Error('Group key decryption not yet implemented — needs owner shared secret');
}

// Backup encrypted private key to server
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

// Fetch encrypted private key backup from server
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

/**
 * Fetch a single message by ID (for reply previews of old messages)
 */
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

    // Decrypt the single message
    const [decrypted] = await decryptMessages([data.message], encryptionKey);
    return decrypted as Message;
  } catch (err) {
    console.error('Failed to fetch single message:', err);
    return null;
  }
}