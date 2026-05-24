import { fetchWithAuth } from '../Auth/authServiceApi';
import type { CallMedia, SfuCallSnapshot, SfuJoinInfo } from './callTypes';

interface CallResponse {
  success: boolean;
  call: SfuCallSnapshot | null;
  sfu?: SfuJoinInfo;
  code?: string;
  message?: string;
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

async function parseCallResponse(response: Response, fallback: string): Promise<CallResponse> {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw createCallError(payload, fallback);
  }

  return (payload || { success: true, call: null }) as CallResponse;
}

export async function getActiveCall(): Promise<SfuCallSnapshot | null> {
  const response = await fetchWithAuth('/api/calls/active');
  const payload = await parseCallResponse(response, 'Failed to inspect active call');
  return payload.call || null;
}

export async function startSfuCall(input: {
  conversationId: string;
  media?: CallMedia;
}): Promise<CallResponse> {
  const response = await fetchWithAuth('/api/calls/start', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: input.conversationId,
      media: input.media || 'audio',
    }),
  });

  return parseCallResponse(response, 'Failed to start call');
}

export async function acceptSfuCall(callId: string): Promise<CallResponse> {
  const response = await fetchWithAuth(`/api/calls/${callId}/accept`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  return parseCallResponse(response, 'Failed to accept call');
}

export async function rejectSfuCall(callId: string): Promise<CallResponse> {
  const response = await fetchWithAuth(`/api/calls/${callId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'declined' }),
  });

  return parseCallResponse(response, 'Failed to decline call');
}

export async function cancelSfuCall(callId: string): Promise<CallResponse> {
  const response = await fetchWithAuth(`/api/calls/${callId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'cancelled' }),
  });

  return parseCallResponse(response, 'Failed to cancel call');
}

export async function endSfuCall(callId: string): Promise<CallResponse> {
  const response = await fetchWithAuth(`/api/calls/${callId}/end`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'ended' }),
  });

  return parseCallResponse(response, 'Failed to end call');
}

export async function createSfuJoinToken(callId: string): Promise<CallResponse> {
  const response = await fetchWithAuth(`/api/calls/${callId}/join`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  return parseCallResponse(response, 'Failed to create SFU join token');
}
