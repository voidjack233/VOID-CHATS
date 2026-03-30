export interface GroupPermissions {
  admin_can_remove_members: boolean;
  admin_can_approve_join_requests: boolean;
  admin_can_edit_member_nicknames: boolean;
  admin_can_edit_group_profile: boolean;
  admin_can_manage_invite_links: boolean;
  members_can_set_own_nickname: boolean;
  who_can_send_attachments: 'everyone' | 'admins' | 'owner';
  who_can_create_invite_links: 'everyone' | 'admins' | 'owner';
  who_can_approve_requests: 'everyone' | 'admins' | 'owner';
  who_can_edit_other_nicknames: 'everyone' | 'admins' | 'owner';
  who_can_edit_own_nickname: 'everyone' | 'admins' | 'owner';
  who_can_edit_group_profile: 'everyone' | 'admins' | 'owner';
}

export interface Conversation {
  id: string;
  public_id?: string | null;
  type: 'dm' | 'group' | 'channel';
  name: string | null;
  slowmode_seconds?: number;
  owner_id: string | null;
  current_key_version?: number | null;
  icon_filename: string | null;
  icon_url?: string | null;
  parent_conversation_id?: string | null;
  parent_public_id?: string | null;
  created_at: string;
  updated_at: string;
  role: string;
  last_read_message_id: string | null;
  unread_count?: number;
  last_message_id?: string | null;
  last_message_sender_id?: string | null;
  last_message_preview?: string | null;
  dm_user_id?: string;
  dm_username: string | null;
  dm_display_name: string | null;
  dm_avatar_url: string | null;
  member_count: number;
  channels?: Conversation[];
  permissions?: GroupPermissions;
}

export interface Attachment {
  url: string;
  blurhash?: string;
  encrypted?: boolean;
  iv?: string;
  key?: string;
  mime?: string;
  name?: string;
  size?: number;
}

export type MessageCryptoProtocol = 'legacy_aes' | 'mls';

export interface ReactionMap {
  [emoji: string]: string[] | { count: number; me: boolean };
}

export interface Message {
  conversation_id: string;
  conversation_public_id?: string | null;
  message_id: string;
  sender_id: string;
  encrypted_content: string | null;
  iv: string | null;
  key_version: number;
  message_type: string;
  reply_to: string | null;
  attachments?: string[];
  is_edited: boolean;
  edited_at: string | null;
  is_deleted: boolean;
  created_at: string;
  content?: string;
  reactions?: ReactionMap;
  protocol?: MessageCryptoProtocol | null;
  protocol_version?: number | null;
  decryption_failed?: boolean;
  local_status?: 'sending' | 'sent' | 'failed' | 'queued';
  local_client_id?: string;
}

export interface KeyBackupRecord {
  encrypted_private_key: string;
  iv: string;
  salt: string;
  key_id: string;
  created_at?: string;
  recovery_encrypted_private_key?: string | null;
  recovery_iv?: string | null;
  recovery_salt?: string | null;
  recovery_key_id?: string | null;
  recovery_configured_at?: string | null;
  mls_state_encrypted?: string | null;
  mls_state_iv?: string | null;
  mls_state_salt?: string | null;
}

export interface MessageDecryptionContext {
  conversation?: Conversation;
  userId?: string;
  currentKeyVersion?: number;
}

export interface ConversationMember {
  user_id: string;
  role: string;
  nickname: string | null;
  joined_at: string;
  joined_key_version?: number | null;
  history_start_version?: number | null;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_id: string;
}

export interface ConversationInviteLink {
  id: number;
  code: string;
  url: string;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  is_revoked: boolean;
  created_at: string;
}

export interface ConversationJoinRequest {
  id: number;
  status: string;
  created_at: string;
  invite_link_id: number | null;
  requester_user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_id: string;
}

export interface InvitePreview {
  id: number;
  code: string;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  created_at: string;
  conversation_id: string;
  conversation_public_id?: string | null;
  conversation_name: string | null;
  conversation_icon_url?: string | null;
  owner_id: string | null;
  owner_display_name: string | null;
  owner_username: string | null;
  owner_avatar_url: string | null;
  member_count: number;
}

export interface ConversationDetails extends Conversation {
  members?: ConversationMember[];
}

export interface HandshakeCacheEntry {
  members: Record<string, ConversationMember>;
  key: CryptoKey;
  version: number;
  keysByVersion: Record<number, CryptoKey>;
}

export type VersionedDecryptableMessage = {
  encrypted_content: string | null;
  iv: string | null;
  is_deleted: boolean;
  key_version?: number;
  [key: string]: any;
};
