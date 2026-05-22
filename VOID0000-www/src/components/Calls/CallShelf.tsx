import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { Maximize2, Mic, MicOff, Minimize2, MonitorUp, PhoneCall, PhoneOff, Video } from 'lucide-react';
import type { ConversationMember } from '../../Services/Chat/chatService';
import type { CallDebugState, CallPhase } from '../../Services/Calls/callTypes';
import { formatCallDuration } from '../../Services/Calls/callUtils';
import UserAvatar from '../common/UserAvatar';

interface CallShelfProps {
  phase: CallPhase;
  notice: string | null;
  microphoneWarning: string | null;
  isCallShelfCollapsed: boolean;
  callShelfStyle: CSSProperties;
  callShelfNotice: string;
  elapsedSeconds: number;
  debugState: CallDebugState;
  supportsDirectCall: boolean;
  isMuted: boolean;
  localSpeaking: boolean;
  remoteSpeaking: boolean;
  shelfCurrentMember: ConversationMember | null;
  shelfRemoteMember: ConversationMember | null;
  onAccept: () => void;
  onDeclineOrEnd: () => void;
  onToggleMute: () => void;
  onCollapseChange: (collapsed: boolean) => void;
  onDragStart: (event: PointerEvent<HTMLDivElement>) => void;
  onDragMove: (event: PointerEvent<HTMLDivElement>) => void;
  onDragEnd: (event: PointerEvent<HTMLDivElement>) => void;
}

function getMemberDisplayName(member: ConversationMember | null, fallback: string) {
  return member?.display_name || member?.username || fallback;
}

