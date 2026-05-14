import { debugLog } from '../../../utils/debugLog';

const MESSAGE_LIST_DEBUG_KEY = 'void:chat-debug';
const MAX_DEBUG_BUFFER_ENTRIES = 50;

const ALLOWED_DEBUG_EVENTS = new Set([
  'older_fetch_start',
  'older_fetch_success',
  'prepend_apply',
  'prepend_derived_rows',
  'prepend_batch_rows',
  'prepend_rendered_rows_above_anchor',
  'prepended_row_height_change',
  'older_fetch_boundary',
  'older_server_prefetch_state',
  'final_boundary_scroller_before',
  'final_boundary_scroller_after',
  'first_item_index_change',
  'start_reached',
  'prepend_commit_before',
  'prepend_commit_metrics',
  'explicit_scroll_action',
  'visible_anchor_before',
  'visible_anchor_after',
]);

const CAPTURED_DEBUG_EVENTS = new Set([
  '[chat-debug-raw] start_reached',
  '[chat-debug-raw] prepend_commit_before',
  '[chat-debug-raw] prepend_commit_metrics',
  '[chat-debug-raw] older_fetch_boundary',
  '[chat-debug-raw] older_server_prefetch_state',
  '[chat-debug-raw] final_boundary_scroller_before',
  '[chat-debug-raw] final_boundary_scroller_after',
  'visible_anchor_before',
  'visible_anchor_after',
]);

type DebugEntry = { event: string; payload?: unknown; ts: string };

declare global {
  interface Window {
    __VOID_CHAT_DEBUG__?: DebugEntry[];
    __chatDebugBuffer?: DebugEntry[];
    copyChatDebugReport?: () => Promise<string>;
    copyFinalBoundaryDebugReport?: () => Promise<string>;
    clearChatDebugReport?: () => void;
  }
}

function getNowIso() {
  return new Date().toISOString();
}

function pushDebugEntry(list: DebugEntry[] | undefined, entry: DebugEntry, maxSize: number) {
  return [...(list || []), entry].slice(-maxSize);
}

function debugReplacer(_key: string, value: unknown) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (value instanceof Set) {
    return Array.from(value);
  }

  if (value instanceof Map) {
    return Object.fromEntries(value);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof HTMLElement !== 'undefined' && value instanceof HTMLElement) {
    return {
      tagName: value.tagName,
      id: value.id || null,
      className: value.className || null,
      dataset: { ...value.dataset },
    };
  }

  return value;
}

function snapshotPayload(payload?: unknown) {
  if (typeof payload === 'undefined') {
    return undefined;
  }

  try {
    return JSON.parse(JSON.stringify(payload, debugReplacer));
  } catch (error) {
    return {
      __snapshotError: error instanceof Error ? error.message : String(error),
      __rawType: Object.prototype.toString.call(payload),
      __stringValue: String(payload),
    };
  }
}

function formatDebugReport(entries: DebugEntry[]) {
  if (entries.length === 0) {
    return '[]';
  }

  return entries.map((entry, index) => {
    const header = `#${index + 1} ${entry.ts} ${entry.event}`;
    const body = JSON.stringify(entry.payload ?? null, null, 2);
    return `${header}\n${body}`;
  }).join('\n\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFinalBoundaryPayload(payload: unknown) {
  if (!isRecord(payload)) {
    return false;
  }

  const requestedOlderCount = typeof payload.requestedOlderCount === 'number'
    ? payload.requestedOlderCount
    : null;
  const returnedOlderCount = typeof payload.returnedOlderCount === 'number'
    ? payload.returnedOlderCount
    : null;
  const localProbeHasMore = typeof payload.localProbeHasMore === 'boolean'
    ? payload.localProbeHasMore
    : null;
  const localHasMore = typeof payload.localHasMore === 'boolean'
    ? payload.localHasMore
    : null;
  const serverHasMore = typeof payload.serverHasMore === 'boolean'
    ? payload.serverHasMore
    : null;

  return (
    (requestedOlderCount != null && returnedOlderCount != null && returnedOlderCount < requestedOlderCount) ||
    localProbeHasMore === false ||
    localHasMore === false ||
    serverHasMore === false
  );
}

function extractFinalBoundaryEntries(entries: DebugEntry[]) {
  const relevantEvents = new Set([
    '[chat-debug-raw] older_fetch_boundary',
    '[chat-debug-raw] older_server_prefetch_state',
    '[chat-debug-raw] prepend_commit_before',
    '[chat-debug-raw] prepend_commit_metrics',
    '[chat-debug-raw] final_boundary_scroller_before',
    '[chat-debug-raw] final_boundary_scroller_after',
    'visible_anchor_before',
    'visible_anchor_after',
  ]);

  const boundaryIndex = (() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.event === '[chat-debug-raw] older_fetch_boundary' && isFinalBoundaryPayload(entry.payload)) {
        return index;
      }
    }
    return -1;
  })();

  if (boundaryIndex < 0) {
    return [];
  }

  let startIndex = boundaryIndex;
  for (let index = boundaryIndex; index >= 0; index -= 1) {
    if (
      entries[index]?.event === '[chat-debug-raw] prepend_commit_before' ||
      entries[index]?.event === 'visible_anchor_before'
    ) {
      startIndex = index;
      break;
    }
  }

  let endIndex = boundaryIndex;
  let sawVisibleAnchorAfter = false;
  for (let index = boundaryIndex; index < entries.length; index += 1) {
    const event = entries[index]?.event;
    if (!sawVisibleAnchorAfter && event === 'visible_anchor_after') {
      endIndex = index;
      sawVisibleAnchorAfter = true;
      continue;
    }
    if (sawVisibleAnchorAfter && event === '[chat-debug-raw] final_boundary_scroller_after') {
      endIndex = index;
      break;
    }
  }

  return entries.slice(startIndex, endIndex + 1).filter((entry) => relevantEvents.has(entry.event));
}

