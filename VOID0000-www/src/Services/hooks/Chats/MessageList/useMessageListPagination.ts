import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import {
  MESSAGE_PAGE_SIZE,
  MESSAGE_PREFETCH_SIZE,
  MESSAGE_WINDOW_TRIM_TARGET,
  MESSAGE_WINDOW_TRIM_TRIGGER,
} from '../../../Chat/chatConstants';
import { messageSync } from '../../../Chat/chatSync';
import { getMessages, type Conversation, type Message } from '../../../Chat/chatService';
import { gateway } from '../../../Gateway/gateway';
import { type HistoryAccessFence, filterMessagesByHistoryFence } from './messageListHistory';
import { debugMessageList, rawDebugMessageList } from './messageListDebug';
import {
  getNewestServerBackedMessage,
  trimMessages,
} from './messageListReconciliation';
import {
  hasUndecryptableMessage,
  mergeLocalMessages,
  persistFetchedMessagesSafely,
  sortMessages,
  toUIMessage,
} from './messageListPersistence';

interface UseMessageListPaginationParams {
  conversationId: string;
  decryptionConversation: Conversation;
  historyAccessFence: HistoryAccessFence | null;
  userId?: string;
  encryptionKey: CryptoKey | null;
  encryptionKeyRef: MutableRefObject<CryptoKey | null>;
  currentKeyVersionRef: MutableRefObject<number>;
  messages: Message[];
  messagesRef: MutableRefObject<Message[]>;
  firstItemIndex: number;
  replaceWindow: (params: {
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
  }) => void;
  mergeVisibleMessages: (params: {
    incoming: Message[];
    currentUserId?: string;
    trimFrom?: 'old' | 'new';
    hasOlder?: boolean;
    hasNewer?: boolean;
    isAtPresent?: boolean;
  }) => void;
  queueNewerMessages: (params: {
    incoming: Message[];
    hasNewerAfterFlush: boolean;
    isAtPresentAfterFlush: boolean;
  }) => void;
  flushQueuedNewerMessages: (params?: {
    currentUserId?: string;
    trimFrom?: 'old' | 'new';
  }) => void;
  applyPrependedWindow: (params: {
    messages: Message[];
    prependedCount: number;
    seamBreakBeforeId: string;
  }) => void;
  loadingOlder: boolean;
  loadingNewer: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  isAtPresent: boolean;
  hasQueuedNewer: boolean;
  setLoadingOlder: Dispatch<SetStateAction<boolean>>;
  setLoadingNewer: Dispatch<SetStateAction<boolean>>;
  setHasOlder: Dispatch<SetStateAction<boolean>>;
  setHasNewer: Dispatch<SetStateAction<boolean>>;
  setIsAtPresent: Dispatch<SetStateAction<boolean>>;
  loading: boolean;
  syncing: boolean;
  initialHydrationSettled: boolean;
  onMessagesLoaded?: (messages: Message[]) => void;
  messageListBaseIndex: number;
}

const FETCH_SIZE = MESSAGE_PAGE_SIZE;

