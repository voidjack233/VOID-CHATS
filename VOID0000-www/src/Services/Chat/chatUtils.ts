import { fetchWithAuth } from '../Auth/authServiceApi';
import type { Conversation } from './chatTypes';

export const CHAT_API_PREFIX = '/api/conversations';
export const CHAT_KEY_ROTATION_ENABLED = true;
export const CHAT_DEFAULT_MLS_MESSAGE_TYPE = 'mls_application';
export const CHAT_MLS_ROLLOUT_DATE_MS = Date.parse('2026-03-15T00:00:00.000Z');

const membershipLocks = new Map<string, Promise<unknown>>();

export function withMembershipLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const previous = membershipLocks.get(conversationId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  membershipLocks.set(conversationId, next);
  next.finally(() => {
    if (membershipLocks.get(conversationId) === next) {
      membershipLocks.delete(conversationId);
    }
  });
  return next;
}

export function createApiError(data: any): Error & Record<string, any> {
  const message =
    (typeof data?.error === 'string' && data.error.trim()) ||
    (typeof data?.message === 'string' && data.message.trim()) ||
    (typeof data?.code === 'string' && data.code.trim()) ||
    'Request failed';
  const error = new Error(message) as Error & Record<string, any>;
  if (data && typeof data === 'object') {
    Object.assign(error, data);
  }
  return error;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error || 'Request failed');
}

export function isRollbackableMlsAddFailure(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    return (
      (error as { code?: unknown }).code === 'MLS_ADD_KEY_PACKAGE_MISSING' ||
      (error as { code?: unknown }).code === 'MLS_DISTRIBUTE_SYNC_REQUIRED'
    );
  }

  const message = getErrorMessage(error);
  return (
    message.includes('not ready for secure group add yet') ||
    message.includes('Local MLS state is behind the server') ||
    message.includes('Local MLS state could not apply this membership change')
  );
}

export function normalizeKeyVersion(value: unknown, fallback = 1): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}

export function ensureKeyRotationEnabled(): void {
  if (!CHAT_KEY_ROTATION_ENABLED) {
    throw new Error('Membership updates are temporarily paused while encrypted key delivery is stabilized.');
  }
}

export function getConversationKeyId(conversation: Conversation): string {
  return conversation.parent_conversation_id || conversation.id;
}

export async function refreshConversationKeyVersion(
  keyConversationId: string,
  fallback: Conversation,
): Promise<Conversation> {
  try {
    const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${keyConversationId}`);
    const data = await response.json();
    if (data.success && data.conversation) {
      return {
        ...fallback,
        current_key_version: normalizeKeyVersion(data.conversation.current_key_version, 1),
      };
    }
  } catch {
    // Fall through to the caller-provided conversation snapshot.
  }

  return fallback;
}

export async function notifyMembershipUpdate(keyConversationId: string): Promise<void> {
  try {
    await fetchWithAuth(`${CHAT_API_PREFIX}/${keyConversationId}/members/emit-update`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch {
    // Best-effort only; other members can catch up on next sync.
  }
}
