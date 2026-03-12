// src/components/Chat/MessageView.tsx

import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Virtuoso, VirtuosoHandle, ListRange, type ScrollSeekPlaceholderProps } from 'react-virtuoso';
import { Pencil, Trash2, Reply, CornerUpRight, Smile, Image, ArrowDown, X, Download, ChevronLeft, ChevronRight, Copy, Forward } from 'lucide-react';
import { useMessageList } from '../../Services/hooks/Chats/useMessageList';
import { useMessageDisplay } from '../../Services/hooks/Chats/useMessageDisplay';
import { useReactions } from '../../Services/hooks/Chats/useReactions';
import { Message, Conversation, ConversationMember, parseAttachments } from '../../Services/Chat/chatService';
import { useUser } from '../../Services/Auth/UserContext';
import { useFriends, Friend } from '../../Services/hooks/Friends/useFriends';
import { useUserProfile } from '../../Services/hooks/editProfile/userProfile';
import { useTheme, Density } from '../../Services/hooks/Settings/useTheme';
import FriendProfile from '../common/Friends/FriendProfile';
import UserProfile from '../common/Profile/userProfile';
import EmojiPicker from './EmojiPicker';
import ReactionBar from './ReactionBar';
import BlurImage from '../common/BlurImage';
import { MessageViewSkeleton, Skeleton } from '../common/Skeleton';

const DENSITY: Record<Density, {
  consecutiveGap: number;
  bubblePadding: string;
  maxWidth: string;
  timestampAlways: boolean;
}> = {
  compact: {
    consecutiveGap: 2,
    bubblePadding: 'px-3 py-1.5',
    maxWidth: 'max-w-[85%]',
    timestampAlways: false,
  },
  comfortable: {
    consecutiveGap: 6,
    bubblePadding: 'px-4 py-2.5',
    maxWidth: 'max-w-[70%]',
    timestampAlways: true,
  },
};

const AVATAR_OFFSET = 'pl-10';
const GROUP_TIME_WINDOW_MS = 5 * 60 * 1000;

const isSameDay = (a: string, b: string) => {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
};

interface MessageViewProps {
  conversation: Conversation;
  encryptionKey: CryptoKey | null;
  keyVersion?: number;
  encryptionError?: string | null;
  members: Record<string, ConversationMember>;
  onReply?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  newMessage?: Message | null;
  userAvatar?: string;
  gateway?: any;
  messageUpdate?: { message_id: string; content: string; is_edited: boolean; edited_at: string } | null;
  messageDelete?: { message_id: string } | null;
}

