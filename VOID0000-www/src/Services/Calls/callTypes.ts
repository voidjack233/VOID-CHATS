export type CallMedia = 'audio' | 'video';
export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'active' | 'ended' | 'failed';
export type CallTerminalStatus = 'ended' | 'rejected' | 'cancelled' | 'missed';

export interface SfuJoinInfo {
  configured: boolean;
  provider: string;
  url: string | null;
  room_name: string;
  participant_identity: string;
  participant_name: string;
  token: string | null;
  message?: string;
}

export interface SfuCallSnapshot {
  call_id: string;
  conversation_id: string;
  conversation_public_id?: string | null;
  conversation_type?: string | null;
  from_user_id: string;
  target_user_id: string;
  peer_user_id: string;
  media: CallMedia;
  status: 'ringing' | 'active' | CallTerminalStatus;
  direction: 'incoming' | 'outgoing';
  sfu_provider: string;
  sfu_room_name: string;
  started_at?: string | null;
  answered_at?: string | null;
  ended_at?: string | null;
  ended_by?: string | null;
  end_reason?: string | null;
}

export interface SfuCallEventPayload {
  event: 'CALL_INVITE' | 'CALL_ACCEPT' | 'CALL_REJECT' | 'CALL_CANCEL' | 'CALL_END' | 'CALL_STATE';
  call_id: string;
  conversation_id: string;
  conversation_public_id?: string | null;
  conversation_type?: string | null;
  from_user_id: string;
  target_user_id: string;
  media?: CallMedia;
  status?: SfuCallSnapshot['status'];
  sfu_provider?: string;
  sfu_room_name?: string;
  started_at?: string | null;
  answered_at?: string | null;
  ended_at?: string | null;
  ended_by?: string | null;
  end_reason?: string | null;
}
