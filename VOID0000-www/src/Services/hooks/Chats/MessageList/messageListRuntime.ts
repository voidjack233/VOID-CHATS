import {
  FALLBACK_MESSAGE_HEIGHT,
  MAX_ACTIVE_CONVERSATIONS,
  MAX_RUNTIME_MEASURED_HEIGHTS_PER_CONVERSATION,
  MAX_RUNTIME_MESSAGES_PER_CONVERSATION,
  MESSAGE_WINDOW_TRIM_TARGET,
  MESSAGE_WINDOW_TRIM_TRIGGER,
} from '../../../Chat/chatConstants';
import type { Message } from '../../../Chat/chatService';
import { sortMessages } from './messageListPersistence';

type PageDirection = 'initial' | 'older' | 'newer' | 'live';

interface PageCache {
  id: string;
  direction: PageDirection;
  ids: string[];
  oldestCursor: string | null;
  newestCursor: string | null;
  loadedAt: number;
}

interface ConversationRuntime {
  conversationId: string;
  messageById: Map<string, Message>;
  pages: PageCache[];
  renderedIds: string[];
  pendingLiveIds: string[];
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  heightByMessageId: Map<string, number>;
  oldestCursor: string | null;
  newestCursor: string | null;
  hasOlder: boolean;
  hasNewer: boolean;
  lastAccessedAt: number;
}

interface RuntimeStats {
  renderedIdsLength: number;
  messageByIdSize: number;
  pagesLength: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
}

const runtimeRegistry = new Map<string, ConversationRuntime>();

const getMessageId = (message: Pick<Message, 'message_id'>) => String(message.message_id);

const createEmptyRuntime = (conversationId: string): ConversationRuntime => ({
  conversationId,
  messageById: new Map(),
  pages: [],
  renderedIds: [],
  pendingLiveIds: [],
  topSpacerHeight: 0,
  bottomSpacerHeight: 0,
  heightByMessageId: new Map(),
  oldestCursor: null,
  newestCursor: null,
  hasOlder: false,
  hasNewer: false,
  lastAccessedAt: Date.now(),
});

const cloneRuntime = (runtime: ConversationRuntime): ConversationRuntime => ({
  ...runtime,
  messageById: new Map(runtime.messageById),
  pages: runtime.pages.map((page) => ({ ...page, ids: [...page.ids] })),
  renderedIds: [...runtime.renderedIds],
  pendingLiveIds: [...runtime.pendingLiveIds],
  heightByMessageId: new Map(runtime.heightByMessageId),
  lastAccessedAt: Date.now(),
});

const getRenderedMessages = (runtime: ConversationRuntime): Message[] =>
  runtime.renderedIds
    .map((id) => runtime.messageById.get(id))
    .filter((message): message is Message => Boolean(message));

const getRuntimeStats = (runtime: ConversationRuntime): RuntimeStats => ({
  renderedIdsLength: runtime.renderedIds.length,
  messageByIdSize: runtime.messageById.size,
  pagesLength: runtime.pages.length,
  topSpacerHeight: runtime.topSpacerHeight,
  bottomSpacerHeight: runtime.bottomSpacerHeight,
});

const getMessageHeight = (
  runtime: ConversationRuntime,
  message: Message,
  resolveHeight?: (message: Message) => number,
) => {
  const id = getMessageId(message);
  const cachedHeight = runtime.heightByMessageId.get(id);
  if (typeof cachedHeight === 'number' && Number.isFinite(cachedHeight) && cachedHeight > 0) {
    return cachedHeight;
  }

  const resolvedHeight = resolveHeight?.(message);
  if (typeof resolvedHeight === 'number' && Number.isFinite(resolvedHeight) && resolvedHeight > 0) {
    runtime.heightByMessageId.set(id, resolvedHeight);
    return resolvedHeight;
  }

  return FALLBACK_MESSAGE_HEIGHT;
};

const sumMessageHeights = (
  runtime: ConversationRuntime,
  messages: Message[],
  resolveHeight?: (message: Message) => number,
) => messages.reduce((total, message) => total + getMessageHeight(runtime, message, resolveHeight), 0);

