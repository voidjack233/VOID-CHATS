import { useCallback, useEffect, useState, type MutableRefObject, type RefObject } from 'react';
import {
  getFirstVisibleMessageAnchor,
  getMessageAnchorsAroundViewport,
  getMessageElementEdgeOffset,
  moveHistoryRangeReplacementSeamAnchor,
  restoreHistoryRangeReplacementAnchor,
  restoreHistoryRangeReplacementSeamAnchor,
  restoreVisibleMessageAnchor,
  updateHistoryRangeReplacementPosition,
  type HistoryLoadScrollSnapshot,
  type HistoryRangeReplacementSnapshot,
  type NewerHistoryLoadScrollSnapshot,
  type ViewportAnchorLock,
} from './historyScrollAnchors';

const OLDER_LOAD_SCROLL_UPDATE_THRESHOLD = 1;

interface ScrollState {
  atBottom: boolean;
  shouldShowJumpToPresent: boolean;
  isAtPresent: boolean;
}

interface UseMessageHistoryViewportRestorationOptions {
  resetKey: string;
  scrollerRef: RefObject<HTMLDivElement | null>;
  firstVisualMessageId?: string;
  lastVisualMessageId?: string;
  renderedTopSpacerHeight: number;
  renderedBottomSpacerHeight: number;
  historyLogicalSlotHeight: number;
  historySkeletonRowHeight: number;
  olderTopExhaustionThreshold: number;
  hasNewer: boolean;
  isAtPresent: boolean;
  pendingOlderLoadScrollSnapshotRef: MutableRefObject<HistoryLoadScrollSnapshot | null>;
  pendingNewerLoadScrollSnapshotRef: MutableRefObject<NewerHistoryLoadScrollSnapshot | null>;
  historyScrollTransactionActiveRef: MutableRefObject<boolean>;
  viewportAnchorLockRef: MutableRefObject<ViewportAnchorLock | null>;
  viewportAnchorRestoreInProgressRef: MutableRefObject<boolean>;
  atBottomRef: MutableRefObject<boolean>;
  showJumpToPresentRef: MutableRefObject<boolean>;
  forceFollowOutputRef: MutableRefObject<boolean>;
  hasOlderRef: MutableRefObject<boolean>;
  hasNewerRef: MutableRefObject<boolean>;
  historyLoadPausedUntilRef: MutableRefObject<number>;
  isOlderRangeVisible: (scroller: HTMLElement) => boolean;
  isNewerRangeVisible: (scroller: HTMLElement) => boolean;
  getScrollState: (scroller: HTMLElement) => ScrollState;
  captureViewportAnchorLock: (scroller?: HTMLDivElement | null) => boolean;
  loadOlder: () => Promise<boolean | undefined>;
  loadNewer: () => Promise<boolean | undefined>;
  setOlderRangeError: (value: boolean) => void;
  setNewerRangeError: (value: boolean) => void;
  setShowJumpToPresent: (value: boolean) => void;
  setIsAtPresent: (value: boolean) => void;
  onOwnSendHistoryModeChange?: (shouldJumpToPresent: boolean) => void;
}

