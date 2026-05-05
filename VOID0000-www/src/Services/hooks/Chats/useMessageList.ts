import { useCallback, useEffect, useMemo, useReducer, useRef, type SetStateAction } from 'react';
import {
  type Conversation,
  type ConversationMember,
  type Message,
} from '../../Chat/chatService';
import { MESSAGE_CACHE_LIMIT, MESSAGE_INITIAL_PAGE_SIZE } from '../../Chat/chatConstants';
import { createHistoryAccessFence, normalizeHistoryVersion, } from './MessageList/messageListHistory';
import { mergeMessagesWithReconciliation } from './MessageList/messageListReconciliation';
import { sortMessages } from './MessageList/messageListPersistence';
import { getConversationWindowSnapshot, setConversationWindowSnapshot,} from './MessageList/messageListWindowCache';
import type { MessageDelete, MessageStreamEvent, MessageUpdate } from './MessageList/messageListTypes';
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
  queuedNewerMessages: Message[];
  queuedNewerHasNewer: boolean;
  queuedNewerIsAtPresent: boolean;
  loading: boolean;
  syncing: boolean;
  initialHydrationSettled: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  isAtPresent: boolean;
}

type MessageWindowAction =
  | { type: 'set_messages'; value: SetStateAction<Message[]> }
  | {
      type: 'replace_window';
      messages: Message[];
      firstItemIndex?: number;
      groupBreakBeforeIds?: Set<string>;
      loading?: boolean;
      syncing?: boolean;
      initialHydrationSettled?: boolean;
      loadingOlder?: boolean;
      loadingNewer?: boolean;
      hasOlder?: boolean;
      hasNewer?: boolean;
      isAtPresent?: boolean;
    }
  | {
      type: 'merge_visible_messages';
      incoming: Message[];
      currentUserId?: string;
      trimFrom?: 'old' | 'new';
      hasOlder?: boolean;
      hasNewer?: boolean;
      isAtPresent?: boolean;
    }
  | {
      type: 'queue_newer_messages';
      incoming: Message[];
      hasNewerAfterFlush: boolean;
      isAtPresentAfterFlush: boolean;
    }
  | {
      type: 'flush_queued_newer';
      currentUserId?: string;
      trimFrom?: 'old' | 'new';
    }
  | { type: 'set_first_item_index'; value: SetStateAction<number> }
  | { type: 'set_group_break_before_ids'; value: SetStateAction<Set<string>> }
  | { type: 'set_loading'; value: SetStateAction<boolean> }
  | { type: 'set_syncing'; value: SetStateAction<boolean> }
  | { type: 'set_initial_hydration_settled'; value: SetStateAction<boolean> }
  | { type: 'set_loading_older'; value: SetStateAction<boolean> }
  | { type: 'set_loading_newer'; value: SetStateAction<boolean> }
  | { type: 'set_has_older'; value: SetStateAction<boolean> }
  | { type: 'set_has_newer'; value: SetStateAction<boolean> }
  | { type: 'set_is_at_present'; value: SetStateAction<boolean> }
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
  queuedNewerMessages: [],
  queuedNewerHasNewer: false,
  queuedNewerIsAtPresent: true,
  loading: true,
  syncing: false,
  initialHydrationSettled: false,
  loadingOlder: false,
  loadingNewer: false,
  hasOlder: false,
  hasNewer: false,
  isAtPresent: true,
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
    case 'replace_window':
      return {
        ...state,
        messages: action.messages,
        firstItemIndex: action.firstItemIndex ?? state.firstItemIndex,
        groupBreakBeforeIds: action.groupBreakBeforeIds ?? state.groupBreakBeforeIds,
        queuedNewerMessages: [],
        queuedNewerHasNewer: false,
        queuedNewerIsAtPresent: true,
        loading: action.loading ?? state.loading,
        syncing: action.syncing ?? state.syncing,
        initialHydrationSettled: action.initialHydrationSettled ?? state.initialHydrationSettled,
        loadingOlder: action.loadingOlder ?? state.loadingOlder,
        loadingNewer: action.loadingNewer ?? state.loadingNewer,
        hasOlder: action.hasOlder ?? state.hasOlder,
        hasNewer: action.hasNewer ?? state.hasNewer,
        isAtPresent: action.isAtPresent ?? state.isAtPresent,
      };
    case 'queue_newer_messages': {
      const queuedNewerMessages = action.incoming.length > 0
        ? sortMessages(
            Array.from(
              new Map(
                [...state.queuedNewerMessages, ...action.incoming].map((message) => [message.message_id, message])
              ).values()
            )
          )
        : state.queuedNewerMessages;
      const hasExistingQueuedNewer = state.queuedNewerMessages.length > 0;

      return {
        ...state,
        queuedNewerMessages,
        queuedNewerHasNewer: hasExistingQueuedNewer
          ? state.queuedNewerHasNewer || action.hasNewerAfterFlush
          : action.hasNewerAfterFlush,
        queuedNewerIsAtPresent: hasExistingQueuedNewer
          ? state.queuedNewerIsAtPresent && action.isAtPresentAfterFlush
          : action.isAtPresentAfterFlush,
        hasNewer: true,
        isAtPresent: false,
      };
    }
    case 'flush_queued_newer': {
      if (state.queuedNewerMessages.length === 0) {
        return state;
      }
      const flushResult = mergeMessagesWithReconciliation({
        existing: state.messages,
        incoming: state.queuedNewerMessages,
        currentUserId: action.currentUserId,
        trimFrom: action.trimFrom ?? 'old',
        allowOptimisticFallback: true,
      });
      return {
        ...state,
        messages: flushResult.messages,
        firstItemIndex: flushResult.trimmedFromOld > 0
          ? state.firstItemIndex + flushResult.trimmedFromOld
          : state.firstItemIndex,
        queuedNewerMessages: [],
        queuedNewerHasNewer: false,
        queuedNewerIsAtPresent: true,
        hasOlder: flushResult.trimmedFromOld > 0 ? true : state.hasOlder,
        hasNewer: state.queuedNewerHasNewer,
        isAtPresent: state.queuedNewerIsAtPresent,
      };
    }
    case 'merge_visible_messages': {
      const mergeResult = mergeMessagesWithReconciliation({
        existing: state.messages,
        incoming: action.incoming,
        currentUserId: action.currentUserId,
        trimFrom: action.trimFrom ?? 'old',
        allowOptimisticFallback: true,
      });
      return {
        ...state,
        messages: mergeResult.messages,
        firstItemIndex: mergeResult.trimmedFromOld > 0
          ? state.firstItemIndex + mergeResult.trimmedFromOld
          : state.firstItemIndex,
        hasOlder: mergeResult.trimmedFromOld > 0 ? true : (action.hasOlder ?? state.hasOlder),
        hasNewer: mergeResult.trimmedFromNew > 0 ? true : (action.hasNewer ?? state.hasNewer),
        isAtPresent: mergeResult.trimmedFromNew > 0 ? false : (action.isAtPresent ?? state.isAtPresent),
      };
    }
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
    case 'set_loading':
      return {
        ...state,
        loading: resolveStateAction(state.loading, action.value),
      };
    case 'set_syncing':
      return {
        ...state,
        syncing: resolveStateAction(state.syncing, action.value),
      };
    case 'set_initial_hydration_settled':
      return {
        ...state,
        initialHydrationSettled: resolveStateAction(state.initialHydrationSettled, action.value),
      };
    case 'set_loading_older':
      return {
        ...state,
        loadingOlder: resolveStateAction(state.loadingOlder, action.value),
      };
    case 'set_loading_newer':
      return {
        ...state,
        loadingNewer: resolveStateAction(state.loadingNewer, action.value),
      };
    case 'set_has_older':
      return {
        ...state,
        hasOlder: resolveStateAction(state.hasOlder, action.value),
      };
    case 'set_has_newer':
      return {
        ...state,
        hasNewer: resolveStateAction(state.hasNewer, action.value),
      };
    case 'set_is_at_present':
      return {
        ...state,
        isAtPresent: resolveStateAction(state.isAtPresent, action.value),
      };
    case 'apply_prepended_window': {
      const nextBreaks = new Set(state.groupBreakBeforeIds);
      nextBreaks.add(action.seamBreakBeforeId);
      return {
        ...state,
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
  messageEvents?: MessageStreamEvent[],
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

  const messagesRef = useRef<Message[]>([]);
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
  const loading = windowState.loading;
  const syncing = windowState.syncing;
  const initialHydrationSettled = windowState.initialHydrationSettled;
  const loadingOlder = windowState.loadingOlder;
  const loadingNewer = windowState.loadingNewer;
  const hasOlder = windowState.hasOlder;
  const hasNewer = windowState.hasNewer;
  const isAtPresent = windowState.isAtPresent;
  const queuedNewerCount = windowState.queuedNewerMessages.length;

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const setMessages = useCallback((value: SetStateAction<Message[]>) => {
    dispatchWindowState({ type: 'set_messages', value });
  }, []);

  const replaceWindow = useCallback((params: {
    messages: Message[];
    firstItemIndex?: number;
    groupBreakBeforeIds?: Set<string>;
    loading?: boolean;
    syncing?: boolean;
    initialHydrationSettled?: boolean;
    loadingOlder?: boolean;
    loadingNewer?: boolean;
    hasOlder?: boolean;
    hasNewer?: boolean;
    isAtPresent?: boolean;
  }) => {
    dispatchWindowState({ type: 'replace_window', ...params });
  }, []);

  const mergeVisibleMessages = useCallback((params: {
    incoming: Message[];
    currentUserId?: string;
    trimFrom?: 'old' | 'new';
    hasOlder?: boolean;
    hasNewer?: boolean;
    isAtPresent?: boolean;
  }) => {
    dispatchWindowState({ type: 'merge_visible_messages', ...params });
  }, []);

  const queueNewerMessages = useCallback((params: {
    incoming: Message[];
    hasNewerAfterFlush: boolean;
    isAtPresentAfterFlush: boolean;
  }) => {
    dispatchWindowState({ type: 'queue_newer_messages', ...params });
  }, []);

  const flushQueuedNewerMessages = useCallback((params?: {
    currentUserId?: string;
    trimFrom?: 'old' | 'new';
  }) => {
    dispatchWindowState({ type: 'flush_queued_newer', ...params });
  }, []);

  const setLoading = useCallback((value: SetStateAction<boolean>) => {
    dispatchWindowState({ type: 'set_loading', value });
  }, []);

  const setSyncing = useCallback((value: SetStateAction<boolean>) => {
    dispatchWindowState({ type: 'set_syncing', value });
  }, []);

  const setInitialHydrationSettled = useCallback((value: SetStateAction<boolean>) => {
    dispatchWindowState({ type: 'set_initial_hydration_settled', value });
  }, []);

  const setLoadingOlder = useCallback((value: SetStateAction<boolean>) => {
    dispatchWindowState({ type: 'set_loading_older', value });
  }, []);

  const setLoadingNewer = useCallback((value: SetStateAction<boolean>) => {
    dispatchWindowState({ type: 'set_loading_newer', value });
  }, []);

  const setHasOlder = useCallback((value: SetStateAction<boolean>) => {
    dispatchWindowState({ type: 'set_has_older', value });
  }, []);

  const setHasNewer = useCallback((value: SetStateAction<boolean>) => {
    dispatchWindowState({ type: 'set_has_newer', value });
  }, []);

  const setIsAtPresent = useCallback((value: SetStateAction<boolean>) => {
    dispatchWindowState({ type: 'set_is_at_present', value });
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
    jumpToPresent,
    loadNewer,
    loadOlder,
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
    firstItemIndex,
    replaceWindow,
    mergeVisibleMessages,
    queueNewerMessages,
    flushQueuedNewerMessages,
    applyPrependedWindow,
    loadingOlder,
    loadingNewer,
    hasOlder,
    hasNewer,
    isAtPresent,
    hasQueuedNewer: queuedNewerCount > 0,
    setLoadingOlder,
    setLoadingNewer,
    setHasOlder,
    setHasNewer,
    setIsAtPresent,
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
    replaceWindow,
    mergeVisibleMessages,
    setLoading,
    setSyncing,
    setHasOlder,
    setInitialHydrationSettled,
    encryptionKeyRef,
    currentKeyVersionRef,
    messagesRef,
    lastLoadedConversationIdRef,
    observedConversationKeyVersionRef,
    pendingConversationKeyRefreshRef,
    keyVersionRefreshInFlightRef,
  });

  const { handleDelete } = useMessageListRealtime({
    conversationId,
    userId,
    historyAccessFence,
    messageEvents,
    messageUpdate,
    messageDelete,
    setMessages,
    mergeVisibleMessages,
    queueNewerMessages,
    isAtPresent,
    initialHydrationSettled,
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
    loadingNewer,
    hasOlder,
    hasNewer,
    isAtPresent,
    firstItemIndex,
    groupBreakBeforeIds,
    setIsAtPresent,
    handleDelete,
    getReplyParent,
    mergeVisibleMessages,
    jumpToPresent,
    loadOlder,
    loadNewer,
  };
};
