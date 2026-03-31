import { useEffect, useRef, useState } from 'react';
import { gateway } from '../../Gateway/gateway';

type GatewayState = 'connected' | 'reconnecting' | 'disconnected';

interface ConnectionStatus {
  isOnline: boolean;
  gatewayState: GatewayState;
  /**
   * True when a reconnect/offline condition has been active long enough to
   * surface to the user. Fires immediately when offline. Fires after
   * STALL_THRESHOLD_MS of continuous reconnecting — whether or not this is
   * a first-load or a mid-session drop — so API-down refreshes also get the
   * right UX instead of an indefinite loading screen.
   */
  showReconnectBanner: boolean;
}

/** How long the gateway must stay in 'reconnecting' before we surface the banner. */
const STALL_THRESHOLD_MS = 8000;

export function useConnectionStatus(): ConnectionStatus {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [gatewayState, setGatewayState] = useState<GatewayState>(
    () => gateway.getConnectionState()
  );
  const [isStalled, setIsStalled] = useState(false);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const handleStateChange = ({ state }: { state: GatewayState }) => {
      setGatewayState(state);
    };
    gateway.on('CONNECTION_STATE', handleStateChange);
    return () => gateway.off('CONNECTION_STATE', handleStateChange);
  }, []);

  // Start a stall timer whenever the gateway enters reconnecting. Clear it and
  // reset isStalled the moment a connection is established or gateway is
  // intentionally disconnected (logged out).
  useEffect(() => {
    if (gatewayState === 'reconnecting') {
      if (!stallTimerRef.current) {
        stallTimerRef.current = setTimeout(() => {
          setIsStalled(true);
        }, STALL_THRESHOLD_MS);
      }
    } else {
      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
      setIsStalled(false);
    }
    return () => {
      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
    };
  }, [gatewayState]);

  const showReconnectBanner =
    !isOnline ||
    (gatewayState === 'reconnecting' && (gateway.getHasEverConnected() || isStalled));

  return { isOnline, gatewayState, showReconnectBanner };
}
