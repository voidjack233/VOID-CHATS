// src/Services/Auth/UserContext.tsx
import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { authService, fetchWithAuth } from './authServiceApi';
import { gateway } from '../Gateway/gateway';
import { keyManager } from '../Crypto/keyManager';
import { uploadPublicKey, backupKeyToServer, fetchKeyBackup } from '../Chat/chatService';

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
  setLoginPassword: (password: string) => void;
  needsRestorePassword: boolean;
  submitRestorePassword: (password: string) => Promise<void>;
  restoreError: string | null;
}

const UserContext = createContext<UserContextType | null>(null);
const USER_STORAGE_KEY = 'void_user';

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => {
    const stored = localStorage.getItem(USER_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  });
  const [loading, setLoading] = useState(!localStorage.getItem(USER_STORAGE_KEY));

  const loginPasswordRef = useRef<string | null>(null);

  // Only prompt needed: new device with backup but no password in memory
  const [needsRestorePassword, setNeedsRestorePassword] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const setLoginPassword = (password: string) => {
    loginPasswordRef.current = password;
  };

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
        return { ...authData.user, ...accountData.account };
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
      if (freshUser) setUser(freshUser as User);
    } catch (err) {
      console.error('Failed to refresh user:', err);
    }
  };

  const logout = async () => {
    gateway.disconnect();
    loginPasswordRef.current = null;
    setNeedsRestorePassword(false);
    await authService.logout();
    setUser(null);
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith('void_')) localStorage.removeItem(key);
    });
  };

  // Restore prompt handler
  const submitRestorePassword = async (password: string) => {
    if (!user?.id) return;
    setRestoreError(null);

    try {
      loginPasswordRef.current = password;
      await keyManager.initializeKeys(user.id, password, {
        uploadPublicKey: async (pubKey, keyId) => await uploadPublicKey(pubKey, keyId),
        backupToServer: async (data) => await backupKeyToServer(data),
        fetchBackup: async () => await fetchKeyBackup(),
      });

      console.log('🔑 Keys restored successfully');
      setNeedsRestorePassword(false);
      window.location.reload();
    } catch (err: any) {
      if (err.message === 'KEY_RESTORE_FAILED') {
        setRestoreError('Wrong password. Please enter your login password.');
      } else {
        setRestoreError('Restore failed. Please try again.');
      }
    }
  };

  // Initial user fetch
  useEffect(() => {
    const init = async () => {
      const stored = localStorage.getItem(USER_STORAGE_KEY);
      if (stored) {
        const freshUser = await fetchFullUser();
        if (freshUser && freshUser.username) {
          setUser(freshUser as User);
        } else {
          setUser(null);
          Object.keys(localStorage).forEach((key) => {
            if (key.startsWith('void_')) localStorage.removeItem(key);
          });
        }
      } else {
        setLoading(true);
        const freshUser = await fetchFullUser();
        if (freshUser && freshUser.username) setUser(freshUser as User);
        setLoading(false);
      }
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
    return () => { gateway.disconnect(); };
  }, [user?.id]);

  // Initialize encryption keys — silent when password available
  useEffect(() => {
    if (!user?.id) return;

    const password = loginPasswordRef.current;

    keyManager.initializeKeys(user.id, password, {
      uploadPublicKey: async (pubKey, keyId) => await uploadPublicKey(pubKey, keyId),
      backupToServer: async (data) => await backupKeyToServer(data),
      fetchBackup: async () => await fetchKeyBackup(),
    })
      .then(() => {
        console.log('🔑 Encryption keys ready');
      })
      .catch((err) => {
  if (err.message === 'KEY_NEEDS_PASSWORD') {
    console.warn('🔑 No keys and no password — forcing re-login');
    logout();
  } else {
    console.warn('🔑 Key init failed:', err.message);
  }
});
  }, [user?.id]);

  return (
    <UserContext.Provider value={{
      user, loading, setUser, refreshUser, logout, setLoginPassword,
      needsRestorePassword, submitRestorePassword, restoreError,
    }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (!context) throw new Error('useUser must be used within UserProvider');
  return context;
}