// src/Services/hooks/Chats/useMessageList.ts

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  deleteMessage,
  getMessageById,
  getMessages,
  resolveMessageCryptoMetadata,
  Message,
  type Conversation,
  type ConversationMember,
} from '../../Chat/chatService';
import { messageSync } from '../../Chat/chatSync';
import { messageStore, LocalMessage } from '../../Chat/chatStore';
import { queuedSendStore } from '../../Chat/queuedSendStore';
import { gateway } from '../../Gateway/gateway';
import {
  MESSAGE_CACHE_LIMIT,
  MESSAGE_INITIAL_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  MESSAGE_PREFETCH_SIZE,
} from '../../Chat/chatConstants';

const INITIAL_FETCH_SIZE = MESSAGE_INITIAL_PAGE_SIZE;
const FETCH_SIZE = MESSAGE_PAGE_SIZE;
const CACHE_LIMIT = MESSAGE_CACHE_LIMIT;
const MESSAGE_LIST_BASE_INDEX = 100000;

interface ConversationWindowSnapshot {
  loadedCount: number;
  hasOlder: boolean;
  topVisibleMessageId?: string; // used to restore scroll position on re-open
}

const conversationWindowCache = new Map<string, ConversationWindowSnapshot>();

/**
 * Called by MessageView before switching away from a conversation.
 * Saves the top-visible message ID so we can restore the scroll position on return.
 */
export const saveConversationScrollPosition = (conversationId: string, messageId: string) => {
  const existing = conversationWindowCache.get(conversationId);
  conversationWindowCache.set(conversationId, {
    loadedCount: existing?.loadedCount ?? 0,
    hasOlder: existing?.hasOlder ?? false,
    topVisibleMessageId: messageId,
  });
};

interface MessageUpdate {
  message_id: string;
  content: string;
  is_edited: boolean;
  edited_at: string;
}

interface MessageDelete {
  message_id: string;
}

interface HistoryAccessFence {
  joinedAtMs: number | null;
  keyVersionFloor: number | null;
}

