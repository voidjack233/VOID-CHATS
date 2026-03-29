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

  const resolveMemberLabel = useCallback((
    member?: ConversationMember,
    fallbackUser?: { display_name?: string | null; username?: string | null } | null,
  ) => {
    return (
      normalizeName(member?.nickname) ||
      normalizeName(member?.display_name) ||
      normalizeName(member?.username) ||
      normalizeName(fallbackUser?.display_name) ||
      normalizeName(fallbackUser?.username) ||
      null
    );
  }, []);

  const getSenderName = useCallback((senderId: string) => {
    const u = userRef.current;
    const member = membersRef.current[senderId];

    if (senderId === u?.id) {
      return resolveMemberLabel(member, u) || 'You';
    }

    return resolveMemberLabel(member) || senderId.substring(0, 8);
  }, [resolveMemberLabel]);

  const getSenderAvatarUrl = useCallback((senderId: string) => {
    const u = userRef.current;
    if (senderId === u?.id && userAvatarRef.current) return userAvatarRef.current;

    const member = membersRef.current[senderId];
    return member?.avatar_url || null;
  }, []);

  return { formatTime, getSenderName, getSenderAvatarUrl };
};
