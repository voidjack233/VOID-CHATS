import type { Conversation } from '../../Chat/chatService';

export interface MlsAccountStateRecord {
  userId: string;
  clientId: string;
  createdAt: string;
  updatedAt: string;
  lastBootstrappedAt?: string | null;
  lastSyncedAt?: string | null;
}

export interface MlsGroupStateRecord {
  conversationId: string;
  groupId: string;
  epoch: number;
  stateBlob: string;
  createdAt: string;
  updatedAt: string;
}

export interface MlsKeyPackageRecord {
  userId: string;
  packageRef: string;
  packageData: string;
  /** Base64-encoded JSON of the PrivateKeyPackage — never sent to server */
  privateData?: string | null;
  createdAt: string;
  publishedAt?: string | null;
  consumedAt?: string | null;
}

export interface MlsDistributeKeyResult {
  key: CryptoKey;
  keyVersion: number;
}

export interface MlsWelcomeRecord {
  userId: string;
  welcomeRef: string;
  payload: string;
  conversationId?: string | null;
  receivedAt: string;
  consumedAt?: string | null;
}

export interface MlsCommitRecord {
  conversationId: string;
  commitRef: string;
  payload: string;
  epoch?: number | null;
  receivedAt: string;
  appliedAt?: string | null;
}

export interface MlsConversationBootstrapInput {
  userId: string;
  conversation: Conversation;
  peerUserId?: string;
}

export interface MlsBootstrapResult {
  enabled: boolean;
  ready: boolean;
  mode: 'mls';
  reason?: string;
}

export interface MlsServerCapabilities {
  supported: boolean;
  keyPackages: boolean;
  groupState: boolean;
  commitFanout: boolean;
  welcomeInbox: boolean;
  reason?: string;
}

export interface MlsSyncKeyPackageUpdate {
  userId: string;
  packageRef: string;
  packageData?: string | null;
  publishedAt?: string | null;
  consumedAt?: string | null;
}

export interface MlsSyncGroupStateUpdate {
  conversationId: string;
  groupId: string;
  epoch: number;
  stateBlob: string;
  updatedAt?: string | null;
}

export interface MlsSyncWelcomeUpdate {
  userId: string;
  welcomeRef: string;
  payload: string;
  conversationId?: string | null;
  receivedAt?: string | null;
}

export interface MlsSyncCommitUpdate {
  conversationId: string;
  commitRef: string;
  payload: string;
  epoch?: number | null;
  receivedAt?: string | null;
}

export interface MlsUploadGroupStateInput {
  conversationId: string;
  groupId: string;
  epoch: number;
  stateBlob: string;
}

export interface MlsUploadWelcomeInput {
  userId: string;
  welcomeRef: string;
  payload: string;
  conversationId?: string | null;
}

export interface MlsUploadCommitInput {
  conversationId: string;
  commitRef: string;
  payload: string;
  epoch?: number | null;
}

export interface MlsInboxSyncPayload {
  keyPackages: MlsSyncKeyPackageUpdate[];
  groupStates: MlsSyncGroupStateUpdate[];
  welcomes: MlsSyncWelcomeUpdate[];
  commits: MlsSyncCommitUpdate[];
}

export interface MlsBackupData {
  version: 1;
  exportedAt: string;
  accounts: MlsAccountStateRecord[];
  groups: MlsGroupStateRecord[];
  keyPackages: MlsKeyPackageRecord[];
  groupKeys: Array<{ id: string; version: number; key: string }>;
}

export interface MlsInboxSyncResult {
  publishedKeyPackages: number;
  uploadedGroupStates: number;
  uploadedWelcomes: number;
  uploadedCommits: number;
  syncedKeyPackages: number;
  syncedGroupStates: number;
  syncedWelcomes: number;
  syncedCommits: number;
  acknowledgedWelcomes: number;
  acknowledgedCommits: number;
}
