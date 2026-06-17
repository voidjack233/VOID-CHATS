export interface HistoryLoadScrollSnapshot {
  scrollHeight: number;
  scrollTop: number;
  anchorMessageId: string | null;
  anchorOffsetTop: number | null;
  rangeReplacement: HistoryRangeReplacementSnapshot | null;
  readyToRestore: boolean;
}

export interface MessageAnchorSnapshot {
  messageId: string;
  offsetTop: number;
}

export interface HistoryRangeReplacementSnapshot {
  direction: 'older' | 'newer';
  seamMessageId: string;
  seamAnchor: {
    edge: 'top' | 'bottom';
    offset: number;
  } | null;
  sourceStart: number;
  sourceEnd: number;
  rowHeight: number;
  anchor:
    | {
        kind: 'row';
        rowIndex: number;
        offsetTop: number;
      }
    | {
        kind: 'start' | 'end';
        offsetTop: number;
      };
  rangeStartOffsetTop: number;
  rangeEndOffsetTop: number;
  mapped: boolean;
}

export interface NewerHistoryLoadScrollSnapshot extends HistoryLoadScrollSnapshot {
  fallbackAnchors: MessageAnchorSnapshot[];
  distanceFromBottom: number;
}

export interface ViewportAnchorLock {
  anchors: MessageAnchorSnapshot[];
}

export const getVisibleMessageAnchors = (scroller: HTMLElement): MessageAnchorSnapshot[] => {
  const scrollerRect = scroller.getBoundingClientRect();
  const elements = Array.from(scroller.querySelectorAll<HTMLElement>('[data-message-id]'));
  const anchors: MessageAnchorSnapshot[] = [];

  for (const element of elements) {
    const messageId = element.dataset.messageId;
    if (!messageId) continue;

    const rect = element.getBoundingClientRect();
    if (rect.bottom <= scrollerRect.top || rect.top >= scrollerRect.bottom) {
      continue;
    }

    anchors.push({
      messageId,
      offsetTop: rect.top - scrollerRect.top,
    });
  }

  return anchors;
};

