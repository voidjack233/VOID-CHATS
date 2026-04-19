// src/Services/hooks/Chats/useReactions.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { toggleReaction } from '../../Chat/chatService';
import { MAX_UNIQUE_REACTIONS_PER_MESSAGE, getUniqueReactionCount } from '../../Chat/reactionLimits';

export interface ReactionData {
  count: number;
  me: boolean;
}

export type ReactionMap = Record<string, ReactionData>;

interface ReactionEvent {
  conversation_id: string;
  message_id: string;
  emoji: string;
  user_id: string;
  action: 'add' | 'remove';
}

interface ReactionBatchEvent {
  conversation_id: string;
  message_id: string;
  events: ReactionEvent[];
}

interface PendingReactionSync {
  desiredMe: boolean;
  serverMe: boolean;
  inFlight: boolean;
  timer: number | null;
}

const REACTION_SYNC_DEBOUNCE_MS = 220;

const applyReactionEvent = (
  previous: Record<string, ReactionMap>,
  data: ReactionEvent,
  currentUserId?: string,
): Record<string, ReactionMap> => {
  const msgReactions = { ...(previous[data.message_id] || {}) };

  if (data.action === 'add') {
    const existing = msgReactions[data.emoji] || { count: 0, me: false };
    msgReactions[data.emoji] = {
      count: existing.count + 1,
      me: existing.me || data.user_id === currentUserId,
    };
    return { ...previous, [data.message_id]: msgReactions };
  }

  const existing = msgReactions[data.emoji];
  if (!existing) return previous;

  const newCount = existing.count - 1;
  if (newCount <= 0) {
    delete msgReactions[data.emoji];
  } else {
    msgReactions[data.emoji] = {
      count: newCount,
      me: data.user_id === currentUserId ? false : existing.me,
    };
  }

  return { ...previous, [data.message_id]: msgReactions };
};

const areReactionMapsEqual = (a?: ReactionMap, b?: ReactionMap): boolean => {
  const aEntries = Object.entries(a || {});
  const bEntries = Object.entries(b || {});

  if (aEntries.length !== bEntries.length) {
    return false;
  }

  return aEntries.every(([emoji, data]) => {
    const other = (b || {})[emoji];
    return !!other && other.count === data.count && other.me === data.me;
  });
};

const normalizeReactionMap = (rawReactions: any, currentUserId?: string): ReactionMap => {
  if (!rawReactions || typeof rawReactions !== 'object') {
    return {};
  }

  const normalized: ReactionMap = {};
  for (const [emoji, data] of Object.entries(rawReactions)) {
    if (Array.isArray(data)) {
      normalized[emoji] = {
        count: data.length,
        me: currentUserId ? data.includes(currentUserId) : false,
      };
    } else if (data && typeof data === 'object') {
      normalized[emoji] = data as ReactionData;
    }
  }

  return normalized;
};

const cloneReactionMap = (reactionMap?: ReactionMap): ReactionMap => {
  if (!reactionMap) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(reactionMap).map(([emoji, data]) => [emoji, { ...data }]),
  );
};

const setCurrentUserReactionState = (
  previous: Record<string, ReactionMap>,
  messageId: string,
  emoji: string,
  nextMe: boolean,
): Record<string, ReactionMap> => {
  const currentReactions = previous[messageId] || {};
  const msgReactions = { ...currentReactions };
  const current = msgReactions[emoji] || { count: 0, me: false };

  if (current.me === nextMe) {
    return previous;
  }

  if (nextMe) {
    msgReactions[emoji] = {
      count: current.count + 1,
      me: true,
    };
  } else {
    const nextCount = current.count - 1;
    if (nextCount <= 0) {
      delete msgReactions[emoji];
    } else {
      msgReactions[emoji] = {
        count: nextCount,
        me: false,
      };
    }
  }

  if (Object.keys(msgReactions).length === 0) {
    const next = { ...previous };
    delete next[messageId];
    return next;
  }

  return {
    ...previous,
    [messageId]: msgReactions,
  };
};

