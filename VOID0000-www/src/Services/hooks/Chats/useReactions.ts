// src/Services/hooks/Chats/useReactions.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { toggleReaction } from '../../Chat/chatService';

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

export const useReactions = (
  conversationId: string,
  gateway: any,
  currentUserId?: string
) => {
  const [reactions, setReactions] = useState<Record<string, ReactionMap>>({});
  const lastConvRef = useRef<string>('');

  // Reset on conversation change
  useEffect(() => {
    if (lastConvRef.current !== conversationId) {
      setReactions({});
      lastConvRef.current = conversationId;
    }
  }, [conversationId]);

  // Listen for real-time reaction events
  useEffect(() => {
    if (!gateway) return;

    const handleReactionAdd = (data: ReactionEvent) => {
      if (data.conversation_id !== conversationId) return;
      setReactions((prev) => {
        const msgReactions = { ...(prev[data.message_id] || {}) };
        const existing = msgReactions[data.emoji] || { count: 0, me: false };
        msgReactions[data.emoji] = {
          count: existing.count + 1,
          me: existing.me || data.user_id === currentUserId,
        };
        return { ...prev, [data.message_id]: msgReactions };
      });
    };

    const handleReactionRemove = (data: ReactionEvent) => {
      if (data.conversation_id !== conversationId) return;
      setReactions((prev) => {
        const msgReactions = { ...(prev[data.message_id] || {}) };
        const existing = msgReactions[data.emoji];
        if (!existing) return prev;

        const newCount = existing.count - 1;
        if (newCount <= 0) {
          delete msgReactions[data.emoji];
        } else {
          msgReactions[data.emoji] = {
            count: newCount,
            me: data.user_id === currentUserId ? false : existing.me,
          };
        }
        return { ...prev, [data.message_id]: msgReactions };
      });
    };

    gateway.on?.('REACTION_ADD', handleReactionAdd);
    gateway.on?.('REACTION_REMOVE', handleReactionRemove);

    return () => {
      gateway.off?.('REACTION_ADD', handleReactionAdd);
      gateway.off?.('REACTION_REMOVE', handleReactionRemove);
    };
  }, [gateway, conversationId, currentUserId]);

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
      }
      setReactions((prev) => {
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
    [currentUserId]
  );

  // Toggle reaction (optimistic update)
  const handleToggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      setReactions((prev) => {
        const msgReactions = { ...(prev[messageId] || {}) };
        const existing = msgReactions[emoji] || { count: 0, me: false };

        if (existing.me) {
          const newCount = existing.count - 1;
          if (newCount <= 0) {
            delete msgReactions[emoji];
          } else {
            msgReactions[emoji] = { count: newCount, me: false };
          }
        } else {
          msgReactions[emoji] = { count: existing.count + 1, me: true };
        }

        return { ...prev, [messageId]: msgReactions };
      });

      try {
        await toggleReaction(conversationId, messageId, emoji);
      } catch (err) {
        console.error('Failed to toggle reaction:', err);
      }
    },
    [conversationId]
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
