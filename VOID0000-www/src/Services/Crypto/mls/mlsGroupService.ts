import {
  bytesToBase64,
  createCommit,
  createGroup,
  decodeGroupState,
  decodeMlsMessage,
  emptyPskIndex,
  encodeMlsMessage,
  joinGroup,
  zeroOutUint8Array,
  type ClientState,
  type CiphersuiteImpl,
  type PrivateKeyPackage,
  type Proposal,
} from 'ts-mls';
import {
  checkKeyPackageAvailability,
  ingestMlsCommits,
  ingestMlsWelcomes,
  upsertMlsGroupStates,
} from './mlsApi';
import { applyCommitMessage, buildMlsClientConfig, deriveGroupAesKey, getMlsCiphersuiteImpl } from './mlsCryptoService';
import {
  buildAddProposals,
  deserializePrivatePackage,
  findLeafIndex,
  generateMemberKeyPackage,
  getMemberUserIds,
  zeroOutPrivateKeyPackage,
} from './mlsKeyService';
import { mlsStorageService } from './mlsStorageService';
import type { Conversation } from '../../Chat/chatService';
import type {
  MlsBootstrapResult,
  MlsConversationBootstrapInput,
  MlsDistributeGroupInput,
  MlsDistributeKeyResult,
  MlsInboxSyncResult,
  MlsServerCapabilities,
  MlsSyncCommitUpdate,
  MlsSyncGroupStateUpdate,
  MlsSyncWelcomeUpdate,
  PersistGroupStateOptions,
} from './mlsTypes';
import { MlsProtocolVersions } from './mlsTypes';
import { base64ToBytes, createMlsError, normalizeConversationKeyId, normalizePositiveVersion } from './mlsUtils';

interface MlsGroupServiceDependencies {
  getServerCapabilities: () => Promise<MlsServerCapabilities>;
  bootstrapAccount: (userId: string, force?: boolean) => Promise<void>;
  syncInbox: (userId: string, force?: boolean) => Promise<MlsInboxSyncResult>;
}

export class MlsGroupService {
  constructor(private readonly deps: MlsGroupServiceDependencies) {}

  private async uploadGroupStateRecord(
    record: Pick<MlsSyncGroupStateUpdate, 'conversationId' | 'groupId' | 'epoch' | 'keyVersion' | 'stateBlob'>,
    source: string,
  ): Promise<number> {
    const capabilities = await this.deps.getServerCapabilities();
    if (!capabilities.groupState) {
      return 0;
    }

    console.log('[MLS_GROUP_STATE] uploading group state', {
      conversation_id: record.conversationId,
      epoch: record.epoch,
      source,
    });

    try {
      const uploaded = await upsertMlsGroupStates([record]);
      console.log('[MLS_GROUP_STATE] uploaded group state', {
        conversation_id: record.conversationId,
        epoch: record.epoch,
        source,
        uploaded_items: uploaded,
      });
      return uploaded;
    } catch (err) {
      console.warn('[MLS_GROUP_STATE] upload failed', {
        conversation_id: record.conversationId,
        epoch: record.epoch,
        source,
        error: err instanceof Error ? err.message : String(err || ''),
      });
      return 0;
    }
  }

  private async persistGroupState(
    conversationId: string,
    state: ClientState,
    options: PersistGroupStateOptions,
  ): Promise<void> {
    const record = await mlsStorageService.saveGroupState(conversationId, state, {
      keyVersion: options.keyVersion,
    });
    if (options.upload === false) {
      return;
    }

    await this.uploadGroupStateRecord(
      {
        conversationId: record.conversationId,
        groupId: record.groupId,
        epoch: record.epoch,
        keyVersion: record.keyVersion,
        stateBlob: record.stateBlob,
      },
      options.source,
    );
  }

