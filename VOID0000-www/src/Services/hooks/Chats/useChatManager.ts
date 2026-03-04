// src/Services/hooks/Chats/useChatManager.ts
import { useState, useEffect, useRef } from 'react';
import { Conversation, Message, getEncryptionKey, getOrCreateDM } from '../../Chat/chatService';
import { gateway } from '../../Gateway/gateway';
import { decryptMessage } from '../../Crypto/messageEncryption';
import { fetchWithAuth } from '../../Auth/authServiceApi';

export const useChatManager = (user: any) => {
  const [members, setMembers] = useState<Record<string, any>>({});
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [encryptionKey, setEncryptionKey] = useState<CryptoKey | null>(null);
  const [keyVersion, setKeyVersion] = useState(1);
  const [encryptionError, setEncryptionError] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [messageUpdate, setMessageUpdate] = useState<{ message_id: string; content: string; is_edited: boolean; edited_at: string } | null>(null);
  const [messageDelete, setMessageDelete] = useState<{ message_id: string } | null>(null);

  const handshakeCache = useRef<Record<string, { members: Record<string, any>; key: CryptoKey; version: number }>>({});
  const pendingMessages = useRef<any[]>([]);

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
        const res = await fetchWithAuth(`/api/conversations/${activeConversation.id}`);
        const data = await res.json();

        if (ignore) return; 
        if (!data.success) throw new Error('Could not load members');

        const memberMap: Record<string, any> = {};
        data.conversation.members.forEach((m: any) => memberMap[m.user_id] = m);
        setMembers(memberMap);

        const peerId = activeConversation.type === 'dm'
          ? data.conversation.members.find((m: any) => m.user_id !== user.id)?.user_id
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

  // Handlers
  const handleSelectConversation = (conv: Conversation) => {
    if (activeConversation?.id === conv.id) return;
    setEncryptionKey(null);
    setEncryptionError(null);
    setActiveConversation(conv);
    setEditingMessage(null);
    setReplyTo(null);
    setNewMessage(null);
    setMessageUpdate(null);
    setMessageDelete(null);
    pendingMessages.current = [];
  };

  const handleBackToMe = () => {
    setActiveConversation(null);
    setEncryptionError(null);
    setEncryptionKey(null);
  };

  const handleStartDM = async (targetId: string) => {
    const { conversation_id } = await getOrCreateDM(targetId);
    const res = await fetchWithAuth(`/api/conversations/${conversation_id}`);
    const data = await res.json();
    if (data.success) handleSelectConversation(data.conversation);
  };

  return {
    members, activeConversation, encryptionKey, keyVersion, encryptionError,
    newMessage, editingMessage, replyTo, messageUpdate, messageDelete,
    setEditingMessage, setReplyTo, setMessageUpdate,
    handleSelectConversation, handleMessageSent: setNewMessage, handleBackToMe, handleStartDM,
  };
};