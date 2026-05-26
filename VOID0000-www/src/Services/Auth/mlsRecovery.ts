import { keyManager } from '../Crypto/keyManager';
import { upsertMlsGroupStates } from '../Crypto/mls/mlsApi';
import { mlsStore } from '../Crypto/mls/mlsStore';
import type { MlsBackupData } from '../Crypto/mls/mlsTypes';
import { debugLog } from '../utils/debugLog';
import type { KeyBackupRecord } from '../Chat/chatService';

export type MlsRestoreOutcome = 'skipped' | 'already_local' | 'restored' | 'failed';

export interface MlsRestoreSummary {
  outcome: MlsRestoreOutcome;
  backupGroupStateCount: number;
  backupGroupKeyCount: number;
  hasConversationArtifacts: boolean;
}

export function createEmptyRestoreSummary(): MlsRestoreSummary {
  return {
    outcome: 'skipped',
    backupGroupStateCount: 0,
    backupGroupKeyCount: 0,
    hasConversationArtifacts: false,
  };
}

export function hasMlsBackupPayload(backup: KeyBackupRecord | null): boolean {
  return Boolean(
    backup?.mls_state_encrypted &&
    backup.mls_state_iv &&
    backup.mls_state_salt
  );
}

export function hasRecoveryMlsBackupPayload(backup: KeyBackupRecord | null): boolean {
  return Boolean(
    backup?.recovery_mls_state_encrypted &&
    backup.recovery_mls_state_iv &&
    backup.recovery_mls_state_salt
  );
}

export function hasAccountMlsBackupPayload(backup: KeyBackupRecord | null): boolean {
  return Boolean(
    backup?.account_mls_state_encrypted &&
    backup.account_mls_state_iv &&
    backup.account_mls_state_key_id
  );
}

export function hasPasswordBackupPayload(backup: KeyBackupRecord | null): boolean {
  return Boolean(
    backup?.encrypted_private_key &&
    backup.iv &&
    backup.salt &&
    backup.key_id
  );
}

export function hasRecoveryBackupPayload(backup: KeyBackupRecord | null): boolean {
  return Boolean(
    backup?.recovery_encrypted_private_key &&
    backup.recovery_iv &&
    backup.recovery_salt &&
    backup.recovery_key_id
  );
}

function toTimestamp(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizePositiveVersion(value: unknown): number {
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

export async function inspectLocalMlsChatState(): Promise<{
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

export async function restoreMlsStateFromBackup(
  userId: string,
  backup: KeyBackupRecord,
  secret: string | null,
  mode: 'password' | 'recovery_key' | 'account_identity' = 'password'
): Promise<MlsRestoreSummary> {
  const hasPayload = mode === 'account_identity'
    ? hasAccountMlsBackupPayload(backup)
    : mode === 'recovery_key'
      ? hasRecoveryMlsBackupPayload(backup)
      : hasMlsBackupPayload(backup);

  if (!hasPayload) {
    return createEmptyRestoreSummary();
  }

  try {
    if (mode !== 'account_identity' && !secret) {
      throw new Error('MLS_BACKUP_SECRET_REQUIRED');
    }

    const payload = mode === 'account_identity'
      ? await keyManager.decryptDataWithAccountIdentity(
          userId,
          backup.account_mls_state_encrypted!,
          backup.account_mls_state_iv!,
          backup.account_mls_state_key_id
        ) as MlsBackupData
      : mode === 'recovery_key'
      ? await keyManager.decryptDataWithRecoveryPhrase(
          backup.recovery_mls_state_encrypted!,
          backup.recovery_mls_state_iv!,
          backup.recovery_mls_state_salt!,
          secret!
        ) as MlsBackupData
      : await keyManager.decryptDataWithPassword(
          backup.mls_state_encrypted!,
          backup.mls_state_iv!,
          backup.mls_state_salt!,
          secret!
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
        claimableAt: pickLatestTimestamp(existing.claimableAt, keyPackage.claimableAt),
        consumedAt: pickLatestTimestamp(existing.consumedAt, keyPackage.consumedAt),
      };

      const didChange =
        merged.packageData !== existing.packageData ||
        (merged.privateData ?? null) !== (existing.privateData ?? null) ||
        (merged.publishedAt ?? null) !== (existing.publishedAt ?? null) ||
        (merged.claimableAt ?? null) !== (existing.claimableAt ?? null) ||
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
        debugLog('[MLS_GROUP_STATE] uploading restored backup group states', {
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
        debugLog('[MLS_GROUP_STATE] uploaded restored backup group states', {
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

    debugLog('[MLS_RESTORE] reconciled MLS state from backup', {
      user_id: userId,
      backup_mode: mode,
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
      backup_mode: mode,
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
