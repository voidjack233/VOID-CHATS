// src/Services/hooks/Chats/useMessageList.ts

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { deleteMessage, getMessageById, getMessages, Message, type Conversation } from '../../Chat/chatService';
import { messageSync } from '../../Chat/chatSync';
import { messageStore, LocalMessage } from '../../Chat/chatStore';
import {
  MESSAGE_CACHE_LIMIT,
  MESSAGE_INITIAL_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
} from '../../Chat/chatConstants';

const INITIAL_FETCH_SIZE = MESSAGE_INITIAL_PAGE_SIZE;
const FETCH_SIZE = MESSAGE_PAGE_SIZE;
const CACHE_LIMIT = MESSAGE_CACHE_LIMIT;
const MESSAGE_LIST_BASE_INDEX = 100000;

interface ConversationWindowSnapshot {
  loadedCount: number;
  hasOlder: boolean;
}

const conversationWindowCache = new Map<string, ConversationWindowSnapshot>();

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

const compareByCreatedAtAsc = (
  a: { created_at: string; message_id: string },
  b: { created_at: string; message_id: string }
) => {
  const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  if (timeDiff !== 0) return timeDiff;
  return a.message_id.localeCompare(b.message_id);
};

const sortMessages = (msgs: Message[]) =>
  [...msgs].sort(compareByCreatedAtAsc);

const sortLocalMessages = (msgs: LocalMessage[]) =>
  [...msgs].sort(compareByCreatedAtAsc);

const isUndecryptableContent = (content: string | null | undefined) =>
  content === '[unable to decrypt]';

const hasUndecryptableMessage = (messages: Array<{ content?: string | null }>) =>
  messages.some((message) => isUndecryptableContent(message.content));

const toLocalMessages = (msgs: Message[]): LocalMessage[] =>
  msgs.map((msg) => ({
    conversation_id: msg.conversation_id,
    message_id: msg.message_id,
    sender_id: msg.sender_id,
    content: msg.content ?? null,
    message_type: msg.message_type,
    reply_to: msg.reply_to,
    is_edited: msg.is_edited,
    edited_at: msg.edited_at,
    is_deleted: msg.is_deleted,
    created_at: msg.created_at,
    reactions: (msg as any).reactions || {},
    attachments: msg.attachments,
  }));

const mergeLocalMessages = (...pages: LocalMessage[][]): LocalMessage[] =>
  sortLocalMessages(
    Array.from(
      new Map(
        pages.flat().map((msg) => [msg.message_id, msg])
      ).values()
    )
  );

// Deduplicate + keep messages oldest-first before trimming
const trimMessages = (msgs: Message[], trimFrom: 'old' | 'new'): Message[] => {
  const sorted = sortMessages(msgs);
  if (sorted.length <= CACHE_LIMIT) return sorted;

  // trimFrom 'old' = remove oldest (keep newest) — user scrolled down
  // trimFrom 'new' = remove newest (keep oldest) — user scrolled up
  return trimFrom === 'old'
    ? sorted.slice(sorted.length - CACHE_LIMIT)
    : sorted.slice(0, CACHE_LIMIT);
};

const resolveInitialHasOlder = ({
  localHasMore,
  localCount,
  requestedLimit,
  sessionSnapshot,
  syncHasMore = false,
}: {
  localHasMore: boolean;
  localCount: number;
  requestedLimit: number;
  sessionSnapshot?: ConversationWindowSnapshot;
  syncHasMore?: boolean;
}) => {
  if (sessionSnapshot) {
    return localHasMore || syncHasMore || sessionSnapshot.hasOlder;
  }

  return localHasMore || syncHasMore || localCount >= requestedLimit;
};

