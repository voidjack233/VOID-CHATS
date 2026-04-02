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
