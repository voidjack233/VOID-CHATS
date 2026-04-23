import { fetchWithAuth } from '../Auth/authServiceApi';
import { decryptMessages, encryptMessage } from '../Crypto/messageEncryption';
import { encryptAttachmentFile } from '../Crypto/attachmentEncryption';
import { chatCryptoProtocolService } from '../Crypto/protocols/chatCryptoProtocolService';
import {
  createMessageKeyResolver,
  getEncryptionKey,
  resolveMessageCryptoMetadata,
} from './chatCryptoService';
import {
  applyEncryptedMessageEnvelope,
  buildEncryptedMessagePayload,
} from './messageEnvelope';
import {
  serializeAttachment,
} from './messageAttachments';
import type {
  Conversation,
  ForwardedMessageMetadata,
  Message,
  MessageCryptoProtocol,
  MessageDecryptionContext,
} from './chatTypes';
import {
  CHAT_API_PREFIX,
  CHAT_DEFAULT_MLS_MESSAGE_TYPE,
  createApiError,
} from './chatUtils';
import { bootstrapDmKey } from './conversationService';

export { parseAttachment, parseAttachments } from './messageAttachments';

export async function sendMessage(
  conversationId: string,
  plaintext: string,
  encryptionKey: CryptoKey,
  options?: {
    reply_to?: string;
    key_version?: number;
    attachments?: string[];
    secure_attachments?: string[];
    message_type?: string;
    forwarded?: ForwardedMessageMetadata | null;
  },
): Promise<Message> {
  const payload = buildEncryptedMessagePayload(
    plaintext,
    options?.secure_attachments,
    { forwarded: options?.forwarded },
  );
  const { encrypted_content, iv } = await encryptMessage(payload, encryptionKey);
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
    attachments: options?.secure_attachments || data.message.attachments,
    forwarded: options?.forwarded || undefined,
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
  encryptionKey: CryptoKey,
  secureAttachments: string[],
  options?: {
    reply_to?: string;
    key_version?: number;
    message_type?: string;
    forwarded?: ForwardedMessageMetadata | null;
  },
): Promise<Message> {
  const payload = buildEncryptedMessagePayload('', secureAttachments, {
    forwarded: options?.forwarded,
  });
  const { encrypted_content, iv } = await encryptMessage(payload, encryptionKey);
  const messageType = options?.message_type || CHAT_DEFAULT_MLS_MESSAGE_TYPE;
  const protocol: MessageCryptoProtocol = 'mls';
  const protocolVersion = chatCryptoProtocolService.protocolVersion;

  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      encrypted_content,
      iv,
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
    attachments: secureAttachments,
    forwarded: options?.forwarded || undefined,
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

export async function uploadEncryptedAttachments(
  conversationId: string,
  files: File[],
): Promise<string[]> {
  const prepared = await Promise.all(files.map((file) => encryptAttachmentFile(file)));
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/attachments`, {
    method: 'POST',
    body: JSON.stringify({
      files: prepared.map(({ encryptedData }) => ({
        data: encryptedData,
        encrypted: true,
      })),
    }),
  });

  const data = await response.json();
  if (!data.success) throw new Error(data.error || 'Upload failed');

  const urls = Array.isArray(data.urls) ? (data.urls as string[]) : [];
  if (urls.length !== prepared.length) {
    throw new Error('Encrypted upload response was incomplete');
  }

  return urls.map((url, index) =>
    serializeAttachment({
      ...prepared[index]!.attachment,
      url,
    }),
  );
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

  const messagesWithReactions = sourceMessages.map((message, index) =>
    applyEncryptedMessageEnvelope({
      ...(decryptedByIndex[index] || message),
      reactions: sourceMessages[index]?.reactions || {},
    } as Message)
  );

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
    secureAttachments?: string[];
    forwarded?: ForwardedMessageMetadata | null;
  },
): Promise<void> {
  const payload = buildEncryptedMessagePayload(newPlaintext, options?.secureAttachments, {
    forwarded: options?.forwarded,
  });
  const { encrypted_content, iv } = await encryptMessage(payload, encryptionKey);
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

async function resolveForwardSendCrypto(
  conversation: Conversation,
  currentUserId: string,
): Promise<{ key: CryptoKey; version: number }> {
  if (conversation.type === 'dm') {
    try {
      return await getEncryptionKey(currentUserId, conversation);
    } catch {
      if (!conversation.dm_user_id) {
        throw new Error('This DM is still missing the secure recipient details needed to forward.');
      }

      return bootstrapDmKey(conversation, currentUserId, conversation.dm_user_id);
    }
  }

  return getEncryptionKey(
    currentUserId,
    conversation,
    conversation.current_key_version ?? undefined,
    { allowNewerGroupVersion: true },
  );
}

export async function forwardMessageToConversation(
  targetConversation: Conversation,
  sourceMessage: Pick<
    Message,
    'message_id' | 'sender_id' | 'content' | 'attachments' | 'created_at' | 'message_type'
  >,
  options: {
    currentUserId: string;
    forwarded: ForwardedMessageMetadata;
  },
): Promise<Message> {
  const plaintext = typeof sourceMessage.content === 'string' ? sourceMessage.content.trim() : '';
  const secureAttachments = sourceMessage.attachments || [];

  if (!plaintext && secureAttachments.length === 0) {
    throw new Error('Only messages with text or attachments can be forwarded right now.');
  }

  const sendCrypto = await resolveForwardSendCrypto(targetConversation, options.currentUserId);

  if (plaintext) {
    return sendMessage(targetConversation.id, plaintext, sendCrypto.key, {
      key_version: sendCrypto.version,
      message_type: CHAT_DEFAULT_MLS_MESSAGE_TYPE,
      secure_attachments: secureAttachments,
      forwarded: options.forwarded,
    });
  }

  return sendImageOnlyMessage(targetConversation.id, sendCrypto.key, secureAttachments, {
    key_version: sendCrypto.version,
    message_type: CHAT_DEFAULT_MLS_MESSAGE_TYPE,
    forwarded: options.forwarded,
  });
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
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/read`, {
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

    return applyEncryptedMessageEnvelope({
      ...(decrypted as Message),
      protocol: cryptoMetadata.protocol,
      protocol_version: cryptoMetadata.protocol_version,
    } as Message);
  } catch (error) {
    console.error('Failed to fetch single message:', error);
    return null;
  }
}
