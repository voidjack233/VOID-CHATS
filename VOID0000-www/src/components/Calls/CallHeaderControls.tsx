import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Phone, PhoneCall } from 'lucide-react';
import type { ConversationMember } from '../../Services/Chat/chatService';
import { sendCallSignal } from '../../Services/Calls/callService';
import { gateway } from '../../Services/Gateway/gateway';
import CallShelf from './CallShelf';
import type { CallDebugState, CallEventPayload, CallHeaderControlsProps, CallPhase, CallShelfFrame } from './callTypes';
import {
  CALL_SHELF_DRAG_MAX_Y,
  CALL_SHELF_DRAG_MIN_Y,
  OUTGOING_CALL_TIMEOUT_MS,
  REMOTE_AUDIO_VOLUME,
  createCallId,
  encodeSdp,
  formatCallDuration,
  getCallAcceptErrorMessage,
  getCallStartErrorMessage,
  getDirectTargetUserId,
  getMicrophoneErrorMessage,
  getVoiceAudioConstraints,
  isConversationEvent,
  resolveSignalSdp,
} from './callUtils';
import { createVoiceActivityWatcher } from './voiceActivity';

export type { PendingIncomingCall } from './callTypes';

export default function CallHeaderControls({
  conversation,
  members,
  currentUserId,
  pendingIncomingCall,
  autoAnswerIncomingCallId,
  mobileAnchorRef,
  onAutoAnswerIncomingHandled,
  onPendingIncomingHandled,
}: CallHeaderControlsProps) {
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [callConversationId, setCallConversationId] = useState<string | null>(null);
  const [remoteUserId, setRemoteUserId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [remoteSpeaking, setRemoteSpeaking] = useState(false);
  const [callCurrentMemberSnapshot, setCallCurrentMemberSnapshot] = useState<ConversationMember | null>(null);
  const [callRemoteMemberSnapshot, setCallRemoteMemberSnapshot] = useState<ConversationMember | null>(null);
  const [microphoneWarning, setMicrophoneWarning] = useState<string | null>(null);
  const [callShelfOffsetY, setCallShelfOffsetY] = useState(0);
  const [mobileShelfFrame, setMobileShelfFrame] = useState<CallShelfFrame | null>(null);
  const [isCallShelfCollapsed, setIsCallShelfCollapsed] = useState(true);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
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
  const callConversationIdRef = useRef<string | null>(null);
  const remoteUserIdRef = useRef<string | null>(null);
  const outgoingTimeoutRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const dragStartRef = useRef<{ pointerId: number; startY: number; startOffsetY: number } | null>(null);
  const phaseRef = useRef<CallPhase>('idle');
  const stopLocalVoiceActivityRef = useRef<(() => void) | null>(null);
  const stopRemoteVoiceActivityRef = useRef<(() => void) | null>(null);

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
  const showCallShelf = phase !== 'idle';

  const updateDebug = useCallback((patch: Partial<CallDebugState>) => {
    setDebugState((current) => ({ ...current, ...patch }));
  }, []);

  useEffect(() => {
    callIdRef.current = callId;
  }, [callId]);

  useEffect(() => {
    callConversationIdRef.current = callConversationId;
  }, [callConversationId]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    remoteUserIdRef.current = remoteUserId;
  }, [remoteUserId]);

  useEffect(() => {
    if (!showCallShelf || !mobileAnchorRef?.current) {
      setMobileShelfFrame(null);
      return;
    }

    const syncFrame = () => {
      const rect = mobileAnchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const isMobile = window.matchMedia('(max-width: 767px)').matches;
      if (isMobile && rect.width <= 0) {
        const viewport = window.visualViewport;
        setMobileShelfFrame({
          left: viewport?.offsetLeft ?? 0,
          top: viewport?.offsetTop ?? 0,
          width: viewport?.width ?? window.innerWidth,
          isMobile,
        });
        return;
      }
      setMobileShelfFrame({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        isMobile,
      });
    };

    syncFrame();
    window.addEventListener('resize', syncFrame);
    window.addEventListener('scroll', syncFrame, true);
    window.visualViewport?.addEventListener('resize', syncFrame);
    window.visualViewport?.addEventListener('scroll', syncFrame);

    return () => {
      window.removeEventListener('resize', syncFrame);
      window.removeEventListener('scroll', syncFrame, true);
      window.visualViewport?.removeEventListener('resize', syncFrame);
      window.visualViewport?.removeEventListener('scroll', syncFrame);
    };
  }, [mobileAnchorRef, showCallShelf]);

  const clearOutgoingTimeout = useCallback(() => {
    if (outgoingTimeoutRef.current !== null) {
      window.clearTimeout(outgoingTimeoutRef.current);
      outgoingTimeoutRef.current = null;
    }
  }, []);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  const stopLocalMedia = useCallback(() => {
    stopLocalVoiceActivityRef.current?.();
    stopLocalVoiceActivityRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setIsMuted(false);
    setLocalSpeaking(false);
    updateDebug({ localStream: false });
  }, [updateDebug]);

  const closePeerConnection = useCallback(() => {
    stopRemoteVoiceActivityRef.current?.();
    stopRemoteVoiceActivityRef.current = null;
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
    setRemoteSpeaking(false);
  }, [updateDebug]);

  const cleanupMedia = useCallback(() => {
    closePeerConnection();
    stopLocalMedia();
  }, [closePeerConnection, stopLocalMedia]);

  const resetCall = useCallback((message?: string) => {
    clearResetTimer();
    cleanupMedia();
    clearOutgoingTimeout();
    setConnectedAt(null);
    setElapsedSeconds(0);
    setPhase(message ? 'ended' : 'idle');
    setNotice(message || null);
    if (message) {
      resetTimerRef.current = window.setTimeout(() => {
        setPhase('idle');
        setNotice(null);
        setCallId(null);
        setCallConversationId(null);
        setRemoteUserId(null);
        setCallCurrentMemberSnapshot(null);
        setCallRemoteMemberSnapshot(null);
        setCallShelfOffsetY(0);
        setIsCallShelfCollapsed(true);
        resetTimerRef.current = null;
      }, 2500);
    } else {
      setCallId(null);
      setCallConversationId(null);
      setRemoteUserId(null);
      setCallCurrentMemberSnapshot(null);
      setCallRemoteMemberSnapshot(null);
      setCallShelfOffsetY(0);
      setIsCallShelfCollapsed(true);
    }
  }, [cleanupMedia, clearOutgoingTimeout, clearResetTimer]);

  const beginCallShelfDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    dragStartRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startOffsetY: callShelfOffsetY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [callShelfOffsetY]);

  const moveCallShelfDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragStartRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextOffset = Math.max(
      CALL_SHELF_DRAG_MIN_Y,
      Math.min(CALL_SHELF_DRAG_MAX_Y, drag.startOffsetY + event.clientY - drag.startY),
    );
    setCallShelfOffsetY(nextOffset);
  }, []);

  const endCallShelfDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragStartRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  useEffect(() => {
    if (!connectedAt || phase !== 'active') return;

    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - connectedAt) / 1000)));
    };

    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(intervalId);
  }, [connectedAt, phase]);

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
      conversationId: callConversationIdRef.current || conversation.id,
      targetUserId: target,
      callId: activeCallId,
      media: 'audio',
      reason: options?.reason,
      sdpBase64: options?.sdp ? encodeSdp(options.sdp) : undefined,
      candidateInit: options?.candidateInit,
    });
  }, [conversation.id]);

  useEffect(() => {
    if (phase !== 'outgoing' || !callId || !remoteUserId) {
      clearOutgoingTimeout();
      return;
    }

    outgoingTimeoutRef.current = window.setTimeout(() => {
      const activeCallId = callIdRef.current;
      const activeRemoteUserId = remoteUserIdRef.current;
      if (!activeCallId || !activeRemoteUserId) return;

      void sendSignal('CALL_CANCEL', activeRemoteUserId, activeCallId, {
        reason: 'missed',
      }).catch(() => {
        // Timing out locally should still clear the ringing UI.
      });
      resetCall('No answer');
    }, OUTGOING_CALL_TIMEOUT_MS);

    return clearOutgoingTimeout;
  }, [callId, clearOutgoingTimeout, phase, remoteUserId, resetCall, sendSignal]);

  const ensureLocalStream = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot access microphone calls.');
    }

    const voiceConstraints = getVoiceAudioConstraints();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: voiceConstraints,
        video: false,
      });
    } catch (error) {
      const errorName = error && typeof error === 'object' ? (error as { name?: string }).name : '';
      if (errorName !== 'OverconstrainedError') {
        throw error;
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    }
    localStreamRef.current = stream;
    stream.getAudioTracks().forEach((track) => {
      track.contentHint = 'speech';
      track.enabled = !isMuted;
      void track.applyConstraints(voiceConstraints).catch(() => {
        // Some browsers accept constraints at getUserMedia but reject reapplying
        // individual advanced keys. The original capture is still usable.
      });
    });
    stopLocalVoiceActivityRef.current?.();
    stopLocalVoiceActivityRef.current = createVoiceActivityWatcher(stream, setLocalSpeaking);
    updateDebug({ localStream: true, last: 'microphone ready' });
    return stream;
  }, [isMuted, updateDebug]);

  const tryEnsureLocalStream = useCallback(async () => {
    try {
      const stream = await ensureLocalStream();
      setMicrophoneWarning(null);
      return stream;
    } catch (error) {
      const message = getMicrophoneErrorMessage(error);
      setMicrophoneWarning(message);
      setIsMuted(true);
      setLocalSpeaking(false);
      updateDebug({ localStream: false, last: message });
      return null;
    }
  }, [ensureLocalStream, updateDebug]);

  const toggleMute = useCallback(async () => {
    if (!localStreamRef.current) {
      const stream = await tryEnsureLocalStream();
      if (!stream) return;

      const pc = peerConnectionRef.current;
      if (pc) {
        const existingTrackIds = new Set(pc.getSenders().map((sender) => sender.track?.id).filter(Boolean));
        stream.getTracks().forEach((track) => {
          if (!existingTrackIds.has(track.id)) {
            pc.addTrack(track, stream);
          }
        });
      }

      setIsMuted(false);
      stream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      updateDebug({ last: 'microphone enabled' });
      return;
    }

    setIsMuted((current) => {
      const next = !current;
      localStreamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      updateDebug({ last: next ? 'microphone muted' : 'microphone unmuted' });
      return next;
    });
  }, [tryEnsureLocalStream, updateDebug]);

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
        stopRemoteVoiceActivityRef.current?.();
        stopRemoteVoiceActivityRef.current = createVoiceActivityWatcher(stream, setRemoteSpeaking);
        remoteAudioRef.current.volume = REMOTE_AUDIO_VOLUME;
        remoteAudioRef.current.muted = false;
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
        setConnectedAt((current) => current || Date.now());
        setNotice('Audio connected');
      } else if (['failed', 'disconnected'].includes(pc.connectionState)) {
        setNotice('Call connection is unstable');
      }
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [resetCall, sendSignal, updateDebug]);

  const attachLocalTracks = useCallback(async (pc: RTCPeerConnection) => {
    const stream = await tryEnsureLocalStream();
    if (!stream) return false;
    const existingTrackIds = new Set(pc.getSenders().map((sender) => sender.track?.id).filter(Boolean));
    stream.getTracks().forEach((track) => {
      if (!existingTrackIds.has(track.id)) {
        pc.addTrack(track, stream);
      }
    });
    return true;
  }, [tryEnsureLocalStream]);

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
    if (pc.localDescription?.type === 'offer' || pc.signalingState !== 'stable') {
      updateDebug({ last: `skipped duplicate offer in ${pc.signalingState}` });
      return;
    }
    await attachLocalTracks(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    updateDebug({ last: 'offer sent' });
    await sendSignal('WEBRTC_OFFER', target, activeCallId, { sdp: offer.sdp || '' });
  }, [attachLocalTracks, createPeerConnection, sendSignal, updateDebug]);

  const answerOffer = useCallback(async (target: string, activeCallId: string, sdp: string) => {
    const pc = createPeerConnection(target, activeCallId);
    if (pc.remoteDescription?.type === 'offer' && pc.localDescription?.type === 'answer') {
      updateDebug({ last: 'skipped duplicate offer' });
      return;
    }
    if (pc.signalingState !== 'stable') {
      updateDebug({ last: `skipped offer in ${pc.signalingState}` });
      return;
    }
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
    if (pc.signalingState !== 'have-local-offer') {
      updateDebug({ last: `skipped answer in ${pc.signalingState}` });
      return;
    }
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

    clearResetTimer();
    setIsCallShelfCollapsed(true);
    setPhase('outgoing');
    setCallId(nextCallId);
    callConversationIdRef.current = conversation.id;
    setCallConversationId(conversation.id);
    setCallCurrentMemberSnapshot(currentMember);
    setCallRemoteMemberSnapshot(remoteMember);
    setRemoteUserId(targetUserId);
    setNotice(null);

    try {
      await sendSignal('CALL_INVITE', targetUserId, nextCallId);
      setNotice('Calling...');
    } catch (err) {
      setPhase('failed');
      setNotice(getCallStartErrorMessage(err));
    }
  }, [busy, clearResetTimer, conversation.id, currentMember, remoteMember, sendSignal, supportsDirectCall, targetUserId]);

  const acceptCall = useCallback(async () => {
    if (!callId || !remoteUserId) return;
    try {
      await tryEnsureLocalStream();
      await sendSignal('CALL_ACCEPT', remoteUserId, callId);
      clearResetTimer();
      setPhase('active');
      setNotice('Waiting for audio...');
    } catch (err) {
      const code = err && typeof err === 'object' ? (err as Record<string, unknown>).code : null;
      if (code === 'CALL_ALREADY_ANSWERED') {
        resetCall('Answered on another device');
        return;
      }

      setPhase('failed');
      const isBrowserMediaError =
        err && typeof err === 'object' && 'name' in err && !('code' in err);
      setNotice(isBrowserMediaError ? getMicrophoneErrorMessage(err) : getCallAcceptErrorMessage(err));
    }
  }, [callId, clearResetTimer, remoteUserId, resetCall, sendSignal, tryEnsureLocalStream]);

  useEffect(() => {
    if (
      phase !== 'incoming' ||
      !callId ||
      autoAnswerIncomingCallId !== callId
    ) {
      return;
    }

    onAutoAnswerIncomingHandled?.(callId);
    void acceptCall();
  }, [acceptCall, autoAnswerIncomingCallId, callId, onAutoAnswerIncomingHandled, phase]);

  const declineOrEndCall = useCallback(async () => {
    if (!callId || !remoteUserId) {
      resetCall();
      return;
    }

    const event = phase === 'outgoing' ? 'CALL_CANCEL' : phase === 'incoming' ? 'CALL_REJECT' : 'CALL_END';
    try {
      await sendSignal(event, remoteUserId, callId, {
        reason: event === 'CALL_REJECT'
          ? 'declined'
          : event === 'CALL_CANCEL'
            ? 'missed'
            : undefined,
      });
    } catch {
      // Local cleanup should still happen even if the peer is already gone.
    }
    const localMessage = event === 'CALL_REJECT'
      ? 'Call declined'
      : event === 'CALL_CANCEL'
        ? 'Call canceled'
        : `Call ended · ${formatCallDuration(elapsedSeconds)}`;
    resetCall(localMessage);
  }, [callId, elapsedSeconds, phase, remoteUserId, resetCall, sendSignal]);

  useEffect(() => () => {
    clearResetTimer();
    cleanupMedia();
  }, [cleanupMedia, clearResetTimer]);

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
    callConversationIdRef.current = pendingIncomingCall.conversation_id || conversation.id;
    setCallConversationId(pendingIncomingCall.conversation_id || conversation.id);
    setCallCurrentMemberSnapshot(currentMember);
    setCallRemoteMemberSnapshot(remoteMember);
    setRemoteUserId(pendingIncomingCall.from_user_id);
    setNotice('Incoming audio call');
    setIsCallShelfCollapsed(true);
    clearResetTimer();
    onPendingIncomingHandled?.(pendingIncomingCall.call_id);
  }, [clearResetTimer, conversation, currentMember, onPendingIncomingHandled, pendingIncomingCall, remoteMember]);

  useEffect(() => {
    const isActiveCallEvent = (payload: CallEventPayload) => (
      Boolean(payload.call_id && callIdRef.current && payload.call_id === callIdRef.current)
    );

    const handleInvite = (payload: CallEventPayload) => {
      if (!isConversationEvent(conversation, payload) || !payload.call_id || !payload.from_user_id) return;
      clearResetTimer();
      setIsCallShelfCollapsed(true);
      setPhase('incoming');
      setCallId(payload.call_id);
      callConversationIdRef.current = payload.conversation_id || conversation.id;
      setCallConversationId(payload.conversation_id || conversation.id);
      setCallCurrentMemberSnapshot(currentMember);
      setCallRemoteMemberSnapshot(remoteMember);
      setRemoteUserId(payload.from_user_id);
      setNotice('Incoming audio call');
    };

    const handleAccepted = (payload: CallEventPayload) => {
      if (!isActiveCallEvent(payload)) return;
      clearResetTimer();
      setPhase('active');
      setNotice('Starting audio...');
      if (payload.from_user_id && payload.call_id) {
        void sendOffer(payload.from_user_id, payload.call_id).catch((err) => {
          setPhase('failed');
          setNotice(getMicrophoneErrorMessage(err));
        });
      }
    };

    const handleEnded = (payload: CallEventPayload) => {
      if (callIdRef.current) {
        if (payload.call_id !== callIdRef.current) return;
      } else if (!isConversationEvent(conversation, payload)) {
        return;
      }
      const duration = Number.isFinite(payload.call_duration_seconds)
        ? ` · ${formatCallDuration(payload.call_duration_seconds || 0)}`
        : '';
      const message = payload.event === 'CALL_REJECT'
        ? 'Call declined'
        : payload.event === 'CALL_CANCEL'
          ? 'Call canceled'
          : `Call ended${duration}`;
      resetCall(message);
    };

    const handleClearedElsewhere = (payload: CallEventPayload) => {
      if (!isActiveCallEvent(payload)) return;
      if (phaseRef.current !== 'incoming') return;
      resetCall(payload.clear_reason === 'answered'
        ? 'Answered on another device'
        : 'Handled on another device');
    };

    const handleOffer = (payload: CallEventPayload) => {
      if (!payload.call_id || !payload.from_user_id || (!payload.sdp && !payload.sdp_base64)) return;
      if (!isActiveCallEvent(payload) && !isConversationEvent(conversation, payload)) return;
      if (callIdRef.current && payload.call_id !== callIdRef.current) return;
      clearResetTimer();
      setPhase('active');
      if (payload.conversation_id) {
        callConversationIdRef.current = payload.conversation_id;
        setCallConversationId(payload.conversation_id);
      }
      setCallId(payload.call_id);
      setCallCurrentMemberSnapshot(currentMember);
      setCallRemoteMemberSnapshot(remoteMember);
      setRemoteUserId(payload.from_user_id);
      setNotice('Answering audio...');
      void answerOffer(payload.from_user_id, payload.call_id, resolveSignalSdp(payload)).catch((err) => {
        setPhase('failed');
        setNotice(getMicrophoneErrorMessage(err));
      });
    };

    const handleAnswer = (payload: CallEventPayload) => {
      if (!isActiveCallEvent(payload) || (!payload.sdp && !payload.sdp_base64)) return;
      void applyAnswer(resolveSignalSdp(payload)).catch((err) => {
        setPhase('failed');
        setNotice(err instanceof Error ? err.message : 'Could not connect audio');
      });
    };

    const handleIceCandidate = (payload: CallEventPayload) => {
      if (!isActiveCallEvent(payload)) return;
      void applyIceCandidate(payload.candidate_init);
    };

    gateway.on('CALL_INVITE', handleInvite);
    gateway.on('CALL_ACCEPT', handleAccepted);
    gateway.on('CALL_REJECT', handleEnded);
    gateway.on('CALL_CANCEL', handleEnded);
    gateway.on('CALL_END', handleEnded);
    gateway.on('CALL_CLEARED_ELSEWHERE', handleClearedElsewhere);
    gateway.on('WEBRTC_OFFER', handleOffer);
    gateway.on('WEBRTC_ANSWER', handleAnswer);
    gateway.on('ICE_CANDIDATE', handleIceCandidate);

    return () => {
      gateway.off('CALL_INVITE', handleInvite);
      gateway.off('CALL_ACCEPT', handleAccepted);
      gateway.off('CALL_REJECT', handleEnded);
      gateway.off('CALL_CANCEL', handleEnded);
      gateway.off('CALL_END', handleEnded);
      gateway.off('CALL_CLEARED_ELSEWHERE', handleClearedElsewhere);
      gateway.off('WEBRTC_OFFER', handleOffer);
      gateway.off('WEBRTC_ANSWER', handleAnswer);
      gateway.off('ICE_CANDIDATE', handleIceCandidate);
    };
  }, [answerOffer, applyAnswer, applyIceCandidate, clearResetTimer, conversation, currentMember, remoteMember, resetCall, sendOffer]);

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

  const shelfCurrentMember = phase === 'idle'
    ? currentMember
    : callCurrentMemberSnapshot || currentMember;
  const shelfRemoteMember = phase === 'idle'
    ? remoteMember
    : callRemoteMemberSnapshot || remoteMember;

  const callShelfStyle: CSSProperties = mobileShelfFrame
    ? {
        left: `${mobileShelfFrame.left}px`,
        top: `${mobileShelfFrame.top + 76 + (mobileShelfFrame.isMobile ? callShelfOffsetY : 0)}px`,
        width: `${mobileShelfFrame.width}px`,
      }
    : {
        left: '50%',
        top: `calc(5rem + ${callShelfOffsetY}px)`,
        width: 'min(680px, calc(100vw - 1rem))',
        transform: 'translateX(-50%)',
      };
  const callShelfNotice = notice || (phase === 'outgoing' ? 'Calling...' : phase === 'active' ? 'Audio call' : 'Call');

  const callShelf = showCallShelf ? (
    <CallShelf
      phase={phase}
      notice={notice}
      microphoneWarning={microphoneWarning}
      isCallShelfCollapsed={isCallShelfCollapsed}
      callShelfStyle={callShelfStyle}
      callShelfNotice={callShelfNotice}
      elapsedSeconds={elapsedSeconds}
      debugState={debugState}
      supportsDirectCall={supportsDirectCall}
      isMuted={isMuted}
      localSpeaking={localSpeaking}
      remoteSpeaking={remoteSpeaking}
      shelfCurrentMember={shelfCurrentMember}
      shelfRemoteMember={shelfRemoteMember}
      onAccept={acceptCall}
      onDeclineOrEnd={declineOrEndCall}
      onToggleMute={toggleMute}
      onCollapseChange={setIsCallShelfCollapsed}
      onDragStart={beginCallShelfDrag}
      onDragMove={moveCallShelfDrag}
      onDragEnd={endCallShelfDrag}
    />
  ) : null;

  return (
    <div className="ml-2 flex shrink-0 items-center gap-2">
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      {callShelf && typeof document !== 'undefined' ? createPortal(callShelf, document.body) : callShelf}

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
