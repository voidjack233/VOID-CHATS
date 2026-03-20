// src/Services/hooks/Chats/useChatManager.ts
import { useState, useEffect, useRef } from 'react';
import { Conversation, Message, getOrCreateDM } from '../../Chat/chatService';
import { fetchWithAuth } from '../../Auth/authServiceApi';
import { ConversationDetails } from '../../Chat/chatTypes';
import { getConversationDetails, storeConversationDetails } from '../../Chat/conversationCache';
import { matchesConversationIdentifier, hasLoadedChannel, pickInitialChannel } from '../../Chat/utils/conversationUtils';
import { useTypingIndicator } from './useTypingIndicator';
import { useConversationHandshake } from './useConversationHandshake';
import { useMessageStream } from './useMessageStream';
import { useConversationSync } from './useConversationSync';

export const useChatManager = (user: any) => {
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [activeGroup, setActiveGroup] = useState<Conversation | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);

  const { typingUsers, clearUserTyping } = useTypingIndicator({ activeConversation, user });

  const lastActiveChannelRef = useRef<{ id: string; public_id?: string | null } | null>(null);

  const getCachedConversationDetails = (identifier?: string | null) => {
    if (!identifier) return null;
    return getConversationDetails(identifier);
  };

  const hasConversationDetails = (conversation: Conversation | null | undefined) => {
    if (!conversation) return false;

    const cachedConversation =
      getCachedConversationDetails(conversation.id) ||
      getCachedConversationDetails(conversation.public_id) ||
      null;

    if (conversation.type === 'dm') {
      return !!(
        cachedConversation?.members?.length ||
        (conversation.dm_user_id && (conversation.dm_display_name || conversation.dm_username))
      );
    }

    return !!cachedConversation?.members?.length;
  };

  const fetchConversationByIdentifier = async (identifier: string) => {
    const res = await fetchWithAuth(`/api/conversations/${identifier}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to load conversation');

    const conversation = data.conversation as ConversationDetails;

    if (conversation.type !== 'dm') {
      return storeConversationDetails(conversation) as Conversation;
    }

    const peer = conversation.members?.find((member) => member.user_id !== user?.id);

    return storeConversationDetails({
      ...conversation,
      dm_user_id: conversation.dm_user_id || peer?.user_id,
      dm_username: conversation.dm_username || peer?.username || null,
      dm_display_name: conversation.dm_display_name || peer?.display_name || null,
      dm_avatar_url: conversation.dm_avatar_url || peer?.avatar_url || null,
    }) as Conversation;
  };

  // Defined before useConversationHandshake so it can be passed as onPatchConversation.
  const patchConversationInState = (updatedConversation: Conversation) => {
    const conversationIdentifier = updatedConversation.public_id || updatedConversation.id;
    const cachedConversation =
      getCachedConversationDetails(updatedConversation.id) ||
      getCachedConversationDetails(updatedConversation.public_id) ||
      null;
    const hasPatchChanges = (target: Conversation | null | undefined) =>
      !!target &&
      Object.entries(updatedConversation).some(
        ([key, value]) => (target as any)[key] !== value
      );

    if (cachedConversation) {
      storeConversationDetails({
        ...cachedConversation,
        ...updatedConversation,
      });
    }

    setActiveGroup((prev) => {
      if (!prev) return prev;

      if (matchesConversationIdentifier(prev, conversationIdentifier)) {
        if (!hasPatchChanges(prev)) {
          return prev;
        }

        return {
          ...prev,
          ...updatedConversation,
          channels: prev.channels || [],
        };
      }

      const existingChannels = prev.channels || [];
      const isExistingChannel = existingChannels.some((channel) =>
        matchesConversationIdentifier(channel, conversationIdentifier)
      );

      if (isExistingChannel) {
        const nextChannels = existingChannels.map((channel) =>
          matchesConversationIdentifier(channel, conversationIdentifier)
            ? (hasPatchChanges(channel) ? { ...channel, ...updatedConversation } : channel)
            : channel
        );

        const didChange = nextChannels.some((channel, index) => channel !== existingChannels[index]);
        if (!didChange) return prev;

        return {
          ...prev,
          channels: nextChannels,
        };
      }

      // New channel belonging to this group — append it
      const isNewChannel =
        updatedConversation.type === 'channel' &&
        (matchesConversationIdentifier(prev, updatedConversation.parent_conversation_id) ||
          matchesConversationIdentifier(prev, updatedConversation.parent_public_id));

      if (isNewChannel) {
        return {
          ...prev,
          channels: [...existingChannels, updatedConversation],
        };
      }

      return prev;
    });

    setActiveConversation((prev) => {
      if (!matchesConversationIdentifier(prev, conversationIdentifier)) {
        return prev;
      }

      if (!hasPatchChanges(prev || null)) {
        return prev;
      }

      return {
        ...prev,
        ...updatedConversation,
      };
    });
  };

  const {
    members,
    encryptionKey,
    keyVersion,
    encryptionError,
    retryHandshake,
    updateKey,
    resetCryptoState,
    getConversationKeyScopeId,
    getConversationKeyScopePublicId,
    getKeyLookupConversation,
  } = useConversationHandshake({
    activeConversation,
    activeGroup,
    user,
    onHydrateDm: (updater) => setActiveConversation(updater),
    onPatchConversation: patchConversationInState,
  });

  const {
    newMessage,
    messageUpdate,
    messageDelete,
    setNewMessage,
    setMessageUpdate,
    resetMessageStream,
  } = useMessageStream({
    activeConversation,
    activeGroup,
    user,
    encryptionKey,
    keyVersion,
    members,
    clearUserTyping,
    retryHandshake,
    updateKey,
    getConversationKeyScopeId,
    getConversationKeyScopePublicId,
    getKeyLookupConversation,
  });

  const resetLiveChatState = () => {
    resetCryptoState();
    setEditingMessage(null);
    setReplyTo(null);
    resetMessageStream();
  };

  const getPreferredChannelIdentifier = (preferredChannelId?: string | null) => {
    if (preferredChannelId) return preferredChannelId;

    if (activeConversation?.type === 'channel') {
      return activeConversation.public_id || activeConversation.id;
    }

    return (
      lastActiveChannelRef.current?.public_id ||
      lastActiveChannelRef.current?.id ||
      null
    );
  };

  const openGroupByIdentifier = async (
    groupIdentifier: string,
    preferredChannelId?: string | null,
    seedConversation?: Conversation,
    options?: { forceReload?: boolean }
  ) => {
    const preferredIdentifier = getPreferredChannelIdentifier(preferredChannelId);
    const shouldReuseLoadedGroup =
      !options?.forceReload &&
      activeGroup &&
      matchesConversationIdentifier(activeGroup, groupIdentifier) &&
      (!preferredIdentifier || hasLoadedChannel(activeGroup, preferredIdentifier));

    if (shouldReuseLoadedGroup) {
      const selectedChannel = pickInitialChannel(activeGroup, preferredIdentifier);
      const keepCurrentChannel =
        selectedChannel.type === 'group' &&
        activeConversation?.type === 'channel' &&
        (matchesConversationIdentifier(activeGroup, activeConversation.parent_conversation_id) ||
          matchesConversationIdentifier(activeGroup, activeConversation.parent_public_id));
      const nextChannel = keepCurrentChannel ? activeConversation : selectedChannel;

      if (activeConversation?.id !== nextChannel.id) {
        resetLiveChatState();
        setActiveConversation(nextChannel);
      }
      return { group: activeGroup, conversation: nextChannel };
    }

    const cachedGroup = !options?.forceReload ? getCachedConversationDetails(groupIdentifier) : null;
    const groupConversation = (cachedGroup || await fetchConversationByIdentifier(groupIdentifier)) as Conversation;
    if (groupConversation.type !== 'group') {
      throw new Error('Requested conversation is not a group');
    }

    const fallbackChannels = matchesConversationIdentifier(activeGroup, groupIdentifier)
      ? (activeGroup?.channels || [])
      : (seedConversation?.channels || []);
    const fetchedChannels = Array.isArray(groupConversation.channels) ? groupConversation.channels : [];
    const hydratedChannels = fetchedChannels.length > 0 ? fetchedChannels : fallbackChannels;

    const hydratedGroup: Conversation = {
      ...seedConversation,
      ...groupConversation,
      channels: hydratedChannels,
    };

    const selectedChannel = pickInitialChannel(hydratedGroup, preferredIdentifier);
    const activeChannelBelongsToGroup = !!(
      activeConversation?.type === 'channel' &&
      (
        matchesConversationIdentifier(hydratedGroup, activeConversation.parent_conversation_id) ||
        matchesConversationIdentifier(hydratedGroup, activeConversation.parent_public_id) ||
        hydratedChannels.some((channel) =>
          matchesConversationIdentifier(channel, activeConversation.id) ||
          (activeConversation.public_id
            ? matchesConversationIdentifier(channel, activeConversation.public_id)
            : false)
        )
      )
    );
    const shouldKeepCurrentChannel =
      selectedChannel.type === 'group' &&
      activeChannelBelongsToGroup;
    const nextChannel = shouldKeepCurrentChannel ? activeConversation : selectedChannel;
    const isSameChannel = activeConversation?.id === nextChannel.id;

    if (!isSameChannel) {
      resetLiveChatState();
    }

    setActiveGroup(hydratedGroup);

    // Only update activeConversation if the channel actually changed.
    // Setting a new object reference for the same channel triggers
    // useMessageList to clear messages and re-fetch unnecessarily.
    if (!isSameChannel) {
      setActiveConversation(nextChannel);
    }

    return { group: hydratedGroup, conversation: isSameChannel ? (activeConversation as Conversation) : nextChannel };
  };

  const openConversationByIdentifier = async (identifier: string) => {
    if (
      !activeGroup &&
      matchesConversationIdentifier(activeConversation, identifier) &&
      hasConversationDetails(activeConversation)
    ) {
      return activeConversation;
    }

    const conversation = (getCachedConversationDetails(identifier) || await fetchConversationByIdentifier(identifier)) as Conversation;
    if (conversation.type === 'group') {
      const result = await openGroupByIdentifier(identifier, null, conversation);
      return result.conversation;
    }

    resetLiveChatState();
    setActiveGroup(null);
    setActiveConversation(conversation);
    return conversation;
  };

  const refreshActiveGroup = async (preferredChannelId?: string | null) => {
    if (!activeGroup) return;
    try {
      const preferredIdentifier =
        getPreferredChannelIdentifier(preferredChannelId) ||
        activeGroup.default_channel_public_id ||
        activeGroup.default_channel_id ||
        null;

      await openGroupByIdentifier(
        activeGroup.public_id || activeGroup.id,
        preferredIdentifier,
        activeGroup,
        { forceReload: true }
      );
    } catch (err) {
      console.error('Failed to refresh group:', err);
    }
  };

  const handleBackToMe = () => {
    resetLiveChatState();
    setActiveConversation(null);
    setActiveGroup(null);
  };

  // Tracks the last active channel so that group navigation and sync events
  // can restore to the same channel after a reload.
  useEffect(() => {
    if (activeConversation?.type !== 'channel') {
      return;
    }

    lastActiveChannelRef.current = {
      id: activeConversation.id,
      public_id: activeConversation.public_id || null,
    };
  }, [activeConversation?.id, activeConversation?.public_id, activeConversation?.type]);

  useConversationSync({
    activeConversation,
    activeGroup,
    user,
    lastActiveChannelRef,
    onPatchConversation: patchConversationInState,
    onRefreshActiveGroup: refreshActiveGroup,
    onBackToMe: handleBackToMe,
    onResetLiveChatState: resetLiveChatState,
    onSetActiveConversation: setActiveConversation,
    getPreferredChannelIdentifier,
  });

  // Handlers
  const handleSelectConversation = (conv: Conversation) => {
    if (conv.type === 'group') {
      if (activeGroup?.id === conv.id) return;
      void openGroupByIdentifier(conv.public_id || conv.id, null, conv).catch((err) => {
        console.error('Failed to select group:', err);
        setActiveGroup(null);
        setActiveConversation(conv);
      });
      return;
    }

    if (activeConversation?.id === conv.id) return;
    resetLiveChatState();
    setActiveGroup(null);
    setActiveConversation(conv);
  };

  const handleSelectChannel = (channel: Conversation) => {
    if (activeConversation?.id === channel.id) return;
    resetLiveChatState();
    setActiveConversation(channel);
  };

  const handleStartDM = async (targetId: string) => {
    const { conversation_public_id, conversation_id } = await getOrCreateDM(targetId);
    return conversation_public_id || conversation_id;
  };

  return {
    members, activeConversation, activeGroup, encryptionKey, keyVersion, encryptionError,
    typingUsers,
    newMessage, editingMessage, replyTo, messageUpdate, messageDelete,
    setEditingMessage, setReplyTo, setMessageUpdate,
    handleSelectConversation, handleSelectChannel, refreshActiveGroup, patchConversationInState, handleMessageSent: setNewMessage,
    handleBackToMe, handleStartDM, openConversationByIdentifier, openGroupByIdentifier,
    handleEncryptionKeyResolved: updateKey,
    retryHandshake,
  };
};
