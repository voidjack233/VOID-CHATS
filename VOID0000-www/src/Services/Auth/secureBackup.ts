import { keyManager } from '../Crypto/keyManager';
import { fetchKeyPackageReserveStatus } from '../Crypto/mls/mlsApi';
import { mlsStore } from '../Crypto/mls/mlsStore';
import type { MlsBackupData } from '../Crypto/mls/mlsTypes';
import { chatCryptoProtocolService } from '../Crypto/protocols/chatCryptoProtocolService';
import {
  backupAccountMlsStateToServer,
  backupKeyToServer,
  backupRecoveryKeyToServer,
  fetchKeyBackup,
} from '../Chat/chatService';
import { debugLog } from '../utils/debugLog';
import {
  hasAccountMlsBackupPayload,
  hasMlsBackupPayload,
  hasRecoveryMlsBackupPayload,
  restoreMlsStateFromBackup,
} from './mlsRecovery';

export interface SecureKeyBackupPayload {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
  mls_state_encrypted?: string;
  mls_state_iv?: string;
  mls_state_salt?: string;
  mls_key_package_refs?: string[];
}

export interface RecoveryKeyBackupPayload {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
  recovery_mls_state_encrypted?: string;
  recovery_mls_state_iv?: string;
  recovery_mls_state_salt?: string;
  mls_key_package_refs?: string[];
}

export interface AccountMlsBackupPayload {
  account_mls_state_encrypted: string;
  account_mls_state_iv: string;
  account_mls_state_key_id: string;
  mls_key_package_refs: string[];
}

export interface AccountSecureKeysReadinessResult {
  ready: boolean;
  claimableKeyPackagesCount: number;
  stagedKeyPackagesCount: number;
  backedUpKeyPackageRefsCount: number;
  activatedKeyPackageRefsCount: number;
}

interface EnsureAccountSecureKeysReadyOptions {
  password?: string | null;
  restoreBackup?: boolean;
  source?: string;
  attempts?: number;
}

const ACCOUNT_KEY_READINESS_BACKOFF_MS = [0, 450, 1200];
const accountKeyReadinessJobs = new Map<string, Promise<AccountSecureKeysReadinessResult>>();

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function buildMlsBackupFields(
  userId: string,
  password: string
): Promise<Pick<SecureKeyBackupPayload, 'mls_state_encrypted' | 'mls_state_iv' | 'mls_state_salt' | 'mls_key_package_refs'> | null> {
  try {
    const mlsData = await mlsStore.exportForBackup(userId);
    const groupKeys = await keyManager.exportGroupKeys();
    const payload: MlsBackupData = { ...mlsData, groupKeys };
    const { encrypted, iv, salt } = await keyManager.encryptDataWithPassword(payload, password);
    return {
      mls_state_encrypted: encrypted,
      mls_state_iv: iv,
      mls_state_salt: salt,
      mls_key_package_refs: mlsData.keyPackages
        .filter((record) => Boolean(record.privateData) && !record.consumedAt)
        .map((record) => record.packageRef),
    };
  } catch (err) {
    console.warn('🔑 MLS state export failed (non-critical):', err);
    return null;
  }
}

export async function buildRecoveryMlsBackupFields(
  userId: string,
  recoveryKey: string
): Promise<Pick<RecoveryKeyBackupPayload, 'recovery_mls_state_encrypted' | 'recovery_mls_state_iv' | 'recovery_mls_state_salt' | 'mls_key_package_refs'> | null> {
  try {
    const mlsData = await mlsStore.exportForBackup(userId);
    const groupKeys = await keyManager.exportGroupKeys();
    const payload: MlsBackupData = { ...mlsData, groupKeys };
    const { encrypted, iv, salt } = await keyManager.encryptDataWithRecoveryPhrase(payload, recoveryKey);
    return {
      recovery_mls_state_encrypted: encrypted,
      recovery_mls_state_iv: iv,
      recovery_mls_state_salt: salt,
      mls_key_package_refs: mlsData.keyPackages
        .filter((record) => Boolean(record.privateData) && !record.consumedAt)
        .map((record) => record.packageRef),
    };
  } catch (err) {
    console.warn('🔑 Recovery MLS state export failed (non-critical):', err);
    return null;
  }
}

