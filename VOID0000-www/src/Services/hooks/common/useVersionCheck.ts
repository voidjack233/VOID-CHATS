import { useEffect, useRef } from 'react';
import { debugLog } from '../../utils/debugLog';

const VERSION_ENDPOINT = '/version.json';
const CHECK_COOLDOWN_MS = 5 * 60 * 1000;
const RELOAD_DEDUP_WINDOW_MS = 60 * 1000;
const RELOAD_VERSION_KEY = 'void_last_version_reload_target';
const RELOAD_TIME_KEY = 'void_last_version_reload_at';
const EXPECTED_SERVICE_WORKER_PATHS = new Set(['/push-sw.js']);

interface BuildVersionPayload {
  version?: string;
  builtAt?: string;
}

async function unregisterUnexpectedServiceWorkers(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    if (registrations.length === 0) return;
    const unexpectedRegistrations = registrations.filter((registration) => {
      const workers = [
        registration.active,
        registration.waiting,
        registration.installing,
      ].filter(Boolean);

      return !workers.some((worker) => {
        try {
          return EXPECTED_SERVICE_WORKER_PATHS.has(new URL(worker!.scriptURL).pathname);
        } catch {
          return false;
        }
      });
    });

    if (unexpectedRegistrations.length === 0) return;

    console.warn('[APP_VERSION] unregistering unexpected service workers', {
      count: unexpectedRegistrations.length,
      scopes: unexpectedRegistrations.map((registration) => registration.scope),
    });

    await Promise.all(unexpectedRegistrations.map((registration) => registration.unregister()));
  } catch (error) {
    console.warn('[APP_VERSION] failed to inspect service worker registrations', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function shouldSkipReload(serverVersion: string): boolean {
  try {
    const lastReloadTarget = sessionStorage.getItem(RELOAD_VERSION_KEY);
    const lastReloadAt = Number(sessionStorage.getItem(RELOAD_TIME_KEY) || '0');

    return (
      lastReloadTarget === serverVersion &&
      Date.now() - lastReloadAt < RELOAD_DEDUP_WINDOW_MS
    );
  } catch {
    return false;
  }
}

function markReload(serverVersion: string): void {
  try {
    sessionStorage.setItem(RELOAD_VERSION_KEY, serverVersion);
    sessionStorage.setItem(RELOAD_TIME_KEY, String(Date.now()));
  } catch {
    // Non-critical.
  }
}

export const useVersionCheck = () => {
  const isCheckingRef = useRef(false);
  const lastCheckRef = useRef(0);
  const isReloadingRef = useRef(false);

  useEffect(() => {
    const win = window as Window & {
      __VOID_BUILD_VERSION__?: string;
    };

    win.__VOID_BUILD_VERSION__ = __BUILD_VERSION__;
    debugLog('[APP_VERSION] running build', {
      version: __BUILD_VERSION__,
    });
  }, []);

  useEffect(() => {
    void unregisterUnexpectedServiceWorkers();

    if (import.meta.env.DEV) {
      return;
    }

    const checkVersion = async (reason: 'mount' | 'visible' | 'interval') => {
      if (isCheckingRef.current || isReloadingRef.current) return;

      const now = Date.now();
      if (reason !== 'mount' && now - lastCheckRef.current < CHECK_COOLDOWN_MS) {
        return;
      }
      lastCheckRef.current = now;
      isCheckingRef.current = true;

      try {
        const response = await fetch(`${VERSION_ENDPOINT}?ts=${Date.now()}`, {
          cache: 'no-store',
        });

        if (!response.ok) {
          console.warn('[APP_VERSION] version check request failed', {
            status: response.status,
            reason,
          });
          return;
        }

        const payload = (await response.json()) as BuildVersionPayload;
        const serverVersion = typeof payload.version === 'string' ? payload.version : null;

        if (!serverVersion) {
          console.warn('[APP_VERSION] version payload missing build version', {
            reason,
            payload,
          });
          return;
        }

        if (serverVersion === __BUILD_VERSION__) {
          return;
        }

        if (shouldSkipReload(serverVersion)) {
          console.warn('[APP_VERSION] stale build detected again; skipping duplicate reload', {
            current_version: __BUILD_VERSION__,
            server_version: serverVersion,
            reason,
          });
          return;
        }

        isReloadingRef.current = true;
        markReload(serverVersion);
        console.warn('[APP_VERSION] stale build detected, reloading application', {
          current_version: __BUILD_VERSION__,
          server_version: serverVersion,
          built_at: payload.builtAt || null,
          reason,
        });
        window.location.reload();
      } catch (error) {
        console.warn('[APP_VERSION] version check failed', {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        isCheckingRef.current = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkVersion('visible');
      }
    };

    void checkVersion('mount');
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void checkVersion('interval');
      }
    }, CHECK_COOLDOWN_MS);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(intervalId);
    };
  }, []);
};