const removeDuplicateIds = (ids: string[]) => Array.from(new Set(ids));

const getRuntimeMessagesByIds = (runtime: ConversationRuntime, ids: string[]): Message[] =>
  ids
    .map((id) => runtime.messageById.get(id))
    .filter((message): message is Message => Boolean(message));

const stripMessageIdsFromRuntime = (runtime: ConversationRuntime, ids: Set<string>) => {
  if (ids.size === 0) {
    return;
  }

  ids.forEach((id) => {
    runtime.messageById.delete(id);
  });

  runtime.pendingLiveIds = runtime.pendingLiveIds.filter((id) => !ids.has(id));
  runtime.pages = runtime.pages
    .map((page) => ({ ...page, ids: page.ids.filter((id) => !ids.has(id)) }))
    .filter((page) => page.ids.length > 0);
};

const evictTrimmedMessages = (
  runtime: ConversationRuntime,
  trimmedOldIds: string[],
  trimmedNewIds: string[],
  options: {
    resolveHeight?: (message: Message) => number;
  } = {},
) => {
  const renderedIds = new Set(runtime.renderedIds);
  const oldIds = removeDuplicateIds(trimmedOldIds).filter((id) => !renderedIds.has(id));
  const newIds = removeDuplicateIds(trimmedNewIds).filter((id) => !renderedIds.has(id));
  const oldMessages = getRuntimeMessagesByIds(runtime, oldIds);
  const newMessages = getRuntimeMessagesByIds(runtime, newIds);

  runtime.topSpacerHeight += sumMessageHeights(runtime, oldMessages, options.resolveHeight);
  runtime.bottomSpacerHeight += sumMessageHeights(runtime, newMessages, options.resolveHeight);

  stripMessageIdsFromRuntime(runtime, new Set([...oldIds, ...newIds]));
};

const upsertMessages = (runtime: ConversationRuntime, messages: Message[]) => {
  messages.forEach((message) => {
    runtime.messageById.set(getMessageId(message), message);
  });
};

const toSortedUniqueIds = (runtime: ConversationRuntime, messages: Message[]) => {
  upsertMessages(runtime, messages);
  return sortMessages(messages).map(getMessageId);
};

const makePage = (
  direction: PageDirection,
  ids: string[],
): PageCache => ({
  id: `${direction}:${ids[0] || 'empty'}:${ids[ids.length - 1] || 'empty'}:${Date.now()}`,
  direction,
  ids,
  oldestCursor: ids[0] || null,
  newestCursor: ids[ids.length - 1] || null,
  loadedAt: Date.now(),
});

const pruneMeasuredHeightCache = (runtime: ConversationRuntime) => {
  if (runtime.heightByMessageId.size <= MAX_RUNTIME_MEASURED_HEIGHTS_PER_CONVERSATION) {
    return;
  }

  const protectedIds = new Set(runtime.renderedIds);
  for (const messageId of runtime.heightByMessageId.keys()) {
    if (runtime.heightByMessageId.size <= MAX_RUNTIME_MEASURED_HEIGHTS_PER_CONVERSATION) {
      break;
    }
    if (!protectedIds.has(messageId)) {
      runtime.heightByMessageId.delete(messageId);
    }
  }
};

