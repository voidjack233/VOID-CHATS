import { useEffect } from 'react';
import { AlertCircle, RefreshCcw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '../../Services/Auth/UserContext';
import { useCheckAuth } from '../../Services/hooks/Auth/useCheckAuth';
import { useIdleDetector } from '../../Services/hooks/useIdleDetector';
import { debugLog } from '../../Services/utils/debugLog';
import AppBootScreen from '../common/AppBootScreen';

export const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const {
    user,
    loading,
    authUnavailable,
    authRetrying,
    retryAuth,
  } = useUser();
  const navigate = useNavigate();

  // Re-check auth when tab becomes visible (phone unlock, tab switch)
  useCheckAuth();
  useIdleDetector();

  // Redirect to auth if not authenticated and not loading
  useEffect(() => {
    if (!loading && !user) {
      navigate('/auth', { replace: true });
    }
  }, [loading, user, navigate]);

  useEffect(() => {
    const handleOnline = () => {
      debugLog('🌐 Network back');
      void retryAuth();
    };

    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, [retryAuth]);

  if (loading) {
    return <AppBootScreen />;
  }

  if (!user) {
    return null;
  }

  return (
    <>
      {authUnavailable ? (
        <div className="fixed inset-x-0 top-3 z-[100] flex justify-center px-4">
          <div className="flex max-w-xl items-center gap-3 rounded-xl border border-orange-400/30 bg-gray-950/95 px-4 py-3 text-sm text-orange-100 shadow-xl backdrop-blur">
            <AlertCircle className="h-4 w-4 shrink-0 text-orange-300" />
            <span className="flex-1">
              Account service is unavailable. Your login is preserved and will be retried.
            </span>
            <button
              type="button"
              onClick={() => void retryAuth()}
              disabled={authRetrying}
              className="inline-flex items-center gap-1.5 rounded-lg bg-orange-400/15 px-2.5 py-1.5 font-semibold text-orange-100 transition-colors hover:bg-orange-400/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCcw className={`h-3.5 w-3.5 ${authRetrying ? 'animate-spin' : ''}`} />
              Retry
            </button>
          </div>
        </div>
      ) : null}
      {children}
    </>
  );
};

export default ProtectedRoute;
