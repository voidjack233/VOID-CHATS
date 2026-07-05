import { fetchWithAuth } from '../Auth/authServiceApi';
import { fetchAppBootstrap } from '../bootstrap';
import { keyManager } from '../Crypto/keyManager';
import type { MlsMembershipFinalizeArtifacts } from '../Crypto/mls/mlsTypes';
import { chatCryptoProtocolService } from '../Crypto/protocols/chatCryptoProtocolService';
import { debugLog } from '../utils/debugLog';
import { distributeGroupSenderKeyWithProtocol, preflightGroupRemove } from './chatCryptoService';
import type {
  Conversation,
  ConversationMember,
  GroupPermissions,
} from './chatTypes';
import {
  CHAT_API_PREFIX,
  createApiError,
  ensureKeyRotationEnabled,
  fetchActiveConversationMemberIds,
  getConversationKeyId,
  getErrorMessage,
  isRollbackableMlsAddFailure,
  normalizeKeyVersion,
  notifyMembershipUpdate,
  refreshConversationKeyVersion,
  withMembershipLock,
} from './chatUtils';

let usedBootstrapConversations = false;
const selfLeaveFinalizationRequests = new Map<string, Promise<SelfLeaveFinalizeResult>>();

export interface PendingSelfLeaveRotation {
  operation_id: string;
  conversation_id: string;
  conversation_public_id?: string | null;
  target_user_id: string;
  target_label?: string | null;
  survivor_role?: string | null;
  pending_key_version: number;
  current_key_version: number;
}

export interface SelfLeaveFinalizeResult {
  removed_user_id: string;
  key_version: number;
  already_finalized: boolean;
}

async function rollbackFailedRotateAdd(
  keyConversationId: string,
  memberIds: string[],
  failedKeyVersion: number,
  operationId: string,
): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${keyConversationId}/members/rotate-add/rollback`, {
    method: 'POST',
    body: JSON.stringify({
      members: memberIds,
      failed_key_version: failedKeyVersion,
      operation_id: operationId,
    }),
  });
  const data = await response.json();
  if (!data.success) {
    throw createApiError(data);
  }
}

async function rollbackFailedRotateRemove(
  keyConversationId: string,
  targetUserId: string,
  failedKeyVersion: number,
  operationId: string,
): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${keyConversationId}/members/rotate-remove/rollback`, {
    method: 'POST',
    body: JSON.stringify({
      target_user_id: targetUserId,
      failed_key_version: failedKeyVersion,
      operation_id: operationId,
    }),
  });
  const data = await response.json();
  if (!data.success) {
    throw createApiError(data);
  }
}

