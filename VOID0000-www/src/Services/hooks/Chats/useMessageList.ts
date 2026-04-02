import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type SetStateAction } from 'react';
import {
  type Conversation,
  type ConversationMember,
  type Message,
} from '../../Chat/chatService';
import { MESSAGE_CACHE_LIMIT, MESSAGE_INITIAL_PAGE_SIZE } from '../../Chat/chatConstants';
import { createHistoryAccessFence, normalizeHistoryVersion, } from './MessageList/messageListHistory';
import { getConversationWindowSnapshot, setConversationWindowSnapshot,} from './MessageList/messageListWindowCache';
import type { MessageDelete, MessageUpdate } from './MessageList/messageListTypes';
import { useMessageListLoading } from './MessageList/useMessageListLoading';
import { useMessageListPagination } from './MessageList/useMessageListPagination';
import { useMessageListRealtime } from './MessageList/useMessageListRealtime';
import { useMessageListReplies } from './MessageList/useMessageListReplies';

const CACHE_LIMIT = MESSAGE_CACHE_LIMIT;
const MESSAGE_LIST_BASE_INDEX = 100000;

export { saveConversationScrollPosition } from './MessageList/messageListWindowCache';

interface MessageWindowState {
  messages: Message[];
  firstItemIndex: number;
  groupBreakBeforeIds: Set<string>;
}

type MessageWindowAction =
  | { type: 'set_messages'; value: SetStateAction<Message[]> }
  | { type: 'set_first_item_index'; value: SetStateAction<number> }
  | { type: 'set_group_break_before_ids'; value: SetStateAction<Set<string>> }
  | {
      type: 'apply_prepended_window';
      messages: Message[];
      prependedCount: number;
      seamBreakBeforeId: string;
    };

const initialMessageWindowState: MessageWindowState = {
  messages: [],
  firstItemIndex: MESSAGE_LIST_BASE_INDEX,
  groupBreakBeforeIds: new Set(),
};

const resolveStateAction = <T,>(previous: T, value: SetStateAction<T>): T => (
  typeof value === 'function'
    ? (value as (current: T) => T)(previous)
    : value
);

const messageWindowReducer = (
  state: MessageWindowState,
  action: MessageWindowAction,
): MessageWindowState => {
  switch (action.type) {
    case 'set_messages':
      return {
        ...state,
        messages: resolveStateAction(state.messages, action.value),
      };
    case 'set_first_item_index':
      return {
        ...state,
        firstItemIndex: resolveStateAction(state.firstItemIndex, action.value),
      };
    case 'set_group_break_before_ids':
      return {
        ...state,
        groupBreakBeforeIds: resolveStateAction(state.groupBreakBeforeIds, action.value),
      };
    case 'apply_prepended_window': {
      const nextBreaks = new Set(state.groupBreakBeforeIds);
      nextBreaks.add(action.seamBreakBeforeId);
      return {
        messages: action.messages,
        firstItemIndex: action.prependedCount > 0
          ? state.firstItemIndex - action.prependedCount
          : state.firstItemIndex,
        groupBreakBeforeIds: nextBreaks,
      };
    }
    default:
      return state;
  }
};

export const useMessageList = (
  conversation: Conversation,
  userId: string | undefined,
  currentMember: ConversationMember | null | undefined,
  encryptionKey: CryptoKey | null,
  currentKeyVersion = 1,
  newMessage?: Message | null,
  messageUpdate?: MessageUpdate | null,
  messageDelete?: MessageDelete | null,
  onMessagesLoaded?: (messages: Message[]) => void,
  waitForEncryptionBootstrap = false,
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
  const historyAccessFenceSignature = historyAccessFence
    ? `${historyAccessFence.joinedAtMs ?? 'null'}:${historyAccessFence.keyVersionFloor ?? 'null'}`
    : 'none';

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

  const [windowState, dispatchWindowState] = useReducer(messageWindowReducer, initialMessageWindowState);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [initialHydrationSettled, setInitialHydrationSettled] = useState(false);

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

  const messages = windowState.messages;
  const firstItemIndex = windowState.firstItemIndex;
  const groupBreakBeforeIds = windowState.groupBreakBeforeIds;

  const initialScrollToMessageId = useMemo(
    () => getConversationWindowSnapshot(conversationId)?.topVisibleMessageId ?? null,
    [conversationId]
  );

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const setMessages = useCallback((value: SetStateAction<Message[]>) => {
    dispatchWindowState({ type: 'set_messages', value });
  }, []);

  const setFirstItemIndex = useCallback((value: SetStateAction<number>) => {
    dispatchWindowState({ type: 'set_first_item_index', value });
  }, []);

  const setGroupBreakBeforeIds = useCallback((value: SetStateAction<Set<string>>) => {
    dispatchWindowState({ type: 'set_group_break_before_ids', value });
  }, []);

  const applyPrependedWindow = useCallback((params: {
    messages: Message[];
    prependedCount: number;
    seamBreakBeforeId: string;
  }) => {
    dispatchWindowState({ type: 'apply_prepended_window', ...params });
  }, []);

  useEffect(() => {
    setInitialHydrationSettled(false);
  }, [conversationId, hasEncryptionKey, historyAccessFenceSignature, waitForEncryptionBootstrap]);

  const {
    hasNewer,
    hasOlder,
    isAtPresent,
    jumpToPresent,
    loadNewer,
    loadOlder,
    loadingNewer,
    loadingOlder,
    prefetchingOlder,
    topLoadingPlaceholderCount,
    bottomLoadingPlaceholderCount,
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
    applyPrependedWindow,
    setFirstItemIndex,
    setGroupBreakBeforeIds,
    loading,
    syncing,
    initialHydrationSettled,
    onMessagesLoaded,
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
    setInitialHydrationSettled,
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
        Math.max(existingSnapshot?.loadedCount ?? MESSAGE_INITIAL_PAGE_SIZE, messages.length)
      ),
      hasOlder,
    });
  }, [conversationId, hasOlder, messages]);

  return {
    messages,
    loading,
    syncing,
    initialHydrationSettled,
    loadingOlder,
    prefetchingOlder,
    loadingNewer,
    hasOlder,
    hasNewer,
    isAtPresent,
    firstItemIndex,
    topLoadingPlaceholderCount,
    bottomLoadingPlaceholderCount,
    groupBreakBeforeIds,
    setIsAtPresent,
    handleDelete,
    getReplyParent,
    jumpToPresent,
    loadOlder,
    loadNewer,
    initialScrollToMessageId,
  };
};