const pruneRuntimeCache = (runtime: ConversationRuntime) => {
  if (runtime.messageById.size <= MAX_RUNTIME_MESSAGES_PER_CONVERSATION) {
    return;
  }

  const protectedIds = new Set(runtime.renderedIds);
  const pendingIds = new Set(runtime.pendingLiveIds);
  const renderedTimes = runtime.renderedIds
    .map((id) => new Date(runtime.messageById.get(id)?.created_at || 0).getTime())
    .filter((time) => Number.isFinite(time) && time > 0);
  const oldestRenderedTime = renderedTimes.length > 0 ? Math.min(...renderedTimes) : 0;
  const newestRenderedTime = renderedTimes.length > 0 ? Math.max(...renderedTimes) : 0;
  const getDistanceFromRenderedWindow = (message: Message) => {
    const time = new Date(message.created_at).getTime();
    if (!Number.isFinite(time) || oldestRenderedTime <= 0 || newestRenderedTime <= 0) {
      return 0;
    }
    if (time < oldestRenderedTime) return oldestRenderedTime - time;
    if (time > newestRenderedTime) return time - newestRenderedTime;
    return 0;
  };
  const candidateIds = Array.from(runtime.messageById.entries())
    .filter(([id]) => !protectedIds.has(id) && !pendingIds.has(id))
    .sort(([, left], [, right]) => getDistanceFromRenderedWindow(right) - getDistanceFromRenderedWindow(left))
    .map(([id]) => id);
  const excessCount = runtime.messageById.size - MAX_RUNTIME_MESSAGES_PER_CONVERSATION;
  const evictIds = candidateIds.slice(0, Math.max(0, excessCount));
  stripMessageIdsFromRuntime(runtime, new Set(evictIds));
  pruneMeasuredHeightCache(runtime);
};

const recordMeasuredMessageHeights = (
  currentRuntime: ConversationRuntime,
  measurements: Array<{ messageId: string; height: number }>,
) => {
  const changedMeasurements = measurements.filter(({ messageId, height }) => {
    if (!messageId || !Number.isFinite(height) || height <= 0) {
      return false;
    }

    const currentHeight = currentRuntime.heightByMessageId.get(String(messageId));
    return typeof currentHeight !== 'number' || Math.abs(currentHeight - height) > 0.5;
  });

  if (changedMeasurements.length === 0) {
    return currentRuntime;
  }

  const runtime = cloneRuntime(currentRuntime);
  changedMeasurements.forEach(({ messageId, height }) => {
    const normalizedId = String(messageId);
    runtime.heightByMessageId.delete(normalizedId);
    runtime.heightByMessageId.set(normalizedId, height);
  });
  pruneMeasuredHeightCache(runtime);
  saveConversationRuntime(runtime);
  return runtime;
};

const saveConversationRuntime = (runtime: ConversationRuntime) => {
  runtimeRegistry.set(runtime.conversationId, cloneRuntime(runtime));

  if (runtimeRegistry.size <= MAX_ACTIVE_CONVERSATIONS) {
    return;
  }

  const evictable = Array.from(runtimeRegistry.values())
    .filter((entry) => entry.conversationId !== runtime.conversationId)
    .sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
  const evictCount = runtimeRegistry.size - MAX_ACTIVE_CONVERSATIONS;

  evictable.slice(0, evictCount).forEach((entry) => {
    runtimeRegistry.delete(entry.conversationId);
  });
};

const getSavedConversationRuntime = (conversationId: string): ConversationRuntime | null => {
  const runtime = runtimeRegistry.get(conversationId);
  return runtime ? cloneRuntime(runtime) : null;
};

const resetRuntime = (
  conversationId: string,
  messages: Message[],
  options?: {
    hasOlder?: boolean;
    hasNewer?: boolean;
    topSpacerHeight?: number;
    bottomSpacerHeight?: number;
  },
) => {
  const runtime = createEmptyRuntime(conversationId);
  const renderedIds = toSortedUniqueIds(runtime, messages);

  runtime.renderedIds = renderedIds;
  runtime.pages = renderedIds.length > 0 ? [makePage('initial', renderedIds)] : [];
  runtime.oldestCursor = renderedIds[0] || null;
  runtime.newestCursor = renderedIds[renderedIds.length - 1] || null;
  runtime.hasOlder = Boolean(options?.hasOlder);
  runtime.hasNewer = Boolean(options?.hasNewer);
  runtime.topSpacerHeight = options?.topSpacerHeight ?? 0;
  runtime.bottomSpacerHeight = options?.bottomSpacerHeight ?? 0;
  pruneRuntimeCache(runtime);
  saveConversationRuntime(runtime);
  return runtime;
};

