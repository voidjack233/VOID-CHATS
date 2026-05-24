import {
  resolveMessageCryptoMetadata,
  type Message,
} from '../../../Chat/chatService';
import { messageStore, type LocalMessage } from '../../../Chat/chatStore';
import {
  getPersistableMessageContent,
  hasReadableMessageContent,
  isTransientUndecryptableMessage,
} from '../../../Chat/messageDecryptionState';

function toUIMessage(local: LocalMessage): Message {
  return {
    conversation_id: local.conversation_id,
    message_id: local.message_id,
    sender_id: local.sender_id,
    encrypted_content: null,
    iv: null,
    key_version: local.key_version ?? 1,
    message_type: local.message_type,
    reply_to: local.reply_to,
    is_edited: local.is_edited,
    edited_at: local.edited_at,
    is_deleted: local.is_deleted,
    created_at: local.created_at,
    content: local.content ?? undefined,
    reactions: local.reactions || {},
    attachments: local.attachments,
    forwarded: local.forwarded ?? undefined,
    mentions: local.mentions ?? undefined,
    link_preview: local.link_preview ?? undefined,
    protocol: local.protocol ?? null,
    protocol_version: local.protocol_version ?? null,
  };
}

const compareByCreatedAtAsc = (
  a: { created_at: string; message_id: string },
  b: { created_at: string; message_id: string }
) => {
  const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  if (timeDiff !== 0) return timeDiff;
  return a.message_id.localeCompare(b.message_id);
};

const isPendingLocalMessage = (message: Message): boolean => (
  (message.local_status === 'sending' || message.local_status === 'queued') &&
  (
    Boolean(message.local_client_id) ||
    (typeof message.message_id === 'string' && message.message_id.startsWith('local-'))
  )
);

const sortMessages = (messages: Message[]) =>
  [...messages].sort((left, right) => {
    const leftPending = isPendingLocalMessage(left);
    const rightPending = isPendingLocalMessage(right);

    if (leftPending !== rightPending) {
      return leftPending ? 1 : -1;
    }

    return compareByCreatedAtAsc(left, right);
  });

const sortLocalMessages = (messages: LocalMessage[]) =>
  [...messages].sort(compareByCreatedAtAsc);

const hasUndecryptableMessage = (
  messages: Array<{
    content?: string | null;
    decryption_failed?: boolean;
    is_deleted?: boolean;
    attachments?: string[] | null;
    message_type?: string | null;
    protocol?: string | null;
    encrypted_content?: string | null;
    iv?: string | null;
  }>
) => messages.some((message) => isTransientUndecryptableMessage(message));

const toLocalMessages = (messages: Message[]): LocalMessage[] =>
  messages.map((message) => {
    const cryptoMetadata = resolveMessageCryptoMetadata(message);
    return {
      conversation_id: message.conversation_id,
      message_id: message.message_id,
      sender_id: message.sender_id,
      content: getPersistableMessageContent(message),
      key_version: message.key_version ?? null,
      message_type: message.message_type,
      reply_to: message.reply_to,
      is_edited: message.is_edited,
      edited_at: message.edited_at,
      is_deleted: message.is_deleted,
      created_at: message.created_at,
      reactions: (message as any).reactions || {},
      attachments: message.attachments,
      forwarded: message.forwarded ?? undefined,
      mentions: message.mentions ?? undefined,
      link_preview: message.link_preview ?? undefined,
      protocol: cryptoMetadata.protocol,
      protocol_version: cryptoMetadata.protocol_version,
    };
  });

const preserveReadableLocalContent = async (messages: LocalMessage[]): Promise<LocalMessage[]> => {
  const staleIndexes = messages.reduce<number[]>((indexes, message, index) => {
    if (isTransientUndecryptableMessage(message)) {
      indexes.push(index);
    }
    return indexes;
  }, []);

  if (staleIndexes.length === 0) {
    return messages;
  }

  const existingMessages = await Promise.all(
    staleIndexes.map((index) => {
      const message = messages[index]!;
      return messageStore.getMessage(message.conversation_id, message.message_id);
    })
  );

  const nextMessages = [...messages];
  staleIndexes.forEach((staleIndex, lookupIndex) => {
    const existing = existingMessages[lookupIndex];
    if (existing && hasReadableMessageContent(existing)) {
      nextMessages[staleIndex] = {
        ...nextMessages[staleIndex]!,
        content: existing.content,
      };
    }
  });

  return nextMessages;
};

const persistFetchedMessagesSafely = async (messages: Message[]): Promise<LocalMessage[]> => {
  const localMessages = await preserveReadableLocalContent(toLocalMessages(messages));
  if (localMessages.length > 0) {
    await messageStore.putMessages(localMessages);
  }
  return localMessages;
};

const mergeLocalMessages = (...pages: LocalMessage[][]): LocalMessage[] => {
  const merged = new Map<string, LocalMessage>();

  pages.flat().forEach((message) => {
    const existing = merged.get(message.message_id);
    if (!existing) {
      merged.set(message.message_id, message);
      return;
    }

    merged.set(message.message_id, {
      ...existing,
      ...message,
      content: message.content ?? existing.content ?? null,
      attachments: message.attachments ?? existing.attachments,
      forwarded: message.forwarded ?? existing.forwarded,
      mentions: message.mentions ?? existing.mentions,
      link_preview: message.link_preview ?? existing.link_preview,
      reactions:
        Object.keys(message.reactions || {}).length > 0
          ? message.reactions
          : existing.reactions,
      key_version: message.key_version ?? existing.key_version ?? null,
      protocol: message.protocol ?? existing.protocol ?? null,
      protocol_version: message.protocol_version ?? existing.protocol_version ?? null,
    });
  });

  return sortLocalMessages(Array.from(merged.values()));
};

export {
  hasUndecryptableMessage,
  mergeLocalMessages,
  persistFetchedMessagesSafely,
  preserveReadableLocalContent,
  sortLocalMessages,
  sortMessages,
  toLocalMessages,
  toUIMessage,
};
