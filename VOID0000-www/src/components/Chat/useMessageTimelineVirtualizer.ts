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
const SCROLL_DIRECTION_SIGNAL_TTL_MS = 1_500;

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
  const lastHistoryLoadSettledAtRef = useRef(0);
  const lastScrollDirectionSignalRef = useRef<{ direction: HistoryLoadDirection; at: number } | null>(null);
  const consumedScrollSignalAtRef = useRef<Record<HistoryLoadDirection, number>>({
    older: 0,
    newer: 0,
  });

  useEffect(() => {
    historyLoadInFlightRef.current = null;
    lastHistoryLoadAtRef.current = 0;
    lastHistoryLoadSettledAtRef.current = 0;
    lastScrollTopRef.current = scrollerRef.current?.scrollTop ?? null;
    lastScrollDirectionSignalRef.current = null;
    consumedScrollSignalAtRef.current = {
      older: 0,
      newer: 0,
    };
  }, [resetKey, scrollerRef]);

  const startHistoryLoad = useCallback((direction: HistoryLoadDirection, signalAt: number) => {
    historyLoadInFlightRef.current = direction;
    lastHistoryLoadAtRef.current = Date.now();
    consumedScrollSignalAtRef.current[direction] = signalAt;

    if (direction === 'older') {
      loadingOlderRequestInFlightRef.current = true;
      void loadOlderPreservingViewport().finally(() => {
        loadingOlderRequestInFlightRef.current = false;
        historyLoadInFlightRef.current = null;
        lastHistoryLoadSettledAtRef.current = Date.now();
      });
      return true;
    }

    loadingNewerRequestInFlightRef.current = true;
    void loadNewerPreservingViewport().finally(() => {
      loadingNewerRequestInFlightRef.current = false;
      historyLoadInFlightRef.current = null;
      lastHistoryLoadSettledAtRef.current = Date.now();
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
    const now = Date.now();
    if (
      !scroller ||
      !initialLatestRestoreDoneRef.current
    ) {
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
    if (scrollDirection) {
      lastScrollDirectionSignalRef.current = {
        direction: scrollDirection,
        at: now,
      };
    }

    const scrollSignal = lastScrollDirectionSignalRef.current;
    if (
      !scrollSignal ||
      now - scrollSignal.at > SCROLL_DIRECTION_SIGNAL_TTL_MS ||
      scrollSignal.at <= consumedScrollSignalAtRef.current[scrollSignal.direction] ||
      scrollSignal.at <= lastHistoryLoadSettledAtRef.current ||
      (preferredDirection && scrollSignal.direction !== preferredDirection)
    ) {
      return false;
    }

    const requestedDirection = preferredDirection ?? scrollSignal.direction;
    const consumeScrollSignal = () => {
      consumedScrollSignalAtRef.current[scrollSignal.direction] = scrollSignal.at;
    };

    if (
      historyLoadInFlightRef.current ||
      loadingOlderRequestInFlightRef.current ||
      loadingNewerRequestInFlightRef.current ||
      loadingOlderStateRef.current ||
      loadingNewer
    ) {
      consumeScrollSignal();
      return false;
    }

    if (historyLoadPausedUntil > now) {
      consumeScrollSignal();
      return false;
    }

    if (now - lastHistoryLoadAtRef.current < HISTORY_LOAD_COOLDOWN_MS) {
      consumeScrollSignal();
      return false;
    }

    const olderDistance = getOlderBoundaryDistance(scroller);
    const newerDistance = getNewerBoundaryDistance(scroller);
    const olderVisible = olderRangeStatus === 'idle' && isOlderRangeVisible(scroller);
    const newerVisible = newerRangeStatus === 'idle' && isNewerRangeVisible(scroller);
    const nearOlder = hasOlder && (olderVisible || olderDistance <= olderTopLoadThreshold);
    const nearNewer = hasNewer && (newerVisible || newerDistance <= newerBottomLoadThreshold);

    if (!nearOlder && !nearNewer) {
      return false;
    }

    if (requestedDirection === 'older' && nearOlder) {
      return startHistoryLoad('older', scrollSignal.at);
    }

    if (requestedDirection === 'newer' && nearNewer) {
      return startHistoryLoad('newer', scrollSignal.at);
    }

    return false;
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

  return {
    handleScroll,
    maybeStartBestHistoryLoad,
  };
};

export type { HistoryLoadDirection };
