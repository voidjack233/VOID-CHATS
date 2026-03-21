import type { Conversation } from '../../Chat/chatService';
import {
  checkKeyPackageAvailability,
  consumeMlsWelcome,
  fetchMlsCapabilities,
  publishMlsKeyPackage,
  syncMlsInbox,
} from './mlsApi';
import { getMlsCiphersuiteImpl } from './mlsCryptoService';
import { MlsGroupService } from './mlsGroupService';
import { createKeyPackageRecord } from './mlsKeyService';
import { mlsStorageService } from './mlsStorageService';
import {
  EMPTY_MLS_SYNC_RESULT,
  MLS_BOOTSTRAP_COOLDOWN_MS,
  MLS_MINIMUM_KEY_PACKAGES,
  MLS_SYNC_COOLDOWN_MS,
  type MlsBootstrapResult,
  type MlsConversationBootstrapInput,
  type MlsDistributeGroupInput,
  type MlsDistributeKeyResult,
  type MlsInboxSyncResult,
  type MlsKeyPackageRecord,
  type MlsServerCapabilities,
  type MlsSyncKeyPackageUpdate,
  type MlsSyncWelcomeUpdate,
} from './mlsTypes';

export class MlsService {
  private serverCapabilitiesPromise: Promise<MlsServerCapabilities> | null = null;
  private readonly minimumKeyPackages = MLS_MINIMUM_KEY_PACKAGES;
  private readonly syncInboxPromises = new Map<string, Promise<MlsInboxSyncResult>>();
  private readonly groupService = new MlsGroupService({
    getServerCapabilities: () => this.getServerCapabilities(),
    bootstrapAccount: (userId: string, force = false) => this.bootstrapAccount(userId, force),
    syncInbox: (userId: string, force = false) => this.syncInbox(userId, force),
  });

  isEnabled(): boolean {
    return true;
  }

  isMlsMessageType(messageType: string | null | undefined): boolean {
    return messageType === 'mls_application';
  }

  private async getServerCapabilities(): Promise<MlsServerCapabilities> {
    if (!this.serverCapabilitiesPromise) {
      this.serverCapabilitiesPromise = fetchMlsCapabilities().catch(() => ({
        supported: false,
        keyPackages: false,
        groupState: false,
        commitFanout: false,
        welcomeInbox: false,
        reason: 'capabilities_fetch_failed',
      }));
    }

    return this.serverCapabilitiesPromise;
  }

  private async syncKeyPackageInventory(
    userId: string,
    updates: MlsSyncKeyPackageUpdate[],
  ): Promise<boolean> {
    let changed = false;

    for (const update of updates) {
      if (update.userId !== userId) {
        continue;
      }

      const existing = await mlsStorageService.getKeyPackage(update.userId, update.packageRef);
      const nextPackageData = update.packageData ?? existing?.packageData ?? null;
      if (!nextPackageData) {
        continue;
      }

      const nextPublishedAt = update.publishedAt ?? existing?.publishedAt ?? null;
      const nextConsumedAt = update.consumedAt ?? existing?.consumedAt ?? null;
      const nextCreatedAt =
        existing?.createdAt ||
        nextPublishedAt ||
        nextConsumedAt ||
        new Date().toISOString();

      const nextRecord: MlsKeyPackageRecord = {
        userId: update.userId,
        packageRef: update.packageRef,
        packageData: nextPackageData,
        privateData: existing?.privateData ?? null,
        createdAt: nextCreatedAt,
        publishedAt: nextPublishedAt,
        consumedAt: nextConsumedAt,
      };

      const didChange =
        !existing ||
        existing.packageData !== nextRecord.packageData ||
        (existing.privateData ?? null) !== nextRecord.privateData ||
        (existing.publishedAt ?? null) !== nextPublishedAt ||
        (existing.consumedAt ?? null) !== nextConsumedAt;

      if (!didChange) {
        continue;
      }

      await mlsStorageService.putKeyPackage(nextRecord);
      changed = true;
    }

    if (changed) {
      mlsStorageService.notifyKeyPackageChanged();
    }

    return changed;
  }

  private async generateAndStoreKeyPackage(userId: string): Promise<void> {
    const impl = await getMlsCiphersuiteImpl();
    const record = await createKeyPackageRecord(userId, impl);
    await mlsStorageService.putKeyPackage(record);
    mlsStorageService.notifyKeyPackageChanged();
  }

