// src/Services/hooks/Chats/useMessageInput.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import { sendMessage, sendImageOnlyMessage, editMessage, uploadAttachments, sendTypingStart, Message, Conversation } from '../../Chat/chatService';

export interface PendingAttachment {
  id: string;
  preview: string;
  url: string | null;
  blurhash?: string;
  uploading: boolean;
  error?: string;
}

interface UseMessageInputProps {
  currentUserId?: string;
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
  currentUserId,
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
  const [sendError, setSendError] = useState('');
  const [slowmodeRemaining, setSlowmodeRemaining] = useState(0);
  const lastTypingSentAtRef = useRef(0);

  // Changed to HTMLTextAreaElement
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea as text changes
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'; // Reset height to recalculate
      // Set max height to around ~120px (about 5-6 lines) before scrolling
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
    }
  }, [text]);

  useEffect(() => {
    if (editingMessage) {
      setText(editingMessage.content || '');
      inputRef.current?.focus();
    }
  }, [editingMessage]);

  useEffect(() => {
    inputRef.current?.focus();
    setAttachments([]);
    setSendError('');
    setSlowmodeRemaining(0);
    lastTypingSentAtRef.current = 0;
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
          const { urls: [url], blurhashes: [blurhash] } = await uploadAttachments(conversation.id, [{ data }]);
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, url: url ?? null, blurhash: blurhash || undefined, uploading: false } : a))
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
    if (!editingMessage && slowmodeRemaining > 0) {
      return `Slowmode active: wait ${slowmodeRemaining}s`;
    }
    if (attachments.length > 0) return 'Add a caption... (optional)';
    if (conversation.type === 'dm') {
      return `Message ${conversation.dm_display_name || conversation.dm_username || 'user'}`;
    }
    return `Message ${conversation.name || 'conversation'}`;
  };

  const isSlowmodeBlocked =
    !editingMessage &&
    slowmodeRemaining > 0 &&
    conversation.type === 'channel' &&
    !['owner', 'admin'].includes(conversation.role);

  const canSend = !sending && !isSlowmodeBlocked && encryptionKey && (
    text.trim().length > 0 || attachments.some((a) => a.url)
  ) && !attachments.some((a) => a.uploading);

  useEffect(() => {
    if (slowmodeRemaining <= 0) return;

    const timer = window.setInterval(() => {
      setSlowmodeRemaining((prev) => {
        if (prev <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [slowmodeRemaining]);

  useEffect(() => {
    if (slowmodeRemaining === 0 && sendError.toLowerCase().includes('slowmode')) {
      setSendError('');
    }
  }, [sendError, slowmodeRemaining]);

  useEffect(() => {
    const isTypingEligible =
      !!encryptionKey &&
      !sending &&
      text.trim().length > 0 &&
      !editingMessage;

    if (!isTypingEligible) {
      return;
    }

    let cancelled = false;
    const emitTyping = async () => {
      const now = Date.now();
      if (now - lastTypingSentAtRef.current < 2200) return;

      lastTypingSentAtRef.current = now;
      try {
        await sendTypingStart(conversation.id);
      } catch {
        // Typing signals are best-effort and should never block input.
      }
    };

    void emitTyping();
    const timer = window.setInterval(() => {
      if (!cancelled) {
        void emitTyping();
      }
    }, 2200);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conversation.id, editingMessage, encryptionKey, sending, text]);

  const handleSend = async () => {
    if (!canSend) return;

    const trimmed = text.trim();
    const previousText = text;
    const previousAttachments = attachments;
    const uploadedUrls = attachments
      .filter((a) => a.url)
      .map((a) => a.blurhash
        ? JSON.stringify({ url: a.url!, blurhash: a.blurhash })
        : a.url!
      );

    setSendError('');
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
          keyVersion,
          {
            messageType: editingMessage.message_type || null,
            signal: {
              userId: currentUserId,
              peerUserId: conversation.type === 'dm' ? conversation.dm_user_id : undefined,
            },
            requireSignal: conversation.type === 'dm',
          }
        );
        onEditComplete?.(editingMessage.message_id, trimmed);
        onCancelEdit?.();
      } else if (trimmed) {
        const msg = await sendMessage(conversation.id, trimmed, encryptionKey!, {
          key_version: keyVersion,
          reply_to: replyTo?.message_id || undefined,
          attachments: uploadedUrls,
          signal: {
            userId: currentUserId,
            peerUserId: conversation.type === 'dm' ? conversation.dm_user_id : undefined,
          },
          requireSignalForText: conversation.type === 'dm',
        });
        onMessageSent(msg);
        onCancelReply?.();
        if (conversation.type === 'channel' && conversation.slowmode_seconds && !['owner', 'admin'].includes(conversation.role)) {
          setSlowmodeRemaining(conversation.slowmode_seconds);
        }
      } else if (uploadedUrls.length > 0) {
        const msg = await sendImageOnlyMessage(conversation.id, uploadedUrls, {
          key_version: keyVersion,
          reply_to: replyTo?.message_id || undefined,
        });
        onMessageSent(msg);
        onCancelReply?.();
        if (conversation.type === 'channel' && conversation.slowmode_seconds && !['owner', 'admin'].includes(conversation.role)) {
          setSlowmodeRemaining(conversation.slowmode_seconds);
        }
      }
    } catch (err: any) {
      console.error('Send failed:', err);
      setText(previousText);
      setAttachments(previousAttachments);

      if (typeof err?.retry_after_seconds === 'number' && err.retry_after_seconds > 0) {
        setSlowmodeRemaining(err.retry_after_seconds);
        setSendError(err.error || err.message || `Slowmode active. Wait ${err.retry_after_seconds}s.`);
      } else if (
        err?.code === 'SIGNAL_LOCKED_SEND_BLOCKED' &&
        typeof err?.message === 'string' &&
        err.message.includes('Peer has no active Signal devices')
      ) {
        setSendError('Recipient has not finished secure messaging setup yet. Ask them to open the app once, then retry.');
      } else if (err?.code === 'SIGNAL_LOCKED_SEND_BLOCKED') {
        setSendError('Signal locked mode is enabled, but this DM is not ready yet. Please retry in a moment.');
      } else if (err?.code === 'STALE_KEY_VERSION' || err?.message?.includes('key_version') || err?.message?.includes('Not a member')) {
        setSendError('Encryption keys changed. Please close and reopen this conversation, then try again.');
      } else {
        setSendError(err?.message || 'Failed to send message');
      }
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Check if the user is on a mobile device
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (e.key === 'Enter' && !e.shiftKey) {
      if (!isMobile) {
        // Desktop behavior: Regular Enter sends the message.
        // (Shift + Enter is naturally ignored here, so it creates a new line)
        e.preventDefault();
        handleSend();
      }
      // Mobile behavior: We do absolutely nothing here. 
      // The native mobile "Return" key will just create a new line like normal.
    }

    if (e.key === 'Escape') {
      if (editingMessage) onCancelEdit?.();
      if (replyTo) onCancelReply?.();
    }
  };

  // ADDED THIS BACK IN!
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
    sendError,
    slowmodeRemaining,
    attachments,
    inputRef,
    fileInputRef,
    getPlaceholder,
    handleSend,
    handleKeyDown,
    handleCancelAction, // Now this resolves correctly
    handlePaste,
    openFilePicker,
    handleFileChange,
    removeAttachment,
  };
};
