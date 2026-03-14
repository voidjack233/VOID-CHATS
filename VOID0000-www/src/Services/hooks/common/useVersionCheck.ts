import { useEffect, useRef } from 'react';

/**
 * Detects stale client bundles and forces a reload.
 *
 * How it works:
 * - Sends HEAD request to /index.html on visibility change
 * - Stores the ETag/Last-Modified from first load as baseline
 * - If it changes → new deploy happened → hard reload
 *
 * No API endpoint needed. Works because Vite generates unique
 * script filenames every build, so index.html always changes.
 */
export const useVersionCheck = () => {
  const knownETag = useRef<string | null>(null);
  const isCheckingRef = useRef(false);
  const lastCheckRef = useRef(0);
  const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

  const checkVersion = async () => {
    if (isCheckingRef.current) return;

    const now = Date.now();
    if (now - lastCheckRef.current < COOLDOWN_MS) return;
    lastCheckRef.current = now;

    isCheckingRef.current = true;

    try {
      // HEAD request — no body, just headers
      const res = await fetch('/?_v=' + Date.now(), {
        method: 'HEAD',
        cache: 'no-store',
      });

      if (!res.ok) return;

      // Use ETag or Last-Modified as version fingerprint
      const fingerprint =
        res.headers.get('etag') ||
        res.headers.get('last-modified') ||
        null;

      if (!fingerprint) return;

      if (knownETag.current === null) {
        // First check — store baseline
        knownETag.current = fingerprint;
      } else if (fingerprint !== knownETag.current) {
        console.log('🔄 New build detected, reloading...');
        window.location.reload();
      }
    } catch {
      // Network error — don't reload
    } finally {
      isCheckingRef.current = false;
    }
  };

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        checkVersion();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    // Store baseline on mount
    checkVersion();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);
};
