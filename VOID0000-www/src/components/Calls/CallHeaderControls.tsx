import { createPortal } from 'react-dom';
import { Loader2, Phone, PhoneCall } from 'lucide-react';
import { useCallController } from '../../Services/Calls/useCallController';
import type { CallHeaderControlsProps } from '../../Services/Calls/callTypes';
import CallShelf from './CallShelf';

export type { PendingIncomingCall } from '../../Services/Calls/callTypes';

export default function CallHeaderControls(props: CallHeaderControlsProps) {
  const { conversation } = props;
  const call = useCallController(props);

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

  const callShelf = call.showCallShelf ? <CallShelf {...call.shelfProps} /> : null;

  return (
    <div className="ml-2 flex shrink-0 items-center gap-2">
      <audio ref={call.remoteAudioRef} autoPlay playsInline className="hidden" />
      {callShelf && typeof document !== 'undefined' ? createPortal(callShelf, document.body) : callShelf}

      <button
        type="button"
        onClick={call.phase === 'idle' || call.phase === 'failed' ? call.startCall : undefined}
        disabled={!call.supportsDirectCall || call.busy || call.showCallShelf}
        className={`rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          call.showCallShelf
            ? 'bg-emerald-500/10 text-emerald-200'
            : 'text-void-text-muted hover:bg-void-bg-hover hover:text-void-text'
        }`}
        title={call.supportsDirectCall ? (call.showCallShelf ? 'Call controls are below' : 'Start audio call') : 'Call unavailable'}
      >
        {call.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : call.showCallShelf ? <PhoneCall className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
      </button>
    </div>
  );
}
