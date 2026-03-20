import { fetchWithAuth } from '../Auth/authServiceApi';
import { keyManager } from '../Crypto/keyManager';
import { distributeGroupSenderKeyWithProtocol } from './chatCryptoService';
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
  getConversationKeyId,
  getErrorMessage,
  isRollbackableMlsAddFailure,
  normalizeKeyVersion,
  notifyMembershipUpdate,
  refreshConversationKeyVersion,
  withMembershipLock,
} from './chatUtils';

async function rollbackFailedApproval(
  keyConversationId: string,
  requestId: number,
  failedKeyVersion: number,
): Promise<void> {
  const response = await fetchWithAuth(
    `${CHAT_API_PREFIX}/${keyConversationId}/invites/requests/${requestId}/rollback-approval`,
    {
      method: 'POST',
      body: JSON.stringify({
        failed_key_version: failedKeyVersion,
      }),
    },
  );
  const data = await response.json();
  if (!data.success) {
    throw createApiError(data);
  }
}

export function approveConversationJoinRequest(
  conversation: Conversation,
  currentUserId: string,
  currentMemberIds: string[],
  requestId: number,
  requesterUserId: string,
): Promise<{ approved_user_id: string; key_version: number }> {
  const keyConversationId = getConversationKeyId(conversation);
  return withMembershipLock(keyConversationId, async () => {
    ensureKeyRotationEnabled();
    const freshConversation = await refreshConversationKeyVersion(keyConversationId, conversation);
    const finalMemberIds = [...new Set([...currentMemberIds, requesterUserId, currentUserId])];
    const nextKeyVersion = normalizeKeyVersion(freshConversation.current_key_version, 1) + 1;

    const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${keyConversationId}/invites/requests/${requestId}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        new_key_version: nextKeyVersion,
      }),
    });
    const data = await response.json();
    if (!data.success) throw createApiError(data);
    const resolvedKeyVersion = data.key_version || nextKeyVersion;

    let mlsKey: CryptoKey;
    try {
      ({ key: mlsKey } = await distributeGroupSenderKeyWithProtocol(
        { ...freshConversation, id: keyConversationId, current_key_version: resolvedKeyVersion },
        currentUserId,
        finalMemberIds,
      ));
    } catch (error) {
      if (!isRollbackableMlsAddFailure(error)) {
        throw error;
      }

      const rollbackNotice = 'Server membership was rolled back.';
      try {
        await rollbackFailedApproval(keyConversationId, requestId, resolvedKeyVersion);
      } catch (rollbackError) {
        throw new Error(`${getErrorMessage(error)} Server membership rollback failed; manual cleanup required. ${getErrorMessage(rollbackError)}`);
      }

      throw new Error(`${getErrorMessage(error)} ${rollbackNotice}`);
    }

    await keyManager.storeGroupKey(keyConversationId, resolvedKeyVersion, mlsKey);
    await notifyMembershipUpdate(keyConversationId);

    return {
      approved_user_id: data.approved_user_id || requesterUserId,
      key_version: resolvedKeyVersion,
    };
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
): Promise<{ status: 'pending'; request_id: number; created_at: string }> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/invite-links/${code}/request`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const data = await response.json();
  if (!data.success) throw createApiError(data);
  return data;
}
