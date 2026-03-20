import { bytesToBase64, decodeGroupState, encodeGroupState, type ClientState, type CiphersuiteImpl } from 'ts-mls';
import { keyManager } from '../keyManager';
import { deriveGroupAesKey, buildMlsClientConfig } from './mlsCryptoService';
import { mlsStore } from './mlsStore';
import type {
  MlsAccountStateRecord,
  MlsDistributeKeyResult,
  MlsGroupStateRecord,
  MlsKeyPackageRecord,
} from './mlsTypes';
import { base64ToBytes } from './mlsUtils';

interface CacheDerivedGroupKeyOptions {
  aliasVersionOne?: boolean;
}

export class MlsStorageService {
  private dispatchWindowEvent(name: string): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(name));
    }
  }

  async saveGroupState(conversationId: string, state: ClientState): Promise<MlsGroupStateRecord> {
    const stateBytes = encodeGroupState(state);
    const record: MlsGroupStateRecord = {
      conversationId,
      groupId: bytesToBase64(state.groupContext.groupId),
      epoch: Number(state.groupContext.epoch),
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

    this.dispatchWindowEvent('void:group-key-changed');
    return result;
  }
}

export const mlsStorageService = new MlsStorageService();