  async bootstrapConversation(input: MlsConversationBootstrapInput): Promise<MlsBootstrapResult> {
    const capabilities = await this.deps.getServerCapabilities();
    if (!capabilities.supported) {
      return {
        enabled: false,
        ready: false,
        mode: 'mls',
        reason: capabilities.reason || 'mls_server_not_supported',
      };
    }

    await this.deps.bootstrapAccount(input.userId);
    const conversationId = normalizeConversationKeyId(input.conversation);
    const groupState = await mlsStorageService.getGroupStateRecord(conversationId);
    if (!groupState) {
      return { enabled: true, ready: false, mode: 'mls', reason: 'mls_group_state_missing' };
    }

    return { enabled: true, ready: true, mode: 'mls' };
  }

  async distributeGroupSenderKey(input: MlsDistributeGroupInput): Promise<MlsDistributeKeyResult> {
    await this.deps.bootstrapAccount(input.userId);

    const capabilities = await this.deps.getServerCapabilities();
    const conversationId = normalizeConversationKeyId(input.conversation);
    const impl = await getMlsCiphersuiteImpl();
    const desiredMembers = [...new Set([...input.memberUserIds, input.userId].filter(Boolean))];
    const otherMembers = desiredMembers.filter((id) => id !== input.userId);
    const isDmConversation = input.conversation.type === 'dm';
    const requiredServerVersion = normalizePositiveVersion(input.conversation.current_key_version);

    let missingMemberUserIds: string[] = [];
    let existingState = await mlsStorageService.loadGroupState(conversationId);

    console.log('[MLS_DISTRIBUTE] start', {
      conversation_id: conversationId,
      conversation_type: input.conversation.type,
      requested_member_user_ids: desiredMembers,
      required_server_version: requiredServerVersion,
      has_existing_state: Boolean(existingState),
    });

    if (!isDmConversation && requiredServerVersion != null) {
      const ensureFreshLineage = async (reason: string): Promise<void> => {
        const localEpochBeforeSync = existingState ? Number(existingState.groupContext.epoch) : null;
        console.warn('[MLS_DISTRIBUTE] forcing sync before local membership distribution', {
          conversation_id: conversationId,
          reason,
          required_server_version: requiredServerVersion,
          local_epoch: localEpochBeforeSync,
        });

        try {
          await this.deps.syncInbox(input.userId, true);
        } catch (syncErr) {
          console.warn('[MLS_DISTRIBUTE] sync before distribution failed', {
            conversation_id: conversationId,
            reason,
            required_server_version: requiredServerVersion,
            local_epoch: localEpochBeforeSync,
            error: syncErr instanceof Error ? syncErr.message : String(syncErr || ''),
          });
        }

        existingState = await mlsStorageService.loadGroupState(conversationId);
        const localEpochAfterSync = existingState ? Number(existingState.groupContext.epoch) : null;
        const hasUsableLineage =
          existingState != null &&
          requiredServerVersion <= (localEpochAfterSync ?? 0) + 1;

        if (!hasUsableLineage) {
          throw createMlsError(
            'Local MLS state is behind the server. Sync latest durable group state before retrying this membership change.',
            'MLS_DISTRIBUTE_SYNC_REQUIRED',
          );
        }
      };

      if (!existingState && requiredServerVersion > 1) {
        await ensureFreshLineage('missing_local_state_for_advanced_server_version');
      } else if (existingState) {
        const localEpoch = Number(existingState.groupContext.epoch);
        if (requiredServerVersion > localEpoch + 1) {
          await ensureFreshLineage('local_lineage_behind_server_version');
        }
      }
    }

    if (!existingState && !isDmConversation && !input.allowFreshGroupBootstrap) {
      console.warn('[MLS_DISTRIBUTE] refusing fresh bootstrap for existing group without local state', {
        conversation_id: conversationId,
        conversation_type: input.conversation.type,
        required_server_version: requiredServerVersion,
      });

      try {
        await this.deps.syncInbox(input.userId, true);
      } catch (syncErr) {
        console.warn('[MLS_DISTRIBUTE] sync before refusing fresh bootstrap failed', {
          conversation_id: conversationId,
          required_server_version: requiredServerVersion,
          error: syncErr instanceof Error ? syncErr.message : String(syncErr || ''),
        });
      }

      existingState = await mlsStorageService.loadGroupState(conversationId);
      if (!existingState) {
        throw createMlsError(
          'Local MLS state is missing for this existing group. Sync latest durable group state before retrying.',
          'MLS_DISTRIBUTE_SYNC_REQUIRED',
        );
      }
    }

    let newState: ClientState | null = null;
    let welcomePayload: string | null = null;
    let commitPayload: string | null = null;
    let newMembersForWelcome: string[] = [];
    let existingPeers: string[] = [];
    let deferredKeyCleanup: PrivateKeyPackage | null = null;

    if (!existingState) {
      if (isDmConversation && otherMembers.length === 0) {
        throw new Error('DM peer could not be resolved for secure bootstrap');
      }

      if (isDmConversation) {
        for (const peerId of otherMembers) {
          const peerReady = await checkKeyPackageAvailability(peerId);
          if (!peerReady) {
            console.warn('[DM_BOOTSTRAP] peer failed non-consuming readiness check', {
              conversation_id: conversationId,
              user_id: input.userId,
              peer_user_id: peerId,
            });
            throw new Error('DM peer device is not ready for secure chat yet');
          }
        }
      }

      const myKp = await generateMemberKeyPackage(input.userId, impl);
      const groupIdBytes = new TextEncoder().encode(conversationId);
      let state = await createGroup(
        groupIdBytes,
        myKp.publicPackage,
        myKp.privatePackage,
        [],
        impl,
        buildMlsClientConfig(),
      );

      const addProposalResult =
        otherMembers.length > 0
          ? await buildAddProposals(otherMembers)
          : { proposals: [], addedUserIds: [], missingUserIds: [] };
      const addProposals = addProposalResult.proposals;
      missingMemberUserIds = addProposalResult.missingUserIds;

      if (isDmConversation && missingMemberUserIds.length > 0) {
        console.warn('[DM_BOOTSTRAP] peer key package unavailable during initial bootstrap', {
          conversation_id: conversationId,
          user_id: input.userId,
          missing_member_user_ids: missingMemberUserIds,
        });
        throw new Error('DM peer device is not ready for secure chat yet');
      }

      const commitResult = await createCommit(
        { state, cipherSuite: impl },
        { extraProposals: addProposals, ratchetTreeExtension: addProposals.length > 0 },
      );
      commitResult.consumed.forEach(zeroOutUint8Array);
      state = commitResult.newState;

      if (addProposals.length > 0) {
        if (commitResult.welcome) {
          welcomePayload = bytesToBase64(
            encodeMlsMessage({
              welcome: commitResult.welcome,
              wireformat: 'mls_welcome',
              version: MlsProtocolVersions.current,
            }),
          );
        }
        commitPayload = bytesToBase64(encodeMlsMessage(commitResult.commit));
        newMembersForWelcome = addProposalResult.addedUserIds;
      }

      newState = state;
      deferredKeyCleanup = myKp.privatePackage;
    } else {
      const currentMembers = getMemberUserIds(existingState);
      const toAdd = desiredMembers.filter((id) => !currentMembers.includes(id));
      const toRemove = currentMembers.filter((id) => !desiredMembers.includes(id));

      if (isDmConversation && toAdd.length > 0) {
        console.warn('[DM_BOOTSTRAP] refusing late DM membership change to preserve version-1 history', {
          conversation_id: conversationId,
          current_member_user_ids: currentMembers,
          missing_member_user_ids: toAdd,
        });
        const result = await mlsStorageService.cacheDerivedGroupKey(conversationId, existingState, impl);
        return {
          ...result,
          includedMemberUserIds: currentMembers,
          missingMemberUserIds: toAdd,
        };
      }

      if (toAdd.length === 0 && toRemove.length === 0) {
        const result = await mlsStorageService.cacheDerivedGroupKey(conversationId, existingState, impl);
        return {
          ...result,
          includedMemberUserIds: currentMembers,
          missingMemberUserIds: [],
        };
      }

      const proposals: Proposal[] = [];

      if (toAdd.length > 0) {
        const addProposalResult = await buildAddProposals(toAdd);
        proposals.push(...addProposalResult.proposals);
        newMembersForWelcome = addProposalResult.addedUserIds;
        missingMemberUserIds = addProposalResult.missingUserIds;
      }

      if (toAdd.length > 0 && missingMemberUserIds.length > 0 && toRemove.length === 0) {
        console.error('[MLS_DISTRIBUTE] refusing add/re-add without claimable peer key packages', {
          conversation_id: conversationId,
          conversation_type: input.conversation.type,
          requested_add_user_ids: toAdd,
          added_member_user_ids: newMembersForWelcome,
          missing_member_user_ids: missingMemberUserIds,
          server_key_version: input.conversation.current_key_version ?? null,
          mls_epoch: Number(existingState.groupContext.epoch),
        });
        throw createMlsError(
          'One or more members are not ready for secure group add yet',
          'MLS_ADD_KEY_PACKAGE_MISSING',
        );
      }

      for (const removeId of toRemove) {
        const leafIdx = findLeafIndex(existingState, removeId);
        if (leafIdx !== null) {
          proposals.push({ proposalType: 'remove', remove: { removed: leafIdx } });
        }
      }

      try {
        const commitResult = await createCommit(
          { state: existingState, cipherSuite: impl },
          { extraProposals: proposals, ratchetTreeExtension: toAdd.length > 0 },
        );
        commitResult.consumed.forEach(zeroOutUint8Array);
        newState = commitResult.newState;

        if (commitResult.welcome && toAdd.length > 0) {
          welcomePayload = bytesToBase64(
            encodeMlsMessage({
              welcome: commitResult.welcome,
              wireformat: 'mls_welcome',
              version: MlsProtocolVersions.current,
            }),
          );
        }
        commitPayload = bytesToBase64(encodeMlsMessage(commitResult.commit));
        existingPeers = currentMembers.filter((id) => id !== input.userId && !toRemove.includes(id));
      } catch (commitErr) {
        console.warn('[MLS] Existing-group commit failed - refusing bootstrap fallback', {
          conversation_id: conversationId,
          required_server_version: requiredServerVersion,
          local_epoch: Number(existingState.groupContext.epoch),
          error: commitErr instanceof Error ? commitErr.message : String(commitErr || ''),
        });
        try {
          await this.deps.syncInbox(input.userId, true);
        } catch (syncErr) {
          console.warn('[MLS_DISTRIBUTE] sync after commit failure failed', {
            conversation_id: conversationId,
            required_server_version: requiredServerVersion,
            local_epoch: Number(existingState.groupContext.epoch),
            error: syncErr instanceof Error ? syncErr.message : String(syncErr || ''),
          });
        }
        throw createMlsError(
          'Local MLS state could not apply this membership change. Sync latest durable group state before retrying.',
          'MLS_DISTRIBUTE_SYNC_REQUIRED',
        );
      }
    }

    if (!newState) {
      throw new Error('MLS group state creation failed');
    }

    await this.persistGroupState(conversationId, newState, {
      source: existingState ? 'distribute_update' : 'distribute_bootstrap',
      keyVersion: requiredServerVersion,
    });

    if (deferredKeyCleanup) {
      zeroOutPrivateKeyPackage(deferredKeyCleanup);
    }

    const result = await mlsStorageService.cacheDerivedGroupKey(conversationId, newState, impl);

    if (capabilities.welcomeInbox && welcomePayload && newMembersForWelcome.length > 0) {
      const welcomeRef = crypto.randomUUID();
      console.log('[MLS_WELCOME] ingesting welcome payload', {
        conversation_id: conversationId,
        welcome_ref: welcomeRef,
        recipient_user_ids: newMembersForWelcome,
      });

      try {
        await ingestMlsWelcomes(
          newMembersForWelcome.map((memberId) => ({
            userId: memberId,
            welcomeRef,
            payload: welcomePayload!,
            conversationId,
          })),
        );
      } catch (welcomeErr) {
        console.warn('[MLS_WELCOME] first upload attempt failed, retrying once', {
          conversation_id: conversationId,
          error: welcomeErr instanceof Error ? welcomeErr.message : String(welcomeErr || ''),
        });
        await ingestMlsWelcomes(
          newMembersForWelcome.map((memberId) => ({
            userId: memberId,
            welcomeRef: crypto.randomUUID(),
            payload: welcomePayload!,
            conversationId,
          })),
        );
      }
    }

    if (capabilities.commitFanout && commitPayload && existingPeers.length > 0) {
      console.log('[MLS_COMMIT] fanout commit payload', {
        conversation_id: conversationId,
        peer_user_ids: existingPeers,
      });
      await ingestMlsCommits([
        {
          conversationId,
          commitRef: crypto.randomUUID(),
          payload: commitPayload,
          epoch: Number(newState.groupContext.epoch) - 1,
        },
      ]);
    }

    return {
      ...result,
      includedMemberUserIds: getMemberUserIds(newState),
      missingMemberUserIds,
    };
  }

