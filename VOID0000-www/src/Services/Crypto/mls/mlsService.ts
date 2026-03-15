import type { Conversation } from '../../Chat/chatService';
import { keyManager } from '../keyManager';
import {
  consumeMlsWelcome,
  fetchMlsCapabilities,
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
  MlsInboxSyncPayload,
  MlsInboxSyncResult,
  MlsServerCapabilities,
  MlsSyncCommitUpdate,
  MlsSyncWelcomeUpdate,
} from './mlsTypes';

function normalizeConversationKeyId(conversation: Conversation): string {
  return conversation.parent_conversation_id || conversation.id;
}

interface MlsGroupSenderKeyCommitPayload {
  version: number;
  kind: 'group_sender_key';
  conversation_id: string;
  key_version: number;
  group_key: string;
  sender_user_id: string;
  member_user_ids: string[];
  sent_at: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

class MlsService {
  private serverCapabilitiesPromise: Promise<MlsServerCapabilities> | null = null;
  private readonly minimumUnpublishedKeyPackages = 1;

  isEnabled(): boolean {
    return true;
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

  isMlsMessageType(messageType: string | null | undefined): boolean {
    return messageType === 'mls_application';
  }

  private async ensureAccountState(userId: string): Promise<MlsAccountStateRecord> {
    const existing = await mlsStore.getAccountState(userId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const created: MlsAccountStateRecord = {
      userId,
      clientId: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    await mlsStore.putAccountState(created);
    return created;
  }

  private buildPlaceholderKeyPackageData(userId: string, clientId: string, packageRef: string): string {
    return JSON.stringify({
      version: 1,
      source: 'mls_placeholder',
      user_id: userId,
      client_id: clientId,
      package_ref: packageRef,
      generated_at: new Date().toISOString(),
    });
  }

  private async ensureLocalKeyPackages(userId: string, clientId: string): Promise<void> {
    const unpublished = await mlsStore.listUnpublishedKeyPackages(userId);
    if (unpublished.length >= this.minimumUnpublishedKeyPackages) {
      return;
    }

    const missing = this.minimumUnpublishedKeyPackages - unpublished.length;
    const now = new Date().toISOString();
    await Promise.all(Array.from({ length: missing }).map(async () => {
      const packageRef = crypto.randomUUID();
      await mlsStore.putKeyPackage({
        userId,
        packageRef,
        packageData: this.buildPlaceholderKeyPackageData(userId, clientId, packageRef),
        createdAt: now,
      });
    }));
  }

  private async publishPendingKeyPackages(userId: string): Promise<number> {
    const unpublished = await mlsStore.listUnpublishedKeyPackages(userId);
    let publishedCount = 0;

    for (const record of unpublished) {
      const published = await publishMlsKeyPackage({
        userId: record.userId,
        packageRef: record.packageRef,
        packageData: record.packageData,
      });

      if (published) {
        await mlsStore.markKeyPackagePublished(record.userId, record.packageRef);
        publishedCount += 1;
      }
    }

    return publishedCount;
  }

  private async uploadLocalGroupStates(): Promise<number> {
    const groupStates = await mlsStore.listGroupStates();
    if (groupStates.length === 0) return 0;

    return upsertMlsGroupStates(groupStates.map((groupState) => ({
      conversationId: groupState.conversationId,
      groupId: groupState.groupId,
      epoch: groupState.epoch,
      stateBlob: groupState.stateBlob,
    })));
  }

  private async uploadLocalWelcomes(userId: string): Promise<number> {
    const welcomes = await mlsStore.listUnconsumedWelcomes(userId);
    if (welcomes.length === 0) return 0;

    return ingestMlsWelcomes(welcomes.map((welcome) => ({
      userId: welcome.userId,
      welcomeRef: welcome.welcomeRef,
      payload: welcome.payload,
      conversationId: welcome.conversationId || null,
    })));
  }

  private parseGroupSenderKeyCommitPayload(payload: string): MlsGroupSenderKeyCommitPayload | null {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return null;
      if (parsed.kind !== 'group_sender_key') return null;

      const conversationId = typeof parsed.conversation_id === 'string'
        ? parsed.conversation_id
        : null;
      const keyVersion = typeof parsed.key_version === 'number'
        ? parsed.key_version
        : Number(parsed.key_version);
      const groupKey = typeof parsed.group_key === 'string'
        ? parsed.group_key
        : null;
      const senderUserId = typeof parsed.sender_user_id === 'string'
        ? parsed.sender_user_id
        : null;
      const sentAt = typeof parsed.sent_at === 'string'
        ? parsed.sent_at
        : null;

      const memberUserIds = Array.isArray(parsed.member_user_ids)
        ? parsed.member_user_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];

      if (!conversationId || !Number.isInteger(keyVersion) || keyVersion <= 0 || !groupKey || !senderUserId || !sentAt) {
        return null;
      }

      return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        kind: 'group_sender_key',
        conversation_id: conversationId,
        key_version: keyVersion,
        group_key: groupKey,
        sender_user_id: senderUserId,
        member_user_ids: memberUserIds,
        sent_at: sentAt,
      };
    } catch {
      return null;
    }
  }

