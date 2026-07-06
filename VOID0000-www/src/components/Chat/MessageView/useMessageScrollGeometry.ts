import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

export type HistoryRangeStatus = 'idle' | 'loading' | 'loaded' | 'error';

interface ScrollGeometryInput {
  scrollerRef?: { current: HTMLElement | null };
  scrollCompensationBlockerRef?: { current: unknown };
  resetKey?: string;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  hasOlder: boolean;
  hasNewer: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  olderRangeError: boolean;
  newerRangeError: boolean;
  historyLogicalSlotHeight: number;
  bottomThreshold: number;
  jumpToPresentRevealDistance: number;
  enablePhysicalSpacerWindowing?: boolean;
  maxPhysicalSpacerHeight?: number;
  maxPhysicalBottomSpacerHeight?: number;
}

interface ScrollState {
  distanceFromBottom: number;
  atBottom: boolean;
  shouldShowJumpToPresent: boolean;
  isAtPresent: boolean;
}

export const useMessageScrollGeometry = ({
  scrollerRef,
  scrollCompensationBlockerRef,
  resetKey,
  topSpacerHeight,
  bottomSpacerHeight,
  hasOlder,
  hasNewer,
  loadingOlder,
  loadingNewer,
  olderRangeError,
  newerRangeError,
  historyLogicalSlotHeight,
  bottomThreshold,
  jumpToPresentRevealDistance,
  enablePhysicalSpacerWindowing = false,
  maxPhysicalSpacerHeight = Number.POSITIVE_INFINITY,
  maxPhysicalBottomSpacerHeight,
}: ScrollGeometryInput) => {
  const topTrimmedSpacerHeight = hasOlder ? Math.max(0, topSpacerHeight) : 0;
  const bottomTrimmedSpacerHeight = Math.max(0, bottomSpacerHeight);
  const topEstimatedLoadingHeight = hasOlder && topTrimmedSpacerHeight <= 1 ? historyLogicalSlotHeight : 0;
  const bottomEstimatedLoadingHeight = hasNewer && bottomTrimmedSpacerHeight <= 1 ? historyLogicalSlotHeight : 0;
  const topLogicalRangeHeight = topTrimmedSpacerHeight + topEstimatedLoadingHeight;
  const bottomLogicalRangeHeight = bottomTrimmedSpacerHeight + bottomEstimatedLoadingHeight;

  const physicalTopSpacerLimit = enablePhysicalSpacerWindowing && Number.isFinite(maxPhysicalSpacerHeight)
    ? Math.max(0, maxPhysicalSpacerHeight)
    : Number.POSITIVE_INFINITY;
  const bottomSpacerLimitSource = maxPhysicalBottomSpacerHeight ?? maxPhysicalSpacerHeight;
  const physicalBottomSpacerLimit = enablePhysicalSpacerWindowing && Number.isFinite(bottomSpacerLimitSource)
    ? Math.max(0, bottomSpacerLimitSource)
    : Number.POSITIVE_INFINITY;

  // Logical spacers remain the source of truth. Rendered spacers can be capped
  // so the browser does not carry a giant physical scroll layer forever.
  const renderedTopSpacerHeight = Math.min(topLogicalRangeHeight, physicalTopSpacerLimit);
  const renderedBottomSpacerHeight = Math.min(bottomLogicalRangeHeight, physicalBottomSpacerLimit);
  const topOriginOffset = Math.max(0, topLogicalRangeHeight - renderedTopSpacerHeight);
  const bottomOriginOffset = Math.max(0, bottomLogicalRangeHeight - renderedBottomSpacerHeight);
  const isPhysicalSpacerCompacted = topOriginOffset > 0 || bottomOriginOffset > 0;

  const previousResetKeyRef = useRef(resetKey);
  const previousRenderedTopSpacerHeightRef = useRef<number | null>(null);
  const previousTopOriginOffsetRef = useRef(0);

  useLayoutEffect(() => {
    if (previousResetKeyRef.current !== resetKey) {
      previousResetKeyRef.current = resetKey;
      previousRenderedTopSpacerHeightRef.current = renderedTopSpacerHeight;
      previousTopOriginOffsetRef.current = topOriginOffset;
      return;
    }

    const previousRenderedTopSpacerHeight = previousRenderedTopSpacerHeightRef.current;
    const previousTopOriginOffset = previousTopOriginOffsetRef.current;
    previousRenderedTopSpacerHeightRef.current = renderedTopSpacerHeight;
    previousTopOriginOffsetRef.current = topOriginOffset;

    if (
      !enablePhysicalSpacerWindowing ||
      previousRenderedTopSpacerHeight === null ||
      (previousTopOriginOffset <= 0 && topOriginOffset <= 0) ||
      scrollCompensationBlockerRef?.current
    ) {
      return;
    }

    const topSpacerDelta = renderedTopSpacerHeight - previousRenderedTopSpacerHeight;
    if (Math.abs(topSpacerDelta) <= 0.5) {
      return;
    }

    const scroller = scrollerRef?.current;
    if (!scroller) {
      return;
    }

    scroller.scrollTop = Math.max(0, scroller.scrollTop + topSpacerDelta);
  }, [
    enablePhysicalSpacerWindowing,
    renderedTopSpacerHeight,
    resetKey,
    scrollerRef,
    scrollCompensationBlockerRef,
    topOriginOffset,
  ]);

  const olderRangeStatus: HistoryRangeStatus = loadingOlder
    ? 'loading'
    : olderRangeError
      ? 'error'
      : topLogicalRangeHeight <= 1
        ? 'loaded'
        : hasOlder
          ? 'idle'
          : 'error';

  const newerRangeStatus: HistoryRangeStatus = loadingNewer
    ? 'loading'
    : newerRangeError
      ? 'error'
      : bottomLogicalRangeHeight <= 1
        ? 'loaded'
        : hasNewer
          ? 'idle'
          : 'error';

  const getScrollState = useCallback((scroller: HTMLElement): ScrollState => {
    const distanceFromBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    const atBottom = distanceFromBottom <= bottomThreshold && !hasNewer && bottomLogicalRangeHeight <= 1;
    const shouldShowJumpToPresent = !atBottom && (
      hasNewer ||
      bottomLogicalRangeHeight > 1 ||
      distanceFromBottom >= jumpToPresentRevealDistance
    );

    return {
      distanceFromBottom,
      atBottom,
      shouldShowJumpToPresent,
      isAtPresent: atBottom && !hasNewer,
    };
  }, [bottomLogicalRangeHeight, bottomThreshold, hasNewer, jumpToPresentRevealDistance]);

  const getOlderBoundaryDistance = useCallback((scroller: HTMLElement) => (
    scroller.scrollTop - Math.max(0, renderedTopSpacerHeight)
  ), [renderedTopSpacerHeight]);

  const getNewerBoundaryDistance = useCallback((scroller: HTMLElement) => (
    scroller.scrollHeight -
    Math.max(0, renderedBottomSpacerHeight) -
    (scroller.scrollTop + scroller.clientHeight)
  ), [renderedBottomSpacerHeight]);

  const isOlderRangeVisible = useCallback((scroller: HTMLElement) => {
    if (renderedTopSpacerHeight <= 1) {
      return false;
    }

    return scroller.scrollTop < renderedTopSpacerHeight &&
      scroller.scrollTop + scroller.clientHeight > 0;
  }, [renderedTopSpacerHeight]);

  const isNewerRangeVisible = useCallback((scroller: HTMLElement) => {
    if (renderedBottomSpacerHeight <= 1) {
      return false;
    }

    const bottomRangeStart = scroller.scrollHeight - renderedBottomSpacerHeight;
    return scroller.scrollTop + scroller.clientHeight >= bottomRangeStart &&
      scroller.scrollTop <= scroller.scrollHeight;
  }, [renderedBottomSpacerHeight]);

  const getLoadedScrollHeight = useCallback((scroller: HTMLElement) => (
    Math.max(0, scroller.scrollHeight - (renderedTopSpacerHeight + renderedBottomSpacerHeight))
  ), [renderedBottomSpacerHeight, renderedTopSpacerHeight]);

  return useMemo(() => ({
    topTrimmedSpacerHeight,
    bottomTrimmedSpacerHeight,
    topEstimatedLoadingHeight,
    bottomEstimatedLoadingHeight,
    topLogicalRangeHeight,
    bottomLogicalRangeHeight,
    renderedTopSpacerHeight,
    renderedBottomSpacerHeight,
    topOriginOffset,
    bottomOriginOffset,
    isPhysicalSpacerCompacted,
    olderRangeStatus,
    newerRangeStatus,
    getScrollState,
    getOlderBoundaryDistance,
    getNewerBoundaryDistance,
    isOlderRangeVisible,
    isNewerRangeVisible,
    getLoadedScrollHeight,
  }), [
    bottomEstimatedLoadingHeight,
    bottomLogicalRangeHeight,
    bottomTrimmedSpacerHeight,
    getLoadedScrollHeight,
    getNewerBoundaryDistance,
    getOlderBoundaryDistance,
    getScrollState,
    isNewerRangeVisible,
    isOlderRangeVisible,
    newerRangeStatus,
    olderRangeStatus,
    bottomOriginOffset,
    renderedBottomSpacerHeight,
    renderedTopSpacerHeight,
    isPhysicalSpacerCompacted,
    topOriginOffset,
    topEstimatedLoadingHeight,
    topLogicalRangeHeight,
    topTrimmedSpacerHeight,
  ]);
};
