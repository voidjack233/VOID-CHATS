import type { Proposal } from 'ts-mls';
import type { Conversation } from '../../Chat/chatService';

export const MLS_BOOTSTRAP_COOLDOWN_MS = 5 * 60 * 1000;
export const MLS_SYNC_COOLDOWN_MS = 30 * 1000;
export const MLS_ARCHIVE_SYNC_COOLDOWN_MS = 10 * 60 * 1000;
export const MLS_MINIMUM_KEY_PACKAGES = 3;
export const MLS_KEY_PACKAGE_TARGET = 10;
export const MLS_KEY_PACKAGE_LOW_WATERMARK = 3;
export const MLS_EXPORTER_LABEL = 'void-msg-key';

/** Server response from the non-consuming key-package availability check. */
export interface KeyPackageReserveStatus {
  available: boolean;
  availableCount: number;
  minimumRequired: number;
  targetRecommended: number;
}

export const MlsCipherSuites = {
  default: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
} as const;

export const MlsProtocolVersions = {
  current: 'mls10',
} as const;

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
  keyVersion?: number | null;
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
  claimableAt?: string | null;
  consumedAt?: string | null;
}

export interface MlsDistributeKeyResult {
  key: CryptoKey;
  keyVersion: number;
  includedMemberUserIds: string[];
  missingMemberUserIds: string[];
  membershipArtifacts?: MlsMembershipFinalizeArtifacts | null;
}

export interface MlsWelcomeRecord {
  userId: string;
  welcomeRef: string;
  payload: string;
  conversationId?: string | null;
  receivedAt: string;
  consumedAt?: string | null;
  failureCode?: 'no_matching_key_package' | null;
  failedAt?: string | null;
  attemptedKeyPackageRefs?: string[];
}

export type MlsWelcomeProcessResult =
  | { status: 'processed' }
  | { status: 'pending' }
  | {
      status: 'failed_no_matching_key_package';
      attemptedKeyPackageRefs: string[];
    };

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

export interface MlsDistributeGroupInput {
  userId: string;
  conversation: Conversation;
  memberUserIds: string[];
  allowFreshGroupBootstrap?: boolean;
  forceFreshGroupBootstrap?: boolean;
  forceReaddMemberUserIds?: string[];
  forceKeyVersionBump?: boolean;
  stageOnly?: boolean;
  _retried?: boolean;
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
  claimableAt?: string | null;
  consumedAt?: string | null;
}

export interface MlsSyncGroupStateUpdate {
  conversationId: string;
  groupId: string;
  epoch: number;
  keyVersion?: number | null;
  stateBlob: string;
  updatedAt?: string | null;
}

export interface MlsSyncWelcomeUpdate {
  userId: string;
  welcomeRef: string;
  payload: string;
  conversationId?: string | null;
  receivedAt?: string | null;
  keyVersion?: number | null;
  joinedKeyVersionFloor?: number | null;
}

export interface MlsSyncCommitUpdate {
  conversationId: string;
  commitRef: string;
  payload: string;
  epoch?: number | null;
  receivedAt?: string | null;
}

export interface MlsSyncArchivedKeyUpdate {
  conversationId: string;
  keyVersion: number;
  keyData: string;
}

export interface MlsUploadGroupStateInput {
  conversationId: string;
  groupId: string;
  epoch: number;
  keyVersion?: number | null;
  stateBlob: string;
}

export interface MlsUploadWelcomeInput {
  userId: string;
  welcomeRef: string;
  payload: string;
  conversationId?: string | null;
  keyVersion?: number | null;
}

export interface MlsUploadCommitInput {
  conversationId: string;
  commitRef: string;
  payload: string;
  epoch?: number | null;
}

export interface MlsMembershipFinalizeArtifacts {
  snapshot: MlsUploadGroupStateInput;
  welcomes: MlsUploadWelcomeInput[];
  commit?: MlsUploadCommitInput | null;
}

export interface MlsInboxSyncPayload {
  keyPackages: MlsSyncKeyPackageUpdate[];
  groupStates: MlsSyncGroupStateUpdate[];
  welcomes: MlsSyncWelcomeUpdate[];
  commits: MlsSyncCommitUpdate[];
  archivedKeys: MlsSyncArchivedKeyUpdate[];
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

export interface AddProposalBuildResult {
  proposals: Proposal[];
  addedUserIds: string[];
  missingUserIds: string[];
}

export interface PersistGroupStateOptions {
  source: string;
  upload?: boolean;
  keyVersion?: number | null;
}

export const EMPTY_MLS_SYNC_RESULT: MlsInboxSyncResult = {
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