const MessageView = ({
  conversation,
  encryptionKey,
  keyVersion,
  encryptionError,
  members,
  onReply,
  onEdit,
  newMessage,
  userAvatar,
  gateway,
  messageUpdate,
  messageDelete,
}: MessageViewProps) => {
  const { user } = useUser();
  const { density, messageGroupSpacing, chatFontScale } = useTheme();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ msg: Message; x: number; y: number } | null>(null);
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<{ messageId: string; position: { x: number; y: number } } | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);
  const [imageViewer, setImageViewer] = useState<{ urls: string[]; index: number } | null>(null);

  useEffect(() => {
    if (!imageViewer) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setImageViewer(null);
      if (e.key === 'ArrowLeft') setImageViewer(v => v && v.index > 0 ? { ...v, index: v.index - 1 } : v);
      if (e.key === 'ArrowRight') setImageViewer(v => v && v.index < v.urls.length - 1 ? { ...v, index: v.index + 1 } : v);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [imageViewer]);

  const { friends } = useFriends();
  const { profile: myProfile } = useUserProfile(user?.profile_id || '');
  const { getMessageReactions, handleToggleReaction, initReactionsFromMessages } = useReactions(conversation.id, gateway, user?.id);

  const {
    messages,
    loading,
    loadingOlder,
    prefetchingOlder,
    loadingNewer,
    hasOlder,
    hasNewer,
    isAtPresent,
    firstItemIndex,
    groupBreakBeforeIds,
    setIsAtPresent,
    handleDelete,
    getReplyParent,
    jumpToPresent,
    loadOlder,
    loadNewer,
  } = useMessageList(
    conversation,
    user?.id,
    encryptionKey,
    keyVersion,
    newMessage,
    messageUpdate,
    messageDelete,
    initReactionsFromMessages
  );

  const { formatTime, getSenderName, getSenderAvatarUrl } = useMessageDisplay(members, userAvatar);

  const visualMessages = useMemo(() => messages, [messages]);
  const atBottomRef = useRef(true);
  const canLoadOlderRef = useRef(false);
  const lastOlderTriggerMessageIdRef = useRef<string | null>(null);
  const lastRangeStartIndexRef = useRef<number | null>(null);
  const pendingStartReachedRef = useRef(false);
  const topLoadLockedRef = useRef(false);
  const scrollSeekActiveRef = useRef(false);
  const layoutCacheRef = useRef<Record<string, { startsGroup: boolean; showDateSeparator: boolean }>>({});
  const scrollerRef = useRef<HTMLElement | null>(null);
  const keepPinnedOnOpenRef = useRef(true);
  const forceFollowOutputRef = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasUnseenMessages, setHasUnseenMessages] = useState(false);
  const [scrollSeekExitTick, setScrollSeekExitTick] = useState(0);
  const topRenderBufferPx = 240;
  const bottomRenderBufferPx = 200;
  const scrollOverscanPx = 240;

  const handleScrollerRef = useCallback((element: HTMLElement | null | Window) => {
    if (element instanceof HTMLElement) {
      element.style.overflowAnchor = 'none';
      scrollerRef.current = element;
      return;
    }

    scrollerRef.current = null;
  }, []);

  useLayoutEffect(() => {
    canLoadOlderRef.current = false;
    lastOlderTriggerMessageIdRef.current = null;
    lastRangeStartIndexRef.current = null;
    pendingStartReachedRef.current = false;
    topLoadLockedRef.current = false;
    scrollSeekActiveRef.current = false;
    layoutCacheRef.current = {};
    keepPinnedOnOpenRef.current = true;
    forceFollowOutputRef.current = false;
  }, [conversation.id]);

  useEffect(() => {
    if (!newMessage) return;
    if (String(newMessage.conversation_id || conversation.id) !== String(conversation.id)) {
      return;
    }
    if (newMessage.sender_id === user?.id) {
      forceFollowOutputRef.current = true;
      return;
    }
    if (!atBottomRef.current) {
      setHasUnseenMessages(true);
    }
  }, [conversation.id, newMessage, user?.id]);

  const handleJumpToPresent = useCallback(async () => {
    forceFollowOutputRef.current = true;
    keepPinnedOnOpenRef.current = true;
    await jumpToPresent();
    setHasUnseenMessages(false);
    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: 'LAST',
        align: 'end',
        behavior: 'smooth',
      });
    });
  }, [jumpToPresent]);

  const triggerOlderLoad = useCallback(() => {
    if (prefetchingOlder) {
      pendingStartReachedRef.current = true;
      return;
    }

    if (loadingOlder || !hasOlder || topLoadLockedRef.current) {
      return;
    }

    const oldestVisibleMessageId = visualMessages[0]?.message_id ?? null;
    if (oldestVisibleMessageId && lastOlderTriggerMessageIdRef.current === oldestVisibleMessageId) {
      return;
    }

    lastOlderTriggerMessageIdRef.current = oldestVisibleMessageId;
    pendingStartReachedRef.current = false;
    topLoadLockedRef.current = true;
    void loadOlder();
  }, [hasOlder, loadOlder, loadingOlder, prefetchingOlder, visualMessages]);

  const handleStartReached = useCallback(() => {
    if (!canLoadOlderRef.current || scrollSeekActiveRef.current || prefetchingOlder) {
      pendingStartReachedRef.current = true;
      return;
    }

    triggerOlderLoad();
  }, [prefetchingOlder, triggerOlderLoad]);

  const handleRangeChanged = useCallback((range: ListRange) => {
    const previousStartIndex = lastRangeStartIndexRef.current;
    lastRangeStartIndexRef.current = range.startIndex;

    if (previousStartIndex !== null && range.startIndex < previousStartIndex) {
      canLoadOlderRef.current = true;
      keepPinnedOnOpenRef.current = false;
    }

    const relativeStartIndex = range.startIndex - firstItemIndex;

    if (relativeStartIndex > 6) {
      topLoadLockedRef.current = false;
    }

    if (
      pendingStartReachedRef.current &&
      canLoadOlderRef.current &&
      !scrollSeekActiveRef.current &&
      !prefetchingOlder &&
      relativeStartIndex <= 1
    ) {
      triggerOlderLoad();
    }
  }, [firstItemIndex, prefetchingOlder, triggerOlderLoad]);

  const scrollSeekConfiguration = useMemo(() => ({
    enter: (velocity: number) => {
      const shouldEnter = Math.abs(velocity) > 1400;
      if (shouldEnter) {
        scrollSeekActiveRef.current = true;
      }
      return shouldEnter;
    },
    exit: (velocity: number) => {
      const shouldExit = Math.abs(velocity) < 120;
      if (shouldExit && scrollSeekActiveRef.current) {
        scrollSeekActiveRef.current = false;
        setScrollSeekExitTick((prev) => prev + 1);
      }
      return shouldExit;
    },
  }), []);

  useEffect(() => {
    const relativeStartIndex =
      lastRangeStartIndexRef.current === null
        ? null
        : lastRangeStartIndexRef.current - firstItemIndex;

    if (
      !scrollSeekActiveRef.current &&
      pendingStartReachedRef.current &&
      canLoadOlderRef.current &&
      !prefetchingOlder &&
      relativeStartIndex !== null &&
      relativeStartIndex <= 1
    ) {
      triggerOlderLoad();
    }
  }, [firstItemIndex, prefetchingOlder, scrollSeekExitTick, triggerOlderLoad]);

  const renderScrollSeekPlaceholder = useCallback(({ height, index }: ScrollSeekPlaceholderProps) => {
    const isRightAligned = density === 'comfortable' && index % 4 === 1;
    const showAvatar = !isRightAligned && index % 3 !== 0;
    const bubbleWidths =
      density === 'comfortable'
        ? ['w-36', 'w-44', 'w-56', 'w-40']
        : ['w-32', 'w-40', 'w-52', 'w-36'];
    const bubbleWidth = bubbleWidths[index % bubbleWidths.length];

    return (
      <div style={{ height }} className="px-2 overflow-hidden">
        <div className={`flex h-full items-center ${isRightAligned ? 'justify-end' : 'justify-start'}`}>
          <div className={`flex items-center gap-2 ${isRightAligned ? 'flex-row-reverse max-w-[70%]' : 'max-w-[85%]'}`}>
            {showAvatar ? (
              <Skeleton className="w-8 h-8" rounded="full" />
            ) : (
              !isRightAligned && <div className="w-8 shrink-0" />
            )}
            <div className={`flex flex-col gap-1 ${isRightAligned ? 'items-end' : 'items-start'}`}>
              <Skeleton className="h-3 w-20" />
              <Skeleton className={`h-8 ${bubbleWidth}`} rounded="2xl" />
            </div>
          </div>
        </div>
      </div>
    );
  }, [density]);

  const renderPaginationSkeleton = useCallback((position: 'top' | 'bottom') => {
    const isBottom = position === 'bottom';

    return (
      <div className={`pointer-events-none absolute inset-x-0 z-[5] px-4 ${isBottom ? 'bottom-3' : 'top-3'}`}>
        <div className={`flex ${isBottom ? 'justify-end' : 'justify-start'} opacity-95`}>
          <div className="rounded-2xl bg-void-bg-main/70 p-3 backdrop-blur-sm">
            <div className={`flex items-start gap-2 ${isBottom ? 'flex-row-reverse' : 'flex-row'}`}>
              {!isBottom && <Skeleton className="w-8 h-8" rounded="full" />}
              <div className={`flex flex-col gap-2 ${isBottom ? 'items-end' : 'items-start'}`}>
                <Skeleton className="h-3 w-20" />
                <Skeleton className={`h-8 ${isBottom ? 'w-36' : 'w-44'}`} rounded="2xl" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }, []);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    document.addEventListener('click', closeMenu);
    document.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('scroll', closeMenu, true);
    };
  }, []);

  const handleContextMenu = (e: React.MouseEvent, msg: Message) => {
    e.preventDefault();
    let x = e.clientX;
    let y = e.clientY;
    if (window.innerWidth - x < 200) x -= 180;
    if (window.innerHeight - y < 200) y -= 150;
    setContextMenu({ msg, x, y });
  };

  const getSmartDisplayName = useCallback((senderId: string) => {
    if (senderId === user?.id) {
      return myProfile?.display_name;
    }
    const friend = friends.find(f => f.id === senderId);
    if (friend && friend.display_name) {
      return friend.display_name;
    }
    return getSenderName(senderId);
  }, [user, myProfile, friends, getSenderName]);

  const handleProfileClick = useCallback((senderId: string) => {
    if (senderId === user?.id && user?.profile_id) {
      setSelectedProfileId(user.profile_id);
      return;
    }
    const friend = friends.find(f => f.id === senderId);
    if (friend) {
      setSelectedFriend(friend);
      return;
    }
    const member = members[senderId];
    if (member && (member as any).profile_id) {
      setSelectedProfileId((member as any).profile_id);
      return;
    }
    setSelectedProfileId(senderId);
  }, [user, friends, members]);

  const openEmojiPicker = useCallback((messageId: string, event: React.MouseEvent) => {
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    setEmojiPickerTarget({
      messageId,
      position: { x: rect.left, y: rect.top },
    });
  }, []);

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      if (emojiPickerTarget && user?.id) {
        handleToggleReaction(emojiPickerTarget.messageId, emoji);
      }
      setEmojiPickerTarget(null);
    },
    [emojiPickerTarget, user?.id, handleToggleReaction]
  );

  const handleCopyMessageText = useCallback(async (content?: string) => {
    if (!content || content === '[encrypted]' || content === '[deleted]') return;

    try {
      await navigator.clipboard.writeText(content);
    } catch (error) {
      console.error('Failed to copy message text:', error);
    }
  }, []);

  const dmIntroFriend = useMemo(() => {
    if (conversation.type !== 'dm') return null;
    return friends.find((friend) =>
      friend.id === conversation.dm_user_id ||
      friend.username === conversation.dm_username
    ) || null;
  }, [conversation.dm_user_id, conversation.dm_username, conversation.type, friends]);

  const dmIntroMember = useMemo(() => {
    if (conversation.type !== 'dm' || !user?.id) return null;
    return Object.values(members).find((member) => member.user_id !== user.id) || null;
  }, [conversation.type, members, user?.id]);

  const conversationStartLabel =
    conversation.type === 'dm'
      ? conversation.dm_display_name ||
        dmIntroMember?.display_name ||
        dmIntroFriend?.display_name ||
        conversation.dm_username ||
        dmIntroMember?.username ||
        dmIntroFriend?.username ||
        'Direct message'
      : conversation.name || 'this conversation';
  const conversationStartAvatar =
    conversation.dm_avatar_url || dmIntroMember?.avatar_url || dmIntroFriend?.avatar_url || null;
  const conversationStartUsername =
    conversation.type === 'dm'
      ? conversation.dm_username || dmIntroMember?.username || dmIntroFriend?.username || null
      : null;
  const conversationStartUserId =
    conversation.dm_user_id || dmIntroMember?.user_id || dmIntroFriend?.id || null;
  const friendsSinceLabel = dmIntroFriend?.friends_since
    ? new Date(dmIntroFriend.friends_since).toLocaleDateString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;

  if (loading || !encryptionKey) return <MessageViewSkeleton density={density} />;

  if (encryptionError) return (
    <div className="flex-1 flex items-center justify-center text-red-400 p-4 text-center">
      <p>Encryption Error: {encryptionError}</p>
    </div>
  );

  const getDateLabel = (dateStr: string) => {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const isSameDayD = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (isSameDayD(date, today)) return 'Today';
    if (isSameDayD(date, yesterday)) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  };

  const metaFontSize = Math.max(10, chatFontScale - 4);
  const replyFontSize = Math.max(11, chatFontScale - 2);
  const bubbleFontSize = chatFontScale;
  const encryptedFontSize = Math.max(10, chatFontScale - 3);

  // ============== Virtuoso itemContent ==============
  const renderMessage = (index: number, msg: Message) => {
    const listIndex = Math.max(0, index - firstItemIndex);
    const d = DENSITY[density];
    const isOwn = msg.sender_id === user?.id;
    const isRightAligned = isOwn && density === 'comfortable';
    let traits = layoutCacheRef.current[msg.message_id];

    if (!traits) {
      const prev = listIndex > 0 ? visualMessages[listIndex - 1] : null;
      const hasUnknownPreviousContext = listIndex === 0 && hasOlder;
      const hasPaginationBreak = groupBreakBeforeIds.has(msg.message_id);
      const showDateSeparator =
        (!prev && !hasUnknownPreviousContext) ||
        (!!prev && !isSameDay(msg.created_at, prev.created_at));
      const timeDiff = prev ? new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() : 0;
      const startsGroup =
        hasUnknownPreviousContext ||
        hasPaginationBreak ||
        !!msg.reply_to ||
        (!prev && !hasUnknownPreviousContext) ||
        (!!prev && (
          prev.sender_id !== msg.sender_id ||
          prev.message_type !== msg.message_type ||
          showDateSeparator ||
          timeDiff >= GROUP_TIME_WINDOW_MS
        ));

      traits = { startsGroup, showDateSeparator };
      layoutCacheRef.current[msg.message_id] = traits;
    }

    const { startsGroup, showDateSeparator } = traits;
    const showAvatar = startsGroup && (density === 'compact' ? true : !isOwn);
    const leftIndent = !isRightAligned && showAvatar ? AVATAR_OFFSET : '';
    const rowIndent = !isRightAligned && !showAvatar ? AVATAR_OFFSET : '';
    const replyParent = msg.reply_to ? getReplyParent(msg.reply_to) : null;
    const msgReactions = getMessageReactions(msg.message_id, msg.reactions);

    return (
      <div
        className="px-2"
        style={{ paddingTop: `${startsGroup ? messageGroupSpacing : d.consecutiveGap}px` }}
      >
        {showDateSeparator && (
          <div className="flex items-center gap-3 py-4">
            <div className="flex-1 h-px bg-void-bg-hover" />
            <span className="text-void-text-muted font-medium shrink-0" style={{ fontSize: `${metaFontSize}px` }}>
              {getDateLabel(msg.created_at)}
            </span>
            <div className="flex-1 h-px bg-void-bg-hover" />
          </div>
        )}

        {startsGroup && (
          <div
            className={`flex items-center gap-2 pb-0.5 px-1 ${isRightAligned ? 'justify-end' : leftIndent}`}
            style={{ fontSize: `${metaFontSize}px` }}
          >
            {isRightAligned ? (
              <>
                <span className="text-void-text-muted">{formatTime(msg.created_at)}</span>
                <span
                  className="font-semibold text-void-accent cursor-pointer hover:underline"
                  onClick={() => handleProfileClick(msg.sender_id)}
                >
                  {getSmartDisplayName(msg.sender_id)}
                </span>
              </>
            ) : (
              <>
                <span
                  className="font-semibold text-void-accent cursor-pointer hover:underline"
                  onClick={() => handleProfileClick(msg.sender_id)}
                >
                  {getSmartDisplayName(msg.sender_id)}
                </span>
                <span className="text-void-text-muted">{formatTime(msg.created_at)}</span>
              </>
            )}
          </div>
        )}

        <div
          onMouseEnter={() => setHoveredId(msg.message_id)}
          onMouseLeave={() => setHoveredId(null)}
          onContextMenu={(e) => handleContextMenu(e, msg)}
          className={`relative flex ${isRightAligned ? 'flex-row-reverse' : 'flex-row'} items-end gap-2 max-w-full group/msg ${rowIndent}`}
        >
          {showAvatar && (
            <div
              className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 bg-void-bg-hover cursor-pointer hover:opacity-80 transition-opacity self-start"
              onClick={() => handleProfileClick(msg.sender_id)}
            >
              <img
                src={getSenderAvatarUrl(msg.sender_id)}
                alt="avatar"
                width={32}
                height={32}
                className="w-full h-full object-cover"
              />
            </div>
          )}

          <div className={`flex flex-col ${isRightAligned ? 'items-end' : 'items-start'} ${d.maxWidth} min-w-0`}>
            {msg.reply_to && (
              <div className={`pb-0.5 ${isRightAligned ? 'text-right' : 'text-left'}`}>
                <div
                  className="inline-flex items-center gap-1.5 text-void-text-muted cursor-pointer hover:text-void-text transition-colors"
                  style={{ fontSize: `${replyFontSize}px` }}
                >
                  <CornerUpRight className="w-3 h-3 flex-shrink-0" />
                  {replyParent ? (
                    <>
                      <span className="font-semibold text-void-accent/70">{getSmartDisplayName(replyParent.sender_id)}</span>
                      {(() => {
                        const hasRealContent = replyParent.content && replyParent.content !== '[encrypted]' && replyParent.content !== '[deleted]';
                        if (replyParent.is_deleted) return <span className="italic opacity-60">[deleted]</span>;
                        if (!hasRealContent && replyParent.attachments?.length) {
                          return (
                            <span className="flex items-center gap-1.5">
                              <Image className="w-4 h-4 flex-shrink-0" />
                              <span className="italic text-void-text-muted/70 cursor-not-allowed select-none">
                                Click to see attachment
                              </span>
                            </span>
                          );
                        }
                        if (hasRealContent) {
                          return (
                            <span className="truncate max-w-[220px]">
                              {replyParent.content!.substring(0, 60) + (replyParent.content!.length > 60 ? '...' : '')}
                            </span>
                          );
                        }
                        return <span className="italic opacity-60">Message unavailable</span>;
                      })()}
                    </>
                  ) : (
                    <span className="italic">Loading reply...</span>
                  )}
                </div>
              </div>
            )}

            {msg.is_deleted ? (
              <div
                className={`${d.bubblePadding} rounded-2xl italic text-void-text-muted bg-void-bg-hover/50`}
                style={{ fontSize: `${bubbleFontSize}px` }}
              >
                [deleted]
              </div>
            ) : (() => {
              const hasRealContent = msg.content && msg.content !== '[encrypted]';
              if (!hasRealContent && msg.attachments?.length) return null;
              return (
                <div
                  className={`${d.bubblePadding} rounded-2xl whitespace-pre-wrap break-words ${
                  isRightAligned
                    ? 'rounded-br-sm bg-void-accent text-white'
                    : isOwn
                      ? 'rounded-bl-sm bg-void-accent text-white'
                      : 'rounded-bl-sm bg-void-bg-hover text-void-text'
                }`}
                  style={{ fontSize: `${bubbleFontSize}px` }}
                >
                  {hasRealContent ? msg.content : <span className="italic opacity-50" style={{ fontSize: `${encryptedFontSize}px` }}>encrypted</span>}
                  {msg.is_edited && <span className="text-[10px] opacity-60 ml-1.5">(edited)</span>}
                </div>
              );
            })()}

            {!msg.is_deleted && msg.attachments && msg.attachments.length > 0 && (() => {
              const parsed = parseAttachments(msg.attachments);
              const rawUrls = parsed.map(a => a.url);
              return (
                <div className={`pt-1 grid gap-1 ${
                  parsed.length === 1 ? 'grid-cols-1' :
                  parsed.length === 2 ? 'grid-cols-2' :
                  'grid-cols-3'
                } max-w-xs`}>
                  {parsed.map((attachment, i) => (
                    <button
                      key={i}
                      onClick={() => setImageViewer({ urls: rawUrls, index: i })}
                      className="block rounded-xl overflow-hidden bg-void-bg-hover focus:outline-none aspect-square"
                    >
                      <BlurImage
                        src={attachment.url}
                        blurhash={attachment.blurhash}
                        alt="attachment"
                        className="w-full h-full object-cover hover:opacity-90"
                      />
                    </button>
                  ))}
                </div>
              );
            })()}

            {!msg.is_deleted && Object.keys(msgReactions).length > 0 && (
              <div className="pt-1">
                <ReactionBar
                  reactions={msgReactions}
                  currentUserId={user?.id || ''}
                  onToggle={(emoji) => handleToggleReaction(msg.message_id, emoji)}
                  onAddReaction={() => {
                    const el = document.querySelector(`[data-msg-id="${msg.message_id}"]`);
                    if (el) {
                      const rect = el.getBoundingClientRect();
                      setEmojiPickerTarget({
                        messageId: msg.message_id,
                        position: { x: rect.left, y: rect.bottom + 8 },
                      });
                    }
                  }}
                />
              </div>
            )}
          </div>

          {hoveredId === msg.message_id && !msg.is_deleted && (
            <div
              data-msg-id={msg.message_id}
              className="flex items-center gap-0.5 bg-void-bg-main border border-void-bg-hover rounded-md p-0.5 shadow-lg shrink-0 opacity-0 group-hover/msg:opacity-100 transition-opacity"
            >
              <button onClick={(e) => openEmojiPicker(msg.message_id, e)} className="p-1 hover:bg-void-bg-hover rounded text-void-text-muted hover:text-void-text" title="React">
                <Smile className="w-3.5 h-3.5" />
              </button>
              {onReply && (
                <button onClick={() => onReply(msg)} className="p-1 hover:bg-void-bg-hover rounded text-void-text-muted hover:text-void-text">
                  <Reply className="w-3.5 h-3.5" />
                </button>
              )}
              {isOwn && onEdit && (
                <button onClick={() => onEdit(msg)} className="p-1 hover:bg-void-bg-hover rounded text-void-text-muted hover:text-void-text">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}
              {isOwn && (
                <button onClick={() => handleDelete(msg.message_id)} className="p-1 hover:bg-void-bg-hover rounded text-void-text-muted hover:text-red-400">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      <Virtuoso
        key={conversation.id}
        ref={virtuosoRef}
        scrollerRef={handleScrollerRef}
        className="flex-1 min-h-0"
        data={visualMessages}
        computeItemKey={(_index, msg) => msg.message_id}
        firstItemIndex={firstItemIndex}
        atBottomThreshold={12}
        alignToBottom
        increaseViewportBy={{ top: topRenderBufferPx, bottom: bottomRenderBufferPx }}
        minOverscanItemCount={{ top: 8, bottom: 4 }}
        scrollSeekConfiguration={scrollSeekConfiguration}
        startReached={handleStartReached}
        rangeChanged={handleRangeChanged}
        followOutput={(isAtBottom) => {
          if (loadingOlder) {
            return false;
          }
          if (forceFollowOutputRef.current) {
            return 'auto';
          }
          if (keepPinnedOnOpenRef.current || isAtBottom) {
            return 'auto';
          }
          return false;
        }}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        atBottomStateChange={(isAtBottom) => {
          atBottomRef.current = isAtBottom;
          setIsAtBottom(isAtBottom);
          if (isAtBottom) {
            setHasUnseenMessages(false);
            forceFollowOutputRef.current = false;
          }
          setIsAtPresent(isAtBottom && !hasNewer);
        }}
        endReached={() => {
          if (!isAtPresent && hasNewer) loadNewer();
        }}
        overscan={scrollOverscanPx}
        itemContent={renderMessage}
        components={{
          ScrollSeekPlaceholder: renderScrollSeekPlaceholder,
          Header: () => {
            if (hasOlder) return null;

            return (
              <div className="px-4 pt-8 pb-6">
                {conversation.type === 'dm' ? (
                  <div className="max-w-2xl px-5 py-5">
                    <div className="flex items-start gap-4">
                      <button
                        type="button"
                        onClick={() => {
                          if (conversationStartUserId) {
                            handleProfileClick(conversationStartUserId);
                          }
                        }}
                        disabled={!conversationStartUserId}
                        className="shrink-0 disabled:cursor-default"
                      >
                        {conversationStartAvatar ? (
                          <img
                            src={conversationStartAvatar}
                            alt=""
                            width={72}
                            height={72}
                            className="h-[72px] w-[72px] rounded-full object-cover"
                          />
                        ) : (
                          <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-void-bg-hover text-2xl font-bold text-void-text">
                            {conversationStartLabel.charAt(0).toUpperCase()}
                          </div>
                        )}
                      </button>

                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => {
                            if (conversationStartUserId) {
                              handleProfileClick(conversationStartUserId);
                            }
                          }}
                          disabled={!conversationStartUserId}
                          className="max-w-full text-left disabled:cursor-default"
                        >
                          <div className="truncate text-3xl font-bold leading-tight text-void-text">
                            {conversationStartLabel}
                          </div>
                          {conversationStartUsername && conversationStartUsername !== conversationStartLabel && (
                            <div className="mt-1 truncate text-xl font-medium text-void-text-muted">
                              {conversationStartUsername}
                            </div>
                          )}
                        </button>

                        <p className="mt-4 text-sm text-void-text-muted">
                          This is the beginning of your direct message history with{' '}
                          <span className="font-semibold text-void-text">{conversationStartLabel}</span>.
                        </p>

                        {friendsSinceLabel && (
                          <div className="mt-4 inline-flex items-center rounded-full border border-void-bg-hover bg-void-bg-hover/50 px-3 py-1 text-xs text-void-text-muted">
                            Friends since {friendsSinceLabel}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="max-w-lg px-4 py-3 text-center">
                    <p className="text-sm text-void-text-muted">
                      This is the beginning of {conversationStartLabel}.
                    </p>
                  </div>
                )}
              </div>
            );
          },
          Footer: () => null,
          EmptyPlaceholder: () => (
            <p className="text-center text-void-text-muted text-sm py-8">
              No messages yet. Say something!
            </p>
          ),
        }}
      />

      {loadingOlder && renderPaginationSkeleton('top')}
      {loadingNewer && renderPaginationSkeleton('bottom')}

      {/* Jump to Present */}
      {!isAtBottom && (hasNewer || hasUnseenMessages) && (
        <button
          onClick={handleJumpToPresent}
          className="fixed bottom-20 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-4 py-2 bg-void-accent hover:bg-void-accent-hover text-white text-xs font-bold rounded-full shadow-lg transition-all z-10"
        >
          <ArrowDown className="w-3.5 h-3.5" />
          Jump to Present
        </button>
      )}

      {/* Emoji picker */}
      {emojiPickerTarget && (
        <EmojiPicker
          onSelect={handleEmojiSelect}
          onClose={() => setEmojiPickerTarget(null)}
          position={emojiPickerTarget.position}
        />
      )}

      {/* Context menu — Portal */}
      {contextMenu && !contextMenu.msg.is_deleted && createPortal(
        <div
          className="fixed z-[70] w-48 bg-void-bg-main border border-void-bg-hover rounded-lg shadow-2xl py-1.5 overflow-hidden flex flex-col"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            onClick={() => {
              setEmojiPickerTarget({
                messageId: contextMenu.msg.message_id,
                position: { x: contextMenu.x, y: contextMenu.y },
              });
              setContextMenu(null);
            }}
            className="w-full text-left px-3 py-2 text-sm text-void-text hover:bg-void-accent hover:text-white flex items-center gap-2 transition-colors"
          >
            <Smile className="w-4 h-4" />
            Add Reaction
          </button>
          <button
            onClick={async () => {
              await handleCopyMessageText(contextMenu.msg.content);
              setContextMenu(null);
            }}
            className="w-full text-left px-3 py-2 text-sm text-void-text hover:bg-void-accent hover:text-white flex items-center gap-2 transition-colors"
          >
            <Copy className="w-4 h-4" />
            Copy Text
          </button>
          {onReply && (
            <button
              onClick={() => {
                onReply(contextMenu.msg);
                setContextMenu(null);
              }}
              className="w-full text-left px-3 py-2 text-sm text-void-text hover:bg-void-accent hover:text-white flex items-center gap-2 transition-colors"
            >
              <Reply className="w-4 h-4" />
              Reply
            </button>
          )}
          <button
            disabled
            className="w-full text-left px-3 py-2 text-sm text-void-text-muted/60 flex items-center gap-2 cursor-not-allowed"
          >
            <Forward className="w-4 h-4" />
            Forward Message
          </button>
          {contextMenu.msg.sender_id === user?.id && (
            <>
              <div className="h-px w-full bg-void-bg-hover my-1" />
              {onEdit && (
                <button
                  onClick={() => {
                    onEdit(contextMenu.msg);
                    setContextMenu(null);
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-void-text hover:bg-void-accent hover:text-white flex items-center gap-2 transition-colors"
                >
                  <Pencil className="w-4 h-4" />
                  Edit Message
                </button>
              )}
              <button
                onClick={() => {
                  handleDelete(contextMenu.msg.message_id);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-red-500 hover:text-white flex items-center gap-2 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                Delete Message
              </button>
            </>
          )}
        </div>,
        document.body
      )}

      {/* Profiles */}
      {selectedProfileId && (
        <UserProfile profileId={selectedProfileId} onClose={() => setSelectedProfileId(null)} />
      )}
      {selectedFriend && (
        <FriendProfile friend={selectedFriend} onClose={() => setSelectedFriend(null)} />
      )}

      {/* Image Viewer — Portal */}
      {imageViewer && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-sm"
          onClick={() => setImageViewer(null)}
        >
          {/* Toolbar */}
          <div className="absolute top-4 right-4 flex items-center gap-2 z-10" onClick={(e) => e.stopPropagation()}>
            <a
              href={imageViewer.urls[imageViewer.index]}
              download
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
              title="Download"
            >
              <Download className="w-5 h-5" />
            </a>
            <button
              onClick={() => setImageViewer(null)}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Prev */}
          {imageViewer.index > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setImageViewer(v => v ? { ...v, index: v.index - 1 } : v); }}
              className="absolute left-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          )}

          {/* Image */}
          <img
            src={imageViewer.urls[imageViewer.index]}
            alt="attachment"
            className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />

          {/* Next */}
          {imageViewer.index < imageViewer.urls.length - 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); setImageViewer(v => v ? { ...v, index: v.index + 1 } : v); }}
              className="absolute right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          )}

          {/* Dot indicators */}
          {imageViewer.urls.length > 1 && (
            <div className="absolute bottom-4 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              {imageViewer.urls.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setImageViewer(v => v ? { ...v, index: i } : v)}
                  className={`w-2 h-2 rounded-full transition-all ${i === imageViewer.index ? 'bg-white scale-125' : 'bg-white/40 hover:bg-white/70'}`}
                />
              ))}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
};

export default MessageView;
