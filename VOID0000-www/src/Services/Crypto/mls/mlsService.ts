import type { Conversation } from '../../Chat/chatService';
import { keyManager } from '../keyManager';
import {
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  generateKeyPackage,
  defaultCapabilities,
  defaultLifetime,
  createGroup,
  createCommit,
  joinGroup,
  emptyPskIndex,
  encodeGroupState,
  decodeGroupState,
  encodeMlsMessage,
  decodeMlsMessage,
  mlsExporter,
  zeroOutUint8Array,
  bytesToBase64,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  defaultKeyPackageEqualityConfig,
  defaultAuthenticationService,
  acceptAll,
  processPrivateMessage,
  processPublicMessage,
  type ClientState,
  type Proposal,
  type ClientConfig,
  type CiphersuiteImpl,
  type PrivateKeyPackage,
  type LeafIndex,
  type LeafNode,
  type CredentialBasic,
} from 'ts-mls';
import {
  consumeMlsWelcome,
  fetchMlsCapabilities,
  fetchUserKeyPackage,
  ingestMlsCommits,
  ingestMlsWelcomes,
  publishMlsKeyPackage,
  syncMlsInbox,
  upsertMlsGroupStates,
} from './mlsApi';
import { mlsStore } from './mlsStore';
import type {
  MlsAccountStateRecord,
  MlsBootstrapResult,
  MlsConversationBootstrapInput,
  MlsDistributeKeyResult,
  MlsInboxSyncResult,
  MlsServerCapabilities,
  MlsSyncCommitUpdate,
  MlsSyncGroupStateUpdate,
  MlsSyncWelcomeUpdate,
} from './mlsTypes';

// ─── Base64 helpers ───────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Ciphersuite (lazy singleton) ─────────────────────────────────────────────

let implPromise: Promise<CiphersuiteImpl> | null = null;

function getImpl(): Promise<CiphersuiteImpl> {
  if (!implPromise) {
    implPromise = getCiphersuiteImpl(
      getCiphersuiteFromName('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519')
    );
  }
  return implPromise;
}

// ─── ClientConfig ─────────────────────────────────────────────────────────────

function buildClientConfig(): ClientConfig {
  return {
    keyRetentionConfig: defaultKeyRetentionConfig,
    lifetimeConfig: defaultLifetimeConfig,
    keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
    paddingConfig: defaultPaddingConfig,
    authService: defaultAuthenticationService,
  };
}

// ─── Private package serialization ───────────────────────────────────────────

function serializePrivatePackage(priv: PrivateKeyPackage): string {
  return btoa(JSON.stringify({
    initPrivateKey: bytesToBase64(priv.initPrivateKey),
    hpkePrivateKey: bytesToBase64(priv.hpkePrivateKey),
    signaturePrivateKey: bytesToBase64(priv.signaturePrivateKey),
  }));
}

function deserializePrivatePackage(data: string): PrivateKeyPackage {
  const parsed = JSON.parse(atob(data)) as { initPrivateKey: string; hpkePrivateKey: string; signaturePrivateKey: string };
  return {
    initPrivateKey: base64ToBytes(parsed.initPrivateKey),
    hpkePrivateKey: base64ToBytes(parsed.hpkePrivateKey),
    signaturePrivateKey: base64ToBytes(parsed.signaturePrivateKey),
  };
}

// ─── Group state persistence ──────────────────────────────────────────────────

async function saveGroupState(conversationId: string, state: ClientState): Promise<void> {
  const stateBytes = encodeGroupState(state);
  const stateBlob = bytesToBase64(stateBytes);
  const epoch = Number(state.groupContext.epoch);
  const groupId = bytesToBase64(state.groupContext.groupId);
  const now = new Date().toISOString();
  await mlsStore.putGroupState({
    conversationId,
    groupId,
    epoch,
    stateBlob,
    createdAt: now,
    updatedAt: now,
  });
}

async function loadGroupState(conversationId: string): Promise<ClientState | null> {
  const record = await mlsStore.getGroupState(conversationId);
  if (!record) return null;
  try {
    const bytes = base64ToBytes(record.stateBlob);
    const decoded = decodeGroupState(bytes, 0);
    if (!decoded) return null;
    const [groupState] = decoded;
    return { ...groupState, clientConfig: buildClientConfig() };
  } catch {
    return null;
  }
}

