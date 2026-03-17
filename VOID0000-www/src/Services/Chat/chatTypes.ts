// src/Services/Chat/chatTypes.ts
//
// Shared types for the chat feature that are used across hooks and cache modules.
// Keep this file free of runtime logic — types only.

import { Conversation } from './chatService';

export type ConversationMember = {
  user_id: string;
  username?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
};

export type ConversationDetails = Conversation & {
  members?: ConversationMember[];
};

export type HandshakeCacheEntry = {
  members: Record<string, ConversationMember>;
  key: CryptoKey;
  version: number;
  keysByVersion: Record<number, CryptoKey>;
};
