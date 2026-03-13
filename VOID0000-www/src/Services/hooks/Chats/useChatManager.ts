// src/Services/hooks/Chats/useChatManager.ts
import { useState, useEffect, useMemo, useRef } from 'react';
import { Conversation, Message, getEncryptionKey, getOrCreateDM, ensureGroupKeyDistribution } from '../../Chat/chatService';
import { gateway } from '../../Gateway/gateway';
import { decryptMessage } from '../../Crypto/messageEncryption';
import { fetchWithAuth } from '../../Auth/authServiceApi';
import { messageStore } from '../../Chat/chatStore';

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
  const [handshakeRetryToken, setHandshakeRetryToken] = useState(0);

  const handshakeCache = useRef<Record<string, {
    members: Record<string, any>;
    key: CryptoKey;
    version: number;
    keysByVersion: Record<number, CryptoKey>;
  }>>({});
  const conversationDetailsCache = useRef<Record<string, ConversationDetails>>({});
  const pendingMessages = useRef<any[]>([]);
  const lastActiveChannelRef = useRef<{ id: string; public_id?: string | null } | null>(null);

  const normalizeRequiredVersion = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return null;
  };

  const isTransientGroupKeyError = (message: string) =>
    message.includes('No group key available') ||
    message.includes('is unavailable') ||
    message.includes('not decryptable') ||
    message.includes('OperationError');

  const wait = (ms: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

  const requiredConversationKeyVersion = useMemo(() => {
    if (!activeConversation || activeConversation.type === 'dm') {
      return null;
    }

    return normalizeRequiredVersion(
      activeGroup?.current_key_version ?? activeConversation.current_key_version ?? null
    );
  }, [
    activeConversation?.id,
    activeConversation?.type,
    activeConversation?.current_key_version,
    activeGroup?.current_key_version,
  ]);

  const getConversationKeyScopeId = (conversation: Conversation | null | undefined) => {
    if (!conversation) return null;
    if (conversation.type === 'dm') return conversation.id;
    return conversation.parent_conversation_id || activeGroup?.id || conversation.id;
  };

  const getConversationKeyScopePublicId = (conversation: Conversation | null | undefined) => {
    if (!conversation) return null;
    if (conversation.type === 'dm') return conversation.public_id || null;
    return conversation.parent_public_id || activeGroup?.public_id || conversation.public_id || null;
  };

  const getConversationDetailsLookupId = (conversation: Conversation) => {
    if (conversation.type !== 'channel') {
      return conversation.public_id || conversation.id;
    }

    return (
      conversation.parent_public_id ||
      activeGroup?.public_id ||
      conversation.parent_conversation_id ||
      activeGroup?.id ||
      conversation.public_id ||
      conversation.id
    );
  };

  const getKeyLookupConversation = (conversation: Conversation): Conversation => {
    if (conversation.type !== 'channel') {
      return conversation;
    }

    const parentConversationId = conversation.parent_conversation_id || activeGroup?.id || null;
    const parentPublicId = conversation.parent_public_id || activeGroup?.public_id || null;

    if (
      parentConversationId === conversation.parent_conversation_id &&
      parentPublicId === conversation.parent_public_id
    ) {
      return conversation;
    }

    return {
      ...conversation,
      parent_conversation_id: parentConversationId,
      parent_public_id: parentPublicId,
    };
  };

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

  const getCachedConversationDetails = (identifier?: string | null) => {
    if (!identifier) return null;
    return conversationDetailsCache.current[identifier] || null;
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

  const getPeerIdForConversation = (conversation: Conversation) => {
    if (conversation.type !== 'dm') return undefined;

    const cachedConversation =
      getCachedConversationDetails(conversation.id)
      || getCachedConversationDetails(conversation.public_id)
      || null;

    return conversation.dm_user_id
      || cachedConversation?.dm_user_id
      || cachedConversation?.members?.find((member) => member.user_id !== user?.id)?.user_id
      || undefined;
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

  // 1. Handshake setup
  useEffect(() => {
    let ignore = false;

    const setupConversation = async () => {
      if (!activeConversation || !user?.id) return;
      const requiredGroupVersion = requiredConversationKeyVersion;
      const keyScopeId = getConversationKeyScopeId(activeConversation) || activeConversation.id;
      const keyScopePublicId = getConversationKeyScopePublicId(activeConversation);
      const keyLookupConversation = getKeyLookupConversation(activeConversation);

      const cached = handshakeCache.current[keyScopeId];
      if (cached && (!requiredGroupVersion || cached.version === requiredGroupVersion)) {
        setEncryptionError(null);
        setMembers(cached.members);
        setEncryptionKey(cached.key);
        setKeyVersion(cached.version);
        return; 
      }

      const staleHandshake = cached && requiredGroupVersion && cached.version !== requiredGroupVersion;
      if (staleHandshake) {
        delete handshakeCache.current[keyScopeId];
      }

      try {
        let conversationDetails = staleHandshake
          ? null
          : (
              getCachedConversationDetails(activeConversation.id) ||
              getCachedConversationDetails(activeConversation.public_id) ||
              getCachedConversationDetails(keyScopeId) ||
              getCachedConversationDetails(keyScopePublicId) ||
              getCachedConversationDetails(activeGroup?.id) ||
              getCachedConversationDetails(activeGroup?.public_id) ||
              null
            );

        if (!conversationDetails || !conversationDetails.members) {
          const lookupId = getConversationDetailsLookupId(activeConversation);
          const res = await fetchWithAuth(`/api/conversations/${lookupId}`);
          const data = await res.json();

          if (ignore) return; 
          if (!data.success) throw new Error('Could not load members');

          conversationDetails = storeConversationDetails(data.conversation as ConversationDetails);
        }

        if (ignore) return;
        if (!conversationDetails) {
          throw new Error('Could not load conversation details');
        }

        const conversationMembers = conversationDetails.members || [];
        const peer = conversationMembers.find((member: any) => member.user_id !== user.id);
        const hydratedConversationDetails: ConversationDetails = conversationDetails.type === 'dm'
          ? storeConversationDetails({
              ...conversationDetails,
              dm_user_id: conversationDetails.dm_user_id || peer?.user_id,
              dm_username: conversationDetails.dm_username || peer?.username || null,
              dm_display_name: conversationDetails.dm_display_name || peer?.display_name || null,
              dm_avatar_url: conversationDetails.dm_avatar_url || peer?.avatar_url || null,
            })
          : conversationDetails;

        setActiveConversation((prev) => {
          if (!prev || prev.id !== activeConversation.id) {
            return prev;
          }

          const needsHydration =
            prev.dm_user_id !== hydratedConversationDetails.dm_user_id ||
            prev.dm_username !== hydratedConversationDetails.dm_username ||
            prev.dm_display_name !== hydratedConversationDetails.dm_display_name ||
            prev.dm_avatar_url !== hydratedConversationDetails.dm_avatar_url;

          if (!needsHydration) {
            return prev;
          }

          return {
            ...prev,
            ...hydratedConversationDetails,
          };
        });

        const hydratedMembers = hydratedConversationDetails.members || [];
        const memberMap: Record<string, any> = {};
        hydratedMembers.forEach((m: any) => {
          memberMap[m.user_id] = m;
        });
        setMembers(memberMap);

        const peerId = activeConversation.type === 'dm'
          ? (
              activeConversation.dm_user_id ||
              hydratedConversationDetails.dm_user_id ||
              hydratedMembers.find((m: any) => m.user_id !== user.id)?.user_id
            )
          : undefined;

        if (activeConversation.type === 'dm' && !peerId) {
          throw new Error('Could not resolve DM peer');
        }

        let keyResult: { key: CryptoKey; version: number } | null = null;
        let lastKeyError: Error | null = null;

        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            keyResult = await getEncryptionKey(
              user.id,
              keyLookupConversation,
              peerId,
              requiredGroupVersion || undefined
            );
            lastKeyError = null;
            break;
          } catch (err) {
            const nextError = err instanceof Error ? err : new Error(String(err || ''));
            lastKeyError = nextError;

            if (attempt < 2 && isTransientGroupKeyError(nextError.message)) {
              await wait(450 * (attempt + 1));
              continue;
            }

            throw nextError;
          }
        }

        if (!keyResult) {
          throw lastKeyError || new Error('Failed to resolve conversation encryption key');
        }

        const { key, version } = keyResult;

        if (ignore) return; 

        if (key) {
          handshakeCache.current[keyScopeId] = {
            members: memberMap,
            key,
            version,
            keysByVersion: {
              [version]: key,
            },
          };
        }

        setEncryptionError(null);
        setEncryptionKey(key);
        setKeyVersion(version);

        // Owner auto-redistribution: re-wrap the current group key for
        // every member using fresh shared secrets.  Fixes stale
        // distributions caused by identity key changes or members added
        // without a distribution.  Fire-and-forget — never blocks the UI.
        const ownerConversation = activeGroup || activeConversation;
        if (
          ownerConversation &&
          ownerConversation.type !== 'dm' &&
          ownerConversation.owner_id === user.id
        ) {
          ensureGroupKeyDistribution(
            ownerConversation,
            user.id,
            Object.keys(memberMap)
          ).catch(() => {});
        }
      } catch (err: any) {
        if (ignore) return;
        console.error('Handshake Error:', err);
        setEncryptionKey(null);
        const reason = err instanceof Error ? err.message : String(err || '');

        if (reason.includes('Identity keys missing')) {
          setEncryptionError('Your private keys are not available on this device yet.');
          return;
        }

        if (
          reason.includes('No group key available') ||
          reason.includes('Group key version') ||
          reason.includes('not decryptable') ||
          reason.includes('OperationError')
        ) {
          setEncryptionError(
            'Group encryption keys are being refreshed. Ask the group owner to open this conversation, then try again.'
          );
          return;
        }

        setEncryptionError('Failed to load encryption keys for this chat.');
      }
    };

    setupConversation();
    return () => { ignore = true; };
  }, [
    activeConversation?.id,
    activeConversation?.public_id,
    activeConversation?.parent_conversation_id,
    activeConversation?.parent_public_id,
    activeGroup?.id,
    activeGroup?.public_id,
    requiredConversationKeyVersion,
    handshakeRetryToken,
    user?.id,
  ]);

  const resolveMessageKey = async (data: any, fallbackKey: CryptoKey) => {
    if (!activeConversation || !user?.id || activeConversation.type === 'dm') {
      return fallbackKey;
    }

    const requestedVersion = Number.isInteger(data?.key_version) && data.key_version > 0
      ? data.key_version
      : keyVersion;

    if (requestedVersion === keyVersion) {
      return fallbackKey;
    }

    const keyScopeId = getConversationKeyScopeId(activeConversation) || activeConversation.id;
    const keyLookupConversation = getKeyLookupConversation(activeConversation);
    const cacheEntry = handshakeCache.current[keyScopeId];
    const cachedKey = cacheEntry?.keysByVersion?.[requestedVersion];
    if (cachedKey) {
      return cachedKey;
    }

    const { key, version } = await getEncryptionKey(
      user.id,
      keyLookupConversation,
      getPeerIdForConversation(activeConversation),
      requestedVersion
    );

    const activeCache = handshakeCache.current[keyScopeId];
    if (activeCache) {
      activeCache.keysByVersion = {
        ...activeCache.keysByVersion,
        [version]: key,
      };

      if (version > activeCache.version) {
        activeCache.key = key;
        activeCache.version = version;
      }
    } else {
      handshakeCache.current[keyScopeId] = {
        members,
        key,
        version,
        keysByVersion: {
          [version]: key,
        },
      };
    }

    if (version > keyVersion) {
      setEncryptionKey(key);
      setKeyVersion(version);
    }

    return key;
  };

  // --- THE AUTO-HEALER FUNCTION ---
  // If decryption fails, it wipes the cache and forces a re-fetch
  const attemptDecryption = async (data: any, key: CryptoKey, isUpdate = false) => {
    try {
      const messageKey = data.encrypted_content
        ? await resolveMessageKey(data, key)
        : key;

      const content = data.encrypted_content
        ? await decryptMessage(data.encrypted_content, data.iv, messageKey)
        : data.content;
      
      if (isUpdate) {
        setMessageUpdate({ message_id: data.message_id, content, is_edited: true, edited_at: data.edited_at });
      } else {
        setNewMessage({ ...data, content });
      }
    } catch (err) {
      console.warn('Decryption failed! Keys might be stale. Auto-refreshing...', err);
      // Wipe the memory cache so the handshake runs fresh
      const keyScopeId = getConversationKeyScopeId(activeConversation);
      const keyScopePublicId = getConversationKeyScopePublicId(activeConversation);

      if (keyScopeId) {
        delete handshakeCache.current[keyScopeId];
      }

      [
        data.conversation_id,
        activeConversation?.id,
        activeConversation?.public_id,
        keyScopeId,
        keyScopePublicId,
        activeGroup?.id,
        activeGroup?.public_id,
      ]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .forEach((identifier) => {
          delete conversationDetailsCache.current[identifier];
        });

      // Explicit retry token guarantees the handshake effect runs again.
      setEncryptionKey(null);
      setHandshakeRetryToken((current) => current + 1);
      // Buffer the message to try again in a second
      const isAlreadyBuffered = pendingMessages.current.some(
        (pending) =>
          pending.message_id === data.message_id &&
          pending.conversation_id === data.conversation_id &&
          pending.edited_at === data.edited_at
      );
      if (!isAlreadyBuffered) {
        pendingMessages.current.push(data);
      }
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
    if (activeConversation?.type !== 'channel') {
      return;
    }

    lastActiveChannelRef.current = {
      id: activeConversation.id,
      public_id: activeConversation.public_id || null,
    };
  }, [activeConversation?.id, activeConversation?.public_id, activeConversation?.type]);

  useEffect(() => {
    if (!activeGroup) return;

    const channels = activeGroup.channels || [];
    if (channels.length === 0) return;

    const activeIsChannelInGroup = !!(
      activeConversation &&
      activeConversation.type === 'channel' &&
      channels.some((channel) => matchesConversationIdentifier(channel, activeConversation.id) || (
        activeConversation.public_id && matchesConversationIdentifier(channel, activeConversation.public_id)
      ))
    );

    if (activeIsChannelInGroup) {
      return;
    }

    const preferredIdentifier =
      getPreferredChannelIdentifier(null) ||
      activeGroup.default_channel_public_id ||
      activeGroup.default_channel_id ||
      null;
    const fallbackChannel = pickInitialChannel(activeGroup, preferredIdentifier);

    if (fallbackChannel.type !== 'channel') {
      return;
    }

    if (activeConversation?.id === fallbackChannel.id) {
      return;
    }

    resetLiveChatState();
    setActiveConversation(fallbackChannel);
  }, [
    activeConversation?.id,
    activeConversation?.public_id,
    activeConversation?.type,
    activeGroup?.id,
    activeGroup?.public_id,
    activeGroup?.default_channel_id,
    activeGroup?.default_channel_public_id,
    activeGroup?.channels,
  ]);

  useEffect(() => {
    if (!user?.id) return;

    const handleConversationUpdate = (data: any) => {
      const updatedConversation = data?.conversation as Conversation | undefined;
      if (!updatedConversation) return;

      const conversationIdentifier = updatedConversation.public_id || updatedConversation.id;
      const touchesActiveGroup = matchesConversationIdentifier(activeGroup, conversationIdentifier);
      const keyVersionChanged =
        touchesActiveGroup &&
        updatedConversation.current_key_version != null &&
        updatedConversation.current_key_version !== activeGroup?.current_key_version;
      const memberCountChanged =
        touchesActiveGroup &&
        updatedConversation.member_count != null &&
        updatedConversation.member_count !== activeGroup?.member_count;

      patchConversationInState(updatedConversation);

      if (touchesActiveGroup && (keyVersionChanged || memberCountChanged)) {
        const preferredChannelId =
          lastActiveChannelRef.current?.public_id ||
          lastActiveChannelRef.current?.id ||
          activeConversation?.public_id ||
          activeConversation?.id;
        void refreshActiveGroup(preferredChannelId);
      }
    };

    gateway.on('CONVERSATION_UPDATE', handleConversationUpdate);
    return () => gateway.off('CONVERSATION_UPDATE', handleConversationUpdate);
  }, [
    activeConversation?.id,
    activeConversation?.public_id,
    activeGroup?.current_key_version,
    activeGroup?.id,
    activeGroup?.member_count,
    activeGroup?.public_id,
    user?.id,
  ]);

  useEffect(() => {
    if (!user?.id) return;

    const handleMemberLeave = (data: any) => {
      const conversationId = data?.conversation_id;
      const conversationPublicId = data?.conversation_public_id || null;
      if (!conversationId) return;

      const affectedUserId =
        data?.user_id ||
        data?.member_user_id ||
        data?.target_user_id ||
        data?.removed_user_id ||
        null;

      // Only force-close when this current user is the one removed.
      if (affectedUserId && String(affectedUserId) !== String(user.id)) {
        return;
      }

      // Purge all stale caches so that if the user re-joins later
      // they start fresh — no old messages, no stale handshake keys.
      const identifiers = [conversationId, conversationPublicId].filter(Boolean) as string[];
      identifiers.forEach((id) => {
        delete handshakeCache.current[id];
        delete conversationDetailsCache.current[id];
      });

      // Clear the local IndexedDB message cache for this conversation
      // (and its channels if it was a group) so the user won't see
      // pre-kick messages if they rejoin.
      messageStore.clearConversation(conversationId).catch(() => {});
      if (activeGroup && matchesConversationIdentifier(activeGroup, conversationId)) {
        (activeGroup.channels || []).forEach((channel) => {
          messageStore.clearConversation(channel.id).catch(() => {});
          if (channel.public_id) {
            delete handshakeCache.current[channel.public_id];
            delete conversationDetailsCache.current[channel.public_id];
          }
          delete handshakeCache.current[channel.id];
          delete conversationDetailsCache.current[channel.id];
        });
      }

      if (
        matchesConversationIdentifier(activeConversation, conversationId) ||
        matchesConversationIdentifier(activeGroup, conversationId)
      ) {
        handleBackToMe();
      }
    };

    gateway.on('MEMBER_LEAVE', handleMemberLeave);
    return () => gateway.off('MEMBER_LEAVE', handleMemberLeave);
  }, [activeConversation?.id, activeConversation?.public_id, activeGroup?.id, activeGroup?.public_id, user?.id]);

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

      const nextChannels = (prev.channels || []).map((channel) =>
        matchesConversationIdentifier(channel, conversationIdentifier)
          ? (hasPatchChanges(channel) ? { ...channel, ...updatedConversation } : channel)
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

      if (!hasPatchChanges(prev || null)) {
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
