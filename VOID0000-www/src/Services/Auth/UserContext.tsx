// src/Services/Auth/UserContext.tsx
import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { authService, fetchWithAuth } from './authServiceApi';
import { gateway } from '../Gateway/gateway';
import { keyManager } from '../Crypto/keyManager';
import { chatCryptoProtocolService } from '../Crypto/protocols/chatCryptoProtocolService';
import { clearDecryptedAttachmentObjectUrlCache } from '../Crypto/attachmentEncryption';
import { upsertMlsGroupStates } from '../Crypto/mls/mlsApi';
import { mlsStore } from '../Crypto/mls/mlsStore';
import type { MlsBackupData } from '../Crypto/mls/mlsTypes';
import {
  uploadPublicKey,
  backupKeyToServer,
  fetchKeyBackup,
  type KeyBackupRecord,
} from '../Chat/chatService';

type MlsRestoreOutcome = 'skipped' | 'already_local' | 'restored' | 'failed';
interface MlsRestoreSummary {
  outcome: MlsRestoreOutcome;
  backupGroupStateCount: number;
  backupGroupKeyCount: number;
  hasConversationArtifacts: boolean;
}
type MlsRecoveryGateReason = 'password_required' | 'restore_failed' | 'sync_import_missing';

interface MlsRecoveryGateState {
  active: boolean;
  pending: boolean;
  reason: MlsRecoveryGateReason | null;
}

function createEmptyRestoreSummary(): MlsRestoreSummary {
  return {
    outcome: 'skipped',
    backupGroupStateCount: 0,
    backupGroupKeyCount: 0,
    hasConversationArtifacts: false,
  };
}

function hasMlsBackupPayload(backup: KeyBackupRecord | null): boolean {
  return Boolean(
    backup?.mls_state_encrypted &&
    backup.mls_state_iv &&
    backup.mls_state_salt
  );
}

function hasPasswordBackupPayload(backup: KeyBackupRecord | null): boolean {
  return Boolean(
    backup?.encrypted_private_key &&
    backup.iv &&
    backup.salt &&
    backup.key_id
  );
}

