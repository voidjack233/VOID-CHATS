import type { Message } from './chatTypes';
import { messageStore, type LocalMessage } from './chatStore';
import { messageSync } from './chatSync';
import { resolveDecryptedMessagePayload } from './messageEnvelope';
import { normalizeMessageText } from './messageDecryptionState';
import { decryptMessage } from '../Crypto/messageEncryption';
import { keyManager } from '../Crypto/keyManager';

type PreviewSource = Pick<
  Message | LocalMessage,
  'sender_id' | 'content' | 'attachments' | 'is_deleted' | 'message_type'
>;

const cache = new Map<string, string | null>();
const listeners = new Set<() => void>();
const MAX_PREVIEW_LENGTH = 120;

type LiveMessageEvent = {
  conversation_id: string;
  conversation_public_id?: string | null;
  message_id: string;
  sender_id: string;
  encrypted_content?: string | null;
  iv?: string | null;
  key_version?: number | null;
  message_type?: string | null;
  reply_to?: string | null;
  attachments?: string[];
  is_edited?: boolean;
  edited_at?: string | null;
  is_deleted?: boolean;
  created_at?: string | null;
  content?: string | null;
  protocol?: 'legacy_aes' | 'mls' | null;
  protocol_version?: number | null;
};

function emitChange() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('[CONVERSATION_PREVIEW] listener failed', error);
    }
  });
}

function truncatePreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_PREVIEW_LENGTH) return compact;
  return `${compact.slice(0, MAX_PREVIEW_LENGTH - 1).trimEnd()}...`;
}

export function formatConversationPreview(
  message: PreviewSource | null | undefined,
  currentUserId?: string | null,
): string | null {
  if (!message) return null;

  if (message.is_deleted) {
    return 'Message deleted';
  }

  const attachmentCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
  const isSender = Boolean(currentUserId && message.sender_id === currentUserId);
  if (attachmentCount > 0) {
    if (isSender) {
      return attachmentCount > 1 ? `You sent ${attachmentCount} attachments` : 'You sent an attachment';
    }
    return attachmentCount > 1 ? `Sent ${attachmentCount} attachments` : 'Sent an attachment';
  }

  const content = normalizeMessageText(message.content);
  if (content) {
    const preview = truncatePreview(content);
    return isSender && message.message_type !== 'system'
      ? `You: ${preview}`
      : preview;
  }

  return null;
}

export function getConversationPreview(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  return cache.get(conversationId) ?? null;
}

export function setConversationPreview(
  conversationIds: Array<string | null | undefined> | string | null | undefined,
  preview: string | null,
): void {
  const ids = Array.isArray(conversationIds) ? conversationIds : [conversationIds];
  let changed = false;

  ids.forEach((id) => {
    if (!id) return;
    if ((cache.get(id) ?? null) === preview) return;
    cache.set(id, preview);
    changed = true;
  });

  if (changed) {
    emitChange();
  }
}

export function subscribeConversationPreviewCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function hydrateConversationPreviewFromStore(
  conversationId: string,
  currentUserId?: string | null,
): Promise<void> {
  const { messages } = await messageStore.getMessages(conversationId, { limit: 1 });
  const preview = formatConversationPreview(messages[0] || null, currentUserId);
  setConversationPreview(conversationId, preview);
}

