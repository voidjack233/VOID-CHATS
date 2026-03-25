// src/hooks/useMessageDisplay.ts
import { useCallback, useRef } from 'react';
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

  // Refs keep callback references stable so downstream memoized components
  // (MessageItem) don't re-render when members/user objects change identity.
  const membersRef = useRef(members);
  membersRef.current = members;
  const userRef = useRef(user);
  userRef.current = user;
  const userAvatarRef = useRef(userAvatar);
  userAvatarRef.current = userAvatar;

  const formatTime = useCallback((dateStr: string) => {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, []);

  const getSenderName = useCallback((senderId: string) => {
    const u = userRef.current;
    if (senderId === u?.id) {
      return normalizeName(u?.display_name) || normalizeName(u?.username) || 'You';
    }

    const member = membersRef.current[senderId];
    return normalizeName(member?.display_name) || normalizeName(member?.username) || senderId.substring(0, 8);
  }, []);

  const getSenderAvatarUrl = useCallback((senderId: string) => {
    const u = userRef.current;
    if (senderId === u?.id && userAvatarRef.current) return userAvatarRef.current;

    const member = membersRef.current[senderId];
    return member?.avatar_url || null;
  }, []);

  return { formatTime, getSenderName, getSenderAvatarUrl };
};
