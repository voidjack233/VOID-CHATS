// src/Services/hooks/Chats/useReactions.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { toggleReaction, getBatchReactions, ReactionMap } from '../../Chat/chatService';

interface ReactionEvent {
  conversation_id: string;
  message_id: string;
  emoji: string;
  user_id: string;
  action: 'add' | 'remove';
}

export const useReactions = (
  conversationId: string,
  gateway: any
) => {
  const [reactions, setReactions] = useState<Record<string, ReactionMap>>({});
  const loadedRef = useRef(false);
  const lastConvRef = useRef<string>('');

  // Reset on conversation change
  useEffect(() => {
    if (lastConvRef.current !== conversationId) {
      setReactions({});
      loadedRef.current = false;
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
        const users = [...(msgReactions[data.emoji] || [])];
        if (!users.includes(data.user_id)) {
          users.push(data.user_id);
        }
        msgReactions[data.emoji] = users;
        return { ...prev, [data.message_id]: msgReactions };
      });
    };

    const handleReactionRemove = (data: ReactionEvent) => {
      if (data.conversation_id !== conversationId) return;
      setReactions((prev) => {
        const msgReactions = { ...(prev[data.message_id] || {}) };
        const users = (msgReactions[data.emoji] || []).filter(
          (id) => id !== data.user_id
        );
        if (users.length === 0) {
          delete msgReactions[data.emoji];
        } else {
          msgReactions[data.emoji] = users;
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
  }, [gateway, conversationId]);

  // Batch load — ONE call for all visible messages
  const loadReactionsForMessages = useCallback(
    async (messageIds: string[]) => {
      if (messageIds.length === 0 || loadedRef.current) return;
      loadedRef.current = true;

      try {
        const batchResult = await getBatchReactions(conversationId, messageIds);
        setReactions((prev) => {
          const next: Record<string, ReactionMap> = { ...prev };
          for (const [msgId, reactionMap] of Object.entries(batchResult)) {
            next[msgId] = reactionMap as ReactionMap;
          }
          return next;
        });
      } catch (err) {
        console.error('Failed to batch load reactions:', err);
        loadedRef.current = false;
      }
    },
    [conversationId]
  );

  // Toggle reaction (optimistic update)
  const handleToggleReaction = useCallback(
    async (messageId: string, emoji: string, userId: string) => {
      setReactions((prev) => {
        const msgReactions = { ...(prev[messageId] || {}) };
        const users = [...(msgReactions[emoji] || [])];
        const index = users.indexOf(userId);

        if (index > -1) {
          users.splice(index, 1);
          if (users.length === 0) {
            delete msgReactions[emoji];
          } else {
            msgReactions[emoji] = users;
          }
        } else {
          users.push(userId);
          msgReactions[emoji] = users;
        }

        return { ...prev, [messageId]: msgReactions };
      });

      try {
        await toggleReaction(conversationId, messageId, emoji);
      } catch (err) {
        console.error('Failed to toggle reaction:', err);
        try {
          const batchResult = await getBatchReactions(conversationId, [messageId]);
          setReactions((prev) => {
            const next: Record<string, ReactionMap> = { ...prev };
            for (const [msgId, reactionMap] of Object.entries(batchResult)) {
              next[msgId] = reactionMap as ReactionMap;
            }
            return next;
          });
        } catch {
          // Give up on revert
        }
      }
    },
    [conversationId]
  );

  const getMessageReactions = useCallback(
    (messageId: string): ReactionMap => {
      return reactions[messageId] || {};
    },
    [reactions]
  );

  return {
    reactions,
    getMessageReactions,
    handleToggleReaction,
    loadReactionsForMessages,
  };
};