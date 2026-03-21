import { bytesToBase64, decodeGroupState, encodeGroupState, type ClientState, type CiphersuiteImpl } from 'ts-mls';
import { keyManager } from '../keyManager';
import { archiveGroupKeys } from './mlsApi';
import { deriveGroupAesKey, buildMlsClientConfig } from './mlsCryptoService';
import { mlsStore } from './mlsStore';
import type {
  MlsAccountStateRecord,
  MlsDistributeKeyResult,
  MlsGroupStateRecord,
  MlsKeyPackageRecord,
} from './mlsTypes';
import { base64ToBytes, wrapArchiveKey } from './mlsUtils';

interface CacheDerivedGroupKeyOptions {
  aliasVersionOne?: boolean;
  aliasVersion?: number | null;
  userId?: string;
}

export class MlsStorageService {
  private dispatchWindowEvent(name: string): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(name));
    }
  }

  async saveGroupState(
    conversationId: string,
    state: ClientState,
    options?: { keyVersion?: number | null },
  ): Promise<MlsGroupStateRecord> {
    const stateBytes = encodeGroupState(state);
    const record: MlsGroupStateRecord = {
      conversationId,
      groupId: bytesToBase64(state.groupContext.groupId),
      epoch: Number(state.groupContext.epoch),
      keyVersion: options?.keyVersion ?? null,
      stateBlob: bytesToBase64(stateBytes),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await mlsStore.putGroupState(record);
    return record;
  }

  async loadGroupState(conversationId: string): Promise<ClientState | null> {
    const record = await this.getGroupStateRecord(conversationId);
    if (!record) return null;

    try {
      const bytes = base64ToBytes(record.stateBlob);
      const decoded = decodeGroupState(bytes, 0);
      if (!decoded) return null;

      const [groupState] = decoded;
      return { ...groupState, clientConfig: buildMlsClientConfig() };
    } catch {
      return null;
    }
  }

  async getGroupStateRecord(conversationId: string): Promise<MlsGroupStateRecord | null> {
    return mlsStore.getGroupState(conversationId);
  }

  async ensureAccountState(userId: string): Promise<MlsAccountStateRecord> {
    const existing = await mlsStore.getAccountState(userId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const record: MlsAccountStateRecord = {
      userId,
      clientId: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };

    await mlsStore.putAccountState(record);
    return record;
  }

  async putAccountState(record: MlsAccountStateRecord): Promise<void> {
    await mlsStore.putAccountState(record);
  }

  async getKeyPackage(userId: string, packageRef: string): Promise<MlsKeyPackageRecord | null> {
    return mlsStore.getKeyPackage(userId, packageRef);
  }

  async listKeyPackages(userId: string): Promise<MlsKeyPackageRecord[]> {
    return mlsStore.listKeyPackages(userId);
  }

  async listUnpublishedKeyPackages(userId: string): Promise<MlsKeyPackageRecord[]> {
    return mlsStore.listUnpublishedKeyPackages(userId);
  }

  async putKeyPackage(record: MlsKeyPackageRecord): Promise<void> {
    await mlsStore.putKeyPackage(record);
  }

  async markKeyPackagePublished(userId: string, packageRef: string): Promise<void> {
    await mlsStore.markKeyPackagePublished(userId, packageRef);
  }

  async markKeyPackageConsumed(userId: string, packageRef: string): Promise<void> {
    await mlsStore.markKeyPackageConsumed(userId, packageRef);
  }

  async markWelcomeConsumed(userId: string, welcomeRef: string): Promise<void> {
    await mlsStore.markWelcomeConsumed(userId, welcomeRef);
  }

  async markCommitApplied(conversationId: string, commitRef: string): Promise<void> {
    await mlsStore.markCommitApplied(conversationId, commitRef);
  }

  notifyKeyPackageChanged(): void {
    this.dispatchWindowEvent('void:mls-key-package-changed');
  }

  async cacheDerivedGroupKey(
    conversationId: string,
    state: ClientState,
    impl: CiphersuiteImpl,
    options?: CacheDerivedGroupKeyOptions,
  ): Promise<Pick<MlsDistributeKeyResult, 'key' | 'keyVersion'>> {
    const result = await deriveGroupAesKey(state, conversationId, impl);
    await keyManager.storeGroupKey(conversationId, result.keyVersion, result.key);

    if (options?.aliasVersionOne && result.keyVersion !== 1) {
      await keyManager.storeGroupKey(conversationId, 1, result.key);
    }

    if (
      options?.aliasVersion != null &&
      Number.isInteger(options.aliasVersion) &&
      options.aliasVersion > 0 &&
      options.aliasVersion !== result.keyVersion
    ) {
      await keyManager.storeGroupKey(conversationId, options.aliasVersion, result.key);
    }

    // Archive derived key to server for same-account multi-device recovery.
    // The key is AES-GCM wrapped with an HKDF-derived wrapping key from the
    // identity private key so the server only stores ciphertext.
    // Fire-and-forget: archiving failure must not block encryption/decryption.
    if (options?.userId) {
      try {
        const identityBytes = await keyManager.getIdentityKeyBytes(options.userId);
        if (identityBytes) {
          const rawBytes = await crypto.subtle.exportKey('raw', result.key);
          const keyData = await wrapArchiveKey(rawBytes, identityBytes, options.userId);
          archiveGroupKeys([{
            conversationId,
            keyVersion: result.keyVersion,
            keyData,
          }]).catch(() => {
            // Silently swallow — the key will be re-archived on next derivation.
          });
        }
      } catch {
        // Export or wrap failed — non-fatal.
      }
    }

    this.dispatchWindowEvent('void:group-key-changed');
    return result;
  }
}

export const mlsStorageService = new MlsStorageService();