function toUIMessage(local: LocalMessage): Message {
  return {
    conversation_id: local.conversation_id,
    message_id: local.message_id,
    sender_id: local.sender_id,
    encrypted_content: null,
    iv: null,
    key_version: local.key_version ?? 1,
    message_type: local.message_type,
    reply_to: local.reply_to,
    is_edited: local.is_edited,
    edited_at: local.edited_at,
    is_deleted: local.is_deleted,
    created_at: local.created_at,
    content: local.content ?? undefined,
    reactions: local.reactions || {},
    attachments: local.attachments,
    protocol: local.protocol ?? null,
    protocol_version: local.protocol_version ?? null,
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

const isTransientUndecryptableMessage = (message: { content?: string | null; decryption_failed?: boolean }) =>
  message.decryption_failed === true || isUndecryptableContent(message.content);

const hasUndecryptableMessage = (
  messages: Array<{ content?: string | null; decryption_failed?: boolean }>
) => messages.some((message) => isTransientUndecryptableMessage(message));

const getPersistableMessageContent = (message: {
  content?: string | null;
  decryption_failed?: boolean;
}) => (isTransientUndecryptableMessage(message) ? null : (message.content ?? null));

const toLocalMessages = (msgs: Message[]): LocalMessage[] =>
  msgs.map((msg) => {
    const cryptoMetadata = resolveMessageCryptoMetadata(msg);
    return {
      conversation_id: msg.conversation_id,
      message_id: msg.message_id,
      sender_id: msg.sender_id,
      content: getPersistableMessageContent(msg),
      key_version: msg.key_version ?? null,
      message_type: msg.message_type,
      reply_to: msg.reply_to,
      is_edited: msg.is_edited,
      edited_at: msg.edited_at,
      is_deleted: msg.is_deleted,
      created_at: msg.created_at,
      reactions: (msg as any).reactions || {},
      attachments: msg.attachments,
      protocol: cryptoMetadata.protocol,
      protocol_version: cryptoMetadata.protocol_version,
    };
  });

const mergeLocalMessages = (...pages: LocalMessage[][]): LocalMessage[] => {
  const merged = new Map<string, LocalMessage>();

  pages.flat().forEach((message) => {
    const existing = merged.get(message.message_id);
    if (!existing) {
      merged.set(message.message_id, message);
      return;
    }

    merged.set(message.message_id, {
      ...existing,
      ...message,
      content: message.content ?? existing.content ?? null,
      attachments: message.attachments ?? existing.attachments,
      reactions:
        Object.keys(message.reactions || {}).length > 0
          ? message.reactions
          : existing.reactions,
      key_version: message.key_version ?? existing.key_version ?? null,
      protocol: message.protocol ?? existing.protocol ?? null,
      protocol_version: message.protocol_version ?? existing.protocol_version ?? null,
    });
  });

  return sortLocalMessages(Array.from(merged.values()));
};

const getLocalClientId = (message: Pick<Message, 'message_id' | 'local_client_id'>): string | undefined => {
  if (message.local_client_id) return message.local_client_id;
  return typeof message.message_id === 'string' && message.message_id.startsWith('local-')
    ? message.message_id
    : undefined;
};

const isLocalOnlyMessage = (message: Pick<Message, 'message_id'>): boolean =>
  typeof message.message_id === 'string' && message.message_id.startsWith('local-');

const normalizeMessageContent = (content?: string | null) => {
  const trimmed = typeof content === 'string' ? content.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeHistoryVersion = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
};

const getAttachmentSignature = (message: Pick<Message, 'attachments'>) =>
  JSON.stringify(message.attachments || []);

const getReactionSignature = (message: Pick<Message, 'reactions'>) =>
  JSON.stringify(message.reactions || {});

const isEquivalentMessage = (
  existingMessage: Message,
  nextMessage: Message,
) => (
  String(existingMessage.conversation_id) === String(nextMessage.conversation_id) &&
  existingMessage.sender_id === nextMessage.sender_id &&
  existingMessage.encrypted_content === nextMessage.encrypted_content &&
  existingMessage.iv === nextMessage.iv &&
  existingMessage.key_version === nextMessage.key_version &&
  existingMessage.message_type === nextMessage.message_type &&
  (existingMessage.reply_to ?? null) === (nextMessage.reply_to ?? null) &&
  existingMessage.is_edited === nextMessage.is_edited &&
  (existingMessage.edited_at ?? null) === (nextMessage.edited_at ?? null) &&
  existingMessage.is_deleted === nextMessage.is_deleted &&
  existingMessage.created_at === nextMessage.created_at &&
  (existingMessage.content ?? null) === (nextMessage.content ?? null) &&
  (existingMessage.protocol ?? null) === (nextMessage.protocol ?? null) &&
  (existingMessage.protocol_version ?? null) === (nextMessage.protocol_version ?? null) &&
  (existingMessage.local_status ?? null) === (nextMessage.local_status ?? null) &&
  (existingMessage.local_client_id ?? null) === (nextMessage.local_client_id ?? null) &&
  getAttachmentSignature(existingMessage) === getAttachmentSignature(nextMessage) &&
  getReactionSignature(existingMessage) === getReactionSignature(nextMessage)
);

const findOptimisticReplacementId = (
  messages: Message[],
  incoming: Message,
  currentUserId?: string,
): string | undefined => {
  if (!currentUserId || incoming.sender_id !== currentUserId || incoming.local_status === 'sending') {
    return undefined;
  }

  const incomingReplyTo = incoming.reply_to ?? null;
  const incomingContent = normalizeMessageContent(incoming.content);
  const incomingAttachments = getAttachmentSignature(incoming);

  const pendingMatch = messages.find((message) => (
    message.local_status === 'sending' &&
    message.sender_id === incoming.sender_id &&
    String(message.conversation_id) === String(incoming.conversation_id) &&
    message.message_type === incoming.message_type &&
    (message.reply_to ?? null) === incomingReplyTo &&
    normalizeMessageContent(message.content) === incomingContent &&
    getAttachmentSignature(message) === incomingAttachments
  ));

  return pendingMatch ? (getLocalClientId(pendingMatch) || pendingMatch.message_id) : undefined;
};

const mergeMessagesWithReconciliation = ({
  existing,
  incoming,
  currentUserId,
  trimFrom,
  allowOptimisticFallback = false,
}: {
  existing: Message[];
  incoming: Message[];
  currentUserId?: string;
  trimFrom: 'old' | 'new';
  allowOptimisticFallback?: boolean;
}): Message[] => {
  const next = [...existing];
  let didChange = false;

  incoming.forEach((message) => {
    const existingIndex = next.findIndex((entry) => String(entry.message_id) === String(message.message_id));
    if (existingIndex >= 0) {
      const existingMessage = next[existingIndex]!;
      const mergedMessage: Message = {
        ...existingMessage,
        ...message,
        local_client_id: message.local_client_id ?? existingMessage.local_client_id,
        local_status: message.local_status ?? existingMessage.local_status,
      };
      if (!isEquivalentMessage(existingMessage, mergedMessage)) {
        next[existingIndex] = mergedMessage;
        didChange = true;
      }
      return;
    }

    const replacementId = getLocalClientId(message) || (
      allowOptimisticFallback
        ? findOptimisticReplacementId(next, message, currentUserId)
        : undefined
    );

    if (replacementId) {
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const candidate = next[index]!;
        if (
          String(candidate.message_id) === String(replacementId) ||
          getLocalClientId(candidate) === replacementId
        ) {
          next.splice(index, 1);
          didChange = true;
        }
      }
    }

    next.push(message);
    didChange = true;
  });

  if (!didChange) {
    return existing;
  }

  return trimMessages(next, trimFrom);
};

const getNewestServerBackedMessage = (messages: Message[]): Message | undefined =>
  [...messages].reverse().find((message) => !isLocalOnlyMessage(message));

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

const createHistoryAccessFence = (
  conversation: Conversation,
  currentMember?: ConversationMember | null,
): HistoryAccessFence | null => {
  if (conversation.type === 'dm' || !currentMember) {
    return null;
  }

  const joinedAtMs = currentMember.joined_at
    ? new Date(currentMember.joined_at).getTime()
    : Number.NaN;
  const safeJoinedAtMs = Number.isFinite(joinedAtMs) ? joinedAtMs : null;
  const joinedKeyVersion = normalizeHistoryVersion(currentMember.joined_key_version);
  const historyStartVersion = normalizeHistoryVersion(currentMember.history_start_version);
  const keyVersionFloor = Math.max(joinedKeyVersion || 0, historyStartVersion || 0) || null;

  if (safeJoinedAtMs === null && keyVersionFloor === null) {
    return null;
  }

  return {
    joinedAtMs: safeJoinedAtMs,
    keyVersionFloor,
  };
};

const isMessageVisibleForHistoryFence = (
  message: { created_at: string; key_version?: number | null },
  historyAccessFence: HistoryAccessFence | null,
): boolean => {
  if (!historyAccessFence) {
    return true;
  }

  if (
    historyAccessFence.keyVersionFloor !== null &&
    typeof message.key_version === 'number' &&
    message.key_version > 0 &&
    message.key_version < historyAccessFence.keyVersionFloor
  ) {
    return false;
  }

  if (historyAccessFence.joinedAtMs !== null) {
    const createdAtMs = new Date(message.created_at).getTime();
    if (Number.isFinite(createdAtMs) && createdAtMs < historyAccessFence.joinedAtMs) {
      return false;
    }
  }

  return true;
};

const filterMessagesByHistoryFence = <T extends { created_at: string; key_version?: number | null }>(
  messages: T[],
  historyAccessFence: HistoryAccessFence | null,
): T[] => {
  if (!historyAccessFence || messages.length === 0) {
    return messages;
  }

  const filtered = messages.filter((message) =>
    isMessageVisibleForHistoryFence(message, historyAccessFence)
  );

  return filtered.length === messages.length ? messages : filtered;
};

export const useMessageList = (
  conversation: Conversation,
  userId: string | undefined,
  currentMember: ConversationMember | null | undefined,
  encryptionKey: CryptoKey | null,
  currentKeyVersion = 1,
  newMessage?: Message | null,
  messageUpdate?: MessageUpdate | null,
  messageDelete?: MessageDelete | null,
  onMessagesLoaded?: (messages: Message[]) => void
) => {
  const conversationId = conversation.id;
  const hasEncryptionKey = Boolean(encryptionKey);
  const historyAccessFence = useMemo(
    () => createHistoryAccessFence(conversation, currentMember),
    [
      conversation.type,
      currentMember?.history_start_version,
      currentMember?.joined_at,
      currentMember?.joined_key_version,
    ]
  );
  const historyAccessFenceSignature = historyAccessFence
    ? `${historyAccessFence.joinedAtMs ?? ''}:${historyAccessFence.keyVersionFloor ?? ''}`
    : 'none';
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
  // Prevents firing the post-load background prefetch more than once per conversation load.
  const prefetchedAfterLoadRef = useRef(false);

  // The message ID to scroll to when this conversation reopens (from previous session).
  // Read once per conversation mount from the module-level cache.
  const initialScrollToMessageId = useMemo(
    () => conversationWindowCache.get(conversationId)?.topVisibleMessageId ?? null,
    [conversationId]
  );

  // Track which conversation we last loaded so we can distinguish between
  // a genuine conversation switch (needs full reset) and a same-conversation
  // reload (initial key resolution or key rotation), which should preserve
  // any visible messages while the refresh completes.
  const lastLoadedConversationIdRef = useRef<string | null>(null);

  // Refs for values used inside the initial load effect that should NOT
  // trigger a re-run on key rotation. On key rotation the messages are
  // already displayed and new messages arrive via the WS MESSAGE_CREATE
  // handler, so re-syncing from the server is unnecessary and causes a
  // visible blink (Virtuoso re-renders from a new merged array).
  const encryptionKeyRef = useRef(encryptionKey);
  encryptionKeyRef.current = encryptionKey;
  const currentKeyVersionRef = useRef(currentKeyVersion);
  currentKeyVersionRef.current = currentKeyVersion;

  useEffect(() => {
    setReplyCache({});
    fetchingReplies.current.clear();
    prefetchingOlderRef.current = false;
    prefetchedAfterLoadRef.current = false;
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
    let ignore = false;
    const sessionSnapshot = conversationWindowCache.get(conversationId);
    const initialLimit = Math.max(INITIAL_FETCH_SIZE, sessionSnapshot?.loadedCount ?? 0);

    const loadLocalOnly = async () => {
      const shouldPreserveMessages = lastLoadedConversationIdRef.current === conversationId;
      lastLoadedConversationIdRef.current = conversationId;

      if (!shouldPreserveMessages) {
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
        const cached = await messageSync.readLocal(conversationId, { limit: initialLimit });
        if (ignore) return;

        const visibleCachedMessages = filterMessagesByHistoryFence(cached.messages, historyAccessFence);
        const uiMessages = sortMessages(visibleCachedMessages.map(toUIMessage));
        if (uiMessages.length > 0) {
          if (shouldPreserveMessages) {
            setMessages((prev) => {
              if (prev.length === 0) return uiMessages;
              return mergeMessagesWithReconciliation({
                existing: prev,
                incoming: uiMessages,
                currentUserId: userId,
                trimFrom: 'old',
                allowOptimisticFallback: true,
              });
            });
          } else {
            setMessages(uiMessages);
          }
          onMessagesLoaded?.(uiMessages);
        } else if (!shouldPreserveMessages) {
          setMessages([]);
        }

        setHasOlder(resolveInitialHasOlder({
          localHasMore: cached.has_more,
          localCount: uiMessages.length,
          requestedLimit: initialLimit,
          sessionSnapshot,
        }));
        setHasNewer(false);
        setIsAtPresent(true);
        setLoading(false);
        setSyncing(false);
      } catch (err) {
        if (ignore) return;
        console.error('Failed to load cached messages without an encryption key:', err);
        setLoading(false);
        setSyncing(false);
      }
    };

    const load = async () => {
      // If the conversation hasn't changed, we're refreshing the same thread
      // after initial key resolution or key rotation. Preserve visible
      // messages while we re-sync instead of clearing the list.
      const shouldPreserveMessages = lastLoadedConversationIdRef.current === conversationId;
      lastLoadedConversationIdRef.current = conversationId;

      if (!shouldPreserveMessages) {
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
          encryptionKeyRef.current!,
          {
            preferSessionCache: true,
            initialLimit,
            syncLimit: INITIAL_FETCH_SIZE,
            conversation: decryptionConversation,
            userId,
              currentKeyVersion: currentKeyVersionRef.current,
          }
        );

        if (ignore) return;

        if (cached.messages.length > 0) {
          const visibleCachedMessages = filterMessagesByHistoryFence(cached.messages, historyAccessFence);
          const uiMessages = sortMessages(visibleCachedMessages.map(toUIMessage));
          if (shouldPreserveMessages) {
            setMessages((prev) => {
              if (prev.length === 0) return uiMessages;
              return mergeMessagesWithReconciliation({
                existing: prev,
                incoming: uiMessages,
                currentUserId: userId,
                trimFrom: 'old',
                allowOptimisticFallback: true,
              });
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
            const visibleFreshMessages = filterMessagesByHistoryFence(fresh.messages, historyAccessFence);
            const freshUI = sortMessages(visibleFreshMessages.map(toUIMessage));
            setMessages((prev) => {
              return mergeMessagesWithReconciliation({
                existing: prev,
                incoming: freshUI,
                currentUserId: userId,
                trimFrom: 'old',
                allowOptimisticFallback: true,
              });
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
          const visibleFreshMessages = filterMessagesByHistoryFence(fresh.messages, historyAccessFence);
          const freshUI = sortMessages(visibleFreshMessages.map(toUIMessage));
          if (shouldPreserveMessages) {
            setMessages((prev) => {
              if (freshUI.length === 0) return prev;
              return mergeMessagesWithReconciliation({
                existing: prev,
                incoming: freshUI,
                currentUserId: userId,
                trimFrom: 'old',
                allowOptimisticFallback: true,
              });
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

    if (!encryptionKeyRef.current) {
      void loadLocalOnly();
      return () => { ignore = true; };
    }

    void load();
    return () => { ignore = true; };
    // The key object/version are intentionally accessed via refs so a
    // non-null -> non-null key rotation does not re-trigger this effect.
    // We only depend on hasEncryptionKey so a newly opened conversation
    // reruns once when the handshake upgrades null -> ready key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, decryptionConversation, hasEncryptionKey, historyAccessFenceSignature, peerUserId, userId]);

  // ============== Restore Persisted Queued Sends ==============
  // On conversation open, load any queued secure-send messages from the
  // persistent store and inject them into the message list.  These survive
  // conversation switch, refresh, and crash.
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

        setMessages((prev) =>
          mergeMessagesWithReconciliation({
            existing: prev,
            incoming: queuedMessages,
            currentUserId: userId,
            trimFrom: 'old',
            allowOptimisticFallback: false,
          })
        );
      } catch (err) {
        console.error('[QUEUED_SEND] failed to load persisted queued sends', err);
      }
    })();

    return () => { ignore = true; };
  }, [conversationId, userId]);

  // ============== Handle Incoming New Messages ==============
  useEffect(() => {
    if (!newMessage) return;
    const normalizedConversationId = newMessage.conversation_id || conversationId;
    if (String(normalizedConversationId) !== String(conversationId)) {
      return;
    }
    const localStatus = newMessage.local_status;
    const localClientId = getLocalClientId(newMessage);

    if (localStatus === 'failed' && localClientId) {
      setMessages((prev) => prev.filter((message) =>
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

    const isLocalPendingOnly = (normalizedMessage.local_status === 'sending' || normalizedMessage.local_status === 'queued') && Boolean(localClientId);
    if (!isLocalPendingOnly) {
      const localMsg: LocalMessage = {
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

      messageSync.storeIncomingMessage(localMsg).catch(console.error);
    }

    // Always inject incoming messages so realtime updates are visible without refresh.
    setMessages((prev) => {
      return mergeMessagesWithReconciliation({
        existing: prev,
        incoming: [normalizedMessage],
        currentUserId: userId,
        trimFrom: 'old',
        allowOptimisticFallback: true,
      });
    });
  }, [newMessage, conversationId, historyAccessFence, userId]);

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
    // Use a larger page for silent background fetches so we build a bigger local buffer.
    const fetchSize = isSilent ? MESSAGE_PREFETCH_SIZE : FETCH_SIZE;

    if (
      !encryptionKeyRef.current ||
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
          limit: fetchSize,
        });
        const localUI = sortMessages(localResult.messages.map(toUIMessage));
        applyOlderMessages(localUI, seamBreakBeforeId);

        const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
          before: oldest.message_id,
          limit: fetchSize,
          conversation: decryptionConversation,
          userId,
          currentKeyVersion: currentKeyVersionRef.current,
        });
        const localMsgs = toLocalMessages(serverResult.messages);
        if (localMsgs.length > 0) {
          await messageStore.putMessages(localMsgs);
        }
        result = {
          messages: mergeLocalMessages(localResult.messages, localMsgs),
          has_more: localResult.has_more || serverResult.has_more || serverResult.messages.length >= fetchSize,
        };
      } else {
        // Try local first
        result = await messageSync.readLocal(conversationId, {
          before: oldest.message_id,
          limit: fetchSize,
        });

        if (result.messages.length < fetchSize || !result.has_more || hasUndecryptableMessage(result.messages)) {
          const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
            before: oldest.message_id,
            limit: fetchSize,
            conversation: decryptionConversation,
            userId,
              currentKeyVersion: currentKeyVersionRef.current,
          });
          const localMsgs = toLocalMessages(serverResult.messages);
          if (localMsgs.length > 0) {
            await messageStore.putMessages(localMsgs);
          }
          result = {
            messages: mergeLocalMessages(result.messages, localMsgs),
            has_more: result.has_more || serverResult.has_more || serverResult.messages.length >= fetchSize,
          };
        }
      }

      const visibleOlderMessages = filterMessagesByHistoryFence(result.messages, historyAccessFence);
      const olderUI = sortMessages(visibleOlderMessages.map(toUIMessage));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyOlderMessages, conversationId, decryptionConversation, hasOlder, historyAccessFenceSignature, loadingOlder, peerUserId, userId]);

  const loadOlder = useCallback(async () => {
    await loadOlderPage();
  }, [loadOlderPage]);

  // ============== Background Prefetch (WhatsApp-style lazy async) ==============
  // After the initial load completes and there are older messages, silently prefetch
  // the next older page into IndexedDB so that the first scroll-up is instant.
  useEffect(() => {
    if (loading || !hasOlder || !encryptionKey || prefetchedAfterLoadRef.current) return;
    prefetchedAfterLoadRef.current = true;

    const timer = window.setTimeout(() => {
      void loadOlderPage({ silent: true });
    }, 600);

    return () => window.clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, hasOlder, encryptionKey]);

  // Public handle for MessageView's velocity-based prefetch trigger.
  const prefetchOlder = useCallback(() => {
    void loadOlderPage({ silent: true, forceServer: false });
  }, [loadOlderPage]);

  // ============== Load Newer (Scroll Down) ==============
  const loadNewer = useCallback(async () => {
    if (!encryptionKeyRef.current || loadingNewer || !hasNewer || messages.length === 0) return;
    setLoadingNewer(true);

    try {
      const newest = getNewestServerBackedMessage(messages);
      if (!newest) return;

      // Try local first
      let result = await messageSync.readLocal(conversationId, {
        after: newest.message_id,
        limit: FETCH_SIZE,
      });

      if (result.messages.length < FETCH_SIZE || !result.has_more || hasUndecryptableMessage(result.messages)) {
        const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
          after: newest.message_id,
          limit: FETCH_SIZE,
          conversation: decryptionConversation,
          userId,
          currentKeyVersion: currentKeyVersionRef.current,
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

      const visibleNewerMessages = filterMessagesByHistoryFence(result.messages, historyAccessFence);
      const newerUI = sortMessages(visibleNewerMessages.map(toUIMessage));
      if (newerUI.length > 0) {
        setMessages((prev) => {
          return mergeMessagesWithReconciliation({
            existing: prev,
            incoming: newerUI,
            currentUserId: userId,
            trimFrom: 'old',
            allowOptimisticFallback: true,
          });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, decryptionConversation, hasNewer, historyAccessFenceSignature, loadingNewer, messages, onMessagesLoaded, peerUserId, userId]);

  const reconcileRecentMessages = useCallback(async (source: 'gateway_ready' | 'gateway_resumed' | 'tab_visible') => {
    if (!encryptionKeyRef.current) return;

    const newest = getNewestServerBackedMessage(messagesRef.current);
    if (!newest) return;

    console.log('[WS_RESYNC] reconciling active conversation after reconnect/visibility', {
      conversation_id: conversationId,
      source,
      after_message_id: newest.message_id,
    });

    try {
      const serverResult = await getMessages(conversationId, encryptionKeyRef.current!, {
        after: newest.message_id,
        limit: FETCH_SIZE,
        conversation: decryptionConversation,
        userId,
        currentKeyVersion: currentKeyVersionRef.current,
      });

      if (serverResult.messages.length === 0) {
        return;
      }

      const localMsgs = toLocalMessages(serverResult.messages);
      if (localMsgs.length > 0) {
        await messageStore.putMessages(localMsgs);
      }

      const visibleServerMessages = filterMessagesByHistoryFence(serverResult.messages, historyAccessFence);
      const newerUI = sortMessages(visibleServerMessages);
      setMessages((prev) => {
        return mergeMessagesWithReconciliation({
          existing: prev,
          incoming: newerUI,
          currentUserId: userId,
          trimFrom: 'old',
          allowOptimisticFallback: true,
        });
      });
      setHasNewer(serverResult.has_more || serverResult.messages.length >= FETCH_SIZE);
      setIsAtPresent(!(serverResult.has_more || serverResult.messages.length >= FETCH_SIZE));
      onMessagesLoaded?.(newerUI);
    } catch (err) {
      console.error('Failed to reconcile missed messages after reconnect:', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, decryptionConversation, historyAccessFenceSignature, onMessagesLoaded, userId]);

  useEffect(() => {
    if (!encryptionKey) return;

    let lastResyncAt = 0;

    const runResync = (source: 'gateway_ready' | 'gateway_resumed' | 'tab_visible') => {
      const now = Date.now();
      if (now - lastResyncAt < 1500) {
        return;
      }
      lastResyncAt = now;
      void reconcileRecentMessages(source);
    };

    const handleReady = () => runResync('gateway_ready');
    const handleResumed = () => runResync('gateway_resumed');
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runResync('tab_visible');
      }
    };

    gateway.on('READY', handleReady);
    gateway.on('RESUMED', handleResumed);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      gateway.off('READY', handleReady);
      gateway.off('RESUMED', handleResumed);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [encryptionKey, reconcileRecentMessages]);

  // ============== Jump to Present ==============
  const jumpToPresent = useCallback(async () => {
    if (!encryptionKey) return;
    setLoadingNewer(true);

    try {
      const fresh = await messageSync.readLocal(conversationId, { limit: FETCH_SIZE });
      const visibleFreshMessages = filterMessagesByHistoryFence(fresh.messages, historyAccessFence);
      const freshUI = sortMessages(visibleFreshMessages.map(toUIMessage));

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
  }, [encryptionKey, conversationId, historyAccessFenceSignature, onMessagesLoaded]);

  // ============== Reply Parent Lookup ==============
  const getReplyParent = useCallback((replyToId: string): Message | null => {
    const found = messages.find((m) => m.message_id === replyToId);
    if (found) return found;
    if (replyCache[replyToId]) return replyCache[replyToId];
    return null;
  }, [messages, replyCache]);

  // Fetch missing replies
  useEffect(() => {
    if (!encryptionKeyRef.current) return;
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
            const localReply = toUIMessage(local);
            setReplyCache((prev) => ({
              ...prev,
              [replyToId]: isMessageVisibleForHistoryFence(localReply, historyAccessFence)
                ? localReply
                : { message_id: replyToId, content: '[deleted or unavailable]', is_deleted: true } as any,
            }));
          } else {
            getMessageById(conversationId, replyToId, encryptionKeyRef.current!, {
              conversation: decryptionConversation,
              userId,
                  currentKeyVersion: currentKeyVersionRef.current,
            })
              .then((msg: any) => {
                if (ignore) return;
                const actualMsg = msg?.message || msg;
                setReplyCache((prev) => ({
                  ...prev,
                  [replyToId]: actualMsg && isMessageVisibleForHistoryFence(actualMsg, historyAccessFence)
                    ? actualMsg
                    : { message_id: replyToId, content: '[deleted or unavailable]', is_deleted: true } as any
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, replyCache, conversationId, decryptionConversation, historyAccessFenceSignature, peerUserId, userId]);

  // ============== Delete (API + Local) ==============
  const handleDelete = useCallback(async (messageId: string) => {
    try {
      await deleteMessage(conversationId, messageId);
      await messageSync.handleDelete(conversationId, messageId);
      setMessages((prev) => prev.map((m) => m.message_id === messageId ? { ...m, is_deleted: true, content: '[deleted]', encrypted_content: null } : m));
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }, [conversationId]);

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
    // Lazy-async additions
    prefetchOlder,
    initialScrollToMessageId,
  };
};
