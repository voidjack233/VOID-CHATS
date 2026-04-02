import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { MESSAGE_PAGE_SIZE } from '../../../Chat/chatConstants';
import { messageSync } from '../../../Chat/chatSync';
import { type Conversation, type Message } from '../../../Chat/chatService';
import { type HistoryAccessFence, filterMessagesByHistoryFence } from './messageListHistory';
import { mergeMessagesWithReconciliation } from './messageListReconciliation';
import { sortMessages, toUIMessage } from './messageListPersistence';
import {
  getConversationWindowSnapshot,
  resolveInitialHasOlder,
} from './messageListWindowCache';

interface UseMessageListLoadingParams {
  conversationId: string;
  conversationKeyVersion: number;
  decryptionConversation: Conversation;
  historyAccessFence: HistoryAccessFence | null;
  hasEncryptionKey: boolean;
  userId?: string;
  onMessagesLoaded?: (messages: Message[]) => void;
  messageListBaseIndex: number;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setSyncing: Dispatch<SetStateAction<boolean>>;
  setHasOlder: Dispatch<SetStateAction<boolean>>;
  setHasNewer: Dispatch<SetStateAction<boolean>>;
  setIsAtPresent: Dispatch<SetStateAction<boolean>>;
  setFirstItemIndex: Dispatch<SetStateAction<number>>;
  setGroupBreakBeforeIds: Dispatch<SetStateAction<Set<string>>>;
  setPrefetchingOlder: Dispatch<SetStateAction<boolean>>;
  setInitialHydrationSettled: Dispatch<SetStateAction<boolean>>;
  encryptionKeyRef: MutableRefObject<CryptoKey | null>;
  currentKeyVersionRef: MutableRefObject<number>;
  messagesRef: MutableRefObject<Message[]>;
  lastLoadedConversationIdRef: MutableRefObject<string | null>;
  prefetchedAfterLoadRef: MutableRefObject<boolean>;
  observedConversationKeyVersionRef: MutableRefObject<number>;
  pendingConversationKeyRefreshRef: MutableRefObject<number | null>;
  keyVersionRefreshInFlightRef: MutableRefObject<number | null>;
}

const INITIAL_OPEN_LIMIT = MESSAGE_PAGE_SIZE;

