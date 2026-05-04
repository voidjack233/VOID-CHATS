// src/Services/hooks/Chats/useChatManager.ts
import { useState } from 'react';
import { Conversation, Message, getOrCreateDM } from '../../Chat/chatService';
import { fetchWithAuth } from '../../Auth/authServiceApi';
import { ConversationDetails } from '../../Chat/chatTypes';
import { getConversationDetails, storeConversationDetails } from '../../Chat/conversationCache';
import { matchesConversationIdentifier } from '../../Chat/utils/conversationUtils';
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
      dm_display_name:
        conversation.dm_display_name ||
        peer?.nickname ||
        peer?.display_name ||
        peer?.username ||
        null,
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
    conversationSecurityState,
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
    messageEvents,
    messageUpdate,
    messageDelete,
    pushMessageEvent,
    setMessageUpdate,
    resetMessageStream,
  } = useMessageStream({
    activeConversation,
    activeGroup,
    user,
    encryptionKey,
    keyVersion,
    conversationSecurityState,
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

  const openGroupByIdentifier = async (
    groupIdentifier: string,
    _preferredChannelId?: string | null,
    seedConversation?: Conversation,
    options?: { forceReload?: boolean }
  ) => {
    const hasConversationChanges = (target: Conversation | null | undefined, nextConversation: Conversation) =>
      !!target &&
      Object.entries(nextConversation).some(([key, value]) => (target as any)[key] !== value);
    const shouldReuseLoadedGroup = (
      !options?.forceReload &&
      activeGroup &&
      activeConversation?.type === 'group' &&
      matchesConversationIdentifier(activeGroup, groupIdentifier) &&
      matchesConversationIdentifier(activeConversation, activeGroup.public_id || activeGroup.id)
    );

    if (shouldReuseLoadedGroup) {
      return { group: activeGroup, conversation: activeConversation as Conversation };
    }

    const cachedGroup = !options?.forceReload ? getCachedConversationDetails(groupIdentifier) : null;
    const groupConversation = (cachedGroup || await fetchConversationByIdentifier(groupIdentifier)) as Conversation;
    if (groupConversation.type !== 'group') {
      throw new Error('Requested conversation is not a group');
    }

    const hydratedGroup: Conversation = {
      ...seedConversation,
      ...groupConversation,
      channels: [],
    };
    const isSameGroup =
      activeConversation?.type === 'group' &&
      matchesConversationIdentifier(activeConversation, hydratedGroup.public_id || hydratedGroup.id);

    if (!isSameGroup) {
      resetLiveChatState();
    }

    setActiveGroup((prev) => (
      matchesConversationIdentifier(prev, hydratedGroup.public_id || hydratedGroup.id) &&
      !hasConversationChanges(prev, hydratedGroup)
        ? prev
        : hydratedGroup
    ));
    setActiveConversation((prev) => {
      if (!isSameGroup) {
        return hydratedGroup;
      }

      return hasConversationChanges(prev, hydratedGroup)
        ? {
            ...prev,
            ...hydratedGroup,
          }
        : prev;
    });

    return { group: hydratedGroup, conversation: hydratedGroup };
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

  const refreshActiveGroup = async (_preferredChannelId?: string | null) => {
    if (!activeGroup) return;
    try {
      await openGroupByIdentifier(
        activeGroup.public_id || activeGroup.id,
        null,
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

  useConversationSync({
    activeConversation,
    activeGroup,
    user,
    onPatchConversation: patchConversationInState,
    onBackToMe: handleBackToMe,
    retryHandshake,
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

  const handleStartDM = async (targetId: string) => {
    const { conversation_public_id, conversation_id } = await getOrCreateDM(targetId);
    return conversation_public_id || conversation_id;
  };

  return {
    members, activeConversation, activeGroup, encryptionKey, keyVersion, encryptionError, conversationSecurityState,
    typingUsers,
    messageEvents, editingMessage, replyTo, messageUpdate, messageDelete,
    setEditingMessage, setReplyTo, setMessageUpdate,
    handleSelectConversation, refreshActiveGroup, patchConversationInState, handleMessageSent: pushMessageEvent,
    handleBackToMe, handleStartDM, openConversationByIdentifier, openGroupByIdentifier,
    handleEncryptionKeyResolved: updateKey,
    retryHandshake,
  };
};
