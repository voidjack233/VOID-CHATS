import { fetchWithAuth } from '../Auth/authServiceApi';
import { keyManager } from '../Crypto/keyManager';
import type { MlsMembershipFinalizeArtifacts } from '../Crypto/mls/mlsTypes';
import { chatCryptoProtocolService } from '../Crypto/protocols/chatCryptoProtocolService';
import { distributeGroupSenderKeyWithProtocol } from './chatCryptoService';
import { requestSelfLeaveRecoveryScan } from './selfLeaveRecoveryEvents';
import type {
  Conversation,
  ConversationInviteLink,
  ConversationJoinRequest,
  InvitePreview,
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

const JOIN_REQUEST_KEY_PREP_ERROR =
  'Secure join keys are still preparing. Refresh VOID and try requesting again.';
const JOIN_APPROVAL_PREPARATION_ERROR =
  'Secure join approval could not be prepared. Ask the requester to refresh VOID, then retry approval.';

async function rollbackFailedApproval(
  keyConversationId: string,
  requestId: number,
  failedKeyVersion: number,
  operationId: string,
): Promise<void> {
  const response = await fetchWithAuth(
    `${CHAT_API_PREFIX}/${keyConversationId}/invites/requests/${requestId}/rollback-approval`,
    {
      method: 'POST',
      body: JSON.stringify({
        failed_key_version: failedKeyVersion,
        operation_id: operationId,
      }),
    },
  );
  const data = await response.json();
  if (!data.success) {
    throw createApiError(data);
  }
}

function createInviteError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function isMlsSyncRequiredError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    return (error as { code?: unknown }).code === 'MLS_DISTRIBUTE_SYNC_REQUIRED';
  }

  const message = getErrorMessage(error);
  return (
    message.includes('Local MLS state is behind the server') ||
    message.includes('Local MLS state could not apply this membership change')
  );
}

function isMlsArtifactValidationFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as Record<string, unknown>;
  const message = String(payload.error || payload.message || '');
  return (
    payload.code === 'MLS_ARTIFACTS_INVALID' ||
    message.includes('Welcome payload') ||
    message.includes('joining member')
  );
}

function hasExpectedJoinWelcome(
  artifacts: MlsMembershipFinalizeArtifacts,
  requesterUserId: string,
): boolean {
  const welcomes = Array.isArray(artifacts.welcomes) ? artifacts.welcomes : [];
  const welcome = welcomes[0];
  return (
    welcomes.length === 1 &&
    welcome?.userId === requesterUserId &&
    typeof welcome?.payload === 'string' &&
    welcome.payload.length > 0
  );
}

