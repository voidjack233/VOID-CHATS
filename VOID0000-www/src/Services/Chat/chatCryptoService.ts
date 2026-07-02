import { fetchWithAuth } from '../Auth/authServiceApi';
import { keyManager } from '../Crypto/keyManager';
import { chatCryptoProtocolService } from '../Crypto/protocols/chatCryptoProtocolService';
import type { MlsMembershipFinalizeArtifacts } from '../Crypto/mls/mlsTypes';
import { debugLog } from '../utils/debugLog';
import type {
  Conversation,
  KeyBackupRecord,
  MessageDecryptionContext,
  MessageCryptoProtocol,
  VersionedDecryptableMessage,
} from './chatTypes';
import {
  CHAT_API_PREFIX,
  CHAT_MLS_ROLLOUT_DATE_MS,
  getConversationKeyId,
  normalizeKeyVersion,
} from './chatUtils';

const DM_DECRYPT_HEALER_COOLDOWN_MS = 45_000;
const dmDecryptHealerActivatedAt = new Map<string, number>();

export function tryActivateDmDecryptHealer(conversationId: string): {
  activated: boolean;
  retryAfterMs: number;
} {
  const now = Date.now();
  const lastActivatedAt = dmDecryptHealerActivatedAt.get(conversationId) ?? 0;
  const elapsed = now - lastActivatedAt;

  if (elapsed < DM_DECRYPT_HEALER_COOLDOWN_MS) {
    return {
      activated: false,
      retryAfterMs: DM_DECRYPT_HEALER_COOLDOWN_MS - elapsed,
    };
  }

  dmDecryptHealerActivatedAt.set(conversationId, now);
  return { activated: true, retryAfterMs: 0 };
}

function normalizeMessageProtocol(value: unknown): MessageCryptoProtocol | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'mls') return 'mls';
  if (normalized === 'legacy_aes' || normalized === 'legacy' || normalized === 'aes' || normalized === 'aes_gcm') {
    return 'legacy_aes';
  }
  return null;
}

