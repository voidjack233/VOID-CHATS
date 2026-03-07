// src/hooks/useMessageDisplay.ts
import { useCallback } from 'react';
import { useUser } from '../../Auth/UserContext';
import { ConversationMember } from '../../Chat/chatService';

export const useMessageDisplay = (
  members: Record<string, ConversationMember>,
  userAvatar?: string
) => {
  const { user } = useUser();

  const formatTime = useCallback((dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, []);

const getSenderName = useCallback((senderId: string) => {
    // FIX: Prioritize the current user's display_name before falling back to username
    if (senderId === user?.id) {
      return user?.display_name || user?.username || 'You';
    }
    
    // For other members, it was already doing it correctly!
    const member = members[senderId];
    return member?.display_name || member?.username || senderId.substring(0, 8);
  }, [user, members]);

  const getSenderAvatarUrl = useCallback((senderId: string) => {
    // 1. Current user
    if (senderId === user?.id && userAvatar) return userAvatar;
    
    // 2. Other members
    const memberAvatar = members[senderId]?.avatar_url;
    if (memberAvatar) return memberAvatar;
    
    // 3. Fallback
    const fallbackName = getSenderName(senderId);
    return `https://api.dicebear.com/7.x/avataaars/svg?seed=${fallbackName}`;
  }, [user, userAvatar, members, getSenderName]);

  return { formatTime, getSenderName, getSenderAvatarUrl };
};