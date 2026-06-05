import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { getMessageById, type Conversation, type Message } from '../../../Chat/chatService';
import { messageStore, type LocalMessage } from '../../../Chat/chatStore';
import {
  hasReadableMessageContent,
  isTransientUndecryptableMessage,
} from '../../../Chat/messageDecryptionState';
import { type HistoryAccessFence, isMessageVisibleForHistoryFence } from './messageListHistory';
import { toUIMessage } from './messageListPersistence';

interface UseMessageListRepliesParams {
  messages: Message[];
  conversationId: string;
  decryptionConversation: Conversation;
  historyAccessFence: HistoryAccessFence | null;
  userId?: string;
  encryptionKey: CryptoKey | null;
  encryptionKeyRef: MutableRefObject<CryptoKey | null>;
  currentKeyVersionRef: MutableRefObject<number>;
}

const UNAVAILABLE_REPLY_CONTENT = '[deleted or unavailable]';

const createUnavailableReply = (conversationId: string, replyToId: string): Message => ({
  conversation_id: conversationId,
  message_id: replyToId,
  sender_id: '',
  encrypted_content: null,
  iv: null,
  key_version: 1,
  message_type: 'system',
  reply_to: null,
  attachments: [],
  is_edited: false,
  edited_at: null,
  is_deleted: true,
  created_at: new Date(0).toISOString(),
  content: UNAVAILABLE_REPLY_CONTENT,
  reactions: {},
  protocol: null,
  protocol_version: null,
});

const hasRenderableReplyPreview = (message: Message | LocalMessage): boolean => (
  !isTransientUndecryptableMessage(message) &&
  (
    message.is_deleted ||
    message.message_type === 'system' ||
    hasReadableMessageContent(message) ||
    Boolean(message.attachments?.length)
  )
);

const useMessageListReplies = ({
  messages,
  conversationId,
  decryptionConversation,
  historyAccessFence,
  userId,
  encryptionKey,
  encryptionKeyRef,
  currentKeyVersionRef,
}: UseMessageListRepliesParams) => {
  const [replyCache, setReplyCache] = useState<Record<string, Message>>({});
  const [fetchingReplyIds, setFetchingReplyIds] = useState<Set<string>>(new Set());
  const fetchingReplies = useRef<Set<string>>(new Set());
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    requestGenerationRef.current += 1;
    setReplyCache({});
    setFetchingReplyIds(new Set());
    fetchingReplies.current.clear();
  }, [conversationId]);

  const getReplyParent = useCallback((replyToId: string): Message | null => {
    const inMessageList = messages.find((message) => message.message_id === replyToId);
    if (inMessageList) return inMessageList;
    if (replyCache[replyToId]) return replyCache[replyToId];
    return null;
  }, [messages, replyCache]);

  const isReplyParentLoading = useCallback((replyToId: string): boolean => (
    fetchingReplyIds.has(replyToId)
  ), [fetchingReplyIds]);

  useEffect(() => {
    if (!encryptionKey || !encryptionKeyRef.current) return;

    const missingReplies = Array.from(new Set(
      messages
        .map((message) => message.reply_to)
        .filter((replyToId): replyToId is string => (
          !!replyToId &&
          !messages.find((message) => message.message_id === replyToId) &&
          !replyCache[replyToId] &&
          !fetchingReplies.current.has(replyToId)
        ))
    ));

    if (missingReplies.length === 0) return;

    missingReplies.forEach((replyToId) => {
      const requestGeneration = requestGenerationRef.current;
      fetchingReplies.current.add(replyToId);
      setFetchingReplyIds((previous) => {
        if (previous.has(replyToId)) {
          return previous;
        }

        return new Set(previous).add(replyToId);
      });

      const cacheUnavailableReply = () => {
        if (requestGeneration !== requestGenerationRef.current) {
          return;
        }

        setReplyCache((previous) => (
          previous[replyToId]
            ? previous
            : {
                ...previous,
                [replyToId]: createUnavailableReply(conversationId, replyToId),
              }
        ));
      };

      messageStore.getMessage(conversationId, replyToId)
        .then((localMessage) => {
          if (requestGeneration !== requestGenerationRef.current) return;

          if (localMessage && hasRenderableReplyPreview(localMessage)) {
            const localReply = toUIMessage(localMessage);
            const replyForCache = isMessageVisibleForHistoryFence(localReply, historyAccessFence)
              ? localReply
              : createUnavailableReply(conversationId, replyToId);
            setReplyCache((previous) => ({
              ...previous,
              [replyToId]: replyForCache,
            }));
            return;
          }

          return getMessageById(conversationId, replyToId, encryptionKeyRef.current!, {
            conversation: decryptionConversation,
            userId,
            currentKeyVersion: currentKeyVersionRef.current,
          })
            .then((message: any) => {
              if (requestGeneration !== requestGenerationRef.current) return;
              const actualMessage = message?.message || message;
              const replyForCache = actualMessage &&
                hasRenderableReplyPreview(actualMessage) &&
                isMessageVisibleForHistoryFence(actualMessage, historyAccessFence)
                ? actualMessage
                : createUnavailableReply(conversationId, replyToId);
              setReplyCache((previous) => ({
                ...previous,
                [replyToId]: replyForCache,
              }));
            })
            .catch(() => {
              cacheUnavailableReply();
            });
        })
        .catch(() => {
          cacheUnavailableReply();
        })
        .finally(() => {
          if (requestGeneration !== requestGenerationRef.current) {
            return;
          }

          fetchingReplies.current.delete(replyToId);
          setFetchingReplyIds((previous) => {
            if (!previous.has(replyToId)) {
              return previous;
            }

            const next = new Set(previous);
            next.delete(replyToId);
            return next;
          });
        });
    });
  }, [
    conversationId,
    currentKeyVersionRef,
    decryptionConversation,
    encryptionKey,
    encryptionKeyRef,
    historyAccessFence,
    messages,
    replyCache,
    userId,
  ]);

  return {
    getReplyParent,
    isReplyParentLoading,
  };
};

export { useMessageListReplies };
