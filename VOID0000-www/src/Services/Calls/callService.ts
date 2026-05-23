import { fetchWithAuth } from '../Auth/authServiceApi';

export type CallSignalEvent =
  | 'CALL_INVITE'
  | 'CALL_ACCEPT'
  | 'CALL_REJECT'
  | 'CALL_CANCEL'
  | 'CALL_END'
  | 'WEBRTC_OFFER'
  | 'WEBRTC_ANSWER'
  | 'ICE_CANDIDATE';

export interface SendCallSignalInput {
  event: CallSignalEvent;
  conversationId: string;
  targetUserId: string;
  callId: string;
  media?: 'audio' | 'video';
  reason?: string;
  sdp?: string;
  sdpBase64?: string;
  candidate?: string;
  candidateInit?: RTCIceCandidateInit;
}

export interface CallSignalResponse {
  success: boolean;
  event_id?: string;
  message?: string;
  code?: string;
}

export interface ActiveCallSnapshot {
  call_id: string;
  conversation_id?: string;
  conversation_public_id?: string | null;
  conversation_type?: string | null;
  from_user_id: string;
  target_user_id: string;
  peer_user_id: string;
  media?: 'audio' | 'video';
  status: 'ringing' | 'active';
  direction: 'incoming' | 'outgoing';
  started_at?: string;
  answered_at?: string | null;
  answered_by_device_id?: string | null;
  answered_here?: boolean;
  duration_seconds?: number;
}

interface ActiveCallRequestOptions {
  force?: boolean;
  maxAgeMs?: number;
  cacheKey?: string | null;
}

const ACTIVE_CALL_CACHE_MS = 5_000;
let activeCallCache: {
  cacheKey: string | null;
  value: ActiveCallSnapshot | null;
  fetchedAt: number;
} | null = null;
let activeCallInFlight: {
  cacheKey: string | null;
  promise: Promise<ActiveCallSnapshot | null>;
} | null = null;

function createCallError(payload: unknown, fallback: string): Error & Record<string, unknown> {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const message =
    (typeof data.message === 'string' && data.message.trim()) ||
    (typeof data.error === 'string' && data.error.trim()) ||
    fallback;
  const error = new Error(message) as Error & Record<string, unknown>;
  Object.assign(error, data);
  return error;
}

export async function sendCallSignal(input: SendCallSignalInput): Promise<CallSignalResponse> {
  const response = await fetchWithAuth('/api/calls/signal', {
    method: 'POST',
    body: JSON.stringify({
      event: input.event,
      conversation_id: input.conversationId,
      target_user_id: input.targetUserId,
      call_id: input.callId,
      media: input.media,
      reason: input.reason,
      sdp: input.sdp,
      sdp_base64: input.sdpBase64,
      candidate: input.candidate,
      candidate_init: input.candidateInit,
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw createCallError(payload, 'Failed to send call signal');
  }

  invalidateActiveCallCache();
  return (payload || { success: true }) as CallSignalResponse;
}

export async function sendCallHeartbeat(callId: string): Promise<ActiveCallSnapshot | null> {
  const response = await fetchWithAuth('/api/calls/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      call_id: callId,
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw createCallError(payload, 'Failed to refresh call session');
  }

  const value = (payload?.call || null) as ActiveCallSnapshot | null;
  activeCallCache = {
    cacheKey: null,
    value,
    fetchedAt: Date.now(),
  };
  return value;
}

export function invalidateActiveCallCache() {
  activeCallCache = null;
  activeCallInFlight = null;
}

export async function getActiveCall(options: ActiveCallRequestOptions = {}): Promise<ActiveCallSnapshot | null> {
  const maxAgeMs = options.maxAgeMs ?? ACTIVE_CALL_CACHE_MS;
  const cacheKey = options.cacheKey ?? null;
  const now = Date.now();

  if (
    !options.force &&
    activeCallCache &&
    activeCallCache.cacheKey === cacheKey &&
    now - activeCallCache.fetchedAt < maxAgeMs
  ) {
    return activeCallCache.value;
  }

  if (activeCallInFlight && activeCallInFlight.cacheKey === cacheKey) {
    return activeCallInFlight.promise;
  }

  const request = (async () => {
    const response = await fetchWithAuth('/api/calls/active');
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw createCallError(payload, 'Failed to inspect active call');
    }

    const value = (payload?.call || null) as ActiveCallSnapshot | null;
    activeCallCache = {
      cacheKey,
      value,
      fetchedAt: Date.now(),
    };
    return value;
  })().finally(() => {
    if (activeCallInFlight?.promise === request) {
      activeCallInFlight = null;
    }
  });

  activeCallInFlight = {
    cacheKey,
    promise: request,
  };

  return request;
}