function SpeakingAvatarFrame({
  speaking,
  children,
}: {
  speaking: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-full p-[3px] transition-all duration-200 ${
      speaking
        ? 'bg-white/70 shadow-[0_0_0_3px_rgba(255,255,255,0.18),0_0_30px_rgba(255,255,255,0.28)]'
        : 'bg-white/0'
    }`}>
      {children}
    </div>
  );
}

export default function CallShelf({
  phase,
  notice,
  microphoneWarning,
  isCallShelfCollapsed,
  callShelfStyle,
  callShelfNotice,
  elapsedSeconds,
  debugState,
  supportsDirectCall,
  isMuted,
  localSpeaking,
  remoteSpeaking,
  shelfCurrentMember,
  shelfRemoteMember,
  onAccept,
  onDeclineOrEnd,
  onToggleMute,
  onCollapseChange,
  onDragStart,
  onDragMove,
  onDragEnd,
}: CallShelfProps) {
  return (
    <div
      className="fixed z-50 px-2"
      style={callShelfStyle}
    >
      <div className={`relative mx-auto max-w-[680px] overflow-hidden border border-white/10 bg-[#111827]/80 text-white shadow-2xl shadow-black/35 backdrop-blur-xl ${
        isCallShelfCollapsed ? 'max-w-[420px] rounded-full px-3 py-2' :
        phase === 'incoming'
          ? 'rounded-[1.75rem] px-5 py-5 sm:px-8'
          : 'rounded-[2rem] px-4 py-4 sm:px-8'
      }`}>
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-white/5 via-transparent to-white/5" />
        <div
          className={`relative mx-auto flex h-5 w-24 touch-none cursor-grab items-center justify-center active:cursor-grabbing md:hidden ${isCallShelfCollapsed ? 'mb-1' : 'mb-3'}`}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          title="Drag call controls"
          aria-label="Drag call controls"
        >
          <div className="h-1.5 w-12 rounded-full bg-white/25" />
        </div>
        {microphoneWarning && (
          <div className="relative mb-3 rounded-2xl border border-amber-200/15 bg-amber-300/10 px-3 py-2 text-center text-xs font-medium text-amber-50/85">
            {microphoneWarning}
          </div>
        )}
        {isCallShelfCollapsed ? (
          <div className="relative flex items-center gap-3">
            <SpeakingAvatarFrame speaking={phase === 'active' && remoteSpeaking}>
              <UserAvatar
                src={shelfRemoteMember?.avatar_url}
                displayName={getMemberDisplayName(shelfRemoteMember, 'Caller')}
                username={shelfRemoteMember?.username}
                className="h-9 w-9 rounded-full border border-white/10 bg-blue-500/25 text-sm shadow-lg"
                fallbackClassName="bg-blue-500/25 text-blue-50"
                fallbackTone="plain"
              />
            </SpeakingAvatarFrame>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-bold text-white">
                {getMemberDisplayName(shelfRemoteMember, phase === 'incoming' ? 'Incoming call' : 'Call')}
              </div>
              <div className="truncate text-[11px] font-medium text-white/60">
                {callShelfNotice}
                {phase === 'active' ? ` · ${formatCallDuration(elapsedSeconds)}` : ''}
              </div>
            </div>
            {phase === 'incoming' ? (
              <>
                <button
                  type="button"
                  onClick={onAccept}
                  disabled={!supportsDirectCall}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-950/30 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Answer call"
                  aria-label="Answer call"
                >
                  <PhoneCall className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={onDeclineOrEnd}
                  disabled={!supportsDirectCall}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-950/35 transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Decline call"
                  aria-label="Decline call"
                >
                  <PhoneOff className="h-4 w-4" />
                </button>
              </>
            ) : (
              <>
                {phase === 'ended' ? null : (
                  <button
                    type="button"
                    onClick={onToggleMute}
                    className={`flex h-9 w-9 items-center justify-center rounded-full shadow-lg transition ${
                      isMuted || microphoneWarning
                        ? 'bg-amber-400 text-neutral-950 shadow-amber-950/20 hover:bg-amber-300'
                        : 'bg-white/12 text-white shadow-black/20 hover:bg-white/18'
                    }`}
                    title={microphoneWarning ? 'Try microphone again' : (isMuted ? 'Unmute microphone' : 'Mute microphone')}
                    aria-label={microphoneWarning ? 'Try microphone again' : (isMuted ? 'Unmute microphone' : 'Mute microphone')}
                  >
                    {isMuted || microphoneWarning ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onDeclineOrEnd}
                  disabled={phase === 'ended'}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-950/35 transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                  title="End call"
                  aria-label="End call"
                >
                  <PhoneOff className="h-4 w-4" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => onCollapseChange(false)}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white/80 shadow-inner shadow-white/5 transition hover:bg-white/15"
              title="Expand call"
              aria-label="Expand call controls"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>
        ) : phase === 'incoming' ? (
          <div className="relative flex flex-col items-center justify-center gap-4">
            <button
              type="button"
              onClick={() => onCollapseChange(true)}
              className="absolute right-0 top-0 inline-flex h-8 items-center gap-1 rounded-full border border-white/10 bg-white/10 px-2 text-[11px] font-semibold text-white/75 shadow-inner shadow-white/5 transition hover:bg-white/15"
              title="Collapse call"
              aria-label="Collapse call controls"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Compact</span>
            </button>
            <SpeakingAvatarFrame speaking={false}>
              <UserAvatar
                src={shelfRemoteMember?.avatar_url}
                displayName={getMemberDisplayName(shelfRemoteMember, 'Caller')}
                username={shelfRemoteMember?.username}
                className="h-20 w-20 rounded-full border border-white/10 bg-blue-500/25 text-2xl shadow-lg sm:h-28 sm:w-28 sm:text-3xl"
                fallbackClassName="bg-blue-500/25 text-blue-50"
                fallbackTone="plain"
              />
            </SpeakingAvatarFrame>
            <div className="min-w-0 text-center">
              <div className="max-w-[260px] truncate text-base font-bold text-white">
                {getMemberDisplayName(shelfRemoteMember, 'Someone')}
              </div>
              <div className="mt-1 text-xs font-medium text-white/60">
                Incoming audio call
              </div>
            </div>
            <div className="flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={onAccept}
                disabled={!supportsDirectCall}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-950/30 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50 sm:h-14 sm:w-14"
                title="Answer call"
                aria-label="Answer call"
              >
                <PhoneCall className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={onDeclineOrEnd}
                disabled={!supportsDirectCall}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-950/35 transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50 sm:h-14 sm:w-14"
                title="Decline call"
                aria-label="Decline call"
              >
                <PhoneOff className="h-5 w-5" />
              </button>
            </div>
          </div>
        ) : (
          <div className="relative flex flex-col items-center gap-4">
            <button
              type="button"
              onClick={() => onCollapseChange(true)}
              className="absolute right-0 top-0 z-10 inline-flex h-8 items-center gap-1 rounded-full border border-white/10 bg-white/10 px-2 text-[11px] font-semibold text-white/75 shadow-inner shadow-white/5 transition hover:bg-white/15"
              title="Collapse call"
              aria-label="Collapse call controls"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Compact</span>
            </button>

            <div className="grid w-full grid-cols-2 gap-4 px-2 pt-2 sm:gap-10 sm:px-12">
              <div className="flex flex-col items-center gap-2">
                <SpeakingAvatarFrame speaking={phase === 'active' && localSpeaking && !isMuted}>
                  <UserAvatar
                    src={shelfCurrentMember?.avatar_url}
                    displayName={getMemberDisplayName(shelfCurrentMember, 'You')}
                    username={shelfCurrentMember?.username}
                    className="h-16 w-16 rounded-full border border-white/10 bg-blue-500/25 text-lg shadow-lg sm:h-24 sm:w-24 sm:text-2xl"
                    fallbackClassName="bg-blue-500/25 text-blue-50"
                    fallbackTone="plain"
                  />
                </SpeakingAvatarFrame>
                <span className="max-w-[96px] truncate text-xs font-semibold text-white/75 sm:max-w-[140px]">
                  You
                </span>
              </div>

              <div className="flex flex-col items-center gap-2">
                <SpeakingAvatarFrame speaking={phase === 'active' && remoteSpeaking}>
                  <UserAvatar
                    src={shelfRemoteMember?.avatar_url}
                    displayName={getMemberDisplayName(shelfRemoteMember, 'Caller')}
                    username={shelfRemoteMember?.username}
                    className="h-16 w-16 rounded-full border border-white/10 bg-blue-500/25 text-lg shadow-lg sm:h-24 sm:w-24 sm:text-2xl"
                    fallbackClassName="bg-blue-500/25 text-blue-50"
                    fallbackTone="plain"
                  />
                </SpeakingAvatarFrame>
                <span className="max-w-[96px] truncate text-xs font-semibold text-white/75 sm:max-w-[140px]">
                  {getMemberDisplayName(shelfRemoteMember, 'Calling')}
                </span>
              </div>
            </div>

            <div className="flex flex-col items-center gap-2">
              <div className="flex items-center justify-center gap-2 sm:gap-3">
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
                {phase === 'ended' ? null : (
                  <button
                    type="button"
                    onClick={onToggleMute}
                    className={`flex h-11 w-11 items-center justify-center rounded-full shadow-lg transition sm:h-14 sm:w-14 ${
                      isMuted || microphoneWarning
                        ? 'bg-amber-400 text-neutral-950 shadow-amber-950/20 hover:bg-amber-300'
                        : 'bg-white/12 text-white shadow-black/20 hover:bg-white/18'
                    }`}
                    title={microphoneWarning ? 'Try microphone again' : (isMuted ? 'Unmute microphone' : 'Mute microphone')}
                    aria-label={microphoneWarning ? 'Try microphone again' : (isMuted ? 'Unmute microphone' : 'Mute microphone')}
                  >
                    {isMuted || microphoneWarning ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                  </button>
                )}
                <button
                  type="button"
                  onClick={onDeclineOrEnd}
                  disabled={phase === 'ended'}
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-950/35 transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50 sm:h-14 sm:w-14"
                  title="End call"
                  aria-label="End call"
                >
                  <PhoneOff className="h-5 w-5" />
                </button>
              </div>
              <div className="max-w-[360px] truncate text-center text-xs font-medium text-white/65">
                {notice || (phase === 'outgoing' ? 'Calling...' : 'Audio call')}
                {phase === 'active' && (
                  <span className="hidden sm:inline">
                    {' '}· {formatCallDuration(elapsedSeconds)} · {debugState.remoteStream ? 'remote audio ready' : 'waiting for remote audio'}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
