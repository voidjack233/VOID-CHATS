// src/Services/hooks/Chats/useTypingIndicator.ts
//
// Manages the typing indicator state for the active conversation.
//
// Responsibilities:
//   - Tracks which users are currently typing (user_id → timestamp).
//   - Listens for TYPING_START gateway events and updates the map.
//   - Resets the map when the active conversation changes.
//   - Runs a 1-second interval to evict entries older than 4.5 seconds.
//   - Exposes clearUserTyping so that useMessageStream's MESSAGE_CREATE handler
//     can clear a sender's indicator immediately when their message arrives.

import { useState, useEffect, useCallback } from 'react';
import { Conversation } from '../../Chat/chatService';
import { gateway } from '../../Gateway/gateway';

interface UseTypingIndicatorProps {
  activeConversation: Conversation | null;
  user: { id: string } | null | undefined;
}

export interface UseTypingIndicatorResult {
  typingUsers: Record<string, number>;
  clearUserTyping: (userId: string) => void;
}

export const useTypingIndicator = ({
  activeConversation,
  user,
}: UseTypingIndicatorProps): UseTypingIndicatorResult => {
  const [typingUsers, setTypingUsers] = useState<Record<string, number>>({});

  // Reset the map whenever the active conversation changes.
  useEffect(() => {
    setTypingUsers({});
  }, [activeConversation?.id]);

  // Listen for TYPING_START events and add the sender to the map.
  useEffect(() => {
    if (!user?.id) return;

    const handleTypingStart = (data: any) => {
      const conversationId = data?.conversation_id;
      const typingUserId = data?.user_id;
      if (!conversationId || !typingUserId || !activeConversation?.id) return;
      if (String(conversationId) !== String(activeConversation.id)) return;
      if (String(typingUserId) === String(user.id)) return;

      setTypingUsers((prev) => ({
        ...prev,
        [String(typingUserId)]: Date.now(),
      }));
    };

    gateway.on('TYPING_START', handleTypingStart);
    return () => gateway.off('TYPING_START', handleTypingStart);
  }, [activeConversation?.id, user?.id]);

  // Evict entries that have been stale for more than 4.5 seconds.
  // The interval is only scheduled while at least one user is typing.
  useEffect(() => {
    if (Object.keys(typingUsers).length === 0) return;

    const timer = window.setInterval(() => {
      const cutoff = Date.now() - 4500;
      setTypingUsers((prev) => {
        let changed = false;
        const next: Record<string, number> = {};
        Object.entries(prev).forEach(([typingUserId, timestamp]) => {
          if (timestamp >= cutoff) {
            next[typingUserId] = timestamp;
          } else {
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [typingUsers]);

  // Called by useMessageStream's MESSAGE_CREATE handler when a message arrives,
  // to clear that sender's typing indicator immediately without waiting for
  // the 4.5-second timeout.
  const clearUserTyping = useCallback((userId: string) => {
    setTypingUsers((prev) => {
      if (!prev[userId]) return prev;
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  }, []);

  return { typingUsers, clearUserTyping };
};
