// src/Services/hooks/Chats/useMessageInput.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import { sendMessage, sendImageOnlyMessage, editMessage, uploadAttachments, Message, Conversation } from '../../Chat/chatService';

export interface PendingAttachment {
  id: string;
  preview: string; // data URL for local preview
  url: string | null; // CDN URL after upload
  uploading: boolean;
  error?: string;
}

interface UseMessageInputProps {
  conversation: Conversation;
  encryptionKey: CryptoKey | null;
  keyVersion: number;
  onMessageSent: (message: Message) => void;
  editingMessage?: Message | null;
  onCancelEdit?: () => void;
  replyTo?: Message | null;
  onCancelReply?: () => void;
  onEditComplete?: (messageId: string, newContent: string) => void;
}

const MAX_ATTACHMENTS = 5;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export const useMessageInput = ({
  conversation,
  encryptionKey,
  keyVersion,
  onMessageSent,
  editingMessage,
  onCancelEdit,
  replyTo,
  onCancelReply,
  onEditComplete,
}: UseMessageInputProps) => {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingMessage) {
      setText(editingMessage.content || '');
      inputRef.current?.focus();
    }
  }, [editingMessage]);

  useEffect(() => {
    inputRef.current?.focus();
    setAttachments([]);
  }, [conversation.id]);

  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  const uploadFile = useCallback(async (file: File, id: string) => {
    return new Promise<void>((resolve) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const data = e.target?.result as string;
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, preview: data, uploading: true } : a))
        );
        try {
          const [url] = await uploadAttachments(conversation.id, [{ data }]);
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, url: url ?? null, uploading: false } : a))
          );
        } catch {
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, uploading: false, error: 'Upload failed' } : a))
          );
        }
        resolve();
      };
      reader.readAsDataURL(file);
    });
  }, [conversation.id]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => ALLOWED_TYPES.includes(f.type));
    const slots = MAX_ATTACHMENTS - attachments.length;
    if (slots <= 0) return;

    const toAdd = arr.slice(0, slots).map((f) => ({
      id: `${Date.now()}-${Math.random()}`,
      preview: '',
      url: null,
      uploading: true,
      file: f,
    }));

    setAttachments((prev) => [...prev, ...toAdd.map(({ file: _f, ...a }) => a)]);
    toAdd.forEach(({ id, file }) => uploadFile(file, id));
  }, [attachments.length, uploadFile]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Paste handler — captures images pasted from clipboard
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items).filter(
      (item) => item.kind === 'file' && ALLOWED_TYPES.includes(item.type)
    );
    if (items.length === 0) return;
    e.preventDefault();
    const files = items.map((item) => item.getAsFile()!).filter(Boolean);
    addFiles(files);
  }, [addFiles]);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFiles(e.target.files);
      e.target.value = '';
    }
  }, [addFiles]);

  const getPlaceholder = () => {
    if (!encryptionKey) return 'Setting up encryption...';
    if (attachments.length > 0) return 'Add a caption... (optional)';
    if (conversation.type === 'dm') {
      return `Message ${conversation.dm_display_name || conversation.dm_username || 'user'}`;
    }
    return `Message ${conversation.name || 'conversation'}`;
  };

  const canSend = !sending && encryptionKey && (
    text.trim().length > 0 || attachments.some((a) => a.url)
  ) && !attachments.some((a) => a.uploading);

  const handleSend = async () => {
    if (!canSend) return;

    const trimmed = text.trim();
    const uploadedUrls = attachments.filter((a) => a.url).map((a) => a.url!);

    setText('');
    setAttachments([]);
    setSending(true);

    try {
      if (editingMessage) {
        await editMessage(
          conversation.id,
          editingMessage.message_id,
          trimmed,
          encryptionKey!,
          keyVersion
        );
        onEditComplete?.(editingMessage.message_id, trimmed);
        onCancelEdit?.();
      } else if (trimmed) {
        const msg = await sendMessage(conversation.id, trimmed, encryptionKey!, {
          key_version: keyVersion,
          reply_to: replyTo?.message_id || undefined,
          attachments: uploadedUrls,
        });
        onMessageSent(msg);
        onCancelReply?.();
      } else if (uploadedUrls.length > 0) {
        // Image-only message
        const msg = await sendImageOnlyMessage(conversation.id, uploadedUrls, {
          key_version: keyVersion,
          reply_to: replyTo?.message_id || undefined,
        });
        onMessageSent(msg);
        onCancelReply?.();
      }
    } catch (err) {
      console.error('Send failed:', err);
      if (trimmed) setText(trimmed);
    } finally {
      setSending(false);
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
    if (editingMessage) {
      onCancelEdit?.();
      setText('');
    }
    if (replyTo) onCancelReply?.();
  };

  return {
    text,
    setText,
    sending,
    canSend,
    attachments,
    inputRef,
    fileInputRef,
    getPlaceholder,
    handleSend,
    handleKeyDown,
    handleCancelAction,
    handlePaste,
    openFilePicker,
    handleFileChange,
    removeAttachment,
  };
};