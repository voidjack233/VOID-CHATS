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
      fetchingReplies.current.add(replyToId);

      const cacheUnavailableReply = () => {
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
          if (ignore) return;

          if (localMessage && hasReadableMessageContent(localMessage)) {
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
              if (ignore) return;
              const actualMessage = message?.message || message;
              const replyForCache = actualMessage && isMessageVisibleForHistoryFence(actualMessage, historyAccessFence)
                ? actualMessage
                : createUnavailableReply(conversationId, replyToId);
              setReplyCache((previous) => ({
                ...previous,
                [replyToId]: replyForCache,
              }));
            })
            .catch(() => {
              if (ignore) return;
              cacheUnavailableReply();
            });
        })
        .catch(() => {
          if (ignore) return;
          cacheUnavailableReply();
        })
        .finally(() => {
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