export const getMessageAnchorsAroundViewport = (scroller: HTMLElement): MessageAnchorSnapshot[] => {
  const visibleAnchors = getVisibleMessageAnchors(scroller);
  if (visibleAnchors.length > 0) {
    return visibleAnchors;
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const elements = Array.from(scroller.querySelectorAll<HTMLElement>('[data-message-id]'));
  let closestBefore: MessageAnchorSnapshot | null = null;
  let closestAfter: MessageAnchorSnapshot | null = null;

  for (const element of elements) {
    const messageId = element.dataset.messageId;
    if (!messageId) continue;

    const rect = element.getBoundingClientRect();
    const anchor = {
      messageId,
      offsetTop: rect.top - scrollerRect.top,
    };

    if (rect.bottom <= scrollerRect.top) {
      closestBefore = anchor;
      continue;
    }

    if (rect.top >= scrollerRect.bottom && !closestAfter) {
      closestAfter = anchor;
    }
  }

  return [closestBefore, closestAfter].filter((anchor): anchor is MessageAnchorSnapshot => Boolean(anchor));
};

export const getFirstVisibleMessageAnchor = (scroller: HTMLElement) => {
  return getVisibleMessageAnchors(scroller)[0] ?? null;
};

export const escapeMessageIdSelector = (messageId: string) => {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(messageId);
  }

  return messageId.replace(/["\\]/g, '\\$&');
};

export const getMessageElementById = (scroller: HTMLElement, messageId: string) => (
  scroller.querySelector<HTMLElement>(`[data-message-id="${escapeMessageIdSelector(messageId)}"]`)
);

const getElementEdgeOffset = (
  scroller: HTMLElement,
  element: HTMLElement,
  edge: 'top' | 'bottom',
) => {
  const scrollerRect = scroller.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return edge === 'bottom'
    ? rect.bottom - scrollerRect.top
    : rect.top - scrollerRect.top;
};

export const getMessageElementEdgeOffset = (
  scroller: HTMLElement,
  messageId: string,
  edge: 'top' | 'bottom',
) => {
  const element = getMessageElementById(scroller, messageId);
  return element ? getElementEdgeOffset(scroller, element, edge) : null;
};

export const restoreVisibleMessageAnchor = (
  scroller: HTMLElement,
  snapshot: Pick<HistoryLoadScrollSnapshot, 'anchorMessageId' | 'anchorOffsetTop'>,
) => {
  if (!snapshot.anchorMessageId || snapshot.anchorOffsetTop === null) {
    return false;
  }

  const anchorElement = getMessageElementById(scroller, snapshot.anchorMessageId);
  if (!anchorElement) {
    return false;
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const nextOffsetTop = anchorElement.getBoundingClientRect().top - scrollerRect.top;
  const offsetDelta = nextOffsetTop - snapshot.anchorOffsetTop;
  if (Math.abs(offsetDelta) <= 0.5) {
    return true;
  }

  scroller.scrollTop = Math.max(0, scroller.scrollTop + offsetDelta);
  return true;
};

export const updateHistoryRangeReplacementPosition = (
  scroller: HTMLElement,
  replacement: HistoryRangeReplacementSnapshot,
) => {
  const sourceHeight = replacement.sourceEnd - replacement.sourceStart;
  if (sourceHeight <= 0) {
    return;
  }

  const viewportStart = scroller.scrollTop;
  const viewportEnd = viewportStart + scroller.clientHeight;
  replacement.rangeStartOffsetTop = replacement.sourceStart - viewportStart;
  replacement.rangeEndOffsetTop = replacement.sourceEnd - viewportStart;

  if (viewportEnd <= replacement.sourceStart) {
    replacement.anchor = {
      kind: 'start',
      offsetTop: replacement.rangeStartOffsetTop,
    };
    return;
  }

  if (viewportStart >= replacement.sourceEnd) {
    replacement.anchor = {
      kind: 'end',
      offsetTop: replacement.rangeEndOffsetTop,
    };
    return;
  }

  const firstVisibleSourcePoint = Math.max(viewportStart, replacement.sourceStart);
  const availableRowCount = Math.max(1, Math.ceil(sourceHeight / replacement.rowHeight));
  const rowIndex = Math.min(
    availableRowCount - 1,
    Math.max(0, Math.floor(
      (firstVisibleSourcePoint - replacement.sourceStart) / replacement.rowHeight,
    )),
  );
  const rowTop = replacement.sourceStart + (rowIndex * replacement.rowHeight);
  replacement.anchor = {
    kind: 'row',
    rowIndex,
    offsetTop: rowTop - viewportStart,
  };
};

export const moveHistoryRangeReplacementSeamAnchor = (
  replacement: HistoryRangeReplacementSnapshot,
  scrollDelta: number,
) => {
  if (!replacement.seamAnchor) {
    return;
  }

  replacement.seamAnchor.offset -= scrollDelta;
};

export const restoreHistoryRangeReplacementSeamAnchor = (
  scroller: HTMLElement,
  replacement: HistoryRangeReplacementSnapshot,
) => {
  const seamAnchor = replacement.seamAnchor;
  if (!seamAnchor) {
    return false;
  }

  const seamElement = getMessageElementById(scroller, replacement.seamMessageId);
  if (!seamElement) {
    return false;
  }

  const currentOffset = getElementEdgeOffset(scroller, seamElement, seamAnchor.edge);
  const offsetDelta = currentOffset - seamAnchor.offset;
  if (Math.abs(offsetDelta) > 0.5) {
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.min(
      maxScrollTop,
      Math.max(0, scroller.scrollTop + offsetDelta),
    );
  }

  replacement.mapped = true;
  return true;
};

export const restoreHistoryRangeReplacementAnchor = ({
  scroller,
  replacement,
  insertedElements,
  rangeStartOffsetTop,
  rangeEndOffsetTop,
}: {
  scroller: HTMLElement;
  replacement: HistoryRangeReplacementSnapshot;
  insertedElements: HTMLElement[];
  rangeStartOffsetTop: number;
  rangeEndOffsetTop: number;
}) => {
  const anchor = replacement.anchor;
  let currentOffsetTop: number;
  let targetOffsetTop: number;

  if (anchor.kind === 'row' && anchor.rowIndex < insertedElements.length) {
    const targetElement = insertedElements[anchor.rowIndex]!;
    const scrollerRect = scroller.getBoundingClientRect();
    currentOffsetTop = targetElement.getBoundingClientRect().top - scrollerRect.top;
    targetOffsetTop = anchor.offsetTop;
  } else if (anchor.kind === 'start') {
    currentOffsetTop = rangeStartOffsetTop;
    targetOffsetTop = anchor.offsetTop;
  } else {
    currentOffsetTop = rangeEndOffsetTop;
    targetOffsetTop = anchor.kind === 'end'
      ? anchor.offsetTop
      : replacement.rangeEndOffsetTop;
  }

  const offsetDelta = currentOffsetTop - targetOffsetTop;
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.min(
    maxScrollTop,
    Math.max(0, scroller.scrollTop + offsetDelta),
  );
  replacement.mapped = true;
  return true;
};