  async importSyncedGroupState(
    update: MlsSyncGroupStateUpdate,
    impl: CiphersuiteImpl,
  ): Promise<boolean> {
    const existing = await mlsStorageService.getGroupStateRecord(update.conversationId);
    if (existing && Number(existing.epoch) > Number(update.epoch)) {
      console.log('[MLS_GROUP_STATE] skipping stale synced group state', {
        conversation_id: update.conversationId,
        local_epoch: existing.epoch,
        incoming_epoch: update.epoch,
      });
      return false;
    }

    try {
      const stateBytes = base64ToBytes(update.stateBlob);
      const decoded = decodeGroupState(stateBytes, 0);
      if (!decoded) {
        throw new Error('Unable to decode synced group state');
      }

      const [decodedState] = decoded;
      const state: ClientState = { ...decodedState, clientConfig: buildMlsClientConfig() };
      await this.persistGroupState(update.conversationId, state, {
        source: 'sync_import',
        upload: false,
        keyVersion: update.keyVersion,
      });
      const keyResult = await mlsStorageService.cacheDerivedGroupKey(update.conversationId, state, impl);
      console.log('[MLS_GROUP_STATE] imported synced group state', {
        conversation_id: update.conversationId,
        incoming_epoch: update.epoch,
        previous_local_epoch: existing?.epoch ?? null,
        key_version: keyResult.keyVersion,
      });
      return true;
    } catch (err) {
      console.warn('[MLS_GROUP_STATE] sync import failed', {
        conversation_id: update.conversationId,
        incoming_epoch: update.epoch,
        error: err instanceof Error ? err.message : String(err || ''),
      });
      return false;
    }
  }