  private buildGroupStateBlob(input: {
    conversationId: string;
    keyVersion: number;
    senderUserId: string;
    memberUserIds: string[];
    commitRef: string;
    generatedAt: string;
  }): string {
    return JSON.stringify({
      version: 1,
      source: 'mls_group_sender_key_commit',
      conversation_id: input.conversationId,
      group_id: input.conversationId,
      epoch: input.keyVersion,
      sender_user_id: input.senderUserId,
      member_user_ids: input.memberUserIds,
      last_commit_ref: input.commitRef,
      generated_at: input.generatedAt,
    });
  }

  private async applyGroupSenderKeyCommit(commit: MlsSyncCommitUpdate): Promise<boolean> {
    const parsed = this.parseGroupSenderKeyCommitPayload(commit.payload);
    if (!parsed) return false;
    if (parsed.conversation_id !== commit.conversationId) return false;

    try {
      const rawKey = base64ToArrayBuffer(parsed.group_key);
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        rawKey,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );

      await keyManager.storeGroupKey(parsed.conversation_id, parsed.key_version, cryptoKey);

      await mlsStore.putGroupState({
        conversationId: parsed.conversation_id,
        groupId: parsed.conversation_id,
        epoch: parsed.key_version,
        stateBlob: this.buildGroupStateBlob({
          conversationId: parsed.conversation_id,
          keyVersion: parsed.key_version,
          senderUserId: parsed.sender_user_id,
          memberUserIds: parsed.member_user_ids,
          commitRef: commit.commitRef,
          generatedAt: parsed.sent_at,
        }),
        createdAt: parsed.sent_at,
        updatedAt: parsed.sent_at,
      });

      await mlsStore.markCommitApplied(commit.conversationId, commit.commitRef);
      return true;
    } catch (err) {
      console.warn('MLS group sender-key commit apply failed:', err);
      return false;
    }
  }

  private async uploadLocalCommits(userId: string): Promise<number> {
    const commits = (await mlsStore.listUnappliedCommits()).filter((commit) => {
      const parsed = this.parseGroupSenderKeyCommitPayload(commit.payload);
      return parsed?.sender_user_id === userId;
    });
    if (commits.length === 0) return 0;

    const uploaded = await ingestMlsCommits(commits.map((commit) => ({
      conversationId: commit.conversationId,
      commitRef: commit.commitRef,
      payload: commit.payload,
      epoch: commit.epoch ?? null,
    })));

    if (uploaded > 0) {
      await Promise.all(commits.map((commit) =>
        mlsStore.markCommitApplied(commit.conversationId, commit.commitRef)
      ));
    }

    return uploaded;
  }