export async function buildAccountMlsBackupFields(
  userId: string
): Promise<AccountMlsBackupPayload> {
  const mlsData = await mlsStore.exportForBackup(userId);
  const groupKeys = await keyManager.exportGroupKeys();
  const payload: MlsBackupData = { ...mlsData, groupKeys };
  const { encrypted, iv, keyId } = await keyManager.encryptDataWithAccountIdentity(userId, payload);
  return {
    account_mls_state_encrypted: encrypted,
    account_mls_state_iv: iv,
    account_mls_state_key_id: keyId,
    mls_key_package_refs: mlsData.keyPackages
      .filter((record) => Boolean(record.privateData) && !record.consumedAt)
      .map((record) => record.packageRef),
  };
}

export async function prepareSecureBackup(
  userId: string,
  password: string
): Promise<SecureKeyBackupPayload> {
  const keyBackup = await keyManager.prepareBackup(userId, password);
  const mlsFields = await buildMlsBackupFields(userId, password);
  return {
    ...keyBackup,
    ...(mlsFields || {}),
  };
}

export async function uploadSecureBackups(userId: string, password: string): Promise<string[]> {
  const activatedRefs = await backupKeyToServer(await prepareSecureBackup(userId, password));
  await Promise.all(activatedRefs.map((packageRef) => mlsStore.markKeyPackageClaimable(userId, packageRef)));
  return activatedRefs;
}

export async function prepareRecoverySecureBackup(
  userId: string,
  recoveryKey: string
): Promise<RecoveryKeyBackupPayload> {
  const keyBackup = await keyManager.prepareRecoveryBackup(userId, recoveryKey);
  const mlsFields = await buildRecoveryMlsBackupFields(userId, recoveryKey);
  return {
    ...keyBackup,
    ...(mlsFields || {}),
  };
}

export async function uploadRecoverySecureBackups(userId: string, recoveryKey: string): Promise<string[]> {
  const activatedRefs = await backupRecoveryKeyToServer(await prepareRecoverySecureBackup(userId, recoveryKey));
  await Promise.all(activatedRefs.map((packageRef) => mlsStore.markKeyPackageClaimable(userId, packageRef)));
  return activatedRefs;
}

export async function uploadAccountMlsBackup(userId: string): Promise<string[]> {
  const activatedRefs = await backupAccountMlsStateToServer(await buildAccountMlsBackupFields(userId));
  await Promise.all(activatedRefs.map((packageRef) => mlsStore.markKeyPackageClaimable(userId, packageRef)));
  return activatedRefs;
}

