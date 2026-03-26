import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { getMessageById, type Conversation, type Message } from '../../../Chat/chatService';
import { messageStore } from '../../../Chat/chatStore';
import { hasReadableMessageContent } from '../../../Chat/messageDecryptionState';
import { type HistoryAccessFence, isMessageVisibleForHistoryFence } from './messageListHistory';
import { toUIMessage } from './messageListPersistence';

interface UseMessageListRepliesParams {
  messages: Message[];
  conversationId: string;
  decryptionConversation: Conversation;
  historyAccessFence: HistoryAccessFence | null;
  userId?: string;
  encryptionKeyRef: MutableRefObject<CryptoKey | null>;
  currentKeyVersionRef: MutableRefObject<number>;
}

const createUnavailableReply = (replyToId: string) => ({
  message_id: replyToId,
  content: '[deleted or unavailable]',
  is_deleted: true,
} as Message);

const useMessageListReplies = ({
  messages,
  conversationId,
  decryptionConversation,
  historyAccessFence,
  userId,
  encryptionKeyRef,
  currentKeyVersionRef,
}: UseMessageListRepliesParams) => {
  const [replyCache, setReplyCache] = useState<Record<string, Message>>({});
  const fetchingReplies = useRef<Set<string>>(new Set());

  useEffect(() => {
    setReplyCache({});
    fetchingReplies.current.clear();
  }, [conversationId]);

  const getReplyParent = useCallback((replyToId: string): Message | null => {
    const inMessageList = messages.find((message) => message.message_id === replyToId);
    if (inMessageList) return inMessageList;
    if (replyCache[replyToId]) return replyCache[replyToId];
    return null;
  }, [messages, replyCache]);

  useEffect(() => {
    if (!encryptionKeyRef.current) return;

    let ignore = false;

    const missingReplies = messages
      .map((message) => message.reply_to)
      .filter((replyToId): replyToId is string => (
        !!replyToId &&
        !messages.find((message) => message.message_id === replyToId) &&
        !replyCache[replyToId] &&
        !fetchingReplies.current.has(replyToId)
      ));

    if (missingReplies.length === 0) return;

    missingReplies.forEach((replyToId) => {
      fetchingReplies.current.add(replyToId);

      messageStore.getMessage(conversationId, replyToId)
        .then((localMessage) => {
          if (ignore) return;

          if (localMessage && hasReadableMessageContent(localMessage)) {
            const localReply = toUIMessage(localMessage);
            setReplyCache((previous) => ({
              ...previous,
              [replyToId]: isMessageVisibleForHistoryFence(localReply, historyAccessFence)
                ? localReply
                : createUnavailableReply(replyToId),
            }));
            return;
          }

          return getMessageById(conversationId, replyToId, encryptionKeyRef.current!, {
            conversation: decryptionConversation,
            userId,
            currentKeyVersion: currentKeyVersionRef.current,
          })
            .then((message: any) => {
              if (ignore) return;
              const actualMessage = message?.message || message;
              setReplyCache((previous) => ({
                ...previous,
                [replyToId]: actualMessage && isMessageVisibleForHistoryFence(actualMessage, historyAccessFence)
                  ? actualMessage
                  : createUnavailableReply(replyToId),
              }));
            })
            .catch(() => {
              if (ignore) return;
              fetchingReplies.current.delete(replyToId);
            });
        })
        .catch(() => {
          if (ignore) return;
          fetchingReplies.current.delete(replyToId);
        });
    });

    return () => { ignore = true; };
  }, [
    conversationId,
    currentKeyVersionRef,
    decryptionConversation,
    encryptionKeyRef,
    historyAccessFence,
    messages,
    replyCache,
    userId,
  ]);

  return {
    getReplyParent,
  };
};

export { useMessageListReplies };
