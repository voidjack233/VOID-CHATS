import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import {
  MESSAGE_INITIAL_PAGE_SIZE,
} from '../../../Chat/chatConstants';
import { messageSync } from '../../../Chat/chatSync';
import { getMessages, type Conversation, type Message } from '../../../Chat/chatService';
import { type HistoryAccessFence, filterMessagesByHistoryFence } from './messageListHistory';
import {
  persistFetchedMessagesSafely,
  sortMessages,
  toUIMessage,
} from './messageListPersistence';
import {
  getConversationWindowSnapshot,
  resolveInitialHasOlder,
} from './messageListWindowCache';
import {
  getRenderedMessages,
  getSavedConversationRuntime,
  type ConversationRuntime,
} from './messageListRuntime';

interface UseMessageListLoadingParams {
  conversationId: string;
  conversationKeyVersion: number;
  decryptionConversation: Conversation;
  historyAccessFence: HistoryAccessFence | null;
  hasEncryptionKey: boolean;
  userId?: string;
  onMessagesLoaded?: (messages: Message[]) => void;
  messageListBaseIndex: number;
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
  restoreRuntime: (params: {
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
  }) => void;
  mergeVisibleMessages: (params: {
    incoming: Message[];
    currentUserId?: string;
    trimFrom?: 'old' | 'new';
    hasOlder?: boolean;
    hasNewer?: boolean;
    isAtPresent?: boolean;
  }) => void;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setSyncing: Dispatch<SetStateAction<boolean>>;
  setHasOlder: Dispatch<SetStateAction<boolean>>;
  setInitialHydrationSettled: Dispatch<SetStateAction<boolean>>;
  encryptionKeyRef: MutableRefObject<CryptoKey | null>;
  currentKeyVersionRef: MutableRefObject<number>;
  messagesRef: MutableRefObject<Message[]>;
  lastLoadedConversationIdRef: MutableRefObject<string | null>;
  observedConversationKeyVersionRef: MutableRefObject<number>;
  pendingConversationKeyRefreshRef: MutableRefObject<number | null>;
  keyVersionRefreshInFlightRef: MutableRefObject<number | null>;
}

const INITIAL_OPEN_LIMIT = MESSAGE_INITIAL_PAGE_SIZE;

const resolveInitialOpenLimit = () => INITIAL_OPEN_LIMIT;

