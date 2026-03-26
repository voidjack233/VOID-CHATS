import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import {
  MESSAGE_PAGE_SIZE,
  MESSAGE_PREFETCH_SIZE,
} from '../../../Chat/chatConstants';
import { messageSync } from '../../../Chat/chatSync';
import { getMessages, type Conversation, type Message } from '../../../Chat/chatService';
import { gateway } from '../../../Gateway/gateway';
import { type HistoryAccessFence, filterMessagesByHistoryFence } from './messageListHistory';
import {
  getNewestServerBackedMessage,
  mergeMessagesWithReconciliation,
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
  setMessages: Dispatch<SetStateAction<Message[]>>;
  loading: boolean;
  onMessagesLoaded?: (messages: Message[]) => void;
  prefetchedAfterLoadRef: MutableRefObject<boolean>;
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
  setMessages,
  loading,
  onMessagesLoaded,
  prefetchedAfterLoadRef,
  messageListBaseIndex,
}: UseMessageListPaginationParams) => {
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [prefetchingOlder, setPrefetchingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [isAtPresent, setIsAtPresent] = useState(true);
  const [firstItemIndex, setFirstItemIndex] = useState(messageListBaseIndex);
  const [groupBreakBeforeIds, setGroupBreakBeforeIds] = useState<Set<string>>(new Set());
  const prefetchingOlderRef = useRef(false);

  useEffect(() => {
    prefetchingOlderRef.current = false;
    setLoadingOlder(false);
    setPrefetchingOlder(false);
    setLoadingNewer(false);
    setHasOlder(false);
    setHasNewer(false);
    setIsAtPresent(true);
    setFirstItemIndex(messageListBaseIndex);
    setGroupBreakBeforeIds(new Set());
  }, [conversationId, messageListBaseIndex]);

  const applyOlderMessages = useCallback((olderMessages: Message[], seamBreakBeforeId: string) => {
    if (olderMessages.length === 0) return;

    const existingIds = new Set(messagesRef.current.map((message) => message.message_id));
    const prependedCount = olderMessages.filter((message) => !existingIds.has(message.message_id)).length;
    const mergedMessages = [...olderMessages, ...messagesRef.current];
    const uniqueMessages = Array.from(
      new Map(mergedMessages.map((message) => [message.message_id, message])).values()
    );
    const trimmedMessages = trimMessages(uniqueMessages, 'new');

    messagesRef.current = trimmedMessages;
    setMessages(trimmedMessages);

    if (trimmedMessages.length < uniqueMessages.length) {
      setHasNewer(true);
      setIsAtPresent(false);
    }

    if (prependedCount > 0) {
      setFirstItemIndex((previous) => previous - prependedCount);
    }

    setGroupBreakBeforeIds((previous) => {
      const nextBreaks = new Set(previous);
      nextBreaks.add(seamBreakBeforeId);
      return nextBreaks;
    });

    onMessagesLoaded?.(olderMessages);
  }, [messagesRef, onMessagesLoaded, setMessages]);

  const loadOlderPage = useCallback(async (options?: { silent?: boolean; forceServer?: boolean }) => {
    const isSilent = options?.silent === true;
    const forceServer = options?.forceServer === true;
    const fetchSize = isSilent ? MESSAGE_PREFETCH_SIZE : FETCH_SIZE;

    if (
      !encryptionKeyRef.current ||
      loadingOlder ||
      prefetchingOlderRef.current ||
      !hasOlder ||
      messagesRef.current.length === 0
    ) {
      return;
    }

    if (isSilent) {
      prefetchingOlderRef.current = true;
      setPrefetchingOlder(true);
    } else {
      setLoadingOlder(true);
    }

    try {
      const oldestMessage = messagesRef.current[0];
      if (!oldestMessage) return;

      const seamBreakBeforeId = oldestMessage.message_id;
      let result: { messages: any[]; has_more: boolean };

      if (forceServer) {
        const localResult = await messageSync.readLocal(conversationId, {
          before: oldestMessage.message_id,
          limit: fetchSize,
        });
        const localUI = sortMessages(localResult.messages.map(toUIMessage));
        applyOlderMessages(localUI, seamBreakBeforeId);

        const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
          before: oldestMessage.message_id,
          limit: fetchSize,
          conversation: decryptionConversation,
          userId,
          currentKeyVersion: currentKeyVersionRef.current,
        });
        const localMessages = await persistFetchedMessagesSafely(serverResult.messages);
        result = {
          messages: mergeLocalMessages(localResult.messages, localMessages),
          has_more: localResult.has_more || serverResult.has_more || serverResult.messages.length >= fetchSize,
        };
      } else {
        result = await messageSync.readLocal(conversationId, {
          before: oldestMessage.message_id,
          limit: fetchSize,
        });

        if (result.messages.length < fetchSize || !result.has_more || hasUndecryptableMessage(result.messages)) {
          const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
            before: oldestMessage.message_id,
            limit: fetchSize,
            conversation: decryptionConversation,
            userId,
            currentKeyVersion: currentKeyVersionRef.current,
          });
          const localMessages = await persistFetchedMessagesSafely(serverResult.messages);
          result = {
            messages: mergeLocalMessages(result.messages, localMessages),
            has_more: result.has_more || serverResult.has_more || serverResult.messages.length >= fetchSize,
          };
        }
      }

      const visibleOlderMessages = filterMessagesByHistoryFence(result.messages, historyAccessFence);
      const olderUI = sortMessages(visibleOlderMessages.map(toUIMessage));
      if (olderUI.length > 0) {
        applyOlderMessages(olderUI, seamBreakBeforeId);
        setHasOlder(result.has_more);
      } else {
        setHasOlder(false);
      }
    } catch (error) {
      console.error('Failed to load older messages:', error);
    } finally {
      if (isSilent) {
        prefetchingOlderRef.current = false;
        setPrefetchingOlder(false);
      } else {
        setLoadingOlder(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyOlderMessages, conversationId, decryptionConversation, hasOlder, historyAccessFence, loadingOlder, userId]);

  const loadOlder = useCallback(async () => {
    await loadOlderPage();
  }, [loadOlderPage]);

  useEffect(() => {
    if (loading || !hasOlder || !encryptionKey || prefetchedAfterLoadRef.current) return;

    prefetchedAfterLoadRef.current = true;
    const timer = window.setTimeout(() => {
      void loadOlderPage({ silent: true });
    }, 600);

    return () => window.clearTimeout(timer);
  }, [encryptionKey, hasOlder, loadOlderPage, loading, prefetchedAfterLoadRef]);

  const prefetchOlder = useCallback(() => {
    void loadOlderPage({ silent: true, forceServer: false });
  }, [loadOlderPage]);

  const loadNewer = useCallback(async () => {
    if (!encryptionKeyRef.current || loadingNewer || !hasNewer || messages.length === 0) return;

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
        setMessages((previous) =>
          mergeMessagesWithReconciliation({
            existing: previous,
            incoming: newerUI,
            currentUserId: userId,
            trimFrom: 'old',
            allowOptimisticFallback: true,
          })
        );

        if (newerUI.length < FETCH_SIZE) {
          setHasNewer(false);
          setIsAtPresent(true);
        } else {
          setHasNewer(result.has_more);
        }
        onMessagesLoaded?.(newerUI);
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
  }, [conversationId, decryptionConversation, hasNewer, historyAccessFence, loadingNewer, messages, onMessagesLoaded, userId]);

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
      setMessages((previous) =>
        mergeMessagesWithReconciliation({
          existing: previous,
          incoming: newerUI,
          currentUserId: userId,
          trimFrom: 'old',
          allowOptimisticFallback: true,
        })
      );
      setHasNewer(serverResult.has_more || serverResult.messages.length >= FETCH_SIZE);
      setIsAtPresent(!(serverResult.has_more || serverResult.messages.length >= FETCH_SIZE));
      onMessagesLoaded?.(newerUI);
    } catch (error) {
      console.error('Failed to reconcile missed messages after reconnect:', error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, decryptionConversation, historyAccessFence, onMessagesLoaded, userId]);

  useEffect(() => {
    if (!encryptionKey) return;

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
  }, [encryptionKey, reconcileRecentMessages]);

  const jumpToPresent = useCallback(async () => {
    if (!encryptionKey) return;

    setLoadingNewer(true);

    try {
      const fresh = await messageSync.readLocal(conversationId, { limit: FETCH_SIZE });
      const visibleFreshMessages = filterMessagesByHistoryFence(fresh.messages, historyAccessFence);
      const freshUI = sortMessages(visibleFreshMessages.map(toUIMessage));

      setMessages(freshUI);
      setFirstItemIndex(messageListBaseIndex);
      setGroupBreakBeforeIds(new Set());
      setHasOlder(fresh.has_more);
      setHasNewer(false);
      setIsAtPresent(true);
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
    setMessages,
  ]);

  return {
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
    setLoadingNewer,
    setLoadingOlder,
    setPrefetchingOlder,
  };
};

export { useMessageListPagination };
