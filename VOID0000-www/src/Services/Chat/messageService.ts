import { fetchWithAuth } from '../Auth/authServiceApi';
import { decryptMessages, encryptMessage } from '../Crypto/messageEncryption';
import { chatCryptoProtocolService } from '../Crypto/protocols/chatCryptoProtocolService';
import {
  createMessageKeyResolver,
  resolveMessageCryptoMetadata,
} from './chatCryptoService';
import type {
  Attachment,
  Message,
  MessageCryptoProtocol,
  MessageDecryptionContext,
} from './chatTypes';
import {
  CHAT_API_PREFIX,
  CHAT_DEFAULT_MLS_MESSAGE_TYPE,
  createApiError,
} from './chatUtils';

export function parseAttachment(raw: string): Attachment {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.url === 'string') return parsed as Attachment;
  } catch {
    // Fall back to the raw URL format.
  }

  return { url: raw };
}

export function parseAttachments(raws?: string[]): Attachment[] {
  return (raws || []).map(parseAttachment);
}

export async function sendMessage(
  conversationId: string,
  plaintext: string,
  encryptionKey: CryptoKey,
  options?: {
    reply_to?: string;
    key_version?: number;
    attachments?: string[];
    message_type?: string;
  },
): Promise<Message> {
  const { encrypted_content, iv } = await encryptMessage(plaintext, encryptionKey);
  const keyVersion = options?.key_version || 1;
  const messageType = options?.message_type || CHAT_DEFAULT_MLS_MESSAGE_TYPE;
  const protocol: MessageCryptoProtocol = 'mls';
  const protocolVersion = chatCryptoProtocolService.protocolVersion;

  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      encrypted_content,
      iv,
      key_version: keyVersion,
      message_type: messageType,
      protocol,
      protocol_version: protocolVersion,
      reply_to: options?.reply_to || null,
      attachments: options?.attachments || [],
    }),
  });

  const data = await response.json();
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

export async function sendSystemEvent(
  conversationId: string,
  content: string,
  keyVersion: number,
): Promise<Message> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      key_version: keyVersion,
      message_type: 'system',
    }),
  });

  const data = await response.json();
  if (!data.success) throw createApiError(data);

  return {
    ...data.message,
    content,
  };
}

export async function sendImageOnlyMessage(
  conversationId: string,
  attachments: string[],
  options?: { reply_to?: string; key_version?: number; message_type?: string },
): Promise<Message> {
  const messageType = options?.message_type || CHAT_DEFAULT_MLS_MESSAGE_TYPE;
  const protocol: MessageCryptoProtocol = 'mls';
  const protocolVersion = chatCryptoProtocolService.protocolVersion;

  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages`, {
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

  const data = await response.json();
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

export async function sendTypingStart(conversationId: string): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/typing`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const data = await response.json();
  if (!data.success) throw createApiError(data);
}

export async function uploadAttachments(
  conversationId: string,
  files: Array<{ data: string }>,
): Promise<{ urls: string[]; blurhashes: string[] }> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/attachments`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  });

  const data = await response.json();
  if (!data.success) throw new Error(data.error || 'Upload failed');

  return {
    urls: data.urls as string[],
    blurhashes: (data.blurhashes || data.urls.map(() => '')) as string[],
  };
}

export async function getMessages(
  conversationId: string,
  encryptionKey: CryptoKey,
  options?: { before?: string; after?: string; limit?: number } & MessageDecryptionContext,
): Promise<{ messages: Message[]; has_more: boolean }> {
  const params = new URLSearchParams();
  if (options?.before) params.set('before', options.before);
  if (options?.after) params.set('after', options.after);
  if (options?.limit) params.set('limit', options.limit.toString());

  const url = `${CHAT_API_PREFIX}/${conversationId}/messages${params.toString() ? `?${params.toString()}` : ''}`;
  const response = await fetchWithAuth(url, { cache: 'no-store' });
  const data = await response.json();
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
  },
): Promise<void> {
  const { encrypted_content, iv } = await encryptMessage(newPlaintext, encryptionKey);
  const payloadMessageType = options?.messageType || CHAT_DEFAULT_MLS_MESSAGE_TYPE;
  const protocol: MessageCryptoProtocol = 'mls';
  const protocolVersion = chatCryptoProtocolService.protocolVersion;

  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/${messageId}`, {
    method: 'PUT',
    body: JSON.stringify({
      encrypted_content,
      iv,
      key_version: keyVersion || 1,
      message_type: payloadMessageType,
      protocol,
      protocol_version: protocolVersion,
    }),
  });

  const data = await response.json();
  if (!data.success) throw new Error(data.error);
}

export async function deleteMessage(
  conversationId: string,
  messageId: string,
): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/${messageId}`, {
    method: 'DELETE',
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
}

export async function markAsRead(
  conversationId: string,
  messageId: string,
): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/read`, {
    method: 'PUT',
    body: JSON.stringify({ message_id: messageId }),
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
}

export async function toggleReaction(
  conversationId: string,
  messageId: string,
  emoji: string,
): Promise<{ action: 'add' | 'remove'; emoji: string; user_id: string }> {
  const response = await fetchWithAuth(
    `${CHAT_API_PREFIX}/${conversationId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    { method: 'PUT' },
  );
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function getMessageById(
  conversationId: string,
  messageId: string,
  encryptionKey: CryptoKey,
  options?: MessageDecryptionContext,
): Promise<Message | null> {
  try {
    const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/${messageId}`);
    const data = await response.json();
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
  } catch (error) {
    console.error('Failed to fetch single message:', error);
    return null;
  }
}
