// src/Services/Chat/utils/conversationUtils.ts
//
// Pure utility functions for conversation identity.
// No state, no refs, no side effects — safe to call from any context.

import { Conversation } from '../chatService';

/**
 * Returns true if the conversation matches the given identifier by either
 * internal id or public_id.
 */
export const matchesConversationIdentifier = (
  conversation: Conversation | null,
  identifier?: string | null,
): boolean => {
  if (!conversation || !identifier) return false;
  return conversation.id === identifier || conversation.public_id === identifier;
};
