// src/Services/Auth/UserContext.tsx
import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { authService, fetchWithAuth } from './authServiceApi';
import { clearAppBootstrap, fetchAppBootstrap } from '../bootstrap';
import { gateway } from '../Gateway/gateway';
import { keyManager } from '../Crypto/keyManager';
import { chatCryptoProtocolService } from '../Crypto/protocols/chatCryptoProtocolService';
import { clearDecryptedAttachmentObjectUrlCache } from '../Crypto/attachmentEncryption';
import { debugLog } from '../utils/debugLog';
import { mlsStorageService } from '../Crypto/mls/mlsStorageService';
import {
  uploadRecoverySecureBackups as uploadRecoverySecureBackupsNow,
  uploadSecureBackups as uploadSecureBackupsNow,
} from './secureBackup';
import {
  uploadPublicKey,
  backupKeyToServer,
  fetchKeyBackup,
  type KeyBackupRecord,
} from '../Chat/chatService';
import {
  createEmptyRestoreSummary,
  hasMlsBackupPayload,
  hasPasswordBackupPayload,
  hasRecoveryBackupPayload,
  hasRecoveryMlsBackupPayload,
  inspectLocalMlsChatState,
  normalizePositiveVersion,
  restoreMlsStateFromBackup,
  type MlsRestoreSummary,
} from './mlsRecovery';
import type {
  KeyStatus,
  MlsRecoveryGateReason,
  MlsRecoveryGateState,
  RecoveryBackupStatus,
  User,
  UserContextType,
} from './userContextTypes';

export type {
  KeyStatus,
  MlsRecoveryGateReason,
  MlsRecoveryGateState,
  RecoveryBackupStatus,
  User,
} from './userContextTypes';

declare global {
  interface Window {
    __voidRescueMlsArchive?: (conversationId?: string) => Promise<number>;
  }
}

