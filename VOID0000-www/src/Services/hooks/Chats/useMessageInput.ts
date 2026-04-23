// src/Services/hooks/Chats/useMessageInput.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import type { ConversationSecurityState } from '../../Chat/conversationSecurityState';
import {
  sendMessage,
  sendImageOnlyMessage,
  editMessage,
  uploadEncryptedAttachments,
  sendTypingStart,
  bootstrapDmKey,
  Message,
  Conversation,
  ConversationMember,
  MessageMentionMetadata,
} from '../../Chat/chatService';
import { chatCryptoProtocolService } from '../../Crypto/protocols/chatCryptoProtocolService';
import { queuedSendStore } from '../../Chat/queuedSendStore';
import { resolveMessageMentions } from '../../Chat/messageMentions';

export interface PendingAttachment {
  id: string;
  preview: string;
  url: string | null;
  name: string;
  mime: string;
  size: number;
  blurhash?: string;
  uploading: boolean;
  error?: string;
}

interface UseMessageInputProps {
  currentUserId?: string;
  conversation: Conversation;
  members?: ConversationMember[];
  encryptionKey: CryptoKey | null;
  keyVersion: number;
  conversationSecurityState?: ConversationSecurityState;
  onMessageSent: (message: Message) => void;
  onEncryptionKeyResolved?: (key: CryptoKey, version: number) => void;
  editingMessage?: Message | null;
  onCancelEdit?: () => void;
  replyTo?: Message | null;
  onCancelReply?: () => void;
  onEditComplete?: (
    messageId: string,
    updates: {
      content: string;
      mentions?: MessageMentionMetadata[];
      forwarded?: Message['forwarded'];
      message_type?: string | null;
    },
  ) => void;
}

interface AttachmentAlertState {
  title: string;
  message: string;
}

const MAX_ATTACHMENTS = 5;
const IMAGE_ACCEPT_TYPES = 'image/jpeg,image/png,image/gif,image/webp';
const MAX_ATTACHMENT_FILE_SIZE = 10 * 1024 * 1024;
const MLS_MESSAGE_TYPE = 'mls_application';
const DEFAULT_ATTACHMENT_PERMISSION = 'everyone';

function isDmPeerNotReadyError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : null;
  const message = (
    error instanceof Error
      ? error.message
      : error && typeof error === 'object' && 'message' in error
        ? (error as { message?: unknown }).message
        : error
  );
  const normalizedMessage = String(message || '').toLowerCase();

  return (
    code === 'DM_RECIPIENT_KEYS_MISSING' ||
    code === 'MLS_ADD_KEY_PACKAGE_MISSING' ||
    normalizedMessage.includes('no usable secure device keys') ||
    normalizedMessage.includes('dm peer device is not ready') ||
    normalizedMessage.includes('no published mls key packages') ||
    normalizedMessage.includes('not ready for secure group add yet')
  );
}

const resolveAttachmentAccess = (conversation: Conversation) => {
  if (conversation.type === 'dm') {
    return {
      allowed: true,
      required: DEFAULT_ATTACHMENT_PERMISSION as 'everyone' | 'admins' | 'owner',
    };
  }

  const required = conversation.permissions?.who_can_send_attachments ?? DEFAULT_ATTACHMENT_PERMISSION;
  const role = conversation.role;

  if (role === 'owner') {
    return { allowed: true, required };
  }

  if (required === 'everyone') {
    return { allowed: role !== 'viewer', required };
  }

  if (required === 'admins') {
    return { allowed: role === 'admin', required };
  }

  return { allowed: false, required };
};

