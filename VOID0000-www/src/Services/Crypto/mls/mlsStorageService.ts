import { bytesToBase64, decodeGroupState, encodeGroupState, type ClientState, type CiphersuiteImpl } from 'ts-mls';
import { keyManager } from '../keyManager';
import { archiveGroupKeys } from './mlsApi';
import { deriveGroupAesKey, buildMlsClientConfig } from './mlsCryptoService';
import { mlsStore } from './mlsStore';
import type {
  MlsAccountStateRecord,
  MlsCommitRecord,
  MlsDistributeKeyResult,
  MlsGroupStateRecord,
  MlsKeyPackageRecord,
  MlsWelcomeRecord,
} from './mlsTypes';
import { base64ToBytes, wrapArchiveKey } from './mlsUtils';

interface CacheDerivedGroupKeyOptions {
  aliasVersion?: number | null;
  userId?: string;
}

const MAX_ARCHIVE_BATCH_ITEMS = 200;

function extractConversationIdFromExportedGroupKey(
  id: string,
  version: number,
): string | null {
  const prefix = 'group:';
  const suffix = `:${version}`;
  if (!id.startsWith(prefix) || !id.endsWith(suffix)) {
    return null;
  }

  const conversationId = id.slice(prefix.length, -suffix.length);
  return conversationId || null;
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

  async deleteGroupState(conversationId: string): Promise<void> {
    await mlsStore.deleteGroupState(conversationId);
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

  async markKeyPackageClaimable(userId: string, packageRef: string): Promise<void> {
    await mlsStore.markKeyPackageClaimable(userId, packageRef);
  }

  async markKeyPackageConsumed(userId: string, packageRef: string): Promise<void> {
    await mlsStore.markKeyPackageConsumed(userId, packageRef);
  }

  async persistWelcome(record: MlsWelcomeRecord): Promise<void> {
    await mlsStore.putWelcome(record);
  }

  async listWelcomes(userId: string): Promise<MlsWelcomeRecord[]> {
    return mlsStore.listWelcomes(userId);
  }

  async markWelcomeConsumed(userId: string, welcomeRef: string): Promise<void> {
    await mlsStore.markWelcomeConsumed(userId, welcomeRef);
  }

  async markWelcomeFailedNoMatchingKeyPackage(
    userId: string,
    welcomeRef: string,
    attemptedKeyPackageRefs: string[],
  ): Promise<void> {
    await mlsStore.markWelcomeFailedNoMatchingKeyPackage(userId, welcomeRef, attemptedKeyPackageRefs);
  }

  async clearWelcomeFailure(userId: string, welcomeRef: string): Promise<void> {
    await mlsStore.clearWelcomeFailure(userId, welcomeRef);
  }

  async persistCommit(record: MlsCommitRecord): Promise<void> {
    await mlsStore.putCommit(record);
  }

  async markCommitApplied(conversationId: string, commitRef: string): Promise<void> {
    await mlsStore.markCommitApplied(conversationId, commitRef);
  }

  notifyKeyPackageChanged(): void {
    this.dispatchWindowEvent('void:mls-key-package-changed');
  }

  async syncArchivedGroupKeys(
    userId: string,
    options?: { conversationId?: string | null; replaceExisting?: boolean },
  ): Promise<number> {
    const identityBytes = await keyManager.getIdentityKeyBytes(userId);
    if (!identityBytes) {
      return 0;
    }

    const exportedKeys = await keyManager.exportGroupKeys();
    const archiveInputs: Array<{
      conversationId: string;
      keyVersion: number;
      keyData: string;
      replaceExisting?: boolean;
    }> = [];

    for (const entry of exportedKeys) {
      const conversationId = extractConversationIdFromExportedGroupKey(entry.id, entry.version);
      if (!conversationId) {
        continue;
      }

      if (options?.conversationId && options.conversationId !== conversationId) {
        continue;
      }

      try {
        const rawBytes = base64ToBytes(entry.key);
        const keyData = await wrapArchiveKey(
          rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength),
          identityBytes,
          userId,
        );

        archiveInputs.push({
          conversationId,
          keyVersion: entry.version,
          keyData,
          replaceExisting: options?.replaceExisting === true,
        });
      } catch (err) {
        console.warn('[MLS_ARCHIVE] skipping local group key during archive reconciliation', {
          conversation_id: conversationId,
          key_version: entry.version,
          error: err instanceof Error ? err.message : String(err || ''),
        });
      }
    }

    if (archiveInputs.length === 0) {
      return 0;
    }

    archiveInputs.sort((a, b) => {
      const conversationOrder = a.conversationId.localeCompare(b.conversationId);
      if (conversationOrder !== 0) {
        return conversationOrder;
      }
      return a.keyVersion - b.keyVersion;
    });

    let archivedCount = 0;
    for (let index = 0; index < archiveInputs.length; index += MAX_ARCHIVE_BATCH_ITEMS) {
      archivedCount += await archiveGroupKeys(
        archiveInputs.slice(index, index + MAX_ARCHIVE_BATCH_ITEMS),
      );
    }

    return archivedCount;
  }

  async cacheDerivedGroupKey(
    conversationId: string,
    state: ClientState,
    impl: CiphersuiteImpl,
    options?: CacheDerivedGroupKeyOptions,
  ): Promise<Pick<MlsDistributeKeyResult, 'key' | 'keyVersion'>> {
    const result = await deriveGroupAesKey(state, conversationId, impl);
    await keyManager.storeGroupKey(conversationId, result.keyVersion, result.key);

    if (
      options?.aliasVersion != null &&
      Number.isInteger(options.aliasVersion) &&
      options.aliasVersion > 0 &&
      options.aliasVersion !== result.keyVersion
    ) {
      await keyManager.storeGroupKey(conversationId, options.aliasVersion, result.key);
    }

    // Reconcile the full per-version archive for this conversation.
    // A transient failure while version N was current must not permanently
    // strand that historical key on one device only.
    if (options?.userId) {
      this.syncArchivedGroupKeys(options.userId, { conversationId }).catch((err) => {
        console.warn('[MLS_ARCHIVE] conversation archive reconciliation failed', {
          user_id: options.userId,
          conversation_id: conversationId,
          error: err instanceof Error ? err.message : String(err || ''),
        });
      });
    }

    this.dispatchWindowEvent('void:group-key-changed');
    return result;
  }
}

export const mlsStorageService = new MlsStorageService();
