import type {
  ForwardedMessageMetadata,
  Message,
  MessageMentionMetadata,
} from '../../../Chat/chatTypes';

export interface MessageStreamEvent {
  sequence: number;
  message: Message;
}

export interface MessageUpdate {
  message_id: string;
  content: string;
  is_edited: boolean;
  edited_at: string;
  message_type?: string | null;
  forwarded?: ForwardedMessageMetadata | null;
  mentions?: MessageMentionMetadata[];
}

export interface MessageDelete {
  message_id: string;
}
