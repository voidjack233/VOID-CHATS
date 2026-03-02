// src/Services/hooks/Chats/useMessageInput.ts
import { useState, useRef, useEffect } from 'react';
import { sendMessage, editMessage, Message, Conversation } from '../../Chat/chatService';

interface UseMessageInputProps {
  conversation: Conversation;
  encryptionKey: CryptoKey | null;
  keyVersion: number;
  onMessageSent: (message: Message) => void;
  editingMessage?: Message | null;
  onCancelEdit?: () => void;
  replyTo?: string | null;
  onCancelReply?: () => void;
}

export const useMessageInput = ({
  conversation,
  encryptionKey,
  keyVersion,
  onMessageSent,
  editingMessage,
  onCancelEdit,
  replyTo,
  onCancelReply,
}: UseMessageInputProps) => {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (editingMessage) {
      setText(editingMessage.content || '');
      inputRef.current?.focus();
    }
  }, [editingMessage]);

  // Focus on conversation change
  useEffect(() => {
    inputRef.current?.focus();
  }, [conversation.id]);

  const getPlaceholder = () => {
    if (!encryptionKey) return 'Setting up encryption...';
    if (conversation.type === 'dm') {
      return `Message ${conversation.dm_display_name || conversation.dm_username || 'user'}`;
    }
    return `Message ${conversation.name || 'conversation'}`;
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || !encryptionKey || sending) return;

    setSending(true);
    try {
      if (editingMessage) {
        await editMessage(
          conversation.id,
          editingMessage.message_id,
          trimmed,
          encryptionKey,
          keyVersion
        );
        onCancelEdit?.();
      } else {
        const msg = await sendMessage(conversation.id, trimmed, encryptionKey, {
          key_version: keyVersion,
          reply_to: replyTo || undefined,
        });
        onMessageSent(msg);
        onCancelReply?.();
      }
      setText('');
    } catch (err) {
      console.error('Send failed:', err);
    } finally {
      setSending(false);
      // FIX: Re-focus the input after sending so user can keep typing
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape') {
      if (editingMessage) onCancelEdit?.();
      if (replyTo) onCancelReply?.();
    }
  };

  const handleCancelAction = () => {
    if (editingMessage) onCancelEdit?.();
    if (replyTo) onCancelReply?.();
    setText('');
  };

  return {
    text,
    setText,
    sending,
    inputRef,
    getPlaceholder,
    handleSend,
    handleKeyDown,
    handleCancelAction,
  };
};