export async function getConversations(): Promise<Conversation[]> {
  if (!usedBootstrapConversations) {
    const bootstrap = await fetchAppBootstrap();
    if (Array.isArray(bootstrap?.conversations)) {
      usedBootstrapConversations = true;
      return bootstrap.conversations;
    }
  }

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

// DM_FOREVER is used for "mute until I turn it back on".
const DM_MUTE_FOREVER = '2099-12-31T23:59:59Z';

export async function closeDM(conversationId: string): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/dm-settings`, {
    method: 'PATCH',
    body: JSON.stringify({ hidden: true }),
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
}

export async function muteDM(conversationId: string, mute: boolean): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/dm-settings`, {
    method: 'PATCH',
    body: JSON.stringify({ muted_until: mute ? DM_MUTE_FOREVER : null }),
  });
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
  const currentKeyVersion = normalizeKeyVersion(conversation.current_key_version, 1);
  const isExistingDmBootstrap =
    currentKeyVersion > 1 ||
    Boolean(conversation.first_message_at) ||
    Boolean(conversation.last_message_id);

  debugLog('[DM_BOOTSTRAP] attempting secure DM bootstrap', {
    conversation_id: conversation.id,
    current_user_id: currentUserId,
    peer_user_id: peerUserId,
    current_key_version: currentKeyVersion,
    existing_dm_bootstrap: isExistingDmBootstrap,
  });

  const result = await distributeGroupSenderKeyWithProtocol(
    { ...conversation, id: conversation.id },
    currentUserId,
    participantIds,
    { forceKeyVersionBump: isExistingDmBootstrap },
  );

  if (!result.includedMemberUserIds.includes(peerUserId)) {
    console.warn('[DM_BOOTSTRAP] peer was not included in DM bootstrap', {
      conversation_id: conversation.id,
      included_member_user_ids: result.includedMemberUserIds,
      missing_member_user_ids: result.missingMemberUserIds,
    });
    throw new Error('DM peer account secure keys are still preparing');
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
  _currentMemberIds: string[],
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
    const activeMemberIds = await fetchActiveConversationMemberIds(keyConversationId);
    const finalMemberIds = [...new Set([...activeMemberIds, ...additions, currentUserId])];
    const nextKeyVersion = normalizeKeyVersion(freshConversation.current_key_version, 1) + 1;
    const localMemberIds = await chatCryptoProtocolService.getLocalGroupMemberUserIds(keyConversationId);
    if (localMemberIds?.some((memberId) => additions.includes(memberId))) {
      await chatCryptoProtocolService.discardLocalGroupState(keyConversationId);
      await chatCryptoProtocolService.syncInbox(currentUserId, true);
    }

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
    const operationId = typeof data.operation_id === 'string' ? data.operation_id : '';
    if (!operationId) {
      throw new Error('Secure membership reservation was not returned by the server');
    }

    let mlsKey: CryptoKey;
    let mlsArtifacts: MlsMembershipFinalizeArtifacts | null | undefined;
    let finalizeStarted = false;
    try {
      ({ key: mlsKey, membershipArtifacts: mlsArtifacts } = await distributeGroupSenderKeyWithProtocol(
        { ...freshConversation, id: keyConversationId, current_key_version: pendingKeyVersion },
        currentUserId,
        finalMemberIds,
        { stageOnly: true },
      ));

      if (!mlsArtifacts) {
        throw new Error('Secure membership artifacts could not be prepared');
      }

      finalizeStarted = true;
      const finalizeResponse = await fetchWithAuth(
        `${CHAT_API_PREFIX}/${keyConversationId}/members/rotate-add/finalize`,
        {
          method: 'POST',
          body: JSON.stringify({ operation_id: operationId, mls_artifacts: mlsArtifacts }),
        },
      );
      const finalizeData = await finalizeResponse.json();

      if (!finalizeData.success) {
        throw createApiError(finalizeData);
      }

      const resolvedKeyVersion = finalizeData.key_version || pendingKeyVersion;

      await keyManager.storeGroupKey(keyConversationId, resolvedKeyVersion, mlsKey);
      await chatCryptoProtocolService.syncInbox(currentUserId, true).catch((error) => {
        console.warn('[ROTATE_ADD] finalized but local MLS state refresh failed', {
          conversation_id: keyConversationId,
          key_version: resolvedKeyVersion,
          error: error instanceof Error ? error.message : String(error || ''),
        });
      });
      await notifyMembershipUpdate(keyConversationId);

      return {
        added: finalizeData.added || data.added || additions,
        key_version: resolvedKeyVersion,
      };
    } catch (error) {
      if (!finalizeStarted) {
        const rollbackNotice = 'Pending member add was cleared.';
        try {
          await rollbackFailedRotateAdd(keyConversationId, additions, pendingKeyVersion, operationId);
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
  _remainingMemberIds: string[],
  targetUserId: string,
): Promise<{ key_version: number }> {
  const keyConversationId = getConversationKeyId(conversation);
  return withMembershipLock(keyConversationId, async () => {
    ensureKeyRotationEnabled();

    if (!targetUserId) {
      throw new Error('targetUserId required');
    }

    const activeMemberIds = await fetchActiveConversationMemberIds(keyConversationId);
    const survivors = activeMemberIds.filter((memberId) => memberId !== targetUserId);

    if (survivors.length === 0) {
      throw new Error('At least one member must remain in the group');
    }

    const freshConversation = await refreshConversationKeyVersion(keyConversationId, conversation);
    const nextKeyVersion = normalizeKeyVersion(freshConversation.current_key_version, 1) + 1;
    const localMemberIds = await chatCryptoProtocolService.getLocalGroupMemberUserIds(keyConversationId);
    if (localMemberIds && !localMemberIds.includes(targetUserId)) {
      await chatCryptoProtocolService.discardLocalGroupState(keyConversationId);
      await chatCryptoProtocolService.syncInbox(currentUserId, true);
    }

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

    // Phase 1 reserves the one conversation-wide membership rotation slot.
    // No member removal or key-version advance occurs before finalize.
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
    const operationId = typeof prepareData.operation_id === 'string' ? prepareData.operation_id : '';
    if (!operationId) {
      throw new Error('Secure membership reservation was not returned by the server');
    }

    let finalizeStarted = false;
    try {
      // Produce the survivor MLS state without publishing it before membership
      // is committed. Finalize stores the artifact bundle atomically.
      const { key: mlsKey, membershipArtifacts: mlsArtifacts } = await distributeGroupSenderKeyWithProtocol(
        { ...freshConversation, id: keyConversationId, current_key_version: pendingKeyVersion },
        currentUserId,
        survivors,
        { allowFreshGroupBootstrap: preflightResult.requiresFreshBootstrap, stageOnly: true },
      );

      if (!mlsArtifacts) {
        throw new Error('Secure membership artifacts could not be prepared');
      }

      finalizeStarted = true;
      const finalizeResponse = await fetchWithAuth(
        `${CHAT_API_PREFIX}/${keyConversationId}/members/rotate-remove/finalize`,
        {
          method: 'POST',
          body: JSON.stringify({ operation_id: operationId, mls_artifacts: mlsArtifacts }),
        },
      );
      const finalizeData = await finalizeResponse.json();

      if (!finalizeData.success) throw createApiError(finalizeData);
      const resolvedKeyVersion = finalizeData.key_version || pendingKeyVersion;

      if (survivors.includes(currentUserId) && targetUserId !== currentUserId) {
        await keyManager.storeGroupKey(keyConversationId, resolvedKeyVersion, mlsKey);
        await chatCryptoProtocolService.syncInbox(currentUserId, true).catch((error) => {
          console.warn('[ROTATE_REMOVE] finalized but local MLS state refresh failed', {
            conversation_id: keyConversationId,
            key_version: resolvedKeyVersion,
            error: error instanceof Error ? error.message : String(error || ''),
          });
        });
      }
      await notifyMembershipUpdate(keyConversationId);

      return { key_version: resolvedKeyVersion };
    } catch (error) {
      if (!finalizeStarted) {
        try {
          await rollbackFailedRotateRemove(keyConversationId, targetUserId, pendingKeyVersion, operationId);
        } catch (rollbackError) {
          throw new Error(`${getErrorMessage(error)} Pending member removal cleanup failed; manual cleanup may be required. ${getErrorMessage(rollbackError)}`);
        }

        throw new Error(`${getErrorMessage(error)} Pending member removal was cleared.`);
      }

      throw error;
    }
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

export async function leaveConversation(conversationId: string): Promise<{ deleted: boolean }> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/members/leave`, {
    method: 'POST',
  });
  const data = await response.json();
  if (!data.success) throw createApiError(data);
  return { deleted: Boolean(data.deleted) };
}

export async function getPendingSelfLeaveRotations(): Promise<PendingSelfLeaveRotation[]> {
  const response = await fetchWithAuth(
    `${CHAT_API_PREFIX}/membership-rotations/self-leaves/pending`,
  );

  const isJsonResponse = (response.headers.get('content-type') || '')
    .toLowerCase()
    .includes('json');
  let data: Record<string, unknown> | null = null;
  if (isJsonResponse) {
    try {
      data = await response.json() as Record<string, unknown>;
    } catch {
      data = null;
    }
  }

  if (response.status === 404) {
    console.warn('SELF_LEAVE_PENDING_ENDPOINT_NOT_FOUND', {
      endpoint: `${CHAT_API_PREFIX}/membership-rotations/self-leaves/pending`,
    });
    return [];
  }

  if (!response.ok) {
    throw createApiError(data || {
      error: `Pending self-leave recovery request failed with status ${response.status}`,
      code: 'SELF_LEAVE_PENDING_REQUEST_FAILED',
    }, { status: response.status });
  }

  if (!data) {
    throw createApiError({
      error: 'Pending self-leave recovery returned a non-JSON response',
      code: 'SELF_LEAVE_PENDING_RESPONSE_INVALID',
    }, { status: response.status });
  }

  if (!data.success) throw createApiError(data);
  return Array.isArray(data.rotations) ? data.rotations : [];
}

export function finalizeSelfLeaveRotation(
  rotation: PendingSelfLeaveRotation,
  currentUserId: string,
): Promise<SelfLeaveFinalizeResult> {
  const existingRequest = selfLeaveFinalizationRequests.get(rotation.operation_id);
  if (existingRequest) {
    return existingRequest;
  }

  const request = withMembershipLock(rotation.conversation_id, async () => {
    if (!currentUserId || currentUserId === rotation.target_user_id) {
      throw new Error('A remaining member must finalize secure self-leave');
    }

    const claimResponse = await fetchWithAuth(
      `${CHAT_API_PREFIX}/${rotation.conversation_id}/members/self-leave/claim`,
      {
        method: 'POST',
        body: JSON.stringify({ operation_id: rotation.operation_id }),
      },
    );
    const claimData = await claimResponse.json();
    if (!claimData.success) {
      throw createApiError(claimData);
    }

    if (claimData.already_finalized) {
      const resolvedKeyVersion = normalizeKeyVersion(
        claimData.key_version,
        rotation.pending_key_version,
      );
      await chatCryptoProtocolService.syncInbox(currentUserId, true, {
        forceArchiveSync: true,
      }).catch((error) => {
        console.warn('[SELF_LEAVE] finalized rotation inbox sync was deferred', {
          conversation_id: rotation.conversation_id,
          operation_id: rotation.operation_id,
          error: error instanceof Error ? error.message : String(error || ''),
        });
      });
      await notifyMembershipUpdate(rotation.conversation_id);
      return {
        removed_user_id: claimData.removed_user_id || rotation.target_user_id,
        key_version: resolvedKeyVersion,
        already_finalized: true,
      };
    }

    if (!claimData.claimed) {
      throw createApiError({
        error: 'Another member is securing this leave',
        code: 'SELF_LEAVE_CLAIM_HELD',
        retry_after_seconds: Number(claimData.retry_after_seconds) || 2,
      });
    }

    const { conversation } = await getConversation(rotation.conversation_id);
    const memberIds = (conversation.members || []).map((member) => member.user_id);
    if (!memberIds.includes(currentUserId)) {
      throw new Error('Current user is no longer a member of this group');
    }
    if (memberIds.includes(rotation.target_user_id)) {
      throw new Error('Self-leave target is still listed as an active member');
    }

    let mlsKey: CryptoKey | null = null;
    let mlsArtifacts: MlsMembershipFinalizeArtifacts | null | undefined;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        ({ key: mlsKey, membershipArtifacts: mlsArtifacts } =
          await distributeGroupSenderKeyWithProtocol(
            {
              ...conversation,
              id: getConversationKeyId(conversation),
              current_key_version: rotation.pending_key_version,
            },
            currentUserId,
            memberIds,
            { stageOnly: true },
          ));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt === 0) {
          await chatCryptoProtocolService.syncInbox(currentUserId, true, {
            forceArchiveSync: true,
          }).catch(() => {});
        }
      }
    }

    if (lastError) {
      throw lastError;
    }
    if (!mlsKey || !mlsArtifacts) {
      throw new Error('Secure self-leave artifacts could not be prepared');
    }
    if (mlsArtifacts.welcomes.length > 0) {
      debugLog('[SELF_LEAVE] repairing MLS roster drift for active survivors', {
        conversation_id: rotation.conversation_id,
        welcome_user_ids: mlsArtifacts.welcomes.map((welcome) => welcome.userId),
      });
    }

    const finalizeResponse = await fetchWithAuth(
      `${CHAT_API_PREFIX}/${rotation.conversation_id}/members/self-leave/finalize`,
      {
        method: 'POST',
        body: JSON.stringify({
          operation_id: rotation.operation_id,
          mls_artifacts: mlsArtifacts,
        }),
      },
    );
    const finalizeData = await finalizeResponse.json();
    if (!finalizeData.success) {
      throw createApiError(finalizeData);
    }

    const resolvedKeyVersion = normalizeKeyVersion(
      finalizeData.key_version,
      rotation.pending_key_version,
    );
    const alreadyFinalized = Boolean(finalizeData.already_finalized);

    // A racing client must never keep its losing staged key. It syncs the
    // winning finalizer's snapshot/commit instead.
    if (!alreadyFinalized) {
      await keyManager.storeGroupKey(
        getConversationKeyId(conversation),
        resolvedKeyVersion,
        mlsKey,
      );
    }

    // Finalization is already durable. A temporary inbox-sync failure must
    // not make the completed rotation look stuck to the finalizing client.
    await chatCryptoProtocolService.syncInbox(currentUserId, true, {
      forceArchiveSync: true,
    }).catch((error) => {
      console.warn('[SELF_LEAVE] finalized but local inbox sync was deferred', {
        conversation_id: rotation.conversation_id,
        operation_id: rotation.operation_id,
        error: error instanceof Error ? error.message : String(error || ''),
      });
    });
    await notifyMembershipUpdate(rotation.conversation_id);

    return {
      removed_user_id: finalizeData.removed_user_id || rotation.target_user_id,
      key_version: resolvedKeyVersion,
      already_finalized: alreadyFinalized,
    };
  });

  selfLeaveFinalizationRequests.set(rotation.operation_id, request);
  void request.then(
    () => selfLeaveFinalizationRequests.delete(rotation.operation_id),
    () => selfLeaveFinalizationRequests.delete(rotation.operation_id),
  );
  return request;
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

export async function transferConversationOwnership(
  conversationId: string,
  targetUserId: string,
): Promise<{ conversation: Conversation }> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/members/transfer-ownership`, {
    method: 'POST',
    body: JSON.stringify({ target_user_id: targetUserId }),
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return { conversation: data.conversation };
}

export async function updateConversationNickname(
  conversationId: string,
  userId: string,
  nickname: string | null,
): Promise<{ nickname: string | null }> {
  const response = await fetchWithAuth(
    `${CHAT_API_PREFIX}/${conversationId}/members/${userId}/conversation-nickname`,
    {
      method: 'PATCH',
      body: JSON.stringify({ nickname }),
    },
  );
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return { nickname: data.nickname };
}

export async function getConversationPermissions(
  conversationId: string,
): Promise<GroupPermissions> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/permissions`);
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return data.permissions;
}

export async function updateConversationPermissions(
  conversationId: string,
  permissions: Partial<GroupPermissions>,
): Promise<GroupPermissions> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({ permissions }),
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error);
  return data.permissions;
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