const useMessageListPagination = ({
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
  hasQueuedNewer,
  setLoadingOlder,
  setLoadingNewer,
  setHasOlder,
  setHasNewer,
  setIsAtPresent,
  loading,
  syncing,
  initialHydrationSettled,
  onMessagesLoaded,
  messageListBaseIndex,
}: UseMessageListPaginationParams) => {
  const isAtPresentRef = useRef(isAtPresent);
  isAtPresentRef.current = isAtPresent;
  const firstItemIndexRef = useRef(firstItemIndex);
  firstItemIndexRef.current = firstItemIndex;
  const olderServerPrefetchInFlightRef = useRef<Set<string>>(new Set());
  const olderServerPrefetchedAnchorsRef = useRef<Set<string>>(new Set());
  const pendingOlderExhaustionRef = useRef<{
    conversationId: string;
    anchorMessageId: string | null;
  } | null>(null);

  useEffect(() => {
    return () => {
      pendingOlderExhaustionRef.current = null;
    };
  }, []);

  const getOlderServerPrefetchState = useCallback((anchorMessageId: string | null) => {
    if (!anchorMessageId) {
      return null;
    }

    return {
      anchorMessageId,
      inFlight: olderServerPrefetchInFlightRef.current.has(anchorMessageId),
      prefetched: olderServerPrefetchedAnchorsRef.current.has(anchorMessageId),
    };
  }, []);

  useEffect(() => {
    olderServerPrefetchInFlightRef.current.clear();
    olderServerPrefetchedAnchorsRef.current.clear();
    pendingOlderExhaustionRef.current = null;
    replaceWindow({
      messages: [],
      firstItemIndex: messageListBaseIndex,
      groupBreakBeforeIds: new Set(),
      loadingOlder: false,
      loadingNewer: false,
      hasOlder: false,
      hasNewer: false,
      isAtPresent: true,
    });
  }, [conversationId, messageListBaseIndex]);

  const warmOlderServerHistory = useCallback(async (nextOldestMessageId: string) => {
    if (!encryptionKeyRef.current) {
      return;
    }

    const prefetchStateBefore = getOlderServerPrefetchState(nextOldestMessageId);
    if (
      olderServerPrefetchInFlightRef.current.has(nextOldestMessageId) ||
      olderServerPrefetchedAnchorsRef.current.has(nextOldestMessageId)
    ) {
      const payload = {
        conversationId,
        anchorMessageId: nextOldestMessageId,
        action: 'skip_already_known',
        prefetchStateBefore,
      };
      rawDebugMessageList('older_server_prefetch_state', payload);
      debugMessageList('older_server_prefetch_state', payload);
      return;
    }

    const localProbe = await messageSync.readLocal(conversationId, {
      before: nextOldestMessageId,
      limit: FETCH_SIZE,
    });
    const localProbeHadUndecryptable = hasUndecryptableMessage(localProbe.messages);

    const isNearLocalOlderSeam =
      localProbe.messages.length < FETCH_SIZE ||
      !localProbe.has_more ||
      localProbeHadUndecryptable;

    if (!isNearLocalOlderSeam) {
      const payload = {
        conversationId,
        anchorMessageId: nextOldestMessageId,
        action: 'skip_not_near_seam',
        localProbeCount: localProbe.messages.length,
        localProbeHasMore: localProbe.has_more,
        localProbeHadUndecryptable,
        localHistoryExhaustedBeforeServer: localProbe.messages.length < FETCH_SIZE || !localProbe.has_more,
        prefetchStateBefore,
      };
      rawDebugMessageList('older_server_prefetch_state', payload);
      debugMessageList('older_server_prefetch_state', payload);
      return;
    }

    olderServerPrefetchInFlightRef.current.add(nextOldestMessageId);
    const startPayload = {
      conversationId,
      anchorMessageId: nextOldestMessageId,
      action: 'start',
      localProbeCount: localProbe.messages.length,
      localProbeHasMore: localProbe.has_more,
      localProbeHadUndecryptable,
      localHistoryExhaustedBeforeServer: localProbe.messages.length < FETCH_SIZE || !localProbe.has_more,
      prefetchStateBefore,
      prefetchStateAfterStart: getOlderServerPrefetchState(nextOldestMessageId),
    };
    rawDebugMessageList('older_server_prefetch_state', startPayload);
    debugMessageList('older_server_prefetch_state', startPayload);

    try {
      const serverResult = await getMessages(conversationId, encryptionKeyRef.current, {
        before: nextOldestMessageId,
        limit: MESSAGE_PREFETCH_SIZE,
        conversation: decryptionConversation,
        userId,
        currentKeyVersion: currentKeyVersionRef.current,
      });

      await persistFetchedMessagesSafely(serverResult.messages);
      olderServerPrefetchedAnchorsRef.current.add(nextOldestMessageId);
      const successPayload = {
        conversationId,
        anchorMessageId: nextOldestMessageId,
        action: 'success',
        serverCount: serverResult.messages.length,
        serverHasMore: serverResult.has_more,
        prefetchStateAfterSuccess: getOlderServerPrefetchState(nextOldestMessageId),
      };
      rawDebugMessageList('older_server_prefetch_state', successPayload);
      debugMessageList('older_server_prefetch_state', successPayload);
    } catch (error) {
      const errorPayload = {
        conversationId,
        anchorMessageId: nextOldestMessageId,
        action: 'error',
        error: error instanceof Error ? error.message : String(error),
        prefetchStateAtError: getOlderServerPrefetchState(nextOldestMessageId),
      };
      rawDebugMessageList('older_server_prefetch_state', errorPayload);
      debugMessageList('older_server_prefetch_state', errorPayload);
      console.error('Failed to prefetch older server history:', error);
    } finally {
      olderServerPrefetchInFlightRef.current.delete(nextOldestMessageId);
    }
  }, [conversationId, currentKeyVersionRef, decryptionConversation, encryptionKeyRef, getOlderServerPrefetchState, userId]);

  const applyOlderMessages = useCallback((olderMessages: Message[], seamBreakBeforeId: string) => {
    if (olderMessages.length === 0) return null;

    const prevCount = messagesRef.current.length;
    const prevFirstItemIndex = firstItemIndexRef.current;
    const existingIds = new Set(messagesRef.current.map((message) => message.message_id));
    const prependedMessages = olderMessages.filter((message) => !existingIds.has(message.message_id));
    const prependedCount = prependedMessages.length;
    const mergedMessages = [...olderMessages, ...messagesRef.current];
    const uniqueMessages = Array.from(
      new Map(mergedMessages.map((message) => [message.message_id, message])).values()
    );
    const trimResult = trimMessages(uniqueMessages, 'new', {
      trigger: MESSAGE_WINDOW_TRIM_TRIGGER,
      target: MESSAGE_WINDOW_TRIM_TARGET,
    });
    const trimmedMessages = trimResult.messages;

    messagesRef.current = trimmedMessages;
    debugMessageList('prepend_apply', {
      conversationId,
      prependedCount,
      prevFirstItemIndex,
      nextFirstItemIndex: prependedCount > 0
        ? prevFirstItemIndex - prependedCount
        : prevFirstItemIndex,
      prevCount,
      nextCount: trimmedMessages.length,
      firstPrependedId: prependedMessages[0]?.message_id || null,
      lastPrependedId: prependedMessages[prependedMessages.length - 1]?.message_id || null,
    });
    debugMessageList('prepend_derived_rows', {
      conversationId,
      rawOlderMessages: olderMessages.length,
      renderedPrependedRows: prependedCount,
      derivedRowsAreSeparateItems: false,
      note: 'Date separators and grouping are rendered inside MessageItem, not as separate Virtuoso rows.',
    });
    applyPrependedWindow({
      messages: trimmedMessages,
      prependedCount,
      seamBreakBeforeId,
    });

    if (trimResult.trimmedFromNew > 0) {
      setHasNewer(true);
      setIsAtPresent(false);
    }

    onMessagesLoaded?.(olderMessages);
    return {
      prependedCount,
      prevCount,
      nextCount: trimmedMessages.length,
      trimmedVisibleCount: uniqueMessages.length - trimmedMessages.length,
      firstPrependedId: prependedMessages[0]?.message_id || null,
      lastPrependedId: prependedMessages[prependedMessages.length - 1]?.message_id || null,
    };
  }, [applyPrependedWindow, conversationId, messagesRef, onMessagesLoaded]);

  const fetchOlderMessages = useCallback(async (oldestMessageId: string, options?: { forceServer?: boolean }) => {
    const forceServer = options?.forceServer === true;
    let result: { messages: any[]; has_more: boolean };
    let localCount = 0;
    let localHasMore = false;
    let localHadUndecryptable = false;
    let serverRequested = false;
    let serverCount = 0;
    let serverHasMore: boolean | null = null;

    if (forceServer) {
      const localResult = await messageSync.readLocal(conversationId, {
        before: oldestMessageId,
        limit: FETCH_SIZE,
      });
      localCount = localResult.messages.length;
      localHasMore = localResult.has_more;
      localHadUndecryptable = hasUndecryptableMessage(localResult.messages);

      serverRequested = true;
      const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
        before: oldestMessageId,
        limit: FETCH_SIZE,
        conversation: decryptionConversation,
        userId,
        currentKeyVersion: currentKeyVersionRef.current,
      });
      serverCount = serverResult.messages.length;
      serverHasMore = serverResult.has_more;
      const localMessages = await persistFetchedMessagesSafely(serverResult.messages);
      result = {
        messages: mergeLocalMessages(localResult.messages, localMessages),
        has_more: localResult.has_more || serverResult.has_more || serverResult.messages.length >= FETCH_SIZE,
      };
    } else {
      result = await messageSync.readLocal(conversationId, {
        before: oldestMessageId,
        limit: FETCH_SIZE,
      });
      localCount = result.messages.length;
      localHasMore = result.has_more;
      localHadUndecryptable = hasUndecryptableMessage(result.messages);

      // Local older pages can be structurally complete but have stale reaction maps.
      // Validate the page with the server before rendering so old cached messages
      // do not disagree with a fresh browser.
      serverRequested = true;
      const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
        before: oldestMessageId,
        limit: FETCH_SIZE,
        conversation: decryptionConversation,
        userId,
        currentKeyVersion: currentKeyVersionRef.current,
      });
      serverCount = serverResult.messages.length;
      serverHasMore = serverResult.has_more;
      const localMessages = await persistFetchedMessagesSafely(serverResult.messages);
      result = {
        messages: mergeLocalMessages(result.messages, localMessages),
        has_more: result.has_more || serverResult.has_more || serverResult.messages.length >= FETCH_SIZE,
      };
    }

    const visibleOlderMessages = filterMessagesByHistoryFence(result.messages, historyAccessFence);
    const olderUI = sortMessages(visibleOlderMessages.map(toUIMessage));
    return {
      olderUI,
      hasMore: result.has_more,
      debug: {
        requestedOlderCount: FETCH_SIZE,
        forceServer,
        localCount,
        localHasMore,
        localHadUndecryptable,
        localHistoryExhaustedBeforeServer: localCount < FETCH_SIZE || !localHasMore,
        serverRequested,
        serverCount,
        serverHasMore,
        mergedCount: result.messages.length,
        mergedHasMore: result.has_more,
        visibleReturnedCount: olderUI.length,
      },
    };
  }, [conversationId, decryptionConversation, encryptionKeyRef, historyAccessFence, userId, currentKeyVersionRef]);

  const loadOlderPage = useCallback(async (options?: { silent?: boolean; forceServer?: boolean }) => {
    const forceServer = options?.forceServer === true;

    if (
      pendingOlderExhaustionRef.current &&
      pendingOlderExhaustionRef.current.conversationId === conversationId &&
      !loadingOlder
    ) {
      pendingOlderExhaustionRef.current = null;
      setHasOlder(false);
      return;
    }

    if (
      !encryptionKeyRef.current ||
      loadingOlder ||
      !hasOlder ||
      messagesRef.current.length === 0
    ) {
      return;
    }

    debugMessageList('older_fetch_start', {
      conversationId,
      oldestMessageId: messagesRef.current[0]?.message_id || null,
      currentCount: messagesRef.current.length,
      firstItemIndex: firstItemIndexRef.current,
      forceServer,
      hasOlder,
      loadingOlder,
    });
    setLoadingOlder(true);

    try {
      const oldestMessage = messagesRef.current[0];
      if (!oldestMessage) return;

      const seamBreakBeforeId = oldestMessage.message_id;
      const { olderUI, hasMore, debug } = await fetchOlderMessages(oldestMessage.message_id, { forceServer });
      let applySummary: ReturnType<typeof applyOlderMessages> = null;
      const nextOldestLoadedMessageId = olderUI[0]?.message_id ?? null;

      if (olderUI.length > 0) {
        applySummary = applyOlderMessages(olderUI, seamBreakBeforeId);
        if (!hasMore) {
          pendingOlderExhaustionRef.current = {
            conversationId,
            anchorMessageId: nextOldestLoadedMessageId,
          };
          setHasOlder(true);
        } else {
          pendingOlderExhaustionRef.current = null;
          setHasOlder(true);
        }
        if (!forceServer) {
          if (nextOldestLoadedMessageId) {
            void warmOlderServerHistory(nextOldestLoadedMessageId);
          }
        }
        debugMessageList('older_fetch_success', {
          conversationId,
          fetchedCount: olderUI.length,
          hasMore,
          seamBreakBeforeId,
          firstItemIndex: firstItemIndexRef.current,
        });
      } else {
        pendingOlderExhaustionRef.current = null;
        setHasOlder(false);
      }

      if (olderUI.length < FETCH_SIZE || !hasMore) {
        const boundaryPayload = {
          conversationId,
          requestedOlderCount: debug.requestedOlderCount,
          returnedOlderCount: olderUI.length,
          hasOlderBefore: hasOlder,
          hasOlderAfter: olderUI.length > 0 ? hasMore : false,
          oldestMessageIdBefore: oldestMessage.message_id,
          oldestMessageIdAfter: nextOldestLoadedMessageId,
          localHistoryExhaustedBeforeServer: debug.localHistoryExhaustedBeforeServer,
          localCount: debug.localCount,
          localHasMore: debug.localHasMore,
          localHadUndecryptable: debug.localHadUndecryptable,
          serverRequested: debug.serverRequested,
          serverCount: debug.serverCount,
          serverHasMore: debug.serverHasMore,
          mergedCount: debug.mergedCount,
          visibleReturnedCount: debug.visibleReturnedCount,
          currentAnchorPrefetchState: getOlderServerPrefetchState(oldestMessage.message_id),
          nextAnchorPrefetchState: getOlderServerPrefetchState(nextOldestLoadedMessageId),
          trimmedVisibleCount: applySummary?.trimmedVisibleCount ?? 0,
          prevVisibleCount: applySummary?.prevCount ?? messagesRef.current.length,
          nextVisibleCount: applySummary?.nextCount ?? messagesRef.current.length,
          prependedCount: applySummary?.prependedCount ?? 0,
          forceServer,
          exhaustionStateCommitStrategy: olderUI.length > 0 && !hasMore ? 'defer_until_next_top_hit' : 'immediate',
        };
        rawDebugMessageList('older_fetch_boundary', boundaryPayload);
        debugMessageList('older_fetch_boundary', boundaryPayload);
      }
    } catch (error) {
      console.error('Failed to load older messages:', error);
    } finally {
      setLoadingOlder(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    applyOlderMessages,
    fetchOlderMessages,
    getOlderServerPrefetchState,
    hasOlder,
    loadingOlder,
    messagesRef,
    setHasOlder,
    warmOlderServerHistory,
  ]);

  const loadOlder = useCallback(async () => {
    await loadOlderPage();
  }, [loadOlderPage]);

  const loadNewer = useCallback(async () => {
    if (!encryptionKeyRef.current || loadingNewer || !hasNewer || messages.length === 0) return;

    if (initialHydrationSettled && hasQueuedNewer) {
      flushQueuedNewerMessages({ currentUserId: userId, trimFrom: 'old' });
      return;
    }

    setLoadingNewer(true);

    try {
      const newestMessage = getNewestServerBackedMessage(messages);
      if (!newestMessage) return;

      let result = await messageSync.readLocal(conversationId, {
        after: newestMessage.message_id,
        limit: FETCH_SIZE,
      });

      if (result.messages.length < FETCH_SIZE || !result.has_more || hasUndecryptableMessage(result.messages)) {
        const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
          after: newestMessage.message_id,
          limit: FETCH_SIZE,
          conversation: decryptionConversation,
          userId,
          currentKeyVersion: currentKeyVersionRef.current,
        });
        const localMessages = await persistFetchedMessagesSafely(serverResult.messages);
        result = {
          messages: mergeLocalMessages(result.messages, localMessages),
          has_more: result.has_more || serverResult.has_more || serverResult.messages.length >= FETCH_SIZE,
        };
      }

      const visibleNewerMessages = filterMessagesByHistoryFence(result.messages, historyAccessFence);
      const newerUI = sortMessages(visibleNewerMessages.map(toUIMessage));
      if (newerUI.length > 0) {
        const hasNewerAfterMerge = newerUI.length < FETCH_SIZE ? false : result.has_more;
        const isAtPresentAfterMerge = newerUI.length < FETCH_SIZE;

        if (!initialHydrationSettled || !isAtPresentRef.current) {
          queueNewerMessages({
            hasNewerAfterFlush: hasNewerAfterMerge,
            isAtPresentAfterFlush: isAtPresentAfterMerge,
            incoming: newerUI,
          });
        } else {
          mergeVisibleMessages({
            incoming: newerUI,
            currentUserId: userId,
            trimFrom: 'old',
            hasNewer: hasNewerAfterMerge,
            isAtPresent: isAtPresentAfterMerge,
          });
          onMessagesLoaded?.(newerUI);
        }
      } else {
        setHasNewer(false);
        setIsAtPresent(true);
      }
    } catch (error) {
      console.error('Failed to load newer messages:', error);
    } finally {
      setLoadingNewer(false);
    }
  }, [
    conversationId,
    decryptionConversation,
    hasNewer,
    hasQueuedNewer,
    historyAccessFence,
    initialHydrationSettled,
    loadingNewer,
    mergeVisibleMessages,
    messages,
    onMessagesLoaded,
    queueNewerMessages,
    userId,
    flushQueuedNewerMessages,
  ]);

  const reconcileRecentMessages = useCallback(async (source: 'gateway_ready' | 'gateway_resumed' | 'tab_visible') => {
    if (!encryptionKeyRef.current) return;

    const newestMessage = getNewestServerBackedMessage(messagesRef.current);
    if (!newestMessage) return;

    console.log('[WS_RESYNC] reconciling active conversation after reconnect/visibility', {
      conversation_id: conversationId,
      source,
      after_message_id: newestMessage.message_id,
    });

    try {
      const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
        after: newestMessage.message_id,
        limit: FETCH_SIZE,
        conversation: decryptionConversation,
        userId,
        currentKeyVersion: currentKeyVersionRef.current,
      });

      if (serverResult.messages.length === 0) {
        return;
      }

      const localMessages = await persistFetchedMessagesSafely(serverResult.messages);
      const visibleServerMessages = filterMessagesByHistoryFence(localMessages, historyAccessFence);
      const newerUI = sortMessages(visibleServerMessages.map(toUIMessage));
      const hasNewerAfterMerge = serverResult.has_more || serverResult.messages.length >= FETCH_SIZE;
      const isAtPresentAfterMerge = !hasNewerAfterMerge;

      if (newerUI.length === 0) {
        setHasNewer(hasNewerAfterMerge);
        setIsAtPresent(isAtPresentAfterMerge);
      } else if (!initialHydrationSettled || !isAtPresentRef.current) {
        queueNewerMessages({
          hasNewerAfterFlush: hasNewerAfterMerge,
          isAtPresentAfterFlush: isAtPresentAfterMerge,
          incoming: newerUI,
        });
      } else {
        mergeVisibleMessages({
          incoming: newerUI,
          currentUserId: userId,
          trimFrom: 'old',
          hasNewer: hasNewerAfterMerge,
          isAtPresent: isAtPresentAfterMerge,
        });
        onMessagesLoaded?.(newerUI);
      }
    } catch (error) {
      console.error('Failed to reconcile missed messages after reconnect:', error);
    }
  }, [
    conversationId,
    decryptionConversation,
    historyAccessFence,
    initialHydrationSettled,
    mergeVisibleMessages,
    onMessagesLoaded,
    queueNewerMessages,
    userId,
  ]);

  useEffect(() => {
    if (!initialHydrationSettled || !isAtPresent || !hasQueuedNewer) {
      return;
    }

    flushQueuedNewerMessages({ currentUserId: userId, trimFrom: 'old' });
  }, [flushQueuedNewerMessages, hasQueuedNewer, initialHydrationSettled, isAtPresent, userId]);

  useEffect(() => {
    if (!encryptionKey || loading || syncing || !initialHydrationSettled) return;

    let lastResyncAt = 0;

    const runResync = (source: 'gateway_ready' | 'gateway_resumed' | 'tab_visible') => {
      const now = Date.now();
      if (now - lastResyncAt < 1500) {
        return;
      }
      lastResyncAt = now;
      void reconcileRecentMessages(source);
    };

    const handleReady = () => runResync('gateway_ready');
    const handleResumed = () => runResync('gateway_resumed');
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runResync('tab_visible');
      }
    };

    gateway.on('READY', handleReady);
    gateway.on('RESUMED', handleResumed);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      gateway.off('READY', handleReady);
      gateway.off('RESUMED', handleResumed);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [encryptionKey, initialHydrationSettled, loading, reconcileRecentMessages, syncing]);

  const jumpToPresent = useCallback(async () => {
    if (!encryptionKey) return;

    setLoadingNewer(true);

    try {
      const presentLimit = FETCH_SIZE;
      const fresh = await messageSync.readLocal(conversationId, { limit: presentLimit });
      const visibleFreshMessages = filterMessagesByHistoryFence(fresh.messages, historyAccessFence);
      const freshUI = sortMessages(visibleFreshMessages.map(toUIMessage));

      replaceWindow({
        messages: freshUI,
        firstItemIndex: messageListBaseIndex,
        groupBreakBeforeIds: new Set(),
        hasOlder: fresh.has_more,
        hasNewer: false,
        isAtPresent: true,
      });
      onMessagesLoaded?.(freshUI);
    } catch (error) {
      console.error('Failed to jump to present:', error);
    } finally {
      setLoadingNewer(false);
    }
  }, [
    conversationId,
    encryptionKey,
    historyAccessFence,
    messageListBaseIndex,
    onMessagesLoaded,
    replaceWindow,
  ]);

  return {
    jumpToPresent,
    loadNewer,
    loadOlder,
  };
};

export { useMessageListPagination };
