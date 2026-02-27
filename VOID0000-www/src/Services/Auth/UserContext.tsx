import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { authService, fetchWithAuth } from './authServiceApi';
import { gateway } from '../Gateway/gateway';

export interface User {
  id: string;
  email: string;
  username: string;
  profile_id?: string;
  [key: string]: any;
}

interface UserContextType {
  user: User | null;
  loading: boolean;
  setUser: (user: User | null) => void;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
}

const UserContext = createContext<UserContextType | null>(null);
const USER_STORAGE_KEY = 'void_user';

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => {
    const stored = localStorage.getItem(USER_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  });
  const [loading, setLoading] = useState(!localStorage.getItem(USER_STORAGE_KEY));

  const setUser = (newUser: User | null) => {
    setUserState(newUser);
    if (newUser) {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(newUser));
    } else {
      localStorage.removeItem(USER_STORAGE_KEY);
    }
  };

  const fetchFullUser = async (): Promise<User | null> => {
    try {
      const authResponse = await fetchWithAuth('/api/me');
      if (!authResponse.ok) return null;
      const authData = await authResponse.json();
      if (!authData.success) return null;

      const accountResponse = await fetchWithAuth('/api/users/account');
      if (!accountResponse.ok) return null;
      const accountData = await accountResponse.json();

      if (accountData.success && accountData.account) {
        return {
          ...authData.user,
          ...accountData.account,
        };
      }
      return authData.user;
    } catch (err) {
      console.error('Failed to fetch user:', err);
      return null;
    }
  };

  const refreshUser = async () => {
    try {
      const freshUser = await fetchFullUser();
      if (freshUser) {
        setUser(freshUser as User);
      }
    } catch (err) {
      console.error('Failed to refresh user:', err);
    }
  };

  const logout = async () => {
    gateway.disconnect();
    await authService.logout();
    setUser(null);
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith('void_')) {
        localStorage.removeItem(key);
      }
    });
  };

  // Initial user fetch
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      const freshUser = await fetchFullUser();

      if (freshUser && freshUser.username) {
        setUser(freshUser as User);
      } else {
        setUser(null);
        Object.keys(localStorage).forEach((key) => {
          if (key.startsWith('void_')) {
            localStorage.removeItem(key);
          }
        });
      }
      setLoading(false);
    };
    init();
  }, []);

  // Gateway connection
  useEffect(() => {
    if (!user?.id) {
      gateway.disconnect();
      return;
    }
    gateway.connect(user.id);
    return () => {
      gateway.disconnect();
    };
  }, [user?.id]);

  return (
    <UserContext.Provider value={{ user, loading, setUser, refreshUser, logout }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error('useUser must be used within UserProvider');
  }
  return context;
}