  private async ensureLocalKeyPackages(userId: string): Promise<void> {
    const localKeyPackages = await mlsStorageService.listKeyPackages(userId);
    const available = localKeyPackages.filter((record) => !record.consumedAt);
    if (available.length >= this.minimumKeyPackages) {
      return;
    }

    const missing = this.minimumKeyPackages - available.length;
    await Promise.all(
      Array.from({ length: missing }).map(() => this.generateAndStoreKeyPackage(userId)),
    );
  }

  private async publishKeyPackageRecord(
    record: Pick<MlsKeyPackageRecord, 'userId' | 'packageRef' | 'packageData'>,
    source: 'pending_upload' | 'server_repair',
  ): Promise<boolean> {
    try {
      const ok = await publishMlsKeyPackage({
        userId: record.userId,
        packageRef: record.packageRef,
        packageData: record.packageData,
      });

      if (!ok) {
        console.warn('[MLS_KEY_PACKAGE] publish rejected or failed', {
          user_id: record.userId,
          package_ref: record.packageRef,
          source,
        });
        return false;
      }

      await mlsStorageService.markKeyPackagePublished(record.userId, record.packageRef);
      return true;
    } catch (err) {
      console.warn('[MLS_KEY_PACKAGE] publish threw', {
        user_id: record.userId,
        package_ref: record.packageRef,
        source,
        error: err instanceof Error ? err.message : String(err || ''),
      });
      return false;
    }
  }

  private async publishPendingKeyPackages(userId: string): Promise<number> {
    const unpublished = await mlsStorageService.listUnpublishedKeyPackages(userId);
    let published = 0;

    for (const record of unpublished) {
      const ok = await this.publishKeyPackageRecord(record, 'pending_upload');
      if (ok) {
        published += 1;
      }
    }

    if (published > 0) {
      mlsStorageService.notifyKeyPackageChanged();
    }

    return published;
  }

  private async repairServerKeyPackageAvailability(
    userId: string,
    localKeyPackages: MlsKeyPackageRecord[],
  ): Promise<{ repairedPublications: number; serverAvailable: boolean }> {
    let serverAvailable = await checkKeyPackageAvailability(userId);
    if (serverAvailable) {
      return { repairedPublications: 0, serverAvailable: true };
    }

    const repairCandidates = [...localKeyPackages]
      .filter((record) => !record.consumedAt)
      .sort((a, b) => {
        const aPublished = a.publishedAt ? 1 : 0;
        const bPublished = b.publishedAt ? 1 : 0;
        if (aPublished !== bPublished) {
          return aPublished - bPublished;
        }
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      })
      .slice(0, this.minimumKeyPackages);

    let repairedPublications = 0;
    for (const record of repairCandidates) {
      const ok = await this.publishKeyPackageRecord(record, 'server_repair');
      if (ok) {
        repairedPublications += 1;
      }
    }

    if (repairedPublications > 0) {
      mlsStorageService.notifyKeyPackageChanged();
    }

    serverAvailable = await checkKeyPackageAvailability(userId);
    if (!serverAvailable) {
      console.warn('[MLS_KEY_PACKAGE] server pool still unavailable after repair attempt', {
        user_id: userId,
        repair_candidate_count: repairCandidates.length,
        repaired_publications: repairedPublications,
      });
    }

    return {
      repairedPublications,
      serverAvailable,
    };
  }

