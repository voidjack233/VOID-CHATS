import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { MESSAGE_ACTIVE_WINDOW_SIZE, MESSAGE_PAGE_SIZE } from '../../../Chat/chatConstants';
import { messageSync } from '../../../Chat/chatSync';
import { getMessages, type Conversation, type Message } from '../../../Chat/chatService';
import { gateway } from '../../../Gateway/gateway';
import { type HistoryAccessFence, filterMessagesByHistoryFence } from './messageListHistory';
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
  setFirstItemIndex: Dispatch<SetStateAction<number>>;
  setGroupBreakBeforeIds: Dispatch<SetStateAction<Set<string>>>;
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
  replaceWindow,
  mergeVisibleMessages,
  applyPrependedWindow,
  loadingOlder,
  loadingNewer,
  hasOlder,
  hasNewer,
  isAtPresent,
  setFirstItemIndex,
  setGroupBreakBeforeIds,
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
  const pendingNewerMessagesRef = useRef<Message[]>([]);
  const pendingNewerHasMoreRef = useRef(false);
  const pendingNewerIsAtPresentRef = useRef(true);

  isAtPresentRef.current = isAtPresent;

  useEffect(() => {
    pendingNewerMessagesRef.current = [];
    pendingNewerHasMoreRef.current = false;
    pendingNewerIsAtPresentRef.current = true;
    setLoadingOlder(false);
    setLoadingNewer(false);
    setHasOlder(false);
    setHasNewer(false);
    setIsAtPresent(true);
    setFirstItemIndex(messageListBaseIndex);
    setGroupBreakBeforeIds(new Set());
  }, [conversationId, messageListBaseIndex]);

  const queuePendingNewerMessages = useCallback((incoming: Message[], options: {
    hasNewerAfterFlush: boolean;
    isAtPresentAfterFlush: boolean;
  }) => {
    if (incoming.length === 0) {
      pendingNewerHasMoreRef.current = options.hasNewerAfterFlush;
      pendingNewerIsAtPresentRef.current = options.isAtPresentAfterFlush;
      return;
    }

    const mergedPending = Array.from(
      new Map(
        [...pendingNewerMessagesRef.current, ...incoming].map((message) => [message.message_id, message])
      ).values()
    );

    pendingNewerMessagesRef.current = sortMessages(mergedPending);
    pendingNewerHasMoreRef.current = options.hasNewerAfterFlush;
    pendingNewerIsAtPresentRef.current = options.isAtPresentAfterFlush;
  }, []);

  const flushPendingNewerMessages = useCallback(() => {
    const pendingMessages = pendingNewerMessagesRef.current;
    if (pendingMessages.length === 0) {
      return false;
    }

    pendingNewerMessagesRef.current = [];
    const hasNewerAfterFlush = pendingNewerHasMoreRef.current;
    const isAtPresentAfterFlush = pendingNewerIsAtPresentRef.current;
    pendingNewerHasMoreRef.current = false;
    pendingNewerIsAtPresentRef.current = true;

    mergeVisibleMessages({
      incoming: pendingMessages,
      currentUserId: userId,
      trimFrom: 'old',
      hasNewer: hasNewerAfterFlush,
      isAtPresent: isAtPresentAfterFlush,
    });
    onMessagesLoaded?.(pendingMessages);
    return true;
  }, [mergeVisibleMessages, onMessagesLoaded, userId]);

  const applyOlderMessages = useCallback((olderMessages: Message[], seamBreakBeforeId: string) => {
    if (olderMessages.length === 0) return;

    const existingIds = new Set(messagesRef.current.map((message) => message.message_id));
    const prependedCount = olderMessages.filter((message) => !existingIds.has(message.message_id)).length;
    const mergedMessages = [...olderMessages, ...messagesRef.current];
    const uniqueMessages = Array.from(
      new Map(mergedMessages.map((message) => [message.message_id, message])).values()
    );
    const trimmedMessages = trimMessages(uniqueMessages, 'new', MESSAGE_ACTIVE_WINDOW_SIZE);

    messagesRef.current = trimmedMessages;
    applyPrependedWindow({
      messages: trimmedMessages,
      prependedCount,
      seamBreakBeforeId,
    });

    if (trimmedMessages.length < uniqueMessages.length) {
      setHasNewer(true);
      setIsAtPresent(false);
    }

    onMessagesLoaded?.(olderMessages);
  }, [applyPrependedWindow, messagesRef, onMessagesLoaded]);

  const fetchOlderMessages = useCallback(async (oldestMessageId: string, options?: { forceServer?: boolean }) => {
    const forceServer = options?.forceServer === true;
    let result: { messages: any[]; has_more: boolean };

    if (forceServer) {
      const localResult = await messageSync.readLocal(conversationId, {
        before: oldestMessageId,
        limit: FETCH_SIZE,
      });

      const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
        before: oldestMessageId,
        limit: FETCH_SIZE,
        conversation: decryptionConversation,
        userId,
        currentKeyVersion: currentKeyVersionRef.current,
      });
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

      if (result.messages.length < FETCH_SIZE || !result.has_more || hasUndecryptableMessage(result.messages)) {
        const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
          before: oldestMessageId,
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
    }

    const visibleOlderMessages = filterMessagesByHistoryFence(result.messages, historyAccessFence);
    return {
      olderUI: sortMessages(visibleOlderMessages.map(toUIMessage)),
      hasMore: result.has_more,
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
      return;
    }

    setLoadingOlder(true);

    try {
      const oldestMessage = messagesRef.current[0];
      if (!oldestMessage) return;

      const seamBreakBeforeId = oldestMessage.message_id;
      const { olderUI, hasMore } = await fetchOlderMessages(oldestMessage.message_id, { forceServer });

      if (olderUI.length > 0) {
        applyOlderMessages(olderUI, seamBreakBeforeId);
        setHasOlder(hasMore);
      } else {
        setHasOlder(false);
      }
    } catch (error) {
      console.error('Failed to load older messages:', error);
    } finally {
      setLoadingOlder(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyOlderMessages, fetchOlderMessages, hasOlder, loadingOlder, messagesRef, setHasOlder]);

  const loadOlder = useCallback(async () => {
    await loadOlderPage();
  }, [loadOlderPage]);

  const loadNewer = useCallback(async () => {
    if (!encryptionKeyRef.current || loadingNewer || !hasNewer || messages.length === 0) return;

    if (initialHydrationSettled && pendingNewerMessagesRef.current.length > 0) {
      flushPendingNewerMessages();
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
          queuePendingNewerMessages(newerUI, {
            hasNewerAfterFlush: hasNewerAfterMerge,
            isAtPresentAfterFlush: isAtPresentAfterMerge,
          });
          setHasNewer(true);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conversationId,
    decryptionConversation,
    hasNewer,
    historyAccessFence,
    initialHydrationSettled,
    loadingNewer,
    mergeVisibleMessages,
    messages,
    onMessagesLoaded,
    queuePendingNewerMessages,
    userId,
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
        queuePendingNewerMessages(newerUI, {
          hasNewerAfterFlush: hasNewerAfterMerge,
          isAtPresentAfterFlush: isAtPresentAfterMerge,
        });
        setHasNewer(true);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    conversationId,
    decryptionConversation,
    flushPendingNewerMessages,
    historyAccessFence,
    initialHydrationSettled,
    mergeVisibleMessages,
    onMessagesLoaded,
    queuePendingNewerMessages,
    userId,
  ]);

  useEffect(() => {
    if (!initialHydrationSettled || !isAtPresent) {
      return;
    }

    void flushPendingNewerMessages();
  }, [flushPendingNewerMessages, initialHydrationSettled, isAtPresent]);

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

      pendingNewerMessagesRef.current = [];
      pendingNewerHasMoreRef.current = false;
      pendingNewerIsAtPresentRef.current = true;
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
