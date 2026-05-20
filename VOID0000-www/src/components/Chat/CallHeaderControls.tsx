import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Mic, MicOff, MonitorUp, Phone, PhoneCall, PhoneOff, Video } from 'lucide-react';
import type { Conversation, ConversationMember } from '../../Services/Chat/chatService';
import { sendCallSignal } from '../../Services/Calls/callService';
import { gateway } from '../../Services/Gateway/gateway';
import UserAvatar from '../common/UserAvatar';

type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'active' | 'ended' | 'failed';
type CallDebugState = {
  localStream: boolean;
  remoteStream: boolean;
  ice: RTCIceConnectionState | 'new';
  peer: RTCPeerConnectionState | 'new';
  signaling: RTCSignalingState | 'stable';
  last: string;
};

interface CallEventPayload {
  event?: string;
  call_id?: string;
  conversation_id?: string;
  conversation_public_id?: string | null;
  from_user_id?: string;
  target_user_id?: string;
  media?: 'audio' | 'video';
  reason?: string;
  sdp?: string;
  sdp_base64?: string;
  candidate_init?: RTCIceCandidateInit;
}

export interface PendingIncomingCall {
  call_id: string;
  conversation_id?: string;
  conversation_public_id?: string | null;
  from_user_id: string;
  media?: 'audio' | 'video';
}

interface CallHeaderControlsProps {
  conversation: Conversation;
  members: Record<string, ConversationMember>;
  currentUserId?: string;
  pendingIncomingCall?: PendingIncomingCall | null;
  onPendingIncomingHandled?: (callId: string) => void;
}

