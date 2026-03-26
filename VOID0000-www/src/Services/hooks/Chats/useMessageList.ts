import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type Conversation,
  type ConversationMember,
  type Message,
} from '../../Chat/chatService';
import { MESSAGE_CACHE_LIMIT, MESSAGE_INITIAL_PAGE_SIZE, } from '../../Chat/chatConstants';
import { createHistoryAccessFence, normalizeHistoryVersion, } from './MessageList/messageListHistory';
import { getConversationWindowSnapshot, setConversationWindowSnapshot,} from './MessageList/messageListWindowCache';
import type { MessageDelete, MessageUpdate } from './MessageList/messageListTypes';
import { useMessageListLoading } from './MessageList/useMessageListLoading';
import { useMessageListPagination } from './MessageList/useMessageListPagination';
import { useMessageListRealtime } from './MessageList/useMessageListRealtime';
import { useMessageListReplies } from './MessageList/useMessageListReplies';

const INITIAL_FETCH_SIZE = MESSAGE_INITIAL_PAGE_SIZE;
const CACHE_LIMIT = MESSAGE_CACHE_LIMIT;
const MESSAGE_LIST_BASE_INDEX = 100000;

export { saveConversationScrollPosition } from './MessageList/messageListWindowCache';

export const useMessageList = (
  conversation: Conversation,
  userId: string | undefined,
  currentMember: ConversationMember | null | undefined,
  encryptionKey: CryptoKey | null,
  currentKeyVersion = 1,
  newMessage?: Message | null,
  messageUpdate?: MessageUpdate | null,
  messageDelete?: MessageDelete | null,
  onMessagesLoaded?: (messages: Message[]) => void
) => {
  const conversationId = conversation.id;
  const conversationKeyVersion = normalizeHistoryVersion(conversation.current_key_version) ?? 1;
  const hasEncryptionKey = Boolean(encryptionKey);

  const historyAccessFence = useMemo(
    () => createHistoryAccessFence(conversation, currentMember),
    [
      conversation.type,
      currentMember?.history_start_version,
      currentMember?.joined_at,
      currentMember?.joined_key_version,
    ]
  );

  const decryptionConversation = useMemo(
    () => conversation,
    [
      conversation.id,
      conversation.public_id,
      conversation.type,
      conversation.parent_conversation_id,
      conversation.parent_public_id,
      conversation.owner_id,
      conversation.dm_user_id,
    ]
  );

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const messagesRef = useRef<Message[]>([]);
  const prefetchedAfterLoadRef = useRef(false);
  const lastLoadedConversationIdRef = useRef<string | null>(null);
  const encryptionKeyRef = useRef(encryptionKey);
  const currentKeyVersionRef = useRef(currentKeyVersion);
  const observedConversationKeyVersionRef = useRef(conversationKeyVersion);
  const pendingConversationKeyRefreshRef = useRef<number | null>(null);
  const keyVersionRefreshInFlightRef = useRef<number | null>(null);

  encryptionKeyRef.current = encryptionKey;
  currentKeyVersionRef.current = currentKeyVersion;

  const initialScrollToMessageId = useMemo(
    () => getConversationWindowSnapshot(conversationId)?.topVisibleMessageId ?? null,
    [conversationId]
  );

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const {
    firstItemIndex,
    groupBreakBeforeIds,
    hasNewer,
    hasOlder,
    isAtPresent,
    jumpToPresent,
    loadNewer,
    loadOlder,
    loadingNewer,
    loadingOlder,
    prefetchOlder,
    prefetchingOlder,
    setFirstItemIndex,
    setGroupBreakBeforeIds,
    setHasNewer,
    setHasOlder,
    setIsAtPresent,
    setPrefetchingOlder,
  } = useMessageListPagination({
    conversationId,
    decryptionConversation,
    historyAccessFence,
    userId,
    encryptionKey,
    encryptionKeyRef,
    currentKeyVersionRef,
    messages,
    messagesRef,
    setMessages,
    loading,
    onMessagesLoaded,
    prefetchedAfterLoadRef,
    messageListBaseIndex: MESSAGE_LIST_BASE_INDEX,
  });

  useMessageListLoading({
    conversationId,
    conversationKeyVersion,
    decryptionConversation,
    historyAccessFence,
    hasEncryptionKey,
    userId,
    onMessagesLoaded,
    messageListBaseIndex: MESSAGE_LIST_BASE_INDEX,
    setMessages,
    setLoading,
    setSyncing,
    setHasOlder,
    setHasNewer,
    setIsAtPresent,
    setFirstItemIndex,
    setGroupBreakBeforeIds,
    setPrefetchingOlder,
    encryptionKeyRef,
    currentKeyVersionRef,
    messagesRef,
    lastLoadedConversationIdRef,
    prefetchedAfterLoadRef,
    observedConversationKeyVersionRef,
    pendingConversationKeyRefreshRef,
    keyVersionRefreshInFlightRef,
  });

  const { handleDelete } = useMessageListRealtime({
    conversationId,
    userId,
    historyAccessFence,
    newMessage,
    messageUpdate,
    messageDelete,
    setMessages,
  });

  const { getReplyParent } = useMessageListReplies({
    messages,
    conversationId,
    decryptionConversation,
    historyAccessFence,
    userId,
    encryptionKeyRef,
    currentKeyVersionRef,
  });

  useEffect(() => {
    if (
      messages.length === 0 ||
      messages.some((message) => String(message.conversation_id) !== String(conversationId))
    ) {
      return;
    }

    const existingSnapshot = getConversationWindowSnapshot(conversationId);
    setConversationWindowSnapshot(conversationId, {
      loadedCount: Math.min(
        CACHE_LIMIT,
        Math.max(existingSnapshot?.loadedCount ?? INITIAL_FETCH_SIZE, messages.length)
      ),
      hasOlder,
    });
  }, [conversationId, hasOlder, messages]);

  return {
    messages,
    loading,
    syncing,
    loadingOlder,
    prefetchingOlder,
    loadingNewer,
    hasOlder,
    hasNewer,
    isAtPresent,
    firstItemIndex,
    groupBreakBeforeIds,
    setIsAtPresent,
    handleDelete,
    getReplyParent,
    jumpToPresent,
    loadOlder,
    loadNewer,
    prefetchOlder,
    initialScrollToMessageId,
  };
};
