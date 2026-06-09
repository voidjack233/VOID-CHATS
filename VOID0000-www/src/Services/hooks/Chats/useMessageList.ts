import { useCallback, useEffect, useMemo, useReducer, useRef, type SetStateAction } from 'react';
import {
  type Conversation,
  type ConversationMember,
  getMessageContext,
  type Message,
} from '../../Chat/chatService';
import { MAX_CACHED_MESSAGES_PER_CONVERSATION, MESSAGE_INITIAL_PAGE_SIZE } from '../../Chat/chatConstants';
import { messageStore } from '../../Chat/chatStore';
import {
  createHistoryAccessFence,
  filterMessagesByHistoryFence,
  normalizeHistoryVersion,
} from './MessageList/messageListHistory';
import { mergeMessagesWithReconciliation } from './MessageList/messageListReconciliation';
import { getConversationWindowSnapshot, setConversationWindowSnapshot,} from './MessageList/messageListWindowCache';
import {
  persistFetchedMessagesSafely,
  sortMessages,
  toUIMessage,
} from './MessageList/messageListPersistence';
import {
  applyAppendedPage,
  applyPrependedPage,
  applyRenderedUpdate,
  createEmptyRuntime,
  evictTrimmedMessages,
  getRenderedMessages,
  getRuntimeStats,
  queueLiveMessages,
  recordMeasuredMessageHeights,
  recordRuntimePage,
  resetRuntime,
  saveConversationRuntime,
  setRenderedMessages,
  sumMessageHeights,
  type ConversationRuntime,
  type RuntimeStats,
} from './MessageList/messageListRuntime';
import type { MessageDelete, MessageStreamEvent, MessageUpdate } from './MessageList/messageListTypes';
import { useMessageListLoading } from './MessageList/useMessageListLoading';
import { useMessageListPagination } from './MessageList/useMessageListPagination';
import { useMessageListRealtime } from './MessageList/useMessageListRealtime';
import { useMessageListReplies } from './MessageList/useMessageListReplies';
import { getRetryAfterMsFromError, isRateLimitError } from '../../Chat/chatUtils';

const MESSAGE_LIST_BASE_INDEX = 100000;
const MESSAGE_CONTEXT_RADIUS = 30;

export { saveConversationScrollPosition } from './MessageList/messageListWindowCache';

interface MessageWindowMetrics {
  getMessageHeight?: (message: Message) => number;
  onHistoryRateLimited?: (retryAfterMs?: number) => void;
}

interface MessageWindowState {
  runtime: ConversationRuntime;
  firstItemIndex: number;
  groupBreakBeforeIds: Set<string>;
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
      conversationId: string;
      messages: Message[];
      firstItemIndex?: number;
      topSpacerHeight?: number;
      bottomSpacerHeight?: number;
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
      type: 'restore_runtime';
      runtime: ConversationRuntime;
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
      consumeBottomSpacerHeight?: number;
      clearBottomSpacer?: boolean;
      getMessageHeight?: (message: Message) => number;
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
      getMessageHeight?: (message: Message) => number;
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
      type: 'record_measured_heights';
      measurements: Array<{ messageId: string; height: number }>;
    }
  | {
      type: 'apply_prepended_window';
      messages: Message[];
      pageMessages: Message[];
      prependedCount: number;
      seamBreakBeforeId: string;
      topSpacerHeightConsume?: number;
      bottomSpacerHeightDelta?: number;
      trimmedFromNewMessages?: Message[];
      getMessageHeight?: (message: Message) => number;
    }
  | {
      type: 'apply_appended_window';
      messages: Message[];
      pageMessages: Message[];
      appendedCount: number;
      bottomSpacerHeightConsume?: number;
      clearBottomSpacer?: boolean;
      trimmedFromOldMessages?: Message[];
      getMessageHeight?: (message: Message) => number;
      hasNewer?: boolean;
      isAtPresent?: boolean;
    };