  async processIncomingWelcome(
    welcome: MlsSyncWelcomeUpdate,
    userId: string,
    impl: CiphersuiteImpl,
  ): Promise<boolean> {
    const conversationId = welcome.conversationId;
    if (!conversationId) return false;

    const joinedKeyVersionFloor =
      typeof welcome.joinedKeyVersionFloor === 'number' &&
      Number.isInteger(welcome.joinedKeyVersionFloor) &&
      welcome.joinedKeyVersionFloor > 0
        ? welcome.joinedKeyVersionFloor
        : null;

    const welcomeBytes = base64ToBytes(welcome.payload);
    const decoded = decodeMlsMessage(welcomeBytes, 0);
    if (!decoded) return false;

    const [msg] = decoded;
    if (msg.wireformat !== 'mls_welcome') return false;

    const myKeyPackages = await mlsStorageService.listKeyPackages(userId);
    const candidates = myKeyPackages.filter((kp) => kp.publishedAt && kp.privateData);

    for (const kpRecord of candidates) {
      try {
        const kpBytes = base64ToBytes(kpRecord.packageData);
        const kpDecoded = decodeMlsMessage(kpBytes, 0);
        if (!kpDecoded) continue;

        const [kpMsg] = kpDecoded;
        if (kpMsg.wireformat !== 'mls_key_package') continue;

        const privatePackage = deserializePrivatePackage(kpRecord.privateData!);
        const joinedState = await joinGroup(
          msg.welcome,
          kpMsg.keyPackage,
          privatePackage,
          emptyPskIndex,
          impl,
        );

        const derivedKey = await deriveGroupAesKey(joinedState, conversationId, impl);
        if (joinedKeyVersionFloor != null && derivedKey.keyVersion < joinedKeyVersionFloor) {
          console.warn('[MLS_WELCOME] rejecting stale welcome below current membership floor', {
            user_id: userId,
            conversation_id: conversationId,
            welcome_ref: welcome.welcomeRef,
            welcome_key_version: derivedKey.keyVersion,
            joined_key_version_floor: joinedKeyVersionFloor,
          });
          return true;
        }

        await this.persistGroupState(conversationId, joinedState, {
          source: 'welcome_join',
          keyVersion: derivedKey.keyVersion,
        });
        const result = await mlsStorageService.cacheDerivedGroupKey(conversationId, joinedState, impl, {
          aliasVersionOne: true,
        });
        await mlsStorageService.markKeyPackageConsumed(userId, kpRecord.packageRef);
        mlsStorageService.notifyKeyPackageChanged();
        console.log('[MLS_WELCOME] processed welcome', {
          user_id: userId,
          conversation_id: conversationId,
          welcome_ref: welcome.welcomeRef,
          key_version: result.keyVersion,
        });
        return true;
      } catch {
        // Key package did not match this welcome; try the next one.
      }
    }

    console.warn('[MLS_WELCOME] no matching key package for welcome', {
      user_id: userId,
      conversation_id: conversationId,
      welcome_ref: welcome.welcomeRef,
    });
    return false;
  }