export const useMessageList = (
  conversation: Conversation,
  userId: string | undefined,
  encryptionKey: CryptoKey | null,
  currentKeyVersion = 1,
  newMessage?: Message | null,
  messageUpdate?: MessageUpdate | null,
  messageDelete?: MessageDelete | null,
  onMessagesLoaded?: (messages: Message[]) => void
) => {
  const conversationId = conversation.id;
  // Keep decryption context stable across non-key metadata updates
  // (e.g. member_count / updated_at) to avoid unnecessary reload loops.
  const decryptionConversation = useMemo(
    () => conversation,
    [
      conversation.id,
      conversation.public_id,
      conversation.type,
      conversation.parent_conversation_id,
      conversation.parent_public_id,
      conversation.owner_id,
      conversation.dm_user_id,
    ]
  );
  const peerUserId = decryptionConversation.type === 'dm' ? decryptionConversation.dm_user_id : undefined;
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [prefetchingOlder, setPrefetchingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [isAtPresent, setIsAtPresent] = useState(true);
  const [firstItemIndex, setFirstItemIndex] = useState(MESSAGE_LIST_BASE_INDEX);
  const [groupBreakBeforeIds, setGroupBreakBeforeIds] = useState<Set<string>>(new Set());

  const [replyCache, setReplyCache] = useState<Record<string, Message>>({});
  const fetchingReplies = useRef<Set<string>>(new Set());
  const messagesRef = useRef<Message[]>([]);
  const prefetchingOlderRef = useRef(false);

  // Track which conversation we last loaded so we can distinguish between
  // a genuine conversation switch (needs full reset) and a key rotation
  // within the same conversation (should preserve visible messages).
  const lastLoadedConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    setReplyCache({});
    fetchingReplies.current.clear();
    prefetchingOlderRef.current = false;
  }, [conversationId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (
      messages.length === 0 ||
      messages.some((message) => String(message.conversation_id) !== String(conversationId))
    ) {
      return;
    }

    const existing = conversationWindowCache.get(conversationId);
    conversationWindowCache.set(conversationId, {
      loadedCount: Math.min(
        CACHE_LIMIT,
        Math.max(existing?.loadedCount ?? INITIAL_FETCH_SIZE, messages.length)
      ),
      hasOlder,
    });
  }, [conversationId, hasOlder, messages.length]);

  // ============== Initial Load ==============
  useEffect(() => {
    if (!encryptionKey) return;
    let ignore = false;
    const sessionSnapshot = conversationWindowCache.get(conversationId);
    const initialLimit = Math.max(INITIAL_FETCH_SIZE, sessionSnapshot?.loadedCount ?? 0);

    const load = async () => {
      // If the conversation hasn't changed, this is a key rotation —
      // keep existing messages visible while we re-sync from the server.
      const isKeyRotation = lastLoadedConversationIdRef.current === conversationId;
      lastLoadedConversationIdRef.current = conversationId;

      if (!isKeyRotation) {
        setMessages([]);
        setHasOlder(false);
        setHasNewer(false);
        setIsAtPresent(true);
        setFirstItemIndex(MESSAGE_LIST_BASE_INDEX);
        setGroupBreakBeforeIds(new Set());
        setPrefetchingOlder(false);
        setLoading(true);
      }

      try {
        const { cached, syncPromise } = await messageSync.loadConversation(
          conversationId,
          encryptionKey,
          {
            preferSessionCache: true,
            initialLimit,
            syncLimit: INITIAL_FETCH_SIZE,
            conversation: decryptionConversation,
            userId,
            peerUserId,
            currentKeyVersion,
          }
        );

        if (ignore) return;

        if (cached.messages.length > 0) {
          const uiMessages = sortMessages(cached.messages.map(toUIMessage));
          if (isKeyRotation) {
            setMessages((prev) => {
              if (prev.length === 0) return uiMessages;
              const unique = Array.from(
                new Map([...prev, ...uiMessages].map((m) => [m.message_id, m])).values()
              );
              return trimMessages(unique, 'old');
            });
          } else {
            setMessages(uiMessages);
          }
          setHasOlder(resolveInitialHasOlder({
            localHasMore: cached.has_more,
            localCount: uiMessages.length,
            requestedLimit: initialLimit,
            sessionSnapshot,
          }));
          setLoading(false);
          onMessagesLoaded?.(uiMessages);

          setSyncing(true);
          const syncResult = await syncPromise;
          if (ignore) return;
          setSyncing(false);
          setHasOlder((prev) => prev || syncResult.hasMore);

          if (syncResult.newMessages.length > 0) {
            const fresh = await messageSync.readLocal(conversationId, { limit: initialLimit });
            if (ignore) return;
            const freshUI = sortMessages(fresh.messages.map(toUIMessage));
            setMessages((prev) => {
              const unique = Array.from(
                new Map([...prev, ...freshUI].map((m) => [m.message_id, m])).values()
              );
              return trimMessages(unique, 'old');
            });
            setHasOlder(resolveInitialHasOlder({
              localHasMore: fresh.has_more,
              localCount: freshUI.length,
              requestedLimit: initialLimit,
              sessionSnapshot,
              syncHasMore: syncResult.hasMore,
            }));
            onMessagesLoaded?.(freshUI);
          }
        } else {
          setSyncing(true);
          const syncResult = await syncPromise;
          if (ignore) return;
          setSyncing(false);

          const fresh = await messageSync.readLocal(conversationId, { limit: initialLimit });
          if (ignore) return;
          const freshUI = sortMessages(fresh.messages.map(toUIMessage));
          if (isKeyRotation) {
            setMessages((prev) => {
              if (freshUI.length === 0) return prev;
              const unique = Array.from(
                new Map([...prev, ...freshUI].map((m) => [m.message_id, m])).values()
              );
              return trimMessages(unique, 'old');
            });
          } else {
            setMessages(freshUI);
          }
          setHasOlder(resolveInitialHasOlder({
            localHasMore: fresh.has_more,
            localCount: freshUI.length,
            requestedLimit: initialLimit,
            sessionSnapshot,
            syncHasMore: syncResult.hasMore,
          }));
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
  }, [conversationId, currentKeyVersion, decryptionConversation, encryptionKey, peerUserId, userId]);

  // ============== Handle Incoming New Messages ==============
  useEffect(() => {
    if (!newMessage) return;
    const normalizedConversationId = newMessage.conversation_id || conversationId;
    if (String(normalizedConversationId) !== String(conversationId)) {
      return;
    }
    const localStatus = newMessage.local_status;
    const localClientId = newMessage.local_client_id || (
      typeof newMessage.message_id === 'string' && newMessage.message_id.startsWith('local-')
        ? newMessage.message_id
        : undefined
    );

    if (localStatus === 'failed' && localClientId) {
      setMessages((prev) => prev.filter((message) =>
        message.message_id !== localClientId && message.local_client_id !== localClientId
      ));
      return;
    }

    const normalizedMessage: Message = {
      ...newMessage,
      conversation_id: normalizedConversationId,
      message_type: newMessage.message_type || 'text',
      reply_to: newMessage.reply_to ?? null,
      is_edited: Boolean(newMessage.is_edited),
      edited_at: newMessage.edited_at ?? null,
      is_deleted: Boolean(newMessage.is_deleted),
      created_at: newMessage.created_at || new Date().toISOString(),
      reactions: newMessage.reactions || {},
      local_status: localStatus,
      local_client_id: localClientId,
    };

    const isLocalPendingOnly = normalizedMessage.local_status === 'sending' && Boolean(localClientId);
    if (!isLocalPendingOnly) {
      const localMsg: LocalMessage = {
        conversation_id: normalizedMessage.conversation_id,
        message_id: normalizedMessage.message_id,
        sender_id: normalizedMessage.sender_id,
        content: normalizedMessage.content ?? null,
        message_type: normalizedMessage.message_type,
        reply_to: normalizedMessage.reply_to,
        is_edited: normalizedMessage.is_edited,
        edited_at: normalizedMessage.edited_at,
        is_deleted: normalizedMessage.is_deleted,
        created_at: normalizedMessage.created_at,
        reactions: {},
        attachments: normalizedMessage.attachments,
      };

      messageSync.storeIncomingMessage(localMsg).catch(console.error);
    }

    // Always inject incoming messages so realtime updates are visible without refresh.
    setMessages((prev) => {
      const base = localClientId
        ? prev.filter((message) => message.message_id !== localClientId && message.local_client_id !== localClientId)
        : prev;
      const merged = [...base, normalizedMessage];
      const unique = Array.from(
        new Map(merged.map(m => [m.message_id, m])).values()
      );
      return trimMessages(unique, 'old');
    });
  }, [newMessage, conversationId]);

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
  const applyOlderMessages = useCallback((olderUI: Message[], seamBreakBeforeId: string) => {
    if (olderUI.length === 0) return;

    const existingIds = new Set(messagesRef.current.map((m) => m.message_id));
    const prependedCount = olderUI.filter((m) => !existingIds.has(m.message_id)).length;
    const merged = [...olderUI, ...messagesRef.current];
    const unique = Array.from(
      new Map(merged.map((m) => [m.message_id, m])).values()
    );
    const trimmed = trimMessages(unique, 'new');

    messagesRef.current = trimmed;
    setMessages(trimmed);

    if (trimmed.length < unique.length) {
      setHasNewer(true);
      setIsAtPresent(false);
    }

    if (prependedCount > 0) {
      setFirstItemIndex((prev) => prev - prependedCount);
    }

    setGroupBreakBeforeIds((prev) => {
      const next = new Set(prev);
      next.add(seamBreakBeforeId);
      return next;
    });

    onMessagesLoaded?.(olderUI);
  }, [onMessagesLoaded]);

  const loadOlderPage = useCallback(async (options?: { silent?: boolean; forceServer?: boolean }) => {
    const isSilent = options?.silent === true;
    const forceServer = options?.forceServer === true;
    if (
      !encryptionKey ||
      loadingOlder ||
      prefetchingOlderRef.current ||
      !hasOlder ||
      messagesRef.current.length === 0
    ) {
      return;
    }

    if (isSilent) {
      prefetchingOlderRef.current = true;
      setPrefetchingOlder(true);
    } else {
      setLoadingOlder(true);
    }

    try {
      const oldest = messagesRef.current[0];
      if (!oldest) return;
      const seamBreakBeforeId = oldest.message_id;

      let result: { messages: LocalMessage[]; has_more: boolean };

      if (forceServer) {
        const localResult = await messageSync.readLocal(conversationId, {
          before: oldest.message_id,
          limit: FETCH_SIZE,
        });
        const localUI = sortMessages(localResult.messages.map(toUIMessage));
        applyOlderMessages(localUI, seamBreakBeforeId);

        const serverResult = await getMessages(conversationId, encryptionKey, {
          before: oldest.message_id,
          limit: FETCH_SIZE,
          conversation: decryptionConversation,
          userId,
          peerUserId,
          currentKeyVersion,
        });
        const localMsgs = toLocalMessages(serverResult.messages);
        if (localMsgs.length > 0) {
          await messageStore.putMessages(localMsgs);
        }
        result = {
          messages: mergeLocalMessages(localResult.messages, localMsgs),
          has_more: localResult.has_more || serverResult.has_more || serverResult.messages.length >= FETCH_SIZE,
        };
      } else {
        // Try local first
        result = await messageSync.readLocal(conversationId, {
          before: oldest.message_id,
          limit: FETCH_SIZE,
        });

        if (result.messages.length < FETCH_SIZE || !result.has_more || hasUndecryptableMessage(result.messages)) {
          const serverResult = await getMessages(conversationId, encryptionKey, {
            before: oldest.message_id,
            limit: FETCH_SIZE,
            conversation: decryptionConversation,
            userId,
            peerUserId,
            currentKeyVersion,
          });
          const localMsgs = toLocalMessages(serverResult.messages);
          if (localMsgs.length > 0) {
            await messageStore.putMessages(localMsgs);
          }
          result = {
            messages: mergeLocalMessages(result.messages, localMsgs),
            has_more: result.has_more || serverResult.has_more || serverResult.messages.length >= FETCH_SIZE,
          };
        }
      }

      const olderUI = sortMessages(result.messages.map(toUIMessage));
      if (olderUI.length > 0) {
        applyOlderMessages(olderUI, seamBreakBeforeId);
        setHasOlder(result.has_more);
      } else {
        setHasOlder(false);
      }
    } catch (err) {
      console.error('Failed to load older messages:', err);
    } finally {
      if (isSilent) {
        prefetchingOlderRef.current = false;
        setPrefetchingOlder(false);
      } else {
        setLoadingOlder(false);
      }
    }
  }, [applyOlderMessages, conversationId, currentKeyVersion, decryptionConversation, encryptionKey, hasOlder, loadingOlder, peerUserId, userId]);

  const loadOlder = useCallback(async () => {
    await loadOlderPage();
  }, [loadOlderPage]);

  // ============== Load Newer (Scroll Down) ==============
  const loadNewer = useCallback(async () => {
    if (!encryptionKey || loadingNewer || !hasNewer || messages.length === 0) return;
    setLoadingNewer(true);

    try {
      const newest = messages[messages.length - 1];
      if (!newest) return;

      // Try local first
      let result = await messageSync.readLocal(conversationId, {
        after: newest.message_id,
        limit: FETCH_SIZE,
      });

      if (result.messages.length < FETCH_SIZE || !result.has_more || hasUndecryptableMessage(result.messages)) {
        const serverResult = await getMessages(conversationId, encryptionKey, {
          after: newest.message_id,
          limit: FETCH_SIZE,
          conversation: decryptionConversation,
          userId,
          peerUserId,
          currentKeyVersion,
        });
        const localMsgs = toLocalMessages(serverResult.messages);
        if (localMsgs.length > 0) {
          await messageStore.putMessages(localMsgs);
        }
        result = {
          messages: mergeLocalMessages(result.messages, localMsgs),
          has_more: result.has_more || serverResult.has_more || serverResult.messages.length >= FETCH_SIZE,
        };
      }

      const newerUI = sortMessages(result.messages.map(toUIMessage));
      if (newerUI.length > 0) {
        setMessages((prev) => {
          const merged = [...prev, ...newerUI];
          // Deduplicate (though less likely when loading newer)
          const unique = Array.from(
            new Map(merged.map(m => [m.message_id, m])).values()
          );
          return trimMessages(unique, 'old');
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
  }, [conversationId, currentKeyVersion, decryptionConversation, encryptionKey, hasNewer, loadingNewer, messages, onMessagesLoaded, peerUserId, userId]);

  // ============== Jump to Present ==============
  const jumpToPresent = useCallback(async () => {
    if (!encryptionKey) return;
    setLoadingNewer(true);

    try {
      const fresh = await messageSync.readLocal(conversationId, { limit: FETCH_SIZE });
      const freshUI = sortMessages(fresh.messages.map(toUIMessage));

      setMessages(freshUI);
      setFirstItemIndex(MESSAGE_LIST_BASE_INDEX);
      setGroupBreakBeforeIds(new Set());
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
          if (local && !isUndecryptableContent(local.content)) {
            setReplyCache((prev) => ({ ...prev, [replyToId]: toUIMessage(local) }));
          } else {
            getMessageById(conversationId, replyToId, encryptionKey, {
              conversation: decryptionConversation,
              userId,
              peerUserId,
              currentKeyVersion,
            })
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
  }, [messages, replyCache, conversationId, currentKeyVersion, decryptionConversation, encryptionKey, peerUserId, userId]);

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
    prefetchingOlder,
    loadingNewer,
    hasOlder,
    hasNewer,
    isAtPresent,
    firstItemIndex,
    groupBreakBeforeIds,
    setIsAtPresent,
    handleDelete,
    getReplyParent,
    jumpToPresent,
    loadOlder,
    loadNewer,
  };
};
