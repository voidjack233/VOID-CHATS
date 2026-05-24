import { Loader2, Phone, PhoneCall } from 'lucide-react';
import type { Conversation } from '../../Services/Chat/chatService';
import { useCallContext } from './CallProvider';

interface CallHeaderControlsProps {
  conversation: Conversation;
}

export default function CallHeaderControls({ conversation }: CallHeaderControlsProps) {
  const call = useCallContext();
  const isDirectMessage = conversation.type === 'dm';

  return (
    <div className="ml-2 flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={isDirectMessage && (call.phase === 'idle' || call.phase === 'failed') ? call.startCall : undefined}
        disabled={!isDirectMessage || call.busy || call.showCallShelf}
        className={`rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          call.showCallShelf
            ? 'bg-emerald-500/10 text-emerald-200'
            : 'text-void-text-muted hover:bg-void-bg-hover hover:text-void-text'
        }`}
        title={isDirectMessage ? (call.showCallShelf ? 'Call controls are open' : 'Start audio call') : 'Group calls are later'}
        aria-label="Start audio call"
      >
        {call.busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : call.showCallShelf ? (
          <PhoneCall className="h-4 w-4" />
        ) : (
          <Phone className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
