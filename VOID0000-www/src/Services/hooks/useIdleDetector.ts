import { useEffect, useRef } from 'react';
import { gateway } from '../Gateway/gateway';

const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const OP_STATUS_UPDATE = 4;

export function useIdleDetector() {
  const isIdleRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const setOnline = () => {
      if (isIdleRef.current) {
        isIdleRef.current = false;
        gateway.sendRaw({ op: OP_STATUS_UPDATE, d: { status: 'online' } });
      }
      resetTimer();
    };

    const setIdle = () => {
      if (!isIdleRef.current) {
        isIdleRef.current = true;
        gateway.sendRaw({ op: OP_STATUS_UPDATE, d: { status: 'idle' } });
      }
    };

    const resetTimer = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(setIdle, IDLE_TIMEOUT);
    };

    // Activity events
    const events = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'];
    events.forEach(e => window.addEventListener(e, setOnline, { passive: true }));

    // Visibility change — idle when hidden, online when visible
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setIdle();
      } else {
        setOnline();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // Start the timer
    resetTimer();

    return () => {
      events.forEach(e => window.removeEventListener(e, setOnline));
      document.removeEventListener('visibilitychange', handleVisibility);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
}