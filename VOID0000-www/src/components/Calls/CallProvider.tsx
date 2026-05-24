import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Conversation, ConversationMember } from '../../Services/Chat/chatService';
import { gateway } from '../../Services/Gateway/gateway';
import {
  acceptSfuCall,
  cancelSfuCall,
  endSfuCall,
  getActiveCall,
  rejectSfuCall,
  startSfuCall,
} from '../../Services/Calls/callService';
import type { CallPhase, SfuCallEventPayload, SfuCallSnapshot, SfuJoinInfo } from '../../Services/Calls/callTypes';
import CallShelf from './CallShelf';

interface CallProviderProps {
  children: ReactNode;
  conversation: Conversation | null;
  members: Record<string, ConversationMember>;
  currentUserId?: string | null;
}

interface CallContextValue {
  phase: CallPhase;
  busy: boolean;
  notice: string | null;
  activeCall: SfuCallSnapshot | null;
  sfu: SfuJoinInfo | null;
  supportsDirectCall: boolean;
  showCallShelf: boolean;
  startCall: () => Promise<void>;
  acceptCall: () => Promise<void>;
  declineOrEndCall: () => Promise<void>;
  dismissEndedCall: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

function callFromEvent(payload: SfuCallEventPayload, currentUserId: string): SfuCallSnapshot {
  const isCaller = payload.from_user_id === currentUserId;
  const status = payload.status || (
    payload.event === 'CALL_ACCEPT' ? 'active' :
    payload.event === 'CALL_REJECT' ? 'rejected' :
    payload.event === 'CALL_CANCEL' ? 'cancelled' :
    payload.event === 'CALL_END' ? 'ended' :
    'ringing'
  );

  return {
    call_id: payload.call_id,
    conversation_id: payload.conversation_id,
    conversation_public_id: payload.conversation_public_id || null,
    conversation_type: payload.conversation_type || 'dm',
    from_user_id: payload.from_user_id,
    target_user_id: payload.target_user_id,
    peer_user_id: isCaller ? payload.target_user_id : payload.from_user_id,
    media: payload.media || 'audio',
    status,
    direction: isCaller ? 'outgoing' : 'incoming',
    sfu_provider: payload.sfu_provider || 'unconfigured',
    sfu_room_name: payload.sfu_room_name || '',
    started_at: payload.started_at || null,
    answered_at: payload.answered_at || null,
    ended_at: payload.ended_at || null,
    ended_by: payload.ended_by || null,
    end_reason: payload.end_reason || null,
  };
}

function phaseFromCall(call: SfuCallSnapshot | null): CallPhase {
  if (!call) return 'idle';
  if (call.status === 'active') return 'active';
  if (call.status === 'ringing') return call.direction === 'incoming' ? 'incoming' : 'outgoing';
  return 'ended';
}

function getEndedNotice(call: SfuCallSnapshot | null) {
  if (!call) return 'Call ended.';
  if (call.status === 'rejected') return 'Call declined.';
  if (call.status === 'cancelled') return 'Call cancelled.';
  if (call.status === 'missed') return 'Missed call.';
  return 'Call ended.';
}

export function CallProvider({ children, conversation, members, currentUserId }: CallProviderProps) {
  const [activeCall, setActiveCall] = useState<SfuCallSnapshot | null>(null);
  const [sfu, setSfu] = useState<SfuJoinInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);

  const phase = phaseFromCall(activeCall);
  const supportsDirectCall = conversation?.type === 'dm';
  const showCallShelf = phase !== 'idle';

  const stopRingtone = useCallback(() => {
    const ringtone = ringtoneRef.current;
    if (!ringtone) return;
    ringtone.pause();
    ringtone.currentTime = 0;
  }, []);

  useEffect(() => {
    if (phase !== 'incoming') {
      stopRingtone();
      return;
    }

    const ringtone = new Audio('/sounds/ringtone');
    ringtone.loop = true;
    ringtone.volume = 0.55;
    ringtoneRef.current = ringtone;
    void ringtone.play().catch(() => {});

    return () => {
      ringtone.pause();
      ringtone.currentTime = 0;
    };
  }, [phase, stopRingtone]);

  useEffect(() => {
    if (!currentUserId) return;

    let cancelled = false;
    const syncActiveCall = async () => {
      try {
        const call = await getActiveCall();
        if (cancelled) return;
        setActiveCall(call);
        setSfu(null);
        setNotice(call?.status === 'active' ? 'SFU room is ready.' : null);
      } catch {
        // Gateway/service banners already cover backend trouble.
      }
    };

    void syncActiveCall();
    gateway.on('READY', syncActiveCall);
    gateway.on('RESUMED', syncActiveCall);

    return () => {
      cancelled = true;
      gateway.off('READY', syncActiveCall);
      gateway.off('RESUMED', syncActiveCall);
    };
  }, [currentUserId]);

