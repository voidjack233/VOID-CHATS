import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type ListRange, type VirtuosoHandle } from 'react-virtuoso';
import { saveConversationScrollPosition } from '../../Services/hooks/Chats/useMessageList';
import type { Message } from '../../Services/Chat/chatService';

interface UseMessageScrollParams {
  conversationId: string;
  currentUserId?: string;
  visualMessages: Message[];
  loading: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  prefetchingOlder: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  initialHydrationSettled: boolean;
  firstItemIndex: number;
  topLoadingPlaceholderCount: number;
  initialScrollToMessageId: string | null;
  newMessage?: Message | null;
  setIsAtPresent: (value: boolean) => void;
  jumpToPresent: () => Promise<void>;
  loadOlder: () => Promise<void>;
}

export function useMessageScroll({
  conversationId,
  currentUserId,
  visualMessages,
  loading: _loading,
  loadingOlder,
  loadingNewer: _loadingNewer,
  prefetchingOlder,
  hasOlder,
  hasNewer,
  initialHydrationSettled,
  firstItemIndex,
  topLoadingPlaceholderCount: _topLoadingPlaceholderCount,
  initialScrollToMessageId: _initialScrollToMessageId,
  newMessage,
  setIsAtPresent,
  jumpToPresent,
  loadOlder,
}: UseMessageScrollParams) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerElementRef = useRef<HTMLElement | null>(null);
  const atBottomRef = useRef(true);
  const forceFollowOutputRef = useRef(false);
  const initialLatestRestoreDoneRef = useRef(false);
  const lastVisibleTopMessageIdRef = useRef<string | null>(null);
  const previousFirstItemIndexRef = useRef(firstItemIndex);
  const savedAnchorRef = useRef<{ id: string; top: number } | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasUnseenMessages, setHasUnseenMessages] = useState(false);
  const [scrollSeekExitTick, setScrollSeekExitTick] = useState(0);

  const handleScrollerRef = useCallback((element: HTMLElement | null | Window) => {
    if (element instanceof HTMLElement) {
      scrollerElementRef.current = element;
      element.style.overflowAnchor = 'none';
      return;
    }

    scrollerElementRef.current = null;
  }, []);

  useEffect(() => {
    atBottomRef.current = true;
    forceFollowOutputRef.current = false;
    initialLatestRestoreDoneRef.current = false;
    lastVisibleTopMessageIdRef.current = null;
    previousFirstItemIndexRef.current = firstItemIndex;
    savedAnchorRef.current = null;
    setIsAtBottom(true);
    setHasUnseenMessages(false);

    return () => {
      if (lastVisibleTopMessageIdRef.current) {
        saveConversationScrollPosition(conversationId, lastVisibleTopMessageIdRef.current);
      }
    };
  }, [conversationId]);

  useEffect(() => {
    if (!newMessage) return;
    if (String(newMessage.conversation_id || conversationId) !== String(conversationId)) {
      return;
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
    await jumpToPresent();
    setHasUnseenMessages(false);
  }, [jumpToPresent]);

  const handleStartReached = useCallback(() => {
    if (loadingOlder || prefetchingOlder || !hasOlder) {
      return;
    }

    void loadOlder();
  }, [hasOlder, loadOlder, loadingOlder, prefetchingOlder]);

  const handleRangeChanged = useCallback((range: ListRange) => {
    const relativeStartIndex = range.startIndex - firstItemIndex;
    const topMessageIndex = Math.max(0, Math.min(visualMessages.length - 1, relativeStartIndex));
    const topMessage = relativeStartIndex >= 0 ? visualMessages[topMessageIndex] : null;

    if (topMessage) {
      lastVisibleTopMessageIdRef.current = topMessage.message_id;
    }
  }, [firstItemIndex, visualMessages]);

  const scrollSeekConfiguration = useMemo(() => ({
    enter: (velocity: number) => Math.abs(velocity) > 1400,
    exit: (velocity: number) => {
      const shouldExit = Math.abs(velocity) < 120;
      if (shouldExit) {
        setScrollSeekExitTick((previous) => previous + 1);
      }
      return shouldExit;
    },
  }), []);

  const followOutput = useCallback((atBottom: boolean) => {
    if (forceFollowOutputRef.current) {
      return 'auto';
    }

    if (loadingOlder || hasNewer) {
      return false;
    }

    return atBottom ? 'auto' : false;
  }, [hasNewer, loadingOlder]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom;
    setIsAtBottom(atBottom);

    if (atBottom) {
      setHasUnseenMessages(false);
      forceFollowOutputRef.current = false;
    }

    setIsAtPresent(atBottom && !hasNewer);
  }, [hasNewer, setIsAtPresent]);

  const handleAttachmentLoad = useCallback(() => {
    if (!atBottomRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      virtuosoRef.current?.autoscrollToBottom();
    });
  }, []);

  useLayoutEffect(() => {
    const wasPrepend = firstItemIndex < previousFirstItemIndexRef.current;
    previousFirstItemIndexRef.current = firstItemIndex;

    if (!wasPrepend) {
      return;
    }

    const savedAnchor = savedAnchorRef.current;
    const scroller = scrollerElementRef.current;
    if (!savedAnchor || !scroller) {
      return;
    }

    const anchorElement = scroller.querySelector<HTMLElement>(`[data-message-id="${savedAnchor.id}"]`);
    if (!anchorElement) {
      return;
    }

    const delta = anchorElement.getBoundingClientRect().top - savedAnchor.top;
    if (Math.abs(delta) > 1) {
      scroller.scrollTop += delta;
    }
  }, [firstItemIndex, visualMessages]);

  useLayoutEffect(() => {
    const anchorId = lastVisibleTopMessageIdRef.current;
    const scroller = scrollerElementRef.current;
    if (!anchorId || !scroller) {
      return;
    }

    const anchorElement = scroller.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`);
    if (!anchorElement) {
      return;
    }

    savedAnchorRef.current = {
      id: anchorId,
      top: anchorElement.getBoundingClientRect().top,
    };
  });

  useEffect(() => {
    if (initialLatestRestoreDoneRef.current || !initialHydrationSettled || visualMessages.length === 0) {
      return;
    }

    initialLatestRestoreDoneRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
      });
    });
  }, [initialHydrationSettled, visualMessages.length]);

  return {
    virtuosoRef,
    isAtBottom,
    hasUnseenMessages,
    handleScrollerRef,
    handleStartReached,
    handleRangeChanged,
    scrollSeekConfiguration,
    handleJumpToPresent,
    followOutput,
    handleAtBottomStateChange,
    handleAttachmentLoad,
    scrollSeekExitTick,
  };
}