  async bootstrapAccount(userId: string, force = false): Promise<void> {
    const capabilities = await this.getServerCapabilities();
    if (!capabilities.supported) {
      return;
    }

    const account = await mlsStorageService.ensureAccountState(userId);
    if (!force && account.lastBootstrappedAt) {
      const elapsed = Date.now() - Date.parse(account.lastBootstrappedAt);
      if (elapsed < MLS_BOOTSTRAP_COOLDOWN_MS) {
        return;
      }
    }

    let publishedKeyPackages = 0;
    let localPublishedKeyPackages = 0;
    let availableKeyPackages = 0;
    let serverKeyPackageAvailable = false;

    if (capabilities.keyPackages) {
      await this.ensureLocalKeyPackages(userId);
      publishedKeyPackages = await this.publishPendingKeyPackages(userId);

      let localKeyPackages = await mlsStorageService.listKeyPackages(userId);
      const repairResult = await this.repairServerKeyPackageAvailability(userId, localKeyPackages);
      publishedKeyPackages += repairResult.repairedPublications;
      serverKeyPackageAvailable = repairResult.serverAvailable;

      if (repairResult.repairedPublications > 0) {
        localKeyPackages = await mlsStorageService.listKeyPackages(userId);
      }

      availableKeyPackages = localKeyPackages.filter((record) => !record.consumedAt).length;
      localPublishedKeyPackages = localKeyPackages.filter(
        (record) => !record.consumedAt && Boolean(record.publishedAt),
      ).length;
    }

    console.log('[MLS_BOOTSTRAP] account ready', {
      user_id: userId,
      forced: force,
      published_key_packages: publishedKeyPackages,
      local_published_key_packages: localPublishedKeyPackages,
      available_key_packages: availableKeyPackages,
      server_key_package_available: serverKeyPackageAvailable,
    });

    await mlsStorageService.putAccountState({
      ...account,
      lastBootstrappedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async bootstrapConversation(input: MlsConversationBootstrapInput): Promise<MlsBootstrapResult> {
    return this.groupService.bootstrapConversation(input);
  }

  async distributeGroupSenderKey(input: MlsDistributeGroupInput): Promise<MlsDistributeKeyResult> {
    return this.groupService.distributeGroupSenderKey(input);
  }

  async preflightGroupRemove(
    userId: string,
    conversation: Conversation,
    removeMemberIds: string[],
  ): Promise<void> {
    return this.groupService.preflightGroupRemove(userId, conversation, removeMemberIds);
  }

  async syncInbox(userId: string, force = false): Promise<MlsInboxSyncResult> {
    const inflight = this.syncInboxPromises.get(userId);
    if (inflight) {
      return inflight;
    }

    const promise = this._syncInboxWork(userId, force).finally(() => {
      this.syncInboxPromises.delete(userId);
    });
    this.syncInboxPromises.set(userId, promise);
    return promise;
  }

  private async _syncInboxWork(userId: string, force = false): Promise<MlsInboxSyncResult> {
    const capabilities = await this.getServerCapabilities();
    if (!capabilities.supported) {
      return { ...EMPTY_MLS_SYNC_RESULT };
    }

    await this.bootstrapAccount(userId);

    const account = await mlsStorageService.ensureAccountState(userId);
    const publishedKeyPackages = 0;

    if (!force && account.lastSyncedAt) {
      const elapsed = Date.now() - Date.parse(account.lastSyncedAt);
      if (elapsed < MLS_SYNC_COOLDOWN_MS) {
        return {
          ...EMPTY_MLS_SYNC_RESULT,
          publishedKeyPackages,
        };
      }
    }

    const payload = await syncMlsInbox(userId);
    console.log('[MLS_SYNC] inbox payload received', {
      user_id: userId,
      forced: force,
      key_packages: payload.keyPackages.length,
      group_states: payload.groupStates.length,
      welcomes: payload.welcomes.length,
      commits: payload.commits.length,
    });

    const impl = await getMlsCiphersuiteImpl();
    const keyPackageStateChanged = await this.syncKeyPackageInventory(userId, payload.keyPackages);

    for (const groupState of payload.groupStates) {
      await this.groupService.importSyncedGroupState(groupState, impl);
    }

    const acknowledgedWelcomes: MlsSyncWelcomeUpdate[] = [];
    for (const welcome of payload.welcomes) {
      try {
        const joined = await this.groupService.processIncomingWelcome(welcome, userId, impl);
        if (joined) {
          acknowledgedWelcomes.push(welcome);
        }
      } catch (err) {
        console.warn('[MLS] Welcome processing failed:', err);
      }
    }

    for (const commit of payload.commits) {
      try {
        await this.groupService.processIncomingCommit(commit, impl);
      } catch (err) {
        console.warn('[MLS] Commit processing failed:', err);
      }
    }

    let ackCount = 0;
    if (capabilities.welcomeInbox && acknowledgedWelcomes.length > 0) {
      const ackResults = await Promise.all(
        acknowledgedWelcomes.map(async (welcome) => {
          const ok = await consumeMlsWelcome(welcome.welcomeRef);
          if (ok) {
            await mlsStorageService.markWelcomeConsumed(welcome.userId, welcome.welcomeRef);
          }
          return ok;
        }),
      );
      ackCount = ackResults.filter(Boolean).length;
    }

    if (capabilities.keyPackages && (keyPackageStateChanged || payload.welcomes.length > 0)) {
      await this.bootstrapAccount(userId, true);
    }

    const now = new Date().toISOString();
    await mlsStorageService.putAccountState({
      ...account,
      lastSyncedAt: now,
      updatedAt: now,
    });

    return {
      publishedKeyPackages,
      uploadedGroupStates: 0,
      uploadedWelcomes: 0,
      uploadedCommits: 0,
      syncedKeyPackages: payload.keyPackages.length,
      syncedGroupStates: payload.groupStates.length,
      syncedWelcomes: payload.welcomes.length,
      syncedCommits: payload.commits.length,
      acknowledgedWelcomes: ackCount,
      acknowledgedCommits: 0,
    };
  }
}

export const mlsService = new MlsService();
