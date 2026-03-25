// src/Services/Chat/conversationCache.ts
//
// Module-level cache for conversation details (members and DM peer info).
//
// Previously this was a useRef<Record<string, ConversationDetails>> inside
// useChatManager. Moving it here means the cache survives component remounts,
// is shared across all hook instances, and is independently testable.
//
// Entries are keyed by both `id` and `public_id` when available so that
// lookups succeed regardless of which identifier the caller has on hand.
// storeConversationDetails handles writing both keys.

import { ConversationDetails } from './chatTypes';

const cache = new Map<string, ConversationDetails>();

export const getConversationDetails = (
  id: string | null | undefined,
): ConversationDetails | null => {
  if (!id) return null;
  return cache.get(id) ?? null;
};

export const setConversationDetails = (
  id: string,
  entry: ConversationDetails,
): void => {
  cache.set(id, entry);
};

export const deleteConversationDetails = (id: string): void => {
  cache.delete(id);
};

/**
 * Writes a conversation into the cache,
 * keyed by both id and public_id so lookups succeed with either identifier.
 * Returns the normalised cache entry.
 */
export const storeConversationDetails = (
  conversation: ConversationDetails,
): ConversationDetails => {
  const cacheEntry: ConversationDetails = {
    ...conversation,
    channels: conversation.channels || [],
  };

  setConversationDetails(cacheEntry.id, cacheEntry);

  if (cacheEntry.public_id) {
    setConversationDetails(cacheEntry.public_id, cacheEntry);
  }

  return cacheEntry;
};
