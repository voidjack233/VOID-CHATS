import { Loader2, PhoneCall, PhoneOff, X } from 'lucide-react';
import type { ConversationMember } from '../../Services/Chat/chatService';
import type { CallPhase, SfuCallSnapshot, SfuJoinInfo } from '../../Services/Calls/callTypes';
import UserAvatar from '../common/UserAvatar';

interface CallShelfProps {
  phase: CallPhase;
  busy: boolean;
  notice: string | null;
  activeCall: SfuCallSnapshot | null;
  sfu: SfuJoinInfo | null;
  currentMember: ConversationMember | null;
  remoteMember: ConversationMember | null;
  onAccept: () => void;
  onDeclineOrEnd: () => void;
  onDismiss: () => void;
}

function getMemberDisplayName(member: ConversationMember | null, fallback: string) {
  return member?.display_name || member?.username || fallback;
}

function getStatusCopy(phase: CallPhase, sfu: SfuJoinInfo | null) {
  if (phase === 'incoming') return 'Incoming audio call';
  if (phase === 'outgoing') return 'Calling...';
  if (phase === 'active') {
    return sfu?.configured ? 'Connected to SFU room' : 'SFU server not configured yet';
  }
  return 'Call finished';
}

export default function CallShelf({
  phase,
  busy,
  notice,
  activeCall,
  sfu,
  remoteMember,
  onAccept,
  onDeclineOrEnd,
  onDismiss,
}: CallShelfProps) {
  const remoteName = getMemberDisplayName(remoteMember, phase === 'incoming' ? 'Someone' : 'Call');
  const isIncoming = phase === 'incoming';
  const isEnded = phase === 'ended' || phase === 'failed';

  return (
    <div className="pointer-events-none fixed inset-x-3 top-[5.25rem] z-[70] flex justify-center md:left-72 md:right-0">
      <div className="pointer-events-auto w-full max-w-[420px] overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#111827]/88 px-4 py-4 text-white shadow-2xl shadow-black/35 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <UserAvatar
            src={remoteMember?.avatar_url}
            displayName={remoteName}
            username={remoteMember?.username}
            className="h-14 w-14 shrink-0 rounded-full border border-white/10 bg-blue-500/25 text-lg shadow-lg"
            fallbackClassName="bg-blue-500/25 text-blue-50"
            fallbackTone="plain"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-white">{remoteName}</div>
            <div className="mt-0.5 truncate text-xs font-medium text-white/60">
              {getStatusCopy(phase, sfu)}
            </div>
            {notice ? (
              <div className="mt-1 truncate text-[11px] font-medium text-white/45">
                {notice}
              </div>
            ) : null}
            {activeCall?.sfu_room_name ? (
              <div className="mt-1 truncate text-[10px] font-semibold uppercase tracking-[0.18em] text-white/25">
                {activeCall.sfu_provider || 'sfu'} · {activeCall.sfu_room_name}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isIncoming ? (
              <button
                type="button"
                onClick={onAccept}
                disabled={busy}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-950/30 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
                title="Answer call"
                aria-label="Answer call"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneCall className="h-4 w-4" />}
              </button>
            ) : null}
            {isEnded ? (
              <button
                type="button"
                onClick={onDismiss}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/15"
                title="Dismiss call"
                aria-label="Dismiss call"
              >
                <X className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onDeclineOrEnd}
                disabled={busy}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-950/35 transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                title={isIncoming ? 'Decline call' : 'End call'}
                aria-label={isIncoming ? 'Decline call' : 'End call'}
              >
                {busy && !isIncoming ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