  async processIncomingCommit(
    commit: MlsSyncCommitUpdate,
    impl: CiphersuiteImpl,
  ): Promise<boolean> {
    const state = await mlsStorageService.loadGroupState(commit.conversationId);
    if (!state) {
      console.log('[MLS_COMMIT] skipping commit without local group state', {
        conversation_id: commit.conversationId,
        commit_ref: commit.commitRef,
        commit_epoch: commit.epoch ?? null,
      });
      return false;
    }

    const localEpoch = Number(state.groupContext.epoch);
    if (commit.epoch != null && Number(commit.epoch) < localEpoch) {
      console.log('[MLS_COMMIT] skipping stale commit (local epoch ahead)', {
        conversation_id: commit.conversationId,
        commit_ref: commit.commitRef,
        commit_epoch: commit.epoch,
        local_epoch: localEpoch,
      });
      await mlsStorageService.markCommitApplied(commit.conversationId, commit.commitRef);
      return false;
    }

    let newState: ClientState | null = null;
    try {
      newState = await applyCommitMessage(state, commit.payload, impl);
      if (!newState) {
        return false;
      }
    } catch (err) {
      console.warn('[MLS_COMMIT] commit apply failed', {
        conversation_id: commit.conversationId,
        commit_ref: commit.commitRef,
        commit_epoch: commit.epoch ?? null,
        local_epoch: localEpoch,
        error: err instanceof Error ? err.message : String(err || ''),
      });
      throw err;
    }

    const commitKeyVersion = Number(newState.groupContext.epoch);
    await this.persistGroupState(commit.conversationId, newState, {
      source: 'commit_apply',
      keyVersion: commitKeyVersion,
    });
    const keyResult = await mlsStorageService.cacheDerivedGroupKey(commit.conversationId, newState, impl);
    await mlsStorageService.markCommitApplied(commit.conversationId, commit.commitRef);
    console.log('[MLS_COMMIT] applied commit', {
      conversation_id: commit.conversationId,
      commit_ref: commit.commitRef,
      key_version: keyResult.keyVersion,
    });
    return true;
  }

