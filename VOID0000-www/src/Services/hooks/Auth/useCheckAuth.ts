import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { authService } from '../../Auth/authServiceApi';
import { gateway } from '../../Gateway/gateway';

/**
 * Re-check authentication when the browser tab becomes visible.
 * Catches expired sessions after phone lock, tab switch, etc.
 * Also triggers gateway reconnect if WS is disconnected.
 * Does NOT logout on network errors (server down).
 */
export const useCheckAuth = () => {
  const navigate = useNavigate();

  const isCheckingRef = useRef(false);
  const isMountedRef = useRef(false);
  const lastCheckRef = useRef(0);
  const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

  useEffect(() => {
    isMountedRef.current = true;

    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;

      const now = Date.now();
      if (now - lastCheckRef.current < COOLDOWN_MS) return;
      lastCheckRef.current = now;

      // Reconnect gateway if disconnected (user came back to tab)
      gateway.resetReconnect();

      if (isCheckingRef.current) return;
      isCheckingRef.current = true;

      try {
        const { authenticated, networkError } = await authService.verifyAuthWithRefresh();

        if (!isMountedRef.current) return;

        if (networkError) return;

        if (!authenticated) {
          navigate('/auth', { replace: true });
        }
      } catch (error) {
        console.error('Auth check failed:', error);
      } finally {
        isCheckingRef.current = false;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMountedRef.current = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [navigate]);
};