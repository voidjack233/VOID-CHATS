// src/Services/hooks/Chats/useChatManager.ts
import { useState, useEffect, useRef } from 'react';
import { Conversation, Message, getEncryptionKey, getOrCreateDM } from '../../Chat/chatService';
import { gateway } from '../../Gateway/gateway';
import { decryptMessage } from '../../Crypto/messageEncryption';
import { fetchWithAuth } from '../../Auth/authServiceApi';

type ConversationDetails = Conversation & {
  members?: Array<{
    user_id: string;
    username?: string | null;
    display_name?: string | null;
    avatar_url?: string | null;
  }>;
};

export const useChatManager = (user: any) => {
  const [members, setMembers] = useState<Record<string, any>>({});
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [activeGroup, setActiveGroup] = useState<Conversation | null>(null);
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null);
  const [keyVersion, setKeyVersion] = useState(1);
  const [encryptionError, setEncryptionError] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [messageUpdate, setMessageUpdate] = useState<{ message_id: string; content: string; is_edited: boolean; edited_at: string } | null>(null);
  const [messageDelete, setMessageDelete] = useState<{ message_id: string } | null>(null);

  const handshakeCache = useRef<Record<string, { members: Record<string, any>; key: CryptoKey; version: number }>>({});
  const conversationDetailsCache = useRef<Record<string, ConversationDetails>>({});
  const pendingMessages = useRef<any[]>([]);

  const resetLiveChatState = () => {
    setEncryptionKey(null);
    setEncryptionError(null);
    setEditingMessage(null);
    setReplyTo(null);
    setNewMessage(null);
    setMessageUpdate(null);
    setMessageDelete(null);
    pendingMessages.current = [];
  };

  const matchesConversationIdentifier = (conversation: Conversation | null, identifier?: string | null) => {
    if (!conversation || !identifier) return false;
    return conversation.id === identifier || conversation.public_id === identifier;
  };

  const hasLoadedChannel = (groupConversation: Conversation | null, channelIdentifier?: string | null) => {
    if (!groupConversation || !channelIdentifier) return false;
    return (groupConversation.channels || []).some((channel) =>
      matchesConversationIdentifier(channel, channelIdentifier)
    );
  };

  const pickInitialChannel = (groupConversation: Conversation, preferredChannelId?: string | null) => {
    const channels = groupConversation.channels || [];
    if (channels.length === 0) return groupConversation;

    return (
      channels.find((channel) => matchesConversationIdentifier(channel, preferredChannelId)) ||
      channels.find((channel) => matchesConversationIdentifier(channel, groupConversation.default_channel_id)) ||
      channels.find((channel) => matchesConversationIdentifier(channel, groupConversation.default_channel_public_id)) ||
      channels.find((channel) => channel.name?.toLowerCase() === 'general') ||
      channels[0] ||
      groupConversation
    );
  };

  const getCachedConversationDetails = (identifier?: string | null) => {
    if (!identifier) return null;
    return conversationDetailsCache.current[identifier] || null;
  };

  const storeConversationDetails = (conversation: ConversationDetails) => {
    const cacheEntry: ConversationDetails = {
      ...conversation,
      channels: conversation.channels || [],
    };

    conversationDetailsCache.current[cacheEntry.id] = cacheEntry;

    if (cacheEntry.public_id) {
      conversationDetailsCache.current[cacheEntry.public_id] = cacheEntry;
    }

    if (cacheEntry.type === 'group') {
      (cacheEntry.channels || []).forEach((channel) => {
        const channelEntry: ConversationDetails = {
          ...channel,
          members: cacheEntry.members,
        };

        conversationDetailsCache.current[channel.id] = channelEntry;
        if (channel.public_id) {
          conversationDetailsCache.current[channel.public_id] = channelEntry;
        }
      });
    }

    return cacheEntry;
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

  const openGroupByIdentifier = async (
    groupIdentifier: string,
    preferredChannelId?: string | null,
    seedConversation?: Conversation,
    options?: { forceReload?: boolean }
  ) => {
    const shouldReuseLoadedGroup =
      !options?.forceReload &&
      activeGroup &&
      matchesConversationIdentifier(activeGroup, groupIdentifier) &&
      (!preferredChannelId || hasLoadedChannel(activeGroup, preferredChannelId));

    if (shouldReuseLoadedGroup) {
      const selectedChannel = pickInitialChannel(activeGroup, preferredChannelId);
      if (activeConversation?.id !== selectedChannel.id) {
        resetLiveChatState();
        setActiveConversation(selectedChannel);
      }
      return { group: activeGroup, conversation: selectedChannel };
    }

    const cachedGroup = !options?.forceReload ? getCachedConversationDetails(groupIdentifier) : null;
    const groupConversation = (cachedGroup || await fetchConversationByIdentifier(groupIdentifier)) as Conversation;
    if (groupConversation.type !== 'group') {
      throw new Error('Requested conversation is not a group');
    }

    const hydratedGroup: Conversation = {
      ...seedConversation,
      ...groupConversation,
      channels: groupConversation.channels || [],
    };

    resetLiveChatState();
    setActiveGroup(hydratedGroup);
    const selectedChannel = pickInitialChannel(hydratedGroup, preferredChannelId);
    setActiveConversation(selectedChannel);

    return { group: hydratedGroup, conversation: selectedChannel };
  };

  const openConversationByIdentifier = async (identifier: string) => {
    if (!activeGroup && matchesConversationIdentifier(activeConversation, identifier)) {
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

  // 1. Handshake setup
  useEffect(() => {
    let ignore = false;

    const setupConversation = async () => {
      if (!activeConversation || !user?.id) return;
      setEncryptionError(null);

      const cached = handshakeCache.current[activeConversation.id];
      if (cached) {
        setMembers(cached.members);
        setEncryptionKey(cached.key);
        setKeyVersion(cached.version);
        return; 
      }

      try {
        let conversationDetails = getCachedConversationDetails(activeConversation.id);

        if (!conversationDetails || !conversationDetails.members) {
          const res = await fetchWithAuth(`/api/conversations/${activeConversation.id}`);
          const data = await res.json();

          if (ignore) return; 
          if (!data.success) throw new Error('Could not load members');

          conversationDetails = storeConversationDetails(data.conversation as ConversationDetails);
        }

        if (ignore || !conversationDetails?.members) return;

        const memberMap: Record<string, any> = {};
        conversationDetails.members.forEach((m: any) => memberMap[m.user_id] = m);
        setMembers(memberMap);

        const peerId = activeConversation.type === 'dm'
          ? conversationDetails.members.find((m: any) => m.user_id !== user.id)?.user_id
          : undefined;

        const { key, version } = await getEncryptionKey(user.id, activeConversation, peerId);

        if (ignore) return; 

        if (key) {
          handshakeCache.current[activeConversation.id] = { members: memberMap, key, version };
        }

        setEncryptionKey(key);
        setKeyVersion(version);
      } catch (err: any) {
        if (ignore) return;
        console.error('Handshake Error:', err);
        setEncryptionKey(null);
        setEncryptionError('Failed to load encryption keys for this chat.');
      }
    };

    setupConversation();
    return () => { ignore = true; };
  }, [activeConversation?.id, user?.id]);

  // --- THE AUTO-HEALER FUNCTION ---
  // If decryption fails, it wipes the cache and forces a re-fetch
  const attemptDecryption = async (data: any, key: CryptoKey, isUpdate = false) => {
    try {
      const content = data.encrypted_content
        ? await decryptMessage(data.encrypted_content, data.iv, key)
        : data.content;
      
      if (isUpdate) {
        setMessageUpdate({ message_id: data.message_id, content, is_edited: true, edited_at: data.edited_at });
      } else {
        setNewMessage({ ...data, content });
      }
    } catch (err) {
      console.warn('Decryption failed! Keys might be stale. Auto-refreshing...', err);
      // Wipe the memory cache so the handshake runs fresh
      delete handshakeCache.current[data.conversation_id];
      delete conversationDetailsCache.current[data.conversation_id];
      // Setting key to null triggers the handshake useEffect again!
      setEncryptionKey(null);
      // Buffer the message to try again in a second
      pendingMessages.current.push(data);
    }
  };

  // 2. Buffer Flush
  useEffect(() => {
    if (!encryptionKey || !activeConversation?.id || pendingMessages.current.length === 0) return;

    const flush = async () => {
      const toProcess = [...pendingMessages.current];
      pendingMessages.current = [];

      for (const data of toProcess) {
        if (data.conversation_id !== activeConversation.id) continue;
        await attemptDecryption(data, encryptionKey);
      }
    };
    flush();
  }, [encryptionKey, activeConversation?.id]);

  // 3. New Messages
  useEffect(() => {
    if (!user?.id) return;
    const handleMessage = async (data: any) => {
      if (data.conversation_id === activeConversation?.id) {
        if (encryptionKey) {
          await attemptDecryption(data, encryptionKey);
        } else {
          pendingMessages.current.push(data);
        }
      }
    };
    gateway.on('MESSAGE_CREATE', handleMessage);
    return () => gateway.off('MESSAGE_CREATE', handleMessage);
  }, [activeConversation?.id, encryptionKey, user?.id]);

  // 4. Message Edits
  useEffect(() => {
    if (!user?.id) return;
    const handleUpdate = async (data: any) => {
      if (data.conversation_id === activeConversation?.id && encryptionKey) {
        await attemptDecryption(data, encryptionKey, true);
      }
    };
    gateway.on('MESSAGE_UPDATE', handleUpdate);
    return () => gateway.off('MESSAGE_UPDATE', handleUpdate);
  }, [activeConversation?.id, encryptionKey, user?.id]);

  // 5. Message Deletions
  useEffect(() => {
    if (!user?.id) return;
    const handleDeleteEvent = (data: any) => {
      if (data.conversation_id === activeConversation?.id) {
        setMessageDelete({ message_id: data.message_id });
      }
    };
    gateway.on('MESSAGE_DELETE', handleDeleteEvent);
    return () => gateway.off('MESSAGE_DELETE', handleDeleteEvent);
  }, [activeConversation?.id, user?.id]);

  useEffect(() => {
    if (!user?.id) return;

    const handleConversationUpdate = (data: any) => {
      const updatedConversation = data?.conversation as Conversation | undefined;
      if (!updatedConversation) return;
      patchConversationInState(updatedConversation);
    };

    gateway.on('CONVERSATION_UPDATE', handleConversationUpdate);
    return () => gateway.off('CONVERSATION_UPDATE', handleConversationUpdate);
  }, [user?.id]);

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

  const refreshActiveGroup = async (preferredChannelId?: string | null) => {
    if (!activeGroup) return;
    try {
      await openGroupByIdentifier(
        activeGroup.public_id || activeGroup.id,
        preferredChannelId || activeConversation?.public_id || activeConversation?.id,
        activeGroup,
        { forceReload: true }
      );
    } catch (err) {
      console.error('Failed to refresh group:', err);
    }
  };

  const patchConversationInState = (updatedConversation: Conversation) => {
    const conversationIdentifier = updatedConversation.public_id || updatedConversation.id;
    const cachedConversation =
      getCachedConversationDetails(updatedConversation.id) ||
      getCachedConversationDetails(updatedConversation.public_id) ||
      null;

    if (cachedConversation) {
      storeConversationDetails({
        ...cachedConversation,
        ...updatedConversation,
      });
    }

    setActiveGroup((prev) => {
      if (!prev) return prev;

      if (matchesConversationIdentifier(prev, conversationIdentifier)) {
        return {
          ...prev,
          ...updatedConversation,
          channels: prev.channels || [],
        };
      }

      const nextChannels = (prev.channels || []).map((channel) =>
        matchesConversationIdentifier(channel, conversationIdentifier)
          ? { ...channel, ...updatedConversation }
          : channel
      );

      const didChange = nextChannels.some((channel, index) => channel !== (prev.channels || [])[index]);
      if (!didChange) return prev;

      return {
        ...prev,
        channels: nextChannels,
      };
    });

    setActiveConversation((prev) => {
      if (!matchesConversationIdentifier(prev, conversationIdentifier)) {
        return prev;
      }

      return {
        ...prev,
        ...updatedConversation,
      };
    });
  };

  const handleBackToMe = () => {
    resetLiveChatState();
    setActiveConversation(null);
    setActiveGroup(null);
  };

  const handleStartDM = async (targetId: string) => {
    const { conversation_public_id, conversation_id } = await getOrCreateDM(targetId);
    return conversation_public_id || conversation_id;
  };

  return {
    members, activeConversation, activeGroup, encryptionKey, keyVersion, encryptionError,
    newMessage, editingMessage, replyTo, messageUpdate, messageDelete,
    setEditingMessage, setReplyTo, setMessageUpdate,
    handleSelectConversation, handleSelectChannel, refreshActiveGroup, patchConversationInState, handleMessageSent: setNewMessage,
    handleBackToMe, handleStartDM, openConversationByIdentifier, openGroupByIdentifier,
  };
};
