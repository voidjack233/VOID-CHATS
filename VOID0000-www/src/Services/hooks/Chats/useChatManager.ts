// src/Services/hooks/Chats/useChatManager.ts
import { useState, useEffect, useCallback } from 'react';
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
  const [replyTo, setReplyTo] = useState<string | null>(null);

  // Message update/delete state
  const [messageUpdate, setMessageUpdate] = useState<{
    message_id: string;
    content: string;
    is_edited: boolean;
    edited_at: string;
  } | null>(null);

  const [messageDelete, setMessageDelete] = useState<{
    message_id: string;
  } | null>(null);

  // NOTE: Friends removed from here — use useFriends() hook from FriendsProvider instead

  // Conversation Handshake
  const setupConversation = useCallback(async () => {
    if (!activeConversation || !user?.id) return;
    setEncryptionError(null);

    try {
      const res = await fetchWithAuth(`/api/conversations/${activeConversation.id}`);
      const data = await res.json();
      if (!data.success) throw new Error('Could not load members');

      const memberMap: Record<string, any> = {};
      data.conversation.members.forEach((m: any) => memberMap[m.user_id] = m);
      setMembers(memberMap);

      const peerId = activeConversation.type === 'dm'
        ? data.conversation.members.find((m: any) => m.user_id !== user.id)?.user_id
        : undefined;

      const { key, version } = await getEncryptionKey(user.id, activeConversation, peerId);
      setEncryptionKey(key);
      setKeyVersion(version);
    } catch (err: any) {
      console.error('Handshake Error:', err);
      setEncryptionKey(null);

      const msg = err.message || '';
      if (msg.includes('another device') || msg.includes('keys missing') || msg.includes('Identity keys')) {
        setEncryptionError('Your encryption keys are not available on this device. Log in from your primary browser to access encrypted messages.');
      } else if (msg.includes('No public key')) {
        setEncryptionError('The other user needs to log in to initialize their encryption keys.');
      } else {
        setEncryptionError(msg || 'Key exchange failed');
      }
    }
  }, [activeConversation, user?.id]);

  useEffect(() => { setupConversation(); }, [setupConversation]);

  // Real-time: New Messages
  useEffect(() => {
    if (!user?.id) return;
    const handleMessage = async (data: any) => {
      if (data.conversation_id === activeConversation?.id && encryptionKey) {
        try {
          const content = data.encrypted_content
            ? await decryptMessage(data.encrypted_content, data.iv, encryptionKey)
            : data.content;
          setNewMessage({ ...data, content });
        } catch {
          setNewMessage({ ...data, content: '[Decryption Failed]' });
        }
      }
    };
    gateway.on('MESSAGE_CREATE', handleMessage);
    return () => gateway.off('MESSAGE_CREATE', handleMessage);
  }, [activeConversation?.id, encryptionKey, user?.id]);

  // Real-time: Message Edits (from other users)
  useEffect(() => {
    if (!user?.id) return;
    const handleUpdate = async (data: any) => {
      if (data.conversation_id === activeConversation?.id && encryptionKey) {
        try {
          const content = data.encrypted_content
            ? await decryptMessage(data.encrypted_content, data.iv, encryptionKey)
            : '[encrypted]';
          setMessageUpdate({
            message_id: data.message_id,
            content,
            is_edited: true,
            edited_at: data.edited_at,
          });
        } catch {
          setMessageUpdate({
            message_id: data.message_id,
            content: '[Decryption Failed]',
            is_edited: true,
            edited_at: data.edited_at,
          });
        }
      }
    };
    gateway.on('MESSAGE_UPDATE', handleUpdate);
    return () => gateway.off('MESSAGE_UPDATE', handleUpdate);
  }, [activeConversation?.id, encryptionKey, user?.id]);

  // Real-time: Message Deletions (from other users)
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
    setEncryptionError(null);
    setActiveConversation(conv);
    setEditingMessage(null);
    setReplyTo(null);
    setNewMessage(null);
    setMessageUpdate(null);
    setMessageDelete(null);
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
    members,
    activeConversation,
    encryptionKey,
    keyVersion,
    encryptionError,
    newMessage,
    editingMessage,
    replyTo,
    messageUpdate,
    messageDelete,
    setEditingMessage,
    setReplyTo,
    setMessageUpdate,
    handleSelectConversation,
    handleMessageSent: setNewMessage,
    handleBackToMe,
    handleStartDM,
  };
};