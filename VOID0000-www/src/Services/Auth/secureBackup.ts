import { keyManager } from '../Crypto/keyManager';
import { mlsStore } from '../Crypto/mls/mlsStore';
import type { MlsBackupData } from '../Crypto/mls/mlsTypes';
import { backupKeyToServer } from '../Chat/chatService';

export interface SecureKeyBackupPayload {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
  mls_state_encrypted?: string;
  mls_state_iv?: string;
  mls_state_salt?: string;
}

export async function buildMlsBackupFields(
  userId: string,
  password: string
): Promise<Pick<SecureKeyBackupPayload, 'mls_state_encrypted' | 'mls_state_iv' | 'mls_state_salt'> | null> {
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
  await backupKeyToServer(await prepareSecureBackup(userId, password));
}