const initialMessageWindowState: MessageWindowState = {
  runtime: createEmptyRuntime('__initial__'),
  firstItemIndex: MESSAGE_LIST_BASE_INDEX,
  groupBreakBeforeIds: new Set(),
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

const pruneGroupBreaksToMessages = (
  groupBreakBeforeIds: Set<string>,
  messages: Message[],
) => {
  if (groupBreakBeforeIds.size === 0) {
    return groupBreakBeforeIds;
  }

  const renderedIds = new Set(messages.map((message) => String(message.message_id)));
  const nextBreaks = new Set(
    Array.from(groupBreakBeforeIds).filter((id) => renderedIds.has(String(id))),
  );

  return nextBreaks.size === groupBreakBeforeIds.size
    ? groupBreakBeforeIds
    : nextBreaks;
};

const messageWindowReducer = (
  state: MessageWindowState,
  action: MessageWindowAction,
): MessageWindowState => {
  switch (action.type) {
    case 'set_messages': {
      const nextRuntime = applyRenderedUpdate(
        state.runtime,
        (messages) => resolveStateAction(messages, action.value),
      );
      return {
        ...state,
        runtime: nextRuntime,
        groupBreakBeforeIds: pruneGroupBreaksToMessages(
          state.groupBreakBeforeIds,
          getRenderedMessages(nextRuntime),
        ),
      };
    }
    case 'replace_window': {
      const nextRuntime = resetRuntime(action.conversationId, action.messages, {
        hasOlder: action.hasOlder ?? state.runtime.hasOlder,
        hasNewer: action.hasNewer ?? state.runtime.hasNewer,
        topSpacerHeight: action.topSpacerHeight ?? 0,
        bottomSpacerHeight: action.bottomSpacerHeight ?? 0,
      });
      return {
        ...state,
        runtime: nextRuntime,
        firstItemIndex: action.firstItemIndex ?? state.firstItemIndex,
        groupBreakBeforeIds: pruneGroupBreaksToMessages(
          action.groupBreakBeforeIds ?? state.groupBreakBeforeIds,
          action.messages,
        ),
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
    }
    case 'restore_runtime': {
      saveConversationRuntime(action.runtime);
      return {
        ...state,
        runtime: action.runtime,
        firstItemIndex: action.firstItemIndex ?? state.firstItemIndex,
        groupBreakBeforeIds: pruneGroupBreaksToMessages(
          action.groupBreakBeforeIds ?? state.groupBreakBeforeIds,
          getRenderedMessages(action.runtime),
        ),
        queuedNewerHasNewer: false,
        queuedNewerIsAtPresent: true,
        loading: action.loading ?? state.loading,
        syncing: action.syncing ?? state.syncing,
        initialHydrationSettled: action.initialHydrationSettled ?? state.initialHydrationSettled,
        loadingOlder: action.loadingOlder ?? state.loadingOlder,
        loadingNewer: action.loadingNewer ?? state.loadingNewer,
        hasOlder: action.hasOlder ?? action.runtime.hasOlder,
        hasNewer: action.hasNewer ?? action.runtime.hasNewer,
        isAtPresent: action.isAtPresent ?? !action.runtime.hasNewer,
      };
    }
    case 'queue_newer_messages': {
      const hasExistingQueuedNewer = state.runtime.pendingLiveIds.length > 0;
      const nextRuntime = queueLiveMessages(state.runtime, action.incoming, {
        hasNewer: true,
        isAtPresent: false,
      });

      return {
        ...state,
        runtime: nextRuntime,
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
      if (state.runtime.pendingLiveIds.length === 0) {
        return state;
      }
      const pendingMessages = state.runtime.pendingLiveIds
        .map((id) => state.runtime.messageById.get(id))
        .filter((message): message is Message => Boolean(message));
      const flushResult = mergeMessagesWithReconciliation({
        existing: getRenderedMessages(state.runtime),
        incoming: pendingMessages,
        currentUserId: action.currentUserId,
        trimFrom: action.trimFrom ?? 'old',
        allowOptimisticFallback: true,
      });
      const consumedBottomSpacerHeight = sumMessageHeights(
        state.runtime,
        pendingMessages,
        action.getMessageHeight,
      );
      let nextRuntime = setRenderedMessages(state.runtime, flushResult.messages);
      nextRuntime.pendingLiveIds = [];
      nextRuntime.bottomSpacerHeight = state.queuedNewerHasNewer
        ? Math.max(0, nextRuntime.bottomSpacerHeight - consumedBottomSpacerHeight)
        : 0;
      evictTrimmedMessages(
        nextRuntime,
        flushResult.trimmedFromOldMessages.map((message) => String(message.message_id)),
        flushResult.trimmedFromNewMessages.map((message) => String(message.message_id)),
        { resolveHeight: action.getMessageHeight },
      );
      nextRuntime = recordRuntimePage(nextRuntime, pendingMessages, 'live');
      nextRuntime.pendingLiveIds = [];
      nextRuntime.hasOlder = flushResult.trimmedFromOld > 0 ? true : nextRuntime.hasOlder;
      nextRuntime.hasNewer = state.queuedNewerHasNewer;
      saveConversationRuntime(nextRuntime);
      return {
        ...state,
        runtime: nextRuntime,
        firstItemIndex: flushResult.trimmedFromOld > 0
          ? state.firstItemIndex + flushResult.trimmedFromOld
          : state.firstItemIndex,
        groupBreakBeforeIds: pruneGroupBreaksToMessages(state.groupBreakBeforeIds, flushResult.messages),
        queuedNewerHasNewer: false,
        queuedNewerIsAtPresent: true,
        hasOlder: flushResult.trimmedFromOld > 0 ? true : state.hasOlder,
        hasNewer: state.queuedNewerHasNewer,
        isAtPresent: state.queuedNewerIsAtPresent,
      };
    }
    case 'merge_visible_messages': {
      const mergeResult = mergeMessagesWithReconciliation({
        existing: getRenderedMessages(state.runtime),
        incoming: action.incoming,
        currentUserId: action.currentUserId,
        trimFrom: action.trimFrom ?? 'old',
        allowOptimisticFallback: true,
      });
      const consumedBottomSpacerHeight = action.consumeBottomSpacerHeight ?? 0;
      const nextBottomSpacerHeight = action.clearBottomSpacer
        ? 0
        : action.hasNewer === false
        ? (consumedBottomSpacerHeight > 0
            ? Math.max(0, state.runtime.bottomSpacerHeight - consumedBottomSpacerHeight)
            : 0)
        : Math.max(0, state.runtime.bottomSpacerHeight - consumedBottomSpacerHeight);
      let nextRuntime = setRenderedMessages(state.runtime, mergeResult.messages);
      nextRuntime.bottomSpacerHeight = nextBottomSpacerHeight;
      evictTrimmedMessages(
        nextRuntime,
        mergeResult.trimmedFromOldMessages.map((message) => String(message.message_id)),
        mergeResult.trimmedFromNewMessages.map((message) => String(message.message_id)),
        { resolveHeight: action.getMessageHeight },
      );
      nextRuntime = recordRuntimePage(nextRuntime, action.incoming, action.trimFrom === 'new' ? 'older' : 'newer');
      const hasLogicalNewerRange = nextBottomSpacerHeight > 1;
      const nextHasNewer = mergeResult.trimmedFromNew > 0
        ? true
        : action.clearBottomSpacer
          ? false
        : action.hasNewer === false
          ? hasLogicalNewerRange
          : (action.hasNewer ?? nextRuntime.hasNewer);
      nextRuntime.hasOlder = mergeResult.trimmedFromOld > 0 ? true : (action.hasOlder ?? nextRuntime.hasOlder);
      nextRuntime.hasNewer = nextHasNewer;
      saveConversationRuntime(nextRuntime);
      return {
        ...state,
        runtime: nextRuntime,
        firstItemIndex: mergeResult.trimmedFromOld > 0
          ? state.firstItemIndex + mergeResult.trimmedFromOld
          : state.firstItemIndex,
        groupBreakBeforeIds: pruneGroupBreaksToMessages(state.groupBreakBeforeIds, mergeResult.messages),
        hasOlder: mergeResult.trimmedFromOld > 0 ? true : (action.hasOlder ?? state.hasOlder),
        hasNewer: nextHasNewer,
        isAtPresent: mergeResult.trimmedFromNew > 0 || nextHasNewer || hasLogicalNewerRange
          ? false
          : (action.isAtPresent ?? state.isAtPresent),
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
    case 'record_measured_heights': {
      const nextRuntime = recordMeasuredMessageHeights(state.runtime, action.measurements);
      return nextRuntime === state.runtime
        ? state
        : {
            ...state,
            runtime: nextRuntime,
          };
    }
    case 'apply_prepended_window': {
      const nextBreaks = new Set(state.groupBreakBeforeIds);
      nextBreaks.add(action.seamBreakBeforeId);
      const nextRuntime = applyPrependedPage(state.runtime, action.messages, action.pageMessages, {
        topSpacerHeightConsume: action.topSpacerHeightConsume,
        bottomSpacerHeightDelta: action.bottomSpacerHeightDelta,
        trimmedFromNewMessages: action.trimmedFromNewMessages,
        resolveHeight: action.getMessageHeight,
        hasNewer: action.bottomSpacerHeightDelta && action.bottomSpacerHeightDelta > 0 ? true : state.runtime.hasNewer,
      });
      return {
        ...state,
        runtime: nextRuntime,
        firstItemIndex: action.prependedCount > 0
          ? state.firstItemIndex - action.prependedCount
          : state.firstItemIndex,
        groupBreakBeforeIds: pruneGroupBreaksToMessages(nextBreaks, action.messages),
      };
    }
    case 'apply_appended_window': {
      const trimmedFromOldCount = action.trimmedFromOldMessages?.length ?? 0;
      const nextHasNewer = action.clearBottomSpacer
        ? false
        : action.hasNewer ?? state.hasNewer;
      const nextRuntime = applyAppendedPage(state.runtime, action.messages, action.pageMessages, {
        bottomSpacerHeightConsume: action.bottomSpacerHeightConsume,
        clearBottomSpacer: action.clearBottomSpacer,
        trimmedFromOldMessages: action.trimmedFromOldMessages,
        resolveHeight: action.getMessageHeight,
        hasOlder: trimmedFromOldCount > 0 ? true : state.hasOlder,
        hasNewer: nextHasNewer,
      });

      return {
        ...state,
        runtime: nextRuntime,
        firstItemIndex: trimmedFromOldCount > 0
          ? state.firstItemIndex + trimmedFromOldCount
          : state.firstItemIndex,
        groupBreakBeforeIds: pruneGroupBreaksToMessages(state.groupBreakBeforeIds, action.messages),
        hasOlder: trimmedFromOldCount > 0 ? true : state.hasOlder,
        hasNewer: nextHasNewer,
        isAtPresent: nextHasNewer
          ? false
          : (action.isAtPresent ?? state.isAtPresent),
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
  messageWindowMetrics: MessageWindowMetrics = {},
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

  const runtime = windowState.runtime;
  const messages = useMemo(() => getRenderedMessages(runtime), [runtime]);
  const firstItemIndex = windowState.firstItemIndex;
  const topSpacerHeight = runtime.topSpacerHeight;
  const bottomSpacerHeight = runtime.bottomSpacerHeight;
  const groupBreakBeforeIds = windowState.groupBreakBeforeIds;
  const loading = windowState.loading;
  const syncing = windowState.syncing;
  const initialHydrationSettled = windowState.initialHydrationSettled;
  const loadingOlder = windowState.loadingOlder;
  const loadingNewer = windowState.loadingNewer;
  const hasOlder = windowState.hasOlder;
  const hasNewer = windowState.hasNewer;
  const isAtPresent = windowState.isAtPresent;
  const queuedNewerCount = runtime.pendingLiveIds.length;
  const runtimeStats: RuntimeStats = useMemo(() => getRuntimeStats(runtime), [runtime]);
  const getMessageHeight = messageWindowMetrics.getMessageHeight;
  const onHistoryRateLimited = messageWindowMetrics.onHistoryRateLimited;

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const setMessages = useCallback((value: SetStateAction<Message[]>) => {
    dispatchWindowState({ type: 'set_messages', value });
  }, []);

  const replaceWindow = useCallback((params: {
    messages: Message[];
    firstItemIndex?: number;
    topSpacerHeight?: number;
    bottomSpacerHeight?: number;
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
    dispatchWindowState({ type: 'replace_window', conversationId, ...params });
  }, [conversationId]);

  const restoreRuntime = useCallback((params: {
    runtime: ConversationRuntime;
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
    dispatchWindowState({ type: 'restore_runtime', ...params });
  }, []);

  const mergeVisibleMessages = useCallback((params: {
    incoming: Message[];
    currentUserId?: string;
    trimFrom?: 'old' | 'new';
    consumeBottomSpacerHeight?: number;
    clearBottomSpacer?: boolean;
    hasOlder?: boolean;
    hasNewer?: boolean;
    isAtPresent?: boolean;
  }) => {
    dispatchWindowState({
      type: 'merge_visible_messages',
      getMessageHeight,
      ...params,
    });
  }, [getMessageHeight]);

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
    dispatchWindowState({
      type: 'flush_queued_newer',
      getMessageHeight,
      ...params,
    });
  }, [getMessageHeight]);

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

  const recordMessageHeights = useCallback((
    measurements: Array<{ messageId: string; height: number }>,
  ) => {
    if (measurements.length === 0) {
      return;
    }
    dispatchWindowState({ type: 'record_measured_heights', measurements });
  }, []);

  const applyPrependedWindow = useCallback((params: {
    messages: Message[];
    pageMessages: Message[];
    prependedCount: number;
    seamBreakBeforeId: string;
    topSpacerHeightConsume?: number;
    bottomSpacerHeightDelta?: number;
    trimmedFromNewMessages?: Message[];
  }) => {
    dispatchWindowState({
      type: 'apply_prepended_window',
      getMessageHeight,
      ...params,
    });
  }, [getMessageHeight]);

  const applyAppendedWindow = useCallback((params: {
    messages: Message[];
    pageMessages: Message[];
    appendedCount: number;
    bottomSpacerHeightConsume?: number;
    clearBottomSpacer?: boolean;
    trimmedFromOldMessages?: Message[];
    hasNewer?: boolean;
    isAtPresent?: boolean;
  }) => {
    dispatchWindowState({
      type: 'apply_appended_window',
      getMessageHeight,
      ...params,
    });
  }, [getMessageHeight]);

  const loadMessageContext = useCallback(async (targetMessageId: string) => {
    if (!encryptionKeyRef.current) {
      return false;
    }

    try {
      const context = await getMessageContext(
        conversationId,
        targetMessageId,
        encryptionKeyRef.current,
        {
          before: MESSAGE_CONTEXT_RADIUS,
          after: MESSAGE_CONTEXT_RADIUS,
          conversation: decryptionConversation,
          userId,
          currentKeyVersion: currentKeyVersionRef.current,
        },
      );
      const targetId = context.targetMessageId || targetMessageId;
      const visibleMessages = filterMessagesByHistoryFence(context.messages, historyAccessFence);

      if (!visibleMessages.some((message) => String(message.message_id) === String(targetId))) {
        return false;
      }

      const localMessages = await persistFetchedMessagesSafely(visibleMessages);
      const contextMessages = sortMessages(localMessages.map(toUIMessage));
      if (!contextMessages.some((message) => String(message.message_id) === String(targetId))) {
        return false;
      }

      messagesRef.current = contextMessages;
      replaceWindow({
        messages: contextMessages,
        firstItemIndex: MESSAGE_LIST_BASE_INDEX,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0,
        groupBreakBeforeIds: new Set(),
        loading: false,
        syncing: false,
        initialHydrationSettled: true,
        loadingOlder: false,
        loadingNewer: false,
        hasOlder: context.hasOlder,
        hasNewer: context.hasNewer,
        // Scroll geometry decides present only after the target window renders.
        isAtPresent: false,
      });
      onMessagesLoaded?.(contextMessages);
      return true;
    } catch (error) {
      if (isRateLimitError(error)) {
        onHistoryRateLimited?.(getRetryAfterMsFromError(error) ?? undefined);
      }
      console.error('Failed to load message context:', error);
      return false;
    }
  }, [
    conversationId,
    currentKeyVersionRef,
    decryptionConversation,
    encryptionKeyRef,
    historyAccessFence,
    messagesRef,
    onMessagesLoaded,
    onHistoryRateLimited,
    replaceWindow,
    userId,
  ]);

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
    getMessageHeight,
    messages,
    messagesRef,
    firstItemIndex,
    replaceWindow,
    mergeVisibleMessages,
    queueNewerMessages,
    flushQueuedNewerMessages,
    applyPrependedWindow,
    applyAppendedWindow,
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
    onHistoryRateLimited,
    messageListBaseIndex: MESSAGE_LIST_BASE_INDEX,
  });

  useMessageListLoading({
    conversationId,
    conversationKeyVersion,
    decryptionConversation,
    historyAccessFence,
    historyAccessFenceSignature,
    hasEncryptionKey,
    userId,
    onMessagesLoaded,
    messageListBaseIndex: MESSAGE_LIST_BASE_INDEX,
    replaceWindow,
    restoreRuntime,
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

  const { getReplyParent, isReplyParentLoading } = useMessageListReplies({
    messages,
    conversationId,
    decryptionConversation,
    historyAccessFence,
    userId,
    encryptionKey,
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
        MAX_CACHED_MESSAGES_PER_CONVERSATION,
        Math.max(existingSnapshot?.loadedCount ?? MESSAGE_INITIAL_PAGE_SIZE, messages.length)
      ),
      hasOlder,
    });
  }, [conversationId, hasOlder, messages]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void messageStore.pruneConversation(conversationId, {
        maxMessages: MAX_CACHED_MESSAGES_PER_CONVERSATION,
        protectedMessageIds: runtime.renderedIds,
      }).catch((error) => {
        console.warn('[MessageWindowRuntime] failed to prune IndexedDB cache', error);
      });
    }, 750);

    return () => window.clearTimeout(timeoutId);
  }, [conversationId, messages.length, runtime.renderedIds, runtimeStats.messageByIdSize, runtimeStats.pagesLength]);

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
    runtimeStats,
    firstItemIndex,
    topSpacerHeight,
    bottomSpacerHeight,
    groupBreakBeforeIds,
    setIsAtPresent,
    recordMessageHeights,
    handleDelete,
    getReplyParent,
    isReplyParentLoading,
    mergeVisibleMessages,
    loadMessageContext,
    jumpToPresent,
    loadOlder,
    loadNewer,
  };
};
