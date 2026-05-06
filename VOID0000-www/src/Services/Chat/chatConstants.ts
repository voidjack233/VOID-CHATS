export const INITIAL_PAGE_SIZE = 20;
export const SCROLL_PAGE_SIZE = 25;
export const MAX_RENDERED_MESSAGES = 120;
export const TRIM_TO_MESSAGES = 100;
export const MAX_RUNTIME_MESSAGES_PER_CONVERSATION = 300;

export const MESSAGE_INITIAL_PAGE_SIZE = INITIAL_PAGE_SIZE;
export const MESSAGE_PAGE_SIZE = SCROLL_PAGE_SIZE;
export const MESSAGE_CACHE_LIMIT = MAX_RUNTIME_MESSAGES_PER_CONVERSATION;
export const MESSAGE_ACTIVE_WINDOW_SIZE = TRIM_TO_MESSAGES;
export const MAX_CACHED_MESSAGES_PER_CONVERSATION = MAX_RUNTIME_MESSAGES_PER_CONVERSATION;
export const MAX_ACTIVE_CONVERSATIONS = 8;
export const FALLBACK_MESSAGE_HEIGHT = 72;
export const MESSAGE_WINDOW_TRIM_TRIGGER = MAX_RENDERED_MESSAGES;
export const MESSAGE_WINDOW_TRIM_TARGET = TRIM_TO_MESSAGES;
// Larger page for silent background prefetch — fills the local cache ahead of user scroll
export const MESSAGE_PREFETCH_SIZE = SCROLL_PAGE_SIZE;

// Viewport-informed initial open constants — used only for the first local-read
// window when opening a conversation, NOT for sync or pagination.
export const MIN_MESSAGE_ROW_HEIGHT_PX = 44;
export const VIEWPORT_FILL_BUFFER = 10;
export const MAX_INITIAL_OPEN_COUNT = 60;
