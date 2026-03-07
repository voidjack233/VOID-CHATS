// src/Services/hooks/Chats/useMessageList.ts

import { useState, useEffect, useRef, useCallback } from 'react';
import { deleteMessage, getMessageById, Message } from '../../Chat/chatService';
import { messageSync } from '../../Chat/chatSync';
import { messageStore, LocalMessage } from '../../Chat/chatStore';

interface MessageUpdate {
  message_id: string;
  content: string;
  is_edited: boolean;
  edited_at: string;
}

interface MessageDelete {
  message_id: string;
}

function toUIMessage(local: LocalMessage): Message {
  return {
    conversation_id: local.conversation_id,
    message_id: local.message_id,
    sender_id: local.sender_id,
    encrypted_content: null,
    iv: null,
    key_version: 1,
    message_type: local.message_type,
    reply_to: local.reply_to,
    is_edited: local.is_edited,
    edited_at: local.edited_at,
    is_deleted: local.is_deleted,
    created_at: local.created_at,
    content: local.content,
    reactions: local.reactions || {},
    attachments: local.attachments,
  };
}

const sortMessages = (msgs: Message[]) => {
  return [...msgs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
};

export const useMessageList = (
  conversationId: string,
  encryptionKey: CryptoKey | null,
  newMessage?: Message | null,
  messageUpdate?: MessageUpdate | null,
  messageDelete?: MessageDelete | null,
  onMessagesLoaded?: (messages: Message[]) => void
) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const [replyCache, setReplyCache] = useState<Record<string, Message>>({});
  const fetchingReplies = useRef<Set<string>>(new Set());

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setReplyCache({});
    fetchingReplies.current.clear();
  }, [conversationId]);

  const mergeMessages = (freshUI: Message[]) => {
    setMessages((prev) => {
      const freshIds = new Set(freshUI.map((m) => m.message_id));
      const extras = prev.filter((m) => !freshIds.has(m.message_id));
      const merged = [...freshUI, ...extras];
      return sortMessages(merged);
    });
  };

  // ============== Initial Load with Race Protection ==============
  useEffect(() => {
    if (!encryptionKey) return;
    let ignore = false; // <-- The Magic Flag

    const loadFromLocal = async () => {
      setMessages([]);
      setHasMore(false);
      setLoading(true);

      try {
        const { cached, syncPromise } = await messageSync.loadConversation(
          conversationId,
          encryptionKey
        );

        if (ignore) return;

        if (cached.messages.length > 0) {
          const uiMessages = sortMessages(cached.messages.map(toUIMessage));
          setMessages(uiMessages);
          setHasMore(cached.has_more);
          setLoading(false);
          scrollToBottom();
          onMessagesLoaded?.(uiMessages);

          setSyncing(true);
          const syncResult = await syncPromise;
          if (ignore) return;
          setSyncing(false);

          if (syncResult.newMessages.length > 0) {
            const fresh = await messageSync.readLocal(conversationId);
            if (ignore) return;
            const freshUI = fresh.messages.map(toUIMessage);
            mergeMessages(freshUI);
            setHasMore(fresh.has_more);
            onMessagesLoaded?.(freshUI);
            scrollToBottom();
          }
        } else {
          setSyncing(true);
          const syncResult = await syncPromise;
          if (ignore) return;
          setSyncing(false);

          const fresh = await messageSync.readLocal(conversationId);
          if (ignore) return;
          const freshUI = fresh.messages.map(toUIMessage);
          mergeMessages(freshUI);
          setHasMore(fresh.has_more || syncResult.hasMore);
          setLoading(false);
          scrollToBottom();
          onMessagesLoaded?.(freshUI);
        }
      } catch (err) {
        if (ignore) return;
        console.error('Failed to load messages:', err);
        setLoading(false);
        setSyncing(false);
      }
    };

    loadFromLocal();

    return () => {
      ignore = true; // Cleanup on unmount or chat switch
    };
  }, [conversationId, encryptionKey]);

  // ============== Handle Incoming New Messages ==============
  useEffect(() => {
    if (!newMessage) return;
    const localMsg: LocalMessage = {
      conversation_id: newMessage.conversation_id,
      message_id: newMessage.message_id,
      sender_id: newMessage.sender_id,
      content: newMessage.content || '[encrypted]',
      message_type: newMessage.message_type,
      reply_to: newMessage.reply_to,
      is_edited: newMessage.is_edited,
      edited_at: newMessage.edited_at,
      is_deleted: newMessage.is_deleted,
      created_at: newMessage.created_at,
      reactions: {},
      attachments: newMessage.attachments,
    };

    messageSync.storeIncomingMessage(localMsg).then(() => {
      setMessages((prev) => {
        if (prev.some((m) => m.message_id === newMessage.message_id)) return prev;
        return sortMessages([newMessage, ...prev]);
      });
      scrollToBottom();
    }).catch(() => {
      setMessages((prev) => {
        if (prev.some((m) => m.message_id === newMessage.message_id)) return prev;
        return sortMessages([newMessage, ...prev]);
      });
      scrollToBottom();
    });
  }, [newMessage]);

  // ============== Handle Edits ==============
  useEffect(() => {
    if (!messageUpdate) return;
    messageSync.handleEdit(conversationId, messageUpdate.message_id, messageUpdate.content, messageUpdate.edited_at).catch(console.error);
    setMessages((prev) =>
      prev.map((m) => m.message_id === messageUpdate.message_id
          ? { ...m, content: messageUpdate.content, is_edited: messageUpdate.is_edited, edited_at: messageUpdate.edited_at }
          : m
      )
    );
  }, [messageUpdate]);

  // ============== Handle Deletions ==============
  useEffect(() => {
    if (!messageDelete) return;
    messageSync.handleDelete(conversationId, messageDelete.message_id).catch(console.error);
    setMessages((prev) =>
      prev.map((m) => m.message_id === messageDelete.message_id
          ? { ...m, is_deleted: true, content: '[deleted]', encrypted_content: null }
          : m
      )
    );
  }, [messageDelete]);

  // ============== Load More (Scroll Up) ==============
  const loadMore = async () => {
    if (!encryptionKey || loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);

    try {
      const oldest = messages[messages.length - 1];
      if (!oldest) return;

      const local = await messageSync.readLocal(conversationId, { before: oldest.message_id });

      if (local.messages.length > 0) {
        const olderUI = local.messages.map(toUIMessage);
        setMessages((prev) => sortMessages([...prev, ...olderUI]));
        setHasMore(local.has_more);
        onMessagesLoaded?.(olderUI);
      } else {
        const { getMessages } = await import('../../Chat/chatService');
        const { messages: serverMsgs, has_more } = await getMessages(conversationId, encryptionKey, { before: oldest.message_id });

        const localMsgs: LocalMessage[] = serverMsgs.map((msg) => ({
          ...msg,
          content: msg.content || '[encrypted]',
          reactions: (msg as any).reactions || {},
        }));

        await messageStore.putMessages(localMsgs);
        setMessages((prev) => sortMessages([...prev, ...serverMsgs]));
        setHasMore(has_more);
        onMessagesLoaded?.(serverMsgs);
      }
    } catch (err) {
      console.error('Failed to load more:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  // ============== Reply Parent Lookup ==============
  const getReplyParent = useCallback((replyToId: string): Message | null => {
      const found = messages.find((m) => m.message_id === replyToId);
      if (found) return found;
      if (replyCache[replyToId]) return replyCache[replyToId];
      return null;
    }, [messages, replyCache]);

  // Fetch missing replies with Ignore Flag and Dummy Object
  useEffect(() => {
    if (!encryptionKey) return;
    let ignore = false; // <-- Protection flag here too

    const missingReplies = messages
      .map((m) => m.reply_to)
      .filter((id): id is string => 
        !!id && 
        !messages.find((m) => m.message_id === id) && 
        !replyCache[id] && 
        !fetchingReplies.current.has(id)
      );

    if (missingReplies.length === 0) return;

    missingReplies.forEach((replyToId) => {
      fetchingReplies.current.add(replyToId);

      messageStore.getMessage(conversationId, replyToId)
        .then((local) => {
          if (ignore) return;
          if (local) {
            setReplyCache((prev) => ({ ...prev, [replyToId]: toUIMessage(local) }));
          } else {
            getMessageById(conversationId, replyToId, encryptionKey)
              .then((msg: any) => {
                if (ignore) return;
                const actualMsg = msg?.message || msg; 
                // FIX: If server returns null, store a dummy object to stop the infinite fetch loop!
                setReplyCache((prev) => ({ 
                  ...prev, 
                  [replyToId]: actualMsg || { message_id: replyToId, content: '[deleted or unavailable]', is_deleted: true } as any 
                }));
              })
              .catch(() => {
                if (ignore) return;
                fetchingReplies.current.delete(replyToId);
              });
          }
        })
        .catch(() => {
          if (ignore) return;
          fetchingReplies.current.delete(replyToId);
        });
    });

    return () => {
      ignore = true;
    };
  }, [messages, replyCache, conversationId, encryptionKey]);

  // ============== Scroll Handling ==============
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollTop < 100 && hasMore && !loadingMore) loadMore();
  }, [hasMore, loadingMore]);

  const scrollToBottom = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);

  // ============== Delete (API + Local) ==============
  const handleDelete = async (messageId: string) => {
    try {
      await deleteMessage(conversationId, messageId);
      await messageSync.handleDelete(conversationId, messageId);
      setMessages((prev) => prev.map((m) => m.message_id === messageId ? { ...m, is_deleted: true, content: '[deleted]', encrypted_content: null } : m));
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  return { messages, loading, syncing, loadingMore, hasMore, bottomRef, containerRef, handleScroll, handleDelete, getReplyParent };
};