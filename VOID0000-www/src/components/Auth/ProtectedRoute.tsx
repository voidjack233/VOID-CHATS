import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUser } from '../../Services/Auth/UserContext';
import { useCheckAuth } from '../../Services/hooks/Auth/useCheckAuth';
import { useIdleDetector } from '../../Services/hooks/useIdleDetector';

export const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useUser();
  const [serverDown, setServerDown] = useState(false);
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

  // When server comes back online, retry
  useEffect(() => {
    if (!serverDown) return;

    const handleOnline = () => {
      console.log('🌐 Network back');
      setServerDown(false);
    };

    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, [serverDown]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        Checking session...
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return <>{children}</>;
};

export default ProtectedRoute;