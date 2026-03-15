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
): Promise<MlsDistributeKeyResult> {
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
    keyBytes,
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

class MlsService {
  private serverCapabilitiesPromise: Promise<MlsServerCapabilities> | null = null;
  private readonly minimumKeyPackages = 3;

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
   * Fetch a peer's published key package from the server and build an MLS Add proposal.
   */
  private async buildAddProposals(userIds: string[]): Promise<Proposal[]> {
    const proposals: Proposal[] = [];
    for (const userId of userIds) {
      try {
        const kpData = await fetchUserKeyPackage(userId);
        if (!kpData) continue;
        const kpBytes = base64ToBytes(kpData.package_data);
        const decoded = decodeMlsMessage(kpBytes, 0);
        if (!decoded) continue;
        const [msg] = decoded;
        if (msg.wireformat !== 'mls_key_package') continue;
        proposals.push({ proposalType: 'add', add: { keyPackage: msg.keyPackage } });
      } catch {
        // Skip unavailable peers — they can be added later
      }
    }
    return proposals;
  }

  async bootstrapAccount(userId: string): Promise<void> {
    const capabilities = await this.getServerCapabilities();
    if (!capabilities.supported) return;
    await this.ensureAccountState(userId);
    if (capabilities.keyPackages) {
      await this.ensureLocalKeyPackages(userId);
      await this.publishPendingKeyPackages(userId);
    }
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
  }): Promise<MlsDistributeKeyResult> {
    await this.bootstrapAccount(input.userId);

    const capabilities = await this.getServerCapabilities();
    const conversationId = normalizeConversationKeyId(input.conversation);
    const impl = await getImpl();
    const desiredMembers = [...new Set([...input.memberUserIds, input.userId].filter(Boolean))];
    const otherMembers = desiredMembers.filter((id) => id !== input.userId);

    const existingState = await loadGroupState(conversationId);
    let newState: ClientState;
    let welcomePayload: string | null = null;
    let commitPayload: string | null = null;
    let newMembersForWelcome: string[] = [];
    let existingPeers: string[] = [];

    if (!existingState) {
      // ── Create new MLS group ──────────────────────────────────────────────────
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

      if (otherMembers.length > 0) {
        const addProposals = await this.buildAddProposals(otherMembers);
        if (addProposals.length > 0) {
          const commitResult = await createCommit(
            { state, cipherSuite: impl },
            { extraProposals: addProposals, ratchetTreeExtension: true }
          );
          commitResult.consumed.forEach(zeroOutUint8Array);
          state = commitResult.newState;
          if (commitResult.welcome) {
            welcomePayload = bytesToBase64(
              encodeMlsMessage({ welcome: commitResult.welcome, wireformat: 'mls_welcome', version: 'mls10' })
            );
          }
          commitPayload = bytesToBase64(encodeMlsMessage(commitResult.commit));
          newMembersForWelcome = otherMembers;
        }
      }

      newState = state;

      // Clean up ephemeral key package private keys
      zeroOutUint8Array(myKp.privatePackage.initPrivateKey);
      zeroOutUint8Array(myKp.privatePackage.hpkePrivateKey);
      zeroOutUint8Array(myKp.privatePackage.signaturePrivateKey);
    } else {
      // ── Update existing group (add/remove members, advance epoch) ─────────────
      const currentMembers = getMemberUserIds(existingState);
      const toAdd = desiredMembers.filter((id) => !currentMembers.includes(id));
      const toRemove = currentMembers.filter((id) => !desiredMembers.includes(id));

      const proposals: Proposal[] = [];

      if (toAdd.length > 0) {
        const addProposals = await this.buildAddProposals(toAdd);
        proposals.push(...addProposals);
        newMembersForWelcome = toAdd;
      }

      for (const removeId of toRemove) {
        const leafIdx = findLeafIndex(existingState, removeId);
        if (leafIdx !== null) {
          proposals.push({ proposalType: 'remove', remove: { removed: leafIdx } });
        }
      }

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
    }

    // ── Persist new group state (local IndexedDB only — contains private keys) ──
    await saveGroupState(conversationId, newState);

    // ── Send welcome messages to new members ──────────────────────────────────
    if (capabilities.welcomeInbox && welcomePayload && newMembersForWelcome.length > 0) {
      const welcomeRef = crypto.randomUUID();
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
      await ingestMlsCommits([{
        conversationId,
        commitRef: crypto.randomUUID(),
        payload: commitPayload,
        epoch: Number(newState.groupContext.epoch) - 1,
      }]);
    }

    // ── Derive AES-256-GCM key from MLS epoch exporter ─────────────────────────
    const result = await deriveGroupAesKey(newState, conversationId, impl);
    await keyManager.storeGroupKey(conversationId, result.keyVersion, result.key);

    return result;
  }

  async syncInbox(userId: string): Promise<MlsInboxSyncResult> {
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

    const account = await this.ensureAccountState(userId);
    let publishedKeyPackages = 0;

    if (capabilities.keyPackages) {
      await this.ensureLocalKeyPackages(userId);
      publishedKeyPackages = await this.publishPendingKeyPackages(userId);
    }

    const payload = await syncMlsInbox(userId);
    const impl = await getImpl();

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

    // Acknowledge consumed welcomes on the server
    let ackCount = 0;
    if (capabilities.welcomeInbox) {
      for (const welcome of acknowledgedWelcomes) {
        const ok = await consumeMlsWelcome(welcome.welcomeRef);
        if (ok) {
          await mlsStore.markWelcomeConsumed(welcome.userId, welcome.welcomeRef);
          ackCount += 1;
        }
      }
    }

    await mlsStore.putAccountState({ ...account, updatedAt: new Date().toISOString() });

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

        await saveGroupState(conversationId, joinedState);
        const result = await deriveGroupAesKey(joinedState, conversationId, impl);
        await keyManager.storeGroupKey(conversationId, result.keyVersion, result.key);
        await mlsStore.markKeyPackageConsumed(userId, kpRecord.packageRef);
        return true;
      } catch {
        // Key package didn't match — try the next one
      }
    }

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

    await saveGroupState(commit.conversationId, newState);
    const keyResult = await deriveGroupAesKey(newState, commit.conversationId, impl);
    await keyManager.storeGroupKey(commit.conversationId, keyResult.keyVersion, keyResult.key);
    await mlsStore.markCommitApplied(commit.conversationId, commit.commitRef);

    return true;
  }
}

export const mlsService = new MlsService();
