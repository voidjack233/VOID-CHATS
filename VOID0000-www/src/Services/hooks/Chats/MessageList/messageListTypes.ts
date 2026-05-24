import type {
  ForwardedMessageMetadata,
  LinkPreviewMetadata,
  Message,
  MessageMentionMetadata,
} from '../../../Chat/chatTypes';

export interface MessageStreamEvent {
  sequence: number;
  message: Message;
}

export interface MessageUpdate {
  message_id: string;
  content?: string;
  is_edited?: boolean;
  edited_at?: string | null;
  message_type?: string | null;
  forwarded?: ForwardedMessageMetadata | null;
  mentions?: MessageMentionMetadata[];
  link_preview?: LinkPreviewMetadata | null;
  encrypted_link_preview?: string | null;
  link_preview_iv?: string | null;
  link_preview_key_version?: number | null;
}

export interface MessageDelete {
  message_id: string;
}
