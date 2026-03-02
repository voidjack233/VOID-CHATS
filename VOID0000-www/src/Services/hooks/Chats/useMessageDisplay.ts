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
    const date = new Date(dateStr);
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const diffDays = Math.floor((new Date().getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return `Today at ${time}`;
    if (diffDays === 1) return `Yesterday at ${time}`;
    return `${date.toLocaleDateString()} ${time}`;
  }, []);

  const getSenderName = useCallback((senderId: string) => {
    if (senderId === user?.id) return user?.username || 'You';
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