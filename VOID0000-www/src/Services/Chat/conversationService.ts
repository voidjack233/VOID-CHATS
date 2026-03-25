import { fetchWithAuth } from '../Auth/authServiceApi';
import { keyManager } from '../Crypto/keyManager';
import { distributeGroupSenderKeyWithProtocol, preflightGroupRemove, reuploadGroupState } from './chatCryptoService';
import type {
  Conversation,
  ConversationMember,
} from './chatTypes';
import {
  CHAT_API_PREFIX,
  createApiError,
  ensureKeyRotationEnabled,
  getConversationKeyId,
  getErrorMessage,
  isRollbackableMlsAddFailure,
  normalizeKeyVersion,
  notifyMembershipUpdate,
  refreshConversationKeyVersion,
  withMembershipLock,
} from './chatUtils';

async function rollbackFailedRotateAdd(
  keyConversationId: string,
  memberIds: string[],
  failedKeyVersion: number,
): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${keyConversationId}/members/rotate-add/rollback`, {
    method: 'POST',
    body: JSON.stringify({
      members: memberIds,
      failed_key_version: failedKeyVersion,
    }),
  });
  const data = await response.json();
  if (!data.success) {
    throw createApiError(data);
  }
}

export async function getConversations(): Promise<Conversation[]> {
  const response = await fetchWithAuth(CHAT_API_PREFIX);
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return data.conversations;
}

export async function getConversation(id: string): Promise<{
  conversation: Conversation & { members: ConversationMember[] };
}> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${id}`);
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function createConversation(
  type: 'group',
  name: string,
  members: string[],
): Promise<{ conversation: Conversation }> {
  const response = await fetchWithAuth(CHAT_API_PREFIX, {
    method: 'POST',
    body: JSON.stringify({
      type,
      name,
      members,
    }),
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function updateConversation(
  id: string,
  updates: {
    name?: string;
  },
): Promise<{ conversation: Conversation }> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function uploadConversationIcon(
  id: string,
  icon: string,
): Promise<{ conversation: Conversation }> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${id}/icon`, {
    method: 'PUT',
    body: JSON.stringify({ icon }),
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function removeConversationIcon(id: string): Promise<{ conversation: Conversation }> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${id}/icon`, {
    method: 'DELETE',
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function deleteConversation(id: string): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${id}`, { method: 'DELETE' });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
}

export async function getOrCreateDM(userId: string): Promise<{
  conversation_id: string;
  conversation_public_id?: string | null;
  created: boolean;
}> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/dm/${userId}`, {
    method: 'POST',
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function addMembers(
  conversationId: string,
  members: string[],
): Promise<{ added: string[] }> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/members`, {
    method: 'POST',
    body: JSON.stringify({ members }),
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return data;
}

export async function ownerSelfHealGroupKey(
  conversation: Conversation,
  currentUserId: string,
  memberIds: string[],
): Promise<{ key: CryptoKey; version: number }> {
  const keyConversationId = getConversationKeyId(conversation);
  const allParticipants = [...new Set([...memberIds, currentUserId])];
  const { key, version } = await distributeGroupSenderKeyWithProtocol(
    { ...conversation, id: keyConversationId },
    currentUserId,
    allParticipants,
  );

  return { key, version };
}

export async function bootstrapDmKey(
  conversation: Conversation,
  currentUserId: string,
  peerUserId: string | undefined,
): Promise<{ key: CryptoKey; version: number }> {
  if (!peerUserId) {
    throw new Error('DM peer could not be resolved for secure bootstrap');
  }

  const participantIds = [currentUserId, peerUserId];

  console.log('[DM_BOOTSTRAP] attempting secure DM bootstrap', {
    conversation_id: conversation.id,
    current_user_id: currentUserId,
    peer_user_id: peerUserId,
  });

  const result = await distributeGroupSenderKeyWithProtocol(
    { ...conversation, id: conversation.id },
    currentUserId,
    participantIds,
  );

  if (!result.includedMemberUserIds.includes(peerUserId)) {
    console.warn('[DM_BOOTSTRAP] peer was not included in DM bootstrap', {
      conversation_id: conversation.id,
      included_member_user_ids: result.includedMemberUserIds,
      missing_member_user_ids: result.missingMemberUserIds,
    });
    throw new Error('DM peer device is not ready for secure chat yet');
  }

  if (result.version !== 1) {
    await keyManager.storeGroupKey(conversation.id, 1, result.key);
    return { key: result.key, version: 1 };
  }

  return result;
}

export async function ensureGroupKeyDistribution(
  conversation: Conversation,
  currentUserId: string,
  memberIds: string[],
): Promise<void> {
  const keyConversationId = getConversationKeyId(conversation);
  const allParticipants = [...new Set(memberIds)];
  if (allParticipants.length === 0) return;

  await distributeGroupSenderKeyWithProtocol(
    { ...conversation, id: keyConversationId },
    currentUserId,
    allParticipants,
  );
}

export function rotateAddMembers(
  conversation: Conversation,
  currentUserId: string,
  currentMemberIds: string[],
  newMemberIds: string[],
): Promise<{ added: string[]; key_version: number }> {
  const keyConversationId = getConversationKeyId(conversation);
  return withMembershipLock(keyConversationId, async () => {
    ensureKeyRotationEnabled();
    const additions = [...new Set(newMemberIds.filter((memberId) => memberId && memberId !== currentUserId))];

    if (additions.length === 0) {
      throw new Error('Select at least one member to add');
    }

    const freshConversation = await refreshConversationKeyVersion(keyConversationId, conversation);
    const finalMemberIds = [...new Set([...currentMemberIds, ...additions, currentUserId])];
    const nextKeyVersion = normalizeKeyVersion(freshConversation.current_key_version, 1) + 1;

    const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${keyConversationId}/members/rotate-add`, {
      method: 'POST',
      body: JSON.stringify({
        members: additions,
        new_key_version: nextKeyVersion,
      }),
    });
    const data = await response.json();
    if (!data.success) throw createApiError(data);
    const pendingKeyVersion = data.pending_key_version || nextKeyVersion;

    let mlsKey: CryptoKey;
    let finalizeStarted = false;
    try {
      ({ key: mlsKey } = await distributeGroupSenderKeyWithProtocol(
        { ...freshConversation, id: keyConversationId, current_key_version: pendingKeyVersion },
        currentUserId,
        finalMemberIds,
      ));

      finalizeStarted = true;
      let finalizeResponse = await fetchWithAuth(
        `${CHAT_API_PREFIX}/${keyConversationId}/members/rotate-add/finalize`,
        { method: 'POST' },
      );
      let finalizeData = await finalizeResponse.json();

      if (!finalizeData.success && finalizeData.code === 'SNAPSHOT_REQUIRED') {
        console.warn('[ROTATE_ADD] snapshot not found on server, re-uploading from local state', {
          conversation_id: keyConversationId,
          pending_key_version: pendingKeyVersion,
        });
        await reuploadGroupState(keyConversationId);
        finalizeResponse = await fetchWithAuth(
          `${CHAT_API_PREFIX}/${keyConversationId}/members/rotate-add/finalize`,
          { method: 'POST' },
        );
        finalizeData = await finalizeResponse.json();
      }

      if (!finalizeData.success) {
        throw createApiError(finalizeData);
      }

      const resolvedKeyVersion = finalizeData.key_version || pendingKeyVersion;

      await keyManager.storeGroupKey(keyConversationId, resolvedKeyVersion, mlsKey);
      await notifyMembershipUpdate(keyConversationId);

      return {
        added: finalizeData.added || data.added || additions,
        key_version: resolvedKeyVersion,
      };
    } catch (error) {
      if (!finalizeStarted) {
        const rollbackNotice = 'Pending member add was cleared.';
        try {
          await rollbackFailedRotateAdd(keyConversationId, additions, pendingKeyVersion);
        } catch (rollbackError) {
          throw new Error(`${getErrorMessage(error)} Pending member add cleanup failed; manual cleanup may be required. ${getErrorMessage(rollbackError)}`);
        }

        if (!isRollbackableMlsAddFailure(error)) {
          throw new Error(`${getErrorMessage(error)} ${rollbackNotice}`);
        }

        throw new Error(`${getErrorMessage(error)} ${rollbackNotice}`);
      }

      throw error;
    }
  });
}

export function rotateRemoveMember(
  conversation: Conversation,
  currentUserId: string,
  remainingMemberIds: string[],
  targetUserId: string,
): Promise<{ key_version: number }> {
  const keyConversationId = getConversationKeyId(conversation);
  return withMembershipLock(keyConversationId, async () => {
    ensureKeyRotationEnabled();
    const survivors = [...new Set(remainingMemberIds.filter(Boolean))];

    if (!targetUserId) {
      throw new Error('targetUserId required');
    }

    if (survivors.length === 0) {
      throw new Error('At least one member must remain in the group');
    }

    const freshConversation = await refreshConversationKeyVersion(keyConversationId, conversation);
    const nextKeyVersion = normalizeKeyVersion(freshConversation.current_key_version, 1) + 1;

    // Preflight: prove local MLS state can apply this removal BEFORE
    // mutating server membership. No durable side effects — just
    // validates lineage freshness, leaf index existence, and commit
    // applicability. If stale, syncs and retries. If still unusable,
    // throws before any server state is changed.
    const preflightResult = await preflightGroupRemove(
      { ...freshConversation, id: keyConversationId, current_key_version: nextKeyVersion },
      currentUserId,
      [targetUserId],
    );

    // ── Phase 1: PREPARE ─────────────────────────────────────────
    // Server validates the removal and records intent (pending_remove_*
    // columns on the conversation row). Does NOT delete the member or
    // advance current_key_version. Idempotent for the same target/version.
    const prepareResponse = await fetchWithAuth(`${CHAT_API_PREFIX}/${keyConversationId}/members/rotate-remove`, {
      method: 'POST',
      body: JSON.stringify({
        target_user_id: targetUserId,
        new_key_version: nextKeyVersion,
      }),
    });
    const prepareData = await prepareResponse.json();
    if (!prepareData.success) throw createApiError(prepareData);
    const pendingKeyVersion = prepareData.pending_key_version || nextKeyVersion;

    // ── Distribute: produce MLS state and upload survivor snapshot ──
    // The survivor's durable snapshot for pendingKeyVersion must exist
    // in mls_group_states BEFORE finalize will commit the removal.
    const { key: mlsKey } = await distributeGroupSenderKeyWithProtocol(
      { ...freshConversation, id: keyConversationId, current_key_version: pendingKeyVersion },
      currentUserId,
      survivors,
      { allowFreshGroupBootstrap: preflightResult.requiresFreshBootstrap },
    );

    // ── Phase 2: FINALIZE ────────────────────────────────────────
    // Server verifies the survivor's snapshot exists in mls_group_states
    // with key_version >= pendingKeyVersion, then atomically commits:
    // member deletion, version advance, rotation record.
    // If the snapshot is missing, returns 428 SNAPSHOT_REQUIRED.
    let finalizeResponse = await fetchWithAuth(
      `${CHAT_API_PREFIX}/${keyConversationId}/members/rotate-remove/finalize`,
      { method: 'POST' },
    );
    let finalizeData = await finalizeResponse.json();

    // If finalize fails because the upload was silently lost, re-upload
    // from local state and retry once.
    if (!finalizeData.success && finalizeData.code === 'SNAPSHOT_REQUIRED') {
      console.warn('[ROTATE_REMOVE] snapshot not found on server, re-uploading from local state', {
        conversation_id: keyConversationId,
        pending_key_version: pendingKeyVersion,
      });
      await reuploadGroupState(keyConversationId);
      finalizeResponse = await fetchWithAuth(
        `${CHAT_API_PREFIX}/${keyConversationId}/members/rotate-remove/finalize`,
        { method: 'POST' },
      );
      finalizeData = await finalizeResponse.json();
    }

    if (!finalizeData.success) throw createApiError(finalizeData);
    const resolvedKeyVersion = finalizeData.key_version || pendingKeyVersion;

    if (survivors.includes(currentUserId) && targetUserId !== currentUserId) {
      await keyManager.storeGroupKey(keyConversationId, resolvedKeyVersion, mlsKey);
    }
    await notifyMembershipUpdate(keyConversationId);

    return { key_version: resolvedKeyVersion };
  });
}

export async function removeMember(conversationId: string, userId: string): Promise<void> {
  const response = await fetchWithAuth(
    `${CHAT_API_PREFIX}/${conversationId}/members/${userId}`,
    { method: 'DELETE' },
  );
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
}

export async function updateMemberRole(
  conversationId: string,
  userId: string,
  role: string,
): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/members/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
}

export async function createSecureGroup(
  name: string,
  memberIds: string[],
  currentUserId: string,
): Promise<{ conversation: Conversation }> {
  const { conversation } = await createConversation('group', name, memberIds);
  const allParticipants = [...new Set([...memberIds, currentUserId])];
  const { key: mlsKey, version } = await distributeGroupSenderKeyWithProtocol(
    { ...conversation, current_key_version: 1 },
    currentUserId,
    allParticipants,
    { allowFreshGroupBootstrap: true },
  );

  await keyManager.storeGroupKey(conversation.id, version, mlsKey);
  return { conversation };
}
