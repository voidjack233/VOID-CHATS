import type { RefObject } from 'react';
import type { Conversation, ConversationMember } from '../Chat/chatService';

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'active' | 'ended' | 'failed';

export type VoiceMediaTrackConstraints = MediaTrackConstraints & {
  latency?: ConstrainDouble;
  suppressLocalAudioPlayback?: ConstrainBoolean;
  voiceIsolation?: ConstrainBoolean;
};

export type BrowserWindowWithAudioContext = Window & {
  webkitAudioContext?: typeof AudioContext;
};

export type CallDebugState = {
  localStream: boolean;
  remoteStream: boolean;
  ice: RTCIceConnectionState | 'new';
  peer: RTCPeerConnectionState | 'new';
  signaling: RTCSignalingState | 'stable';
  last: string;
};

export interface CallEventPayload {
  event?: string;
  call_id?: string;
  conversation_id?: string;
  conversation_public_id?: string | null;
  from_user_id?: string;
  target_user_id?: string;
  media?: 'audio' | 'video';
  reason?: string;
  clear_reason?: string;
  sdp?: string;
  sdp_base64?: string;
  candidate_init?: RTCIceCandidateInit;
  call_status?: string;
  call_duration_seconds?: number;
}

export interface PendingIncomingCall {
  call_id: string;
  conversation_id?: string;
  conversation_public_id?: string | null;
  conversation_type?: string | null;
  from_user_id: string;
  media?: 'audio' | 'video';
}

export interface CallControllerProps {
  conversation: Conversation | null;
  members: Record<string, ConversationMember>;
  currentUserId?: string;
  pendingIncomingCall?: PendingIncomingCall | null;
  autoAnswerIncomingCallId?: string | null;
  mobileAnchorRef?: RefObject<HTMLElement | null>;
  onAutoAnswerIncomingHandled?: (callId: string) => void;
  onPendingIncomingHandled?: (callId: string) => void;
}

export type CallShelfFrame = {
  left: number;
  top: number;
  width: number;
  isMobile: boolean;
};