  private async applySyncPayload(payload: MlsInboxSyncPayload): Promise<Omit<MlsInboxSyncResult, 'publishedKeyPackages' | 'uploadedGroupStates' | 'uploadedWelcomes' | 'uploadedCommits' | 'acknowledgedWelcomes' | 'acknowledgedCommits'>> {
    const now = new Date().toISOString();

    await Promise.all(payload.keyPackages.map(async (update) => {
      const fallbackData = JSON.stringify({
        version: 1,
        source: 'mls_sync',
        user_id: update.userId,
        package_ref: update.packageRef,
      });

      await mlsStore.putKeyPackage({
        userId: update.userId,
        packageRef: update.packageRef,
        packageData: update.packageData || fallbackData,
        createdAt: update.publishedAt || update.consumedAt || now,
        publishedAt: update.publishedAt || null,
        consumedAt: update.consumedAt || null,
      });
    }));

    await Promise.all(payload.groupStates.map(async (groupState) => {
      await mlsStore.putGroupState({
        conversationId: groupState.conversationId,
        groupId: groupState.groupId,
        epoch: groupState.epoch,
        stateBlob: groupState.stateBlob,
        createdAt: groupState.updatedAt || now,
        updatedAt: groupState.updatedAt || now,
      });
    }));

    await Promise.all(payload.welcomes.map(async (welcome) => {
      await mlsStore.putWelcome({
        userId: welcome.userId,
        welcomeRef: welcome.welcomeRef,
        payload: welcome.payload,
        conversationId: welcome.conversationId || null,
        receivedAt: welcome.receivedAt || now,
      });
    }));

    await Promise.all(payload.commits.map(async (commit) => {
      await mlsStore.putCommit({
        conversationId: commit.conversationId,
        commitRef: commit.commitRef,
        payload: commit.payload,
        epoch: commit.epoch ?? null,
        receivedAt: commit.receivedAt || now,
      });
    }));

    await Promise.all(payload.commits.map(async (commit) => {
      await this.applyGroupSenderKeyCommit(commit);
    }));

    return {
      syncedKeyPackages: payload.keyPackages.length,
      syncedGroupStates: payload.groupStates.length,
      syncedWelcomes: payload.welcomes.length,
      syncedCommits: payload.commits.length,
    };
  }

  private async acknowledgeSyncedWelcomes(welcomes: MlsSyncWelcomeUpdate[]): Promise<number> {
    let acknowledged = 0;

    for (const welcome of welcomes) {
      const ok = await consumeMlsWelcome(welcome.welcomeRef);
      if (!ok) continue;

      await mlsStore.markWelcomeConsumed(welcome.userId, welcome.welcomeRef);
      acknowledged += 1;
    }

    return acknowledged;
  }

  private async acknowledgeSyncedCommits(commits: MlsSyncCommitUpdate[]): Promise<number> {
    // The current backend commit "apply" flag is global per conversation commit row.
    // Client-side commit apply acknowledgements are intentionally skipped so one
    // member does not hide pending commit fanout for every other member.
    void commits;
    return 0;
  }

