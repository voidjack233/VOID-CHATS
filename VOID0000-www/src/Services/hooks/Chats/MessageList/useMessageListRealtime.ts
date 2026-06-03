import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import {
  deleteMessage,
  resolveMessageCryptoMetadata,
  type Message,
} from '../../../Chat/chatService';
import { messageSync } from '../../../Chat/chatSync';
import { type LocalMessage } from '../../../Chat/chatStore';
import { queuedSendStore } from '../../../Chat/queuedSendStore';
import { type HistoryAccessFence, isMessageVisibleForHistoryFence } from './messageListHistory';
import { getLocalClientId } from './messageListReconciliation';
import type { MessageDelete, MessageStreamEvent, MessageUpdate } from './messageListTypes';

interface UseMessageListRealtimeParams {
  conversationId: string;
  userId?: string;
  historyAccessFence: HistoryAccessFence | null;
  messageEvents?: MessageStreamEvent[];
  messageUpdate?: MessageUpdate | null;
  messageDelete?: MessageDelete | null;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  mergeVisibleMessages: (params: {
    incoming: Message[];
    currentUserId?: string;
    trimFrom?: 'old' | 'new';
    hasOlder?: boolean;
    hasNewer?: boolean;
    isAtPresent?: boolean;
  }) => void;
  queueNewerMessages: (params: {
    incoming: Message[];
    hasNewerAfterFlush: boolean;
    isAtPresentAfterFlush: boolean;
  }) => void;
  isAtPresent: boolean;
  initialHydrationSettled: boolean;
}

