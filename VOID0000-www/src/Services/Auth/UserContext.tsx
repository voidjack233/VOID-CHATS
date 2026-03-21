// src/Services/Auth/UserContext.tsx
import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { authService, fetchWithAuth } from './authServiceApi';
import { gateway } from '../Gateway/gateway';
import { keyManager } from '../Crypto/keyManager';
import { chatCryptoProtocolService } from '../Crypto/protocols/chatCryptoProtocolService';
import { upsertMlsGroupStates } from '../Crypto/mls/mlsApi';
import { mlsStore } from '../Crypto/mls/mlsStore';
import type { MlsBackupData } from '../Crypto/mls/mlsTypes';
import {
  uploadPublicKey,
  backupKeyToServer,
  backupRecoveryKeyToServer,
  fetchKeyBackup,
  type KeyBackupRecord,
} from '../Chat/chatService';

type MlsRestoreOutcome = 'skipped' | 'already_local' | 'restored' | 'failed';
type MlsRecoveryGateReason = 'password_required' | 'restore_failed' | 'sync_import_missing';

interface MlsRecoveryGateState {
  active: boolean;
  pending: boolean;
  reason: MlsRecoveryGateReason | null;
}

function hasMlsBackupPayload(backup: KeyBackupRecord | null): boolean {
  return Boolean(
    backup?.mls_state_encrypted &&
    backup.mls_state_iv &&
    backup.mls_state_salt
  );
}

async function inspectLocalMlsChatState(): Promise<{
  groupStateCount: number;
  groupKeyCount: number;
}> {
  const [groups, groupKeys] = await Promise.all([
    mlsStore.listGroupStates(),
    keyManager.exportGroupKeys(),
  ]);

  return {
    groupStateCount: groups.length,
    groupKeyCount: groupKeys.length,
  };
}

async function buildMlsBackupFields(
  userId: string,
  password: string
): Promise<{ mls_state_encrypted: string; mls_state_iv: string; mls_state_salt: string } | null> {
  try {
    const mlsData = await mlsStore.exportForBackup(userId);
    const groupKeys = await keyManager.exportGroupKeys();
    const payload: MlsBackupData = { ...mlsData, groupKeys };
    const { encrypted, iv, salt } = await keyManager.encryptDataWithPassword(payload, password);
    return { mls_state_encrypted: encrypted, mls_state_iv: iv, mls_state_salt: salt };
  } catch (err) {
    console.warn('🔑 MLS state export failed (non-critical):', err);
    return null;
  }
}

async function restoreMlsStateFromBackup(
  userId: string,
  backup: KeyBackupRecord,
  password: string
): Promise<MlsRestoreOutcome> {
  if (!hasMlsBackupPayload(backup)) {
    return 'skipped';
  }

  try {
    const existingAccount = await mlsStore.getAccountState(userId);
    const existingGroups = await mlsStore.listGroupStates();
    if (existingAccount && existingGroups.length > 0) {
      console.log('[MLS_RESTORE] local MLS state already present', {
        user_id: userId,
        existing_group_states: existingGroups.length,
      });
      return 'already_local';
    }

    const payload = await keyManager.decryptDataWithPassword(
      backup.mls_state_encrypted!,
      backup.mls_state_iv!,
      backup.mls_state_salt!,
      password
    ) as MlsBackupData;

    await mlsStore.importFromBackup(payload);
    if (payload.groupKeys?.length) {
      await keyManager.importGroupKeys(payload.groupKeys);
    }

    if (payload.groups.length > 0) {
      try {
        console.log('[MLS_GROUP_STATE] uploading restored backup group states', {
          user_id: userId,
          group_state_count: payload.groups.length,
        });
        const uploaded = await upsertMlsGroupStates(
          payload.groups.map((group) => ({
            conversationId: group.conversationId,
            groupId: group.groupId,
            epoch: group.epoch,
            keyVersion: group.keyVersion ?? null,
            stateBlob: group.stateBlob,
          }))
        );
        console.log('[MLS_GROUP_STATE] uploaded restored backup group states', {
          user_id: userId,
          group_state_count: payload.groups.length,
          uploaded_items: uploaded,
        });
      } catch (err) {
        console.warn('[MLS_GROUP_STATE] backup group state upload failed', {
          user_id: userId,
          group_state_count: payload.groups.length,
          error: err instanceof Error ? err.message : String(err || ''),
        });
      }
    }

    console.log('[MLS_RESTORE] restored MLS state from backup', {
      user_id: userId,
      group_state_count: payload.groups.length,
      group_key_count: payload.groupKeys?.length || 0,
      key_package_count: payload.keyPackages.length,
    });
    return 'restored';
  } catch (err) {
    console.warn('[MLS_RESTORE] restore failed', {
      user_id: userId,
      error: err instanceof Error ? err.message : String(err || ''),
    });
    return 'failed';
  }
}

let backupTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleGroupKeyBackup(userId: string, password: string): void {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    backupTimer = null;
    try {
      const keyBackup = await keyManager.prepareBackup(userId, password);
      const mlsFields = await buildMlsBackupFields(userId, password);
      await backupKeyToServer({ ...keyBackup, ...mlsFields });
    } catch {
      // Non-critical — backup will retry on next key change
    }
  }, 5000);
}

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
  mlsRecoveryGate: MlsRecoveryGateState;
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
  const [mlsRecoveryGate, setMlsRecoveryGate] = useState<MlsRecoveryGateState>({
    active: false,
    pending: false,
    reason: null,
  });
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const loginPasswordRef = useRef<string | null>(null);

  const setLoginPassword = (password: string) => {
    loginPasswordRef.current = password;
  };

  const clearMlsRecoveryGate = () => {
    setMlsRecoveryGate({ active: false, pending: false, reason: null });
  };

  const activateMlsRecoveryGate = (
    reason: MlsRecoveryGateReason,
    metadata: Record<string, unknown>
  ) => {
    console.warn('[MLS_RECOVERY_GATE] activated', {
      reason,
      ...metadata,
    });
    setMlsRecoveryGate({ active: true, pending: false, reason });
  };

  const markMlsRecoveryPending = (
    reason: Extract<MlsRecoveryGateReason, 'sync_import_missing'>,
    metadata: Record<string, unknown>
  ) => {
    console.log('[MLS_RECOVERY_GATE] pending', {
      reason,
      ...metadata,
    });
    setMlsRecoveryGate({ active: false, pending: true, reason });
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
    clearMlsRecoveryGate();
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
      clearMlsRecoveryGate();
      return;
    }

    if (!keyInitResolved || keyStatusLoading) {
      return;
    }

    if (keyStatus === 'LOCKED' || mlsRecoveryGate.active) {
      gateway.disconnect();
      return;
    }
    gateway.connect(user.id);
    return () => { gateway.disconnect(); };
  }, [keyInitResolved, keyStatus, keyStatusLoading, mlsRecoveryGate.active, user?.id]);

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
    clearMlsRecoveryGate();

    keyManager.initializeKeys(userId, password, callbacks)
      .then(async () => {
        if (cancelled) return;
        console.log('🔑 Encryption keys ready');
        try {
          const backup = await callbacks.fetchBackup();
          const hasMlsBackup = hasMlsBackupPayload(backup);
          let restoreOutcome: MlsRestoreOutcome = 'skipped';
          if (!cancelled) {
            setKeyStatus(resolveKeyStatusFromBackup(backup));
          }

          // Restore MLS state on a new device if the backup contains it.
          if (password && backup) {
            restoreOutcome = await restoreMlsStateFromBackup(userId, backup, password);
          }

          const syncResult = await chatCryptoProtocolService.syncInbox(userId, true);
          const localChatState = await inspectLocalMlsChatState();
          const hasLocalChatState =
            localChatState.groupStateCount > 0 || localChatState.groupKeyCount > 0;
          const hasRecoverableServerState =
            hasMlsBackup ||
            syncResult.syncedGroupStates > 0 ||
            syncResult.syncedWelcomes > 0 ||
            syncResult.syncedCommits > 0;

          console.log('[MLS_RESTORE] recovery inspection complete', {
            user_id: userId,
            has_password: Boolean(password),
            has_mls_backup: hasMlsBackup,
            restore_outcome: restoreOutcome,
            synced_group_states: syncResult.syncedGroupStates,
            synced_welcomes: syncResult.syncedWelcomes,
            synced_commits: syncResult.syncedCommits,
            local_group_states: localChatState.groupStateCount,
            local_group_keys: localChatState.groupKeyCount,
          });

          if (!cancelled && hasRecoverableServerState && !hasLocalChatState) {
            if (!password && hasMlsBackup) {
              activateMlsRecoveryGate('password_required', {
                user_id: userId,
                has_mls_backup: hasMlsBackup,
                synced_group_states: syncResult.syncedGroupStates,
                synced_welcomes: syncResult.syncedWelcomes,
                synced_commits: syncResult.syncedCommits,
              });
            } else if (restoreOutcome === 'failed') {
              activateMlsRecoveryGate('restore_failed', {
                user_id: userId,
                has_mls_backup: hasMlsBackup,
                synced_group_states: syncResult.syncedGroupStates,
                synced_welcomes: syncResult.syncedWelcomes,
                synced_commits: syncResult.syncedCommits,
              });
            } else {
              markMlsRecoveryPending('sync_import_missing', {
                user_id: userId,
                has_mls_backup: hasMlsBackup,
                synced_group_states: syncResult.syncedGroupStates,
                synced_welcomes: syncResult.syncedWelcomes,
                synced_commits: syncResult.syncedCommits,
              });
            }
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

  // Bootstrap MLS account state, then refresh the backup so a new device
  // gets an up-to-date MLS state blob on its next login.
  useEffect(() => {
    if (!user?.id) return;
    if (!keyInitResolved || keyStatusLoading || keyStatus === 'LOCKED' || mlsRecoveryGate.active) return;

    const userId = user.id;
    const password = loginPasswordRef.current;
    let cancelled = false;

    const runBootstrapMaintenance = (force = false) => {
      if (cancelled) return;
      void chatCryptoProtocolService.bootstrapAccount(userId, force).catch(() => {});
    };

    void chatCryptoProtocolService.bootstrapAccount(userId, true).then(async () => {
      if (!password || cancelled) return;
      try {
        const keyBackup = await keyManager.prepareBackup(userId, password);
        const mlsFields = await buildMlsBackupFields(userId, password);
        await backupKeyToServer({ ...keyBackup, ...mlsFields });
      } catch {
        // Non-critical — event-driven backup will catch future changes
      }
    }).catch(() => {});

    const maintenanceInterval = window.setInterval(() => {
      runBootstrapMaintenance(true);
    }, 60_000);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runBootstrapMaintenance(true);
      }
    };

    const onFocus = () => {
      runBootstrapMaintenance(true);
    };

    const onOnline = () => {
      runBootstrapMaintenance(true);
    };

    const onKeyPackageChanged = () => {
      runBootstrapMaintenance(true);
    };

    // Incrementally back up group keys whenever they change during the session.
    const onKeyChanged = () => {
      if (loginPasswordRef.current && user?.id) {
        scheduleGroupKeyBackup(user.id, loginPasswordRef.current);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('void:mls-key-package-changed', onKeyPackageChanged);
    window.addEventListener('void:group-key-changed', onKeyChanged);

    return () => {
      cancelled = true;
      window.clearInterval(maintenanceInterval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('void:mls-key-package-changed', onKeyPackageChanged);
      window.removeEventListener('void:group-key-changed', onKeyChanged);
    };
  }, [keyInitResolved, keyStatus, keyStatusLoading, mlsRecoveryGate.active, user?.id]);

  useEffect(() => {
    if (!user?.id || !mlsRecoveryGate.pending) return;
    if (keyStatusLoading || keyStatus === 'LOCKED') return;

    let cancelled = false;
    let retryTimer: number | null = null;

    const clearRetryTimer = () => {
      if (retryTimer != null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const inspectRecoveryState = async (source: 'retry_loop' | 'group_key_changed') => {
      try {
        const syncResult = await chatCryptoProtocolService.syncInbox(user.id, true);
        const localChatState = await inspectLocalMlsChatState();
        const hasLocalChatState =
          localChatState.groupStateCount > 0 || localChatState.groupKeyCount > 0;

        console.log('[MLS_RECOVERY_GATE] pending recheck', {
          user_id: user.id,
          source,
          synced_group_states: syncResult.syncedGroupStates,
          synced_welcomes: syncResult.syncedWelcomes,
          synced_commits: syncResult.syncedCommits,
          local_group_states: localChatState.groupStateCount,
          local_group_keys: localChatState.groupKeyCount,
        });

        if (!cancelled && hasLocalChatState) {
          clearMlsRecoveryGate();
          return;
        }
      } catch (err) {
        console.warn('[MLS_RECOVERY_GATE] pending recheck failed', {
          user_id: user.id,
          source,
          error: err instanceof Error ? err.message : String(err || ''),
        });
      }

      if (!cancelled && source === 'retry_loop') {
        clearRetryTimer();
        retryTimer = window.setTimeout(() => {
          void inspectRecoveryState('retry_loop');
        }, 2500);
      }
    };

    const onGroupKeyChanged = () => {
      void inspectRecoveryState('group_key_changed');
    };

    retryTimer = window.setTimeout(() => {
      void inspectRecoveryState('retry_loop');
    }, 1500);
    window.addEventListener('void:group-key-changed', onGroupKeyChanged);

    return () => {
      cancelled = true;
      clearRetryTimer();
      window.removeEventListener('void:group-key-changed', onGroupKeyChanged);
    };
  }, [keyStatus, keyStatusLoading, mlsRecoveryGate.pending, user?.id]);

  return (
    <UserContext.Provider value={{
      user,
      loading,
      keyStatus,
      keyStatusLoading,
      mlsRecoveryGate,
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