export async function hydrateConversationPreviewsFromStore(
  conversationIds: string[],
  currentUserId?: string | null,
): Promise<void> {
  const uniqueIds = [...new Set(conversationIds.filter(Boolean))];
  await Promise.all(uniqueIds.map((conversationId) =>
    hydrateConversationPreviewFromStore(conversationId, currentUserId).catch((error) => {
      console.warn('[CONVERSATION_PREVIEW] failed to hydrate preview from store', {
        conversation_id: conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    })
  ));
}

async function resolveLiveMessageContent(message: LiveMessageEvent): Promise<{
  content: string | null;
  attachments?: string[];
  forwarded?: LocalMessage['forwarded'];
  mentions?: LocalMessage['mentions'];
}> {
  if (message.is_deleted) {
    return { content: '[deleted]', attachments: [] };
  }

  if (message.message_type === 'system' && !message.iv) {
    return {
      content: normalizeMessageText(message.content || message.encrypted_content) || 'System event',
      attachments: message.attachments,
      forwarded: (message as { forwarded?: LocalMessage['forwarded'] }).forwarded ?? undefined,
      mentions: (message as { mentions?: LocalMessage['mentions'] }).mentions ?? undefined,
    };
  }

  if (message.encrypted_content && message.iv) {
    const requestedVersion = Number.isInteger(message.key_version) && (message.key_version as number) > 0
      ? Number(message.key_version)
      : null;

    let key = requestedVersion
      ? await keyManager.getGroupKey(message.conversation_id, requestedVersion)
      : null;

    if (!key) {
      const fallback = await keyManager.findAnyGroupKey(message.conversation_id);
      key = fallback?.key || null;
    }

    if (key) {
      try {
        const decrypted = await decryptMessage(message.encrypted_content, message.iv, key);
        const resolved = resolveDecryptedMessagePayload(decrypted, message.attachments);
        return {
          content: normalizeMessageText(resolved.content) || null,
          attachments: resolved.attachments,
          forwarded: resolved.forwarded ?? undefined,
          mentions: resolved.mentions ?? undefined,
        };
      } catch {
        // Leave empty; this device does not currently have the right key material.
      }
    }
  }

  return {
    content: normalizeMessageText(message.content) || null,
    attachments: message.attachments,
    forwarded: (message as { forwarded?: LocalMessage['forwarded'] }).forwarded ?? undefined,
    mentions: (message as { mentions?: LocalMessage['mentions'] }).mentions ?? undefined,
  };
}

function toLocalMessage(
  message: LiveMessageEvent,
  resolved: {
    content: string | null;
    attachments?: string[];
    forwarded?: LocalMessage['forwarded'];
    mentions?: LocalMessage['mentions'];
  },
): LocalMessage {
  return {
    conversation_id: message.conversation_id,
    message_id: message.message_id,
    sender_id: message.sender_id,
    content: resolved.content,
    key_version: message.key_version ?? null,
    message_type: message.message_type || 'mls_application',
    reply_to: message.reply_to ?? null,
    is_edited: Boolean(message.is_edited),
    edited_at: message.edited_at ?? null,
    is_deleted: Boolean(message.is_deleted),
    created_at: message.created_at || new Date().toISOString(),
    reactions: {},
    attachments: resolved.attachments ?? message.attachments,
    forwarded: resolved.forwarded ?? (message as { forwarded?: LocalMessage['forwarded'] }).forwarded ?? undefined,
    mentions: resolved.mentions ?? (message as { mentions?: LocalMessage['mentions'] }).mentions ?? undefined,
    protocol: message.protocol ?? null,
    protocol_version: message.protocol_version ?? null,
  };
}

export async function applyLiveMessagePreview(
  message: LiveMessageEvent,
  currentUserId?: string | null,
): Promise<string | null> {
  const resolved = await resolveLiveMessageContent(message);
  const localMessage = toLocalMessage(message, resolved);
  await messageSync.storeIncomingMessage(localMessage);

  const preview = formatConversationPreview(
    {
      sender_id: message.sender_id,
      content: resolved.content,
      attachments: resolved.attachments,
      is_deleted: Boolean(message.is_deleted),
      message_type: message.message_type || 'mls_application',
    },
    currentUserId,
  );

  setConversationPreview([message.conversation_id, message.conversation_public_id], preview);
  return preview;
}

export async function applyLiveMessageEditPreview(
  message: LiveMessageEvent,
  currentUserId?: string | null,
): Promise<void> {
  const resolved = await resolveLiveMessageContent(message);
  if (resolved.content != null) {
    await messageSync.handleEdit(
      message.conversation_id,
      message.message_id,
      {
        content: resolved.content,
        edited_at: message.edited_at || new Date().toISOString(),
        message_type: message.message_type || 'mls_application',
        forwarded: (message as { forwarded?: LocalMessage['forwarded'] }).forwarded ?? undefined,
        mentions: (message as { mentions?: LocalMessage['mentions'] }).mentions ?? undefined,
        link_preview: (message as { link_preview?: LocalMessage['link_preview'] }).link_preview ?? undefined,
      },
    );
  }
  await hydrateConversationPreviewFromStore(message.conversation_id, currentUserId);
  if (message.conversation_public_id) {
    setConversationPreview(message.conversation_public_id, getConversationPreview(message.conversation_id));
  }
}

export async function applyLiveMessageDeletePreview(
  message: Pick<LiveMessageEvent, 'conversation_id' | 'conversation_public_id' | 'message_id'>,
  currentUserId?: string | null,
): Promise<void> {
  await messageSync.handleDelete(message.conversation_id, message.message_id);
  await hydrateConversationPreviewFromStore(message.conversation_id, currentUserId);
  if (message.conversation_public_id) {
    setConversationPreview(message.conversation_public_id, getConversationPreview(message.conversation_id));
  }
}
