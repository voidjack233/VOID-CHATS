export const MESSAGE_INITIAL_PAGE_SIZE = 10;
export const MESSAGE_PAGE_SIZE = 20;
export const MESSAGE_CACHE_LIMIT = 500;
export const MESSAGE_ACTIVE_WINDOW_SIZE = 100;
// Larger page for silent background prefetch — fills the local cache ahead of user scroll
export const MESSAGE_PREFETCH_SIZE = 30;

// Viewport-informed initial open constants — used only for the first local-read
// window when opening a conversation, NOT for sync or pagination.
export const MIN_MESSAGE_ROW_HEIGHT_PX = 44;
export const VIEWPORT_FILL_BUFFER = 10;
export const MAX_INITIAL_OPEN_COUNT = 60;