function createCallId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function getDirectTargetUserId(
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

function isConversationEvent(conversation: Conversation, payload: CallEventPayload) {
  return payload.conversation_id === conversation.id ||
    Boolean(conversation.public_id && payload.conversation_public_id === conversation.public_id);
}

function encodeSdp(sdp: string) {
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

function resolveSignalSdp(payload: CallEventPayload) {
  if (payload.sdp_base64) {
    return decodeSdp(payload.sdp_base64);
  }
  return payload.sdp || '';
}

export default function CallHeaderControls({
  conversation,
  members,
  currentUserId,
  pendingIncomingCall,
  onPendingIncomingHandled,
}: CallHeaderControlsProps) {
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [remoteUserId, setRemoteUserId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mediaReady, setMediaReady] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [debugState, setDebugState] = useState<CallDebugState>({
    localStream: false,
    remoteStream: false,
    ice: 'new',
    peer: 'new',
    signaling: 'stable',
    last: 'idle',
  });
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const callIdRef = useRef<string | null>(null);
  const remoteUserIdRef = useRef<string | null>(null);

  const targetUserId = useMemo(
    () => getDirectTargetUserId(conversation, members, currentUserId),
    [conversation, currentUserId, members],
  );
  const currentMember = useMemo(
    () => Object.values(members).find((member) => member.user_id === currentUserId) || null,
    [currentUserId, members],
  );
  const remoteMember = useMemo(
    () => Object.values(members).find((member) => member.user_id === remoteUserId) || null,
    [members, remoteUserId],
  );
  const supportsDirectCall = Boolean(targetUserId);
  const busy = phase === 'outgoing';
  const showCallShelf = phase !== 'idle' && phase !== 'ended';

  const updateDebug = useCallback((patch: Partial<CallDebugState>) => {
    setDebugState((current) => ({ ...current, ...patch }));
  }, []);

  useEffect(() => {
    callIdRef.current = callId;
  }, [callId]);

  useEffect(() => {
    remoteUserIdRef.current = remoteUserId;
  }, [remoteUserId]);

  const stopLocalMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setMediaReady(false);
    setIsMuted(false);
    updateDebug({ localStream: false });
  }, [updateDebug]);

  const closePeerConnection = useCallback(() => {
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    pendingIceCandidatesRef.current = [];
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
    updateDebug({
      remoteStream: false,
      ice: 'new',
      peer: 'new',
      signaling: 'stable',
    });
  }, [updateDebug]);

  const cleanupMedia = useCallback(() => {
    closePeerConnection();
    stopLocalMedia();
  }, [closePeerConnection, stopLocalMedia]);

  const resetCall = useCallback((message?: string) => {
    cleanupMedia();
    setPhase(message ? 'ended' : 'idle');
    setCallId(null);
    setRemoteUserId(null);
    setNotice(message || null);
    if (message) {
      window.setTimeout(() => {
        setPhase('idle');
        setNotice(null);
      }, 2500);
    }
  }, [cleanupMedia]);

  const sendSignal = useCallback(async (
    event: 'CALL_INVITE' | 'CALL_ACCEPT' | 'CALL_REJECT' | 'CALL_CANCEL' | 'CALL_END' | 'WEBRTC_OFFER' | 'WEBRTC_ANSWER' | 'ICE_CANDIDATE',
    target: string,
    activeCallId: string,
    options?: {
      reason?: string;
      sdp?: string;
      candidateInit?: RTCIceCandidateInit;
    },
  ) => {
    await sendCallSignal({
      event,
      conversationId: conversation.id,
      targetUserId: target,
      callId: activeCallId,
      media: 'audio',
      reason: options?.reason,
      sdpBase64: options?.sdp ? encodeSdp(options.sdp) : undefined,
      candidateInit: options?.candidateInit,
    });
  }, [conversation.id]);

  const ensureLocalStream = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot access microphone calls.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    localStreamRef.current = stream;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !isMuted;
    });
    setMediaReady(true);
    updateDebug({ localStream: true, last: 'microphone ready' });
    return stream;
  }, [isMuted, updateDebug]);

  const toggleMute = useCallback(() => {
    setIsMuted((current) => {
      const next = !current;
      localStreamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      updateDebug({ last: next ? 'microphone muted' : 'microphone unmuted' });
      return next;
    });
  }, [updateDebug]);

  const createPeerConnection = useCallback((target: string, activeCallId: string) => {
    if (peerConnectionRef.current) return peerConnectionRef.current;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      updateDebug({ last: 'sending ICE candidate' });
      void sendSignal('ICE_CANDIDATE', target, activeCallId, {
        candidateInit: event.candidate.toJSON(),
      }).catch((err) => {
        console.error('Failed to send ICE candidate:', err);
      });
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (remoteAudioRef.current && stream) {
        updateDebug({ remoteStream: true, last: 'remote audio stream received' });
        remoteAudioRef.current.srcObject = stream;
        void remoteAudioRef.current.play().catch(() => {
          setNotice('Call connected. Tap the call area if audio does not start.');
          updateDebug({ last: 'remote audio autoplay blocked' });
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      updateDebug({ ice: pc.iceConnectionState, last: `ice ${pc.iceConnectionState}` });
    };

    pc.onsignalingstatechange = () => {
      updateDebug({ signaling: pc.signalingState, last: `signaling ${pc.signalingState}` });
    };

    pc.onconnectionstatechange = () => {
      updateDebug({ peer: pc.connectionState, last: `peer ${pc.connectionState}` });
      if (pc.connectionState === 'connected') {
        setPhase('active');
        setNotice('Audio connected');
      } else if (['failed', 'disconnected'].includes(pc.connectionState)) {
        setNotice('Call connection is unstable');
      }
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [resetCall, sendSignal, updateDebug]);

  const attachLocalTracks = useCallback(async (pc: RTCPeerConnection) => {
    const stream = await ensureLocalStream();
    const existingTrackIds = new Set(pc.getSenders().map((sender) => sender.track?.id).filter(Boolean));
    stream.getTracks().forEach((track) => {
      if (!existingTrackIds.has(track.id)) {
        pc.addTrack(track, stream);
      }
    });
  }, [ensureLocalStream]);

  const flushPendingIceCandidates = useCallback(async (pc: RTCPeerConnection) => {
    if (!pc.remoteDescription) return;
    const pending = pendingIceCandidatesRef.current.splice(0);
    for (const candidate of pending) {
      await pc.addIceCandidate(candidate).catch((err) => {
        console.error('Failed to apply queued ICE candidate:', err);
      });
    }
  }, []);

  const sendOffer = useCallback(async (target: string, activeCallId: string) => {
    const pc = createPeerConnection(target, activeCallId);
    await attachLocalTracks(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    updateDebug({ last: 'offer sent' });
    await sendSignal('WEBRTC_OFFER', target, activeCallId, { sdp: offer.sdp || '' });
  }, [attachLocalTracks, createPeerConnection, sendSignal, updateDebug]);

  const answerOffer = useCallback(async (target: string, activeCallId: string, sdp: string) => {
    const pc = createPeerConnection(target, activeCallId);
    await attachLocalTracks(pc);
    await pc.setRemoteDescription({ type: 'offer', sdp });
    updateDebug({ last: 'offer received' });
    await flushPendingIceCandidates(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendSignal('WEBRTC_ANSWER', target, activeCallId, { sdp: answer.sdp || '' });
    updateDebug({ last: 'answer sent' });
    setPhase('active');
    setNotice('Connecting audio...');
  }, [attachLocalTracks, createPeerConnection, flushPendingIceCandidates, sendSignal, updateDebug]);

  const applyAnswer = useCallback(async (sdp: string) => {
    const pc = peerConnectionRef.current;
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp });
    updateDebug({ last: 'answer received' });
    await flushPendingIceCandidates(pc);
    setPhase('active');
    setNotice('Connecting audio...');
  }, [flushPendingIceCandidates, updateDebug]);

  const applyIceCandidate = useCallback(async (candidateInit?: RTCIceCandidateInit) => {
    if (!candidateInit?.candidate) return;
    const pc = peerConnectionRef.current;
    if (!pc || !pc.remoteDescription) {
      pendingIceCandidatesRef.current.push(candidateInit);
      updateDebug({ last: 'queued ICE candidate' });
      return;
    }
    await pc.addIceCandidate(candidateInit).catch((err) => {
      console.error('Failed to apply ICE candidate:', err);
    });
    updateDebug({ last: 'applied ICE candidate' });
  }, [updateDebug]);

  const startCall = useCallback(async () => {
    if (!supportsDirectCall || !targetUserId || busy) return;
    const nextCallId = createCallId();

    setPhase('outgoing');
    setCallId(nextCallId);
    setRemoteUserId(targetUserId);
    setNotice(null);

    try {
      await sendSignal('CALL_INVITE', targetUserId, nextCallId);
      setNotice('Calling...');
    } catch (err) {
      setPhase('failed');
      setNotice(err instanceof Error ? err.message : 'Could not start call');
    }
  }, [busy, sendSignal, supportsDirectCall, targetUserId]);

  const acceptCall = useCallback(async () => {
    if (!callId || !remoteUserId) return;
    try {
      await ensureLocalStream();
      await sendSignal('CALL_ACCEPT', remoteUserId, callId);
      setPhase('active');
      setNotice('Waiting for audio...');
    } catch (err) {
      setPhase('failed');
      setNotice(err instanceof Error ? err.message : 'Could not accept call');
    }
  }, [callId, ensureLocalStream, remoteUserId, sendSignal]);

  const declineOrEndCall = useCallback(async () => {
    if (!callId || !remoteUserId) {
      resetCall();
      return;
    }

    const event = phase === 'outgoing' ? 'CALL_CANCEL' : phase === 'incoming' ? 'CALL_REJECT' : 'CALL_END';
    try {
      await sendSignal(event, remoteUserId, callId, {
        reason: event === 'CALL_REJECT' ? 'declined' : undefined,
      });
    } catch {
      // Local cleanup should still happen even if the peer is already gone.
    }
    resetCall(event === 'CALL_REJECT' ? 'Call declined' : 'Call ended');
  }, [callId, phase, remoteUserId, resetCall, sendSignal]);

  useEffect(() => {
    resetCall();
  }, [conversation.id, resetCall]);

  useEffect(() => () => cleanupMedia(), [cleanupMedia]);

  useEffect(() => {
    if (
      !pendingIncomingCall ||
      !isConversationEvent(conversation, pendingIncomingCall) ||
      pendingIncomingCall.call_id === callIdRef.current
    ) {
      return;
    }

    setPhase('incoming');
    setCallId(pendingIncomingCall.call_id);
    setRemoteUserId(pendingIncomingCall.from_user_id);
    setNotice('Incoming audio call');
    onPendingIncomingHandled?.(pendingIncomingCall.call_id);
  }, [conversation, onPendingIncomingHandled, pendingIncomingCall]);

  useEffect(() => {
    const handleInvite = (payload: CallEventPayload) => {
      if (!isConversationEvent(conversation, payload) || !payload.call_id || !payload.from_user_id) return;
      setPhase('incoming');
      setCallId(payload.call_id);
      setRemoteUserId(payload.from_user_id);
      setNotice('Incoming audio call');
    };

    const handleAccepted = (payload: CallEventPayload) => {
      if (!isConversationEvent(conversation, payload) || payload.call_id !== callId) return;
      setPhase('active');
      setNotice('Starting audio...');
      if (payload.from_user_id && payload.call_id) {
        void sendOffer(payload.from_user_id, payload.call_id).catch((err) => {
          setPhase('failed');
          setNotice(err instanceof Error ? err.message : 'Could not start audio');
        });
      }
    };

    const handleEnded = (payload: CallEventPayload) => {
      if (!isConversationEvent(conversation, payload) || (callId && payload.call_id !== callId)) return;
      resetCall(payload.event === 'CALL_REJECT' ? 'Call declined' : 'Call ended');
    };

    const handleOffer = (payload: CallEventPayload) => {
      if (!isConversationEvent(conversation, payload) || !payload.call_id || !payload.from_user_id || (!payload.sdp && !payload.sdp_base64)) return;
      if (callIdRef.current && payload.call_id !== callIdRef.current) return;
      setPhase('active');
      setCallId(payload.call_id);
      setRemoteUserId(payload.from_user_id);
      setNotice('Answering audio...');
      void answerOffer(payload.from_user_id, payload.call_id, resolveSignalSdp(payload)).catch((err) => {
        setPhase('failed');
        setNotice(err instanceof Error ? err.message : 'Could not answer audio');
      });
    };

    const handleAnswer = (payload: CallEventPayload) => {
      if (!isConversationEvent(conversation, payload) || (!payload.sdp && !payload.sdp_base64)) return;
      if (payload.call_id !== callIdRef.current) return;
      void applyAnswer(resolveSignalSdp(payload)).catch((err) => {
        setPhase('failed');
        setNotice(err instanceof Error ? err.message : 'Could not connect audio');
      });
    };

    const handleIceCandidate = (payload: CallEventPayload) => {
      if (!isConversationEvent(conversation, payload)) return;
      if (payload.call_id !== callIdRef.current) return;
      void applyIceCandidate(payload.candidate_init);
    };

    gateway.on('CALL_INVITE', handleInvite);
    gateway.on('CALL_ACCEPT', handleAccepted);
    gateway.on('CALL_REJECT', handleEnded);
    gateway.on('CALL_CANCEL', handleEnded);
    gateway.on('CALL_END', handleEnded);
    gateway.on('WEBRTC_OFFER', handleOffer);
    gateway.on('WEBRTC_ANSWER', handleAnswer);
    gateway.on('ICE_CANDIDATE', handleIceCandidate);

    return () => {
      gateway.off('CALL_INVITE', handleInvite);
      gateway.off('CALL_ACCEPT', handleAccepted);
      gateway.off('CALL_REJECT', handleEnded);
      gateway.off('CALL_CANCEL', handleEnded);
      gateway.off('CALL_END', handleEnded);
      gateway.off('WEBRTC_OFFER', handleOffer);
      gateway.off('WEBRTC_ANSWER', handleAnswer);
      gateway.off('ICE_CANDIDATE', handleIceCandidate);
    };
  }, [answerOffer, applyAnswer, applyIceCandidate, callId, conversation, resetCall, sendOffer]);

  if (conversation.type !== 'dm') {
    return (
      <button
        type="button"
        disabled
        className="ml-2 shrink-0 rounded-lg p-2 text-void-text-muted/45"
        title="Group calls are coming after direct calls"
      >
        <Phone className="h-4 w-4" />
      </button>
    );
  }

  const getMemberDisplayName = (member: ConversationMember | null, fallback: string) =>
    member?.display_name || member?.username || fallback;

  return (
    <div className="ml-2 flex shrink-0 items-center gap-2">
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      {showCallShelf && (
        <div className="absolute left-1/2 top-[calc(100%+0.75rem)] z-50 w-[min(680px,calc(100vw-1rem))] -translate-x-1/2 px-2">
          <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#111827]/80 px-4 py-4 text-white shadow-2xl shadow-black/35 backdrop-blur-xl sm:px-8">
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-white/5 via-transparent to-white/5" />
            <div className="relative flex items-center justify-between gap-4">
              <div className="flex min-w-0 flex-1 items-center justify-center">
                <div className="flex flex-col items-center gap-2">
                  <UserAvatar
                    src={currentMember?.avatar_url}
                    displayName={getMemberDisplayName(currentMember, 'You')}
                    username={currentMember?.username}
                    className="h-16 w-16 rounded-full border border-white/10 bg-blue-500/25 text-lg shadow-lg sm:h-24 sm:w-24 sm:text-2xl"
                    fallbackClassName="bg-blue-500/25 text-blue-50"
                    fallbackTone="plain"
                  />
                  <span className="max-w-[96px] truncate text-xs font-semibold text-white/75 sm:max-w-[140px]">
                    You
                  </span>
                </div>
              </div>

              <div className="flex shrink-0 flex-col items-center gap-2">
                <div className="flex items-center gap-2 sm:gap-3">
                  <button
                    type="button"
                    disabled
                    className="flex h-11 w-11 cursor-not-allowed items-center justify-center rounded-full bg-white/10 text-white/35 sm:h-14 sm:w-14"
                    title="Video is not enabled yet"
                    aria-label="Video is not enabled yet"
                  >
                    <Video className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    disabled
                    className="flex h-11 w-11 cursor-not-allowed items-center justify-center rounded-full bg-white/10 text-white/35 sm:h-14 sm:w-14"
                    title="Screen share is not enabled yet"
                    aria-label="Screen share is not enabled yet"
                  >
                    <MonitorUp className="h-5 w-5" />
                  </button>
                  {phase === 'incoming' ? (
                    <button
                      type="button"
                      onClick={acceptCall}
                      disabled={!supportsDirectCall}
                      className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-950/30 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50 sm:h-14 sm:w-14"
                      title="Answer call"
                      aria-label="Answer call"
                    >
                      <PhoneCall className="h-5 w-5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={toggleMute}
                      disabled={!mediaReady}
                      className={`flex h-11 w-11 items-center justify-center rounded-full shadow-lg transition disabled:cursor-not-allowed disabled:opacity-50 sm:h-14 sm:w-14 ${
                        isMuted
                          ? 'bg-amber-400 text-neutral-950 shadow-amber-950/20 hover:bg-amber-300'
                          : 'bg-white/12 text-white shadow-black/20 hover:bg-white/18'
                      }`}
                      title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                      aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                    >
                      {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={declineOrEndCall}
                    disabled={!supportsDirectCall && phase === 'incoming'}
                    className="flex h-11 w-11 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-950/35 transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50 sm:h-14 sm:w-14"
                    title={phase === 'incoming' ? 'Decline call' : 'End call'}
                    aria-label={phase === 'incoming' ? 'Decline call' : 'End call'}
                  >
                    <PhoneOff className="h-5 w-5" />
                  </button>
                </div>
                <div className="max-w-[260px] truncate text-center text-xs font-medium text-white/65">
                  {notice || (phase === 'outgoing' ? 'Calling...' : phase === 'incoming' ? 'Incoming audio call' : 'Audio call')}
                  {phase === 'active' && (
                    <span className="hidden sm:inline">
                      {' '}· {debugState.remoteStream ? 'remote audio ready' : 'waiting for remote audio'}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex min-w-0 flex-1 items-center justify-center">
                <div className="flex flex-col items-center gap-2">
                  <UserAvatar
                    src={remoteMember?.avatar_url}
                    displayName={getMemberDisplayName(remoteMember, 'Caller')}
                    username={remoteMember?.username}
                    className="h-16 w-16 rounded-full border border-white/10 bg-blue-500/25 text-lg shadow-lg sm:h-24 sm:w-24 sm:text-2xl"
                    fallbackClassName="bg-blue-500/25 text-blue-50"
                    fallbackTone="plain"
                  />
                  <span className="max-w-[96px] truncate text-xs font-semibold text-white/75 sm:max-w-[140px]">
                    {getMemberDisplayName(remoteMember, phase === 'incoming' ? 'Incoming call' : 'Calling')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={phase === 'idle' || phase === 'failed' ? startCall : undefined}
        disabled={!supportsDirectCall || busy || showCallShelf}
        className={`rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          showCallShelf
            ? 'bg-emerald-500/10 text-emerald-200'
            : 'text-void-text-muted hover:bg-void-bg-hover hover:text-void-text'
        }`}
        title={supportsDirectCall ? (showCallShelf ? 'Call controls are below' : 'Start audio call') : 'Call unavailable'}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : showCallShelf ? <PhoneCall className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
      </button>
    </div>
  );
}