  async distributeGroupSenderKey(input: {
    userId: string;
    conversation: Conversation;
    memberUserIds: string[];
    keyVersion: number;
    groupKey: CryptoKey;
  }): Promise<void> {
    const capabilities = await this.getServerCapabilities();
    if (!capabilities.supported) return;

    await this.bootstrapAccount(input.userId);

    const conversationId = normalizeConversationKeyId(input.conversation);
    const keyVersion = Number.isInteger(input.keyVersion) && input.keyVersion > 0
      ? input.keyVersion
      : 1;
    const now = new Date().toISOString();
    const memberUserIds = Array.from(
      new Set([...input.memberUserIds, input.userId].filter(Boolean))
    );
    const commitRef = crypto.randomUUID();

    const rawGroupKey = await crypto.subtle.exportKey('raw', input.groupKey);
    const commitPayload: MlsGroupSenderKeyCommitPayload = {
      version: 1,
      kind: 'group_sender_key',
      conversation_id: conversationId,
      key_version: keyVersion,
      group_key: arrayBufferToBase64(rawGroupKey),
      sender_user_id: input.userId,
      member_user_ids: memberUserIds,
      sent_at: now,
    };

    await mlsStore.putGroupState({
      conversationId,
      groupId: conversationId,
      epoch: keyVersion,
      stateBlob: this.buildGroupStateBlob({
        conversationId,
        keyVersion,
        senderUserId: input.userId,
        memberUserIds,
        commitRef,
        generatedAt: now,
      }),
      createdAt: now,
      updatedAt: now,
    });

    await mlsStore.putCommit({
      conversationId,
      commitRef,
      payload: JSON.stringify(commitPayload),
      epoch: keyVersion,
      receivedAt: now,
    });

    if (capabilities.groupState) {
      await upsertMlsGroupStates([{
        conversationId,
        groupId: conversationId,
        epoch: keyVersion,
        stateBlob: this.buildGroupStateBlob({
          conversationId,
          keyVersion,
          senderUserId: input.userId,
          memberUserIds,
          commitRef,
          generatedAt: now,
        }),
      }]);
    }

    if (capabilities.commitFanout) {
      const uploadedCommits = await ingestMlsCommits([{
        conversationId,
        commitRef,
        payload: JSON.stringify(commitPayload),
        epoch: keyVersion,
      }]);

      if (uploadedCommits > 0) {
        await mlsStore.markCommitApplied(conversationId, commitRef);
      }
    }
  }

  async bootstrapAccount(userId: string): Promise<void> {
    const capabilities = await this.getServerCapabilities();
    if (!capabilities.supported) return;

    const account = await this.ensureAccountState(userId);
    if (capabilities.keyPackages) {
      await this.ensureLocalKeyPackages(userId, account.clientId);
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

    if (input.conversation.type === 'dm') {
      return {
        enabled: true,
        ready: false,
        mode: 'mls',
        reason: 'mls_dm_not_implemented',
      };
    }

    const keyConversationId = normalizeConversationKeyId(input.conversation);
    const groupState = await mlsStore.getGroupState(keyConversationId);

    if (!groupState) {
      return {
        enabled: true,
        ready: false,
        mode: 'mls',
        reason: 'mls_group_state_missing',
      };
    }

    return {
      enabled: true,
      ready: true,
      mode: 'mls',
    };
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
    let uploadedGroupStates = 0;
    let uploadedWelcomes = 0;
    let uploadedCommits = 0;

    if (capabilities.keyPackages) {
      await this.ensureLocalKeyPackages(userId, account.clientId);
      publishedKeyPackages = await this.publishPendingKeyPackages(userId);
    }

    if (capabilities.groupState) {
      uploadedGroupStates = await this.uploadLocalGroupStates();
    }

    if (capabilities.welcomeInbox) {
      uploadedWelcomes = await this.uploadLocalWelcomes(userId);
    }

    if (capabilities.commitFanout) {
      uploadedCommits = await this.uploadLocalCommits(userId);
    }

    const payload = await syncMlsInbox(userId);
    const synced = await this.applySyncPayload(payload);

    let acknowledgedWelcomes = 0;
    let acknowledgedCommits = 0;

    if (capabilities.welcomeInbox) {
      acknowledgedWelcomes = await this.acknowledgeSyncedWelcomes(payload.welcomes);
    }

    if (capabilities.commitFanout) {
      acknowledgedCommits = await this.acknowledgeSyncedCommits(payload.commits);
    }

    await mlsStore.putAccountState({
      ...account,
      updatedAt: new Date().toISOString(),
    });

    return {
      publishedKeyPackages,
      uploadedGroupStates,
      uploadedWelcomes,
      uploadedCommits,
      ...synced,
      acknowledgedWelcomes,
      acknowledgedCommits,
    };
  }
}

export const mlsService = new MlsService();