const useMessageListLoading = ({
  conversationId,
  conversationKeyVersion,
  decryptionConversation,
  historyAccessFence,
  hasEncryptionKey,
  userId,
  onMessagesLoaded,
  messageListBaseIndex,
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
}: UseMessageListLoadingParams) => {
  useEffect(() => {
    prefetchedAfterLoadRef.current = false;
    observedConversationKeyVersionRef.current = conversationKeyVersion;
    pendingConversationKeyRefreshRef.current = null;
    keyVersionRefreshInFlightRef.current = null;
  }, [
    conversationId,
    conversationKeyVersion,
    keyVersionRefreshInFlightRef,
    observedConversationKeyVersionRef,
    pendingConversationKeyRefreshRef,
    prefetchedAfterLoadRef,
  ]);

  useEffect(() => {
    const previousVersion = observedConversationKeyVersionRef.current;
    if (conversationKeyVersion > previousVersion) {
      pendingConversationKeyRefreshRef.current = conversationKeyVersion;
    }
    observedConversationKeyVersionRef.current = conversationKeyVersion;
  }, [
    conversationId,
    conversationKeyVersion,
    observedConversationKeyVersionRef,
    pendingConversationKeyRefreshRef,
  ]);

  useEffect(() => {
    let ignore = false;
    const sessionSnapshot = getConversationWindowSnapshot(conversationId);
    const initialLimit = INITIAL_OPEN_LIMIT;

    const settleInitialHydration = () => {
      if (!ignore) {
        setInitialHydrationSettled(true);
      }
    };

    const resetVisibleWindow = () => {
      setMessages([]);
      setHasOlder(false);
      setHasNewer(false);
      setIsAtPresent(true);
      setFirstItemIndex(messageListBaseIndex);
      setGroupBreakBeforeIds(new Set());
      setPrefetchingOlder(false);
      setLoading(true);
    };

    const applyVisibleMessages = (
      nextMessages: Message[],
      shouldPreserveMessages: boolean,
      trimFrom: 'old' | 'new' = 'old',
    ) => {
      if (shouldPreserveMessages) {
        setMessages((previous) => {
          if (previous.length === 0) return nextMessages;
          return mergeMessagesWithReconciliation({
            existing: previous,
            incoming: nextMessages,
            currentUserId: userId,
            trimFrom,
            allowOptimisticFallback: true,
          });
        });
        return;
      }

      setMessages(nextMessages);
    };

    const loadLocalOnly = async () => {
      const shouldPreserveMessages = lastLoadedConversationIdRef.current === conversationId;
      lastLoadedConversationIdRef.current = conversationId;

      if (!shouldPreserveMessages) {
        resetVisibleWindow();
      }

      try {
        const cached = await messageSync.readLocal(conversationId, { limit: initialLimit });
        if (ignore) return;

        const visibleCachedMessages = filterMessagesByHistoryFence(cached.messages, historyAccessFence);
        const uiMessages = sortMessages(visibleCachedMessages.map(toUIMessage));

        if (uiMessages.length > 0) {
          applyVisibleMessages(uiMessages, shouldPreserveMessages);
          onMessagesLoaded?.(uiMessages);
        } else if (!shouldPreserveMessages) {
          setMessages([]);
        }

        setHasOlder(resolveInitialHasOlder({
          localHasMore: cached.has_more,
          localCount: uiMessages.length,
          requestedLimit: initialLimit,
          sessionSnapshot,
        }));
        setHasNewer(false);
        setIsAtPresent(true);
        setLoading(false);
        setSyncing(false);
        settleInitialHydration();
      } catch (error) {
        if (ignore) return;
        console.error('Failed to load cached messages without an encryption key:', error);
        setLoading(false);
        setSyncing(false);
        settleInitialHydration();
      }
    };

    const load = async () => {
      const shouldPreserveMessages = lastLoadedConversationIdRef.current === conversationId;
      lastLoadedConversationIdRef.current = conversationId;

      if (!shouldPreserveMessages) {
        resetVisibleWindow();
      }

      try {
        const { cached, syncPromise } = await messageSync.loadConversation(
          conversationId,
          encryptionKeyRef.current!,
          {
            preferSessionCache: true,
            initialLimit,
            syncLimit: INITIAL_OPEN_LIMIT,
            conversation: decryptionConversation,
            userId,
            currentKeyVersion: currentKeyVersionRef.current,
          }
        );

        if (ignore) return;

        if (cached.messages.length > 0) {
          const visibleCachedMessages = filterMessagesByHistoryFence(cached.messages, historyAccessFence);
          const uiMessages = sortMessages(visibleCachedMessages.map(toUIMessage));

          applyVisibleMessages(uiMessages, shouldPreserveMessages);
          setHasOlder(resolveInitialHasOlder({
            localHasMore: cached.has_more,
            localCount: uiMessages.length,
            requestedLimit: initialLimit,
            sessionSnapshot,
          }));
          setLoading(false);
          onMessagesLoaded?.(uiMessages);

          setSyncing(true);
          const syncResult = await syncPromise;
          if (ignore) return;

          setSyncing(false);
          setHasOlder((previous) => previous || syncResult.hasMore);

          if (syncResult.newMessages.length > 0) {
            const fresh = await messageSync.readLocal(conversationId, { limit: initialLimit });
            if (ignore) return;

            const visibleFreshMessages = filterMessagesByHistoryFence(fresh.messages, historyAccessFence);
            const freshUI = sortMessages(visibleFreshMessages.map(toUIMessage));
            setMessages((previous) =>
              mergeMessagesWithReconciliation({
                existing: previous,
                incoming: freshUI,
                currentUserId: userId,
                trimFrom: 'old',
                allowOptimisticFallback: true,
              })
            );
            setHasOlder(resolveInitialHasOlder({
              localHasMore: fresh.has_more,
              localCount: freshUI.length,
              requestedLimit: initialLimit,
              sessionSnapshot,
              syncHasMore: syncResult.hasMore,
            }));
            onMessagesLoaded?.(freshUI);
          }
          settleInitialHydration();
          return;
        }

        setSyncing(true);
        const syncResult = await syncPromise;
        if (ignore) return;
        setSyncing(false);

        const fresh = await messageSync.readLocal(conversationId, { limit: initialLimit });
        if (ignore) return;

        const visibleFreshMessages = filterMessagesByHistoryFence(fresh.messages, historyAccessFence);
        const freshUI = sortMessages(visibleFreshMessages.map(toUIMessage));

        if (shouldPreserveMessages) {
          setMessages((previous) => {
            if (freshUI.length === 0) return previous;
            return mergeMessagesWithReconciliation({
              existing: previous,
              incoming: freshUI,
              currentUserId: userId,
              trimFrom: 'old',
              allowOptimisticFallback: true,
            });
          });
        } else {
          setMessages(freshUI);
        }

        setHasOlder(resolveInitialHasOlder({
          localHasMore: fresh.has_more,
          localCount: freshUI.length,
          requestedLimit: initialLimit,
          sessionSnapshot,
          syncHasMore: syncResult.hasMore,
        }));
        setLoading(false);
        onMessagesLoaded?.(freshUI);
        settleInitialHydration();
      } catch (error) {
        if (ignore) return;
        console.error('Failed to load messages:', error);
        setLoading(false);
        setSyncing(false);
        settleInitialHydration();
      }
    };

    if (!encryptionKeyRef.current) {
      void loadLocalOnly();
      return () => { ignore = true; };
    }

    void load();
    return () => { ignore = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, decryptionConversation, hasEncryptionKey, historyAccessFence, userId, onMessagesLoaded]);

  useEffect(() => {
    const pendingVersion = pendingConversationKeyRefreshRef.current;
    if (
      !pendingVersion ||
      !encryptionKeyRef.current ||
      currentKeyVersionRef.current < pendingVersion ||
      keyVersionRefreshInFlightRef.current === pendingVersion
    ) {
      return;
    }

    let ignore = false;
    keyVersionRefreshInFlightRef.current = pendingVersion;

    const refreshForKeyVersionBump = async () => {
      const sessionSnapshot = getConversationWindowSnapshot(conversationId);
      const refreshLimit = Math.max(
        INITIAL_OPEN_LIMIT,
        messagesRef.current.length,
      );

      console.log('[KEY_VERSION_REFRESH] forcing current window refresh after conversation key bump', {
        conversation_id: conversationId,
        conversation_key_version: pendingVersion,
        resolved_key_version: currentKeyVersionRef.current,
        refresh_limit: refreshLimit,
      });

      setSyncing(true);

      try {
        messageSync.invalidateConversation(conversationId);
        const { syncPromise } = await messageSync.loadConversation(
          conversationId,
          encryptionKeyRef.current!,
          {
            forceSync: true,
            preferSessionCache: true,
            initialLimit: refreshLimit,
            syncLimit: refreshLimit,
            conversation: decryptionConversation,
            userId,
            currentKeyVersion: currentKeyVersionRef.current,
          }
        );

        const syncResult = await syncPromise;
        if (ignore) return;

        const fresh = await messageSync.readLocal(conversationId, { limit: refreshLimit });
        if (ignore) return;

        const visibleFreshMessages = filterMessagesByHistoryFence(fresh.messages, historyAccessFence);
        const freshUI = sortMessages(visibleFreshMessages.map(toUIMessage));

        if (freshUI.length > 0) {
          setMessages((previous) =>
            mergeMessagesWithReconciliation({
              existing: previous,
              incoming: freshUI,
              currentUserId: userId,
              trimFrom: 'old',
              allowOptimisticFallback: true,
            })
          );
        }

        setHasOlder(resolveInitialHasOlder({
          localHasMore: fresh.has_more,
          localCount: freshUI.length,
          requestedLimit: refreshLimit,
          sessionSnapshot,
          syncHasMore: syncResult.hasMore,
        }));
        onMessagesLoaded?.(freshUI);
        pendingConversationKeyRefreshRef.current = null;
      } catch (error) {
        console.error('Failed to refresh current window after key version bump:', error);
      } finally {
        if (!ignore) {
          setSyncing(false);
        }
        if (keyVersionRefreshInFlightRef.current === pendingVersion) {
          keyVersionRefreshInFlightRef.current = null;
        }
      }
    };

    void refreshForKeyVersionBump();
    return () => {
      ignore = true;
    };
  }, [
    conversationId,
    conversationKeyVersion,
    currentKeyVersionRef,
    decryptionConversation,
    encryptionKeyRef,
    historyAccessFence,
    keyVersionRefreshInFlightRef,
    messagesRef,
    onMessagesLoaded,
    pendingConversationKeyRefreshRef,
    setHasOlder,
    setMessages,
    setSyncing,
    userId,
  ]);
};

export { useMessageListLoading };