async function runAccountSecureKeysReadiness(
  userId: string,
  options: EnsureAccountSecureKeysReadyOptions,
): Promise<AccountSecureKeysReadinessResult> {
  const password = options.password?.trim() || null;
  const recoveryKey = await keyManager.getStoredRecoveryKeyForBackup(userId);
  const source = options.source || 'unspecified';

  if (options.restoreBackup !== false) {
    const backup = await fetchKeyBackup().catch(() => null);
    let restoredAccountBackup = false;
    if (backup && hasAccountMlsBackupPayload(backup)) {
      const result = await restoreMlsStateFromBackup(userId, backup, null, 'account_identity');
      restoredAccountBackup = result.outcome !== 'failed';
    }
    if (!restoredAccountBackup && backup && password && hasMlsBackupPayload(backup)) {
      await restoreMlsStateFromBackup(userId, backup, password);
    } else if (
      !restoredAccountBackup &&
      backup &&
      recoveryKey &&
      hasRecoveryMlsBackupPayload(backup)
    ) {
      await restoreMlsStateFromBackup(userId, backup, recoveryKey, 'recovery_key');
    }
  }

  const maxAttempts = Math.max(1, options.attempts ?? ACCOUNT_KEY_READINESS_BACKOFF_MS.length);
  let latestResult: AccountSecureKeysReadinessResult = {
    ready: false,
    claimableKeyPackagesCount: 0,
    stagedKeyPackagesCount: 0,
    backedUpKeyPackageRefsCount: 0,
    activatedKeyPackageRefsCount: 0,
  };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await delay(ACCOUNT_KEY_READINESS_BACKOFF_MS[Math.min(attempt, ACCOUNT_KEY_READINESS_BACKOFF_MS.length - 1)] ?? 0);

    if (attempt === 0) {
      await chatCryptoProtocolService.bootstrapAccount(userId, true);
    } else {
      await chatCryptoProtocolService.ensureServerKeyPackageReserve(userId);
    }

    const localKeyPackages = await mlsStore.listKeyPackages(userId);
    const backedUpRefs = localKeyPackages
      .filter((record) => Boolean(record.privateData) && !record.consumedAt)
      .map((record) => record.packageRef);
    const stagedCount = localKeyPackages.filter(
      (record) => Boolean(record.privateData) && Boolean(record.publishedAt) && !record.claimableAt && !record.consumedAt,
    ).length;

    const activatedRefs = new Set<string>();
    let didUploadEncryptedMlsBackup = false;
    try {
      const refs = await uploadAccountMlsBackup(userId);
      refs.forEach((packageRef) => activatedRefs.add(packageRef));
      didUploadEncryptedMlsBackup = true;
    } catch (error) {
      console.warn('[MLS_ACCOUNT_KEYS] account-wrapped MLS backup upload failed', {
        user_id: userId,
        source,
        error: error instanceof Error ? error.message : String(error || ''),
      });
    }
    if (password) {
      const refs = await uploadSecureBackups(userId, password);
      refs.forEach((packageRef) => activatedRefs.add(packageRef));
      didUploadEncryptedMlsBackup = true;
    }
    if (!didUploadEncryptedMlsBackup && recoveryKey) {
      const refs = await uploadRecoverySecureBackups(userId, recoveryKey);
      refs.forEach((packageRef) => activatedRefs.add(packageRef));
      didUploadEncryptedMlsBackup = true;
    }

    const status = await fetchKeyPackageReserveStatus(userId);
    latestResult = {
      ready: (status?.availableCount ?? 0) > 0,
      claimableKeyPackagesCount: status?.availableCount ?? 0,
      stagedKeyPackagesCount: stagedCount,
      backedUpKeyPackageRefsCount: didUploadEncryptedMlsBackup ? backedUpRefs.length : 0,
      activatedKeyPackageRefsCount: activatedRefs.size,
    };

    debugLog('[MLS_ACCOUNT_KEYS] readiness pass', {
      user_id: userId,
      source,
      attempt: attempt + 1,
      staged_key_packages_count: latestResult.stagedKeyPackagesCount,
      claimable_key_packages_count: latestResult.claimableKeyPackagesCount,
      backed_up_key_package_refs_count: latestResult.backedUpKeyPackageRefsCount,
      activated_key_package_refs_count: latestResult.activatedKeyPackageRefsCount,
      encrypted_backup_available: didUploadEncryptedMlsBackup,
    });

    if (latestResult.ready) {
      return latestResult;
    }
  }

  console.warn('[MLS_ACCOUNT_KEYS] secure setup keys are still preparing', {
    user_id: userId,
    source,
    staged_key_packages_count: latestResult.stagedKeyPackagesCount,
    claimable_key_packages_count: latestResult.claimableKeyPackagesCount,
    backed_up_key_package_refs_count: latestResult.backedUpKeyPackageRefsCount,
    activated_key_package_refs_count: latestResult.activatedKeyPackageRefsCount,
  });
  return latestResult;
}

export function ensureAccountSecureKeysReady(
  userId: string,
  options: EnsureAccountSecureKeysReadyOptions = {},
): Promise<AccountSecureKeysReadinessResult> {
  const currentJob = accountKeyReadinessJobs.get(userId);
  if (currentJob) {
    return currentJob;
  }

  const job = runAccountSecureKeysReadiness(userId, options).finally(() => {
    accountKeyReadinessJobs.delete(userId);
  });
  accountKeyReadinessJobs.set(userId, job);
  return job;
}
