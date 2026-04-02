import { Loader2 } from 'lucide-react';
import type { Conversation } from '../../../Services/Chat/chatService';
import MessageViewHeader, { buildMessageViewHeaderIdentity } from '../MessageViewHeader';

export interface MessageViewVirtuosoContext {
  loadingOlder: boolean;
  hasOlder: boolean;
  conversationRef: { current: Conversation };
  headerIdentityRef: { current: ReturnType<typeof buildMessageViewHeaderIdentity> };
  emptyStateRef: {
    current: {
      showCachedHistoryFallback: boolean;
      securityDetail?: string | null;
    };
  };
  handleProfileClick: (profileId: string) => void;
}

export const VirtuosoHeader = ({ context }: { context?: MessageViewVirtuosoContext }) => {
  if (!context) return null;

  return (
    <>
      {context.loadingOlder ? (
        <div className="flex justify-center py-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-void-bg-hover bg-void-bg-sec/90 px-3 py-1.5 text-xs font-medium text-void-text shadow-sm backdrop-blur-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-void-text-muted" />
            Loading older messages...
          </div>
        </div>
      ) : null}

      {context.hasOlder ? null : (
        <MessageViewHeader
          conversation={context.conversationRef.current}
          headerIdentity={context.headerIdentityRef.current}
          onProfileClick={context.handleProfileClick}
        />
      )}
    </>
  );
};

export const VirtuosoFooter = ({ context }: { context?: MessageViewVirtuosoContext }) => {
  if (!context) return null;
  return null;
};

export const VirtuosoEmptyPlaceholder = ({ context }: { context?: MessageViewVirtuosoContext }) => (
  <p className="text-center text-void-text-muted text-sm py-8">
    {context?.emptyStateRef.current.showCachedHistoryFallback
      ? context.emptyStateRef.current.securityDetail || 'Cached history will appear here after this device regains the latest conversation keys.'
      : 'No messages yet. Say something!'}
  </p>
);