export const useReactions = (
  conversationId: string,
  gateway: any,
  currentUserId?: string,
  isAtPresent = true,
) => {
  const [reactions, setReactions] = useState<Record<string, ReactionMap>>({});
  const lastConvRef = useRef<string>('');
  const pendingGatewayEventsRef = useRef<ReactionEvent[]>([]);
  const reactionsRef = useRef<Record<string, ReactionMap>>({});
  const pendingSyncRef = useRef<Record<string, PendingReactionSync>>({});

  const commitReactions = useCallback((
    updater: (
      previous: Record<string, ReactionMap>,
    ) => Record<string, ReactionMap>,
  ) => {
    setReactions((previous) => {
      const next = updater(previous);
      reactionsRef.current = next;
      return next;
    });
  }, []);

  const getSyncKey = useCallback((messageId: string, emoji: string) => (
    `${messageId}:${emoji}`
  ), []);

  const clearSyncTimer = useCallback((syncKey: string) => {
    const entry = pendingSyncRef.current[syncKey];
    if (!entry || entry.timer === null) return;

    window.clearTimeout(entry.timer);
    entry.timer = null;
  }, []);

  const sendQueuedToggleRef = useRef<((messageId: string, emoji: string) => Promise<void>) | null>(null);

  const scheduleReactionSync = useCallback((messageId: string, emoji: string) => {
    const syncKey = getSyncKey(messageId, emoji);
    const entry = pendingSyncRef.current[syncKey];
    if (!entry || entry.inFlight) return;

    clearSyncTimer(syncKey);
    entry.timer = window.setTimeout(() => {
      entry.timer = null;
      sendQueuedToggleRef.current?.(messageId, emoji);
    }, REACTION_SYNC_DEBOUNCE_MS);
  }, [clearSyncTimer, getSyncKey]);

  useEffect(() => {
    reactionsRef.current = reactions;
  }, [reactions]);

  // Reset on conversation change
  useEffect(() => {
    if (lastConvRef.current !== conversationId) {
      Object.values(pendingSyncRef.current).forEach((entry) => {
        if (entry.timer !== null) {
          window.clearTimeout(entry.timer);
        }
      });
      setReactions({});
      pendingGatewayEventsRef.current = [];
      reactionsRef.current = {};
      pendingSyncRef.current = {};
      lastConvRef.current = conversationId;
    }
  }, [conversationId]);

  useEffect(() => {
    if (isAtPresent || pendingGatewayEventsRef.current.length === 0) {
      if (isAtPresent && pendingGatewayEventsRef.current.length > 0) {
        commitReactions((previous) => (
          pendingGatewayEventsRef.current.reduce(
            (next, event) => applyReactionEvent(next, event, currentUserId),
            previous,
          )
        ));
        pendingGatewayEventsRef.current = [];
      }
      return;
    }
  }, [currentUserId, isAtPresent]);

  // Listen for real-time reaction events
  useEffect(() => {
    if (!gateway) return;

    const handleReactionAdd = (data: ReactionEvent) => {
      if (data.conversation_id !== conversationId) return;
      if (!isAtPresent) {
        pendingGatewayEventsRef.current.push(data);
        return;
      }

      commitReactions((previous) => applyReactionEvent(previous, data, currentUserId));
    };

    const handleReactionRemove = (data: ReactionEvent) => {
      if (data.conversation_id !== conversationId) return;
      if (!isAtPresent) {
        pendingGatewayEventsRef.current.push(data);
        return;
      }

      commitReactions((previous) => applyReactionEvent(previous, data, currentUserId));
    };

    const handleReactionBatch = (data: ReactionBatchEvent) => {
      if (data.conversation_id !== conversationId) return;
      if (!Array.isArray(data.events) || data.events.length === 0) return;

      if (!isAtPresent) {
        pendingGatewayEventsRef.current.push(...data.events);
        return;
      }

      commitReactions((previous) => (
        data.events.reduce(
          (next, event) => applyReactionEvent(next, event, currentUserId),
          previous,
        )
      ));
    };

    gateway.on?.('REACTION_ADD', handleReactionAdd);
    gateway.on?.('REACTION_REMOVE', handleReactionRemove);
    gateway.on?.('REACTIONS_BATCH', handleReactionBatch);

    return () => {
      gateway.off?.('REACTION_ADD', handleReactionAdd);
      gateway.off?.('REACTION_REMOVE', handleReactionRemove);
      gateway.off?.('REACTIONS_BATCH', handleReactionBatch);
    };
  }, [commitReactions, conversationId, currentUserId, gateway, isAtPresent]);

  /**
   * Initialize reactions from message data -- called by useMessageList
   * after messages are fetched. Handles both old array format and new {count, me} format.
   */
  const initReactionsFromMessages = useCallback(
    (messages: Array<{ message_id: string; reactions?: any }>) => {
      const reactionsMap: Record<string, ReactionMap> = {};
      for (const msg of messages) {
        const normalized = normalizeReactionMap(msg.reactions, currentUserId);
        if (Object.keys(normalized).length > 0) {
          reactionsMap[msg.message_id] = normalized;
        }

        Object.entries(normalized).forEach(([emoji, data]) => {
          const syncKey = getSyncKey(msg.message_id, emoji);
          const existing = pendingSyncRef.current[syncKey];
          if (existing?.inFlight || existing?.desiredMe !== existing?.serverMe) {
            return;
          }

          pendingSyncRef.current[syncKey] = {
            desiredMe: data.me,
            serverMe: data.me,
            inFlight: false,
            timer: existing?.timer ?? null,
          };
        });
      }
      commitReactions((prev) => {
        const entries = Object.entries(reactionsMap);
        if (entries.length === 0) {
          return prev;
        }

        let next = prev;
        let didChange = false;

        for (const [messageId, normalized] of entries) {
          if (areReactionMapsEqual(prev[messageId], normalized)) {
            continue;
          }

          if (!didChange) {
            next = { ...prev };
            didChange = true;
          }

          next[messageId] = normalized;
        }

        return didChange ? next : prev;
      });
    },
    [commitReactions, currentUserId, getSyncKey]
  );

  const sendQueuedToggle = useCallback(
    async (messageId: string, emoji: string) => {
      const syncKey = getSyncKey(messageId, emoji);
      const entry = pendingSyncRef.current[syncKey];
      if (!entry || entry.inFlight || entry.desiredMe === entry.serverMe) {
        return;
      }

      clearSyncTimer(syncKey);
      entry.inFlight = true;

      try {
        const result = await toggleReaction(conversationId, messageId, emoji);
        const latest = pendingSyncRef.current[syncKey];
        if (!latest) {
          return;
        }

        latest.serverMe = result.action === 'add';
        latest.inFlight = false;

        if (latest.desiredMe !== latest.serverMe) {
          scheduleReactionSync(messageId, emoji);
        }
      } catch (err) {
        console.error('Failed to toggle reaction:', err);

        const latest = pendingSyncRef.current[syncKey];
        if (!latest) {
          return;
        }

        latest.inFlight = false;
        latest.desiredMe = latest.serverMe;

        commitReactions((previous) => (
          setCurrentUserReactionState(previous, messageId, emoji, latest.serverMe)
        ));
      }
    },
    [clearSyncTimer, commitReactions, conversationId, getSyncKey, scheduleReactionSync]
  );

  useEffect(() => {
    sendQueuedToggleRef.current = sendQueuedToggle;
    return () => {
      sendQueuedToggleRef.current = null;
    };
  }, [sendQueuedToggle]);

  // Toggle reaction (optimistic update + debounced sync)
  const handleToggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      const currentMessageReactions = cloneReactionMap(reactionsRef.current[messageId]);
      const current = currentMessageReactions[emoji] || { count: 0, me: false };
      const nextDesiredMe = !current.me;
      const isAddingNewUniqueReaction = nextDesiredMe && current.count === 0;

      if (
        isAddingNewUniqueReaction &&
        getUniqueReactionCount(currentMessageReactions) >= MAX_UNIQUE_REACTIONS_PER_MESSAGE
      ) {
        return;
      }

      commitReactions((previous) => (
        setCurrentUserReactionState(previous, messageId, emoji, nextDesiredMe)
      ));

      const syncKey = getSyncKey(messageId, emoji);
      const existingEntry = pendingSyncRef.current[syncKey];
      pendingSyncRef.current[syncKey] = {
        desiredMe: nextDesiredMe,
        serverMe: existingEntry?.serverMe ?? current.me,
        inFlight: existingEntry?.inFlight ?? false,
        timer: existingEntry?.timer ?? null,
      };

      if (pendingSyncRef.current[syncKey]?.inFlight) {
        return;
      }

      scheduleReactionSync(messageId, emoji);
    },
    [commitReactions, getSyncKey, scheduleReactionSync]
  );

  const getMessageReactions = useCallback(
    (messageId: string, fallbackReactions?: any): ReactionMap => {
      const hydrated = reactions[messageId];
      if (hydrated) {
        return hydrated;
      }
      return normalizeReactionMap(fallbackReactions, currentUserId);
    },
    [currentUserId, reactions]
  );

  return {
    reactions,
    getMessageReactions,
    handleToggleReaction,
    initReactionsFromMessages,
  };
};
