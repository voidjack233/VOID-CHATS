import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { authService } from '../../Services/Auth/authServiceApi';
import { useUser } from '../../Services/Auth/UserContext';
import { useCheckAuth } from '../../Services/hooks/Auth/useCheckAuth';
import { useIdleDetector } from '../../Services/hooks/useIdleDetector';

export const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const [allowed, setAllowed] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [serverDown, setServerDown] = useState(false);
  const navigate = useNavigate();
  const { setUser } = useUser();
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-check auth when tab becomes visible (phone unlock, tab switch)
  useCheckAuth();
  useIdleDetector();

  const checkAuth = useCallback(async () => {
    try {
      const { authenticated, networkError } = await authService.verifyAuthWithRefresh();

      if (authenticated) {
        setAllowed(true);
        setServerDown(false);
        setIsChecking(false);
        return;
      }

      if (networkError) {
        // Server is unreachable — don't logout, show waiting state and retry
        console.log('🔌 Server unreachable, retrying in 5s...');
        setServerDown(true);
        setIsChecking(false);

        retryTimerRef.current = setTimeout(() => {
          checkAuth();
        }, 5000);
        return;
      }

      // Auth genuinely failed (401, expired tokens) — logout
      setUser(null);
      setAllowed(false);
      navigate('/auth', { replace: true });
    } catch {
      setUser(null);
      navigate('/auth', { replace: true });
    } finally {
      setIsChecking(false);
    }
  }, [navigate, setUser]);

  // Initial auth check
  useEffect(() => {
    checkAuth();

    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, [checkAuth]);

  // WS AUTH_FAILED is NOT a reason to logout.
  // WebSocket can fail for many reasons (mobile background, bad signal, server restart).
  // The refresh token cookie is the source of truth — not the WebSocket.
  // Auth is only checked via HTTP (on mount, on visibility change).

  // When server comes back online, retry auth
  useEffect(() => {
    if (!serverDown) return;

    const handleOnline = () => {
      console.log('🌐 Network back, retrying auth...');
      setServerDown(false);
      setIsChecking(true);
      checkAuth();
    };

    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, [serverDown, checkAuth]);

  if (isChecking) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        Checking session...
      </div>
    );
  }

  if (serverDown) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-400">Reconnecting to server...</p>
        <p className="text-gray-600 text-sm">Your session is safe. Retrying automatically.</p>
      </div>
    );
  }

  if (!allowed) {
    return null;
  }

  return <>{children}</>;
};

export default ProtectedRoute;