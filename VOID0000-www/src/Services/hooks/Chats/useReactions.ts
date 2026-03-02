// src/Services/hooks/Chats/useReactions.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { toggleReaction, getReactions, ReactionMap } from '../../Chat/chatService';

interface ReactionEvent {
  conversation_id: string;
  message_id: string;
  emoji: string;
  user_id: string;
  action: 'add' | 'remove';
}

/**
 * Manages reactions for all messages in a conversation.
 * State shape: { [messageId]: { [emoji]: [userId, userId, ...] } }
 */
export const useReactions = (
  conversationId: string,
  gateway: any // your WebSocket gateway hook/ref
) => {
  // { messageId: { emoji: [userIds] } }
  const [reactions, setReactions] = useState<Record<string, ReactionMap>>({});
  const [loadedMessages, setLoadedMessages] = useState<Set<string>>(new Set());
  const loadingRef = useRef<Set<string>>(new Set());

  // Reset on conversation change
  useEffect(() => {
    setReactions({});
    setLoadedMessages(new Set());
    loadingRef.current.clear();
  }, [conversationId]);

  // Listen for real-time reaction events from gateway
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

    // Subscribe to gateway events — adapt this to your gateway hook pattern
    // If your gateway uses addEventListener style:
    gateway.on?.('REACTION_ADD', handleReactionAdd);
    gateway.on?.('REACTION_REMOVE', handleReactionRemove);

    return () => {
      gateway.off?.('REACTION_ADD', handleReactionAdd);
      gateway.off?.('REACTION_REMOVE', handleReactionRemove);
    };
  }, [gateway, conversationId]);

  // Fetch reactions for a specific message (called lazily)
  const loadReactionsForMessage = useCallback(
    async (messageId: string) => {
      if (loadedMessages.has(messageId) || loadingRef.current.has(messageId)) return;
      loadingRef.current.add(messageId);

      try {
        const reactionMap = await getReactions(conversationId, messageId);
        setReactions((prev) => ({ ...prev, [messageId]: reactionMap }));
        setLoadedMessages((prev) => new Set(prev).add(messageId));
      } catch (err) {
        console.error('Failed to load reactions:', err);
      } finally {
        loadingRef.current.delete(messageId);
      }
    },
    [conversationId, loadedMessages]
  );

  // Batch load reactions for visible messages
  const loadReactionsForMessages = useCallback(
    (messageIds: string[]) => {
      messageIds.forEach((id) => loadReactionsForMessage(id));
    },
    [loadReactionsForMessage]
  );

  // Toggle reaction (optimistic update)
  const handleToggleReaction = useCallback(
    async (messageId: string, emoji: string, userId: string) => {
      // Optimistic update
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
        // Revert on error by re-fetching
        const reactionMap = await getReactions(conversationId, messageId);
        setReactions((prev) => ({ ...prev, [messageId]: reactionMap }));
      }
    },
    [conversationId]
  );

  // Get reactions for a specific message
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
    loadReactionsForMessage,
  };
};