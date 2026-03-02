// src/Services/hooks/Chats/useMessageList.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import { getMessages, getMessageById, deleteMessage, Message } from '../../Chat/chatService';

export const useMessageList = (
  conversationId: string,
  encryptionKey: CryptoKey | null,
  newMessage?: Message | null
) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // Reply cache: stores parent messages not in the current message list
  const [replyCache, setReplyCache] = useState<Record<string, Message>>({});
  const fetchingReplies = useRef<Set<string>>(new Set());

  // Refs for scrolling
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Initial load
  useEffect(() => {
    if (!encryptionKey) return;
    loadMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Look up a reply parent: check messages array first, then cache, then fetch
  const getReplyParent = useCallback(
    (replyToId: string): Message | null => {
      // 1. Check loaded messages
      const found = messages.find((m) => m.message_id === replyToId);
      if (found) return found;

      // 2. Check cache
      if (replyCache[replyToId]) return replyCache[replyToId];

      // 3. Fetch if not already fetching
      if (!fetchingReplies.current.has(replyToId) && encryptionKey) {
        fetchingReplies.current.add(replyToId);
        getMessageById(conversationId, replyToId, encryptionKey).then((msg) => {
          if (msg) {
            setReplyCache((prev) => ({ ...prev, [replyToId]: msg }));
          }
          fetchingReplies.current.delete(replyToId);
        });
      }

      return null; // Will re-render when cache updates
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