// ─── AES key derivation ───────────────────────────────────────────────────────

async function deriveGroupAesKey(
  state: ClientState,
  conversationId: string,
  impl: CiphersuiteImpl
): Promise<Pick<MlsDistributeKeyResult, 'key' | 'keyVersion'>> {
  const contextBytes = new TextEncoder().encode(conversationId);
  const keyBytes = await mlsExporter(
    state.keySchedule.exporterSecret,
    'void-msg-key',
    contextBytes,
    32,
    impl
  );
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  return { key, keyVersion: Number(state.groupContext.epoch) };
}

// ─── Member helpers ───────────────────────────────────────────────────────────

function getGroupMembers(state: ClientState): LeafNode[] {
  return state.ratchetTree.flatMap((node, nodeIndex) => {
    if (node === undefined || nodeIndex % 2 !== 0 || node.nodeType !== 'leaf') return [];
    return [node.leaf];
  });
}

function getMemberUserIds(state: ClientState): string[] {
  return getGroupMembers(state).flatMap((leaf: LeafNode) => {
    if (leaf.credential.credentialType !== 'basic') return [];
    return [new TextDecoder().decode(leaf.credential.identity)];
  });
}

function findLeafIndex(state: ClientState, targetUserId: string): LeafIndex | null {
  const members = getGroupMembers(state);
  const idx = members.findIndex((leaf: LeafNode) => {
    if (leaf.credential.credentialType !== 'basic') return false;
    return new TextDecoder().decode(leaf.credential.identity) === targetUserId;
  });
  return idx === -1 ? null : (idx as LeafIndex);
}

function normalizeConversationKeyId(conversation: Conversation): string {
  return conversation.parent_conversation_id || conversation.id;
}

// ─── MlsService ───────────────────────────────────────────────────────────────

const BOOTSTRAP_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const SYNC_COOLDOWN_MS = 30 * 1000; // 30 seconds

interface AddProposalBuildResult {
  proposals: Proposal[];
  addedUserIds: string[];
  missingUserIds: string[];
}

interface PersistGroupStateOptions {
  source: string;
  upload?: boolean;
}

class MlsService {
  private serverCapabilitiesPromise: Promise<MlsServerCapabilities> | null = null;
  private readonly minimumKeyPackages = 3;
  private readonly syncInboxPromises = new Map<string, Promise<MlsInboxSyncResult>>();

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

  private async uploadGroupStateRecord(
    record: Pick<MlsSyncGroupStateUpdate, 'conversationId' | 'groupId' | 'epoch' | 'stateBlob'>,
    source: string,
  ): Promise<number> {
    const capabilities = await this.getServerCapabilities();
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
    await saveGroupState(conversationId, state);

    if (options.upload === false) {
      return;
    }

    const record = await mlsStore.getGroupState(conversationId);
    if (!record) {
      return;
    }

    await this.uploadGroupStateRecord({
      conversationId: record.conversationId,
      groupId: record.groupId,
      epoch: record.epoch,
      stateBlob: record.stateBlob,
    }, options.source);
  }

  private async cacheDerivedGroupKey(
    conversationId: string,
    state: ClientState,
    impl: CiphersuiteImpl,
    options?: { aliasVersionOne?: boolean },
  ): Promise<Pick<MlsDistributeKeyResult, 'key' | 'keyVersion'>> {
    const result = await deriveGroupAesKey(state, conversationId, impl);
    await keyManager.storeGroupKey(conversationId, result.keyVersion, result.key);
    if (options?.aliasVersionOne && result.keyVersion !== 1) {
      await keyManager.storeGroupKey(conversationId, 1, result.key);
    }
    window.dispatchEvent(new Event('void:group-key-changed'));
    return result;
  }

