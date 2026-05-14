const DEBUG_LOGS_ENABLED = /^(1|true|yes)$/i.test(process.env.VOID_DEBUG_LOGS || '');

export function debugLog(...args) {
  if (!DEBUG_LOGS_ENABLED) return;
  console.debug(...args);
}
