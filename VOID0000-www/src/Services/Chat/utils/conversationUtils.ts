// src/Services/Chat/utils/conversationUtils.ts
//
// Pure utility functions for conversation identity and channel resolution.
// No state, no refs, no side effects — safe to call from any context.
//
// Note: getPreferredChannelIdentifier is intentionally NOT here. It closes
// over activeConversation (state) and lastActiveChannelRef (ref) inside
// useChatManager and cannot be made pure without changing its call sites.
// It will be extracted in a later PR once it is refactored to accept those
// values as explicit arguments.

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

/**
 * Returns true if the group conversation has already loaded a channel that
 * matches the given identifier.
 */
export const hasLoadedChannel = (
  groupConversation: Conversation | null,
  channelIdentifier?: string | null,
): boolean => {
  if (!groupConversation || !channelIdentifier) return false;
  return (groupConversation.channels || []).some((channel) =>
    matchesConversationIdentifier(channel, channelIdentifier),
  );
};

/**
 * Picks the best initial channel from a group conversation, preferring the
 * caller-supplied id, then the group's default channel, then 'general', then
 * the first channel, and finally the group itself as a fallback.
 */
export const pickInitialChannel = (
  groupConversation: Conversation,
  preferredChannelId?: string | null,
): Conversation => {
  const channels = groupConversation.channels || [];
  if (channels.length === 0) return groupConversation;

  return (
    channels.find((channel) => matchesConversationIdentifier(channel, preferredChannelId)) ||
    channels.find((channel) =>
      matchesConversationIdentifier(channel, groupConversation.default_channel_id),
    ) ||
    channels.find((channel) =>
      matchesConversationIdentifier(channel, groupConversation.default_channel_public_id),
    ) ||
    channels.find((channel) => channel.name?.toLowerCase() === 'general') ||
    channels[0] ||
    groupConversation
  );
};