function normalizeProtocolVersion(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function inferMessageProtocol(
  messageType: string | null | undefined,
  createdAt?: string | null,
): MessageCryptoProtocol | null {
  const normalizedType = typeof messageType === 'string'
    ? messageType.trim().toLowerCase()
    : '';

  if (normalizedType === 'mls_application') {
    return 'mls';
  }

  if (chatCryptoProtocolService.isDmMessageType(messageType)) {
    return 'mls';
  }

  if (normalizedType === 'signal_text') {
    return 'legacy_aes';
  }

  if (normalizedType === 'text' && createdAt) {
    const createdAtMs = Date.parse(createdAt);
    if (Number.isFinite(createdAtMs) && createdAtMs < CHAT_MLS_ROLLOUT_DATE_MS) {
      return 'legacy_aes';
    }
  }

  return 'mls';
}

export function resolveMessageCryptoMetadata(message: {
  message_type?: string | null;
  created_at?: string | null;
  iv?: string | null;
  protocol?: unknown;
  protocol_version?: unknown;
}): { protocol: MessageCryptoProtocol | null; protocol_version: number | null } {
  const explicitProtocol = normalizeMessageProtocol(message.protocol);
  const protocol = explicitProtocol || inferMessageProtocol(message.message_type, message.created_at);
  const explicitVersion = normalizeProtocolVersion(message.protocol_version);

  if (explicitVersion != null) {
    return { protocol, protocol_version: explicitVersion };
  }

  if (protocol === 'mls') {
    return { protocol, protocol_version: chatCryptoProtocolService.protocolVersion };
  }

  if (protocol === 'legacy_aes') {
    return { protocol, protocol_version: 1 };
  }

  return { protocol, protocol_version: null };
}

export function createMessageKeyResolver(
  fallbackKey: CryptoKey,
  context?: MessageDecryptionContext,
): ((message: VersionedDecryptableMessage) => Promise<CryptoKey>) | null {
  if (!context?.conversation || !context.userId) {
    return null;
  }

  const conversation = context.conversation;
  const versionCache = new Map<number, Promise<CryptoKey>>();
  const currentVersion = normalizeKeyVersion(context.currentKeyVersion, 1);
  if (conversation.type !== 'dm') {
    versionCache.set(currentVersion, Promise.resolve(fallbackKey));
  }

  return async (message: VersionedDecryptableMessage) => {
    const targetVersion = normalizeKeyVersion(message.key_version, currentVersion);

    if (!versionCache.has(targetVersion)) {
      versionCache.set(
        targetVersion,
        getEncryptionKey(
          context.userId as string,
          conversation as Conversation,
          targetVersion,
          // Decryption can safely probe a newer group key when old metadata is
          // stale: AES-GCM rejects the wrong key, and we do not alias-cache it
          // into IndexedDB under the older version.
          { allowNewerGroupVersion: conversation.type !== 'dm' },
        ).then(({ key }) => key),
      );
    }

    return versionCache.get(targetVersion) as Promise<CryptoKey>;
  };
}

export async function distributeGroupSenderKeyWithProtocol(
  conversation: Conversation,
  currentUserId: string,
  participantIds: string[],
  options?: {
    allowFreshGroupBootstrap?: boolean;
    forceFreshGroupBootstrap?: boolean;
    forceReaddMemberUserIds?: string[];
    forceKeyVersionBump?: boolean;
    stageOnly?: boolean;
  },
): Promise<{
  key: CryptoKey;
  version: number;
  includedMemberUserIds: string[];
  missingMemberUserIds: string[];
  membershipArtifacts?: MlsMembershipFinalizeArtifacts | null;
}> {
  const uniqueParticipants = [...new Set([...participantIds, currentUserId].filter(Boolean))];
  const result = await chatCryptoProtocolService.distributeGroupKey({
    userId: currentUserId,
    conversation,
    memberUserIds: uniqueParticipants,
    allowFreshGroupBootstrap: options?.allowFreshGroupBootstrap,
    forceFreshGroupBootstrap: options?.forceFreshGroupBootstrap,
    forceReaddMemberUserIds: options?.forceReaddMemberUserIds,
    forceKeyVersionBump: options?.forceKeyVersionBump,
    stageOnly: options?.stageOnly,
  });

  return {
    key: result.key,
    version: result.keyVersion,
    includedMemberUserIds: result.includedMemberUserIds,
    missingMemberUserIds: result.missingMemberUserIds,
    membershipArtifacts: result.membershipArtifacts ?? null,
  };
}

export async function preflightGroupRemove(
  conversation: Conversation,
  currentUserId: string,
  removeMemberIds: string[],
): Promise<{ requiresFreshBootstrap: boolean }> {
  return chatCryptoProtocolService.preflightGroupRemove(currentUserId, conversation, removeMemberIds);
}

export async function reuploadGroupState(conversationId: string): Promise<boolean> {
  return chatCryptoProtocolService.reuploadGroupState(conversationId);
}

export async function uploadPublicKey(publicKey: string, keyId: string): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/keys`, {
    method: 'POST',
    body: JSON.stringify({ public_key: publicKey, key_id: keyId }),
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
}

export async function getEncryptionKey(
  userId: string,
  conversation: Conversation,
  requestedKeyVersion?: number,
  options?: {
    allowNewerGroupVersion?: boolean;
  },
): Promise<{ key: CryptoKey; version: number }> {
  const keyConversationId = getConversationKeyId(conversation);
  const hasRequestedVersion = Number.isInteger(requestedKeyVersion) && (requestedKeyVersion as number) > 0;
  const requestedVersion = hasRequestedVersion ? (requestedKeyVersion as number) : null;
  const allowNewerGroupVersion =
    conversation.type !== 'dm' && options?.allowNewerGroupVersion === true;
  const allowLatestDmVersion =
    conversation.type === 'dm' && requestedVersion == null;

  const targetVersion = hasRequestedVersion
    ? (requestedKeyVersion as number)
    : normalizeKeyVersion(conversation.current_key_version, 1);

  // For DMs, reject a cached key only when local MLS state proves that the
  // self/peer pair is incomplete. A missing local MLS state does not prove a
  // cached key is wrong; deleting it can destroy the only usable message key.
  const isDm = conversation.type === 'dm';
  let canUseCachedGroupKey = !isDm;
  let confirmedInvalidDmCoverage = false;
  if (isDm) {
    const peerUserId = conversation.dm_user_id;
    if (peerUserId) {
      const localMembers = await chatCryptoProtocolService.getLocalGroupMemberUserIds(keyConversationId);
      if (localMembers === null) {
        canUseCachedGroupKey = true;
        console.warn('[KEY_RESOLVE] DM local MLS member coverage unknown', {
          conversation_id: keyConversationId,
          local_members: localMembers,
          expected_peer: peerUserId,
        });
      } else {
        canUseCachedGroupKey =
          localMembers.includes(userId) &&
          localMembers.includes(peerUserId);
        confirmedInvalidDmCoverage = !canUseCachedGroupKey;
      }
      if (confirmedInvalidDmCoverage) {
        console.warn('[KEY_RESOLVE] DM cached key coverage invalid — peer missing from local MLS state', {
          conversation_id: keyConversationId,
          local_members: localMembers,
          expected_peer: peerUserId,
        });
      }
    }
  }

  if (confirmedInvalidDmCoverage) {
    const versionsToDelete = new Set<number>([targetVersion]);
    if (requestedVersion != null) {
      versionsToDelete.add(requestedVersion);
    }

    await Promise.all(
      Array.from(versionsToDelete).map((version) =>
        keyManager.deleteGroupKey(keyConversationId, version).catch(() => {})
      )
    );
  }

  if (canUseCachedGroupKey) {
    if (requestedVersion != null) {
      const cachedRequestedGroupKey = await keyManager.getGroupKey(keyConversationId, requestedVersion);
      if (cachedRequestedGroupKey) {
        return { key: cachedRequestedGroupKey, version: requestedVersion };
      }
    }

    const cachedGroupKey = await keyManager.getGroupKey(keyConversationId, targetVersion);
    if (cachedGroupKey) {
      return { key: cachedGroupKey, version: targetVersion };
    }
  }

  debugLog('[KEY_RESOLVE] local miss - forcing syncInbox', {
    conversation_id: keyConversationId,
    targetVersion,
  });
  await chatCryptoProtocolService.syncInbox(userId, true, {
    forceArchiveSync: true,
  });

  const syncedGroupKey = await keyManager.getGroupKey(keyConversationId, targetVersion);
  if (syncedGroupKey) {
    debugLog('[KEY_RESOLVE] syncInbox resolved key', {
      conversation_id: keyConversationId,
      targetVersion,
    });
    return { key: syncedGroupKey, version: targetVersion };
  }

  if (allowNewerGroupVersion || allowLatestDmVersion) {
    const newerGroupKey = await keyManager.findAnyGroupKey(keyConversationId);
    if (newerGroupKey && newerGroupKey.version > targetVersion) {
      debugLog('[KEY_RESOLVE] accepting newer synced group version', {
        conversation_id: keyConversationId,
        conversation_type: conversation.type,
        target_version: targetVersion,
        accepted_version: newerGroupKey.version,
      });
      return { key: newerGroupKey.key, version: newerGroupKey.version };
    }
  }

  const fallback = await keyManager.findAnyGroupKey(keyConversationId);
  if (fallback) {
    if (fallback.version === targetVersion) {
      return { key: fallback.key, version: targetVersion };
    }

    // Different version — do NOT alias-cache. Aliasing a key under a different
    // message version permanently poisons the cache: the wrong key fails AES-GCM
    // decryption AND archived-key import skips "existing" entries, blocking
    // same-account multi-device recovery.
    console.warn('[KEY_RESOLVE] group key version mismatch — not aliasing to preserve archive import path', {
      conversation_id: keyConversationId,
      conversation_type: conversation.type,
      found_version: fallback.version,
      target_version: targetVersion,
    });
    throw new Error(`No group sender key available for version ${targetVersion}`);
  }

  throw new Error(`No group sender key available for version ${targetVersion}`);
}

export async function backupKeyToServer(data: {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
  mls_state_encrypted?: string;
  mls_state_iv?: string;
  mls_state_salt?: string;
  mls_key_package_refs?: string[];
}): Promise<string[]> {
  const response = await fetchWithAuth('/api/conversations/keys/backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    let errorCode = 'Failed to backup key';
    try {
      const payload = await response.json();
      errorCode = payload?.code || payload?.error || errorCode;
    } catch {
      // Ignore JSON parsing failure and use fallback message.
    }
    throw new Error(errorCode);
  }

  const payload = await response.json().catch(() => null) as {
    data?: { activated_key_package_refs?: unknown };
  } | null;
  const refs = payload?.data?.activated_key_package_refs;
  return Array.isArray(refs)
    ? refs.filter((value): value is string => typeof value === 'string')
    : [];
}

export async function backupRecoveryKeyToServer(data: {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
  recovery_mls_state_encrypted?: string;
  recovery_mls_state_iv?: string;
  recovery_mls_state_salt?: string;
  mls_key_package_refs?: string[];
}): Promise<string[]> {
  const response = await fetchWithAuth('/api/conversations/keys/backup/recovery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    let errorCode = 'Failed to backup recovery key';
    try {
      const payload = await response.json();
      errorCode = payload?.code || payload?.error || errorCode;
    } catch {
      // Ignore JSON parsing failure and use fallback message.
    }
    throw new Error(errorCode);
  }

  const payload = await response.json().catch(() => null) as {
    data?: { activated_key_package_refs?: unknown };
  } | null;
  const refs = payload?.data?.activated_key_package_refs;
  return Array.isArray(refs)
    ? refs.filter((value): value is string => typeof value === 'string')
    : [];
}

export async function backupAccountMlsStateToServer(data: {
  account_mls_state_encrypted: string;
  account_mls_state_iv: string;
  account_mls_state_key_id: string;
  mls_key_package_refs: string[];
}): Promise<string[]> {
  const response = await fetchWithAuth('/api/conversations/keys/backup/account-mls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    let errorCode = 'Failed to backup account MLS state';
    try {
      const payload = await response.json();
      errorCode = payload?.code || payload?.error || errorCode;
    } catch {
      // Ignore JSON parsing failure and use fallback message.
    }
    throw new Error(errorCode);
  }

  const payload = await response.json().catch(() => null) as {
    data?: { activated_key_package_refs?: unknown };
  } | null;
  const refs = payload?.data?.activated_key_package_refs;
  return Array.isArray(refs)
    ? refs.filter((value): value is string => typeof value === 'string')
    : [];
}

export async function fetchKeyBackup(): Promise<KeyBackupRecord | null> {
  const response = await fetchWithAuth('/api/conversations/keys/backup');
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Failed to fetch key backup');
  const data = await response.json();
  return data.backup || null;
}
