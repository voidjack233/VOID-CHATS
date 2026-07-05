import { Loader2 } from 'lucide-react';
import type { ConversationSecurityState } from '../../../Services/Chat/conversationSecurityState';

interface EmptyMessageTimelineStateProps {
  isSecureChatPreparing: boolean;
  showCachedHistoryFallback: boolean;
  conversationSecurityState?: ConversationSecurityState;
}

export default function EmptyMessageTimelineState({
  isSecureChatPreparing,
  showCachedHistoryFallback,
  conversationSecurityState,
}: EmptyMessageTimelineStateProps) {
  if (isSecureChatPreparing) {
    return (
      <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full border border-blue-400/25 bg-blue-500/10">
          <Loader2 className="h-5 w-5 animate-spin text-blue-300" />
        </div>
        <div>
          <p className="text-sm font-semibold text-void-text">
            Preparing secure chat...
          </p>
          <p className="mt-1 text-xs text-void-text-muted">
            Waiting for encryption keys before messages can load.
          </p>
        </div>
      </div>
    );
  }

  return (
    <p className="text-center text-void-text-muted text-sm py-8">
      {showCachedHistoryFallback
        ? conversationSecurityState?.detail || 'Cached history will appear here after the latest conversation keys are restored.'
        : 'No messages yet. Say something!'}
    </p>
  );
}
