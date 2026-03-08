// src/Services/hooks/Chats/useMessageList.ts
//
// Discord-style message loading:
//   - Fetch in batches of FETCH_SIZE (50)
//   - Keep at most CACHE_LIMIT (200) messages in memory
//   - Bidirectional scroll: older (up) + newer (down)
//   - Virtual list handles scroll position preservation
//   - Track whether we're "at present" (viewing latest messages)

import { useState, useEffect, useRef, useCallback } from 'react';
import { deleteMessage, getMessageById, getMessages, Message } from '../../Chat/chatService';
import { messageSync } from '../../Chat/chatSync';
import { messageStore, LocalMessage } from '../../Chat/chatStore';

const FETCH_SIZE = 50;
const CACHE_LIMIT = 200;

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
    content: local.content ?? undefined,
    reactions: local.reactions || {},
    attachments: local.attachments,
  };
}

const sortMessages = (msgs: Message[]) =>
  [...msgs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

// Deduplicate + sort + trim to CACHE_LIMIT from a specific end
const trimMessages = (msgs: Message[], trimFrom: 'old' | 'new'): Message[] => {
  const sorted = sortMessages(msgs);
  if (sorted.length <= CACHE_LIMIT) return sorted;
  // trimFrom 'old' = remove oldest (keep newest) — user scrolled down
  // trimFrom 'new' = remove newest (keep oldest) — user scrolled up
  return trimFrom === 'old'
    ? sorted.slice(0, CACHE_LIMIT)
    : sorted.slice(sorted.length - CACHE_LIMIT);
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
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [isAtPresent, setIsAtPresent] = useState(true);

  const [replyCache, setReplyCache] = useState<Record<string, Message>>({});
  const fetchingReplies = useRef<Set<string>>(new Set());

  useEffect(() => {
    setReplyCache({});
    fetchingReplies.current.clear();
  }, [conversationId]);

  // ============== Initial Load ==============
  useEffect(() => {
    if (!encryptionKey) return;
    let ignore = false;

    const load = async () => {
      setMessages([]);
      setHasOlder(false);
      setHasNewer(false);
      setIsAtPresent(true);
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
          setHasOlder(cached.has_more);
          setLoading(false);
          onMessagesLoaded?.(uiMessages);

          setSyncing(true);
          const syncResult = await syncPromise;
          if (ignore) return;
          setSyncing(false);

          if (syncResult.newMessages.length > 0) {
            const fresh = await messageSync.readLocal(conversationId, { limit: FETCH_SIZE });
            if (ignore) return;
            const freshUI = fresh.messages.map(toUIMessage);
            setMessages((prev) => {
              const ids = new Set(freshUI.map((m) => m.message_id));
              const extras = prev.filter((m) => !ids.has(m.message_id));
              return trimMessages([...freshUI, ...extras], 'old');
            });
            setHasOlder(fresh.has_more);
            onMessagesLoaded?.(freshUI);
          }
        } else {
          setSyncing(true);
          const syncResult = await syncPromise;
          if (ignore) return;
          setSyncing(false);

          const fresh = await messageSync.readLocal(conversationId, { limit: FETCH_SIZE });
          if (ignore) return;
          const freshUI = fresh.messages.map(toUIMessage);
          setMessages(freshUI);
          setHasOlder(fresh.has_more || syncResult.hasMore);
          setLoading(false);
          onMessagesLoaded?.(freshUI);
        }
      } catch (err) {
        if (ignore) return;
        console.error('Failed to load messages:', err);
        setLoading(false);
        setSyncing(false);
      }
    };

    load();
    return () => { ignore = true; };
  }, [conversationId, encryptionKey]);

  // ============== Handle Incoming New Messages ==============
  useEffect(() => {
    if (!newMessage) return;
    const localMsg: LocalMessage = {
      conversation_id: newMessage.conversation_id,
      message_id: newMessage.message_id,
      sender_id: newMessage.sender_id,
      content: newMessage.content ?? null,
      message_type: newMessage.message_type,
      reply_to: newMessage.reply_to,
      is_edited: newMessage.is_edited,
      edited_at: newMessage.edited_at,
      is_deleted: newMessage.is_deleted,
      created_at: newMessage.created_at,
      reactions: {},
      attachments: newMessage.attachments,
    };

    messageSync.storeIncomingMessage(localMsg).catch(console.error);

    if (isAtPresent) {
      // We're viewing latest — add message (virtuoso followOutput handles auto-scroll)
      setMessages((prev) => {
        if (prev.some((m) => m.message_id === newMessage.message_id)) return prev;
        return trimMessages([newMessage, ...prev], 'old');
      });
    }
    // If not at present (user scrolled far up), don't inject — they'll see it on jump-to-present
  }, [newMessage, isAtPresent]);

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

  // ============== Load Older (Scroll Up) ==============
  const loadOlder = useCallback(async () => {
    if (!encryptionKey || loadingOlder || !hasOlder || messages.length === 0) return;
    setLoadingOlder(true);

    try {
      const oldest = messages[messages.length - 1];
      if (!oldest) return;

      // Try local first
      let result = await messageSync.readLocal(conversationId, {
        before: oldest.message_id,
        limit: FETCH_SIZE,
      });

      if (result.messages.length === 0) {
        // Fallback to server
        const serverResult = await getMessages(conversationId, encryptionKey, {
          before: oldest.message_id,
          limit: FETCH_SIZE,
        });
        const localMsgs: LocalMessage[] = serverResult.messages.map((msg) => ({
          ...msg,
          content: msg.content ?? null,
          reactions: (msg as any).reactions || {},
        }));
        await messageStore.putMessages(localMsgs);
        result = { messages: localMsgs, has_more: serverResult.has_more };
      }

      const olderUI = result.messages.map(toUIMessage);
      if (olderUI.length > 0) {
        setMessages((prev) => {
          const merged = [...prev, ...olderUI];
          const trimmed = trimMessages(merged, 'new');
          if (trimmed.length < merged.length) {
            setHasNewer(true);
            setIsAtPresent(false);
          }
          return trimmed;
        });
        setHasOlder(result.has_more);
        onMessagesLoaded?.(olderUI);
      }
    } catch (err) {
      console.error('Failed to load older messages:', err);
    } finally {
      setLoadingOlder(false);
    }
  }, [encryptionKey, loadingOlder, hasOlder, messages, conversationId, onMessagesLoaded]);

  // ============== Load Newer (Scroll Down) ==============
  const loadNewer = useCallback(async () => {
    if (!encryptionKey || loadingNewer || !hasNewer || messages.length === 0) return;
    setLoadingNewer(true);

    try {
      const newest = messages[0];
      if (!newest) return;

      // Try local first
      let result = await messageSync.readLocal(conversationId, {
        after: newest.message_id,
        limit: FETCH_SIZE,
      });

      if (result.messages.length === 0) {
        // Fallback to server
        const serverResult = await getMessages(conversationId, encryptionKey, {
          after: newest.message_id,
          limit: FETCH_SIZE,
        });
        const localMsgs: LocalMessage[] = serverResult.messages.map((msg) => ({
          ...msg,
          content: msg.content ?? null,
          reactions: (msg as any).reactions || {},
        }));
        await messageStore.putMessages(localMsgs);
        result = { messages: localMsgs, has_more: serverResult.has_more };
      }

      const newerUI = result.messages.map(toUIMessage);
      if (newerUI.length > 0) {
        setMessages((prev) => {
          const merged = [...newerUI, ...prev];
          return trimMessages(merged, 'old');
        });
        // If we got fewer than FETCH_SIZE, we've reached the present
        if (newerUI.length < FETCH_SIZE) {
          setHasNewer(false);
          setIsAtPresent(true);
        } else {
          setHasNewer(result.has_more);
        }
        onMessagesLoaded?.(newerUI);
      } else {
        setHasNewer(false);
        setIsAtPresent(true);
      }
    } catch (err) {
      console.error('Failed to load newer messages:', err);
    } finally {
      setLoadingNewer(false);
    }
  }, [encryptionKey, loadingNewer, hasNewer, messages, conversationId, onMessagesLoaded]);

  // ============== Jump to Present ==============
  const jumpToPresent = useCallback(async () => {
    if (!encryptionKey) return;
    setLoadingNewer(true);

    try {
      const fresh = await messageSync.readLocal(conversationId, { limit: FETCH_SIZE });
      const freshUI = fresh.messages.map(toUIMessage);

      setMessages(freshUI);
      setHasOlder(fresh.has_more);
      setHasNewer(false);
      setIsAtPresent(true);
      onMessagesLoaded?.(freshUI);
    } catch (err) {
      console.error('Failed to jump to present:', err);
    } finally {
      setLoadingNewer(false);
    }
  }, [encryptionKey, conversationId, onMessagesLoaded]);

  // ============== Reply Parent Lookup ==============
  const getReplyParent = useCallback((replyToId: string): Message | null => {
    const found = messages.find((m) => m.message_id === replyToId);
    if (found) return found;
    if (replyCache[replyToId]) return replyCache[replyToId];
    return null;
  }, [messages, replyCache]);

  // Fetch missing replies
  useEffect(() => {
    if (!encryptionKey) return;
    let ignore = false;

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

    return () => { ignore = true; };
  }, [messages, replyCache, conversationId, encryptionKey]);

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

  return {
    messages,
    loading,
    syncing,
    loadingOlder,
    loadingNewer,
    hasOlder,
    hasNewer,
    isAtPresent,
    handleDelete,
    getReplyParent,
    jumpToPresent,
    loadOlder,
    loadNewer,
  };
};
