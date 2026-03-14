// src/Services/Auth/UserContext.tsx
import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { authService, fetchWithAuth } from './authServiceApi';
import { gateway } from '../Gateway/gateway';
import { keyManager } from '../Crypto/keyManager';
import { signalService } from '../Crypto/libsignal/signalService';
import {
  uploadPublicKey,
  backupKeyToServer,
  backupRecoveryKeyToServer,
  fetchKeyBackup,
  type KeyBackupRecord,
} from '../Chat/chatService';

export interface User {
  id: string;
  email: string;
  username: string;
  profile_id?: string;
  [key: string]: any;
}

export type KeyStatus = 'SECURE' | 'LOCKED' | 'UNINITIALIZED';

interface UserContextType {
  user: User | null;
  loading: boolean;
  keyStatus: KeyStatus;
  keyStatusLoading: boolean;
  isLoggingOut: boolean;
  setUser: (user: User | null) => void;
  refreshUser: () => Promise<void>;
  refreshKeyStatus: () => Promise<KeyStatus>;
  logout: () => Promise<void>;
  setLoginPassword: (password: string) => void;
  saveRecoveryPhrase: (recoveryPhrase: string) => Promise<void>;
  unlockWithRecoveryPhrase: (recoveryPhrase: string) => Promise<void>;
}

const UserContext = createContext<UserContextType | null>(null);
const USER_STORAGE_KEY = 'void_user';

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => {
    const stored = localStorage.getItem(USER_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  });
  const [loading, setLoading] = useState(!localStorage.getItem(USER_STORAGE_KEY));
  const [keyStatus, setKeyStatus] = useState<KeyStatus>('UNINITIALIZED');
  const [keyStatusLoading, setKeyStatusLoading] = useState(false);
  const [keyInitResolved, setKeyInitResolved] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const loginPasswordRef = useRef<string | null>(null);

  const setLoginPassword = (password: string) => {
    loginPasswordRef.current = password;
  };

  const resolveKeyStatusFromBackup = (backup: KeyBackupRecord | null): KeyStatus => {
    const hasRecoveryBackup = Boolean(
      backup?.recovery_encrypted_private_key &&
      backup.recovery_iv &&
      backup.recovery_salt
    );

    return hasRecoveryBackup ? 'SECURE' : 'UNINITIALIZED';
  };

  const createKeyCallbacks = () => ({
    uploadPublicKey: async (pubKey: string, keyId: string) => uploadPublicKey(pubKey, keyId),
    backupToServer: async (data: { encrypted_private_key: string; iv: string; salt: string; key_id: string }) => {
      await backupKeyToServer(data);
    },
    fetchBackup: async () => fetchKeyBackup(),
  });

  const setUser = (newUser: User | null) => {
    const previousUser = user;
    setUserState(newUser);
    if (newUser) {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(newUser));
      if (!previousUser || previousUser.id !== newUser.id) {
        // Dispatch global login event so other providers (like ThemeProvider) can reset/re-fetch.
        window.dispatchEvent(new Event('user-login'));
      }
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

  const refreshKeyStatus = async (): Promise<KeyStatus> => {
    if (!user?.id) {
      setKeyStatus('UNINITIALIZED');
      return 'UNINITIALIZED';
    }

    try {
      const backup = await fetchKeyBackup();
      const nextStatus = resolveKeyStatusFromBackup(backup);
      setKeyStatus(nextStatus);
      return nextStatus;
    } catch (err) {
      console.error('Failed to refresh key status:', err);
      return keyStatus;
    }
  };

  const logout = async () => {
    setIsLoggingOut(true);
    gateway.disconnect();
    loginPasswordRef.current = null;
    setKeyStatus('UNINITIALIZED');
    setKeyStatusLoading(false);
    try {
      await authService.logout();
    } finally {
      setUser(null);
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('void_')) localStorage.removeItem(key);
      });
      setIsLoggingOut(false);
    }
  };

  const saveRecoveryPhrase = async (recoveryPhrase: string) => {
    if (!user?.id) {
      throw new Error('AUTH_REQUIRED');
    }

    const recoveryBackup = await keyManager.prepareRecoveryBackup(user.id, recoveryPhrase);
    await backupRecoveryKeyToServer(recoveryBackup);

    if (loginPasswordRef.current) {
      await backupKeyToServer(await keyManager.prepareBackup(user.id, loginPasswordRef.current));
    }

    setKeyStatus('SECURE');
  };

  const unlockWithRecoveryPhrase = async (recoveryPhrase: string) => {
    if (!user?.id) {
      throw new Error('AUTH_REQUIRED');
    }

    const callbacks = createKeyCallbacks();
    setKeyStatusLoading(true);

    try {
      await keyManager.restoreFromRecoveryPhrase(
        user.id,
        recoveryPhrase,
        loginPasswordRef.current,
        callbacks
      );
      setKeyStatus('SECURE');
      window.location.reload();
    } catch (err) {
      setKeyStatusLoading(false);
      throw err;
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
      setKeyStatus('UNINITIALIZED');
      setKeyStatusLoading(false);
      setKeyInitResolved(false);
      return;
    }

    if (!keyInitResolved || keyStatusLoading) {
      return;
    }

    if (keyStatus === 'LOCKED') {
      gateway.disconnect();
      return;
    }
    gateway.connect(user.id);
    return () => { gateway.disconnect(); };
  }, [keyInitResolved, keyStatus, keyStatusLoading, user?.id]);

  // Initialize encryption keys
  useEffect(() => {
    if (!user?.id) {
      setKeyInitResolved(false);
      return;
    }

    const userId = user.id;
    const password = loginPasswordRef.current;
    const callbacks = createKeyCallbacks();
    let cancelled = false;

    setKeyInitResolved(false);
    setKeyStatusLoading(true);

    keyManager.initializeKeys(userId, password, callbacks)
      .then(async () => {
        if (cancelled) return;
        console.log('🔑 Encryption keys ready');
        try {
          const backup = await callbacks.fetchBackup();
          if (!cancelled) {
            setKeyStatus(resolveKeyStatusFromBackup(backup));
          }
        } catch (err) {
          console.error('Failed to inspect key backup status:', err);
          if (!cancelled) {
            setKeyStatus('UNINITIALIZED');
          }
        } finally {
          if (!cancelled) {
            setKeyStatusLoading(false);
            setKeyInitResolved(true);
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.message === 'KEY_NEEDS_PASSWORD' || err.message === 'KEY_RESTORE_FAILED') {
          console.warn('🔑 Keys are locked on this device');
          setKeyStatus('LOCKED');
        } else {
          console.warn('🔑 Key init failed:', err.message);
          setKeyStatus('UNINITIALIZED');
        }
        setKeyStatusLoading(false);
        setKeyInitResolved(true);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Bootstrap Signal device registration/prekeys as soon as a user session
  // is unlocked, so peers can start prekey messaging without opening a DM first.
  useEffect(() => {
    if (!user?.id) return;
    if (!keyInitResolved || keyStatusLoading || keyStatus === 'LOCKED') return;

    void signalService.bootstrapAccount(user.id);
  }, [keyInitResolved, keyStatus, keyStatusLoading, user?.id]);

  return (
    <UserContext.Provider value={{
      user,
      loading,
      keyStatus,
      keyStatusLoading,
      isLoggingOut,
      setUser,
      refreshUser,
      refreshKeyStatus,
      logout,
      setLoginPassword,
      saveRecoveryPhrase,
      unlockWithRecoveryPhrase,
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
