import { useEffect, type MutableRefObject, type RefObject } from 'react';

// IntersectionObserver catches the exact boundary. The scroll handler starts
// history fetches earlier so fast scrolling is less likely to hit a loading wall.
const OLDER_SENTINEL_ROOT_MARGIN = '0px 0px 0px 0px';

interface UseMessageHistorySentinelsOptions {
  scrollerRef: RefObject<HTMLDivElement | null>;
  olderSentinelRef: RefObject<HTMLDivElement | null>;
  newerSentinelRef: RefObject<HTMLDivElement | null>;
  resetKey: string;
  initialLatestRestoreDoneRef: MutableRefObject<boolean>;
  loadingNewerRequestInFlightRef: MutableRefObject<boolean>;
  hasNewer: boolean;
  loadingNewer: boolean;
  newerBottomLoadThreshold: number;
  maybeStartBestHistoryLoad: (preferredDirection?: 'older' | 'newer') => void;
}

export function useMessageHistorySentinels({
  scrollerRef,
  olderSentinelRef,
  newerSentinelRef,
  resetKey,
  initialLatestRestoreDoneRef,
  loadingNewerRequestInFlightRef,
  hasNewer,
  loadingNewer,
  newerBottomLoadThreshold,
  maybeStartBestHistoryLoad,
}: UseMessageHistorySentinelsOptions) {
  useEffect(() => {
    const sentinel = olderSentinelRef.current;
    const scroller = scrollerRef.current;
    if (!sentinel || !scroller) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!initialLatestRestoreDoneRef.current) {
          return;
        }
        if (!entry?.isIntersecting) {
          return;
        }

        maybeStartBestHistoryLoad('older');
      },
      {
        root: scroller,
        rootMargin: OLDER_SENTINEL_ROOT_MARGIN,
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    initialLatestRestoreDoneRef,
    maybeStartBestHistoryLoad,
    olderSentinelRef,
    resetKey,
    scrollerRef,
  ]);

  useEffect(() => {
    const sentinel = newerSentinelRef.current;
    const scroller = scrollerRef.current;
    if (!sentinel || !scroller || !hasNewer) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!initialLatestRestoreDoneRef.current) {
          return;
        }
        if (
          !entry?.isIntersecting ||
          loadingNewerRequestInFlightRef.current ||
          !hasNewer ||
          loadingNewer
        ) {
          return;
        }

        maybeStartBestHistoryLoad('newer');
      },
      {
        root: scroller,
        rootMargin: `0px 0px ${newerBottomLoadThreshold}px 0px`,
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    hasNewer,
    initialLatestRestoreDoneRef,
    loadingNewer,
    loadingNewerRequestInFlightRef,
    maybeStartBestHistoryLoad,
    newerBottomLoadThreshold,
    newerSentinelRef,
    resetKey,
    scrollerRef,
  ]);
}