  private async importSyncedGroupState(
    update: MlsSyncGroupStateUpdate,
    impl: CiphersuiteImpl,
  ): Promise<boolean> {
    const existing = await mlsStore.getGroupState(update.conversationId);
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
      const state: ClientState = { ...decodedState, clientConfig: buildClientConfig() };
      await this.persistGroupState(update.conversationId, state, {
        source: 'sync_import',
        upload: false,
      });
      const keyResult = await this.cacheDerivedGroupKey(update.conversationId, state, impl);
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

  private async ensureAccountState(userId: string): Promise<MlsAccountStateRecord> {
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

  private async generateAndStoreKeyPackage(userId: string): Promise<void> {
    const impl = await getImpl();
    const credential: CredentialBasic = {
      credentialType: 'basic',
      identity: new TextEncoder().encode(userId),
    };
    const kp = await generateKeyPackage(
      credential,
      defaultCapabilities(),
      defaultLifetime,
      [],
      impl
    );
    const encodedPublic = encodeMlsMessage({
      keyPackage: kp.publicPackage,
      wireformat: 'mls_key_package',
      version: 'mls10',
    });
    const packageData = bytesToBase64(encodedPublic);
    const privateData = serializePrivatePackage(kp.privatePackage);

    // Zero out in-memory private keys after serialising
    zeroOutUint8Array(kp.privatePackage.initPrivateKey);
    zeroOutUint8Array(kp.privatePackage.hpkePrivateKey);
    zeroOutUint8Array(kp.privatePackage.signaturePrivateKey);

    await mlsStore.putKeyPackage({
      userId,
      packageRef: crypto.randomUUID(),
      packageData,
      privateData,
      createdAt: new Date().toISOString(),
    });
  }

  private async ensureLocalKeyPackages(userId: string): Promise<void> {
    const unpublished = await mlsStore.listUnpublishedKeyPackages(userId);
    if (unpublished.length >= this.minimumKeyPackages) return;
    const missing = this.minimumKeyPackages - unpublished.length;
    await Promise.all(Array.from({ length: missing }).map(() => this.generateAndStoreKeyPackage(userId)));
  }

  private async publishPendingKeyPackages(userId: string): Promise<number> {
    const unpublished = await mlsStore.listUnpublishedKeyPackages(userId);
    let published = 0;
    for (const record of unpublished) {
      const ok = await publishMlsKeyPackage({
        userId: record.userId,
        packageRef: record.packageRef,
        packageData: record.packageData,
      });
      if (ok) {
        await mlsStore.markKeyPackagePublished(record.userId, record.packageRef);
        published += 1;
      }
    }
    return published;
  }

  /**
   * Fetch peers' published key packages in parallel and build MLS Add proposals.
   */
  private async buildAddProposals(userIds: string[]): Promise<AddProposalBuildResult> {
    const results = await Promise.all(
      userIds.map(async (userId): Promise<{ proposal: Proposal | null; userId: string }> => {
        try {
          const kpData = await fetchUserKeyPackage(userId);
          if (!kpData) return { proposal: null, userId };
          const kpBytes = base64ToBytes(kpData.package_data);
          const decoded = decodeMlsMessage(kpBytes, 0);
          if (!decoded) return { proposal: null, userId };
          const [msg] = decoded;
          if (msg.wireformat !== 'mls_key_package') {
            return { proposal: null, userId };
          }
          return {
            proposal: { proposalType: 'add', add: { keyPackage: msg.keyPackage } },
            userId,
          };
        } catch {
          return { proposal: null, userId }; // Skip unavailable peers — they can be added later
        }
      })
    );

    const proposals: Proposal[] = [];
    const addedUserIds: string[] = [];
    const missingUserIds: string[] = [];

    results.forEach(({ proposal, userId }) => {
      if (proposal) {
        proposals.push(proposal);
        addedUserIds.push(userId);
        return;
      }

      missingUserIds.push(userId);
    });

    return {
      proposals,
      addedUserIds,
      missingUserIds,
    };
  }

  async bootstrapAccount(userId: string, force = false): Promise<void> {
    const capabilities = await this.getServerCapabilities();
    if (!capabilities.supported) return;
    const account = await this.ensureAccountState(userId);
    if (!force && account.lastBootstrappedAt) {
      const elapsed = Date.now() - Date.parse(account.lastBootstrappedAt);
      if (elapsed < BOOTSTRAP_COOLDOWN_MS) return;
    }
    let publishedKeyPackages = 0;
    if (capabilities.keyPackages) {
      await this.ensureLocalKeyPackages(userId);
      publishedKeyPackages = await this.publishPendingKeyPackages(userId);
    }
    console.log('[MLS_BOOTSTRAP] account ready', {
      user_id: userId,
      forced: force,
      published_key_packages: publishedKeyPackages,
    });
    await mlsStore.putAccountState({
      ...account,
      lastBootstrappedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  async bootstrapConversation(input: MlsConversationBootstrapInput): Promise<MlsBootstrapResult> {
    const capabilities = await this.getServerCapabilities();
    if (!capabilities.supported) {
      return {
        enabled: false,
        ready: false,
        mode: 'mls',
        reason: capabilities.reason || 'mls_server_not_supported',
      };
    }
    await this.bootstrapAccount(input.userId);
    const keyConversationId = normalizeConversationKeyId(input.conversation);
    const groupState = await mlsStore.getGroupState(keyConversationId);
    if (!groupState) {
      return { enabled: true, ready: false, mode: 'mls', reason: 'mls_group_state_missing' };
    }
    return { enabled: true, ready: true, mode: 'mls' };
  }

  /**
   * Create or update an MLS group for a conversation, distribute welcomes to new
   * members, and return an AES-256-GCM key derived from the MLS epoch exporter.
   */
  async distributeGroupSenderKey(input: {
    userId: string;
    conversation: Conversation;
    memberUserIds: string[];
    _retried?: boolean;
  }): Promise<MlsDistributeKeyResult> {
    await this.bootstrapAccount(input.userId);

    const capabilities = await this.getServerCapabilities();
    const conversationId = normalizeConversationKeyId(input.conversation);
    const impl = await getImpl();
    const desiredMembers = [...new Set([...input.memberUserIds, input.userId].filter(Boolean))];
    const otherMembers = desiredMembers.filter((id) => id !== input.userId);
    const isDmConversation = input.conversation.type === 'dm';
    let missingMemberUserIds: string[] = [];

    const existingState = await loadGroupState(conversationId);

    console.log('[MLS_DISTRIBUTE] start', {
      conversation_id: conversationId,
      conversation_type: input.conversation.type,
      requested_member_user_ids: desiredMembers,
      has_existing_state: Boolean(existingState),
    });

    // When no local MLS state exists, any conversation member may bootstrap
    // a fresh group.  This covers:
    //  • DMs where owner_id is null (either participant can initiate)
    //  • New-device logins where the member has no local state
    // The freshly-created group sends welcomes to all other members so they
    // converge on the new epoch automatically via syncInbox.

    let newState: ClientState;
    let welcomePayload: string | null = null;
    let commitPayload: string | null = null;
    let newMembersForWelcome: string[] = [];
    let existingPeers: string[] = [];
    // Deferred cleanup: zero-out ephemeral key package private keys AFTER
    // the group state has been persisted, so we don't corrupt shared
    // Uint8Array references that ts-mls keeps inside the ClientState.
    let deferredKeyCleanup: PrivateKeyPackage | null = null;

    if (!existingState) {
      // ── Create new MLS group ──────────────────────────────────────────────────
      if (isDmConversation && otherMembers.length === 0) {
        throw new Error('DM peer could not be resolved for secure bootstrap');
      }

      const myCredential: CredentialBasic = {
        credentialType: 'basic',
        identity: new TextEncoder().encode(input.userId),
      };
      const myKp = await generateKeyPackage(
        myCredential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        impl
      );
      const groupIdBytes = new TextEncoder().encode(conversationId);
      let state = await createGroup(
        groupIdBytes,
        myKp.publicPackage,
        myKp.privatePackage,
        [],
        impl,
        buildClientConfig()
      );

      {
        const addProposalResult = otherMembers.length > 0
          ? await this.buildAddProposals(otherMembers)
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

        // Always create a commit — even with no proposals — so the epoch
        // advances to 1 (matching the backend's current_key_version = 1).
        // NOTE: ts-mls may share Uint8Array references for private keys
        // between the input and output states — the ephemeral key package
        // cleanup is deferred until after saveGroupState to avoid corruption.
        const commitResult = await createCommit(
          { state, cipherSuite: impl },
          { extraProposals: addProposals, ratchetTreeExtension: addProposals.length > 0 }
        );
        commitResult.consumed.forEach(zeroOutUint8Array);
        state = commitResult.newState;

        if (addProposals.length > 0) {
          if (commitResult.welcome) {
            welcomePayload = bytesToBase64(
              encodeMlsMessage({ welcome: commitResult.welcome, wireformat: 'mls_welcome', version: 'mls10' })
            );
          }
          commitPayload = bytesToBase64(encodeMlsMessage(commitResult.commit));
          newMembersForWelcome = addProposalResult.addedUserIds;
        }
      }

      newState = state;

      // Defer cleanup until after saveGroupState — see deferredKeyCleanup comment above.
      deferredKeyCleanup = myKp.privatePackage;
    } else {
      // ── Update existing group (add/remove members, advance epoch) ─────────────
      const currentMembers = getMemberUserIds(existingState);
      const toAdd = desiredMembers.filter((id) => !currentMembers.includes(id));
      const toRemove = currentMembers.filter((id) => !desiredMembers.includes(id));

      if (isDmConversation && toAdd.length > 0) {
        console.warn('[DM_BOOTSTRAP] refusing late DM membership change to preserve version-1 history', {
          conversation_id: conversationId,
          current_member_user_ids: currentMembers,
          missing_member_user_ids: toAdd,
        });
        const result = await deriveGroupAesKey(existingState, conversationId, impl);
        await keyManager.storeGroupKey(conversationId, result.keyVersion, result.key);
        window.dispatchEvent(new Event('void:group-key-changed'));
        return {
          ...result,
          includedMemberUserIds: currentMembers,
          missingMemberUserIds: toAdd,
        };
      }

      // No-op: if the MLS group already has the right members, return the
      // current key without creating a commit.  Empty commits advance the
      // epoch and cause version drift between MLS epoch and the server's
      // current_key_version, which breaks key resolution for new members.
      if (toAdd.length === 0 && toRemove.length === 0) {
        const result = await deriveGroupAesKey(existingState, conversationId, impl);
        await keyManager.storeGroupKey(conversationId, result.keyVersion, result.key);
        window.dispatchEvent(new Event('void:group-key-changed'));
        return {
          ...result,
          includedMemberUserIds: currentMembers,
          missingMemberUserIds: [],
        };
      }

      const proposals: Proposal[] = [];

      if (toAdd.length > 0) {
        const addProposalResult = await this.buildAddProposals(toAdd);
        proposals.push(...addProposalResult.proposals);
        newMembersForWelcome = addProposalResult.addedUserIds;
        missingMemberUserIds = addProposalResult.missingUserIds;
      }

      if (toAdd.length > 0 && proposals.length === 0 && toRemove.length === 0) {
        console.warn('[MLS_DISTRIBUTE] additions requested but no peer key packages were available; skipping commit', {
          conversation_id: conversationId,
          conversation_type: input.conversation.type,
          requested_add_user_ids: toAdd,
          missing_member_user_ids: missingMemberUserIds,
        });
        const result = await deriveGroupAesKey(existingState, conversationId, impl);
        await keyManager.storeGroupKey(conversationId, result.keyVersion, result.key);
        window.dispatchEvent(new Event('void:group-key-changed'));
        return {
          ...result,
          includedMemberUserIds: currentMembers,
          missingMemberUserIds,
        };
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
          { extraProposals: proposals, ratchetTreeExtension: toAdd.length > 0 }
        );
        commitResult.consumed.forEach(zeroOutUint8Array);
        newState = commitResult.newState;

        if (commitResult.welcome && toAdd.length > 0) {
          welcomePayload = bytesToBase64(
            encodeMlsMessage({ welcome: commitResult.welcome, wireformat: 'mls_welcome', version: 'mls10' })
          );
        }
        commitPayload = bytesToBase64(encodeMlsMessage(commitResult.commit));

        // Existing members (excluding self) receive the commit to advance their epoch
        existingPeers = currentMembers.filter((id) => id !== input.userId && !toRemove.includes(id));
      } catch (commitErr) {
        // Corrupted group state (e.g. zeroed-out signing key).  Delete it
        // and recreate the group from scratch so the conversation recovers.
        if (input._retried) throw commitErr;
        console.warn('[MLS] Commit failed — recreating group:', commitErr);
        await mlsStore.deleteGroupState(conversationId);
        return this.distributeGroupSenderKey({ ...input, _retried: true });
      }
    }

    // ── Persist new group state (local IndexedDB only — contains private keys) ──
    await this.persistGroupState(conversationId, newState, {
      source: existingState ? 'distribute_update' : 'distribute_bootstrap',
    });

    // Now that the state bytes are safely persisted, zero out the ephemeral
    // key package private keys so they don't linger in memory.
    if (deferredKeyCleanup) {
      zeroOutUint8Array(deferredKeyCleanup.initPrivateKey);
      zeroOutUint8Array(deferredKeyCleanup.hpkePrivateKey);
      zeroOutUint8Array(deferredKeyCleanup.signaturePrivateKey);
    }

    // ── Derive and cache AES-256-GCM key immediately after state is saved ──────
    // This must happen before the HTTP fan-out calls so that concurrent callers
    // (e.g. setupConversation re-triggered by a WebSocket CONVERSATION_UPDATE
    // arriving before the rotate-remove HTTP response) can find the new key in
    // IndexedDB during their retry window instead of falling into ownerSelfHeal.
    const result = await this.cacheDerivedGroupKey(conversationId, newState, impl);

    // ── Send welcome messages to new members ──────────────────────────────────
    if (capabilities.welcomeInbox && welcomePayload && newMembersForWelcome.length > 0) {
      const welcomeRef = crypto.randomUUID();
      console.log('[MLS_WELCOME] ingesting welcome payload', {
        conversation_id: conversationId,
        welcome_ref: welcomeRef,
        recipient_user_ids: newMembersForWelcome,
      });
      await ingestMlsWelcomes(
        newMembersForWelcome.map((memberId) => ({
          userId: memberId,
          welcomeRef,
          payload: welcomePayload!,
          conversationId,
        }))
      );
    }

    // ── Fan-out commit to existing peers so they can advance their epoch ───────
    if (capabilities.commitFanout && commitPayload && existingPeers.length > 0) {
      console.log('[MLS_COMMIT] fanout commit payload', {
        conversation_id: conversationId,
        peer_user_ids: existingPeers,
      });
      await ingestMlsCommits([{
        conversationId,
        commitRef: crypto.randomUUID(),
        payload: commitPayload,
        epoch: Number(newState.groupContext.epoch) - 1,
      }]);
    }

    return {
      ...result,
      includedMemberUserIds: getMemberUserIds(newState),
      missingMemberUserIds,
    };
  }

  async syncInbox(userId: string, force = false): Promise<MlsInboxSyncResult> {
    // Deduplicate: if a sync is already in-flight for this user, reuse it.
    const inflight = this.syncInboxPromises.get(userId);
    if (inflight) return inflight;

    const promise = this._syncInboxWork(userId, force).finally(() => {
      this.syncInboxPromises.delete(userId);
    });
    this.syncInboxPromises.set(userId, promise);
    return promise;
  }

  private async _syncInboxWork(userId: string, force = false): Promise<MlsInboxSyncResult> {
    const capabilities = await this.getServerCapabilities();
    if (!capabilities.supported) {
      return {
        publishedKeyPackages: 0,
        uploadedGroupStates: 0,
        uploadedWelcomes: 0,
        uploadedCommits: 0,
        syncedKeyPackages: 0,
        syncedGroupStates: 0,
        syncedWelcomes: 0,
        syncedCommits: 0,
        acknowledgedWelcomes: 0,
        acknowledgedCommits: 0,
      };
    }

    // Publish key packages via bootstrapAccount (respects 5-min cooldown).
    await this.bootstrapAccount(userId);

    const account = await this.ensureAccountState(userId);
    const publishedKeyPackages = 0;

    // Short-circuit the heavy server sync if we synced recently.
    if (!force && account.lastSyncedAt) {
      const elapsed = Date.now() - Date.parse(account.lastSyncedAt);
      if (elapsed < SYNC_COOLDOWN_MS) {
        return {
          publishedKeyPackages,
          uploadedGroupStates: 0,
          uploadedWelcomes: 0,
          uploadedCommits: 0,
          syncedKeyPackages: 0,
          syncedGroupStates: 0,
          syncedWelcomes: 0,
          syncedCommits: 0,
          acknowledgedWelcomes: 0,
          acknowledgedCommits: 0,
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
    const impl = await getImpl();

    // Import durable group state snapshots before processing commits so a
    // new device can recover the current epoch even after welcomes were
    // already consumed elsewhere.
    for (const groupState of payload.groupStates) {
      await this.importSyncedGroupState(groupState, impl);
    }

    // Process incoming welcomes (join new groups)
    const acknowledgedWelcomes: MlsSyncWelcomeUpdate[] = [];
    for (const welcome of payload.welcomes) {
      try {
        const joined = await this.processIncomingWelcome(welcome, userId, impl);
        if (joined) acknowledgedWelcomes.push(welcome);
      } catch (err) {
        console.warn('[MLS] Welcome processing failed:', err);
      }
    }

    // Process incoming commits (advance epoch on existing groups)
    for (const commit of payload.commits) {
      try {
        await this.processIncomingCommit(commit, impl);
      } catch (err) {
        console.warn('[MLS] Commit processing failed:', err);
      }
    }

    // Acknowledge consumed welcomes in parallel
    let ackCount = 0;
    if (capabilities.welcomeInbox && acknowledgedWelcomes.length > 0) {
      const ackResults = await Promise.all(
        acknowledgedWelcomes.map(async (welcome) => {
          const ok = await consumeMlsWelcome(welcome.welcomeRef);
          if (ok) {
            await mlsStore.markWelcomeConsumed(welcome.userId, welcome.welcomeRef);
          }
          return ok;
        })
      );
      ackCount = ackResults.filter(Boolean).length;
    }

    const now = new Date().toISOString();
    await mlsStore.putAccountState({ ...account, lastSyncedAt: now, updatedAt: now });

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

  private async processIncomingWelcome(
    welcome: MlsSyncWelcomeUpdate,
    userId: string,
    impl: CiphersuiteImpl
  ): Promise<boolean> {
    const conversationId = welcome.conversationId;
    if (!conversationId) return false;

    const welcomeBytes = base64ToBytes(welcome.payload);
    const decoded = decodeMlsMessage(welcomeBytes, 0);
    if (!decoded) return false;
    const [msg] = decoded;
    if (msg.wireformat !== 'mls_welcome') return false;

    // Try each published+unconsumed key package until one matches the welcome
    const myKeyPackages = await mlsStore.listKeyPackages(userId);
    const candidates = myKeyPackages.filter((kp) => kp.publishedAt && !kp.consumedAt && kp.privateData);

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

        await this.persistGroupState(conversationId, joinedState, {
          source: 'welcome_join',
        });
        const result = await this.cacheDerivedGroupKey(conversationId, joinedState, impl, {
          aliasVersionOne: true,
        });
        await mlsStore.markKeyPackageConsumed(userId, kpRecord.packageRef);
        console.log('[MLS_WELCOME] processed welcome', {
          user_id: userId,
          conversation_id: conversationId,
          welcome_ref: welcome.welcomeRef,
          key_version: result.keyVersion,
        });
        return true;
      } catch {
        // Key package didn't match — try the next one
      }
    }

    console.warn('[MLS_WELCOME] no matching key package for welcome', {
      user_id: userId,
      conversation_id: conversationId,
      welcome_ref: welcome.welcomeRef,
    });
    return false;
  }

  private async processIncomingCommit(
    commit: MlsSyncCommitUpdate,
    impl: CiphersuiteImpl
  ): Promise<boolean> {
    const state = await loadGroupState(commit.conversationId);
    if (!state) return false;

    const commitBytes = base64ToBytes(commit.payload);
    const decoded = decodeMlsMessage(commitBytes, 0);
    if (!decoded) return false;
    const [msg] = decoded;

    let newState: ClientState;

    if (msg.wireformat === 'mls_private_message') {
      const result = await processPrivateMessage(state, msg.privateMessage, emptyPskIndex, impl, acceptAll);
      result.consumed.forEach(zeroOutUint8Array);
      if (result.kind !== 'newState') return false;
      newState = result.newState;
    } else if (msg.wireformat === 'mls_public_message') {
      const result = await processPublicMessage(state, msg.publicMessage, emptyPskIndex, impl, acceptAll);
      result.consumed.forEach(zeroOutUint8Array);
      newState = result.newState;
    } else {
      return false;
    }

    await this.persistGroupState(commit.conversationId, newState, {
      source: 'commit_apply',
    });
    const keyResult = await this.cacheDerivedGroupKey(commit.conversationId, newState, impl);
    await mlsStore.markCommitApplied(commit.conversationId, commit.commitRef);
    console.log('[MLS_COMMIT] applied commit', {
      conversation_id: commit.conversationId,
      commit_ref: commit.commitRef,
      key_version: keyResult.keyVersion,
    });

    return true;
  }
}

export const mlsService = new MlsService();
