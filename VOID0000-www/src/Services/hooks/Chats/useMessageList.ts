// src/Services/hooks/Chats/useMessageList.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import { getMessages, getMessageById, deleteMessage, Message } from '../../Chat/chatService';

interface MessageUpdate {
  message_id: string;
  content: string;
  is_edited: boolean;
  edited_at: string;
}

interface MessageDelete {
  message_id: string;
}

export const useMessageList = (
  conversationId: string,
  encryptionKey: CryptoKey | null,
  newMessage?: Message | null,
  messageUpdate?: MessageUpdate | null,
  messageDelete?: MessageDelete | null
) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // Reply cache
  const [replyCache, setReplyCache] = useState<Record<string, Message>>({});
  const fetchingReplies = useRef<Set<string>>(new Set());

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Initial load
  useEffect(() => {
    if (!encryptionKey) return;
    loadMessages();
  }, [conversationId, encryptionKey]);

  // Clear reply cache on conversation change
  useEffect(() => {
    setReplyCache({});
    fetchingReplies.current.clear();
  }, [conversationId]);

  // Handle incoming new messages
  useEffect(() => {
    if (newMessage) {
      setMessages((prev) => [newMessage, ...prev]);
      scrollToBottom();
    }
  }, [newMessage]);

  // Handle message edits (from WebSocket or own edits)
  useEffect(() => {
    if (!messageUpdate) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.message_id === messageUpdate.message_id
          ? {
              ...m,
              content: messageUpdate.content,
              is_edited: messageUpdate.is_edited,
              edited_at: messageUpdate.edited_at,
            }
          : m
      )
    );
  }, [messageUpdate]);

  // Handle message deletions from other users (via WebSocket)
  useEffect(() => {
    if (!messageDelete) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.message_id === messageDelete.message_id
          ? { ...m, is_deleted: true, content: '[deleted]', encrypted_content: null }
          : m
      )
    );
  }, [messageDelete]);

  const loadMessages = async () => {
    if (!encryptionKey) return;
    setLoading(true);
    try {
      const { messages: msgs, has_more } = await getMessages(conversationId, encryptionKey);
      setMessages(msgs);
      setHasMore(has_more);
      scrollToBottom();
    } catch (err) {
      console.error('Failed to load messages:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!encryptionKey || loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = messages[messages.length - 1];
      const { messages: older, has_more } = await getMessages(conversationId, encryptionKey, {
        before: oldest?.message_id,
      });
      setMessages((prev) => [...prev, ...older]);
      setHasMore(has_more);
    } catch (err) {
      console.error('Failed to load more:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  // Reply parent lookup
  const getReplyParent = useCallback(
    (replyToId: string): Message | null => {
      const found = messages.find((m) => m.message_id === replyToId);
      if (found) return found;

      if (replyCache[replyToId]) return replyCache[replyToId];

      if (!fetchingReplies.current.has(replyToId) && encryptionKey) {
        fetchingReplies.current.add(replyToId);
        getMessageById(conversationId, replyToId, encryptionKey).then((msg) => {
          if (msg) {
            setReplyCache((prev) => ({ ...prev, [replyToId]: msg }));
          }
          fetchingReplies.current.delete(replyToId);
        });
      }

      return null;
    },
    [messages, replyCache, conversationId, encryptionKey]
  );

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollTop < 100 && hasMore && !loadingMore) {
      loadMore();
    }
  }, [hasMore, loadingMore]);

  const scrollToBottom = () => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
  };

  const handleDelete = async (messageId: string) => {
    try {
      await deleteMessage(conversationId, messageId);
      setMessages((prev) =>
        prev.map((m) =>
          m.message_id === messageId
            ? { ...m, is_deleted: true, content: '[deleted]', encrypted_content: null }
            : m
        )
      );
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  return {
    messages,
    loading,
    loadingMore,
    hasMore,
    bottomRef,
    containerRef,
    handleScroll,
    handleDelete,
    getReplyParent,
  };
};