import { fetchWithAuth } from '../Auth/authServiceApi';
import type { Conversation } from './chatTypes';

export const CHAT_API_PREFIX = '/api/conversations';
export const CHAT_KEY_ROTATION_ENABLED = true;
export const CHAT_DEFAULT_MLS_MESSAGE_TYPE = 'mls_application';
export const CHAT_FORWARDED_MLS_MESSAGE_TYPE = 'mls_forwarded';
export const CHAT_MLS_ROLLOUT_DATE_MS = Date.parse('2026-03-15T00:00:00.000Z');

const membershipLocks = new Map<string, Promise<unknown>>();

export function withMembershipLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const previous = membershipLocks.get(conversationId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  membershipLocks.set(conversationId, next);
  const cleanup = () => {
    if (membershipLocks.get(conversationId) === next) {
      membershipLocks.delete(conversationId);
    }
  };
  void next.then(cleanup, cleanup);
  return next;
}

export function createApiError(data: any, meta?: Record<string, unknown>): Error & Record<string, any> {
  const message =
    (typeof data?.error === 'string' && data.error.trim()) ||
    (typeof data?.message === 'string' && data.message.trim()) ||
    (typeof data?.code === 'string' && data.code.trim()) ||
    'Request failed';
  const error = new Error(message) as Error & Record<string, any>;
  if (data && typeof data === 'object') {
    Object.assign(error, data);
  }
  if (meta && typeof meta === 'object') {
    Object.assign(error, meta);
  }
  return error;
}

export function getRetryAfterMsFromResponse(response: Response): number | null {
  const retryAfter = response.headers.get('Retry-After');
  if (!retryAfter) {
    return null;
  }

  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return retryAfterSeconds * 1000;
  }

  const retryAfterDate = Date.parse(retryAfter);
  if (Number.isFinite(retryAfterDate)) {
    return Math.max(0, retryAfterDate - Date.now());
  }

  return null;
}

export function getRetryAfterMsFromError(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const payload = error as Record<string, unknown>;
  if (payload.retryAfterMs !== null && payload.retryAfterMs !== undefined) {
    const retryAfterMs = Number(payload.retryAfterMs);
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
      return retryAfterMs;
    }
  }

  if (payload.retryAfterSeconds !== null && payload.retryAfterSeconds !== undefined) {
    const retryAfterSeconds = Number(payload.retryAfterSeconds);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return retryAfterSeconds * 1000;
    }
  }

  if (payload.resetTime !== null && payload.resetTime !== undefined) {
    const resetTime = Number(payload.resetTime);
    if (Number.isFinite(resetTime) && resetTime > 0) {
      return Math.max(0, resetTime - Date.now());
    }
  }

  return null;
}

export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const payload = error as Record<string, unknown>;
  return Number(payload.status ?? payload.statusCode) === 429 ||
    payload.code === 'RATE_LIMITED' ||
    payload.error === 'RATE_LIMITED';
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

export async function fetchActiveConversationMemberIds(conversationId: string): Promise<string[]> {
  const response = await fetchWithAuth(`${CHAT_API_PREFIX}/${conversationId}`);
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw createApiError(data, { status: response.status });
  }

  const members = Array.isArray(data.conversation?.members) ? data.conversation.members : [];
  const memberIds = members.flatMap((member: unknown) => {
    if (!member || typeof member !== 'object') return [];
    const userId = (member as { user_id?: unknown }).user_id;
    return typeof userId === 'string' && userId.length > 0 ? [userId] : [];
  });
  return [...new Set<string>(memberIds)];
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
