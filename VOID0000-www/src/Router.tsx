import { Routes, Route, Navigate } from 'react-router-dom';
import { ErrorBoundary } from './components/Auth/ErrorBoundary';
import ProtectedRoute from './components/Auth/ProtectedRoute';
import { UserProvider } from './Services/Auth/UserContext';
import { FriendProvider } from './Services/hooks/Friends/useFriendRequests';
import { PresenceProvider } from './Services/hooks/Friends/usePresence';
import { FriendsProvider } from './Services/hooks/Friends';

// Import pages
import Auth from './pages/Auth';
import ResetPassword from './pages/Auth/ResetPassword';
import Chat from './pages/chats';

// Route configuration
const ROUTE_CONFIG = {
  public: [
    { path: '/auth', component: Auth },
    { path: '/reset-password', component: ResetPassword },
  ],
  protected: [
    { path: '/chats', component: Chat },
  ]
};

export default function Router() {
  return (
    <ErrorBoundary>
      <UserProvider>
        <FriendsProvider>
         <FriendProvider>
          <PresenceProvider>
        <Routes>
          {/* Public routes */}
          {ROUTE_CONFIG.public.map(({ path, component: Component }) => (
            <Route key={path} path={path} element={<Component />} />
          ))}
          
          {/* Protected routes */}
          {ROUTE_CONFIG.protected.map(({ path, component: Component }) => (
            <Route 
              key={path} 
              path={path} 
              element={
                <ProtectedRoute>
                  <Component />
                </ProtectedRoute>
              } 
            />
          ))}

          {/* Redirects */}
          <Route path="/" element={<Navigate to="/chats" replace />} />
          <Route path="/home" element={<Navigate to="/chats" replace />} />
        </Routes>
        </PresenceProvider>
        </FriendProvider>
       </FriendsProvider> 
      </UserProvider>
    </ErrorBoundary>
  );
}