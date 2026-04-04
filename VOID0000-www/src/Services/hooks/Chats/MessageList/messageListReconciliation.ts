import { MESSAGE_WINDOW_TRIM_TARGET, MESSAGE_WINDOW_TRIM_TRIGGER } from '../../../Chat/chatConstants';
import type { Message } from '../../../Chat/chatService';

const getLocalClientId = (message: Pick<Message, 'message_id' | 'local_client_id'>): string | undefined => {
  if (message.local_client_id) return message.local_client_id;
  return typeof message.message_id === 'string' && message.message_id.startsWith('local-')
    ? message.message_id
    : undefined;
};

const isLocalOnlyMessage = (message: Pick<Message, 'message_id'>): boolean =>
  typeof message.message_id === 'string' && message.message_id.startsWith('local-');

const normalizeMessageContent = (content?: string | null) => {
  const trimmed = typeof content === 'string' ? content.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

const getAttachmentSignature = (message: Pick<Message, 'attachments'>) =>
  JSON.stringify(message.attachments || []);

const getReactionSignature = (message: Pick<Message, 'reactions'>) =>
  JSON.stringify(message.reactions || {});

const isEquivalentMessage = (
  existingMessage: Message,
  nextMessage: Message,
) => (
  String(existingMessage.conversation_id) === String(nextMessage.conversation_id) &&
  existingMessage.sender_id === nextMessage.sender_id &&
  existingMessage.encrypted_content === nextMessage.encrypted_content &&
  existingMessage.iv === nextMessage.iv &&
  existingMessage.key_version === nextMessage.key_version &&
  existingMessage.message_type === nextMessage.message_type &&
  (existingMessage.reply_to ?? null) === (nextMessage.reply_to ?? null) &&
  existingMessage.is_edited === nextMessage.is_edited &&
  (existingMessage.edited_at ?? null) === (nextMessage.edited_at ?? null) &&
  existingMessage.is_deleted === nextMessage.is_deleted &&
  existingMessage.created_at === nextMessage.created_at &&
  (existingMessage.content ?? null) === (nextMessage.content ?? null) &&
  (existingMessage.protocol ?? null) === (nextMessage.protocol ?? null) &&
  (existingMessage.protocol_version ?? null) === (nextMessage.protocol_version ?? null) &&
  (existingMessage.local_status ?? null) === (nextMessage.local_status ?? null) &&
  (existingMessage.local_client_id ?? null) === (nextMessage.local_client_id ?? null) &&
  getAttachmentSignature(existingMessage) === getAttachmentSignature(nextMessage) &&
  getReactionSignature(existingMessage) === getReactionSignature(nextMessage)
);

const findOptimisticReplacementId = (
  messages: Message[],
  incoming: Message,
  currentUserId?: string,
): string | undefined => {
  if (!currentUserId || incoming.sender_id !== currentUserId || incoming.local_status === 'sending') {
    return undefined;
  }

  const incomingReplyTo = incoming.reply_to ?? null;
  const incomingContent = normalizeMessageContent(incoming.content);
  const incomingAttachments = getAttachmentSignature(incoming);

  const pendingMatch = messages.find((message) => (
    message.local_status === 'sending' &&
    message.sender_id === incoming.sender_id &&
    String(message.conversation_id) === String(incoming.conversation_id) &&
    message.message_type === incoming.message_type &&
    (message.reply_to ?? null) === incomingReplyTo &&
    normalizeMessageContent(message.content) === incomingContent &&
    getAttachmentSignature(message) === incomingAttachments
  ));

  return pendingMatch ? (getLocalClientId(pendingMatch) || pendingMatch.message_id) : undefined;
};

interface TrimOptions {
  trigger?: number;
  target?: number;
}

interface TrimResult {
  messages: Message[];
  trimmedFromOld: number;
  trimmedFromNew: number;
}

interface MergeResult {
  messages: Message[];
  trimmedFromOld: number;
  trimmedFromNew: number;
}

const sortMessages = (messages: Message[]): Message[] =>
  [...messages].sort((left, right) => {
    const timeDiff = new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
    if (timeDiff !== 0) return timeDiff;
    return left.message_id.localeCompare(right.message_id);
  });

const trimMessages = (
  messages: Message[],
  trimFrom: 'old' | 'new',
  options: TrimOptions = {},
): TrimResult => {
  const trigger = options.trigger ?? MESSAGE_WINDOW_TRIM_TRIGGER;
  const target = options.target ?? MESSAGE_WINDOW_TRIM_TARGET;
  const sorted = sortMessages(messages);

  if (sorted.length <= trigger) {
    return { messages: sorted, trimmedFromOld: 0, trimmedFromNew: 0 };
  }

  const trimCount = sorted.length - target;

  if (trimFrom === 'old') {
    return { messages: sorted.slice(trimCount), trimmedFromOld: trimCount, trimmedFromNew: 0 };
  }

  return { messages: sorted.slice(0, target), trimmedFromOld: 0, trimmedFromNew: trimCount };
};

const mergeMessagesWithReconciliation = ({
  existing,
  incoming,
  currentUserId,
  trimFrom,
  allowOptimisticFallback = false,
}: {
  existing: Message[];
  incoming: Message[];
  currentUserId?: string;
  trimFrom: 'old' | 'new';
  allowOptimisticFallback?: boolean;
}): MergeResult => {
  const next = [...existing];
  let didChange = false;

  incoming.forEach((message) => {
    const existingIndex = next.findIndex((entry) => String(entry.message_id) === String(message.message_id));
    if (existingIndex >= 0) {
      const existingMessage = next[existingIndex]!;
      const mergedMessage: Message = {
        ...existingMessage,
        ...message,
        local_client_id: message.local_client_id ?? existingMessage.local_client_id,
        local_status: message.local_status ?? existingMessage.local_status,
      };
      if (!isEquivalentMessage(existingMessage, mergedMessage)) {
        next[existingIndex] = mergedMessage;
        didChange = true;
      }
      return;
    }

    const replacementId = getLocalClientId(message) || (
      allowOptimisticFallback
        ? findOptimisticReplacementId(next, message, currentUserId)
        : undefined
    );

    if (replacementId) {
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const candidate = next[index]!;
        if (
          String(candidate.message_id) === String(replacementId) ||
          getLocalClientId(candidate) === replacementId
        ) {
          next.splice(index, 1);
          didChange = true;
        }
      }
    }

    next.push(message);
    didChange = true;
  });

  if (!didChange) {
    return { messages: existing, trimmedFromOld: 0, trimmedFromNew: 0 };
  }

  return trimMessages(next, trimFrom);
};

const getNewestServerBackedMessage = (messages: Message[]): Message | undefined =>
  [...messages].reverse().find((message) => !isLocalOnlyMessage(message));

export {
  getLocalClientId,
  getNewestServerBackedMessage,
  isLocalOnlyMessage,
  mergeMessagesWithReconciliation,
  trimMessages,
};

export type { MergeResult, TrimResult };
