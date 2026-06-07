import { fetchWithAuth } from '../../Auth/authServiceApi';
import {
  MLS_KEY_PACKAGE_TARGET,
  MLS_MINIMUM_KEY_PACKAGES,
  type KeyPackageReserveStatus,
  type MlsInboxSyncPayload,
  type MlsServerCapabilities,
  type MlsSyncArchivedKeyUpdate,
  type MlsSyncCommitUpdate,
  type MlsSyncGroupStateUpdate,
  type MlsSyncKeyPackageUpdate,
  type MlsSyncWelcomeUpdate,
  type MlsUploadCommitInput,
  type MlsUploadGroupStateInput,
  type MlsUploadWelcomeInput,
} from './mlsTypes';

const MLS_API_PREFIX = '/api/conversations/mls';

interface MlsApiEnvelope<T> {
  success?: boolean;
  error?: string;
  message?: string;
  data?: T;
  capabilities?: T;
}

interface PublishKeyPackageInput {
  userId: string;
  packageRef: string;
  packageData: string;
}

interface MlsBatchEnvelope<T> {
  items?: T[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function normalizeCapabilityBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function pickCapability(raw: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (key in raw) {
      return normalizeCapabilityBoolean(raw[key]);
    }
  }
  return false;
}

async function parseJsonSafe(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pickEnvelopeData<T>(payload: MlsApiEnvelope<T> | null): unknown {
  if (!payload) return null;
  return payload.data ?? payload.capabilities ?? payload;
}

function resolveBatchCount(payload: MlsApiEnvelope<unknown> | null): number {
  const data = pickEnvelopeData(payload);
  if (!data || typeof data !== 'object') return 0;
  const maybeItems = (data as MlsBatchEnvelope<unknown>).items;
  if (!Array.isArray(maybeItems)) return 0;
  return maybeItems.length;
}

function normalizeCapabilities(raw: unknown): MlsServerCapabilities {
  if (!raw || typeof raw !== 'object') {
    return {
      supported: false,
      keyPackages: false,
      groupState: false,
      commitFanout: false,
      welcomeInbox: false,
      reason: 'invalid_capabilities_payload',
    };
  }

  const source = raw as Record<string, unknown>;
  return {
    supported: pickCapability(source, ['supported', 'mls_supported', 'mls_enabled']),
    keyPackages: pickCapability(source, ['key_packages', 'keyPackages']),
    groupState: pickCapability(source, ['group_state', 'groupState']),
    commitFanout: pickCapability(source, ['commit_fanout', 'commitFanout']),
    welcomeInbox: pickCapability(source, ['welcome_inbox', 'welcomeInbox']),
  };
}

export async function fetchMlsCapabilities(): Promise<MlsServerCapabilities> {
  const response = await fetchWithAuth(`${MLS_API_PREFIX}/capabilities`, { cache: 'no-store' });

  if (response.status === 404) {
    return {
      supported: false,
      keyPackages: false,
      groupState: false,
      commitFanout: false,
      welcomeInbox: false,
      reason: 'capabilities_endpoint_not_found',
    };
  }

  if (!response.ok) {
    return {
      supported: false,
      keyPackages: false,
      groupState: false,
      commitFanout: false,
      welcomeInbox: false,
      reason: `capabilities_http_${response.status}`,
    };
  }

  const payload = (await parseJsonSafe(response)) as MlsApiEnvelope<unknown> | null;
  if (!payload) {
    return {
      supported: false,
      keyPackages: false,
      groupState: false,
      commitFanout: false,
      welcomeInbox: false,
      reason: 'capabilities_payload_empty',
    };
  }

  const candidate = (payload.capabilities || payload.data || payload) as unknown;
  const normalized = normalizeCapabilities(candidate);
  if (!normalized.supported && !normalized.reason) {
    normalized.reason = 'capabilities_mls_not_enabled';
  }
  return normalized;
}

export async function fetchKeyPackageReserveStatus(
  userId: string,
): Promise<KeyPackageReserveStatus | null> {
  try {
    const response = await fetchWithAuth(
      `${MLS_API_PREFIX}/key-packages/${encodeURIComponent(userId)}/check`,
    );
    if (!response.ok) return null;
    const payload = (await parseJsonSafe(response)) as MlsApiEnvelope<unknown> | null;
    const data = asObject(pickEnvelopeData(payload));
    if (!data) return null;

    return {
      available: data.available === true,
      availableCount: typeof data.availableCount === 'number' ? data.availableCount : (data.available ? 1 : 0),
      minimumRequired: typeof data.minimumRequired === 'number' ? data.minimumRequired : MLS_MINIMUM_KEY_PACKAGES,
      targetRecommended: typeof data.targetRecommended === 'number' ? data.targetRecommended : MLS_KEY_PACKAGE_TARGET,
    };
  } catch {
    return null;
  }
}

/** Backward-compatible boolean check — delegates to fetchKeyPackageReserveStatus. */
export async function checkKeyPackageAvailability(userId: string): Promise<boolean> {
  const status = await fetchKeyPackageReserveStatus(userId);
  return status?.available === true;
}

export async function fetchUserKeyPackage(
  userId: string
): Promise<{ package_ref: string; package_data: string } | null> {
  const response = await fetchWithAuth(
    `${MLS_API_PREFIX}/key-packages/${encodeURIComponent(userId)}`
  );

  if (response.status === 404 || !response.ok) return null;

  const payload = (await parseJsonSafe(response)) as MlsApiEnvelope<unknown> | null;
  const data = asObject(pickEnvelopeData(payload));
  if (!data) return null;

  const packageRef = pickString(data, ['package_ref', 'packageRef']);
  const packageData = pickString(data, ['package_data', 'packageData']);
  if (!packageRef || !packageData) return null;

  return { package_ref: packageRef, package_data: packageData };
}

export async function publishMlsKeyPackage(input: PublishKeyPackageInput): Promise<boolean> {
  const response = await fetchWithAuth(`${MLS_API_PREFIX}/key-packages`, {
    method: 'POST',
    body: JSON.stringify({
      user_id: input.userId,
      package_ref: input.packageRef,
      package_data: input.packageData,
    }),
  });

  if (response.status === 404 || !response.ok) {
    return false;
  }

  const payload = (await parseJsonSafe(response)) as MlsApiEnvelope<unknown> | null;
  if (!payload) return true;
  if (payload.success === false) return false;
  return true;
}

export async function upsertMlsGroupStates(items: MlsUploadGroupStateInput[]): Promise<number> {
  if (items.length === 0) return 0;

  const response = await fetchWithAuth(`${MLS_API_PREFIX}/group-states`, {
    method: 'POST',
    body: JSON.stringify({
      items: items.map((item) => ({
        conversation_id: item.conversationId,
        group_id: item.groupId,
        epoch: item.epoch,
        ...(item.keyVersion != null ? { key_version: item.keyVersion } : {}),
        state_blob: item.stateBlob,
      })),
    }),
  });

  if (response.status === 404 || !response.ok) {
    return 0;
  }

  const payload = (await parseJsonSafe(response)) as MlsApiEnvelope<unknown> | null;
  if (!payload) return items.length;
  if (payload.success === false) return 0;
  const count = resolveBatchCount(payload);
  return count > 0 ? count : items.length;
}

export async function ingestMlsWelcomes(items: MlsUploadWelcomeInput[]): Promise<number> {
  if (items.length === 0) return 0;

  const response = await fetchWithAuth(`${MLS_API_PREFIX}/welcomes`, {
    method: 'POST',
    body: JSON.stringify({
      items: items.map((item) => ({
        user_id: item.userId,
        welcome_ref: item.welcomeRef,
        payload: item.payload,
        ...(item.conversationId ? { conversation_id: item.conversationId } : {}),
        ...(item.keyVersion != null ? { key_version: item.keyVersion } : {}),
      })),
    }),
  });

  if (response.status === 404 || !response.ok) {
    console.error('[MLS_WELCOME_UPLOAD] welcome ingest failed', {
      status: response.status,
      recipient_count: items.length,
      conversation_id: items[0]?.conversationId ?? null,
    });
    throw new Error(`Welcome upload failed (HTTP ${response.status})`);
  }

  const payload = (await parseJsonSafe(response)) as MlsApiEnvelope<unknown> | null;
  if (!payload) return items.length;
  if (payload.success === false) {
    console.error('[MLS_WELCOME_UPLOAD] welcome ingest rejected by server', {
      recipient_count: items.length,
      conversation_id: items[0]?.conversationId ?? null,
    });
    throw new Error('Welcome upload rejected by server');
  }
  const count = resolveBatchCount(payload);
  return count > 0 ? count : items.length;
}

export async function ingestMlsCommits(items: MlsUploadCommitInput[]): Promise<number> {
  if (items.length === 0) return 0;

  const response = await fetchWithAuth(`${MLS_API_PREFIX}/commits`, {
    method: 'POST',
    body: JSON.stringify({
      items: items.map((item) => ({
        conversation_id: item.conversationId,
        commit_ref: item.commitRef,
        payload: item.payload,
        ...(item.epoch != null ? { epoch: item.epoch } : {}),
      })),
    }),
  });

  if (response.status === 404 || !response.ok) {
    return 0;
  }

  const payload = (await parseJsonSafe(response)) as MlsApiEnvelope<unknown> | null;
  if (!payload) return items.length;
  if (payload.success === false) return 0;
  const count = resolveBatchCount(payload);
  return count > 0 ? count : items.length;
}

export async function consumeMlsWelcome(welcomeRef: string): Promise<boolean> {
  const response = await fetchWithAuth(
    `${MLS_API_PREFIX}/welcomes/${encodeURIComponent(welcomeRef)}/consume`,
    { method: 'POST', body: JSON.stringify({}) }
  );

  if (response.status === 404 || !response.ok) {
    return false;
  }

  const payload = (await parseJsonSafe(response)) as MlsApiEnvelope<unknown> | null;
  if (!payload) return true;
  if (payload.success === false) return false;
  return true;
}

export async function applyMlsCommit(conversationId: string, commitRef: string): Promise<boolean> {
  const response = await fetchWithAuth(
    `${MLS_API_PREFIX}/commits/${encodeURIComponent(conversationId)}/${encodeURIComponent(commitRef)}/apply`,
    { method: 'POST', body: JSON.stringify({}) }
  );

  if (response.status === 404 || !response.ok) {
    return false;
  }

  const payload = (await parseJsonSafe(response)) as MlsApiEnvelope<unknown> | null;
  if (!payload) return true;
  if (payload.success === false) return false;
  return true;
}

export async function archiveGroupKeys(
  items: Array<{ conversationId: string; keyVersion: number; keyData: string; replaceExisting?: boolean }>,
): Promise<number> {
  if (items.length === 0) return 0;

  const response = await fetchWithAuth(`${MLS_API_PREFIX}/group-key-archive`, {
    method: 'POST',
    body: JSON.stringify({
      items: items.map((item) => ({
        conversation_id: item.conversationId,
        key_version: item.keyVersion,
        key_data: item.keyData,
        ...(item.replaceExisting ? { replace_existing: true } : {}),
      })),
    }),
  });

  if (response.status === 404 || !response.ok) {
    return 0;
  }

  const payload = (await parseJsonSafe(response)) as MlsApiEnvelope<unknown> | null;
  if (!payload) return items.length;
  if (payload.success === false) return 0;
  const count = resolveBatchCount(payload);
  return count > 0 ? count : items.length;
}

function normalizeSyncKeyPackageUpdates(raw: unknown, userId: string): MlsSyncKeyPackageUpdate[] {
  return asArray(raw).flatMap((entry) => {
    const obj = asObject(entry);
    if (!obj) return [];
    const packageRef = pickString(obj, ['package_ref', 'packageRef', 'ref']);
    if (!packageRef) return [];
    const packageData = pickString(obj, ['package_data', 'packageData', 'data']);
    const publishedAt = pickString(obj, ['published_at', 'publishedAt']);
    const claimableAt = pickString(obj, ['claimable_at', 'claimableAt']);
    const consumedAt = pickString(obj, ['consumed_at', 'consumedAt']);
    const rowUserId = pickString(obj, ['user_id', 'userId']) || userId;
    return [{
      userId: rowUserId,
      packageRef,
      packageData,
      publishedAt,
      claimableAt,
      consumedAt,
    }];
  });
}

function normalizeSyncGroupStates(raw: unknown): MlsSyncGroupStateUpdate[] {
  return asArray(raw).flatMap((entry) => {
    const obj = asObject(entry);
    if (!obj) return [];
    const conversationId = pickString(obj, ['conversation_id', 'conversationId']);
    const groupId = pickString(obj, ['group_id', 'groupId']);
    const stateBlob = pickString(obj, ['state_blob', 'stateBlob']);
    const epoch = pickNumber(obj, ['epoch']);
    if (!conversationId || !groupId || !stateBlob || epoch == null) return [];
    const keyVersion = pickNumber(obj, ['key_version', 'keyVersion']);
    const updatedAt = pickString(obj, ['updated_at', 'updatedAt']);
    return [{
      conversationId,
      groupId,
      epoch,
      keyVersion,
      stateBlob,
      updatedAt,
    }];
  });
}

function normalizeSyncWelcomes(raw: unknown, userId: string): MlsSyncWelcomeUpdate[] {
  return asArray(raw).flatMap((entry) => {
    const obj = asObject(entry);
    if (!obj) return [];
    const welcomeRef = pickString(obj, ['welcome_ref', 'welcomeRef', 'ref']);
    const payload = pickString(obj, ['payload', 'welcome', 'data']);
    if (!welcomeRef || !payload) return [];
    const conversationId = pickString(obj, ['conversation_id', 'conversationId']);
    const receivedAt = pickString(obj, ['received_at', 'receivedAt']);
    const keyVersion = pickNumber(obj, ['key_version', 'keyVersion']);
    const joinedKeyVersionFloor = pickNumber(obj, [
      'joined_key_version_floor',
      'joinedKeyVersionFloor',
      'joined_key_version',
      'joinedKeyVersion',
    ]);
    const rowUserId = pickString(obj, ['user_id', 'userId']) || userId;
    return [{
      userId: rowUserId,
      welcomeRef,
      payload,
      conversationId,
      receivedAt,
      keyVersion,
      joinedKeyVersionFloor,
    }];
  });
}

function normalizeSyncCommits(raw: unknown): MlsSyncCommitUpdate[] {
  return asArray(raw).flatMap((entry) => {
    const obj = asObject(entry);
    if (!obj) return [];
    const conversationId = pickString(obj, ['conversation_id', 'conversationId']);
    const commitRef = pickString(obj, ['commit_ref', 'commitRef', 'ref']);
    const payload = pickString(obj, ['payload', 'commit', 'data']);
    if (!conversationId || !commitRef || !payload) return [];
    const epoch = pickNumber(obj, ['epoch']);
    const receivedAt = pickString(obj, ['received_at', 'receivedAt']);
    return [{
      conversationId,
      commitRef,
      payload,
      epoch,
      receivedAt,
    }];
  });
}

function normalizeSyncArchivedKeys(raw: unknown): MlsSyncArchivedKeyUpdate[] {
  return asArray(raw).flatMap((entry) => {
    const obj = asObject(entry);
    if (!obj) return [];
    const conversationId = pickString(obj, ['conversation_id', 'conversationId']);
    const keyData = pickString(obj, ['key_data', 'keyData']);
    const keyVersion = pickNumber(obj, ['key_version', 'keyVersion']);
    if (!conversationId || !keyData || keyVersion == null || keyVersion < 1) return [];
    return [{ conversationId, keyVersion, keyData }];
  });
}

function emptySyncPayload(): MlsInboxSyncPayload {
  return {
    keyPackages: [],
    groupStates: [],
    welcomes: [],
    commits: [],
    archivedKeys: [],
  };
}

function normalizeInboxSyncPayload(raw: unknown, userId: string): MlsInboxSyncPayload {
  const source = asObject(raw);
  if (!source) {
    return emptySyncPayload();
  }

  const keyPackages = normalizeSyncKeyPackageUpdates(
    source.key_packages ?? source.keyPackages ?? source.packages,
    userId
  );
  const groupStates = normalizeSyncGroupStates(
    source.group_states ?? source.groupStates
  );
  const welcomes = normalizeSyncWelcomes(
    source.welcomes ?? source.welcome_messages ?? source.welcomeMessages,
    userId
  );
  const commits = normalizeSyncCommits(
    source.commits ?? source.commit_messages ?? source.commitMessages
  );
  const archivedKeys = normalizeSyncArchivedKeys(
    source.archived_keys ?? source.archivedKeys
  );

  return {
    keyPackages,
    groupStates,
    welcomes,
    commits,
    archivedKeys,
  };
}

export async function syncMlsInbox(
  userId: string,
  options: { includeArchivedKeys?: boolean } = {},
): Promise<MlsInboxSyncPayload> {
  // Don't send user_id in the body — the server derives it from the JWT.
  // Sending it caused 403 errors when String(jwt.id) !== body.user_id due
  // to format differences (e.g. numeric vs UUID string).
  const response = await fetchWithAuth(`${MLS_API_PREFIX}/sync`, {
    method: 'POST',
    body: JSON.stringify({
      include_archived_keys: options.includeArchivedKeys !== false,
    }),
  });

  if (response.status === 404 || !response.ok) {
    return emptySyncPayload();
  }

  const payload = (await parseJsonSafe(response)) as MlsApiEnvelope<unknown> | null;
  const candidate = pickEnvelopeData(payload);
  return normalizeInboxSyncPayload(candidate, userId);
}