export function approveConversationJoinRequest(
  conversation: Conversation,
  currentUserId: string,
  _currentMemberIds: string[],
  requestId: number,
  requesterUserId: string,
): Promise<{ approved_user_id: string; key_version: number }> {
  const keyConversationId = getConversationKeyId(conversation);
  return withMembershipLock(keyConversationId, async () => {
    ensureKeyRotationEnabled();
    const freshConversation = await refreshConversationKeyVersion(keyConversationId, conversation);
    const activeMemberIds = await fetchActiveConversationMemberIds(keyConversationId);
    const finalMemberIds = [...new Set([...activeMemberIds, requesterUserId, currentUserId])];
    const nextKeyVersion = normalizeKeyVersion(freshConversation.current_key_version, 1) + 1;
    if (normalizeKeyVersion(freshConversation.current_key_version, 1) > 1) {
      await chatCryptoProtocolService.syncInbox(currentUserId, true, { forceArchiveSync: true }).catch((error) => {
        console.warn('[APPROVE_JOIN] pre-approval MLS sync failed', {
          conversation_id: keyConversationId,
          error: error instanceof Error ? error.message : String(error || ''),
        });
      });
    }
    const localMemberIds = await chatCryptoProtocolService.getLocalGroupMemberUserIds(keyConversationId);
    const shouldForceRequesterReadd = localMemberIds?.includes(requesterUserId) === true;
    if (shouldForceRequesterReadd) {
      console.warn('[APPROVE_JOIN] requester already present in local MLS state; forcing targeted re-add', {
        conversation_id: keyConversationId,
        requester_user_id: requesterUserId,
      });
    }

    const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${keyConversationId}/invites/requests/${requestId}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        new_key_version: nextKeyVersion,
      }),
    });
    const data = await response.json();
    if (!data.success) {
      if (data?.code === 'MEMBERSHIP_ROTATION_PENDING') {
        requestSelfLeaveRecoveryScan('invite_approval_membership_pending');
      }
      throw createApiError(data);
    }
    const pendingKeyVersion = data.pending_key_version || nextKeyVersion;
    const operationId = typeof data.operation_id === 'string' ? data.operation_id : '';
    if (!operationId) {
      throw new Error('Secure membership reservation was not returned by the server');
    }

    let mlsKey: CryptoKey | null = null;
    let mlsArtifacts: MlsMembershipFinalizeArtifacts | null | undefined;
    let finalizeStarted = false;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          ({ key: mlsKey, membershipArtifacts: mlsArtifacts } = await distributeGroupSenderKeyWithProtocol(
            { ...freshConversation, id: keyConversationId, current_key_version: pendingKeyVersion },
            currentUserId,
            finalMemberIds,
            {
              stageOnly: true,
              forceReaddMemberUserIds: shouldForceRequesterReadd ? [requesterUserId] : undefined,
            },
          ));
          break;
        } catch (error) {
          if (attempt > 0 || !isMlsSyncRequiredError(error)) {
            throw error;
          }

          await chatCryptoProtocolService.syncInbox(currentUserId, true, { forceArchiveSync: true });
        }
      }

      if (!mlsKey || !mlsArtifacts) {
        throw new Error('Secure membership artifacts could not be prepared');
      }

      if (!hasExpectedJoinWelcome(mlsArtifacts, requesterUserId)) {
        throw createInviteError(
          JOIN_APPROVAL_PREPARATION_ERROR,
          'MLS_ADD_KEY_PACKAGE_MISSING',
        );
      }

      finalizeStarted = true;
      const finalizeResponse = await fetchWithAuth(
        `${CHAT_API_PREFIX}/${keyConversationId}/invites/requests/${requestId}/approve/finalize`,
        {
          method: 'POST',
          body: JSON.stringify({ operation_id: operationId, mls_artifacts: mlsArtifacts }),
        },
      );
      const finalizeData = await finalizeResponse.json();

      if (!finalizeData.success) {
        if (isMlsArtifactValidationFailure(finalizeData)) {
          try {
            await rollbackFailedApproval(keyConversationId, requestId, pendingKeyVersion, operationId);
          } catch (rollbackError) {
            throw new Error(`${JOIN_APPROVAL_PREPARATION_ERROR} Pending approval cleanup failed; manual cleanup may be required. ${getErrorMessage(rollbackError)}`);
          }

          throw new Error(`${JOIN_APPROVAL_PREPARATION_ERROR} Pending approval was cleared.`);
        }

        throw createApiError(finalizeData);
      }

      const resolvedKeyVersion = finalizeData.key_version || pendingKeyVersion;

      await keyManager.storeGroupKey(keyConversationId, resolvedKeyVersion, mlsKey);
      await chatCryptoProtocolService.syncInbox(currentUserId, true).catch((error) => {
        console.warn('[APPROVE_JOIN] finalized but local MLS state refresh failed', {
          conversation_id: keyConversationId,
          key_version: resolvedKeyVersion,
          error: error instanceof Error ? error.message : String(error || ''),
        });
      });
      await notifyMembershipUpdate(keyConversationId);

      return {
        approved_user_id: finalizeData.approved_user_id || requesterUserId,
        key_version: resolvedKeyVersion,
      };
    } catch (error) {
      if (!finalizeStarted) {
        const rollbackNotice = 'Pending approval was cleared.';
        try {
          await rollbackFailedApproval(keyConversationId, requestId, pendingKeyVersion, operationId);
        } catch (rollbackError) {
          throw new Error(`${getErrorMessage(error)} Pending approval cleanup failed; manual cleanup may be required. ${getErrorMessage(rollbackError)}`);
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

export async function declineConversationJoinRequest(
  conversationId: string,
  requestId: number,
): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/invites/requests/${requestId}/decline`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const data = await response.json();
  if (!data.success) throw createApiError(data);
}

export async function getConversationInvites(
  conversationId: string,
): Promise<{
  invites: ConversationInviteLink[];
  pending_requests: ConversationJoinRequest[];
}> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/invites`);
  const data = await response.json();
  if (!data.success) throw createApiError(data);
  return {
    invites: data.invites || [],
    pending_requests: data.pending_requests || [],
  };
}

export async function createConversationInviteLink(
  conversationId: string,
  options?: { expires_in_days?: number; max_uses?: number | null },
): Promise<ConversationInviteLink> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/invites`, {
    method: 'POST',
    body: JSON.stringify({
      expires_in_days: options?.expires_in_days ?? 7,
      max_uses: options?.max_uses ?? null,
    }),
  });
  const data = await response.json();
  if (!data.success) throw createApiError(data);
  return data.invite as ConversationInviteLink;
}

export async function revokeConversationInviteLink(
  conversationId: string,
  inviteId: number,
): Promise<void> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}/invites/${inviteId}/revoke`, {
    method: 'POST',
  });
  const data = await response.json();
  if (!data.success) throw createApiError(data);
}

export async function getInvitePreview(code: string): Promise<InvitePreview> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/invite-links/${code}`);
  const data = await response.json();
  if (!data.success) throw createApiError(data);
  return data.invite as InvitePreview;
}

export async function getInviteRequestStatus(
  code: string,
): Promise<{
  status: 'none' | 'pending' | 'declined' | 'approved' | 'member';
  conversation_public_id?: string | null;
  created_at?: string | null;
  resolved_at?: string | null;
}> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/invite-links/${code}/status`);
  const data = await response.json();
  if (!data.success) throw createApiError(data);
  return data;
}

export async function requestJoinByInviteCode(
  code: string,
  currentUserId?: string,
): Promise<{ status: 'pending'; request_id: number; created_at: string }> {
  if (currentUserId) {
    try {
      await chatCryptoProtocolService.ensureServerKeyPackageReserve(currentUserId);
    } catch (error) {
      console.warn('[INVITE_JOIN] secure key package reserve failed before join request', {
        user_id: currentUserId,
        error: error instanceof Error ? error.message : String(error || ''),
      });
      throw new Error(JOIN_REQUEST_KEY_PREP_ERROR);
    }
  }

  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/invite-links/${code}/request`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const data = await response.json();
  if (!data.success) throw createApiError(data);
  return data;
}