const setRenderedMessages = (
  currentRuntime: ConversationRuntime,
  messages: Message[],
) => {
  const runtime = cloneRuntime(currentRuntime);
  const renderedIds = toSortedUniqueIds(runtime, messages);
  runtime.renderedIds = renderedIds;
  runtime.oldestCursor = renderedIds[0] || runtime.oldestCursor;
  runtime.newestCursor = renderedIds[renderedIds.length - 1] || runtime.newestCursor;
  pruneRuntimeCache(runtime);
  saveConversationRuntime(runtime);
  return runtime;
};

const applyRenderedUpdate = (
  currentRuntime: ConversationRuntime,
  updater: (messages: Message[]) => Message[],
) => setRenderedMessages(currentRuntime, updater(getRenderedMessages(currentRuntime)));

const mergeIntoRenderedWindow = (
  currentRuntime: ConversationRuntime,
  incoming: Message[],
  options: {
    trimFrom: 'old' | 'new';
    consumeBottomSpacerHeight?: number;
    hasOlder?: boolean;
    hasNewer?: boolean;
    isAtPresent?: boolean;
    resolveHeight?: (message: Message) => number;
    pageDirection?: PageDirection;
  },
) => {
  const runtime = cloneRuntime(currentRuntime);
  const existingRendered = getRenderedMessages(runtime);
  const byId = new Map(existingRendered.map((message) => [getMessageId(message), message]));

  incoming.forEach((message) => {
    const id = getMessageId(message);
    byId.set(id, {
      ...byId.get(id),
      ...message,
      local_client_id: message.local_client_id ?? byId.get(id)?.local_client_id,
      local_status: message.local_status ?? byId.get(id)?.local_status,
    });
    runtime.messageById.set(id, byId.get(id)!);
  });

  let sortedMessages = sortMessages(Array.from(byId.values()));
  let trimmedOldMessages: Message[] = [];
  let trimmedNewMessages: Message[] = [];

  if (sortedMessages.length > MESSAGE_WINDOW_TRIM_TRIGGER) {
    const trimCount = sortedMessages.length - MESSAGE_WINDOW_TRIM_TARGET;
    if (options.trimFrom === 'old') {
      trimmedOldMessages = sortedMessages.slice(0, trimCount);
      sortedMessages = sortedMessages.slice(trimCount);
    } else {
      trimmedNewMessages = sortedMessages.slice(MESSAGE_WINDOW_TRIM_TARGET);
      sortedMessages = sortedMessages.slice(0, MESSAGE_WINDOW_TRIM_TARGET);
    }
  }

  const incomingIds = toSortedUniqueIds(runtime, incoming);
  if (incomingIds.length > 0) {
    runtime.pages.push(makePage(options.pageDirection ?? 'newer', incomingIds));
  }

  runtime.renderedIds = sortedMessages.map(getMessageId);
  runtime.oldestCursor = runtime.renderedIds[0] || runtime.oldestCursor;
  runtime.newestCursor = runtime.renderedIds[runtime.renderedIds.length - 1] || runtime.newestCursor;
  runtime.bottomSpacerHeight = options.hasNewer === false
    ? 0
    : Math.max(0, runtime.bottomSpacerHeight - (options.consumeBottomSpacerHeight ?? 0));
  evictTrimmedMessages(
    runtime,
    trimmedOldMessages.map(getMessageId),
    trimmedNewMessages.map(getMessageId),
    { resolveHeight: options.resolveHeight },
  );
  runtime.hasOlder = trimmedOldMessages.length > 0 ? true : (options.hasOlder ?? runtime.hasOlder);
  runtime.hasNewer = trimmedNewMessages.length > 0 ? true : (options.hasNewer ?? runtime.hasNewer);

  pruneRuntimeCache(runtime);
  saveConversationRuntime(runtime);
  return {
    runtime,
    trimmedFromOld: trimmedOldMessages.length,
    trimmedFromNew: trimmedNewMessages.length,
    trimmedFromOldMessages: trimmedOldMessages,
    trimmedFromNewMessages: trimmedNewMessages,
  };
};

