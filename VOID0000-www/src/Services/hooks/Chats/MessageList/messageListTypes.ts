export interface MessageUpdate {
  message_id: string;
  content: string;
  is_edited: boolean;
  edited_at: string;
}

export interface MessageDelete {
  message_id: string;
}
