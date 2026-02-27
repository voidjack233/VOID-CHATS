import { useSearchParams, useNavigate } from 'react-router-dom';
import { useMemo, useEffect } from 'react';
import { useUser } from '../../Services/Auth/UserContext';
import Login from './Login';
import Register from './Register';
import ForgotPassword from './ForgotPassword';
import EmailVerification from './EmailVerification';
import ResetPassword from './ResetPassword';

type AuthView =
  | 'login'
  | 'register'
  | 'forgot'
  | 'email-verification'
  | 'reset-password';

export default function Auth() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Get the current user status
  const { user, loading } = useUser();

  // The "Kick" Logic: If logged in, go Home immediately
  useEffect(() => {
    if (!loading && user) {
      navigate('/', { replace: true });
    }
  }, [user, loading, navigate]);

  const viewParam = searchParams.get('view') as AuthView | null;

  const currentView: AuthView = useMemo(() => {
    if (viewParam) return viewParam;
    return 'login';
  }, [viewParam]);

  const renderCurrentView = () => {
    switch (currentView) {
      case 'login':
        return <Login />;
      case 'register':
        return <Register />;
      case 'forgot':
        return <ForgotPassword />;
      case 'email-verification':
        return <EmailVerification />;
      case 'reset-password':
        return <ResetPassword />;
      default:
        return <Login />;
    }
  };

  // Optional: Prevent flash of login screen while checking user status
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  // If we have a user, return null (because useEffect is about to redirect us)
  if (user) return null;

  return (
    <div className="auth-wrapper">
      {renderCurrentView()}
    </div>
  );
}