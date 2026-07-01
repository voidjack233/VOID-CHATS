import { useEffect, type MutableRefObject, type RefObject } from 'react';
import type { HistoryLoadScrollSnapshot } from './historyScrollAnchors';

interface UseMessageHistoryBoundaryLockOptions {
  scrollerRef: RefObject<HTMLDivElement | null>;
  resetKey: string;
  loadingOlderRequestInFlightRef: MutableRefObject<boolean>;
  loadingOlderStateRef: MutableRefObject<boolean>;
  pendingOlderLoadScrollSnapshotRef: MutableRefObject<HistoryLoadScrollSnapshot | null>;
  olderTopScrollLockThreshold: number;
}

export function useMessageHistoryBoundaryLock({
  scrollerRef,
  resetKey,
  loadingOlderRequestInFlightRef,
  loadingOlderStateRef,
  pendingOlderLoadScrollSnapshotRef,
  olderTopScrollLockThreshold,
}: UseMessageHistoryBoundaryLockOptions) {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    let lastTouchY: number | null = null;
    const shouldLockOlderBoundary = () => (
      (loadingOlderRequestInFlightRef.current ||
        loadingOlderStateRef.current ||
        pendingOlderLoadScrollSnapshotRef.current !== null) &&
      scroller.scrollTop <= olderTopScrollLockThreshold
    );

    const handleWheelBoundaryLock = (event: WheelEvent) => {
      if (event.deltaY < 0 && shouldLockOlderBoundary()) {
        event.preventDefault();
        scroller.scrollTop = Math.max(0, scroller.scrollTop);
      }
    };

    const handleTouchStartBoundaryLock = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY ?? null;
    };

    const handleTouchMoveBoundaryLock = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      if (nextY === null || lastTouchY === null) {
        lastTouchY = nextY;
        return;
      }

      const isPullingTowardOlderHistory = nextY > lastTouchY;
      if (isPullingTowardOlderHistory && shouldLockOlderBoundary()) {
        event.preventDefault();
      }
      lastTouchY = nextY;
    };

    const clearTouchBoundaryLock = () => {
      lastTouchY = null;
    };

    scroller.addEventListener('wheel', handleWheelBoundaryLock, { passive: false });
    scroller.addEventListener('touchstart', handleTouchStartBoundaryLock, { passive: true });
    scroller.addEventListener('touchmove', handleTouchMoveBoundaryLock, { passive: false });
    scroller.addEventListener('touchend', clearTouchBoundaryLock);
    scroller.addEventListener('touchcancel', clearTouchBoundaryLock);

    return () => {
      scroller.removeEventListener('wheel', handleWheelBoundaryLock);
      scroller.removeEventListener('touchstart', handleTouchStartBoundaryLock);
      scroller.removeEventListener('touchmove', handleTouchMoveBoundaryLock);
      scroller.removeEventListener('touchend', clearTouchBoundaryLock);
      scroller.removeEventListener('touchcancel', clearTouchBoundaryLock);
    };
  }, [
    loadingOlderRequestInFlightRef,
    loadingOlderStateRef,
    olderTopScrollLockThreshold,
    pendingOlderLoadScrollSnapshotRef,
    resetKey,
    scrollerRef,
  ]);
}