  /**
   * Preflight check for group member removal. Validates that local MLS state
   * is fresh enough and can build/commit the removal — with NO durable side
   * effects (no persist, no upload, no key cache).
   *
   * Syncing inbox is allowed (read-only from a durable-state perspective).
   * Throws MLS_DISTRIBUTE_SYNC_REQUIRED or MLS_PREFLIGHT_REMOVE_FAILED if
   * the removal cannot be applied locally.
   */
  async preflightGroupRemove(
    userId: string,
    conversation: Conversation,
    removeMemberIds: string[],
  ): Promise<void> {
    await this.deps.bootstrapAccount(userId);

    const conversationId = normalizeConversationKeyId(conversation);
    const impl = await getMlsCiphersuiteImpl();
    const requiredServerVersion = normalizePositiveVersion(conversation.current_key_version);

    let existingState = await mlsStorageService.loadGroupState(conversationId);

    // Lineage freshness check — same logic as distributeGroupSenderKey but
    // no durable side effects beyond syncing inbox (which only reads).
    if (requiredServerVersion != null) {
      const needsSync =
        (!existingState && requiredServerVersion > 1) ||
        (existingState != null &&
          requiredServerVersion > Number(existingState.groupContext.epoch) + 1);

      if (needsSync) {
        try {
          await this.deps.syncInbox(userId, true);
        } catch {
          // Best-effort sync; fall through to freshness check below.
        }
        existingState = await mlsStorageService.loadGroupState(conversationId);
      }

      const localEpoch = existingState ? Number(existingState.groupContext.epoch) : null;
      const hasUsableLineage =
        existingState != null &&
        requiredServerVersion <= (localEpoch ?? 0) + 1;

      if (!hasUsableLineage) {
        throw createMlsError(
          'Local MLS state is behind the server. Sync latest durable group state before retrying this membership change.',
          'MLS_DISTRIBUTE_SYNC_REQUIRED',
        );
      }
    }

    if (!existingState) {
      throw createMlsError(
        'Local MLS state is missing for this group. Cannot preflight removal.',
        'MLS_PREFLIGHT_REMOVE_FAILED',
      );
    }

    // Verify leaf indices exist for all removal targets.
    const proposals: Proposal[] = [];
    for (const removeId of removeMemberIds) {
      const leafIdx = findLeafIndex(existingState, removeId);
      if (leafIdx === null) {
        throw createMlsError(
          `Member ${removeId} not found in local MLS group state. Cannot apply removal.`,
          'MLS_PREFLIGHT_REMOVE_FAILED',
        );
      }
      proposals.push({ proposalType: 'remove', remove: { removed: leafIdx } });
    }

    // Dry-run createCommit — validates the MLS operation will succeed.
    // Result is discarded; no state is persisted.
    try {
      const commitResult = await createCommit(
        { state: existingState, cipherSuite: impl },
        { extraProposals: proposals, ratchetTreeExtension: false },
      );
      // Zero out any sensitive material from the discarded result.
      commitResult.consumed.forEach(zeroOutUint8Array);
    } catch (commitErr) {
      // Sync once and re-check, mirroring distributeGroupSenderKey behavior.
      try {
        await this.deps.syncInbox(userId, true);
      } catch {
        // Best-effort.
      }
      throw createMlsError(
        'Local MLS state could not apply this removal. Sync latest durable group state before retrying.',
        'MLS_PREFLIGHT_REMOVE_FAILED',
      );
    }
  }
}
