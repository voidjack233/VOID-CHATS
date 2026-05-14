import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { HistoryRangeStatus } from './useMessageScrollGeometry';

type HistoryLoadDirection = 'older' | 'newer';

interface UseMessageTimelineVirtualizerParams {
  scrollerRef: MutableRefObject<HTMLElement | null>;
  resetKey: string;
  initialLatestRestoreDoneRef: MutableRefObject<boolean>;
  loadingOlderRequestInFlightRef: MutableRefObject<boolean>;
  loadingNewerRequestInFlightRef: MutableRefObject<boolean>;
  loadingOlderStateRef: MutableRefObject<boolean>;
  loadingNewer: boolean;
  historyLoadPausedUntil: number;
  hasOlder: boolean;
  hasNewer: boolean;
  olderRangeStatus: HistoryRangeStatus;
  newerRangeStatus: HistoryRangeStatus;
  olderTopLoadThreshold: number;
  newerBottomLoadThreshold: number;
  getOlderBoundaryDistance: (scroller: HTMLElement) => number;
  getNewerBoundaryDistance: (scroller: HTMLElement) => number;
  isOlderRangeVisible: (scroller: HTMLElement) => boolean;
  isNewerRangeVisible: (scroller: HTMLElement) => boolean;
  loadOlderPreservingViewport: () => Promise<unknown>;
  loadNewerPreservingViewport: () => Promise<unknown>;
  syncScrollState: () => void;
}

const HISTORY_LOAD_COOLDOWN_MS = 400;
const SCROLL_DIRECTION_EPSILON = 1;

