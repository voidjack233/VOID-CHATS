import { Loader2, Phone, PhoneCall } from 'lucide-react';
import type { Conversation } from '../../Services/Chat/chatService';
import { useCallContext } from './CallProvider';

interface CallHeaderControlsProps {
  conversation: Conversation;
}

export type { PendingIncomingCall } from '../../Services/Calls/callTypes';

export default function CallHeaderControls({ conversation }: CallHeaderControlsProps) {
  const call = useCallContext();
  const isDirectMessage = conversation.type === 'dm';

  if (!isDirectMessage) {
    return (
      <div className="ml-2 flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled
          className={`rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            call.showCallShelf
              ? 'bg-emerald-500/10 text-emerald-200'
              : 'text-void-text-muted/45'
          }`}
          title={call.showCallShelf ? 'Call controls are open' : 'Group calls are coming after direct calls'}
        >
          {call.showCallShelf ? <PhoneCall className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
        </button>
      </div>
    );
  }

  return (
    <div className="ml-2 flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={call.phase === 'idle' || call.phase === 'failed' ? call.startCall : undefined}
        disabled={!call.supportsDirectCall || call.busy || call.showCallShelf}
        className={`rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          call.showCallShelf
            ? 'bg-emerald-500/10 text-emerald-200'
            : 'text-void-text-muted hover:bg-void-bg-hover hover:text-void-text'
        }`}
        title={call.supportsDirectCall ? (call.showCallShelf ? 'Call controls are open' : 'Start audio call') : 'Call unavailable'}
      >
        {call.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : call.showCallShelf ? <PhoneCall className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
      </button>
    </div>
  );
}
