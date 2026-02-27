import { Routes, Route } from 'react-router-dom';
import { ErrorBoundary } from './components/Auth/ErrorBoundary';
import ProtectedRoute from './components/Auth/ProtectedRoute';
import { UserProvider } from './Services/Auth/UserContext';
import { FriendProvider } from './Services/hooks/Friends/useFriendRequests';

// Import all pages
import Auth from './pages/Auth';
import ResetPassword from './pages/Auth/ResetPassword';
import Home from './pages/Home';
import { PresenceProvider } from './Services/hooks/Friends/usePresence';
import { FriendsProvider } from './Services/hooks/Friends';

// Route configuration
const ROUTE_CONFIG = {
  public: [
    { path: '/auth', component: Auth },
    { path: '/reset-password', component: ResetPassword },
  ],
  protected: [
    { path: '/', component: Home },
    { path: '/home', component: Home },
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
        </Routes>
        </PresenceProvider>
        </FriendProvider>
       </FriendsProvider> 
      </UserProvider>
    </ErrorBoundary>
  );
}