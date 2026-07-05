import { fetchWithAuth } from '../Auth/authServiceApi';
import { decryptMessage, decryptMessages, encryptMessage } from '../Crypto/messageEncryption';
import { encryptAttachmentFile, resolveAttachmentBlob } from '../Crypto/attachmentEncryption';
import { keyManager } from '../Crypto/keyManager';
import { chatCryptoProtocolService } from '../Crypto/protocols/chatCryptoProtocolService';
import {
  createMessageKeyResolver,
  getEncryptionKey,
  resolveMessageCryptoMetadata,
  tryActivateDmDecryptHealer,
} from './chatCryptoService';
import {
  applyEncryptedMessageEnvelope,
  buildEncryptedLinkPreviewPayload,
  buildEncryptedMessagePayload,
  resolveDecryptedLinkPreviewPayload,
} from './messageEnvelope';
import {
  parseAttachment,
  serializeAttachment,
} from './messageAttachments';
import type {
  Conversation,
  ForwardedMessageMetadata,
  LinkPreviewMetadata,
  Message,
  MessageCryptoProtocol,
  MessageDecryptionContext,
  MessageMentionMetadata,
} from './chatTypes';
import {
  CHAT_API_PREFIX,
  CHAT_DEFAULT_MLS_MESSAGE_TYPE,
  CHAT_FORWARDED_MLS_MESSAGE_TYPE,
  createApiError,
  getRetryAfterMsFromResponse,
  getConversationKeyId,
  normalizeKeyVersion,
} from './chatUtils';
import { bootstrapDmKey } from './conversationService';
import { requestSelfLeaveRecoveryScan } from './selfLeaveRecoveryEvents';

export { parseAttachment, parseAttachments } from './messageAttachments';

const MESSAGE_SEND_TIMEOUT_MS = 30_000;
const ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_CODE = 'REQUEST_TIMEOUT';

function createRequestTimeoutError(label: string): Error {
  const error = new Error(`${label} timed out. Check your connection and retry.`);
  (error as Error & { code?: string }).code = REQUEST_TIMEOUT_CODE;
  return error;
}

