// src/hooks/useMessageDisplay.ts
import { useCallback } from 'react';
import { useUser } from '../../Auth/UserContext';
import { ConversationMember } from '../../Chat/chatService';

const normalizeName = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

export const useMessageDisplay = (
  members: Record<string, ConversationMember>,
  userAvatar?: string
) => {
  const { user } = useUser();

  const formatTime = useCallback((dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, []);

const getSenderName = useCallback((senderId: string) => {
    if (senderId === user?.id) {
      return normalizeName(user?.display_name) || normalizeName(user?.username) || 'You';
    }

    const member = members[senderId];
    return normalizeName(member?.display_name) || normalizeName(member?.username) || senderId.substring(0, 8);
  }, [user, members]);

  const getSenderAvatarUrl = useCallback((senderId: string) => {
    if (senderId === user?.id && userAvatar) return userAvatar;

    const member = members[senderId];
    return member?.avatar_url || null;
  }, [user, userAvatar, members]);

  return { formatTime, getSenderName, getSenderAvatarUrl };
};
