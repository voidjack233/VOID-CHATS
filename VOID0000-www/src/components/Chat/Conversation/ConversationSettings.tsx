import type {
  Conversation,
  ConversationMember,
  Message,
} from '../../../Services/Chat/chatService';
import DirectConversationSettings from './DirectConversationSettings';
import GroupConversationSettings from '../Groups/GroupConversationSettings';

export interface ConversationSettingsProps {
  conversation: Conversation;
  currentUserId: string;
  members: ConversationMember[];
  onMessageCreated?: (message: Message) => void;
  onConversationUpdated?: (conversation: Conversation) => Promise<void> | void;
  onMembershipChanged?: () => Promise<void> | void;
  onConversationLeft?: () => void;
  onClose: () => void;
}

export default function ConversationSettings(props: ConversationSettingsProps) {
  if (props.conversation.type === 'group') {
    return <GroupConversationSettings {...props} />;
  }

  return (
    <DirectConversationSettings
      conversation={props.conversation}
      currentUserId={props.currentUserId}
      members={props.members}
      onMessageCreated={props.onMessageCreated}
      onConversationUpdated={props.onConversationUpdated}
      onClose={props.onClose}
    />
  );
}
