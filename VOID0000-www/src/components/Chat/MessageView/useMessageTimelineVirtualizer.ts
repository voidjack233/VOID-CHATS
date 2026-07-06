import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { HistoryRangeStatus } from './useMessageScrollGeometry';

type HistoryLoadDirection = 'older' | 'newer';

interface UseMessageTimelineVirtualizerParams {
  scrollerRef: MutableRefObject<HTMLElement | null>;
  resetKey: string;
  initialLatestRestoreDoneRef: MutableRefObject<boolean>;
  pendingOlderLoadScrollSnapshotRef: MutableRefObject<unknown>;
  pendingNewerLoadScrollSnapshotRef: MutableRefObject<unknown>;
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
const HISTORY_RESTORE_RETRY_MS = 50;
const SCROLL_DIRECTION_EPSILON = 1;
const SCROLL_DIRECTION_SIGNAL_TTL_MS = 1_500;

export const useMessageTimelineVirtualizer = ({
  scrollerRef,
  resetKey,
  initialLatestRestoreDoneRef,
  pendingOlderLoadScrollSnapshotRef,
  pendingNewerLoadScrollSnapshotRef,
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
  const lastScrollDirectionSignalRef = useRef<{ direction: HistoryLoadDirection; at: number } | null>(null);
  const retainedScrollSignalRef = useRef<{ direction: HistoryLoadDirection; at: number } | null>(null);
  const consumedScrollSignalAtRef = useRef<Record<HistoryLoadDirection, number>>({
    older: 0,
    newer: 0,
  });
  const retryHistoryLoadRef = useRef<(preferredDirection?: HistoryLoadDirection) => void>(() => {});
  const historyLoadRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyLoadRetryDirectionRef = useRef<HistoryLoadDirection | null>(null);

  const scheduleHistoryLoadRetry = useCallback((delayMs: number, preferredDirection?: HistoryLoadDirection) => {
    if (historyLoadRetryTimeoutRef.current) {
      clearTimeout(historyLoadRetryTimeoutRef.current);
    }
    if (preferredDirection) {
      historyLoadRetryDirectionRef.current = preferredDirection;
    }

    historyLoadRetryTimeoutRef.current = setTimeout(() => {
      historyLoadRetryTimeoutRef.current = null;
      const retryDirection = historyLoadRetryDirectionRef.current;
      historyLoadRetryDirectionRef.current = null;
      retryHistoryLoadRef.current(retryDirection ?? undefined);
    }, Math.max(0, delayMs));
  }, []);

  useEffect(() => {
    historyLoadInFlightRef.current = null;
    lastHistoryLoadAtRef.current = 0;
    lastScrollTopRef.current = scrollerRef.current?.scrollTop ?? null;
    lastScrollDirectionSignalRef.current = null;
    retainedScrollSignalRef.current = null;
    historyLoadRetryDirectionRef.current = null;
    consumedScrollSignalAtRef.current = {
      older: 0,
      newer: 0,
    };
    if (historyLoadRetryTimeoutRef.current) {
      clearTimeout(historyLoadRetryTimeoutRef.current);
      historyLoadRetryTimeoutRef.current = null;
    }
  }, [resetKey, scrollerRef]);

  const startHistoryLoad = useCallback((direction: HistoryLoadDirection, signalAt: number) => {
    historyLoadInFlightRef.current = direction;
    lastHistoryLoadAtRef.current = Date.now();
    consumedScrollSignalAtRef.current[direction] = signalAt;
    if (
      retainedScrollSignalRef.current?.direction === direction &&
      retainedScrollSignalRef.current.at <= signalAt
    ) {
      retainedScrollSignalRef.current = null;
    }

    if (direction === 'older') {
      loadingOlderRequestInFlightRef.current = true;
      void loadOlderPreservingViewport().finally(() => {
        loadingOlderRequestInFlightRef.current = false;
        historyLoadInFlightRef.current = null;
        scheduleHistoryLoadRetry(HISTORY_LOAD_COOLDOWN_MS, 'older');
      });
      return true;
    }

    loadingNewerRequestInFlightRef.current = true;
    void loadNewerPreservingViewport().finally(() => {
      loadingNewerRequestInFlightRef.current = false;
      historyLoadInFlightRef.current = null;
      scheduleHistoryLoadRetry(HISTORY_LOAD_COOLDOWN_MS, 'newer');
    });
    return true;
  }, [
    loadNewerPreservingViewport,
    loadOlderPreservingViewport,
    loadingNewerRequestInFlightRef,
    loadingOlderRequestInFlightRef,
    scheduleHistoryLoadRetry,
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
      if (
        historyLoadRetryDirectionRef.current &&
        historyLoadRetryDirectionRef.current !== scrollDirection
      ) {
        historyLoadRetryDirectionRef.current = null;
      }
      if (
        retainedScrollSignalRef.current &&
        retainedScrollSignalRef.current.direction !== scrollDirection
      ) {
        retainedScrollSignalRef.current = null;
      }
      lastScrollDirectionSignalRef.current = {
        direction: scrollDirection,
        at: now,
      };
    }

    let scrollSignal = lastScrollDirectionSignalRef.current;
    const retainedScrollSignal = retainedScrollSignalRef.current;
    if (preferredDirection) {
      if (
        retainedScrollSignal?.direction === preferredDirection &&
        retainedScrollSignal.at > consumedScrollSignalAtRef.current[preferredDirection]
      ) {
        scrollSignal = retainedScrollSignal;
      } else if (
        !scrollSignal ||
        scrollSignal.direction !== preferredDirection ||
        scrollSignal.at <= consumedScrollSignalAtRef.current[preferredDirection] ||
        now - scrollSignal.at > SCROLL_DIRECTION_SIGNAL_TTL_MS
      ) {
        scrollSignal = {
          direction: preferredDirection,
          at: now,
        };
        lastScrollDirectionSignalRef.current = scrollSignal;
      }
    }

    const isRetainedSignal = Boolean(
      retainedScrollSignal &&
      retainedScrollSignal.direction === scrollSignal?.direction &&
      retainedScrollSignal.at === scrollSignal?.at
    );
    if (
      !scrollSignal ||
      (!preferredDirection && !isRetainedSignal && now - scrollSignal.at > SCROLL_DIRECTION_SIGNAL_TTL_MS) ||
      scrollSignal.at <= consumedScrollSignalAtRef.current[scrollSignal.direction] ||
      (preferredDirection && scrollSignal.direction !== preferredDirection)
    ) {
      return false;
    }

    const requestedDirection = preferredDirection ?? scrollSignal.direction;
    const olderDistance = getOlderBoundaryDistance(scroller);
    const newerDistance = getNewerBoundaryDistance(scroller);
    const canLoadOlder = olderRangeStatus === 'idle';
    const canLoadNewer = newerRangeStatus === 'idle';
    const olderVisible = canLoadOlder && isOlderRangeVisible(scroller);
    const newerVisible = canLoadNewer && isNewerRangeVisible(scroller);
    const nearOlder = hasOlder && canLoadOlder && (olderVisible || olderDistance <= olderTopLoadThreshold);
    const nearNewer = hasNewer && canLoadNewer && (newerVisible || newerDistance <= newerBottomLoadThreshold);
    const isRequestedBoundaryNear = requestedDirection === 'older' ? nearOlder : nearNewer;

    if (!isRequestedBoundaryNear) {
      if (retainedScrollSignalRef.current?.direction === requestedDirection) {
        retainedScrollSignalRef.current = null;
      }
      return false;
    }

    if (
      historyLoadInFlightRef.current ||
      loadingOlderRequestInFlightRef.current ||
      loadingNewerRequestInFlightRef.current ||
      loadingOlderStateRef.current ||
      loadingNewer
    ) {
      retainedScrollSignalRef.current = scrollSignal;
      return false;
    }

    if (
      pendingOlderLoadScrollSnapshotRef.current ||
      pendingNewerLoadScrollSnapshotRef.current
    ) {
      retainedScrollSignalRef.current = scrollSignal;
      scheduleHistoryLoadRetry(HISTORY_RESTORE_RETRY_MS);
      return false;
    }

    if (historyLoadPausedUntil > now) {
      retainedScrollSignalRef.current = scrollSignal;
      scheduleHistoryLoadRetry(historyLoadPausedUntil - now + 10);
      return false;
    }

    const cooldownRemaining = HISTORY_LOAD_COOLDOWN_MS - (now - lastHistoryLoadAtRef.current);
    if (cooldownRemaining > 0) {
      retainedScrollSignalRef.current = scrollSignal;
      scheduleHistoryLoadRetry(cooldownRemaining + 1);
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
    pendingNewerLoadScrollSnapshotRef,
    pendingOlderLoadScrollSnapshotRef,
    scheduleHistoryLoadRetry,
    scrollerRef,
    startHistoryLoad,
  ]);

  retryHistoryLoadRef.current = (preferredDirection) => {
    const retained = retainedScrollSignalRef.current;
    void maybeStartBestHistoryLoad(preferredDirection ?? retained?.direction);
  };

  useEffect(() => {
    if (!retainedScrollSignalRef.current) {
      return;
    }

    retryHistoryLoadRef.current();
  }, [
    hasNewer,
    hasOlder,
    historyLoadPausedUntil,
    loadingNewer,
    newerRangeStatus,
    olderRangeStatus,
  ]);

  useEffect(() => () => {
    if (historyLoadRetryTimeoutRef.current) {
      clearTimeout(historyLoadRetryTimeoutRef.current);
    }
    historyLoadRetryDirectionRef.current = null;
  }, []);

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