const useMessageListLoading = ({
  conversationId,
  conversationKeyVersion,
  decryptionConversation,
  historyAccessFence,
  hasEncryptionKey,
  userId,
  onMessagesLoaded,
  messageListBaseIndex,
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
}: UseMessageListLoadingParams) => {
  useEffect(() => {
    observedConversationKeyVersionRef.current = conversationKeyVersion;
    pendingConversationKeyRefreshRef.current = null;
    keyVersionRefreshInFlightRef.current = null;
  }, [
    conversationId,
    conversationKeyVersion,
    keyVersionRefreshInFlightRef,
    observedConversationKeyVersionRef,
    pendingConversationKeyRefreshRef,
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
    const initialLimit = resolveInitialOpenLimit();

    const settleInitialHydration = () => {
      if (!ignore) {
        setInitialHydrationSettled(true);
      }
    };

    const resetVisibleWindow = () => {
      replaceWindow({
        messages: [],
        firstItemIndex: messageListBaseIndex,
        groupBreakBeforeIds: new Set(),
        loading: true,
        syncing: false,
        loadingOlder: false,
        loadingNewer: false,
        hasOlder: false,
        hasNewer: false,
        isAtPresent: true,
      });
    };

    const restoreSavedRuntime = () => {
      const savedRuntime = getSavedConversationRuntime(conversationId);
      if (!savedRuntime) {
        return false;
      }

      const savedMessages = getRenderedMessages(savedRuntime);
      if (savedMessages.length === 0) {
        return false;
      }

      restoreRuntime({
        runtime: savedRuntime,
        firstItemIndex: messageListBaseIndex,
        groupBreakBeforeIds: new Set(),
        loading: false,
        syncing: false,
        initialHydrationSettled: true,
        loadingOlder: false,
        loadingNewer: false,
        hasOlder: savedRuntime.hasOlder,
        hasNewer: savedRuntime.hasNewer,
        isAtPresent: !savedRuntime.hasNewer,
      });
      onMessagesLoaded?.(savedMessages);
      settleInitialHydration();
      return true;
    };

    const applyVisibleMessages = (
      nextMessages: Message[],
      shouldPreserveMessages: boolean,
      trimFrom: 'old' | 'new' = 'old',
      options?: {
        hasOlder?: boolean;
        hasNewer?: boolean;
        isAtPresent?: boolean;
        loading?: boolean;
        syncing?: boolean;
      },
    ) => {
      if (shouldPreserveMessages) {
        if (nextMessages.length === 0) {
          return;
        }

        mergeVisibleMessages({
          incoming: nextMessages,
          currentUserId: userId,
          trimFrom,
          hasOlder: options?.hasOlder,
          hasNewer: options?.hasNewer,
          isAtPresent: options?.isAtPresent,
        });
        return;
      }

      replaceWindow({
        messages: nextMessages,
        firstItemIndex: messageListBaseIndex,
        groupBreakBeforeIds: new Set(),
        loading: options?.loading,
        syncing: options?.syncing,
        hasOlder: options?.hasOlder,
        hasNewer: options?.hasNewer,
        isAtPresent: options?.isAtPresent,
      });
    };

    const fetchAuthoritativeLatestWindow = async (limit: number) => {
      const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
        limit,
        conversation: decryptionConversation,
        userId,
        currentKeyVersion: currentKeyVersionRef.current,
      });
      const localServerMessages = await persistFetchedMessagesSafely(serverResult.messages);
      const visibleServerMessages = filterMessagesByHistoryFence(localServerMessages, historyAccessFence);
      const serverUI = sortMessages(visibleServerMessages.map(toUIMessage));

      return {
        messages: serverUI,
        hasOlder: serverResult.has_more || serverResult.messages.length >= limit,
      };
    };

    const loadLocalOnly = async () => {
      const shouldPreserveMessages = lastLoadedConversationIdRef.current === conversationId;
      lastLoadedConversationIdRef.current = conversationId;

      if (!shouldPreserveMessages && restoreSavedRuntime()) {
        return;
      }

      if (!shouldPreserveMessages) {
        resetVisibleWindow();
      }

      try {
        const cached = await messageSync.readLocal(conversationId, { limit: initialLimit });
        if (ignore) return;

        const visibleCachedMessages = filterMessagesByHistoryFence(cached.messages, historyAccessFence);
        const uiMessages = sortMessages(visibleCachedMessages.map(toUIMessage));

        if (uiMessages.length > 0) {
          applyVisibleMessages(uiMessages, shouldPreserveMessages, 'old', {
            hasOlder: resolveInitialHasOlder({
              localHasMore: cached.has_more,
              localCount: uiMessages.length,
              requestedLimit: initialLimit,
              sessionSnapshot,
            }),
            hasNewer: false,
            isAtPresent: true,
            loading: false,
            syncing: false,
          });
          onMessagesLoaded?.(uiMessages);
        } else if (!shouldPreserveMessages) {
          replaceWindow({
            messages: [],
            firstItemIndex: messageListBaseIndex,
            groupBreakBeforeIds: new Set(),
            hasOlder: false,
            hasNewer: false,
            isAtPresent: true,
            loading: false,
            syncing: false,
          });
        }
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

      if (!shouldPreserveMessages && restoreSavedRuntime()) {
        return;
      }

      if (!shouldPreserveMessages) {
        resetVisibleWindow();
        // Force one fresh validation sync when a conversation is opened again in the UI.
        // Cached messages still render immediately, but we should not trust the previous
        // session-validation result to answer "does older history exist?" for this open.
        messageSync.invalidateConversation(conversationId);
      }

      try {
        const { cached, syncPromise } = await messageSync.loadConversation(
          conversationId,
          encryptionKeyRef.current!,
          {
            forceSync: true,
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
          const resolvedHasOlder = resolveInitialHasOlder({
            localHasMore: cached.has_more,
            localCount: uiMessages.length,
            requestedLimit: initialLimit,
            sessionSnapshot,
          });

          applyVisibleMessages(uiMessages, shouldPreserveMessages, 'old', {
            hasOlder: resolvedHasOlder,
            hasNewer: false,
            isAtPresent: true,
            loading: false,
          });
          onMessagesLoaded?.(uiMessages);

          setSyncing(true);
          const syncResult = await syncPromise;
          if (ignore) return;

          setSyncing(false);
          setHasOlder((previous) => previous || syncResult.hasMore);

          const authoritative = await fetchAuthoritativeLatestWindow(initialLimit);
          if (ignore) return;

          applyVisibleMessages(authoritative.messages, false, 'old', {
            hasOlder: authoritative.hasOlder || syncResult.hasMore,
            hasNewer: false,
            isAtPresent: true,
            loading: false,
            syncing: false,
          });
          onMessagesLoaded?.(authoritative.messages);
          settleInitialHydration();
          return;
        }

        setSyncing(true);
        const syncResult = await syncPromise;
        if (ignore) return;
        setSyncing(false);

        const authoritative = await fetchAuthoritativeLatestWindow(initialLimit);
        if (ignore) return;

        applyVisibleMessages(authoritative.messages, false, 'old', {
          hasOlder: authoritative.hasOlder || syncResult.hasMore,
          hasNewer: false,
          isAtPresent: true,
          loading: false,
          syncing: false,
        });
        onMessagesLoaded?.(authoritative.messages);
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
          mergeVisibleMessages({
            incoming: freshUI,
            currentUserId: userId,
            trimFrom: 'old',
            hasOlder: resolveInitialHasOlder({
              localHasMore: fresh.has_more,
              localCount: freshUI.length,
              requestedLimit: refreshLimit,
              sessionSnapshot,
              syncHasMore: syncResult.hasMore,
            }),
          });
        } else {
          setHasOlder(resolveInitialHasOlder({
            localHasMore: fresh.has_more,
            localCount: freshUI.length,
            requestedLimit: refreshLimit,
            sessionSnapshot,
            syncHasMore: syncResult.hasMore,
          }));
        }
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
    mergeVisibleMessages,
    replaceWindow,
    setHasOlder,
    setSyncing,
    userId,
  ]);
};

export { useMessageListLoading };
