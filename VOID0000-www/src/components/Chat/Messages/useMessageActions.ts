import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message, ConversationMember } from '../../../Services/Chat/chatService';
import type { Friend } from '../../../Services/hooks/Friends/useFriends';

export interface ContextMenuState {
  msg: Message;
  x: number;
  y: number;
  mode?: 'full' | 'reactions';
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
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const userProfileIdRef = useRef(userProfileId);
  userProfileIdRef.current = userProfileId;
  const friendsRef = useRef(friends);
  friendsRef.current = friends;
  const membersRef = useRef(members);
  membersRef.current = members;

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

  const positionContextMenu = useCallback((
    position: { x: number; y: number },
    mode: 'full' | 'reactions',
  ) => {
    const viewportPadding = 8;

    if (mode === 'reactions') {
      const estimatedWidth = 316;
      const estimatedHeight = 52;

      let x = position.x - estimatedWidth / 2;
      let y = position.y - estimatedHeight;

      x = Math.max(viewportPadding, Math.min(x, window.innerWidth - estimatedWidth - viewportPadding));
      y = Math.max(viewportPadding, Math.min(y, window.innerHeight - estimatedHeight - viewportPadding));

      return { x, y };
    }

    const estimatedWidth = 344;
    const estimatedHeight = 356;
    let x = position.x;
    let y = position.y;

    if (x + estimatedWidth > window.innerWidth - viewportPadding) {
      x = window.innerWidth - estimatedWidth - viewportPadding;
    }

    if (y + estimatedHeight > window.innerHeight - viewportPadding) {
      y = window.innerHeight - estimatedHeight - viewportPadding;
    }

    x = Math.max(viewportPadding, x);
    y = Math.max(viewportPadding, y);

    return { x, y };
  }, []);

  const handleContextMenu = useCallback((event: React.MouseEvent, msg: Message) => {
    event.preventDefault();
    const { x, y } = positionContextMenu({
      x: event.clientX,
      y: event.clientY,
    }, 'full');
    setContextMenu({ msg, x, y, mode: 'full' });
  }, [positionContextMenu]);

  const openContextMenuAtPosition = useCallback((
    msg: Message,
    position: { x: number; y: number },
    mode: 'full' | 'reactions' = 'full',
  ) => {
    const { x, y } = positionContextMenu(position, mode);
    setContextMenu({ msg, x, y, mode });
  }, [positionContextMenu]);

  const blurActiveTextInput = useCallback(() => {
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      (activeElement.tagName === 'TEXTAREA' ||
        activeElement.tagName === 'INPUT' ||
        activeElement.isContentEditable)
    ) {
      activeElement.blur();
    }
  }, []);

  const handleProfileClick = useCallback((senderId: string) => {
    if (senderId === userIdRef.current && userProfileIdRef.current) {
      setSelectedProfileId(userProfileIdRef.current);
      return;
    }

    const friend = friendsRef.current.find((entry) => entry.id === senderId);
    if (friend) {
      setSelectedFriend(friend);
      return;
    }

    const member = membersRef.current[senderId];
    if (member?.profile_id) {
      setSelectedProfileId(member.profile_id);
      return;
    }

    setSelectedProfileId(senderId);
  }, []);

  const openEmojiPicker = useCallback((
    messageId: string,
    anchor: HTMLElement,
    placement: 'top' | 'bottom' = 'top',
  ) => {
    blurActiveTextInput();
    const rect = anchor.getBoundingClientRect();
    setEmojiPickerTarget({
      messageId,
      position: {
        x: rect.left,
        y: placement === 'bottom' ? rect.bottom + 8 : rect.top,
      },
    });
  }, [blurActiveTextInput]);

  const openEmojiPickerAtPosition = useCallback((
    messageId: string,
    position: { x: number; y: number },
  ) => {
    blurActiveTextInput();
    setEmojiPickerTarget({ messageId, position });
  }, [blurActiveTextInput]);

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
    openContextMenuAtPosition,
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