export const useMessageTimelineVirtualizer = ({
  scrollerRef,
  resetKey,
  initialLatestRestoreDoneRef,
  loadingOlderRequestInFlightRef,
  loadingNewerRequestInFlightRef,
  loadingOlderStateRef,
  loadingNewer,
  historyLoadPausedUntil,
  hasOlder,
  hasNewer,
  olderRangeStatus,
  newerRangeStatus,
  olderTopLoadThreshold,
  newerBottomLoadThreshold,
  getOlderBoundaryDistance,
  getNewerBoundaryDistance,
  isOlderRangeVisible,
  isNewerRangeVisible,
  loadOlderPreservingViewport,
  loadNewerPreservingViewport,
  syncScrollState,
}: UseMessageTimelineVirtualizerParams) => {
  const historyLoadInFlightRef = useRef<HistoryLoadDirection | null>(null);
  const lastScrollTopRef = useRef<number | null>(null);
  const lastHistoryLoadAtRef = useRef(0);
  const visibleRangeRetryTimerRef = useRef<number | null>(null);

  useEffect(() => {
    historyLoadInFlightRef.current = null;
    lastHistoryLoadAtRef.current = 0;
    lastScrollTopRef.current = scrollerRef.current?.scrollTop ?? null;
    if (visibleRangeRetryTimerRef.current !== null) {
      window.clearTimeout(visibleRangeRetryTimerRef.current);
      visibleRangeRetryTimerRef.current = null;
    }
  }, [resetKey, scrollerRef]);

  useEffect(() => () => {
    if (visibleRangeRetryTimerRef.current !== null) {
      window.clearTimeout(visibleRangeRetryTimerRef.current);
    }
  }, []);

  const startHistoryLoad = useCallback((direction: HistoryLoadDirection) => {
    historyLoadInFlightRef.current = direction;
    lastHistoryLoadAtRef.current = Date.now();

    if (direction === 'older') {
      loadingOlderRequestInFlightRef.current = true;
      void loadOlderPreservingViewport().finally(() => {
        loadingOlderRequestInFlightRef.current = false;
        historyLoadInFlightRef.current = null;
      });
      return true;
    }

    loadingNewerRequestInFlightRef.current = true;
    void loadNewerPreservingViewport().finally(() => {
      loadingNewerRequestInFlightRef.current = false;
      historyLoadInFlightRef.current = null;
    });
    return true;
  }, [
    loadNewerPreservingViewport,
    loadOlderPreservingViewport,
    loadingNewerRequestInFlightRef,
    loadingOlderRequestInFlightRef,
  ]);

  const maybeStartBestHistoryLoad = useCallback((preferredDirection?: HistoryLoadDirection) => {
    const scroller = scrollerRef.current;
    if (
      !scroller ||
      !initialLatestRestoreDoneRef.current ||
      historyLoadInFlightRef.current ||
      loadingOlderRequestInFlightRef.current ||
      loadingNewerRequestInFlightRef.current ||
      loadingOlderStateRef.current ||
      loadingNewer
    ) {
      return false;
    }

    const now = Date.now();
    if (historyLoadPausedUntil > now) {
      return false;
    }

    if (now - lastHistoryLoadAtRef.current < HISTORY_LOAD_COOLDOWN_MS) {
      return false;
    }

    const previousScrollTop = lastScrollTopRef.current;
    const currentScrollTop = scroller.scrollTop;
    const scrollDelta = previousScrollTop === null ? 0 : currentScrollTop - previousScrollTop;
    const scrollDirection: HistoryLoadDirection | null =
      scrollDelta < -SCROLL_DIRECTION_EPSILON
        ? 'older'
        : scrollDelta > SCROLL_DIRECTION_EPSILON
          ? 'newer'
          : null;

    lastScrollTopRef.current = currentScrollTop;

    const olderDistance = getOlderBoundaryDistance(scroller);
    const newerDistance = getNewerBoundaryDistance(scroller);
    const olderVisible = olderRangeStatus === 'idle' && isOlderRangeVisible(scroller);
    const newerVisible = newerRangeStatus === 'idle' && isNewerRangeVisible(scroller);
    const nearOlder = hasOlder && (olderVisible || olderDistance <= olderTopLoadThreshold);
    const nearNewer = hasNewer && (newerVisible || newerDistance <= newerBottomLoadThreshold);

    if (!nearOlder && !nearNewer) {
      return false;
    }

    let nextDirection: HistoryLoadDirection;
    if (nearOlder && !nearNewer) {
      nextDirection = 'older';
    } else if (nearNewer && !nearOlder) {
      nextDirection = 'newer';
    } else if (preferredDirection && ((preferredDirection === 'older' && nearOlder) || (preferredDirection === 'newer' && nearNewer))) {
      nextDirection = preferredDirection;
    } else if (scrollDirection && ((scrollDirection === 'older' && nearOlder) || (scrollDirection === 'newer' && nearNewer))) {
      nextDirection = scrollDirection;
    } else {
      const olderPressure = olderDistance - olderTopLoadThreshold;
      const newerPressure = newerDistance - newerBottomLoadThreshold;
      nextDirection = olderPressure <= newerPressure ? 'older' : 'newer';
    }

    return startHistoryLoad(nextDirection);
  }, [
    getNewerBoundaryDistance,
    getOlderBoundaryDistance,
    hasNewer,
    hasOlder,
    historyLoadPausedUntil,
    initialLatestRestoreDoneRef,
    isNewerRangeVisible,
    isOlderRangeVisible,
    loadingNewer,
    loadingNewerRequestInFlightRef,
    loadingOlderRequestInFlightRef,
    loadingOlderStateRef,
    newerBottomLoadThreshold,
    newerRangeStatus,
    olderRangeStatus,
    olderTopLoadThreshold,
    scrollerRef,
    startHistoryLoad,
  ]);

  const handleScroll = useCallback(() => {
    syncScrollState();
    maybeStartBestHistoryLoad();
  }, [maybeStartBestHistoryLoad, syncScrollState]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !initialLatestRestoreDoneRef.current) {
      return undefined;
    }

    const olderVisible = hasOlder && olderRangeStatus === 'idle' && isOlderRangeVisible(scroller);
    const newerVisible = hasNewer && newerRangeStatus === 'idle' && isNewerRangeVisible(scroller);
    if (!olderVisible && !newerVisible) {
      return undefined;
    }

    if (
      historyLoadInFlightRef.current ||
      loadingOlderRequestInFlightRef.current ||
      loadingNewerRequestInFlightRef.current ||
      loadingOlderStateRef.current ||
      loadingNewer
    ) {
      return undefined;
    }

    const now = Date.now();
    const delay = Math.max(
      0,
      historyLoadPausedUntil - now,
      HISTORY_LOAD_COOLDOWN_MS - (now - lastHistoryLoadAtRef.current),
    );
    const preferredDirection: HistoryLoadDirection | undefined =
      newerVisible && !olderVisible
        ? 'newer'
        : olderVisible && !newerVisible
          ? 'older'
          : undefined;

    if (visibleRangeRetryTimerRef.current !== null) {
      window.clearTimeout(visibleRangeRetryTimerRef.current);
    }

    visibleRangeRetryTimerRef.current = window.setTimeout(() => {
      visibleRangeRetryTimerRef.current = null;
      maybeStartBestHistoryLoad(preferredDirection);
    }, delay);

    return () => {
      if (visibleRangeRetryTimerRef.current !== null) {
        window.clearTimeout(visibleRangeRetryTimerRef.current);
        visibleRangeRetryTimerRef.current = null;
      }
    };
  }, [
    hasNewer,
    hasOlder,
    historyLoadPausedUntil,
    initialLatestRestoreDoneRef,
    isNewerRangeVisible,
    isOlderRangeVisible,
    loadingNewer,
    loadingNewerRequestInFlightRef,
    loadingOlderRequestInFlightRef,
    loadingOlderStateRef,
    maybeStartBestHistoryLoad,
    newerRangeStatus,
    olderRangeStatus,
    scrollerRef,
  ]);

  return {
    handleScroll,
    maybeStartBestHistoryLoad,
  };
};

export type { HistoryLoadDirection };
