import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { gateway } from '../../Gateway/gateway';
import { useUser } from '../../Auth/UserContext';

const AUTH_CHECK_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Re-check authentication when the browser tab becomes visible.
 * Catches expired sessions after phone lock, tab switch, etc.
 * Also triggers gateway reconnect if WS is disconnected.
 * Does NOT logout on network errors (server down).
 */
export const useCheckAuth = () => {
  const navigate = useNavigate();
  const { verifySession } = useUser();

  const isCheckingRef = useRef(false);
  const isMountedRef = useRef(false);
  const lastCheckRef = useRef(0);
  const verifySessionRef = useRef(verifySession);
  verifySessionRef.current = verifySession;

  useEffect(() => {
    isMountedRef.current = true;

    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;

      // Browser background throttling can leave a half-dead WebSocket marked
      // OPEN. Always probe it when the tab wakes, independent of auth checks.
      gateway.resetReconnect();

      const now = Date.now();
      if (now - lastCheckRef.current < AUTH_CHECK_COOLDOWN_MS) return;
      lastCheckRef.current = now;

      if (isCheckingRef.current) return;
      isCheckingRef.current = true;

      try {
        const status = await verifySessionRef.current();

        if (!isMountedRef.current) return;

        if (status === 'invalid') {
          navigate('/auth', { replace: true });
        }
      } catch (error) {
        console.error('Auth check failed:', error);
      } finally {
        isCheckingRef.current = false;
      }
    };

    const handleWindowFocus = () => {
      gateway.resetReconnect();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      isMountedRef.current = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [navigate]);
};
