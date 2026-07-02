import {
  bytesToBase64,
  createCommit,
  createGroup,
  decodeGroupState,
  decodeMlsMessage,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  joinGroup,
  zeroOutUint8Array,
  type ClientState,
  type CiphersuiteImpl,
  type PrivateKeyPackage,
  type Proposal,
} from 'ts-mls';
import {
  applyMlsCommit,
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
import { keyManager } from '../keyManager';
import type { Conversation } from '../../Chat/chatService';
import type {
  MlsBootstrapResult,
  MlsConversationBootstrapInput,
  MlsDistributeGroupInput,
  MlsDistributeKeyResult,
  MlsInboxSyncResult,
  MlsMembershipFinalizeArtifacts,
  MlsServerCapabilities,
  MlsSyncCommitUpdate,
  MlsSyncGroupStateUpdate,
  MlsSyncWelcomeUpdate,
  MlsUploadGroupStateInput,
  MlsWelcomeProcessResult,
  PersistGroupStateOptions,
} from './mlsTypes';
import { MlsProtocolVersions } from './mlsTypes';
import { base64ToBytes, createMlsError, normalizeConversationKeyId, normalizePositiveVersion } from './mlsUtils';
import { debugLog } from '../../utils/debugLog';

interface MlsGroupServiceDependencies {
  getServerCapabilities: () => Promise<MlsServerCapabilities>;
  bootstrapAccount: (userId: string, force?: boolean) => Promise<void>;
  syncInbox: (userId: string, force?: boolean) => Promise<MlsInboxSyncResult>;
}

const DM_PEER_READINESS_BACKOFF_MS = [0, 450, 1100];

export class MlsGroupService {
  constructor(private readonly deps: MlsGroupServiceDependencies) {}

  private async waitForDmPeerAccountKeys(
    conversationId: string,
    currentUserId: string,
    peerUserId: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < DM_PEER_READINESS_BACKOFF_MS.length; attempt += 1) {
      const delayMs = DM_PEER_READINESS_BACKOFF_MS[attempt] ?? 0;
      if (delayMs > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
      }

      const peerReady = await checkKeyPackageAvailability(peerUserId);
      debugLog('[DM_BOOTSTRAP] peer account secure-key readiness check', {
        conversation_id: conversationId,
        user_id: currentUserId,
        peer_user_id: peerUserId,
        attempt: attempt + 1,
        ready: peerReady,
      });
      if (peerReady) {
        return true;
      }
    }

    return false;
  }

  private async uploadGroupStateRecord(
    record: Pick<MlsSyncGroupStateUpdate, 'conversationId' | 'groupId' | 'epoch' | 'keyVersion' | 'stateBlob'>,
    source: string,
  ): Promise<number> {
    const capabilities = await this.deps.getServerCapabilities();
    if (!capabilities.groupState) {
      return 0;
    }

    debugLog('[MLS_GROUP_STATE] uploading group state', {
      conversation_id: record.conversationId,
      epoch: record.epoch,
      source,
    });

    try {
      const uploaded = await upsertMlsGroupStates([record]);
      debugLog('[MLS_GROUP_STATE] uploaded group state', {
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
  ): Promise<number> {
    const record = await mlsStorageService.saveGroupState(conversationId, state, {
      keyVersion: options.keyVersion,
    });
    if (options.upload === false) {
      return -1;
    }

    return this.uploadGroupStateRecord(
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

  private serializeGroupState(
    conversationId: string,
    state: ClientState,
    keyVersion?: number | null,
  ): MlsUploadGroupStateInput {
    return {
      conversationId,
      groupId: bytesToBase64(state.groupContext.groupId),
      epoch: Number(state.groupContext.epoch),
      keyVersion: keyVersion ?? null,
      stateBlob: bytesToBase64(encodeGroupState(state)),
    };
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
    const currentDmServerVersion = requiredServerVersion ?? 1;
    const forceDmVersionBump = isDmConversation && input.forceKeyVersionBump === true;
    const forceFreshGroupBootstrap = !isDmConversation && input.forceFreshGroupBootstrap === true;
    let bumpDmVersionForFreshBootstrap = false;

    let missingMemberUserIds: string[] = [];
    let existingState = await mlsStorageService.loadGroupState(conversationId);
    if (forceFreshGroupBootstrap) {
      if (existingState) {
        await mlsStorageService.deleteGroupState(conversationId);
      }
      existingState = null;
    }

    debugLog('[MLS_DISTRIBUTE] start', {
      conversation_id: conversationId,
      conversation_type: input.conversation.type,
      requested_member_user_ids: desiredMembers,
      required_server_version: requiredServerVersion,
      force_key_version_bump: forceDmVersionBump,
      force_fresh_group_bootstrap: forceFreshGroupBootstrap,
      has_existing_state: Boolean(existingState),
    });

    if (!isDmConversation && requiredServerVersion != null && !forceFreshGroupBootstrap) {
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

        if (!hasUsableLineage && !input.allowFreshGroupBootstrap) {
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

    // --- Existing-state branch: try membership update on current local state ---
    if (existingState) {
      const currentMembers = getMemberUserIds(existingState);
      const forceReaddMemberIds = new Set(
        (input.forceReaddMemberUserIds || [])
          .filter((id) => id && id !== input.userId),
      );
      const forcedReaddIds = currentMembers.filter((id) => (
        forceReaddMemberIds.has(id) && desiredMembers.includes(id)
      ));
      const toAdd = desiredMembers.filter((id) => (
        !currentMembers.includes(id) || forcedReaddIds.includes(id)
      ));
      const toRemove = currentMembers.filter((id) => (
        !desiredMembers.includes(id) || forcedReaddIds.includes(id)
      ));

      if (isDmConversation && toAdd.length > 0) {
        // The existing DM MLS state is missing the peer — this happens when
        // User A bootstrapped the DM while User B had no keys on the server.
        // Discard the stale single-member state and fall through to fresh
        // bootstrap so both DM members are included in the new group.
        console.warn('[DM_REPAIR] stale single-member DM state detected, rebuilding', {
          conversation_id: conversationId,
          current_member_user_ids: currentMembers,
          missing_member_user_ids: toAdd,
        });
        await mlsStorageService.deleteGroupState(conversationId);
        existingState = null;
        bumpDmVersionForFreshBootstrap = true;
        // Reset vars that may have been partially set.
        newMembersForWelcome = [];
        missingMemberUserIds = [];
        // Skip the rest of the existing-state branch; the fresh-bootstrap
        // branch below (if !existingState && !newState) handles the rebuild.
      } else if (toAdd.length === 0 && toRemove.length === 0) {
        const result = await mlsStorageService.cacheDerivedGroupKey(conversationId, existingState, impl, {
          aliasVersion: isDmConversation ? currentDmServerVersion : undefined,
          userId: input.userId,
        });
        return {
          ...result,
          keyVersion: isDmConversation ? currentDmServerVersion : result.keyVersion,
          includedMemberUserIds: currentMembers,
          missingMemberUserIds: [],
        };
      } else {
        // Membership update on existing state (add/remove for non-DM-repair cases).
        const proposals: Proposal[] = [];

        if (toAdd.length > 0) {
          const addProposalResult = await buildAddProposals(toAdd);
          proposals.push(...addProposalResult.proposals);
          newMembersForWelcome = addProposalResult.addedUserIds;
          missingMemberUserIds = addProposalResult.missingUserIds;
        }

        if (toAdd.length > 0 && missingMemberUserIds.length > 0) {
          console.error('[MLS_DISTRIBUTE] refusing add/re-add without claimable peer key packages', {
            conversation_id: conversationId,
            conversation_type: input.conversation.type,
            requested_add_user_ids: toAdd,
            added_member_user_ids: newMembersForWelcome,
            missing_member_user_ids: missingMemberUserIds,
            forced_readd_user_ids: forcedReaddIds,
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
          const errMsg = commitErr instanceof Error ? commitErr.message : String(commitErr || '');
          console.warn('[MLS] Existing-group commit failed', {
            conversation_id: conversationId,
            required_server_version: requiredServerVersion,
            local_epoch: Number(existingState.groupContext.epoch),
            error: errMsg,
          });

          // "removing committer" means the local state has the wrong self-identity
          // (cross-user state pollution from pre-migration shared rows). Clear the
          // poisoned state and fall through to fresh-bootstrap below.
          if (errMsg.includes('removing committer')) {
            console.warn('[MLS_DISTRIBUTE] clearing poisoned local state (wrong committer identity)', {
              conversation_id: conversationId,
            });
            await mlsStorageService.deleteGroupState(conversationId);
            existingState = null;
            // Reset vars that may have been partially set during the failed branch.
            newMembersForWelcome = [];
            missingMemberUserIds = [];
          } else {
            try {
              await this.deps.syncInbox(input.userId, true);
            } catch (syncErr) {
              console.warn('[MLS_DISTRIBUTE] sync after commit failure failed', {
                conversation_id: conversationId,
                required_server_version: requiredServerVersion,
                error: syncErr instanceof Error ? syncErr.message : String(syncErr || ''),
              });
            }
            throw createMlsError(
              'Local MLS state could not apply this membership change. Sync latest durable group state before retrying.',
              'MLS_DISTRIBUTE_SYNC_REQUIRED',
            );
          }
        }
      }
    }

    // --- No-state branch: fresh-bootstrap the group ---
    // Reached when there was never a local state OR when poisoned state was
    // cleared above (removing-committer recovery).
    if (!existingState && !newState) {
      if (isDmConversation && otherMembers.length === 0) {
        throw new Error('DM peer could not be resolved for secure bootstrap');
      }

      if (isDmConversation) {
        for (const peerId of otherMembers) {
          const peerReady = await this.waitForDmPeerAccountKeys(conversationId, input.userId, peerId);
          if (!peerReady) {
            console.warn('[DM_BOOTSTRAP] peer account secure keys did not become claimable after readiness retries', {
              conversation_id: conversationId,
              user_id: input.userId,
              peer_user_id: peerId,
            });
            throw new Error('DM peer account secure keys are still preparing');
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

      if (!isDmConversation && missingMemberUserIds.length > 0) {
        console.warn('[MLS_DISTRIBUTE] refusing fresh group bootstrap without claimable peer key packages', {
          conversation_id: conversationId,
          conversation_type: input.conversation.type,
          requested_member_user_ids: otherMembers,
          added_member_user_ids: addProposalResult.addedUserIds,
          missing_member_user_ids: missingMemberUserIds,
          server_key_version: input.conversation.current_key_version ?? null,
        });
        throw createMlsError(
          'The joining member is not ready for secure approval yet. Ask them to refresh VOID, then retry approval.',
          'MLS_ADD_KEY_PACKAGE_MISSING',
        );
      }

      if (isDmConversation && missingMemberUserIds.length > 0) {
        console.warn('[DM_BOOTSTRAP] peer account secure key package unavailable during initial bootstrap', {
          conversation_id: conversationId,
          user_id: input.userId,
          missing_member_user_ids: missingMemberUserIds,
        });
        throw new Error('DM peer account secure keys are still preparing');
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
    }

    if (!newState) {
      throw new Error('MLS group state creation failed');
    }

    const distributionKeyVersion = isDmConversation
      ? (bumpDmVersionForFreshBootstrap || forceDmVersionBump ? currentDmServerVersion + 1 : currentDmServerVersion)
      : requiredServerVersion;
    const stageMembershipChange = input.stageOnly === true && !isDmConversation;

    const distributeSource = existingState ? 'distribute_update' : 'distribute_bootstrap';
    const stagedSnapshot = stageMembershipChange
      ? this.serializeGroupState(conversationId, newState, distributionKeyVersion)
      : null;

    if (!stageMembershipChange) {
      const durableUploadCount = await this.persistGroupState(conversationId, newState, {
        source: distributeSource,
        keyVersion: distributionKeyVersion,
      });

      if (durableUploadCount === 0) {
        console.error('[MLS_DISTRIBUTE] CRITICAL: durable group state upload failed after membership change', {
          conversation_id: conversationId,
          source: distributeSource,
          epoch: Number(newState.groupContext.epoch),
          key_version: distributionKeyVersion,
        });
      }
    }

    if (deferredKeyCleanup) {
      zeroOutPrivateKeyPackage(deferredKeyCleanup);
    }

    const result = stageMembershipChange
      ? await deriveGroupAesKey(newState, conversationId, impl)
      : await mlsStorageService.cacheDerivedGroupKey(conversationId, newState, impl, {
          aliasVersion: distributionKeyVersion,
          userId: input.userId,
        });

    let membershipArtifacts: MlsMembershipFinalizeArtifacts | null = null;
    if (stageMembershipChange && stagedSnapshot) {
      const welcomeRef = crypto.randomUUID();
      membershipArtifacts = {
        snapshot: stagedSnapshot,
        welcomes: welcomePayload
          ? newMembersForWelcome.map((memberId) => ({
              userId: memberId,
              welcomeRef,
              payload: welcomePayload,
              conversationId,
              keyVersion: distributionKeyVersion,
            }))
          : [],
        commit: commitPayload && existingPeers.length > 0
          ? {
              conversationId,
              commitRef: crypto.randomUUID(),
              payload: commitPayload,
              epoch: Number(newState.groupContext.epoch) - 1,
            }
          : null,
      };
    }

    if (!stageMembershipChange && capabilities.welcomeInbox && welcomePayload && newMembersForWelcome.length > 0) {
      const welcomeRef = crypto.randomUUID();
      debugLog('[MLS_WELCOME] ingesting welcome payload', {
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
            keyVersion: distributionKeyVersion,
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
            keyVersion: distributionKeyVersion,
          })),
        );
      }
    }

    if (!stageMembershipChange && capabilities.commitFanout && commitPayload && existingPeers.length > 0) {
      debugLog('[MLS_COMMIT] fanout commit payload', {
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
      keyVersion: isDmConversation && distributionKeyVersion != null
        ? distributionKeyVersion
        : result.keyVersion,
      includedMemberUserIds: getMemberUserIds(newState),
      missingMemberUserIds,
      membershipArtifacts,
    };
  }

  async importSyncedGroupState(
    update: MlsSyncGroupStateUpdate,
    impl: CiphersuiteImpl,
    userId?: string,
  ): Promise<boolean> {
    const existing = await mlsStorageService.getGroupStateRecord(update.conversationId);
    if (existing && Number(existing.epoch) >= Number(update.epoch)) {
      // A fresh-bootstrap can produce a lower epoch but higher key_version.
      // Accept the incoming state if its key_version is strictly higher.
      const existingKv = Number(existing.keyVersion ?? existing.epoch ?? 0);
      const incomingKv = Number(update.keyVersion ?? update.epoch ?? 0);
      if (incomingKv <= existingKv) {
        if (incomingKv > 0) {
          const existingHistoricalKey = await keyManager.getGroupKey(update.conversationId, incomingKv);
          if (!existingHistoricalKey) {
            try {
              const stateBytes = base64ToBytes(update.stateBlob);
              const decoded = decodeGroupState(stateBytes, 0);
              if (!decoded) {
                throw new Error('Unable to decode historical synced group state');
              }

              const [decodedState] = decoded;
              const state: ClientState = { ...decodedState, clientConfig: buildMlsClientConfig() };
              const keyResult = await mlsStorageService.cacheDerivedGroupKey(update.conversationId, state, impl, {
                aliasVersion: incomingKv,
                userId,
              });
              debugLog('[MLS_GROUP_STATE] cached historical synced group key', {
                conversation_id: update.conversationId,
                incoming_epoch: update.epoch,
                local_epoch: existing.epoch,
                key_version: keyResult.keyVersion,
                alias_version: incomingKv,
              });
              return true;
            } catch (historicalErr) {
              console.warn('[MLS_GROUP_STATE] historical key cache failed', {
                conversation_id: update.conversationId,
                incoming_epoch: update.epoch,
                local_epoch: existing.epoch,
                incoming_key_version: incomingKv,
                error: historicalErr instanceof Error ? historicalErr.message : String(historicalErr || ''),
              });
            }
          }
        }

        debugLog('[MLS_GROUP_STATE] skipping stale or same-epoch synced group state', {
          conversation_id: update.conversationId,
          local_epoch: existing.epoch,
          incoming_epoch: update.epoch,
          local_key_version: existingKv,
          incoming_key_version: incomingKv,
        });
        return false;
      }
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
      const keyResult = await mlsStorageService.cacheDerivedGroupKey(update.conversationId, state, impl, {
        aliasVersion: update.keyVersion,
        userId,
      });
      debugLog('[MLS_GROUP_STATE] imported synced group state', {
        conversation_id: update.conversationId,
        incoming_epoch: update.epoch,
        previous_local_epoch: existing?.epoch ?? null,
        key_version: keyResult.keyVersion,
        alias_version: update.keyVersion ?? null,
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
  ): Promise<MlsWelcomeProcessResult> {
    const conversationId = welcome.conversationId;
    if (!conversationId) return { status: 'pending' };

    const joinedKeyVersionFloor =
      typeof welcome.joinedKeyVersionFloor === 'number' &&
      Number.isInteger(welcome.joinedKeyVersionFloor) &&
      welcome.joinedKeyVersionFloor > 0
        ? welcome.joinedKeyVersionFloor
        : null;
    const welcomeKeyVersion =
      typeof welcome.keyVersion === 'number' &&
      Number.isInteger(welcome.keyVersion) &&
      welcome.keyVersion > 0
        ? welcome.keyVersion
        : null;

    const welcomeBytes = base64ToBytes(welcome.payload);
    const decoded = decodeMlsMessage(welcomeBytes, 0);
    if (!decoded) return { status: 'pending' };

    const [msg] = decoded;
    if (msg.wireformat !== 'mls_welcome') return { status: 'pending' };

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
          return { status: 'processed' };
        }

        await this.persistGroupState(conversationId, joinedState, {
          source: 'welcome_join',
          keyVersion: welcomeKeyVersion ?? derivedKey.keyVersion,
        });
        const result = await mlsStorageService.cacheDerivedGroupKey(conversationId, joinedState, impl, {
          aliasVersion: welcomeKeyVersion,
          userId,
        });
        await mlsStorageService.markKeyPackageConsumed(userId, kpRecord.packageRef);
        mlsStorageService.notifyKeyPackageChanged();
        debugLog('[MLS_WELCOME] processed welcome', {
          user_id: userId,
          conversation_id: conversationId,
          welcome_ref: welcome.welcomeRef,
          key_version: result.keyVersion,
          welcome_key_version: welcomeKeyVersion,
        });
        return { status: 'processed' };
      } catch {
        // Key package did not match this welcome; try the next one.
      }
    }

    console.warn('[MLS_WELCOME] no matching key package for welcome', {
      user_id: userId,
      conversation_id: conversationId,
      welcome_ref: welcome.welcomeRef,
    });
    return {
      status: 'failed_no_matching_key_package',
      attemptedKeyPackageRefs: candidates.map((candidate) => candidate.packageRef),
    };
  }

  async processIncomingCommit(
    commit: MlsSyncCommitUpdate,
    impl: CiphersuiteImpl,
    userId?: string,
  ): Promise<boolean> {
    const state = await mlsStorageService.loadGroupState(commit.conversationId);
    if (!state) {
      debugLog('[MLS_COMMIT] skipping commit without local group state', {
        conversation_id: commit.conversationId,
        commit_ref: commit.commitRef,
        commit_epoch: commit.epoch ?? null,
      });
      return false;
    }

    const localEpoch = Number(state.groupContext.epoch);
    if (commit.epoch != null && Number(commit.epoch) < localEpoch) {
      const commitKeyVersion = Number(commit.epoch) + 1;
      const hasCommitKey = await keyManager.getGroupKey(commit.conversationId, commitKeyVersion);
      if (!hasCommitKey) {
        console.warn('[MLS_COMMIT] stale commit is missing exact historical key; leaving unacknowledged', {
          conversation_id: commit.conversationId,
          commit_ref: commit.commitRef,
          commit_epoch: commit.epoch,
          local_epoch: localEpoch,
          required_key_version: commitKeyVersion,
        });
        return false;
      }

      debugLog('[MLS_COMMIT] skipping stale commit (local epoch ahead)', {
        conversation_id: commit.conversationId,
        commit_ref: commit.commitRef,
        commit_epoch: commit.epoch,
        local_epoch: localEpoch,
      });
      await mlsStorageService.markCommitApplied(commit.conversationId, commit.commitRef);
      try {
        await applyMlsCommit(commit.conversationId, commit.commitRef);
      } catch {
        // Best-effort server-side acknowledgement.
      }
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
    const keyResult = await mlsStorageService.cacheDerivedGroupKey(commit.conversationId, newState, impl, { userId });
    await mlsStorageService.markCommitApplied(commit.conversationId, commit.commitRef);
    try {
      await applyMlsCommit(commit.conversationId, commit.commitRef);
    } catch {
      // Best-effort server-side acknowledgement.
    }
    debugLog('[MLS_COMMIT] applied commit', {
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
  ): Promise<{ requiresFreshBootstrap: boolean }> {
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
    let missingLeaf = false;
    for (const removeId of removeMemberIds) {
      const leafIdx = findLeafIndex(existingState, removeId);
      if (leafIdx === null) {
        missingLeaf = true;
        break;
      }
      proposals.push({ proposalType: 'remove', remove: { removed: leafIdx } });
    }

    // If any removal target is missing from the local ratchet tree, sync
    // inbox once (the add-commit may be pending) and retry. If still
    // missing the local state is irrecoverably stale — clear it and let
    // distributeGroupSenderKey fresh-bootstrap the group with the correct
    // survivor set (same recovery path as the "removing committer" case).
    if (missingLeaf) {
      try {
        await this.deps.syncInbox(userId, true);
      } catch {
        // Best-effort sync.
      }
      const refreshedState = await mlsStorageService.loadGroupState(conversationId);
      if (refreshedState) {
        const allFound = removeMemberIds.every(
          (id) => findLeafIndex(refreshedState, id) !== null,
        );
        if (allFound) {
          // Sync resolved it — rebuild proposals from the refreshed state
          // and fall through to the dry-run commit below.
          proposals.length = 0;
          for (const removeId of removeMemberIds) {
            const leafIdx = findLeafIndex(refreshedState, removeId)!;
            proposals.push({ proposalType: 'remove', remove: { removed: leafIdx } });
          }
          existingState = refreshedState;
          missingLeaf = false;
        }
      }

      if (missingLeaf) {
        console.warn('[MLS_PREFLIGHT] member leaf missing after sync — clearing stale state for fresh bootstrap', {
          conversation_id: conversationId,
          remove_member_ids: removeMemberIds,
        });
        await mlsStorageService.deleteGroupState(conversationId);
        return { requiresFreshBootstrap: true };
      }
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
      const errMsg = commitErr instanceof Error ? commitErr.message : String(commitErr || '');
      console.warn('[MLS_PREFLIGHT] dry-run createCommit failed', {
        conversation_id: conversationId,
        local_epoch: Number(existingState.groupContext.epoch),
        required_server_version: requiredServerVersion,
        remove_member_ids: removeMemberIds,
        error: errMsg,
        stack: commitErr instanceof Error ? commitErr.stack : undefined,
      });

      // "removing committer" means the local state has the wrong self-identity
      // (cross-user state pollution from pre-migration shared rows). Clear the
      // poisoned state and return — the subsequent distributeGroupSenderKey call
      // will fresh-bootstrap the group with the correct member set.
      if (errMsg.includes('removing committer')) {
        console.warn('[MLS_PREFLIGHT] clearing poisoned local state (wrong committer identity)', {
          conversation_id: conversationId,
        });
        await mlsStorageService.deleteGroupState(conversationId);
        return { requiresFreshBootstrap: true };
      }

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

    return { requiresFreshBootstrap: false };
  }

  /**
   * Re-upload the local group state record to the server. Used by the
   * two-phase remove finalize path when the initial upload may have silently
   * failed. Returns true if a record was found and upload succeeded.
   */
  async reuploadGroupState(conversationId: string): Promise<boolean> {
    const record = await mlsStorageService.getGroupStateRecord(conversationId);
    if (!record) return false;

    const uploaded = await this.uploadGroupStateRecord(
      {
        conversationId: record.conversationId,
        groupId: record.groupId,
        epoch: record.epoch,
        keyVersion: record.keyVersion,
        stateBlob: record.stateBlob,
      },
      'reupload_for_finalize',
    );
    return uploaded > 0;
  }
}
