import { keyManager } from '../Crypto/keyManager';
import { mlsStore } from '../Crypto/mls/mlsStore';
import type { MlsBackupData } from '../Crypto/mls/mlsTypes';
import { backupKeyToServer, backupRecoveryKeyToServer } from '../Chat/chatService';

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

export async function uploadSecureBackups(userId: string, password: string): Promise<void> {
  const activatedRefs = await backupKeyToServer(await prepareSecureBackup(userId, password));
  await Promise.all(activatedRefs.map((packageRef) => mlsStore.markKeyPackageClaimable(userId, packageRef)));
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

export async function uploadRecoverySecureBackups(userId: string, recoveryKey: string): Promise<void> {
  const activatedRefs = await backupRecoveryKeyToServer(await prepareRecoverySecureBackup(userId, recoveryKey));
  await Promise.all(activatedRefs.map((packageRef) => mlsStore.markKeyPackageClaimable(userId, packageRef)));
}
