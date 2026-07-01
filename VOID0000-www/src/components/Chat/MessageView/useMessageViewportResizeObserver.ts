import { useEffect, type MutableRefObject, type RefObject } from 'react';

interface UseMessageViewportResizeObserverOptions {
  scrollerRef: RefObject<HTMLDivElement | null>;
  historyScrollTransactionActiveRef: MutableRefObject<boolean>;
  atBottomRef: MutableRefObject<boolean>;
  showJumpToPresentRef: MutableRefObject<boolean>;
  attemptInitialBottomRestore: () => boolean;
  maybeAutofillOlder: () => boolean;
  restoreViewportAnchorLock: () => boolean;
  syncScrollState: () => void;
}

export function useMessageViewportResizeObserver({
  scrollerRef,
  historyScrollTransactionActiveRef,
  atBottomRef,
  showJumpToPresentRef,
  attemptInitialBottomRestore,
  maybeAutofillOlder,
  restoreViewportAnchorLock,
  syncScrollState,
}: UseMessageViewportResizeObserverOptions) {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      void attemptInitialBottomRestore();
      void maybeAutofillOlder();
      if (
        historyScrollTransactionActiveRef.current ||
        !atBottomRef.current ||
        showJumpToPresentRef.current
      ) {
        restoreViewportAnchorLock();
      }
      syncScrollState();
    });

    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [
    attemptInitialBottomRestore,
    atBottomRef,
    historyScrollTransactionActiveRef,
    maybeAutofillOlder,
    restoreViewportAnchorLock,
    scrollerRef,
    showJumpToPresentRef,
    syncScrollState,
  ]);
}