  useEffect(() => {
    if (!currentUserId) return;

    const handleInvite = (payload: SfuCallEventPayload) => {
      if (payload.target_user_id !== currentUserId) return;
      setActiveCall(callFromEvent(payload, currentUserId));
      setSfu(null);
      setNotice(null);
    };

    const handleState = (payload: SfuCallEventPayload) => {
      if (payload.from_user_id !== currentUserId && payload.target_user_id !== currentUserId) return;
      setActiveCall(callFromEvent(payload, currentUserId));
    };

    const handleAccept = (payload: SfuCallEventPayload) => {
      if (payload.from_user_id !== currentUserId && payload.target_user_id !== currentUserId) return;
      setActiveCall(callFromEvent(payload, currentUserId));
      setNotice('SFU room is ready.');
    };

    const handleTerminal = (payload: SfuCallEventPayload) => {
      if (payload.from_user_id !== currentUserId && payload.target_user_id !== currentUserId) return;
      const nextCall = callFromEvent(payload, currentUserId);
      setActiveCall(nextCall);
      setSfu(null);
      setNotice(getEndedNotice(nextCall));
    };

    gateway.on('CALL_INVITE', handleInvite);
    gateway.on('CALL_STATE', handleState);
    gateway.on('CALL_ACCEPT', handleAccept);
    gateway.on('CALL_REJECT', handleTerminal);
    gateway.on('CALL_CANCEL', handleTerminal);
    gateway.on('CALL_END', handleTerminal);

    return () => {
      gateway.off('CALL_INVITE', handleInvite);
      gateway.off('CALL_STATE', handleState);
      gateway.off('CALL_ACCEPT', handleAccept);
      gateway.off('CALL_REJECT', handleTerminal);
      gateway.off('CALL_CANCEL', handleTerminal);
      gateway.off('CALL_END', handleTerminal);
    };
  }, [currentUserId]);

  const startCall = useCallback(async () => {
    if (!conversation || !supportsDirectCall || busy) return;
    setBusy(true);
    setNotice(null);

    try {
      const response = await startSfuCall({
        conversationId: conversation.public_id || conversation.id,
        media: 'audio',
      });
      setActiveCall(response.call);
      setSfu(response.sfu || null);
      setNotice(response.sfu?.configured ? 'Waiting for them to answer.' : response.sfu?.message || 'Waiting for them to answer.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not start call.');
      setActiveCall((current) => current || null);
    } finally {
      setBusy(false);
    }
  }, [busy, conversation, supportsDirectCall]);

  const acceptCall = useCallback(async () => {
    if (!activeCall || busy) return;
    stopRingtone();
    setBusy(true);

    try {
      const response = await acceptSfuCall(activeCall.call_id);
      setActiveCall(response.call);
      setSfu(response.sfu || null);
      setNotice(response.sfu?.configured ? 'SFU room is ready.' : response.sfu?.message || 'SFU room is not configured yet.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not answer call.');
    } finally {
      setBusy(false);
    }
  }, [activeCall, busy, stopRingtone]);

  const declineOrEndCall = useCallback(async () => {
    if (!activeCall || busy) return;
    stopRingtone();
    setBusy(true);

    try {
      const response = phase === 'incoming'
        ? await rejectSfuCall(activeCall.call_id)
        : phase === 'outgoing'
          ? await cancelSfuCall(activeCall.call_id)
          : await endSfuCall(activeCall.call_id);
      setActiveCall(response.call);
      setSfu(null);
      setNotice(getEndedNotice(response.call));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not update call.');
    } finally {
      setBusy(false);
    }
  }, [activeCall, busy, phase, stopRingtone]);

  const dismissEndedCall = useCallback(() => {
    if (phase !== 'ended' && phase !== 'failed') return;
    setActiveCall(null);
    setSfu(null);
    setNotice(null);
  }, [phase]);

  const remoteMember = activeCall ? members[activeCall.peer_user_id] || null : null;
  const currentMember = currentUserId ? members[currentUserId] || null : null;

  const value = useMemo<CallContextValue>(() => ({
    phase,
    busy,
    notice,
    activeCall,
    sfu,
    supportsDirectCall,
    showCallShelf,
    startCall,
    acceptCall,
    declineOrEndCall,
    dismissEndedCall,
  }), [
    acceptCall,
    activeCall,
    busy,
    declineOrEndCall,
    dismissEndedCall,
    notice,
    phase,
    sfu,
    showCallShelf,
    startCall,
    supportsDirectCall,
  ]);

  return (
    <CallContext.Provider value={value}>
      {children}
      {showCallShelf ? (
        <CallShelf
          phase={phase}
          busy={busy}
          notice={notice}
          activeCall={activeCall}
          sfu={sfu}
          currentMember={currentMember}
          remoteMember={remoteMember}
          onAccept={acceptCall}
          onDeclineOrEnd={declineOrEndCall}
          onDismiss={dismissEndedCall}
        />
      ) : null}
    </CallContext.Provider>
  );
}

export function useCallContext() {
  const context = useContext(CallContext);
  if (!context) {
    throw new Error('useCallContext must be used within CallProvider');
  }
  return context;
}