export function useMessageHistoryViewportRestoration({
  resetKey,
  scrollerRef,
  firstVisualMessageId,
  lastVisualMessageId,
  renderedTopSpacerHeight,
  renderedBottomSpacerHeight,
  historyLogicalSlotHeight,
  historySkeletonRowHeight,
  olderTopExhaustionThreshold,
  hasNewer,
  isAtPresent,
  pendingOlderLoadScrollSnapshotRef,
  pendingNewerLoadScrollSnapshotRef,
  historyScrollTransactionActiveRef,
  viewportAnchorLockRef,
  viewportAnchorRestoreInProgressRef,
  atBottomRef,
  showJumpToPresentRef,
  forceFollowOutputRef,
  hasOlderRef,
  hasNewerRef,
  historyLoadPausedUntilRef,
  isOlderRangeVisible,
  isNewerRangeVisible,
  getScrollState,
  captureViewportAnchorLock,
  loadOlder,
  loadNewer,
  setOlderRangeError,
  setNewerRangeError,
  setShowJumpToPresent,
  setIsAtPresent,
  onOwnSendHistoryModeChange,
}: UseMessageHistoryViewportRestorationOptions) {
  const [historyRestoreRevision, setHistoryRestoreRevision] = useState(0);

  useEffect(() => {
    setHistoryRestoreRevision(0);
  }, [resetKey]);

  const captureHistoryLoadScrollSnapshot = useCallback((): HistoryLoadScrollSnapshot | null => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const shouldMapVisibleRange = Boolean(
      firstVisualMessageId &&
      renderedTopSpacerHeight > 1 &&
      isOlderRangeVisible(scroller),
    );
    const rangeReplacement: HistoryRangeReplacementSnapshot | null = shouldMapVisibleRange
      ? {
          direction: 'older',
          seamMessageId: firstVisualMessageId!,
          seamAnchor: (() => {
            const offset = getMessageElementEdgeOffset(scroller, firstVisualMessageId!, 'top');
            return offset === null ? null : { edge: 'top', offset };
          })(),
          sourceStart: Math.max(0, renderedTopSpacerHeight - historyLogicalSlotHeight),
          sourceEnd: renderedTopSpacerHeight,
          rowHeight: historySkeletonRowHeight,
          anchor: {
            kind: 'start',
            offsetTop: 0,
          },
          rangeStartOffsetTop: 0,
          rangeEndOffsetTop: 0,
          mapped: false,
        }
      : null;
    if (rangeReplacement) {
      updateHistoryRangeReplacementPosition(scroller, rangeReplacement);
    }
    const anchor = rangeReplacement ? null : getFirstVisibleMessageAnchor(scroller);

    const snapshot = {
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      anchorMessageId: anchor?.messageId ?? null,
      anchorOffsetTop: anchor?.offsetTop ?? null,
      rangeReplacement,
      readyToRestore: false,
    };
    pendingOlderLoadScrollSnapshotRef.current = snapshot;
    historyScrollTransactionActiveRef.current = true;
    if (rangeReplacement) {
      viewportAnchorLockRef.current = null;
    } else {
      captureViewportAnchorLock(scroller);
    }
    return snapshot;
  }, [
    captureViewportAnchorLock,
    firstVisualMessageId,
    historyLogicalSlotHeight,
    historyScrollTransactionActiveRef,
    historySkeletonRowHeight,
    isOlderRangeVisible,
    pendingOlderLoadScrollSnapshotRef,
    renderedTopSpacerHeight,
    scrollerRef,
    viewportAnchorLockRef,
  ]);

  const captureNewerHistoryLoadScrollSnapshot = useCallback((): NewerHistoryLoadScrollSnapshot | null => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const shouldMapVisibleRange = Boolean(
      lastVisualMessageId &&
      renderedBottomSpacerHeight > 1 &&
      isNewerRangeVisible(scroller),
    );
    const bottomRangeStart = scroller.scrollHeight - renderedBottomSpacerHeight;
    const rangeReplacement: HistoryRangeReplacementSnapshot | null = shouldMapVisibleRange
      ? {
          direction: 'newer',
          seamMessageId: lastVisualMessageId!,
          seamAnchor: (() => {
            const offset = getMessageElementEdgeOffset(scroller, lastVisualMessageId!, 'bottom');
            return offset === null ? null : { edge: 'bottom', offset };
          })(),
          sourceStart: bottomRangeStart,
          sourceEnd: Math.min(
            scroller.scrollHeight,
            bottomRangeStart + historyLogicalSlotHeight,
          ),
          rowHeight: historySkeletonRowHeight,
          anchor: {
            kind: 'start',
            offsetTop: 0,
          },
          rangeStartOffsetTop: 0,
          rangeEndOffsetTop: 0,
          mapped: false,
        }
      : null;
    if (rangeReplacement) {
      updateHistoryRangeReplacementPosition(scroller, rangeReplacement);
    }
    const anchors = rangeReplacement ? [] : getMessageAnchorsAroundViewport(scroller);
    const anchor = anchors[0] ?? null;

    const snapshot = {
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      anchorMessageId: anchor?.messageId ?? null,
      anchorOffsetTop: anchor?.offsetTop ?? null,
      rangeReplacement,
      readyToRestore: false,
      fallbackAnchors: anchors.slice(1),
      distanceFromBottom: scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight),
    };
    pendingNewerLoadScrollSnapshotRef.current = snapshot;
    historyScrollTransactionActiveRef.current = true;
    if (rangeReplacement) {
      viewportAnchorLockRef.current = null;
    } else {
      captureViewportAnchorLock(scroller);
    }
    return snapshot;
  }, [
    captureViewportAnchorLock,
    historyLogicalSlotHeight,
    historyScrollTransactionActiveRef,
    historySkeletonRowHeight,
    isNewerRangeVisible,
    lastVisualMessageId,
    pendingNewerLoadScrollSnapshotRef,
    renderedBottomSpacerHeight,
    scrollerRef,
    viewportAnchorLockRef,
  ]);

  const syncScrollState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const pendingOlderSnapshot = pendingOlderLoadScrollSnapshotRef.current;
    if (
      pendingOlderSnapshot &&
      Math.abs(scroller.scrollHeight - pendingOlderSnapshot.scrollHeight) <= OLDER_LOAD_SCROLL_UPDATE_THRESHOLD
    ) {
      const scrollDelta = scroller.scrollTop - pendingOlderSnapshot.scrollTop;
      pendingOlderSnapshot.scrollTop = scroller.scrollTop;
      if (pendingOlderSnapshot.rangeReplacement) {
        moveHistoryRangeReplacementSeamAnchor(pendingOlderSnapshot.rangeReplacement, scrollDelta);
        updateHistoryRangeReplacementPosition(scroller, pendingOlderSnapshot.rangeReplacement);
      } else {
        const anchor = getFirstVisibleMessageAnchor(scroller);
        if (anchor) {
          pendingOlderSnapshot.anchorMessageId = anchor.messageId;
          pendingOlderSnapshot.anchorOffsetTop = anchor.offsetTop;
        } else if (pendingOlderSnapshot.anchorOffsetTop !== null) {
          pendingOlderSnapshot.anchorOffsetTop -= scrollDelta;
        }
      }
    }

    const pendingNewerSnapshot = pendingNewerLoadScrollSnapshotRef.current;
    if (
      pendingNewerSnapshot &&
      Math.abs(scroller.scrollHeight - pendingNewerSnapshot.scrollHeight) <= OLDER_LOAD_SCROLL_UPDATE_THRESHOLD
    ) {
      const scrollDelta = scroller.scrollTop - pendingNewerSnapshot.scrollTop;
      pendingNewerSnapshot.scrollTop = scroller.scrollTop;
      pendingNewerSnapshot.distanceFromBottom =
        scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
      if (pendingNewerSnapshot.rangeReplacement) {
        moveHistoryRangeReplacementSeamAnchor(pendingNewerSnapshot.rangeReplacement, scrollDelta);
        updateHistoryRangeReplacementPosition(scroller, pendingNewerSnapshot.rangeReplacement);
      } else {
        const anchors = getMessageAnchorsAroundViewport(scroller);
        const anchor = anchors[0];
        if (anchor) {
          pendingNewerSnapshot.anchorMessageId = anchor.messageId;
          pendingNewerSnapshot.anchorOffsetTop = anchor.offsetTop;
          pendingNewerSnapshot.fallbackAnchors = anchors.slice(1);
        } else {
          if (pendingNewerSnapshot.anchorOffsetTop !== null) {
            pendingNewerSnapshot.anchorOffsetTop -= scrollDelta;
          }
          pendingNewerSnapshot.fallbackAnchors = pendingNewerSnapshot.fallbackAnchors.map(
            (fallbackAnchor) => ({
              ...fallbackAnchor,
              offsetTop: fallbackAnchor.offsetTop - scrollDelta,
            }),
          );
        }
      }
    }

    const scrollState = getScrollState(scroller);

    atBottomRef.current = scrollState.atBottom;
    showJumpToPresentRef.current = scrollState.shouldShowJumpToPresent;
    setShowJumpToPresent(scrollState.shouldShowJumpToPresent);
    onOwnSendHistoryModeChange?.(
      !scrollState.atBottom ||
      scrollState.shouldShowJumpToPresent ||
      hasNewer ||
      !scrollState.isAtPresent ||
      !isAtPresent
    );

    if (scrollState.atBottom) {
      forceFollowOutputRef.current = false;
      if (!historyScrollTransactionActiveRef.current) {
        viewportAnchorLockRef.current = null;
      }
    } else if (!viewportAnchorRestoreInProgressRef.current) {
      captureViewportAnchorLock(scroller);
    }

    setIsAtPresent(scrollState.isAtPresent);
  }, [
    atBottomRef,
    captureViewportAnchorLock,
    forceFollowOutputRef,
    getScrollState,
    hasNewer,
    historyScrollTransactionActiveRef,
    isAtPresent,
    onOwnSendHistoryModeChange,
    pendingNewerLoadScrollSnapshotRef,
    pendingOlderLoadScrollSnapshotRef,
    scrollerRef,
    setIsAtPresent,
    setShowJumpToPresent,
    showJumpToPresentRef,
    viewportAnchorLockRef,
    viewportAnchorRestoreInProgressRef,
  ]);

  const restoreHistoryLoadScrollSnapshot = useCallback((snapshot: HistoryLoadScrollSnapshot) => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return false;
    }

    const replacement = snapshot.rangeReplacement;
    if (replacement) {
      if (!replacement.mapped) {
        const messageElements = Array.from(
          scroller.querySelectorAll<HTMLElement>('[data-message-id]'),
        );
        const seamIndex = messageElements.findIndex(
          (element) => element.dataset.messageId === replacement.seamMessageId,
        );

        if (seamIndex > 0) {
          const insertedElements = messageElements.slice(0, seamIndex);
          const firstInsertedElement = insertedElements[0]!;
          const seamElement = messageElements[seamIndex]!;
          const scrollerRect = scroller.getBoundingClientRect();
          if (!restoreHistoryRangeReplacementSeamAnchor(scroller, replacement)) {
            restoreHistoryRangeReplacementAnchor({
              scroller,
              replacement,
              insertedElements,
              rangeStartOffsetTop:
                firstInsertedElement.getBoundingClientRect().top - scrollerRect.top,
              rangeEndOffsetTop:
                seamElement.getBoundingClientRect().top - scrollerRect.top,
            });
          }
        } else if (snapshot.readyToRestore && !hasOlderRef.current) {
          scroller.scrollTop = 0;
          replacement.mapped = true;
        }
      }

      if (replacement.mapped) {
        syncScrollState();
        return true;
      }

      return false;
    }

    if (!hasOlderRef.current && snapshot.scrollTop <= olderTopExhaustionThreshold) {
      scroller.scrollTop = 0;
      syncScrollState();
      return true;
    }

    if (restoreVisibleMessageAnchor(scroller, snapshot)) {
      syncScrollState();
      return true;
    }

    const scrollHeightDelta = scroller.scrollHeight - snapshot.scrollHeight;
    if (Math.abs(scrollHeightDelta) > 0.5) {
      scroller.scrollTop = snapshot.scrollTop + scrollHeightDelta;
      syncScrollState();
      return true;
    }

    syncScrollState();
    return true;
  }, [hasOlderRef, olderTopExhaustionThreshold, scrollerRef, syncScrollState]);

  const restoreNewerHistoryLoadScrollSnapshot = useCallback((snapshot: NewerHistoryLoadScrollSnapshot) => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return false;
    }

    const replacement = snapshot.rangeReplacement;
    if (replacement) {
      if (!replacement.mapped) {
        const messageElements = Array.from(
          scroller.querySelectorAll<HTMLElement>('[data-message-id]'),
        );
        const seamIndex = messageElements.findIndex(
          (element) => element.dataset.messageId === replacement.seamMessageId,
        );

        if (seamIndex >= 0 && seamIndex < messageElements.length - 1) {
          const seamElement = messageElements[seamIndex]!;
          const insertedElements = messageElements.slice(seamIndex + 1);
          const lastInsertedElement = insertedElements[insertedElements.length - 1]!;
          const scrollerRect = scroller.getBoundingClientRect();
          if (!restoreHistoryRangeReplacementSeamAnchor(scroller, replacement)) {
            restoreHistoryRangeReplacementAnchor({
              scroller,
              replacement,
              insertedElements,
              rangeStartOffsetTop:
                seamElement.getBoundingClientRect().bottom - scrollerRect.top,
              rangeEndOffsetTop:
                lastInsertedElement.getBoundingClientRect().bottom - scrollerRect.top,
            });
          }
        } else if (snapshot.readyToRestore && !hasNewerRef.current) {
          scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          replacement.mapped = true;
        }
      }

      if (replacement.mapped) {
        syncScrollState();
        return true;
      }

      return false;
    }

    if (restoreVisibleMessageAnchor(scroller, snapshot)) {
      syncScrollState();
      return true;
    }

    for (const anchor of snapshot.fallbackAnchors) {
      if (restoreVisibleMessageAnchor(scroller, {
        anchorMessageId: anchor.messageId,
        anchorOffsetTop: anchor.offsetTop,
      })) {
        syncScrollState();
        return true;
      }
    }

    scroller.scrollTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight - snapshot.distanceFromBottom,
    );
    syncScrollState();
    return true;
  }, [hasNewerRef, scrollerRef, syncScrollState]);

  const loadOlderPreservingViewport = useCallback(async () => {
    const snapshot = captureHistoryLoadScrollSnapshot();
    const didLoad = await loadOlder();
    const isHistoryPaused = historyLoadPausedUntilRef.current > Date.now();
    setOlderRangeError(didLoad === false && !isHistoryPaused);
    if (didLoad && snapshot && pendingOlderLoadScrollSnapshotRef.current === snapshot) {
      snapshot.readyToRestore = true;
      setHistoryRestoreRevision((current) => current + 1);
    } else if (!didLoad && snapshot && pendingOlderLoadScrollSnapshotRef.current === snapshot) {
      pendingOlderLoadScrollSnapshotRef.current = null;
      if (!pendingNewerLoadScrollSnapshotRef.current) {
        historyScrollTransactionActiveRef.current = false;
      }
    }
  }, [
    captureHistoryLoadScrollSnapshot,
    historyLoadPausedUntilRef,
    historyScrollTransactionActiveRef,
    loadOlder,
    pendingNewerLoadScrollSnapshotRef,
    pendingOlderLoadScrollSnapshotRef,
    setOlderRangeError,
  ]);

  const loadNewerPreservingViewport = useCallback(async () => {
    const snapshot = captureNewerHistoryLoadScrollSnapshot();
    const didLoad = await loadNewer();
    const isHistoryPaused = historyLoadPausedUntilRef.current > Date.now();
    setNewerRangeError(didLoad === false && !isHistoryPaused);
    if (didLoad && snapshot && pendingNewerLoadScrollSnapshotRef.current === snapshot) {
      snapshot.readyToRestore = true;
      setHistoryRestoreRevision((current) => current + 1);
    } else if (!didLoad && snapshot && pendingNewerLoadScrollSnapshotRef.current === snapshot) {
      pendingNewerLoadScrollSnapshotRef.current = null;
      if (!pendingOlderLoadScrollSnapshotRef.current) {
        historyScrollTransactionActiveRef.current = false;
      }
    }
  }, [
    captureNewerHistoryLoadScrollSnapshot,
    historyLoadPausedUntilRef,
    historyScrollTransactionActiveRef,
    loadNewer,
    pendingNewerLoadScrollSnapshotRef,
    pendingOlderLoadScrollSnapshotRef,
    setNewerRangeError,
  ]);

  const restoreHistoryViewportAfterCommit = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    // Pagination state can commit before the load promise settles. Compensate
    // that commit immediately so the skeleton-to-message swap never paints
    // without its captured viewport anchor.
    let restoredHistoryViewport = false;
    const olderSnapshot = pendingOlderLoadScrollSnapshotRef.current;
    const newerSnapshot = pendingNewerLoadScrollSnapshotRef.current;
    viewportAnchorRestoreInProgressRef.current = Boolean(olderSnapshot || newerSnapshot);

    try {
      if (olderSnapshot) {
        const restoredOlderViewport = restoreHistoryLoadScrollSnapshot(olderSnapshot);
        restoredHistoryViewport = restoredOlderViewport || restoredHistoryViewport;
        if (olderSnapshot.readyToRestore && restoredOlderViewport) {
          pendingOlderLoadScrollSnapshotRef.current = null;
        }
      }

      if (newerSnapshot) {
        const restoredNewerViewport = restoreNewerHistoryLoadScrollSnapshot(newerSnapshot);
        restoredHistoryViewport = restoredNewerViewport || restoredHistoryViewport;
        if (newerSnapshot.readyToRestore && restoredNewerViewport) {
          pendingNewerLoadScrollSnapshotRef.current = null;
        }
      }
    } finally {
      viewportAnchorRestoreInProgressRef.current = false;
    }

    if (restoredHistoryViewport) {
      captureViewportAnchorLock(scroller);
    }

    historyScrollTransactionActiveRef.current = Boolean(
      pendingOlderLoadScrollSnapshotRef.current ||
      pendingNewerLoadScrollSnapshotRef.current
    );
  }, [
    captureViewportAnchorLock,
    historyScrollTransactionActiveRef,
    pendingNewerLoadScrollSnapshotRef,
    pendingOlderLoadScrollSnapshotRef,
    restoreNewerHistoryLoadScrollSnapshot,
    restoreHistoryLoadScrollSnapshot,
    scrollerRef,
    viewportAnchorRestoreInProgressRef,
  ]);

  return {
    historyRestoreRevision,
    loadOlderPreservingViewport,
    loadNewerPreservingViewport,
    restoreHistoryViewportAfterCommit,
    syncScrollState,
  };
}