async function withRequestTimeout<T>(
  timeoutMs: number,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(createRequestTimeoutError(label));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      operation(controller.signal),
      timeoutPromise,
    ]);
  } catch (error) {
    if (timedOut || (error as { name?: string } | null)?.name === 'AbortError') {
      throw createRequestTimeoutError(label);
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function sendMessage(
  conversationId: string,
  plaintext: string,
  encryptionKey: CryptoKey,
  options?: {
    client_message_id?: string;
    reply_to?: string;
    key_version?: number;
    attachments?: string[];
    secure_attachments?: string[];
    message_type?: string;
    forwarded?: ForwardedMessageMetadata | null;
    mentions?: MessageMentionMetadata[] | null;
    linkPreview?: LinkPreviewMetadata | null;
  },
): Promise<Message> {
  const payload = buildEncryptedMessagePayload(
    plaintext,
    options?.secure_attachments,
    {
      forwarded: options?.forwarded,
      mentions: options?.mentions,
      linkPreview: options?.linkPreview,
    },
  );
  const { encrypted_content, iv } = await encryptMessage(payload, encryptionKey);
  const keyVersion = options?.key_version || 1;
  const messageType = options?.message_type || CHAT_DEFAULT_MLS_MESSAGE_TYPE;
  const protocol: MessageCryptoProtocol = 'mls';
  const protocolVersion = chatCryptoProtocolService.protocolVersion;

  const { response, data } = await withRequestTimeout(MESSAGE_SEND_TIMEOUT_MS, 'Message send', async (signal) => {
    const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages`, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        encrypted_content,
        iv,
        key_version: keyVersion,
        message_type: messageType,
        protocol,
        protocol_version: protocolVersion,
        client_message_id: options?.client_message_id || null,
        reply_to: options?.reply_to || null,
        attachments: options?.attachments || [],
        forwarded: options?.forwarded || null,
        mentions: options?.mentions || [],
      }),
    });

    return {
      response,
      data: await response.json(),
    };
  });
  if (!response.ok || !data.success) {
    if (data?.code === 'MEMBERSHIP_ROTATION_PENDING') {
      requestSelfLeaveRecoveryScan('message_send_membership_pending');
    }
    throw createApiError(data, {
      status: response.status,
      statusCode: response.status,
      retryAfterMs: getRetryAfterMsFromResponse(response),
    });
  }

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
    mentions: options?.mentions || undefined,
    link_preview: options?.linkPreview || undefined,
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
    client_message_id?: string;
    reply_to?: string;
    key_version?: number;
    message_type?: string;
    forwarded?: ForwardedMessageMetadata | null;
    mentions?: MessageMentionMetadata[] | null;
    linkPreview?: LinkPreviewMetadata | null;
  },
): Promise<Message> {
  const payload = buildEncryptedMessagePayload('', secureAttachments, {
    forwarded: options?.forwarded,
    mentions: options?.mentions,
    linkPreview: options?.linkPreview,
  });
  const { encrypted_content, iv } = await encryptMessage(payload, encryptionKey);
  const messageType = options?.message_type || CHAT_DEFAULT_MLS_MESSAGE_TYPE;
  const protocol: MessageCryptoProtocol = 'mls';
  const protocolVersion = chatCryptoProtocolService.protocolVersion;

  const { response, data } = await withRequestTimeout(MESSAGE_SEND_TIMEOUT_MS, 'Message send', async (signal) => {
    const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages`, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        encrypted_content,
        iv,
        key_version: options?.key_version || 1,
        message_type: messageType,
        protocol,
        protocol_version: protocolVersion,
        client_message_id: options?.client_message_id || null,
        reply_to: options?.reply_to || null,
        forwarded: options?.forwarded || null,
        mentions: options?.mentions || [],
      }),
    });

    return {
      response,
      data: await response.json(),
    };
  });
  if (!response.ok || !data.success) {
    if (data?.code === 'MEMBERSHIP_ROTATION_PENDING') {
      requestSelfLeaveRecoveryScan('message_send_membership_pending');
    }
    throw createApiError(data, {
      status: response.status,
      statusCode: response.status,
      retryAfterMs: getRetryAfterMsFromResponse(response),
    });
  }

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
    mentions: options?.mentions || undefined,
    link_preview: options?.linkPreview || undefined,
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
  const { response, data } = await withRequestTimeout(ATTACHMENT_UPLOAD_TIMEOUT_MS, 'Attachment upload', async (signal) => {
    const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/attachments`, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        files: prepared.map(({ encryptedData }) => ({
          data: encryptedData,
          encrypted: true,
        })),
      }),
    });

    return {
      response,
      data: await response.json(),
    };
  });
  if (!response.ok || !data.success) {
    throw createApiError(data, {
      status: response.status,
      statusCode: response.status,
      retryAfterMs: getRetryAfterMsFromResponse(response),
    });
  }

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

type DecryptedMessage = Message & { content: string; decryption_failed?: boolean };

function isFailedEncryptedMessage(
  message: (Pick<Message, 'encrypted_content' | 'iv'> & { decryption_failed?: boolean }) | null | undefined,
): boolean {
  return Boolean(
    message?.decryption_failed === true &&
    message?.encrypted_content &&
    message?.iv,
  );
}

async function retryDmDecryptionAfterKeyRepair(
  sourceMessages: Message[],
  firstPass: DecryptedMessage[],
  fallbackKey: CryptoKey,
  context?: MessageDecryptionContext,
): Promise<DecryptedMessage[]> {
  if (context?.conversation?.type !== 'dm' || !context.userId) {
    return firstPass;
  }

  const failedVersions = sourceMessages.reduce<Set<number>>((versions, message, index) => {
    if (isFailedEncryptedMessage(firstPass[index])) {
      versions.add(normalizeKeyVersion(message.key_version, context.currentKeyVersion ?? 1));
    }
    return versions;
  }, new Set<number>());

  if (failedVersions.size === 0) {
    return firstPass;
  }

  const keyConversationId = getConversationKeyId(context.conversation);
  const healer = tryActivateDmDecryptHealer(keyConversationId);
  if (!healer.activated) {
    console.warn('[DM_DECRYPT_REPAIR] cooldown active; skipping repeated key deletion and sync retry', {
      conversation_id: keyConversationId,
      retry_after_ms: healer.retryAfterMs,
    });
    return firstPass;
  }

  await Promise.all(
    Array.from(failedVersions).map((version) =>
      keyManager.deleteGroupKey(keyConversationId, version).catch(() => {})
    )
  );

  console.warn('[DM_DECRYPT_REPAIR] retrying message decrypt after deleting stale group key versions', {
    conversation_id: keyConversationId,
    key_versions: Array.from(failedVersions),
  });

  const retryResolver = createMessageKeyResolver(fallbackKey, context);
  const retryPass = await decryptMessages(sourceMessages, retryResolver || fallbackKey) as DecryptedMessage[];

  return retryPass.map((message, index) => {
    const previous = firstPass[index];
    if (previous && !isFailedEncryptedMessage(previous)) {
      return previous;
    }
    return message;
  });
}

async function applyEncryptedLinkPreviewBlocks(
  messages: Message[],
  encryptionKey: CryptoKey,
  context?: MessageDecryptionContext,
): Promise<Message[]> {
  const keyResolver = createMessageKeyResolver(encryptionKey, context);

  return Promise.all(messages.map(async (message) => {
    if (
      message.is_deleted ||
      !message.encrypted_link_preview ||
      !message.link_preview_iv
    ) {
      return message;
    }

    const previewKeyVersion = normalizeKeyVersion(
      message.link_preview_key_version ?? message.key_version,
      message.key_version ?? context?.currentKeyVersion ?? 1,
    );
    const previewDecryptable: Message = {
      ...message,
      encrypted_content: message.encrypted_link_preview,
      iv: message.link_preview_iv,
      key_version: previewKeyVersion,
    };

    try {
      const key = keyResolver
        ? await keyResolver(previewDecryptable)
        : encryptionKey;
      const decryptedPreview = await decryptMessage(
        message.encrypted_link_preview,
        message.link_preview_iv,
        key,
      );
      const linkPreview = resolveDecryptedLinkPreviewPayload(decryptedPreview);
      if (!linkPreview) {
        return message;
      }

      return {
        ...message,
        link_preview: linkPreview,
      };
    } catch (error) {
      console.warn('[LINK_PREVIEW] failed to decrypt preview block', {
        message_id: message.message_id,
        key_version: previewKeyVersion,
        error: error instanceof Error ? error.message : String(error || ''),
      });
      return message;
    }
  }));
}

async function decryptFetchedMessages(
  rawMessages: Message[],
  encryptionKey: CryptoKey,
  context?: MessageDecryptionContext,
): Promise<Message[]> {
  const keyResolver = createMessageKeyResolver(encryptionKey, context);
  const sourceMessages = rawMessages.map((message) => {
    const cryptoMetadata = resolveMessageCryptoMetadata(message);
    return {
      ...message,
      protocol: cryptoMetadata.protocol,
      protocol_version: cryptoMetadata.protocol_version,
    };
  });

  const decryptedByIndex: Array<Partial<Message> | null> = new Array(sourceMessages.length).fill(null);
  const firstPass = await decryptMessages(sourceMessages, keyResolver || encryptionKey) as DecryptedMessage[];
  const decrypted = await retryDmDecryptionAfterKeyRepair(
    sourceMessages,
    firstPass,
    encryptionKey,
    context,
  );
  decrypted.forEach((message, index) => {
    decryptedByIndex[index] = message || null;
  });

  const messagesWithReactions = sourceMessages.map((message, index) =>
    applyEncryptedMessageEnvelope({
      ...(decryptedByIndex[index] || message),
      reactions: sourceMessages[index]?.reactions || {},
    } as Message)
  );

  return applyEncryptedLinkPreviewBlocks(
    messagesWithReactions as Message[],
    encryptionKey,
    context,
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
  if (!response.ok || !data.success) {
    throw createApiError(data, {
      status: response.status,
      statusCode: response.status,
      retryAfterMs: getRetryAfterMsFromResponse(response),
    });
  }

  const messagesWithPreviews = await decryptFetchedMessages(
    (data.messages || []) as Message[],
    encryptionKey,
    options,
  );

  return { messages: messagesWithPreviews, has_more: data.has_more };
}

export async function getMessageContext(
  conversationId: string,
  messageId: string,
  encryptionKey: CryptoKey,
  options?: { before?: number; after?: number } & MessageDecryptionContext,
): Promise<{ targetMessageId: string; messages: Message[]; hasOlder: boolean; hasNewer: boolean }> {
  const params = new URLSearchParams();
  if (typeof options?.before === 'number') params.set('before', options.before.toString());
  if (typeof options?.after === 'number') params.set('after', options.after.toString());

  const url = `${CHAT_API_PREFIX}/${conversationId}/messages/${messageId}/context${params.toString() ? `?${params.toString()}` : ''}`;
  const response = await fetchWithAuth(url, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw createApiError(data, {
      status: response.status,
      statusCode: response.status,
      retryAfterMs: getRetryAfterMsFromResponse(response),
    });
  }

  const messagesWithPreviews = await decryptFetchedMessages(
    (data.messages || []) as Message[],
    encryptionKey,
    options,
  );

  return {
    targetMessageId: String(data.target_message_id || messageId),
    messages: messagesWithPreviews,
    hasOlder: Boolean(data.has_older),
    hasNewer: Boolean(data.has_newer),
  };
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
    mentions?: MessageMentionMetadata[] | null;
    linkPreview?: LinkPreviewMetadata | null;
  },
): Promise<void> {
  const payload = buildEncryptedMessagePayload(newPlaintext, options?.secureAttachments, {
    forwarded: options?.forwarded,
    mentions: options?.mentions,
    linkPreview: options?.linkPreview,
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
      forwarded: options?.forwarded || null,
      mentions: options?.mentions || [],
    }),
  });

  const data = await response.json();
  if (!data.success) throw new Error(data.error);
}

export async function updateMessageLinkPreview(
  conversationId: string,
  messageId: string,
  preview: LinkPreviewMetadata,
  encryptionKey: CryptoKey,
  keyVersion: number,
): Promise<Pick<Message, 'link_preview' | 'encrypted_link_preview' | 'link_preview_iv' | 'link_preview_key_version'>> {
  const payload = buildEncryptedLinkPreviewPayload(preview);
  const { encrypted_content, iv } = await encryptMessage(payload, encryptionKey);

  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/messages/${messageId}/preview`, {
    method: 'PATCH',
    body: JSON.stringify({
      encrypted_link_preview: encrypted_content,
      iv,
      key_version: keyVersion,
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.success) {
    throw createApiError(data, {
      status: response.status,
      statusCode: response.status,
      retryAfterMs: getRetryAfterMsFromResponse(response),
    });
  }

  return {
    link_preview: preview,
    encrypted_link_preview: data.encrypted_link_preview ?? encrypted_content,
    link_preview_iv: data.link_preview_iv ?? iv,
    link_preview_key_version: data.link_preview_key_version ?? keyVersion,
  };
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

async function cloneAttachmentsForForward(
  targetConversationId: string,
  sourceAttachments: string[],
  sourceConversationId?: string | null,
): Promise<string[]> {
  const files = await Promise.all(
    sourceAttachments.map(async (rawAttachment, index) => {
      const attachment = parseAttachment(rawAttachment);
      const blob = await resolveAttachmentBlob(attachment, { conversationId: sourceConversationId });
      const fallbackName = `forwarded-attachment-${index + 1}`;
      const filename = attachment.name?.trim() || fallbackName;
      const mime = attachment.mime || blob.type || 'application/octet-stream';

      return new File([blob], filename, { type: mime });
    }),
  );

  return uploadEncryptedAttachments(targetConversationId, files);
}

export async function forwardMessageToConversation(
  targetConversation: Conversation,
  sourceMessage: Pick<
    Message,
    | 'conversation_id'
    | 'conversation_public_id'
    | 'message_id'
    | 'sender_id'
    | 'content'
    | 'attachments'
    | 'created_at'
    | 'message_type'
  >,
  options: {
    currentUserId: string;
    forwarded: ForwardedMessageMetadata;
  },
): Promise<Message> {
  const plaintext = typeof sourceMessage.content === 'string' ? sourceMessage.content.trim() : '';
  const sourceAttachments = sourceMessage.attachments || [];

  if (!plaintext && sourceAttachments.length === 0) {
    throw new Error('Only messages with text or attachments can be forwarded right now.');
  }

  const sendCrypto = await resolveForwardSendCrypto(targetConversation, options.currentUserId);
  const sourceConversationId = sourceMessage.conversation_public_id || sourceMessage.conversation_id;
  const isSameConversation = String(targetConversation.id) === String(sourceConversationId);
  const secureAttachments = sourceAttachments.length > 0 && !isSameConversation
    ? await cloneAttachmentsForForward(targetConversation.id, sourceAttachments, sourceConversationId)
    : sourceAttachments;

  if (plaintext) {
    return sendMessage(targetConversation.id, plaintext, sendCrypto.key, {
      key_version: sendCrypto.version,
      message_type: CHAT_FORWARDED_MLS_MESSAGE_TYPE,
      secure_attachments: secureAttachments,
      forwarded: options.forwarded,
    });
  }

  return sendImageOnlyMessage(targetConversation.id, sendCrypto.key, secureAttachments, {
    key_version: sendCrypto.version,
    message_type: CHAT_FORWARDED_MLS_MESSAGE_TYPE,
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

    const [messageWithPreview] = await applyEncryptedLinkPreviewBlocks([
      applyEncryptedMessageEnvelope({
      ...(decrypted as Message),
      protocol: cryptoMetadata.protocol,
      protocol_version: cryptoMetadata.protocol_version,
      } as Message),
    ], encryptionKey, options);

    return messageWithPreview || null;
  } catch (error) {
    console.error('Failed to fetch single message:', error);
    return null;
  }
}
