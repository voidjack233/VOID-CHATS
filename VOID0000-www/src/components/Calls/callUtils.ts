import type { Conversation, ConversationMember } from '../../Services/Chat/chatService';
import type { CallEventPayload, VoiceMediaTrackConstraints } from './callTypes';

export const OUTGOING_CALL_TIMEOUT_MS = 45_000;
export const REMOTE_AUDIO_VOLUME = 0.82;
export const CALL_SHELF_DRAG_MIN_Y = -96;
export const CALL_SHELF_DRAG_MAX_Y = 360;

export function createCallId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function getDirectTargetUserId(
  conversation: Conversation,
  members: Record<string, ConversationMember>,
  currentUserId?: string,
) {
  if (conversation.type !== 'dm' || !currentUserId) return null;
  if (conversation.dm_user_id && conversation.dm_user_id !== currentUserId) {
    return conversation.dm_user_id;
  }
  return Object.values(members).find((member) => member.user_id !== currentUserId)?.user_id || null;
}

export function isConversationEvent(conversation: Conversation, payload: CallEventPayload) {
  return payload.conversation_id === conversation.id ||
    Boolean(conversation.public_id && payload.conversation_public_id === conversation.public_id);
}

export function encodeSdp(sdp: string) {
  const bytes = new TextEncoder().encode(sdp);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeSdp(encoded: string) {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(encoded.length / 4) * 4,
    '=',
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function resolveSignalSdp(payload: CallEventPayload) {
  if (payload.sdp_base64) {
    return decodeSdp(payload.sdp_base64);
  }
  return payload.sdp || '';
}

export function formatCallDuration(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function getCallStartErrorMessage(error: unknown) {
  const code = error && typeof error === 'object' ? (error as Record<string, unknown>).code : null;
  if (code === 'CALL_ALREADY_IN_PROGRESS') {
    return 'You already have a call in progress';
  }
  if (code === 'CALL_BUSY') {
    return 'This user is already in a call';
  }
  return error instanceof Error ? error.message : 'Could not start call';
}

export function getCallAcceptErrorMessage(error: unknown) {
  const code = error && typeof error === 'object' ? (error as Record<string, unknown>).code : null;
  if (code === 'CALL_ALREADY_ANSWERED') {
    return 'This call was already answered on another device';
  }
  if (code === 'CALL_NOT_RINGING') {
    return 'This call is no longer ringing';
  }
  return error instanceof Error ? error.message : 'Could not accept call';
}

export function getMicrophoneErrorMessage(error: unknown) {
  const name = error && typeof error === 'object' ? (error as { name?: string }).name : '';
  const message = error instanceof Error ? error.message : '';

  if (name === 'NotFoundError' || /device.*not.*found/i.test(message)) {
    return 'No microphone found.';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow microphone permission for this site and try again.';
  }
  if (name === 'NotReadableError') {
    return 'Your microphone is busy or blocked by another app.';
  }
  if (name === 'OverconstrainedError') {
    return 'This microphone does not support the requested voice settings.';
  }

  return message || 'Could not access your microphone.';
}

export function getVoiceAudioConstraints(): VoiceMediaTrackConstraints {
  const supported = typeof navigator !== 'undefined'
    ? navigator.mediaDevices?.getSupportedConstraints?.() ?? {}
    : {};
  const supportedRecord = supported as Record<string, unknown>;
  const constraints: VoiceMediaTrackConstraints = {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 },
  };

  if (supportedRecord.sampleRate) {
    constraints.sampleRate = { ideal: 48000 };
  }
  if (supportedRecord.sampleSize) {
    constraints.sampleSize = { ideal: 16 };
  }
  if (supportedRecord.latency) {
    constraints.latency = { ideal: 0.03 };
  }
  if (supportedRecord.suppressLocalAudioPlayback) {
    constraints.suppressLocalAudioPlayback = { ideal: true };
  }
  if (supportedRecord.voiceIsolation) {
    constraints.voiceIsolation = { ideal: true };
  }

  return constraints;
}
