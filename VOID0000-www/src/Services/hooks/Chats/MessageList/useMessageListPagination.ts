import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { debugLog } from '../../../utils/debugLog';
import {
  MESSAGE_PAGE_SIZE,
  MESSAGE_PREFETCH_SIZE,
  MESSAGE_WINDOW_TRIM_TARGET,
  MESSAGE_WINDOW_TRIM_TRIGGER,
} from '../../../Chat/chatConstants';
import { messageSync } from '../../../Chat/chatSync';
import { getMessages, type Conversation, type Message } from '../../../Chat/chatService';
import { getRetryAfterMsFromError, isRateLimitError } from '../../../Chat/chatUtils';
import type { LocalMessage } from '../../../Chat/chatStore';
import { gateway } from '../../../Gateway/gateway';
import { type HistoryAccessFence, filterMessagesByHistoryFence } from './messageListHistory';
import { debugMessageList, rawDebugMessageList } from './messageListDebug';
import {
  getNewestServerBackedMessage,
} from './messageListReconciliation';
import {
  hasUndecryptableMessage,
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
  getMessageHeight?: (message: Message) => number;
  messages: Message[];
  messagesRef: MutableRefObject<Message[]>;
  firstItemIndex: number;
  replaceWindow: (params: {
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
  }) => void;
  mergeVisibleMessages: (params: {
    incoming: Message[];
    currentUserId?: string;
    trimFrom?: 'old' | 'new';
    consumeBottomSpacerHeight?: number;
    clearBottomSpacer?: boolean;
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
    pageMessages: Message[];
    prependedCount: number;
    seamBreakBeforeId: string;
    topSpacerHeightConsume?: number;
    bottomSpacerHeightDelta?: number;
    trimmedFromNewMessages?: Message[];
  }) => void;
  applyAppendedWindow: (params: {
    messages: Message[];
    pageMessages: Message[];
    appendedCount: number;
    bottomSpacerHeightConsume?: number;
    clearBottomSpacer?: boolean;
    trimmedFromOldMessages?: Message[];
    hasNewer?: boolean;
    isAtPresent?: boolean;
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
  onHistoryRateLimited?: (retryAfterMs?: number) => void;
  messageListBaseIndex: number;
}

const FETCH_SIZE = MESSAGE_PAGE_SIZE;
const ESTIMATED_MESSAGE_HEIGHT = 72;
const PASSIVE_RECONCILE_TTL_MS = 15_000;
const MESSAGE_CREATE_RECONCILE_TTL_MS = 1_500;
const recentReconcileAtByConversation = new Map<string, number>();

const sumMessageHeights = (
  messages: Message[],
  getMessageHeight?: (message: Message) => number,
) => messages.reduce((total, message) => {
  const height = getMessageHeight?.(message);
  return total + (
    typeof height === 'number' && Number.isFinite(height) && height > 0
      ? height
      : ESTIMATED_MESSAGE_HEIGHT
  );
}, 0);

const useMessageListPagination = ({
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
  onHistoryRateLimited,
  messageListBaseIndex,
}: UseMessageListPaginationParams) => {
  const isAtPresentRef = useRef(isAtPresent);
  isAtPresentRef.current = isAtPresent;
  const firstItemIndexRef = useRef(firstItemIndex);
  firstItemIndexRef.current = firstItemIndex;
  const olderServerPrefetchInFlightRef = useRef<Set<string>>(new Set());
  const olderServerPrefetchedAnchorsRef = useRef<Set<string>>(new Set());
  const historyRequestGenerationRef = useRef(0);

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

  const notifyHistoryRateLimit = useCallback((error: unknown) => {
    if (!isRateLimitError(error)) {
      return false;
    }

    onHistoryRateLimited?.(getRetryAfterMsFromError(error) ?? undefined);
    return true;
  }, [onHistoryRateLimited]);

  useEffect(() => {
    historyRequestGenerationRef.current += 1;
    olderServerPrefetchInFlightRef.current.clear();
    olderServerPrefetchedAnchorsRef.current.clear();
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
  }, [conversationId, messageListBaseIndex, replaceWindow]);

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
      notifyHistoryRateLimit(error);
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
  }, [conversationId, currentKeyVersionRef, decryptionConversation, encryptionKeyRef, getOlderServerPrefetchState, notifyHistoryRateLimit, userId]);

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
    const sortedUniqueMessages = sortMessages(uniqueMessages);
    let nextMessages = sortedUniqueMessages;
    let trimmedFromNewMessages: Message[] = [];
    let bottomSpacerHeightDelta = 0;

    if (sortedUniqueMessages.length > MESSAGE_WINDOW_TRIM_TRIGGER) {
      nextMessages = sortedUniqueMessages.slice(0, MESSAGE_WINDOW_TRIM_TARGET);
      trimmedFromNewMessages = sortedUniqueMessages.slice(MESSAGE_WINDOW_TRIM_TARGET);
      bottomSpacerHeightDelta = sumMessageHeights(trimmedFromNewMessages, getMessageHeight);
    }

    messagesRef.current = nextMessages;
    debugMessageList('prepend_apply', {
      conversationId,
      prependedCount,
      prevFirstItemIndex,
      nextFirstItemIndex: prependedCount > 0
        ? prevFirstItemIndex - prependedCount
        : prevFirstItemIndex,
      prevCount,
      nextCount: nextMessages.length,
      firstPrependedId: prependedMessages[0]?.message_id || null,
      lastPrependedId: prependedMessages[prependedMessages.length - 1]?.message_id || null,
      trimmedFromNewCount: trimmedFromNewMessages.length,
      bottomSpacerHeightDelta,
    });
    debugMessageList('prepend_derived_rows', {
      conversationId,
      rawOlderMessages: olderMessages.length,
      renderedPrependedRows: prependedCount,
      derivedRowsAreSeparateItems: false,
      note: 'Date separators and grouping are rendered inside MessageItem, not as separate Virtuoso rows.',
    });
    applyPrependedWindow({
      messages: nextMessages,
      pageMessages: olderMessages,
      prependedCount,
      seamBreakBeforeId,
      topSpacerHeightConsume: sumMessageHeights(prependedMessages, getMessageHeight),
      bottomSpacerHeightDelta,
      trimmedFromNewMessages,
    });

    if (trimmedFromNewMessages.length > 0) {
      setHasNewer(true);
      setIsAtPresent(false);
    }

    onMessagesLoaded?.(olderMessages);
    return {
      prependedCount,
      prevCount,
      nextCount: nextMessages.length,
      trimmedVisibleCount: trimmedFromNewMessages.length,
      firstPrependedId: prependedMessages[0]?.message_id || null,
      lastPrependedId: prependedMessages[prependedMessages.length - 1]?.message_id || null,
    };
  }, [
    applyPrependedWindow,
    conversationId,
    getMessageHeight,
    messagesRef,
    onMessagesLoaded,
    setHasNewer,
    setIsAtPresent,
  ]);

  const applyNewerMessages = useCallback((
    newerMessages: Message[],
    options: {
      clearBottomSpacer: boolean;
      hasNewerAfterMerge: boolean;
    },
  ) => {
    const prevCount = messagesRef.current.length;
    const prevFirstItemIndex = firstItemIndexRef.current;
    const existingIds = new Set(messagesRef.current.map((message) => message.message_id));
    const appendedMessages = newerMessages.filter((message) => !existingIds.has(message.message_id));
    const appendedCount = appendedMessages.length;
    const mergedMessages = [...messagesRef.current, ...newerMessages];
    const uniqueMessages = Array.from(
      new Map(mergedMessages.map((message) => [message.message_id, message])).values()
    );
    const sortedUniqueMessages = sortMessages(uniqueMessages);
    let nextMessages = sortedUniqueMessages;
    let trimmedFromOldMessages: Message[] = [];

    if (sortedUniqueMessages.length > MESSAGE_WINDOW_TRIM_TRIGGER) {
      const trimCount = sortedUniqueMessages.length - MESSAGE_WINDOW_TRIM_TARGET;
      trimmedFromOldMessages = sortedUniqueMessages.slice(0, trimCount);
      nextMessages = sortedUniqueMessages.slice(trimCount);
    }

    const bottomSpacerHeightConsume = sumMessageHeights(appendedMessages, getMessageHeight);
    messagesRef.current = nextMessages;
    applyAppendedWindow({
      messages: nextMessages,
      pageMessages: newerMessages,
      appendedCount,
      bottomSpacerHeightConsume,
      clearBottomSpacer: options.clearBottomSpacer,
      trimmedFromOldMessages,
      hasNewer: options.hasNewerAfterMerge,
      // Geometry marks present only after the user physically reaches bottom.
      isAtPresent: false,
    });

    onMessagesLoaded?.(newerMessages);
    return {
      appendedCount,
      prevCount,
      nextCount: nextMessages.length,
      trimmedVisibleCount: trimmedFromOldMessages.length,
      prevFirstItemIndex,
      nextFirstItemIndex: trimmedFromOldMessages.length > 0
        ? prevFirstItemIndex + trimmedFromOldMessages.length
        : prevFirstItemIndex,
      firstAppendedId: appendedMessages[0]?.message_id || null,
      lastAppendedId: appendedMessages[appendedMessages.length - 1]?.message_id || null,
    };
  }, [
    applyAppendedWindow,
    getMessageHeight,
    messagesRef,
    onMessagesLoaded,
  ]);

  const clearNewerHistoryRange = useCallback(() => {
    applyAppendedWindow({
      messages: messagesRef.current,
      pageMessages: [],
      appendedCount: 0,
      clearBottomSpacer: true,
      trimmedFromOldMessages: [],
      hasNewer: false,
      isAtPresent: false,
    });
  }, [applyAppendedWindow, messagesRef]);

  const fetchOlderMessages = useCallback(async (oldestMessageId: string, options?: { forceServer?: boolean }) => {
    const forceServer = options?.forceServer === true;
    let result: { messages: LocalMessage[]; has_more: boolean };
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
        messages: localMessages,
        has_more: serverResult.has_more || serverResult.messages.length >= FETCH_SIZE,
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
        messages: localMessages,
        has_more: serverResult.has_more || serverResult.messages.length >= FETCH_SIZE,
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
      !encryptionKeyRef.current ||
      loadingOlder ||
      !hasOlder ||
      messagesRef.current.length === 0
    ) {
      return false;
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
    const requestGeneration = historyRequestGenerationRef.current;

    try {
      const oldestMessage = messagesRef.current[0];
      if (!oldestMessage) return false;

      const seamBreakBeforeId = oldestMessage.message_id;
      const { olderUI, hasMore, debug } = await fetchOlderMessages(oldestMessage.message_id, { forceServer });
      if (requestGeneration !== historyRequestGenerationRef.current) {
        debugMessageList('older_fetch_stale_skip', {
          conversationId,
          oldestMessageId: oldestMessage.message_id,
          requestGeneration,
          currentGeneration: historyRequestGenerationRef.current,
        });
        return false;
      }

      let applySummary: ReturnType<typeof applyOlderMessages> = null;
      const nextOldestLoadedMessageId = olderUI[0]?.message_id ?? null;

      if (olderUI.length > 0) {
        applySummary = applyOlderMessages(olderUI, seamBreakBeforeId);
        setHasOlder(hasMore);
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
          exhaustionStateCommitStrategy: 'immediate',
        };
        rawDebugMessageList('older_fetch_boundary', boundaryPayload);
        debugMessageList('older_fetch_boundary', boundaryPayload);
      }
      return true;
    } catch (error) {
      notifyHistoryRateLimit(error);
      console.error('Failed to load older messages:', error);
      return false;
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
    notifyHistoryRateLimit,
  ]);

  const loadOlder = useCallback(async () => {
    return loadOlderPage();
  }, [loadOlderPage]);

  const loadNewer = useCallback(async () => {
    if (!encryptionKeyRef.current || loadingNewer || !hasNewer || messages.length === 0) return false;

    setLoadingNewer(true);
    const requestGeneration = historyRequestGenerationRef.current;

    try {
      const newestMessage = getNewestServerBackedMessage(messages);
      if (!newestMessage) return false;

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
          // Newer pagination must stay contiguous. Local IndexedDB can already
          // contain a far-future live message, so merging sparse local rows here
          // can create a fake gap like "Thursday -> Today".
          messages: localMessages,
          has_more: serverResult.has_more || serverResult.messages.length >= FETCH_SIZE,
        };
      }

      const visibleNewerMessages = filterMessagesByHistoryFence(result.messages, historyAccessFence);
      const newerUI = sortMessages(visibleNewerMessages.map(toUIMessage));
      if (requestGeneration !== historyRequestGenerationRef.current) {
        debugMessageList('newer_fetch_stale_skip', {
          conversationId,
          newestMessageId: newestMessage.message_id,
          requestGeneration,
          currentGeneration: historyRequestGenerationRef.current,
        });
        return false;
      }

      if (newerUI.length > 0) {
        const reachedPresentBoundary = result.messages.length < FETCH_SIZE || !result.has_more;
        const hasNewerAfterMerge = reachedPresentBoundary ? false : result.has_more;
        const isAtPresentAfterMerge = !hasNewerAfterMerge;

        if (!initialHydrationSettled) {
          queueNewerMessages({
            hasNewerAfterFlush: hasNewerAfterMerge,
            isAtPresentAfterFlush: isAtPresentAfterMerge,
            incoming: newerUI,
          });
        } else {
          applyNewerMessages(newerUI, {
            clearBottomSpacer: reachedPresentBoundary,
            hasNewerAfterMerge,
          });
        }
      } else {
        clearNewerHistoryRange();
      }
      return true;
    } catch (error) {
      notifyHistoryRateLimit(error);
      console.error('Failed to load newer messages:', error);
      return false;
    } finally {
      setLoadingNewer(false);
    }
  }, [
    applyNewerMessages,
    clearNewerHistoryRange,
    conversationId,
    currentKeyVersionRef,
    decryptionConversation,
    encryptionKeyRef,
    hasNewer,
    historyAccessFence,
    initialHydrationSettled,
    loadingNewer,
    messages,
    notifyHistoryRateLimit,
    queueNewerMessages,
    setLoadingNewer,
    userId,
  ]);

  type RecentReconcileSource = 'gateway_ready' | 'gateway_resumed' | 'tab_visible' | 'message_create';

  const reconcileRecentMessages = useCallback(async (source: RecentReconcileSource) => {
    if (!encryptionKeyRef.current) return;

    const newestMessage = getNewestServerBackedMessage(messagesRef.current);
    if (!newestMessage) return;

    debugLog('[WS_RESYNC] reconciling active conversation after reconnect/visibility', {
      conversation_id: conversationId,
      source,
      after_message_id: newestMessage.message_id,
    });

    try {
      const latestServerResult = await getMessages(conversationId, encryptionKeyRef.current!, {
        limit: FETCH_SIZE,
        conversation: decryptionConversation,
        userId,
        currentKeyVersion: currentKeyVersionRef.current,
      });
      const latestLocalMessages = await persistFetchedMessagesSafely(latestServerResult.messages);
      const visibleLatestMessages = filterMessagesByHistoryFence(latestLocalMessages, historyAccessFence);
      const latestUI = sortMessages(visibleLatestMessages.map(toUIMessage));
      const visibleMessageIds = new Set(messagesRef.current.map((message) => String(message.message_id)));
      const latestPageTouchesCurrentWindow = latestUI.some(
        (message) => visibleMessageIds.has(String(message.message_id))
      );

      if (latestUI.length > 0 && isAtPresentRef.current) {
        mergeVisibleMessages({
          incoming: latestUI,
          currentUserId: userId,
          trimFrom: 'old',
          hasNewer: false,
          isAtPresent: true,
        });
        onMessagesLoaded?.(latestUI);
        return;
      }

      if (latestUI.length > 0 && latestPageTouchesCurrentWindow) {
        setHasNewer(true);
        setIsAtPresent(false);
      }

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
      notifyHistoryRateLimit(error);
      console.error('Failed to reconcile missed messages after reconnect:', error);
    }
  }, [
    conversationId,
    currentKeyVersionRef,
    decryptionConversation,
    encryptionKeyRef,
    historyAccessFence,
    initialHydrationSettled,
    mergeVisibleMessages,
    messagesRef,
    notifyHistoryRateLimit,
    onMessagesLoaded,
    queueNewerMessages,
    setHasNewer,
    setIsAtPresent,
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

    const runResync = (source: RecentReconcileSource) => {
      const now = Date.now();
      if (now - lastResyncAt < 1500) {
        return;
      }

      const reconcileKey = `${conversationId}:${source === 'message_create' ? 'message_create' : 'passive'}`;
      const ttl = source === 'message_create'
        ? MESSAGE_CREATE_RECONCILE_TTL_MS
        : PASSIVE_RECONCILE_TTL_MS;
      const lastConversationResyncAt = recentReconcileAtByConversation.get(reconcileKey) ?? 0;
      if (now - lastConversationResyncAt < ttl) {
        return;
      }

      lastResyncAt = now;
      recentReconcileAtByConversation.set(reconcileKey, now);
      void reconcileRecentMessages(source);
    };

    const handleReady = () => runResync('gateway_ready');
    const handleResumed = () => runResync('gateway_resumed');
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runResync('tab_visible');
      }
    };
    const handleMessageCreate = (data: { conversation_id?: string | null }) => {
      if (String(data?.conversation_id || '') === String(conversationId)) {
        runResync('message_create');
      }
    };

    gateway.on('READY', handleReady);
    gateway.on('RESUMED', handleResumed);
    gateway.on('MESSAGE_CREATE', handleMessageCreate);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      gateway.off('READY', handleReady);
      gateway.off('RESUMED', handleResumed);
      gateway.off('MESSAGE_CREATE', handleMessageCreate);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [conversationId, encryptionKey, initialHydrationSettled, loading, reconcileRecentMessages, syncing]);

  const jumpToPresent = useCallback(async () => {
    if (!encryptionKey) return;

    historyRequestGenerationRef.current += 1;
    const requestGeneration = historyRequestGenerationRef.current;
    setLoadingNewer(true);

    try {
      const presentLimit = FETCH_SIZE;
      const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
        limit: presentLimit,
        conversation: decryptionConversation,
        userId,
        currentKeyVersion: currentKeyVersionRef.current,
      });
      const localMessages = await persistFetchedMessagesSafely(serverResult.messages);
      const visibleFreshMessages = filterMessagesByHistoryFence(localMessages, historyAccessFence);
      const freshUI = sortMessages(visibleFreshMessages.map(toUIMessage));
      if (requestGeneration !== historyRequestGenerationRef.current) {
        return;
      }

      replaceWindow({
        messages: freshUI,
        firstItemIndex: messageListBaseIndex,
        groupBreakBeforeIds: new Set(),
        loadingOlder: false,
        loadingNewer: false,
        hasOlder: serverResult.has_more || serverResult.messages.length >= presentLimit,
        hasNewer: false,
        isAtPresent: true,
      });
      onMessagesLoaded?.(freshUI);
    } catch (error) {
      notifyHistoryRateLimit(error);
      console.error('Failed to jump to present:', error);
    } finally {
      setLoadingNewer(false);
    }
  }, [
    conversationId,
    currentKeyVersionRef,
    decryptionConversation,
    encryptionKey,
    encryptionKeyRef,
    historyAccessFence,
    messageListBaseIndex,
    notifyHistoryRateLimit,
    onMessagesLoaded,
    replaceWindow,
    setLoadingNewer,
    userId,
  ]);

  return {
    jumpToPresent,
    loadNewer,
    loadOlder,
  };
};

export { useMessageListPagination };