const useMessageListRealtime = ({
  conversationId,
  userId,
  historyAccessFence,
  messageEvents = [],
  messageUpdate,
  messageDelete,
  setMessages,
  mergeVisibleMessages,
  queueNewerMessages,
  isAtPresent,
  initialHydrationSettled,
}: UseMessageListRealtimeParams) => {
  const lastProcessedMessageEventSequenceRef = useRef(0);

  useEffect(() => {
    lastProcessedMessageEventSequenceRef.current = 0;
  }, [conversationId]);

  useEffect(() => {
    let ignore = false;

    (async () => {
      try {
        const queued = await queuedSendStore.getByConversation(conversationId);
        if (ignore || queued.length === 0) return;

        const queuedMessages: Message[] = queued.map((record) => ({
          conversation_id: record.conversation_id,
          message_id: record.local_client_id,
          sender_id: record.sender_id,
          encrypted_content: null,
          iv: null,
          key_version: 1,
          message_type: 'mls_application',
          protocol: 'mls' as const,
          protocol_version: 1,
          reply_to: record.reply_to_id,
          attachments: record.uploaded_urls,
          is_edited: false,
          edited_at: null,
          is_deleted: false,
          created_at: record.created_at,
          content: record.text || undefined,
          reactions: {},
          link_preview: record.link_preview ?? undefined,
          mentions: record.mentions ?? undefined,
          local_status: 'queued' as const,
          local_client_id: record.local_client_id,
        }));

        mergeVisibleMessages({
          incoming: queuedMessages,
          currentUserId: userId,
          trimFrom: 'old',
        });
      } catch (error) {
        console.error('[QUEUED_SEND] failed to load persisted queued sends', error);
      }
    })();

    return () => { ignore = true; };
  }, [conversationId, mergeVisibleMessages, userId]);

  useEffect(() => {
    const pendingEvents = messageEvents.filter(
      (event) => event.sequence > lastProcessedMessageEventSequenceRef.current
    );
    if (pendingEvents.length === 0) {
      return;
    }

    lastProcessedMessageEventSequenceRef.current = Math.max(
      ...pendingEvents.map((event) => event.sequence),
      lastProcessedMessageEventSequenceRef.current,
    );

    pendingEvents.forEach(({ message: newMessage }) => {
      const normalizedConversationId = newMessage.conversation_id || conversationId;
      if (String(normalizedConversationId) !== String(conversationId)) {
        return;
      }

      const localStatus = newMessage.local_status;
      const localClientId = getLocalClientId(newMessage);

      const cryptoMetadata = resolveMessageCryptoMetadata(newMessage);
      const normalizedMessage: Message = {
        ...newMessage,
        conversation_id: normalizedConversationId,
        message_type: newMessage.message_type || 'mls_application',
        reply_to: newMessage.reply_to ?? null,
        is_edited: Boolean(newMessage.is_edited),
        edited_at: newMessage.edited_at ?? null,
        is_deleted: Boolean(newMessage.is_deleted),
        created_at: newMessage.created_at || new Date().toISOString(),
        reactions: newMessage.reactions || {},
        protocol: cryptoMetadata.protocol,
        protocol_version: cryptoMetadata.protocol_version,
        local_status: localStatus,
        local_client_id: localClientId,
      };

      if (!isMessageVisibleForHistoryFence(normalizedMessage, historyAccessFence)) {
        return;
      }

      const isLocalOnlyStatus = (
        normalizedMessage.local_status === 'sending' ||
        normalizedMessage.local_status === 'queued' ||
        normalizedMessage.local_status === 'failed'
      ) && Boolean(localClientId);

      if (!isLocalOnlyStatus) {
        const localMessage: LocalMessage = {
          conversation_id: normalizedMessage.conversation_id,
          message_id: normalizedMessage.message_id,
          sender_id: normalizedMessage.sender_id,
          content: normalizedMessage.content ?? null,
          key_version: normalizedMessage.key_version ?? null,
          message_type: normalizedMessage.message_type,
          reply_to: normalizedMessage.reply_to,
          is_edited: normalizedMessage.is_edited,
          edited_at: normalizedMessage.edited_at,
          is_deleted: normalizedMessage.is_deleted,
          created_at: normalizedMessage.created_at,
          reactions: {},
          attachments: normalizedMessage.attachments,
          forwarded: normalizedMessage.forwarded ?? undefined,
          mentions: normalizedMessage.mentions ?? undefined,
          link_preview: normalizedMessage.link_preview ?? undefined,
          protocol: normalizedMessage.protocol ?? null,
          protocol_version: normalizedMessage.protocol_version ?? null,
        };

        messageSync.storeIncomingMessage(localMessage).catch(console.error);
      }

      const shouldApplyImmediately = (
        !initialHydrationSettled ||
        isAtPresent ||
        normalizedMessage.local_status === 'sending' ||
        normalizedMessage.local_status === 'queued' ||
        normalizedMessage.local_status === 'failed'
      );

      if (shouldApplyImmediately) {
        mergeVisibleMessages({
          incoming: [normalizedMessage],
          currentUserId: userId,
          trimFrom: 'old',
        });
        return;
      }

      // The live message may be far ahead of the current window. Do not append
      // it directly below old history, or the UI can create a false contiguous
      // list like "Thursday -> Today" while "Yesterday" is still unloaded.
      queueNewerMessages({
        incoming: [],
        hasNewerAfterFlush: true,
        isAtPresentAfterFlush: false,
      });
    });
  }, [
    conversationId,
    historyAccessFence,
    initialHydrationSettled,
    isAtPresent,
    mergeVisibleMessages,
    messageEvents,
    queueNewerMessages,
    setMessages,
    userId,
  ]);

  useEffect(() => {
    if (!messageUpdate) return;

    const hasLinkPreviewUpdate = Object.prototype.hasOwnProperty.call(messageUpdate, 'link_preview');
    const hasContentUpdate = typeof messageUpdate.content === 'string';

    if (hasContentUpdate) {
      messageSync
        .handleEdit(conversationId, messageUpdate.message_id, {
          content: messageUpdate.content || '',
          edited_at: messageUpdate.edited_at || new Date().toISOString(),
          forwarded: messageUpdate.forwarded ?? undefined,
          mentions: messageUpdate.mentions ?? undefined,
          link_preview: messageUpdate.link_preview ?? undefined,
          message_type: messageUpdate.message_type ?? undefined,
        })
        .catch(console.error);
    } else if (hasLinkPreviewUpdate) {
      messageSync
        .handlePreviewUpdate(conversationId, messageUpdate.message_id, messageUpdate.link_preview ?? null)
        .catch(console.error);
    }

    setMessages((previous) =>
      previous.map((message) => (
        message.message_id === messageUpdate.message_id
          ? {
              ...message,
              content: hasContentUpdate ? messageUpdate.content : message.content,
              is_edited: messageUpdate.is_edited ?? message.is_edited,
              edited_at: messageUpdate.edited_at ?? message.edited_at,
              forwarded: messageUpdate.forwarded ?? message.forwarded,
              mentions: messageUpdate.mentions ?? message.mentions,
              link_preview: hasLinkPreviewUpdate ? messageUpdate.link_preview : message.link_preview,
              message_type: messageUpdate.message_type ?? message.message_type,
              encrypted_link_preview: messageUpdate.encrypted_link_preview ?? message.encrypted_link_preview,
              link_preview_iv: messageUpdate.link_preview_iv ?? message.link_preview_iv,
              link_preview_key_version: messageUpdate.link_preview_key_version ?? message.link_preview_key_version,
            }
          : message
      ))
    );
  }, [conversationId, messageUpdate, setMessages]);

  useEffect(() => {
    if (!messageDelete) return;

    messageSync.handleDelete(conversationId, messageDelete.message_id).catch(console.error);
    setMessages((previous) =>
      previous.map((message) => (
        message.message_id === messageDelete.message_id
          ? { ...message, is_deleted: true, content: '[deleted]', encrypted_content: null }
          : message
      ))
    );
  }, [conversationId, messageDelete, setMessages]);

  const handleDelete = useCallback(async (messageId: string) => {
    try {
      await deleteMessage(conversationId, messageId);
      await messageSync.handleDelete(conversationId, messageId);
      setMessages((previous) =>
        previous.map((message) => (
          message.message_id === messageId
            ? { ...message, is_deleted: true, content: '[deleted]', encrypted_content: null }
            : message
        ))
      );
    } catch (error) {
      console.error('Delete failed:', error);
    }
  }, [conversationId, setMessages]);

  return {
    handleDelete,
  };
};

export { useMessageListRealtime };
