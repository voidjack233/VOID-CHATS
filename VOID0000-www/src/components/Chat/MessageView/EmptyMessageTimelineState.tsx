import type { ConversationSecurityState } from '../../../Services/Chat/conversationSecurityState';

interface EmptyMessageTimelineStateProps {
  showCachedHistoryFallback: boolean;
  conversationSecurityState?: ConversationSecurityState;
}

export default function EmptyMessageTimelineState({
  showCachedHistoryFallback,
  conversationSecurityState,
}: EmptyMessageTimelineStateProps) {
  return (
    <p className="text-center text-void-text-muted text-sm py-8">
      {showCachedHistoryFallback
        ? conversationSecurityState?.detail || 'Cached history will appear here after the latest conversation keys are restored.'
        : 'No messages yet. Say something!'}
    </p>
  );
}
