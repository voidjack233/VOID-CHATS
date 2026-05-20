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

  return (payload || { success: true }) as CallSignalResponse;
}
