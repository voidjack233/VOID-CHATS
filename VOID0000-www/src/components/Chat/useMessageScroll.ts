import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { type ListRange, type VirtuosoHandle } from 'react-virtuoso';
import { saveConversationScrollPosition } from '../../Services/hooks/Chats/useMessageList';
import type { Message } from '../../Services/Chat/chatService';

interface UseMessageScrollParams {
  conversationId: string;
  currentUserId?: string;
  visualMessages: Message[];
  loading: boolean;
  loadingOlder: boolean;
  prefetchingOlder: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  firstItemIndex: number;
  initialScrollToMessageId: string | null;
  newMessage?: Message | null;
  setIsAtPresent: (value: boolean) => void;
  jumpToPresent: () => Promise<void>;
  loadOlder: () => Promise<void>;
  prefetchOlder: () => void;
}

export function useMessageScroll({
  conversationId,
  currentUserId,
  visualMessages,
  loading,
  loadingOlder,
  prefetchingOlder,
  hasOlder,
  hasNewer,
  firstItemIndex,
  initialScrollToMessageId,
  newMessage,
  setIsAtPresent,
  jumpToPresent,
  loadOlder,
  prefetchOlder,
}: UseMessageScrollParams) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const atBottomRef = useRef(true);
  const canLoadOlderRef = useRef(false);
  const lastOlderTriggerMessageIdRef = useRef<string | null>(null);
  const lastRangeStartIndexRef = useRef<number | null>(null);
  const pendingStartReachedRef = useRef(false);
  const topLoadLockedRef = useRef(false);
  const scrollSeekActiveRef = useRef(false);
  const keepPinnedOnOpenRef = useRef(true);
  const forceFollowOutputRef = useRef(false);
  const mediaPinWindowUntilRef = useRef(0);
  const prevConversationIdRef = useRef<string | null>(null);
  const lastVisibleTopMessageIdRef = useRef<string | null>(null);
  const scrollRestoredRef = useRef(false);
  const scrollVelocityRef = useRef({ time: 0, top: 0 });
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasUnseenMessages, setHasUnseenMessages] = useState(false);
  const [scrollSeekExitTick, setScrollSeekExitTick] = useState(0);

  const handleScrollerRef = useCallback((element: HTMLElement | null | Window) => {
    if (element instanceof HTMLElement) {
      element.style.overflowAnchor = 'none';
    }
  }, []);

  useLayoutEffect(() => {
    if (prevConversationIdRef.current && prevConversationIdRef.current !== conversationId) {
      if (lastVisibleTopMessageIdRef.current) {
        saveConversationScrollPosition(prevConversationIdRef.current, lastVisibleTopMessageIdRef.current);
      }
    }

    prevConversationIdRef.current = conversationId;
    lastVisibleTopMessageIdRef.current = null;
    scrollRestoredRef.current = false;
    canLoadOlderRef.current = true;
    lastOlderTriggerMessageIdRef.current = null;
    lastRangeStartIndexRef.current = null;
    pendingStartReachedRef.current = false;
    topLoadLockedRef.current = false;
    scrollSeekActiveRef.current = false;
    keepPinnedOnOpenRef.current = true;
    forceFollowOutputRef.current = false;
    mediaPinWindowUntilRef.current = 0;
  }, [conversationId]);

  useEffect(() => {
    if (!loadingOlder && !prefetchingOlder) {
      topLoadLockedRef.current = false;
    }
  }, [loadingOlder, prefetchingOlder, visualMessages.length]);

  useEffect(() => {
    if (!newMessage) return;
    if (String(newMessage.conversation_id || conversationId) !== String(conversationId)) {
      return;
    }

    const hasAttachments = Array.isArray(newMessage.attachments) && newMessage.attachments.length > 0;
    if (hasAttachments && (newMessage.sender_id === currentUserId || atBottomRef.current)) {
      mediaPinWindowUntilRef.current = Date.now() + 4000;
    }

    if (newMessage.sender_id === currentUserId) {
      forceFollowOutputRef.current = true;
      return;
    }

    if (!atBottomRef.current) {
      setHasUnseenMessages(true);
    }
  }, [conversationId, currentUserId, newMessage]);

  const handleJumpToPresent = useCallback(async () => {
    forceFollowOutputRef.current = true;
    keepPinnedOnOpenRef.current = true;
    await jumpToPresent();
    setHasUnseenMessages(false);
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: 'LAST',
        align: 'end',
        behavior: 'smooth',
      });
    });
  }, [jumpToPresent]);

  useEffect(() => {
    if (
      !initialScrollToMessageId ||
      loading ||
      visualMessages.length === 0 ||
      scrollRestoredRef.current
    ) {
      return;
    }

    const targetIdx = visualMessages.findIndex((message) => message.message_id === initialScrollToMessageId);
    if (targetIdx < 0 || targetIdx === visualMessages.length - 1) {
      return;
    }

    scrollRestoredRef.current = true;
    keepPinnedOnOpenRef.current = false;

    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: firstItemIndex + targetIdx,
        align: 'start',
        behavior: 'auto',
      });
    });
  }, [firstItemIndex, initialScrollToMessageId, loading, visualMessages]);

  const handleVirtuosoScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const now = Date.now();
    const top = event.currentTarget.scrollTop;
    const dt = now - scrollVelocityRef.current.time;

    if (dt > 0 && dt < 200) {
      const velocity = (top - scrollVelocityRef.current.top) / dt;
      if (velocity < -1.5 && !topLoadLockedRef.current) {
        prefetchOlder();
      }
    }

    scrollVelocityRef.current = { time: now, top };
  }, [prefetchOlder]);

  const triggerOlderLoad = useCallback(() => {
    if (prefetchingOlder) {
      pendingStartReachedRef.current = true;
      return;
    }

    if (loadingOlder || !hasOlder || topLoadLockedRef.current) {
      return;
    }

    const oldestVisibleMessageId = visualMessages[0]?.message_id ?? null;
    if (oldestVisibleMessageId && lastOlderTriggerMessageIdRef.current === oldestVisibleMessageId) {
      return;
    }

    lastOlderTriggerMessageIdRef.current = oldestVisibleMessageId;
    pendingStartReachedRef.current = false;
    topLoadLockedRef.current = true;
    void loadOlder();
  }, [hasOlder, loadOlder, loadingOlder, prefetchingOlder, visualMessages]);

  const handleStartReached = useCallback(() => {
    if (!canLoadOlderRef.current || scrollSeekActiveRef.current || prefetchingOlder) {
      pendingStartReachedRef.current = true;
      return;
    }

    triggerOlderLoad();
  }, [prefetchingOlder, triggerOlderLoad]);

  const handleRangeChanged = useCallback((range: ListRange) => {
    const previousStartIndex = lastRangeStartIndexRef.current;
    lastRangeStartIndexRef.current = range.startIndex;

    if (previousStartIndex !== null && range.startIndex < previousStartIndex) {
      canLoadOlderRef.current = true;
      keepPinnedOnOpenRef.current = false;
    }

    const relativeStartIndex = range.startIndex - firstItemIndex;
    const topMsg = visualMessages[Math.max(0, relativeStartIndex)];
    if (topMsg) {
      lastVisibleTopMessageIdRef.current = topMsg.message_id;
    }

    if (relativeStartIndex > 6) {
      topLoadLockedRef.current = false;
      lastOlderTriggerMessageIdRef.current = null;
    }

    if (
      pendingStartReachedRef.current &&
      canLoadOlderRef.current &&
      !scrollSeekActiveRef.current &&
      !prefetchingOlder &&
      relativeStartIndex <= 1
    ) {
      triggerOlderLoad();
    }
  }, [firstItemIndex, prefetchingOlder, triggerOlderLoad, visualMessages]);

  const scrollSeekConfiguration = useMemo(() => ({
    enter: (velocity: number) => {
      const shouldEnter = Math.abs(velocity) > 1400;
      if (shouldEnter) {
        scrollSeekActiveRef.current = true;
      }
      return shouldEnter;
    },
    exit: (velocity: number) => {
      const shouldExit = Math.abs(velocity) < 120;
      if (shouldExit && scrollSeekActiveRef.current) {
        scrollSeekActiveRef.current = false;
        setScrollSeekExitTick((prev) => prev + 1);
      }
      return shouldExit;
    },
  }), []);

  useEffect(() => {
    const relativeStartIndex =
      lastRangeStartIndexRef.current === null
        ? null
        : lastRangeStartIndexRef.current - firstItemIndex;

    if (
      !scrollSeekActiveRef.current &&
      pendingStartReachedRef.current &&
      canLoadOlderRef.current &&
      !prefetchingOlder &&
      relativeStartIndex !== null &&
      relativeStartIndex <= 1
    ) {
      triggerOlderLoad();
    }
  }, [firstItemIndex, prefetchingOlder, scrollSeekExitTick, triggerOlderLoad]);

  const followOutput = useCallback((atBottom: boolean) => {
    if (loadingOlder) {
      return false;
    }
    if (forceFollowOutputRef.current) {
      return 'auto';
    }
    if (keepPinnedOnOpenRef.current || atBottom) {
      return 'auto';
    }
    return false;
  }, [loadingOlder]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
    if (atBottom) {
      setHasUnseenMessages(false);
      forceFollowOutputRef.current = false;
      mediaPinWindowUntilRef.current = 0;
    }
    setIsAtPresent(atBottom && !hasNewer);
  }, [hasNewer, setIsAtPresent]);

  const handleAttachmentLoad = useCallback(() => {
    const shouldStickToBottom =
      atBottomRef.current ||
      forceFollowOutputRef.current ||
      keepPinnedOnOpenRef.current ||
      mediaPinWindowUntilRef.current > Date.now();

    if (!shouldStickToBottom) {
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: 'LAST',
          align: 'end',
          behavior: 'auto',
        });
      });
    });
  }, []);

  return {
    virtuosoRef,
    isAtBottom,
    hasUnseenMessages,
    handleScrollerRef,
    handleVirtuosoScroll,
    handleStartReached,
    handleRangeChanged,
    scrollSeekConfiguration,
    handleJumpToPresent,
    followOutput,
    handleAtBottomStateChange,
    handleAttachmentLoad,
  };
}
