import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ErrorBoundary } from './components/Auth/ErrorBoundary';
import ProtectedRoute from './components/Auth/ProtectedRoute';
import { UserProvider } from './Services/Auth/UserContext';
import { FriendProvider } from './Services/hooks/Friends/useFriendRequests';
import { PresenceProvider } from './Services/hooks/Friends/usePresence';
import { FriendsProvider } from './Services/hooks/Friends';
import { ThemeProvider, useThemeProvider } from './Services/hooks/Settings/useTheme';

// Lazy-loaded pages
const Auth = lazy(() => import('./pages/Auth'));
const ResetPassword = lazy(() => import('./pages/Auth/ResetPassword'));
const Chat = lazy(() => import('./pages/chats'));

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

function ThemeWrapper({ children }: { children: React.ReactNode }) {
  const theme = useThemeProvider();
  return <ThemeProvider value={theme}>{children}</ThemeProvider>;
}

export default function Router() {
  return (
    <ErrorBoundary>
      <ThemeWrapper>
      <UserProvider>
        <FriendsProvider>
         <FriendProvider>
          <PresenceProvider>
        <Suspense fallback={null}>
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
        </Suspense>
        </PresenceProvider>
        </FriendProvider>
       </FriendsProvider> 
      </UserProvider>
      </ThemeWrapper>
    </ErrorBoundary>
  );
}