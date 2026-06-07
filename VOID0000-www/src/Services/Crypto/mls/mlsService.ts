import type { Conversation } from '../../Chat/chatService';
import { keyManager } from '../keyManager';
import { debugLog } from '../../utils/debugLog';
import {
  consumeMlsWelcome,
  fetchKeyPackageReserveStatus,
  fetchMlsCapabilities,
  publishMlsKeyPackage,
  syncMlsInbox,
} from './mlsApi';
import { getMlsCiphersuiteImpl } from './mlsCryptoService';
import { MlsGroupService } from './mlsGroupService';
import { createKeyPackageRecord, getMemberUserIds } from './mlsKeyService';
import { mlsStorageService } from './mlsStorageService';
import { base64ToBytes, unwrapArchiveKey } from './mlsUtils';
import {
  EMPTY_MLS_SYNC_RESULT,
  MLS_ARCHIVE_SYNC_COOLDOWN_MS,
  MLS_BOOTSTRAP_COOLDOWN_MS,
  MLS_KEY_PACKAGE_TARGET,
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
  private readonly keyPackageTarget = MLS_KEY_PACKAGE_TARGET;
  private readonly syncInboxPromises = new Map<string, Promise<MlsInboxSyncResult>>();
  private readonly pendingForcedSyncInboxUsers = new Set<string>();
  private readonly pendingArchiveSyncInboxUsers = new Set<string>();
  private readonly lastArchiveSyncAtByUser = new Map<string, number>();
  private readonly reserveTopUpPromises = new Map<string, Promise<{ published: number; serverCount: number }>>();
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
      const nextClaimableAt = update.claimableAt ?? null;
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
        claimableAt: nextClaimableAt,
        consumedAt: nextConsumedAt,
      };

      const didChange =
        !existing ||
        existing.packageData !== nextRecord.packageData ||
        (existing.privateData ?? null) !== nextRecord.privateData ||
        (existing.publishedAt ?? null) !== nextPublishedAt ||
        (existing.claimableAt ?? null) !== nextClaimableAt ||
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
    const unpublished = (await mlsStorageService.listUnpublishedKeyPackages(userId))
      .filter((record) => Boolean(record.privateData));
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

  /**
   * Ensure this user has at least `target` claimable key packages on the server.
   * Newly published packages are staged until an encrypted MLS backup activates
   * them, so local staged inventory is included only to avoid duplicate work.
   *
   * Steps:
   * 1. Fetch exact server count via /check endpoint.
   * 2. If count >= target → done.
   * 3. Stage any genuinely local-unpublished packages (never reached server).
   * 4. If still below target, generate brand-new packages with fresh refs.
   * 5. Re-check server count after publishing.
   *
   * Consumed packages are never re-published (single-use guarantee).
   * A single-flight guard prevents concurrent duplicate runs per userId.
   */
  async ensureServerKeyPackageReserve(
    userId: string,
    target = this.keyPackageTarget,
    minimum = this.minimumKeyPackages,
  ): Promise<{ published: number; serverCount: number }> {
    const inflight = this.reserveTopUpPromises.get(userId);
    if (inflight) return inflight;

    const promise = this._ensureServerKeyPackageReserveWork(userId, target, minimum).finally(() => {
      this.reserveTopUpPromises.delete(userId);
    });
    this.reserveTopUpPromises.set(userId, promise);
    return promise;
  }

  private async _ensureServerKeyPackageReserveWork(
    userId: string,
    target: number,
    minimum: number,
  ): Promise<{ published: number; serverCount: number }> {
    const status = await fetchKeyPackageReserveStatus(userId);
    if (!status) {
      return { published: 0, serverCount: 0 };
    }

    // Use server-provided thresholds when available, fall back to caller args.
    const effectiveTarget = Math.max(target, status.targetRecommended || target);
    const effectiveMinimum = Math.max(minimum, status.minimumRequired || minimum);
    const localKeyPackages = await mlsStorageService.listKeyPackages(userId);
    const localUsablePackages = localKeyPackages.filter(
      (record) => !record.consumedAt && Boolean(record.privateData),
    );
    const localClaimableUsableCount = localUsablePackages.filter(
      (record) => Boolean(record.claimableAt),
    ).length;
    const localStagedUsableCount = localUsablePackages.filter(
      (record) => Boolean(record.publishedAt) && !record.claimableAt,
    ).length;
    const localPublishedUsableCount = localClaimableUsableCount + localStagedUsableCount;
    const claimableOrStagedCount =
      Math.max(status.availableCount, localClaimableUsableCount) + localStagedUsableCount;

    if (claimableOrStagedCount >= effectiveTarget && localPublishedUsableCount >= effectiveMinimum) {
      return { published: 0, serverCount: status.availableCount };
    }

    const serverDeficit = Math.max(0, effectiveTarget - claimableOrStagedCount);
    const localUsableDeficit = Math.max(0, effectiveMinimum - localPublishedUsableCount);
    const desiredLocalUsableTopUp =
      localUsableDeficit > 0
        ? Math.max(localUsableDeficit, effectiveTarget - localPublishedUsableCount)
        : 0;
    const deficit = Math.max(serverDeficit, desiredLocalUsableTopUp);
    let published = 0;

    // Stage 1: publish any genuinely local-unpublished packages that this
    // device can open. Server-synced public-only packages are not enough for
    // incoming welcomes because this browser lacks their private half.
    const localUnpublished = (await mlsStorageService.listUnpublishedKeyPackages(userId))
      .filter((record) => Boolean(record.privateData));
    const stage1Candidates = localUnpublished.slice(0, deficit);
    for (const record of stage1Candidates) {
      const ok = await this.publishKeyPackageRecord(record, 'server_repair');
      if (ok) published += 1;
    }

    // Stage 2: if still below target, generate brand-new key packages with
    // fresh crypto.randomUUID() refs.  This is the primary path when local
    // inventory is stale (server consumed packages without local knowledge).
    const remainingDeficit = deficit - published;
    if (remainingDeficit > 0) {
      for (let i = 0; i < remainingDeficit; i++) {
        await this.generateAndStoreKeyPackage(userId);
      }
      const freshPublished = await this.publishPendingKeyPackages(userId);
      published += freshPublished;
    }

    if (published > 0) {
      mlsStorageService.notifyKeyPackageChanged();
    }

    // Re-check: server is source of truth.
    const after = await fetchKeyPackageReserveStatus(userId);
    const finalCount = after?.availableCount ?? status.availableCount;

    if (finalCount < effectiveMinimum) {
      console.warn('[MLS_KEY_PACKAGE] server reserve still below minimum after top-up', {
        user_id: userId,
        server_count: finalCount,
        target: effectiveTarget,
        minimum: effectiveMinimum,
        staged: published,
        local_published_usable_count: localPublishedUsableCount,
        local_staged_usable_count: localStagedUsableCount + published,
        awaiting_encrypted_backup: localStagedUsableCount + published > 0,
      });
    } else {
      debugLog('[MLS_KEY_PACKAGE] server reserve topped up', {
        user_id: userId,
        server_count: finalCount,
        target: effectiveTarget,
        staged: published,
        local_published_usable_count: localPublishedUsableCount,
        local_staged_usable_count: localStagedUsableCount + published,
      });
    }

    return { published, serverCount: finalCount };
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
    let archivedLocalGroupKeys = 0;

    if (capabilities.keyPackages) {
      // Server availability is the source of truth for DM reachability.
      // ensureServerKeyPackageReserve handles all top-up logic including
      // publishing genuinely-unpublished locals and generating fresh packages.
      const reserveResult = await this.ensureServerKeyPackageReserve(userId);
      publishedKeyPackages = reserveResult.published;
      serverKeyPackageAvailable = reserveResult.serverCount >= this.minimumKeyPackages;

      const localKeyPackages = await mlsStorageService.listKeyPackages(userId);
      availableKeyPackages = localKeyPackages.filter((record) => !record.consumedAt).length;
      localPublishedKeyPackages = localKeyPackages.filter(
        (record) => !record.consumedAt && Boolean(record.claimableAt),
      ).length;
    }

    if (capabilities.groupState) {
      try {
        archivedLocalGroupKeys = await mlsStorageService.syncArchivedGroupKeys(userId);
      } catch (err) {
        console.warn('[MLS_ARCHIVE] local archive reconciliation failed during bootstrap', {
          user_id: userId,
          error: err instanceof Error ? err.message : String(err || ''),
        });
      }
    }

    debugLog('[MLS_BOOTSTRAP] account ready', {
      user_id: userId,
      forced: force,
      published_key_packages: publishedKeyPackages,
      local_published_key_packages: localPublishedKeyPackages,
      available_key_packages: availableKeyPackages,
      server_key_package_available: serverKeyPackageAvailable,
      archived_local_group_keys: archivedLocalGroupKeys,
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
  ): Promise<{ requiresFreshBootstrap: boolean }> {
    return this.groupService.preflightGroupRemove(userId, conversation, removeMemberIds);
  }

  async reuploadGroupState(conversationId: string): Promise<boolean> {
    return this.groupService.reuploadGroupState(conversationId);
  }

  /**
   * Returns the user IDs present in the local MLS group state for a
   * conversation, or null if no local state exists. Used to verify cached
   * DM key coverage without triggering any network requests.
   */
  async getLocalGroupMemberUserIds(conversationId: string): Promise<string[] | null> {
    const state = await mlsStorageService.loadGroupState(conversationId);
    if (!state) return null;
    return getMemberUserIds(state);
  }

  async discardLocalGroupState(conversationId: string): Promise<void> {
    await mlsStorageService.deleteGroupState(conversationId);
  }

  async syncInbox(
    userId: string,
    force = false,
    options: { forceArchiveSync?: boolean } = {},
  ): Promise<MlsInboxSyncResult> {
    const inflight = this.syncInboxPromises.get(userId);
    if (inflight) {
      if (force) {
        this.pendingForcedSyncInboxUsers.add(userId);
      }
      if (options.forceArchiveSync) {
        this.pendingArchiveSyncInboxUsers.add(userId);
      }
      return inflight;
    }

    const promise = this._syncInboxLoop(userId, force, options.forceArchiveSync === true).finally(() => {
      this.syncInboxPromises.delete(userId);
      this.pendingForcedSyncInboxUsers.delete(userId);
      this.pendingArchiveSyncInboxUsers.delete(userId);
    });
    this.syncInboxPromises.set(userId, promise);
    return promise;
  }

  private async _syncInboxLoop(
    userId: string,
    force = false,
    forceArchiveSync = false,
  ): Promise<MlsInboxSyncResult> {
    let shouldForce = force;
    let shouldForceArchive = forceArchiveSync;
    let result: MlsInboxSyncResult = { ...EMPTY_MLS_SYNC_RESULT };

    do {
      this.pendingForcedSyncInboxUsers.delete(userId);
      this.pendingArchiveSyncInboxUsers.delete(userId);
      result = await this._syncInboxWork(userId, shouldForce, shouldForceArchive);
      shouldForce = this.pendingForcedSyncInboxUsers.has(userId);
      shouldForceArchive = this.pendingArchiveSyncInboxUsers.has(userId);
      if (shouldForce || shouldForceArchive) {
        debugLog('[MLS_SYNC] running queued forced inbox sync after inflight request', {
          user_id: userId,
          force_archive_sync: shouldForceArchive,
        });
      }
    } while (shouldForce || shouldForceArchive);

    return result;
  }

  private async _syncInboxWork(
    userId: string,
    force = false,
    forceArchiveSync = false,
  ): Promise<MlsInboxSyncResult> {
    const capabilities = await this.getServerCapabilities();
    if (!capabilities.supported) {
      return { ...EMPTY_MLS_SYNC_RESULT };
    }

    await this.bootstrapAccount(userId);

    const account = await mlsStorageService.ensureAccountState(userId);
    const publishedKeyPackages = 0;

    if (!force && !forceArchiveSync && account.lastSyncedAt) {
      const elapsed = Date.now() - Date.parse(account.lastSyncedAt);
      if (elapsed < MLS_SYNC_COOLDOWN_MS) {
        return {
          ...EMPTY_MLS_SYNC_RESULT,
          publishedKeyPackages,
        };
      }
    }

    const lastArchiveSyncAt = this.lastArchiveSyncAtByUser.get(userId) ?? 0;
    const includeArchivedKeys =
      forceArchiveSync ||
      lastArchiveSyncAt === 0 ||
      Date.now() - lastArchiveSyncAt >= MLS_ARCHIVE_SYNC_COOLDOWN_MS;
    const payload = await syncMlsInbox(userId, { includeArchivedKeys });
    if (includeArchivedKeys) {
      this.lastArchiveSyncAtByUser.set(userId, Date.now());
    }
    debugLog('[MLS_SYNC] inbox payload received', {
      user_id: userId,
      forced: force,
      archived_keys_requested: includeArchivedKeys,
      key_packages: payload.keyPackages.length,
      group_states: payload.groupStates.length,
      welcomes: payload.welcomes.length,
      commits: payload.commits.length,
      archived_keys: payload.archivedKeys.length,
    });

    const impl = await getMlsCiphersuiteImpl();
    const keyPackageStateChanged = await this.syncKeyPackageInventory(userId, payload.keyPackages);

    for (const welcome of payload.welcomes) {
      await mlsStorageService.persistWelcome({
        userId: welcome.userId,
        welcomeRef: welcome.welcomeRef,
        payload: welcome.payload,
        conversationId: welcome.conversationId ?? null,
        receivedAt: welcome.receivedAt ?? new Date().toISOString(),
        consumedAt: null,
      });
    }

    const acknowledgedWelcomes: MlsSyncWelcomeUpdate[] = [];
    for (const welcome of payload.welcomes) {
      try {
        const localWelcome = (await mlsStorageService.listWelcomes(userId))
          .find((candidate) => candidate.welcomeRef === welcome.welcomeRef);
        if (localWelcome?.failureCode === 'no_matching_key_package') {
          const attemptedRefs = new Set(localWelcome.attemptedKeyPackageRefs || []);
          const usablePackages = (await mlsStorageService.listKeyPackages(userId))
            .filter((candidate) => candidate.publishedAt && candidate.privateData);
          const hasUntriedPackage = usablePackages.some(
            (candidate) => !attemptedRefs.has(candidate.packageRef),
          );

          if (!hasUntriedPackage) {
            continue;
          }

          await mlsStorageService.clearWelcomeFailure(userId, welcome.welcomeRef);
        }

        const result = await this.groupService.processIncomingWelcome(welcome, userId, impl);
        if (result.status === 'processed') {
          acknowledgedWelcomes.push(welcome);
        } else if (result.status === 'failed_no_matching_key_package') {
          await mlsStorageService.markWelcomeFailedNoMatchingKeyPackage(
            userId,
            welcome.welcomeRef,
            result.attemptedKeyPackageRefs,
          );
          await this.ensureServerKeyPackageReserve(userId).catch(() => {});
        }
      } catch (err) {
        console.warn('[MLS] Welcome processing failed:', err);
      }
    }

    for (const commit of payload.commits) {
      await mlsStorageService.persistCommit({
        conversationId: commit.conversationId,
        commitRef: commit.commitRef,
        payload: commit.payload,
        epoch: commit.epoch ?? null,
        receivedAt: commit.receivedAt ?? new Date().toISOString(),
        appliedAt: null,
      });
    }

    for (const commit of payload.commits) {
      try {
        await this.groupService.processIncomingCommit(commit, impl, userId);
      } catch (err) {
        console.warn('[MLS] Commit processing failed:', err);
      }
    }

    // Import archived group keys for same-account multi-device recovery.
    // Keys are AES-GCM wrapped with an HKDF-derived wrapping key from the
    // identity private key — unwrap before importing into keyManager.
    let importedArchivedKeys = 0;
    const identityBytes = payload.archivedKeys.length > 0
      ? await keyManager.getIdentityKeyBytes(userId)
      : null;
    for (const archived of payload.archivedKeys) {
      try {
        const existing = await keyManager.getGroupKey(archived.conversationId, archived.keyVersion);
        if (existing) continue;
        if (!identityBytes) continue;

        const rawBytes = await unwrapArchiveKey(archived.keyData, identityBytes, userId);
        const key = await crypto.subtle.importKey(
          'raw',
          rawBytes,
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt'],
        );
        await keyManager.storeGroupKey(archived.conversationId, archived.keyVersion, key);
        importedArchivedKeys += 1;
      } catch (archiveErr) {
        // Non-fatal — skip malformed or unwrap-failed entries, but log
        // detailed diagnostics so the exact failure point is visible.
        let keyDataParsed = false;
        let ivLength = 0;
        let ciphertextLength = 0;
        try {
          const combined = base64ToBytes(archived.keyData);
          ivLength = Math.min(combined.length, 12);
          ciphertextLength = Math.max(0, combined.length - 12);
          keyDataParsed = combined.length > 12;
        } catch { /* base64 decode failed */ }

        const alreadyExistsLocally = await keyManager
          .getGroupKey(archived.conversationId, archived.keyVersion)
          .then((k) => k !== null)
          .catch(() => false);

        console.warn('[MLS_SYNC] archived key import failed', {
          conversation_id: archived.conversationId,
          key_version: archived.keyVersion,
          has_identity_bytes: Boolean(identityBytes),
          key_data_parsed: keyDataParsed,
          iv_length: ivLength,
          ciphertext_length: ciphertextLength,
          unwrap_stage: keyDataParsed ? 'aes_gcm_decrypt' : 'base64_parse',
          already_exists_locally: alreadyExistsLocally,
          error: archiveErr instanceof Error ? archiveErr.message : String(archiveErr || ''),
        });
      }
    }
    if (importedArchivedKeys > 0) {
      debugLog('[MLS_SYNC] imported archived group keys', {
        user_id: userId,
        imported: importedArchivedKeys,
        total: payload.archivedKeys.length,
      });
    }

    // Import latest synced group states last. This is a catch-up fallback for
    // conversations with missing or stale local state, but it must not run
    // before welcome/commit replay. Jumping to the newest epoch first causes
    // intermediate commits to look stale, which strands exact historical keys
    // for messages sent during membership rotations (for example, the first
    // survivor-visible message right after a member removal).
    for (const groupState of payload.groupStates) {
      await this.groupService.importSyncedGroupState(groupState, impl, userId);
    }

    // Historical group states may have just restored exact keys for commits
    // that looked stale on the first pass. Re-run commit handling so those
    // commits can be acknowledged only after their message key exists.
    if (payload.groupStates.length > 0 && payload.commits.length > 0) {
      for (const commit of payload.commits) {
        try {
          await this.groupService.processIncomingCommit(commit, impl, userId);
        } catch (err) {
          console.warn('[MLS] Commit processing after historical state import failed:', err);
        }
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