async function copyTextToClipboard(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    return;
  }

  throw new Error('Clipboard is not available in this environment.');
}

function ensureChatDebugHelpers() {
  if (typeof window === 'undefined') {
    return;
  }

  window.__chatDebugBuffer = window.__chatDebugBuffer || [];

  if (!window.copyChatDebugReport) {
    window.copyChatDebugReport = async () => {
      const report = formatDebugReport(window.__chatDebugBuffer || []);
      await copyTextToClipboard(report);
      debugLog('[chat-debug] copied report', {
        entries: (window.__chatDebugBuffer || []).length,
      });
      return report;
    };
  }

  if (!window.copyFinalBoundaryDebugReport) {
    window.copyFinalBoundaryDebugReport = async () => {
      const report = formatDebugReport(extractFinalBoundaryEntries(window.__chatDebugBuffer || []));
      await copyTextToClipboard(report);
      debugLog('[chat-debug] copied final boundary report', {
        entries: extractFinalBoundaryEntries(window.__chatDebugBuffer || []).length,
      });
      return report;
    };
  }

  if (!window.clearChatDebugReport) {
    window.clearChatDebugReport = () => {
      window.__chatDebugBuffer = [];
      debugLog('[chat-debug] cleared report');
    };
  }
}

function captureDebugEvent(event: string, payload?: unknown) {
  if (typeof window === 'undefined') {
    return;
  }

  ensureChatDebugHelpers();

  if (!CAPTURED_DEBUG_EVENTS.has(event)) {
    return;
  }

  const entry = {
    event,
    payload: snapshotPayload(payload),
    ts: getNowIso(),
  };

  window.__chatDebugBuffer = pushDebugEntry(window.__chatDebugBuffer, entry, MAX_DEBUG_BUFFER_ENTRIES);
}

export function isMessageListDebugEnabled() {
  return (
    typeof window !== 'undefined' &&
    window.localStorage.getItem(MESSAGE_LIST_DEBUG_KEY) === '1'
  );
}

export function debugMessageList(event: string, payload?: unknown) {
  if (!isMessageListDebugEnabled()) {
    return;
  }

  if (!ALLOWED_DEBUG_EVENTS.has(event)) {
    return;
  }

  const entry = {
    event,
    payload: snapshotPayload(payload),
    ts: getNowIso(),
  };

  if (typeof window !== 'undefined') {
    ensureChatDebugHelpers();
    window.__VOID_CHAT_DEBUG__ = pushDebugEntry(window.__VOID_CHAT_DEBUG__, entry, 200);
  }

  captureDebugEvent(event, payload);
  debugLog(`[chat-debug] ${event}`, payload);
}

export function rawDebugMessageList(event: string, payload?: unknown) {
  if (!isMessageListDebugEnabled()) {
    return;
  }

  const label = `[chat-debug-raw] ${event}`;
  captureDebugEvent(label, payload);
  debugLog(label, payload);
}

export { ensureChatDebugHelpers };