export const useMessageInput = ({
  currentUserId,
  conversation,
  members,
  encryptionKey,
  keyVersion,
  conversationSecurityState,
  onMessageSent,
  onEncryptionKeyResolved,
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
  const [attachmentAlert, setAttachmentAlert] = useState<AttachmentAlertState | null>(null);
  const [slowmodeRemaining, setSlowmodeRemaining] = useState(0);
  const lastTypingSentAtRef = useRef(0);
  const attachmentAccess = resolveAttachmentAccess(conversation);
  const attachmentsAllowed = attachmentAccess.allowed;
  const attachmentsRestrictionLabel =
    attachmentAccess.required === 'everyone'
      ? null
      : attachmentAccess.required === 'admins'
        ? 'Admins'
        : 'Owner';

  // Changed to HTMLTextAreaElement
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resolveDraftMentions = useCallback((draftText: string): MessageMentionMetadata[] => {
    if (conversation.type !== 'group') {
      return [];
    }

    return resolveMessageMentions(draftText, members || []);
  }, [conversation.type, members]);

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
    setAttachmentAlert(null);
    setSlowmodeRemaining(0);
    lastTypingSentAtRef.current = 0;
  }, [conversation.id]);

  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  const uploadFile = useCallback(async (file: File, id: string) => {
    if (file.type.startsWith('image/')) {
      const preview = await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve((event.target?.result as string) || null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });

      if (preview) {
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, preview } : a))
        );
      }
    }

    try {
      const [attachment] = await uploadEncryptedAttachments(conversation.id, [file]);
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, url: attachment ?? null, uploading: false } : a))
      );
    } catch {
      setAttachments((prev) =>
        prev.map((a) => (a.id === id ? { ...a, uploading: false, error: 'Upload failed' } : a))
      );
    }
  }, [conversation.id]);

  const addFiles = useCallback((files: FileList | File[]) => {
    if (!attachmentsAllowed) return;

    let oversizedCount = 0;
    const arr = Array.from(files).filter((file) => {
      if (file.size > MAX_ATTACHMENT_FILE_SIZE) {
        oversizedCount += 1;
        return false;
      }

      return true;
    });

    if (oversizedCount > 0) {
      setAttachmentAlert({
        title: 'Attachment Too Large',
        message:
          oversizedCount === 1
            ? 'The maximum upload size is 10MB per attachment. Please choose a smaller file.'
            : `${oversizedCount} attachments were skipped because the maximum upload size is 10MB per attachment.`,
      });
    }

    const slots = MAX_ATTACHMENTS - attachments.length;
    if (slots <= 0) return;
    if (arr.length === 0) return;

    const toAdd = arr.slice(0, slots).map((f) => ({
      id: `${Date.now()}-${Math.random()}`,
      preview: '',
      url: null,
      name: f.name,
      mime: f.type || 'application/octet-stream',
      size: f.size,
      uploading: true,
      file: f,
    }));

    setAttachments((prev) => [...prev, ...toAdd.map(({ file: _f, ...a }) => a)]);
    toAdd.forEach(({ id, file }) => uploadFile(file, id));
  }, [attachments.length, attachmentsAllowed, uploadFile]);

  const dismissAttachmentAlert = useCallback(() => {
    setAttachmentAlert(null);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (!attachmentsAllowed) return;

    const items = Array.from(e.clipboardData.items).filter((item) => item.kind === 'file');
    if (items.length === 0) return;
    e.preventDefault();
    const files = items.map((item) => item.getAsFile()!).filter(Boolean);
    addFiles(files);
  }, [addFiles, attachmentsAllowed]);

  const openMediaPicker = useCallback(() => {
    if (!attachmentsAllowed) return;
    mediaInputRef.current?.click();
  }, [attachmentsAllowed]);

  const openFilePicker = useCallback(() => {
    if (!attachmentsAllowed) return;
    fileInputRef.current?.click();
  }, [attachmentsAllowed]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!attachmentsAllowed) {
      e.target.value = '';
      return;
    }

    if (e.target.files) {
      addFiles(e.target.files);
      e.target.value = '';
    }
  }, [addFiles, attachmentsAllowed]);

  const canBootstrapDmOnSend =
    conversation.type === 'dm' &&
    Boolean(currentUserId) &&
    Boolean(conversation.dm_user_id) &&
    conversationSecurityState?.canSend !== false;

  const resolveSendCrypto = useCallback(async (): Promise<{
    key: CryptoKey;
    version: number;
    bootstrapped: boolean;
  }> => {
    if (conversationSecurityState && !conversationSecurityState.canSend) {
      throw new Error(
        conversationSecurityState.message || 'Secure chat is not ready for this conversation yet.',
      );
    }

    if (conversation.type !== 'dm') {
      if (encryptionKey) {
        return { key: encryptionKey, version: keyVersion, bootstrapped: false };
      }
      throw new Error('Secure chat is still loading for this conversation.');
    }

    if (!currentUserId) {
      throw new Error('You must be signed in to send secure messages.');
    }

    const peerUserId = conversation.dm_user_id;
    if (!peerUserId) {
      throw new Error('This conversation is still loading secure recipient details.');
    }

    if (encryptionKey) {
      const localMembers = await chatCryptoProtocolService.getLocalGroupMemberUserIds(conversation.id);
      const hasValidLocalCoverage =
        localMembers != null &&
        localMembers.includes(currentUserId) &&
        localMembers.includes(peerUserId);

      if (hasValidLocalCoverage) {
        return { key: encryptionKey, version: keyVersion, bootstrapped: false };
      }

      console.warn('[DM_SEND] in-memory DM key missing peer coverage, repairing before send', {
        conversation_id: conversation.id,
        local_members: localMembers,
        expected_peer: peerUserId,
      });
    }

    try {
      const result = await bootstrapDmKey(conversation, currentUserId, peerUserId);
      return { ...result, bootstrapped: true };
    } catch (err) {
      if (isDmPeerNotReadyError(err)) {
        throw new Error('This person has no usable secure device keys on the server yet.');
      }
      throw err;
    }
  }, [conversation, conversationSecurityState, currentUserId, encryptionKey, keyVersion]);

  const getPlaceholder = () => {
    if (conversationSecurityState && !conversationSecurityState.canSend) {
      if (conversationSecurityState.status === 'recovering') {
        return 'Recovering secure conversation state...';
      }
      return 'Secure chat recovery required before sending';
    }

    if (!encryptionKey && !canBootstrapDmOnSend) return 'Setting up encryption...';
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
    !['owner', 'admin'].includes(conversation.role);

  const hasSendCrypto = !!encryptionKey || canBootstrapDmOnSend;

  const canSend =
    !sending &&
    !isSlowmodeBlocked &&
    conversationSecurityState?.canSend !== false &&
    hasSendCrypto &&
    (
    text.trim().length > 0 || attachments.some((a) => a.url)
  ) &&
    !attachments.some((a) => a.uploading);

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

  // Auto-retry queued secure sends when encryptionKey becomes available.
  // Loads from persistent IndexedDB store so queued messages survive
  // conversation switch, refresh, and crash.
  useEffect(() => {
    if (!encryptionKey) return;

    let cancelled = false;

    (async () => {
      let pending;
      try {
        pending = await queuedSendStore.getByConversation(conversation.id);
      } catch {
        return;
      }
      if (cancelled || pending.length === 0) return;

      console.log('[QUEUED_SEND] encryption key available, flushing queued sends', {
        conversation_id: conversation.id,
        count: pending.length,
      });

      for (const queued of pending) {
        if (cancelled) break;
        try {
          const sendCrypto = await resolveSendCrypto();
          if (sendCrypto.bootstrapped) {
            onEncryptionKeyResolved?.(sendCrypto.key, sendCrypto.version);
          }

          let msg: Message;
          if (queued.text) {
            msg = await sendMessage(conversation.id, queued.text, sendCrypto.key, {
              key_version: sendCrypto.version,
              message_type: MLS_MESSAGE_TYPE,
              reply_to: queued.reply_to_id || undefined,
              secure_attachments: queued.uploaded_urls,
              mentions: queued.mentions ?? undefined,
            });
          } else if (queued.uploaded_urls.length > 0) {
            msg = await sendImageOnlyMessage(conversation.id, sendCrypto.key, queued.uploaded_urls, {
              key_version: sendCrypto.version,
              message_type: MLS_MESSAGE_TYPE,
              reply_to: queued.reply_to_id || undefined,
              mentions: queued.mentions ?? undefined,
            });
          } else {
            await queuedSendStore.remove(conversation.id, queued.local_client_id);
            continue;
          }

          console.log('[QUEUED_SEND] queued message sent successfully', {
            local_client_id: queued.local_client_id,
            message_id: msg.message_id,
          });
          await queuedSendStore.remove(conversation.id, queued.local_client_id);
          onMessageSent({
            ...msg,
            local_status: 'sent',
            local_client_id: queued.local_client_id,
          });
        } catch (retryErr) {
          // Leave in store for future retry — don't remove unless permanently failed.
          console.error('[QUEUED_SEND] retry failed, will retry later', {
            local_client_id: queued.local_client_id,
            error: retryErr,
          });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [encryptionKey, conversation.id, onEncryptionKeyResolved, onMessageSent, resolveSendCrypto]);

  useEffect(() => {
    const isTypingEligible =
      conversationSecurityState?.canSend !== false &&
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
  }, [conversation.id, conversationSecurityState, editingMessage, encryptionKey, sending, text]);

  const handleSend = async () => {
    if (!canSend) return;

    const trimmed = text.trim();
    const resolvedMentions = trimmed ? resolveDraftMentions(trimmed) : [];
    const previousText = text;
    const previousAttachments = attachments;
    const uploadedAttachments = attachments
      .filter((a) => a.url)
      .map((a) => a.url!);
    const shouldCreatePendingMessage = !editingMessage && (trimmed.length > 0 || uploadedAttachments.length > 0);
    const localClientId = shouldCreatePendingMessage
      ? `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      : null;
    const optimisticMessage: Message | null = shouldCreatePendingMessage
      ? {
          conversation_id: conversation.id,
          message_id: localClientId as string,
          sender_id: currentUserId || 'local-user',
          encrypted_content: null,
          iv: null,
          key_version: keyVersion,
          message_type: MLS_MESSAGE_TYPE,
          protocol: 'mls',
          protocol_version: 1,
          reply_to: replyTo?.message_id || null,
          attachments: uploadedAttachments,
          is_edited: false,
          edited_at: null,
          is_deleted: false,
          created_at: new Date().toISOString(),
          content: trimmed || undefined,
          reactions: {},
          mentions: resolvedMentions.length > 0 ? resolvedMentions : undefined,
          local_status: 'sending',
          local_client_id: localClientId as string,
        }
      : null;

    setSendError('');
    setText('');
    setAttachments([]);
    setSending(true);
    if (optimisticMessage) {
      onMessageSent(optimisticMessage);
    }

    try {
      const sendCrypto = await resolveSendCrypto();
      if (sendCrypto.bootstrapped) {
        onEncryptionKeyResolved?.(sendCrypto.key, sendCrypto.version);
      }

      if (editingMessage) {
        await editMessage(
          conversation.id,
          editingMessage.message_id,
          trimmed,
          sendCrypto.key,
          sendCrypto.version,
          {
            messageType: editingMessage.message_type || null,
            secureAttachments: editingMessage.attachments,
            forwarded: editingMessage.forwarded,
            mentions: resolvedMentions,
          }
        );
        onEditComplete?.(editingMessage.message_id, {
          content: trimmed,
          mentions: resolvedMentions,
          forwarded: editingMessage.forwarded,
          message_type: editingMessage.message_type || null,
        });
        onCancelEdit?.();
      } else if (trimmed) {
        const msg = await sendMessage(conversation.id, trimmed, sendCrypto.key, {
          key_version: sendCrypto.version,
          message_type: MLS_MESSAGE_TYPE,
          reply_to: replyTo?.message_id || undefined,
          secure_attachments: uploadedAttachments,
          mentions: resolvedMentions,
        });
        onMessageSent(localClientId ? {
          ...msg,
          local_status: 'sent',
          local_client_id: localClientId,
        } : msg);
        onCancelReply?.();
        if (conversation.slowmode_seconds && !['owner', 'admin'].includes(conversation.role)) {
          setSlowmodeRemaining(conversation.slowmode_seconds);
        }
      } else if (uploadedAttachments.length > 0) {
        const msg = await sendImageOnlyMessage(conversation.id, sendCrypto.key, uploadedAttachments, {
          key_version: sendCrypto.version,
          message_type: MLS_MESSAGE_TYPE,
          reply_to: replyTo?.message_id || undefined,
          mentions: resolvedMentions,
        });
        onMessageSent(localClientId ? {
          ...msg,
          local_status: 'sent',
          local_client_id: localClientId,
        } : msg);
        onCancelReply?.();
        if (conversation.slowmode_seconds && !['owner', 'admin'].includes(conversation.role)) {
          setSlowmodeRemaining(conversation.slowmode_seconds);
        }
      }
    } catch (err: any) {
      console.error('Send failed:', err);

      const isPeerNotReady =
        conversation.type === 'dm' &&
        isDmPeerNotReadyError(err);

      if (isPeerNotReady && optimisticMessage && localClientId) {
        // Queue the message locally — don't restore input, don't mark failed.
        // The message stays visible with 'queued' status and will be retried
        // automatically when encryptionKey becomes available (bootstrap succeeds).
        console.log('[QUEUED_SEND] queuing message for deferred secure send', {
          conversation_id: conversation.id,
          local_client_id: localClientId,
        });
        onMessageSent({
          ...optimisticMessage,
          local_status: 'queued',
          local_client_id: localClientId,
        });
        queuedSendStore.put({
          conversation_id: conversation.id,
          local_client_id: localClientId,
          sender_id: currentUserId || 'local-user',
          text: trimmed,
          uploaded_urls: uploadedAttachments,
          reply_to_id: replyTo?.message_id || null,
          mentions: resolvedMentions.length > 0 ? resolvedMentions : undefined,
          created_at: optimisticMessage.created_at,
        }).catch((e) => console.error('[QUEUED_SEND] failed to persist queued send', e));
        setSendError('');
      } else {
        // Normal failure path — restore input and show error.
        setText(previousText);
        setAttachments(previousAttachments);
        if (optimisticMessage && localClientId) {
          onMessageSent({
            ...optimisticMessage,
            local_status: 'failed',
            local_client_id: localClientId,
          });
        }

        if (typeof err?.retry_after_seconds === 'number' && err.retry_after_seconds > 0) {
          setSlowmodeRemaining(err.retry_after_seconds);
          setSendError(err.error || err.message || `Slowmode active. Wait ${err.retry_after_seconds}s.`);
        } else if (err?.code === 'STALE_KEY_VERSION' || err?.message?.includes('key_version') || err?.message?.includes('Not a member')) {
          setSendError('Encryption keys changed. Please close and reopen this conversation, then try again.');
        } else {
          setSendError(err?.message || 'Failed to send message');
        }
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
    attachmentAlert,
    attachmentsAllowed,
    attachmentsRestrictionLabel,
    inputRef,
    mediaInputRef,
    fileInputRef,
    imageAccept: IMAGE_ACCEPT_TYPES,
    getPlaceholder,
    handleSend,
    handleKeyDown,
    handleCancelAction, // Now this resolves correctly
    handlePaste,
    openMediaPicker,
    openFilePicker,
    handleFileChange,
    removeAttachment,
    dismissAttachmentAlert,
  };
};