const UserContext = createContext<UserContextType | null>(null);
const USER_STORAGE_KEY = 'void_user';
const FOREGROUND_MLS_MAINTENANCE_MIN_GAP_MS = 30_000;

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => {
    const stored = localStorage.getItem(USER_STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  });
  const [loading, setLoading] = useState(!localStorage.getItem(USER_STORAGE_KEY));
  const [keyStatus, setKeyStatus] = useState<KeyStatus>('UNINITIALIZED');
  const [recoveryBackupStatus, setRecoveryBackupStatus] = useState<RecoveryBackupStatus>('UNINITIALIZED');
  const [keyStatusLoading, setKeyStatusLoading] = useState(false);
  const [keyInitResolved, setKeyInitResolved] = useState(false);
  const [mlsRecoveryGate, setMlsRecoveryGate] = useState<MlsRecoveryGateState>({
    active: false,
    reason: null,
  });
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const loginPasswordRef = useRef<string | null>(null);
  const loginPasswordClearTimerRef = useRef<number | null>(null);
  const liveConversationKeyVersionsRef = useRef<Record<string, number>>({});
  const pendingLiveInboxSyncTimerRef = useRef<number | null>(null);
  const lastForegroundMlsMaintenanceAtRef = useRef(0);

  const clearLoginPassword = () => {
    loginPasswordRef.current = null;
    if (loginPasswordClearTimerRef.current != null) {
      window.clearTimeout(loginPasswordClearTimerRef.current);
      loginPasswordClearTimerRef.current = null;
    }
  };

  const clearLoginPasswordIfMatches = (password: string | null | undefined) => {
    if (password && loginPasswordRef.current === password) {
      clearLoginPassword();
    }
  };

  const LOGIN_PASSWORD_LEASE_MS = 30_000;

  const setLoginPassword = (password: string) => {
    if (!password.trim()) {
      clearLoginPassword();
      return;
    }

    loginPasswordRef.current = password;
    if (loginPasswordClearTimerRef.current != null) {
      window.clearTimeout(loginPasswordClearTimerRef.current);
    }

    // Keep the raw password only long enough for the immediate key init /
    // recovery bootstrap pass. Longer-lived maintenance must not depend on it.
    loginPasswordClearTimerRef.current = window.setTimeout(() => {
      clearLoginPassword();
    }, LOGIN_PASSWORD_LEASE_MS);
  };

  const refreshSecureBackupsWithPassword = async (password: string) => {
    if (!user?.id) {
      throw new Error('AUTH_REQUIRED');
    }

    if (!password.trim()) {
      throw new Error('PASSWORD_REQUIRED');
    }

    await uploadSecureBackupsNow(user.id, password);
    setKeyStatus('SECURE');
    setRecoveryBackupStatus('PASSWORD_ONLY');
  };

  const generateRecoveryKey = () => keyManager.generateRecoveryPhrase();

  const continueWithoutLocalSecureHistory = () => {
    console.warn('[MLS_RECOVERY_GATE] user continued without local secure history');
    setKeyStatus('SECURE');
    clearMlsRecoveryGate();
    setKeyInitResolved(true);
  };

  const setupRecoveryKey = async (recoveryKey: string) => {
    if (!user?.id) {
      throw new Error('AUTH_REQUIRED');
    }

    if (!keyManager.validateRecoveryPhrase(recoveryKey)) {
      throw new Error('INVALID_RECOVERY_KEY');
    }

    await uploadRecoverySecureBackupsNow(user.id, recoveryKey);
    await keyManager.storeRecoveryKeyForBackup(user.id, recoveryKey);
    setKeyStatus('SECURE');
    setRecoveryBackupStatus('RECOVERY_KEY_READY');
  };

  const clearMlsRecoveryGate = () => {
    setMlsRecoveryGate({ active: false, reason: null });
  };

  const activateMlsRecoveryGate = (
    reason: MlsRecoveryGateReason,
    metadata: Record<string, unknown>
  ) => {
    console.warn('[MLS_RECOVERY_GATE] activated', {
      reason,
      ...metadata,
    });
    setMlsRecoveryGate({ active: true, reason });
  };

  const resolveKeyStatusFromBackup = (backup: KeyBackupRecord | null): KeyStatus => {
    return hasPasswordBackupPayload(backup) || hasRecoveryBackupPayload(backup) ? 'SECURE' : 'UNINITIALIZED';
  };

  const resolveRecoveryBackupStatusFromBackup = (
    backup: KeyBackupRecord | null
  ): RecoveryBackupStatus => {
    if (hasRecoveryBackupPayload(backup)) {
      return 'RECOVERY_KEY_READY';
    }

    if (hasPasswordBackupPayload(backup)) {
      return 'PASSWORD_ONLY';
    }

    return 'UNINITIALIZED';
  };

  const resolveInitialKeyRecoveryGate = (
    errorMessage: string,
    backup: KeyBackupRecord | null
  ): MlsRecoveryGateReason => {
    const hasRecoveryBackup = hasRecoveryBackupPayload(backup);

    if (errorMessage === 'KEY_RESTORE_FAILED') {
      return hasRecoveryBackup ? 'recovery_key_required' : 'restore_failed';
    }

    return 'local_state_lost';
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

  const fetchFullUser = async (force = false): Promise<User | null> => {
    try {
      if (!force) {
        const bootstrap = await fetchAppBootstrap();
        if (bootstrap?.user?.username) {
          return bootstrap.user;
        }
      }

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
      const freshUser = await fetchFullUser(true);
      if (freshUser) setUser(freshUser as User);
    } catch (err) {
      console.error('Failed to refresh user:', err);
    }
  };

  const refreshKeyStatus = async (): Promise<KeyStatus> => {
    if (!user?.id) {
      setKeyStatus('UNINITIALIZED');
      setRecoveryBackupStatus('UNINITIALIZED');
      return 'UNINITIALIZED';
    }

    try {
      const backup = await fetchKeyBackup();
      const nextStatus = resolveKeyStatusFromBackup(backup);
      const nextRecoveryBackupStatus = resolveRecoveryBackupStatusFromBackup(backup);
      setKeyStatus(nextStatus);
      setRecoveryBackupStatus(nextRecoveryBackupStatus);
      return nextStatus;
    } catch (err) {
      console.error('Failed to refresh key status:', err);
      return keyStatus;
    }
  };

  const logout = async () => {
    setIsLoggingOut(true);
    gateway.disconnect();
    clearDecryptedAttachmentObjectUrlCache();
    clearLoginPassword();
    clearAppBootstrap();
    setKeyStatus('UNINITIALIZED');
    setRecoveryBackupStatus('UNINITIALIZED');
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

  const retryMlsRecoveryWithRecoveryKey = async (recoveryKey: string) => {
    if (!user?.id) {
      throw new Error('AUTH_REQUIRED');
    }

    if (!keyManager.validateRecoveryPhrase(recoveryKey)) {
      throw new Error('INVALID_RECOVERY_KEY');
    }

    setKeyStatusLoading(true);
    clearMlsRecoveryGate();

    try {
      const backup = await fetchKeyBackup();
      if (!backup) {
        throw new Error('RECOVERY_NOT_CONFIGURED');
      }

      await keyManager.restoreFromRecoveryPhrase(user.id, recoveryKey, null, createKeyCallbacks());
      await keyManager.storeRecoveryKeyForBackup(user.id, recoveryKey);
      setKeyStatus(resolveKeyStatusFromBackup(backup));
      setRecoveryBackupStatus(resolveRecoveryBackupStatusFromBackup(backup));

      const restoreSummary = await restoreMlsStateFromBackup(user.id, backup, recoveryKey, 'recovery_key');
      const syncResult = await chatCryptoProtocolService.syncInbox(user.id, true);
      const localChatState = await inspectLocalMlsChatState();
      const hasLocalChatState =
        localChatState.groupStateCount > 0 || localChatState.groupKeyCount > 0;
      const hasRecoverableServerState =
        restoreSummary.hasConversationArtifacts ||
        syncResult.syncedGroupStates > 0 ||
        syncResult.syncedWelcomes > 0 ||
        syncResult.syncedCommits > 0;

      debugLog('[MLS_RECOVERY_GATE] recovery key retry inspection', {
        user_id: user.id,
        restore_outcome: restoreSummary.outcome,
        backup_group_state_count: restoreSummary.backupGroupStateCount,
        backup_group_key_count: restoreSummary.backupGroupKeyCount,
        has_backup_conversation_artifacts: restoreSummary.hasConversationArtifacts,
        synced_group_states: syncResult.syncedGroupStates,
        synced_welcomes: syncResult.syncedWelcomes,
        synced_commits: syncResult.syncedCommits,
        local_group_states: localChatState.groupStateCount,
        local_group_keys: localChatState.groupKeyCount,
      });

      if (restoreSummary.outcome === 'failed') {
        activateMlsRecoveryGate('recovery_key_required', {
          user_id: user.id,
          retry_source: 'inline_recovery_key_prompt',
        });
        throw new Error('INVALID_RECOVERY_KEY');
      }

      if (hasRecoverableServerState && !hasLocalChatState) {
        debugLog('[MLS_RECOVERY_GATE] recovery key accepted; continuing with account-scoped conversation recovery', {
          user_id: user.id,
          retry_source: 'inline_recovery_key_prompt',
          synced_group_states: syncResult.syncedGroupStates,
          synced_welcomes: syncResult.syncedWelcomes,
          synced_commits: syncResult.syncedCommits,
        });
      }
      clearMlsRecoveryGate();
    } finally {
      setKeyStatusLoading(false);
      setKeyInitResolved(true);
    }
  };

  const retryMlsRecoveryWithPassword = async (password: string) => {
    if (!user?.id) {
      throw new Error('AUTH_REQUIRED');
    }

    if (!password.trim()) {
      throw new Error('PASSWORD_REQUIRED');
    }

    setLoginPassword(password);
    setKeyStatusLoading(true);
    clearMlsRecoveryGate();

    try {
      const backup = await fetchKeyBackup();
      if (backup) {
        setKeyStatus(resolveKeyStatusFromBackup(backup));
        setRecoveryBackupStatus(resolveRecoveryBackupStatusFromBackup(backup));
      }

      let restoreSummary = createEmptyRestoreSummary();
      if (backup) {
        restoreSummary = await restoreMlsStateFromBackup(user.id, backup, password);
      }

      const syncResult = await chatCryptoProtocolService.syncInbox(user.id, true);
      const localChatState = await inspectLocalMlsChatState();
      const hasLocalChatState =
        localChatState.groupStateCount > 0 || localChatState.groupKeyCount > 0;
      const hasRecoverableServerState =
        restoreSummary.hasConversationArtifacts ||
        syncResult.syncedGroupStates > 0 ||
        syncResult.syncedWelcomes > 0 ||
        syncResult.syncedCommits > 0;

      debugLog('[MLS_RECOVERY_GATE] password retry inspection', {
        user_id: user.id,
        restore_outcome: restoreSummary.outcome,
        backup_group_state_count: restoreSummary.backupGroupStateCount,
        backup_group_key_count: restoreSummary.backupGroupKeyCount,
        has_backup_conversation_artifacts: restoreSummary.hasConversationArtifacts,
        synced_group_states: syncResult.syncedGroupStates,
        synced_welcomes: syncResult.syncedWelcomes,
        synced_commits: syncResult.syncedCommits,
        local_group_states: localChatState.groupStateCount,
        local_group_keys: localChatState.groupKeyCount,
      });

      if (restoreSummary.outcome === 'failed') {
        clearLoginPasswordIfMatches(password);
        activateMlsRecoveryGate('password_required', {
          user_id: user.id,
          retry_source: 'inline_password_prompt',
        });
        throw new Error('INVALID_ACCOUNT_PASSWORD');
      }

      if (hasRecoverableServerState && !hasLocalChatState) {
        debugLog('[MLS_RECOVERY_GATE] password accepted; continuing with account-scoped conversation recovery', {
          user_id: user.id,
          retry_source: 'inline_password_prompt',
          synced_group_states: syncResult.syncedGroupStates,
          synced_welcomes: syncResult.syncedWelcomes,
          synced_commits: syncResult.syncedCommits,
        });
      }
      clearMlsRecoveryGate();
    } finally {
      setKeyStatusLoading(false);
      setKeyInitResolved(true);
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
      setRecoveryBackupStatus('UNINITIALIZED');
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
        debugLog('🔑 Encryption keys ready');
        try {
          const backup = await callbacks.fetchBackup();
          const hasPasswordMlsBackup = hasMlsBackupPayload(backup);
          const hasRecoveryMlsBackup = hasRecoveryMlsBackupPayload(backup);
          const hasMlsBackup = hasPasswordMlsBackup || hasRecoveryMlsBackup;
          const hasRecoveryBackup = hasRecoveryBackupPayload(backup);
          let restoreSummary: MlsRestoreSummary = createEmptyRestoreSummary();
          if (!cancelled) {
            setKeyStatus(resolveKeyStatusFromBackup(backup));
            setRecoveryBackupStatus(resolveRecoveryBackupStatusFromBackup(backup));
          }

          // Restore MLS state on a new device if the backup contains it.
          if (password && backup) {
            restoreSummary = await restoreMlsStateFromBackup(userId, backup, password);
          }

          const syncResult = await chatCryptoProtocolService.syncInbox(userId, true);
          const localChatState = await inspectLocalMlsChatState();
          const hasLocalChatState =
            localChatState.groupStateCount > 0 || localChatState.groupKeyCount > 0;
          const hasBackupConversationArtifacts = password
            ? restoreSummary.hasConversationArtifacts
            : hasRecoveryMlsBackup;
          const hasRecoverableServerState =
            hasBackupConversationArtifacts ||
            syncResult.syncedGroupStates > 0 ||
            syncResult.syncedWelcomes > 0 ||
            syncResult.syncedCommits > 0;

          debugLog('[MLS_RESTORE] recovery inspection complete', {
            user_id: userId,
            has_password: Boolean(password),
            has_recovery_backup: hasRecoveryBackup,
            has_recovery_mls_backup: hasRecoveryMlsBackup,
            has_mls_backup: hasMlsBackup,
            restore_outcome: restoreSummary.outcome,
            backup_group_state_count: restoreSummary.backupGroupStateCount,
            backup_group_key_count: restoreSummary.backupGroupKeyCount,
            has_backup_conversation_artifacts: restoreSummary.hasConversationArtifacts,
            synced_group_states: syncResult.syncedGroupStates,
            synced_welcomes: syncResult.syncedWelcomes,
            synced_commits: syncResult.syncedCommits,
            local_group_states: localChatState.groupStateCount,
            local_group_keys: localChatState.groupKeyCount,
          });

          const needsRecoveryAttention =
            hasRecoverableServerState && !hasLocalChatState;

          let recoveryAttentionResolvedLocally = false;
          if (
            !cancelled &&
            needsRecoveryAttention &&
            backup &&
            (hasRecoveryMlsBackup || hasRecoveryBackup)
          ) {
            const storedRecoveryKey = await keyManager.getStoredRecoveryKeyForBackup(userId);
            if (storedRecoveryKey) {
              try {
                const recoveryRestoreSummary = await restoreMlsStateFromBackup(
                  userId,
                  backup,
                  storedRecoveryKey,
                  'recovery_key',
                );
                const recoverySyncResult = await chatCryptoProtocolService.syncInbox(userId, true);
                const recoveredLocalChatState = await inspectLocalMlsChatState();
                recoveryAttentionResolvedLocally =
                  recoveredLocalChatState.groupStateCount > 0 ||
                  recoveredLocalChatState.groupKeyCount > 0;

                debugLog('[MLS_RECOVERY_GATE] stored recovery key auto-restore inspection', {
                  user_id: userId,
                  restore_outcome: recoveryRestoreSummary.outcome,
                  backup_group_state_count: recoveryRestoreSummary.backupGroupStateCount,
                  backup_group_key_count: recoveryRestoreSummary.backupGroupKeyCount,
                  has_backup_conversation_artifacts: recoveryRestoreSummary.hasConversationArtifacts,
                  synced_group_states: recoverySyncResult.syncedGroupStates,
                  synced_welcomes: recoverySyncResult.syncedWelcomes,
                  synced_commits: recoverySyncResult.syncedCommits,
                  local_group_states: recoveredLocalChatState.groupStateCount,
                  local_group_keys: recoveredLocalChatState.groupKeyCount,
                });
              } catch (restoreError) {
                console.warn('[MLS_RECOVERY_GATE] stored recovery key auto-restore failed', {
                  user_id: userId,
                  error: restoreError instanceof Error ? restoreError.message : String(restoreError || ''),
                });
              }
            }
          }

          let requiresInteractiveRecovery = false;
          if (!cancelled && needsRecoveryAttention && !recoveryAttentionResolvedLocally) {
            const recoveryMetadata = {
              user_id: userId,
              has_mls_backup: hasMlsBackup,
              has_recovery_backup: hasRecoveryBackup,
              has_recovery_mls_backup: hasRecoveryMlsBackup,
              has_backup_conversation_artifacts: hasBackupConversationArtifacts,
              synced_group_states: syncResult.syncedGroupStates,
              synced_welcomes: syncResult.syncedWelcomes,
              synced_commits: syncResult.syncedCommits,
            };

            if (password && restoreSummary.outcome === 'failed') {
              requiresInteractiveRecovery = true;
              activateMlsRecoveryGate('restore_failed', {
                ...recoveryMetadata,
              });
            } else if (password && (hasRecoveryMlsBackup || hasRecoveryBackup)) {
              requiresInteractiveRecovery = true;
              activateMlsRecoveryGate('recovery_key_required', {
                ...recoveryMetadata,
              });
            } else if (password && hasPasswordMlsBackup) {
              requiresInteractiveRecovery = true;
              activateMlsRecoveryGate('password_required', {
                ...recoveryMetadata,
              });
            } else {
              debugLog('[MLS_RECOVERY_GATE] continuing with account-scoped conversation recovery', {
                ...recoveryMetadata,
                source: password
                  ? 'conversation_state_unavailable_after_login'
                  : 'local_identity_present_without_global_restore',
              });
            }
          }

          if (!cancelled && !requiresInteractiveRecovery) {
            try {
              await chatCryptoProtocolService.bootstrapAccount(userId, true);
              await chatCryptoProtocolService.ensureServerKeyPackageReserve(userId);

              if (password) {
                await uploadSecureBackupsNow(userId, password);
              }

              const recoveryKey = await keyManager.getStoredRecoveryKeyForBackup(userId);
              if (recoveryKey) {
                await uploadRecoverySecureBackupsNow(userId, recoveryKey);
              }

              setKeyStatus('SECURE');
              setRecoveryBackupStatus(
                recoveryKey || hasRecoveryBackup
                  ? 'RECOVERY_KEY_READY'
                  : password || hasPasswordBackupPayload(backup)
                    ? 'PASSWORD_ONLY'
                    : 'UNINITIALIZED',
              );
            } catch {
              // Non-critical — periodic maintenance and explicit recovery
              // flows can still repair the backup state later.
            }
          }
        } catch (err) {
          console.error('Failed to inspect key backup status:', err);
          if (!cancelled) {
            setKeyStatus('UNINITIALIZED');
            setRecoveryBackupStatus('UNINITIALIZED');
          }
        } finally {
          if (!cancelled) {
            setKeyStatusLoading(false);
            setKeyInitResolved(true);
          }
          clearLoginPasswordIfMatches(password);
        }
      })
      .catch(async (err) => {
        if (cancelled) return;
        if (err.message === 'KEY_NEEDS_PASSWORD' || err.message === 'KEY_RESTORE_FAILED') {
          clearLoginPasswordIfMatches(password);
          const backup = await callbacks.fetchBackup().catch(() => null);
          const hasRecoveryBackup = hasRecoveryBackupPayload(backup);
          const gateReason = resolveInitialKeyRecoveryGate(err.message, backup);
          console.warn('🔑 Keys are unavailable in this browser session');
          setKeyStatus('LOCKED');
          setRecoveryBackupStatus(resolveRecoveryBackupStatusFromBackup(backup));
          activateMlsRecoveryGate(gateReason, {
            user_id: userId,
            source: 'key_init',
            has_password_backup: hasPasswordBackupPayload(backup),
            has_recovery_backup: hasRecoveryBackup,
          });
        } else {
          console.warn('🔑 Key init failed:', err.message);
          setKeyStatus('UNINITIALIZED');
          setRecoveryBackupStatus('UNINITIALIZED');
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
    let cancelled = false;

    liveConversationKeyVersionsRef.current = {};

    const runBootstrapMaintenance = (force = false) => {
      if (cancelled) return;
      void chatCryptoProtocolService.bootstrapAccount(userId, force).catch(() => {});
    };

    const clearPendingLiveInboxSync = () => {
      if (pendingLiveInboxSyncTimerRef.current != null) {
        window.clearTimeout(pendingLiveInboxSyncTimerRef.current);
        pendingLiveInboxSyncTimerRef.current = null;
      }
    };

    const scheduleLiveInboxSync = (
      reason: 'conversation_key_bump',
      metadata: Record<string, unknown>,
    ) => {
      if (cancelled) return;

      clearPendingLiveInboxSync();
      pendingLiveInboxSyncTimerRef.current = window.setTimeout(() => {
        pendingLiveInboxSyncTimerRef.current = null;
        if (cancelled) return;

        debugLog('[MLS_LIVE_SYNC] syncing inbox after live conversation update', {
          user_id: userId,
          reason,
          ...metadata,
        });

        void chatCryptoProtocolService.syncInbox(userId, true).catch((error) => {
          console.warn('[MLS_LIVE_SYNC] forced inbox sync failed', {
            user_id: userId,
            reason,
            ...metadata,
            error: error instanceof Error ? error.message : String(error || ''),
          });
        });
      }, 150);
    };

    // Top-up the server key-package reserve.  The single-flight mutex inside
    // ensureServerKeyPackageReserve prevents concurrent duplicate jobs when
    // multiple triggers (READY, RESUMED, focus, online) fire close together.
    const runKeyPackageTopUp = () => {
      if (cancelled) return;
      void chatCryptoProtocolService.ensureServerKeyPackageReserve(userId).catch(() => {});
    };

    const runForegroundMaintenance = () => {
      if (cancelled) return;

      const now = Date.now();
      if (now - lastForegroundMlsMaintenanceAtRef.current < FOREGROUND_MLS_MAINTENANCE_MIN_GAP_MS) {
        return;
      }

      lastForegroundMlsMaintenanceAtRef.current = now;
      runBootstrapMaintenance(false);
    };

    // Periodic maintenance fallback — run bootstrap + top-up every 60s.
    const maintenanceInterval = window.setInterval(() => {
      runBootstrapMaintenance(true);
      runKeyPackageTopUp();
    }, 60_000);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runForegroundMaintenance();
      }
    };

    const onFocus = () => {
      runForegroundMaintenance();
    };

    const onOnline = () => {
      runBootstrapMaintenance(true);
      runKeyPackageTopUp();
    };

    const onKeyPackageChanged = () => {
      runBootstrapMaintenance(true);
    };

    // WebSocket READY (fresh identify) / RESUMED (session resume): top-up
    // the server reserve so same-account multiple devices stay DM-reachable.
    const onGatewayReady = () => {
      runBootstrapMaintenance(true);
      runKeyPackageTopUp();
    };
    const onGatewayResumed = () => {
      runKeyPackageTopUp();
    };

    // Server notifies that key-package count dropped below low watermark
    // after another user claimed packages.  Immediately replenish.
    const onKeyPackageLow = () => {
      runKeyPackageTopUp();
    };

    const onConversationUpdate = (data: any) => {
      const updatedConversation = data?.conversation;
      const conversationId =
        typeof updatedConversation?.id === 'string' && updatedConversation.id.length > 0
          ? updatedConversation.id
          : null;

      if (!conversationId) {
        return;
      }

      const nextKeyVersion = normalizePositiveVersion(updatedConversation?.current_key_version);
      if (nextKeyVersion <= 0) {
        return;
      }

      const previousKeyVersion = liveConversationKeyVersionsRef.current[conversationId] ?? 0;
      liveConversationKeyVersionsRef.current[conversationId] = Math.max(
        previousKeyVersion,
        nextKeyVersion,
      );

      const shouldSync =
        previousKeyVersion === 0 || nextKeyVersion > previousKeyVersion;

      if (!shouldSync) {
        return;
      }

      scheduleLiveInboxSync('conversation_key_bump', {
        conversation_id: conversationId,
        conversation_public_id:
          typeof updatedConversation?.public_id === 'string'
            ? updatedConversation.public_id
            : null,
        conversation_type:
          typeof updatedConversation?.type === 'string' ? updatedConversation.type : null,
        previous_key_version: previousKeyVersion > 0 ? previousKeyVersion : null,
        next_key_version: nextKeyVersion,
      });
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('void:mls-key-package-changed', onKeyPackageChanged);
    gateway.on('READY', onGatewayReady);
    gateway.on('RESUMED', onGatewayResumed);
    gateway.on('KEY_PACKAGE_LOW', onKeyPackageLow);
    gateway.on('CONVERSATION_UPDATE', onConversationUpdate);

    return () => {
      cancelled = true;
      clearPendingLiveInboxSync();
      window.clearInterval(maintenanceInterval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('void:mls-key-package-changed', onKeyPackageChanged);
      gateway.off('READY', onGatewayReady);
      gateway.off('RESUMED', onGatewayResumed);
      gateway.off('KEY_PACKAGE_LOW', onKeyPackageLow);
      gateway.off('CONVERSATION_UPDATE', onConversationUpdate);
    };
  }, [keyInitResolved, keyStatus, keyStatusLoading, mlsRecoveryGate.active, user?.id]);

  useEffect(() => {
    if (!user?.id) {
      delete window.__voidRescueMlsArchive;
      return;
    }

    const userId = user.id;
    const rescueArchive = async (conversationId?: string) => {
      const archived = await mlsStorageService.syncArchivedGroupKeys(userId, {
        conversationId: conversationId || null,
        replaceExisting: true,
      });
      debugLog('[MLS_ARCHIVE_RESCUE] force-refreshed local group key archive', {
        user_id: userId,
        conversation_id: conversationId || null,
        archived,
      });
      return archived;
    };

    window.__voidRescueMlsArchive = rescueArchive;
    return () => {
      if (window.__voidRescueMlsArchive === rescueArchive) {
        delete window.__voidRescueMlsArchive;
      }
    };
  }, [user?.id]);

  return (
    <UserContext.Provider value={{
      user,
      loading,
      keyStatus,
      recoveryBackupStatus,
      keyStatusLoading,
      mlsRecoveryGate,
      isLoggingOut,
      setUser,
      refreshUser,
      refreshKeyStatus,
      logout,
      setLoginPassword,
      refreshSecureBackupsWithPassword,
      generateRecoveryKey,
      continueWithoutLocalSecureHistory,
      setupRecoveryKey,
      retryMlsRecoveryWithRecoveryKey,
      retryMlsRecoveryWithPassword,
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
