import { useCallback, useEffect, useState } from 'react';
import type { Message, ConversationMember } from '../../Services/Chat/chatService';
import type { Friend } from '../../Services/hooks/Friends/useFriends';

export interface ContextMenuState {
  msg: Message;
  x: number;
  y: number;
}

export interface EmojiPickerTarget {
  messageId: string;
  position: { x: number; y: number };
}

export interface ImageViewerState {
  urls: string[];
  index: number;
}

interface UseMessageActionsParams {
  userId?: string;
  userProfileId?: string | null;
  friends: Friend[];
  members: Record<string, ConversationMember>;
  onToggleReaction: (messageId: string, emoji: string) => void;
}

export function useMessageActions({
  userId,
  userProfileId,
  friends,
  members,
  onToggleReaction,
}: UseMessageActionsParams) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<EmojiPickerTarget | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);
  const [imageViewer, setImageViewer] = useState<ImageViewerState | null>(null);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    document.addEventListener('click', closeMenu);
    document.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('scroll', closeMenu, true);
    };
  }, []);

  const closeImageViewer = useCallback(() => {
    setImageViewer(null);
  }, []);

  const showPreviousImage = useCallback(() => {
    setImageViewer((current) =>
      current && current.index > 0
        ? { ...current, index: current.index - 1 }
        : current,
    );
  }, []);

  const showNextImage = useCallback(() => {
    setImageViewer((current) =>
      current && current.index < current.urls.length - 1
        ? { ...current, index: current.index + 1 }
        : current,
    );
  }, []);

  const selectImageIndex = useCallback((index: number) => {
    setImageViewer((current) => current ? { ...current, index } : current);
  }, []);

  useEffect(() => {
    if (!imageViewer) return;

    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeImageViewer();
      if (event.key === 'ArrowLeft') showPreviousImage();
      if (event.key === 'ArrowRight') showNextImage();
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeImageViewer, imageViewer, showNextImage, showPreviousImage]);

  const handleContextMenu = useCallback((event: React.MouseEvent, msg: Message) => {
    event.preventDefault();
    let x = event.clientX;
    let y = event.clientY;
    if (window.innerWidth - x < 200) x -= 180;
    if (window.innerHeight - y < 200) y -= 150;
    setContextMenu({ msg, x, y });
  }, []);

  const handleProfileClick = useCallback((senderId: string) => {
    if (senderId === userId && userProfileId) {
      setSelectedProfileId(userProfileId);
      return;
    }

    const friend = friends.find((entry) => entry.id === senderId);
    if (friend) {
      setSelectedFriend(friend);
      return;
    }

    const member = members[senderId];
    if (member?.profile_id) {
      setSelectedProfileId(member.profile_id);
      return;
    }

    setSelectedProfileId(senderId);
  }, [friends, members, userId, userProfileId]);

  const openEmojiPicker = useCallback((
    messageId: string,
    anchor: HTMLElement,
    placement: 'top' | 'bottom' = 'top',
  ) => {
    const rect = anchor.getBoundingClientRect();
    setEmojiPickerTarget({
      messageId,
      position: {
        x: rect.left,
        y: placement === 'bottom' ? rect.bottom + 8 : rect.top,
      },
    });
  }, []);

  const openEmojiPickerAtPosition = useCallback((
    messageId: string,
    position: { x: number; y: number },
  ) => {
    setEmojiPickerTarget({ messageId, position });
  }, []);

  const closeEmojiPicker = useCallback(() => {
    setEmojiPickerTarget(null);
  }, []);

  const handleEmojiSelect = useCallback((emoji: string) => {
    if (emojiPickerTarget && userId) {
      onToggleReaction(emojiPickerTarget.messageId, emoji);
    }
    setEmojiPickerTarget(null);
  }, [emojiPickerTarget, onToggleReaction, userId]);

  const handleCopyMessageText = useCallback(async (content?: string) => {
    if (!content || content === '[encrypted]' || content === '[deleted]') return;

    try {
      await navigator.clipboard.writeText(content);
    } catch (error) {
      console.error('Failed to copy message text:', error);
    }
  }, []);

  const openImageViewer = useCallback((urls: string[], index: number) => {
    setImageViewer({ urls, index });
  }, []);

  return {
    contextMenu,
    emojiPickerTarget,
    selectedProfileId,
    selectedFriend,
    imageViewer,
    setContextMenu,
    setSelectedProfileId,
    setSelectedFriend,
    handleContextMenu,
    handleProfileClick,
    openEmojiPicker,
    openEmojiPickerAtPosition,
    closeEmojiPicker,
    handleEmojiSelect,
    handleCopyMessageText,
    openImageViewer,
    closeImageViewer,
    showPreviousImage,
    showNextImage,
    selectImageIndex,
  };
}
