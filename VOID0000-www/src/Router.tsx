import { lazy, Suspense, useEffect } from 'react';
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

const ROUTE_CONFIG = {
  public: [
    { path: '/auth', component: Auth },
    { path: '/reset-password', component: ResetPassword },
  ],
  protected: [
    { path: '/chats', component: Chat },
  ]
};

// Simplified ThemeWrapper to prevent context nesting issues
function ThemeWrapper({ children }: { children: React.ReactNode }) {
  const theme = useThemeProvider();
  return <ThemeProvider value={theme}>{children}</ThemeProvider>;
}

// A simple loading placeholder
const PageLoader = () => (
  <div className="flex-1 bg-void-bg-main flex items-center justify-center">
    <div className="w-8 h-8 border-2 border-void-accent border-t-transparent rounded-full animate-spin" />
  </div>
);

export default function Router() {
  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  return (
    <ErrorBoundary>
      <ThemeWrapper>
        <UserProvider>
          <FriendsProvider>
            <FriendProvider>
              <PresenceProvider>
                <Suspense fallback={<PageLoader />}>
                  <Routes>
                    {/* Public routes */}
                    {ROUTE_CONFIG.public.map(({ path, component: Component }) => (
                      <Route key={path} path={path} element={<Component />} />
                    ))}

                    {/* Protected routes */}
                    {filteredProtectedRoutes()}

                    {/* Redirects */}
                    <Route path="/" element={<Navigate to="/chats" replace />} />
                    <Route path="/home" element={<Navigate to="/chats" replace />} />
                    <Route path="*" element={<Navigate to="/chats" replace />} />
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

// Helper to keep the JSX clean
function filteredProtectedRoutes() {
  return ROUTE_CONFIG.protected.map(({ path, component: Component }) => (
    <Route
      key={path}
      path={path}
      element={
        <ProtectedRoute>
          <Component />
        </ProtectedRoute>
      }
    />
  ));
}