function toTimestamp(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePositiveVersion(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

function pickLatestTimestamp(current?: string | null, incoming?: string | null): string | null {
  if (!current) return incoming || null;
  if (!incoming) return current;
  return toTimestamp(incoming) > toTimestamp(current) ? incoming : current;
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
): Promise<MlsRestoreSummary> {
  if (!hasMlsBackupPayload(backup)) {
    return {
      outcome: 'skipped',
      backupGroupStateCount: 0,
      backupGroupKeyCount: 0,
      hasConversationArtifacts: false,
    };
  }

  try {
    const payload = await keyManager.decryptDataWithPassword(
      backup.mls_state_encrypted!,
      backup.mls_state_iv!,
      backup.mls_state_salt!,
      password
    ) as MlsBackupData;

    const existingAccount = await mlsStore.getAccountState(userId);
    const existingGroups = await mlsStore.listGroupStates();
    const existingKeyPackages = await mlsStore.listKeyPackages(userId);
    const existingGroupKeys = await keyManager.exportGroupKeys();

    const groupsByConversationId = new Map(
      existingGroups.map((group) => [group.conversationId, group]),
    );
    const keyPackagesByRef = new Map(
      existingKeyPackages.map((record) => [record.packageRef, record]),
    );
    const groupKeysById = new Map(
      existingGroupKeys.map((entry) => [entry.id, entry]),
    );

    let restoredAccount = false;
    let restoredGroups = 0;
    let restoredKeyPackages = 0;
    let restoredGroupKeys = 0;
    const uploadedGroups: MlsBackupData['groups'] = [];

    const backupAccount =
      payload.accounts.find((account) => account.userId === userId) ||
      payload.accounts[0] ||
      null;
    if (
      backupAccount &&
      (!existingAccount || toTimestamp(backupAccount.updatedAt) >= toTimestamp(existingAccount.updatedAt))
    ) {
      await mlsStore.putAccountState(backupAccount);
      restoredAccount = !existingAccount || JSON.stringify(existingAccount) !== JSON.stringify(backupAccount);
    }

    for (const group of payload.groups) {
      const existing = groupsByConversationId.get(group.conversationId) || null;
      const existingVersion = normalizePositiveVersion(existing?.keyVersion ?? existing?.epoch ?? 0);
      const backupVersion = normalizePositiveVersion(group.keyVersion ?? group.epoch ?? 0);
      const shouldImport =
        !existing ||
        backupVersion > existingVersion ||
        (backupVersion === existingVersion &&
          toTimestamp(group.updatedAt) >= toTimestamp(existing.updatedAt) &&
          group.stateBlob !== existing.stateBlob);

      if (!shouldImport) {
        continue;
      }

      await mlsStore.putGroupState(group);
      groupsByConversationId.set(group.conversationId, group);
      restoredGroups += 1;
      uploadedGroups.push(group);
    }

    for (const keyPackage of payload.keyPackages) {
      if (keyPackage.userId !== userId) {
        continue;
      }

      const existing = keyPackagesByRef.get(keyPackage.packageRef) || null;
      if (!existing) {
        await mlsStore.putKeyPackage(keyPackage);
        keyPackagesByRef.set(keyPackage.packageRef, keyPackage);
        restoredKeyPackages += 1;
        continue;
      }

      const merged = {
        ...existing,
        packageData: keyPackage.packageData || existing.packageData,
        privateData: existing.privateData ?? keyPackage.privateData ?? null,
        createdAt: existing.createdAt || keyPackage.createdAt,
        publishedAt: pickLatestTimestamp(existing.publishedAt, keyPackage.publishedAt),
        consumedAt: pickLatestTimestamp(existing.consumedAt, keyPackage.consumedAt),
      };

      const didChange =
        merged.packageData !== existing.packageData ||
        (merged.privateData ?? null) !== (existing.privateData ?? null) ||
        (merged.publishedAt ?? null) !== (existing.publishedAt ?? null) ||
        (merged.consumedAt ?? null) !== (existing.consumedAt ?? null);

      if (!didChange) {
        continue;
      }

      await mlsStore.putKeyPackage(merged);
      keyPackagesByRef.set(keyPackage.packageRef, merged);
      restoredKeyPackages += 1;
    }

    const groupKeysToImport = (payload.groupKeys || []).filter((entry) => {
      const existing = groupKeysById.get(entry.id);
      return !existing || existing.key !== entry.key || existing.version !== entry.version;
    });
    if (groupKeysToImport.length > 0) {
      await keyManager.importGroupKeys(groupKeysToImport);
      restoredGroupKeys = groupKeysToImport.length;
    }

    if (uploadedGroups.length > 0) {
      try {
        console.log('[MLS_GROUP_STATE] uploading restored backup group states', {
          user_id: userId,
          group_state_count: uploadedGroups.length,
        });
        const uploaded = await upsertMlsGroupStates(
          uploadedGroups.map((group) => ({
            conversationId: group.conversationId,
            groupId: group.groupId,
            epoch: group.epoch,
            keyVersion: group.keyVersion ?? null,
            stateBlob: group.stateBlob,
          }))
        );
        console.log('[MLS_GROUP_STATE] uploaded restored backup group states', {
          user_id: userId,
          group_state_count: uploadedGroups.length,
          uploaded_items: uploaded,
        });
      } catch (err) {
        console.warn('[MLS_GROUP_STATE] backup group state upload failed', {
          user_id: userId,
          group_state_count: uploadedGroups.length,
          error: err instanceof Error ? err.message : String(err || ''),
        });
      }
    }

    const didRestore =
      restoredAccount ||
      restoredGroups > 0 ||
      restoredKeyPackages > 0 ||
      restoredGroupKeys > 0;
    const backupGroupStateCount = payload.groups.length;
    const backupGroupKeyCount = payload.groupKeys?.length || 0;
    const hasConversationArtifacts = backupGroupStateCount > 0 || backupGroupKeyCount > 0;

    console.log('[MLS_RESTORE] reconciled MLS state from backup', {
      user_id: userId,
      restored_account: restoredAccount,
      restored_group_states: restoredGroups,
      restored_group_keys: restoredGroupKeys,
      restored_key_packages: restoredKeyPackages,
      backup_group_state_count: backupGroupStateCount,
      backup_group_key_count: backupGroupKeyCount,
      backup_key_package_count: payload.keyPackages.length,
    });
    return {
      outcome: didRestore ? 'restored' : 'already_local',
      backupGroupStateCount,
      backupGroupKeyCount,
      hasConversationArtifacts,
    };
  } catch (err) {
    console.warn('[MLS_RESTORE] restore failed', {
      user_id: userId,
      error: err instanceof Error ? err.message : String(err || ''),
    });
    return {
      outcome: 'failed',
      backupGroupStateCount: 0,
      backupGroupKeyCount: 0,
      hasConversationArtifacts: false,
    };
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
  retryMlsRecoveryWithPassword: (password: string) => Promise<void>;
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
  const liveConversationKeyVersionsRef = useRef<Record<string, number>>({});
  const pendingLiveInboxSyncTimerRef = useRef<number | null>(null);

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
    return hasPasswordBackupPayload(backup) ? 'SECURE' : 'UNINITIALIZED';
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
    clearDecryptedAttachmentObjectUrlCache();
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

  const retryMlsRecoveryWithPassword = async (password: string) => {
    if (!user?.id) {
      throw new Error('AUTH_REQUIRED');
    }

    const normalizedPassword = password.trim();
    if (!normalizedPassword) {
      throw new Error('PASSWORD_REQUIRED');
    }

    loginPasswordRef.current = normalizedPassword;
    setKeyStatusLoading(true);
    clearMlsRecoveryGate();

    try {
      const backup = await fetchKeyBackup();
      if (backup) {
        setKeyStatus(resolveKeyStatusFromBackup(backup));
      }

      let restoreSummary = createEmptyRestoreSummary();
      if (backup) {
        restoreSummary = await restoreMlsStateFromBackup(user.id, backup, normalizedPassword);
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

      console.log('[MLS_RECOVERY_GATE] password retry inspection', {
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
        loginPasswordRef.current = null;
        activateMlsRecoveryGate('password_required', {
          user_id: user.id,
          retry_source: 'inline_password_prompt',
        });
        throw new Error('INVALID_ACCOUNT_PASSWORD');
      }

      if (hasRecoverableServerState && !hasLocalChatState) {
        markMlsRecoveryPending('sync_import_missing', {
          user_id: user.id,
          retry_source: 'inline_password_prompt',
          synced_group_states: syncResult.syncedGroupStates,
          synced_welcomes: syncResult.syncedWelcomes,
          synced_commits: syncResult.syncedCommits,
        });
      } else {
        clearMlsRecoveryGate();
      }
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
          let restoreSummary: MlsRestoreSummary = createEmptyRestoreSummary();
          if (!cancelled) {
            setKeyStatus(resolveKeyStatusFromBackup(backup));
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
            : false;
          const hasRecoverableServerState =
            hasBackupConversationArtifacts ||
            syncResult.syncedGroupStates > 0 ||
            syncResult.syncedWelcomes > 0 ||
            syncResult.syncedCommits > 0;

          console.log('[MLS_RESTORE] recovery inspection complete', {
            user_id: userId,
            has_password: Boolean(password),
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

          if (!cancelled && hasRecoverableServerState && !hasLocalChatState) {
            if (!password && hasMlsBackup) {
              activateMlsRecoveryGate('password_required', {
                user_id: userId,
                has_mls_backup: hasMlsBackup,
                has_backup_conversation_artifacts: hasBackupConversationArtifacts,
                synced_group_states: syncResult.syncedGroupStates,
                synced_welcomes: syncResult.syncedWelcomes,
                synced_commits: syncResult.syncedCommits,
              });
            } else if (restoreSummary.outcome === 'failed') {
              activateMlsRecoveryGate('restore_failed', {
                user_id: userId,
                has_mls_backup: hasMlsBackup,
                has_backup_conversation_artifacts: hasBackupConversationArtifacts,
                synced_group_states: syncResult.syncedGroupStates,
                synced_welcomes: syncResult.syncedWelcomes,
                synced_commits: syncResult.syncedCommits,
              });
            } else {
              markMlsRecoveryPending('sync_import_missing', {
                user_id: userId,
                has_mls_backup: hasMlsBackup,
                has_backup_conversation_artifacts: hasBackupConversationArtifacts,
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
          activateMlsRecoveryGate(
            err.message === 'KEY_RESTORE_FAILED' ? 'restore_failed' : 'password_required',
            {
              user_id: userId,
              source: 'key_init',
            }
          );
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

        console.log('[MLS_LIVE_SYNC] syncing inbox after live conversation update', {
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

    // Login: initial bootstrap + backup, then immediate reserve top-up.
    void chatCryptoProtocolService.bootstrapAccount(userId, true).then(async () => {
      runKeyPackageTopUp();
      if (!password || cancelled) return;
      try {
        const keyBackup = await keyManager.prepareBackup(userId, password);
        const mlsFields = await buildMlsBackupFields(userId, password);
        await backupKeyToServer({ ...keyBackup, ...mlsFields });
        if (!cancelled) {
          setKeyStatus('SECURE');
        }
      } catch {
        // Non-critical — event-driven backup will catch future changes
      }
    }).catch(() => {});

    // Periodic maintenance fallback — run bootstrap + top-up every 60s.
    const maintenanceInterval = window.setInterval(() => {
      runBootstrapMaintenance(true);
      runKeyPackageTopUp();
    }, 60_000);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runBootstrapMaintenance(true);
        runKeyPackageTopUp();
      }
    };

    const onFocus = () => {
      runBootstrapMaintenance(true);
      runKeyPackageTopUp();
    };

    const onOnline = () => {
      runBootstrapMaintenance(true);
      runKeyPackageTopUp();
    };

    const onKeyPackageChanged = () => {
      runBootstrapMaintenance(true);
      if (loginPasswordRef.current && user?.id) {
        scheduleGroupKeyBackup(user.id, loginPasswordRef.current);
      }
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
      window.removeEventListener('void:group-key-changed', onKeyChanged);
      gateway.off('READY', onGatewayReady);
      gateway.off('RESUMED', onGatewayResumed);
      gateway.off('KEY_PACKAGE_LOW', onKeyPackageLow);
      gateway.off('CONVERSATION_UPDATE', onConversationUpdate);
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