const queueLiveMessages = (
  currentRuntime: ConversationRuntime,
  incoming: Message[],
  options?: {
    hasNewer?: boolean;
    isAtPresent?: boolean;
  },
) => {
  const runtime = cloneRuntime(currentRuntime);
  const incomingIds = toSortedUniqueIds(runtime, incoming);
  runtime.pendingLiveIds = removeDuplicateIds([...runtime.pendingLiveIds, ...incomingIds]);
  runtime.hasNewer = options?.hasNewer ?? true;
  pruneRuntimeCache(runtime);
  saveConversationRuntime(runtime);
  return runtime;
};

const recordRuntimePage = (
  currentRuntime: ConversationRuntime,
  messages: Message[],
  direction: PageDirection,
) => {
  const runtime = cloneRuntime(currentRuntime);
  const pageIds = toSortedUniqueIds(runtime, messages);
  if (pageIds.length > 0) {
    runtime.pages.push(makePage(direction, pageIds));
  }
  pruneRuntimeCache(runtime);
  saveConversationRuntime(runtime);
  return runtime;
};

const applyPrependedPage = (
  currentRuntime: ConversationRuntime,
  messages: Message[],
  pageMessages: Message[],
  options: {
    topSpacerHeightConsume?: number;
    bottomSpacerHeightDelta?: number;
    trimmedFromNewMessages?: Message[];
    resolveHeight?: (message: Message) => number;
    hasNewer?: boolean;
  },
) => {
  const runtime = setRenderedMessages(currentRuntime, messages);
  const pageIds = toSortedUniqueIds(runtime, pageMessages);
  if (pageIds.length > 0) {
    runtime.pages.push(makePage('older', pageIds));
  }
  runtime.topSpacerHeight = Math.max(0, runtime.topSpacerHeight - (options.topSpacerHeightConsume ?? 0));
  if (options.trimmedFromNewMessages && options.trimmedFromNewMessages.length > 0) {
    evictTrimmedMessages(
      runtime,
      [],
      options.trimmedFromNewMessages.map(getMessageId),
      { resolveHeight: options.resolveHeight },
    );
  } else {
    runtime.bottomSpacerHeight += options.bottomSpacerHeightDelta ?? 0;
  }
  runtime.hasNewer = options.hasNewer ?? runtime.hasNewer;
  pruneRuntimeCache(runtime);
  saveConversationRuntime(runtime);
  return runtime;
};

const applyAppendedPage = (
  currentRuntime: ConversationRuntime,
  messages: Message[],
  pageMessages: Message[],
  options: {
    bottomSpacerHeightConsume?: number;
    clearBottomSpacer?: boolean;
    trimmedFromOldMessages?: Message[];
    resolveHeight?: (message: Message) => number;
    hasOlder?: boolean;
    hasNewer?: boolean;
  },
) => {
  const runtime = setRenderedMessages(currentRuntime, messages);
  const pageIds = toSortedUniqueIds(runtime, pageMessages);
  if (pageIds.length > 0) {
    runtime.pages.push(makePage('newer', pageIds));
  }

  runtime.bottomSpacerHeight = options.clearBottomSpacer
    ? 0
    : Math.max(0, runtime.bottomSpacerHeight - (options.bottomSpacerHeightConsume ?? 0));

  if (options.trimmedFromOldMessages && options.trimmedFromOldMessages.length > 0) {
    evictTrimmedMessages(
      runtime,
      options.trimmedFromOldMessages.map(getMessageId),
      [],
      { resolveHeight: options.resolveHeight },
    );
  }

  runtime.hasOlder = options.hasOlder ?? runtime.hasOlder;
  runtime.hasNewer = options.hasNewer ?? runtime.hasNewer;
  pruneRuntimeCache(runtime);
  saveConversationRuntime(runtime);
  return runtime;
};

export {
  applyAppendedPage,
  applyPrependedPage,
  applyRenderedUpdate,
  createEmptyRuntime,
  evictTrimmedMessages,
  getRenderedMessages,
  getRuntimeStats,
  getSavedConversationRuntime,
  mergeIntoRenderedWindow,
  queueLiveMessages,
  recordMeasuredMessageHeights,
  recordRuntimePage,
  resetRuntime,
  saveConversationRuntime,
  setRenderedMessages,
  sumMessageHeights,
};

export type { ConversationRuntime, PageCache, RuntimeStats };
