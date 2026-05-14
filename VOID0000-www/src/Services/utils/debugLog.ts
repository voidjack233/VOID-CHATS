function isDebugLogsEnabled(): boolean {
  if (import.meta.env.VITE_DEBUG_LOGS === 'true') return true;

  return (
    typeof window !== 'undefined' &&
    window.localStorage.getItem('void:debug-logs') === '1'
  );
}

export const debugLog: (...args: unknown[]) => void = import.meta.env.PROD
  ? () => {}
  : (...args: unknown[]) => {
      if (!isDebugLogsEnabled()) return;
      console.debug(...args);
    };
