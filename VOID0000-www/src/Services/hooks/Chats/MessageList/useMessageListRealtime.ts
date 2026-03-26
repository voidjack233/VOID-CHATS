import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react';
import {
  deleteMessage,
  resolveMessageCryptoMetadata,
  type Message,
} from '../../../Chat/chatService';
import { messageSync } from '../../../Chat/chatSync';
import { type LocalMessage } from '../../../Chat/chatStore';
import { queuedSendStore } from '../../../Chat/queuedSendStore';
import { type HistoryAccessFence, isMessageVisibleForHistoryFence } from './messageListHistory';
import { getLocalClientId, mergeMessagesWithReconciliation } from './messageListReconciliation';
import type { MessageDelete, MessageUpdate } from './messageListTypes';

interface UseMessageListRealtimeParams {
  conversationId: string;
  userId?: string;
  historyAccessFence: HistoryAccessFence | null;
  newMessage?: Message | null;
  messageUpdate?: MessageUpdate | null;
  messageDelete?: MessageDelete | null;
  setMessages: Dispatch<SetStateAction<Message[]>>;
}

const useMessageListRealtime = ({
  conversationId,
  userId,
  historyAccessFence,
  newMessage,
  messageUpdate,
  messageDelete,
  setMessages,
}: UseMessageListRealtimeParams) => {
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
          local_status: 'queued' as const,
          local_client_id: record.local_client_id,
        }));

        setMessages((previous) =>
          mergeMessagesWithReconciliation({
            existing: previous,
            incoming: queuedMessages,
            currentUserId: userId,
            trimFrom: 'old',
            allowOptimisticFallback: false,
          })
        );
      } catch (error) {
        console.error('[QUEUED_SEND] failed to load persisted queued sends', error);
      }
    })();

    return () => { ignore = true; };
  }, [conversationId, setMessages, userId]);

  useEffect(() => {
    if (!newMessage) return;

    const normalizedConversationId = newMessage.conversation_id || conversationId;
    if (String(normalizedConversationId) !== String(conversationId)) {
      return;
    }

    const localStatus = newMessage.local_status;
    const localClientId = getLocalClientId(newMessage);

    if (localStatus === 'failed' && localClientId) {
      setMessages((previous) => previous.filter((message) =>
        message.message_id !== localClientId && message.local_client_id !== localClientId
      ));
      return;
    }

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

    const isLocalPendingOnly = (
      normalizedMessage.local_status === 'sending' ||
      normalizedMessage.local_status === 'queued'
    ) && Boolean(localClientId);

    if (!isLocalPendingOnly) {
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
        protocol: normalizedMessage.protocol ?? null,
        protocol_version: normalizedMessage.protocol_version ?? null,
      };

      messageSync.storeIncomingMessage(localMessage).catch(console.error);
    }

    setMessages((previous) =>
      mergeMessagesWithReconciliation({
        existing: previous,
        incoming: [normalizedMessage],
        currentUserId: userId,
        trimFrom: 'old',
        allowOptimisticFallback: true,
      })
    );
  }, [conversationId, historyAccessFence, newMessage, setMessages, userId]);

  useEffect(() => {
    if (!messageUpdate) return;

    messageSync
      .handleEdit(conversationId, messageUpdate.message_id, messageUpdate.content, messageUpdate.edited_at)
      .catch(console.error);

    setMessages((previous) =>
      previous.map((message) => (
        message.message_id === messageUpdate.message_id
          ? {
              ...message,
              content: messageUpdate.content,
              is_edited: messageUpdate.is_edited,
              edited_at: messageUpdate.edited_at,
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
