// src/components/Chat/MessageView.tsx

import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { Hash, MessageCircle, Users, Pencil, Trash2, Reply, CornerUpRight, Smile, Image, ArrowDown, X, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMessageList } from '../../Services/hooks/Chats/useMessageList';
import { useMessageDisplay } from '../../Services/hooks/Chats/useMessageDisplay';
import { useGroupMessages, MessageGroupData } from '../../Services/hooks/Chats/useGroupMessages';
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
import { MessageViewSkeleton } from '../common/Skeleton';

const DENSITY: Record<Density, {
  groupGap: string;
  consecutiveGap: string;
  bubblePadding: string;
  maxWidth: string;
  timestampAlways: boolean;
}> = {
  compact: {
    groupGap: 'mt-3',
    consecutiveGap: 'mt-0.5',
    bubblePadding: 'px-3 py-1.5',
    maxWidth: 'max-w-[85%]',
    timestampAlways: false,
  },
  comfortable: {
    groupGap: 'mt-5',
    consecutiveGap: 'mt-1.5',
    bubblePadding: 'px-4 py-2.5',
    maxWidth: 'max-w-[70%]',
    timestampAlways: true,
  },
};

const AVATAR_OFFSET = 'pl-10';

interface MessageViewProps {
  conversation: Conversation;
  encryptionKey: CryptoKey | null;
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
  const { density } = useTheme();
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
    loadingNewer,
    hasOlder,
    hasNewer,
    isAtPresent,
    setIsAtPresent,
    handleDelete,
    getReplyParent,
    jumpToPresent,
    loadOlder,
    loadNewer,
  } = useMessageList(
    conversation.id,
    encryptionKey,
    newMessage,
    messageUpdate,
    messageDelete,
    initReactionsFromMessages
  );

  const { formatTime, getSenderName, getSenderAvatarUrl } = useMessageDisplay(members, userAvatar);

  const groupedMessages = useGroupMessages(messages);
  const latestMessage = messages[0] ?? null;
  const atBottomRef = useRef(true);
  const initialScrollDoneRef = useRef<string | null>(null);
  const latestMessageIdRef = useRef<string | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasUnseenMessages, setHasUnseenMessages] = useState(false);

  const shouldScrollRef = useRef(false);
  useEffect(() => {
    if (shouldScrollRef.current && groupedMessages.length > 0) {
      shouldScrollRef.current = false;
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: 'LAST',
          behavior: 'smooth'
        });
      });
    }
  }, [groupedMessages]);

  useEffect(() => {
    if (loading || groupedMessages.length === 0) return;
    if (initialScrollDoneRef.current === conversation.id) return;

    initialScrollDoneRef.current = conversation.id;
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 10;

    const ensureBottom = () => {
      if (cancelled || atBottomRef.current || attempts >= maxAttempts) return;
      attempts += 1;
      virtuosoRef.current?.scrollToIndex({
        index: 'LAST',
        behavior: 'auto',
      });
      setTimeout(ensureBottom, 90);
    };

    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: 'LAST',
        behavior: 'auto',
      });
      setTimeout(ensureBottom, 90);
    });

    return () => {
      cancelled = true;
    };
  }, [conversation.id, groupedMessages.length, loading]);

  useEffect(() => {
    latestMessageIdRef.current = null;
  }, [conversation.id]);

  useLayoutEffect(() => {
    if (!latestMessage) {
      latestMessageIdRef.current = null;
      return;
    }

    const previousLatestId = latestMessageIdRef.current;
    latestMessageIdRef.current = latestMessage.message_id;

    if (!previousLatestId || previousLatestId === latestMessage.message_id) {
      return;
    }

    if (!atBottomRef.current && latestMessage.sender_id !== user?.id) {
      return;
    }

    virtuosoRef.current?.scrollToIndex({
      index: 'LAST',
      behavior: 'auto',
    });
  }, [latestMessage, user?.id]);

  useEffect(() => {
    if (!newMessage) return;
    if (newMessage.sender_id === user?.id) return;
    if (!atBottomRef.current) {
      setHasUnseenMessages(true);
    }
  }, [newMessage, user?.id]);

  const handleJumpToPresent = useCallback(async () => {
    shouldScrollRef.current = true;
    await jumpToPresent();
    setHasUnseenMessages(false);
  }, [jumpToPresent]);

  const handleStartReached = useCallback(() => {
    // Prevent mount-time "bounce up": only load older when user is actually away from bottom.
    if (atBottomRef.current) return;
    void loadOlder();
  }, [loadOlder]);

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

  const getConversationIcon = () => {
    switch (conversation.type) {
      case 'dm': return <MessageCircle className="w-10 h-10 text-void-text" />;
      case 'group': return <Users className="w-10 h-10 text-void-text" />;
      default: return <Hash className="w-10 h-10 text-void-text" />;
    }
  };

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

  // ============== Virtuoso itemContent ==============
  const renderGroup = (_index: number, group: MessageGroupData) => {
    const isOwn = group.sender_id === user?.id;
    const d = DENSITY[density];
    const isRightAligned = isOwn && density === 'comfortable';
    const showAvatar = density === 'compact' ? true : !isOwn;
    const leftIndent = !isRightAligned && showAvatar ? AVATAR_OFFSET : '';

    return (
      <div className={`px-2 ${d.groupGap}`}>
        {/* Date separator — above the group */}
        {group.showDateSeparator && (
          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-void-bg-hover" />
            <span className="text-xs text-void-text-muted font-medium shrink-0">
              {getDateLabel(group.created_at)}
            </span>
            <div className="flex-1 h-px bg-void-bg-hover" />
          </div>
        )}

        {/* Header row: Shows ONCE per group */}
        <div className={`flex items-center gap-2 text-xs mb-0.5 px-1 ${isRightAligned ? 'justify-end' : leftIndent}`}>
          {isRightAligned ? (
            <>
              <span className="text-void-text-muted">{formatTime(group.created_at)}</span>
              <span
                className="font-semibold text-void-accent cursor-pointer hover:underline"
                onClick={() => handleProfileClick(group.sender_id)}
              >
                {getSmartDisplayName(group.sender_id)}
              </span>
            </>
          ) : (
            <>
              <span
                className="font-semibold text-void-accent cursor-pointer hover:underline"
                onClick={() => handleProfileClick(group.sender_id)}
              >
                {getSmartDisplayName(group.sender_id)}
              </span>
              <span className="text-void-text-muted">{formatTime(group.created_at)}</span>
            </>
          )}
        </div>

        {/* Avatar + Messages Column */}
        <div className={`flex ${isRightAligned ? 'flex-row-reverse' : 'flex-row'} items-end gap-2`}>
          {/* Avatar: Shows ONCE per group */}
          {showAvatar && (
            <div
              className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 bg-void-bg-hover cursor-pointer hover:opacity-80 transition-opacity self-start"
              onClick={() => handleProfileClick(group.sender_id)}
            >
              <img src={getSenderAvatarUrl(group.sender_id)} alt="avatar" className="w-full h-full object-cover" />
            </div>
          )}

          {/* Messages Column Wrapper */}
          <div className={`flex flex-col ${isRightAligned ? 'items-end' : 'items-start'} ${d.maxWidth} min-w-0 w-full`}>
            {group.messages.map((msg, msgIndex) => {
              const replyParent = msg.reply_to ? getReplyParent(msg.reply_to) : null;
              const msgReactions = getMessageReactions(msg.message_id);

              return (
                <div
                  key={msg.message_id}
                  onMouseEnter={() => setHoveredId(msg.message_id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onContextMenu={(e) => handleContextMenu(e, msg)}
                  className={`relative flex ${isRightAligned ? 'flex-row-reverse' : 'flex-row'} items-center gap-2 max-w-full group/msg ${msgIndex > 0 ? d.consecutiveGap : ''}`}
                >
                  <div className={`flex flex-col ${isRightAligned ? 'items-end' : 'items-start'} min-w-0`}>
                    
                    {/* Reply preview */}
                    {msg.reply_to && (
                      <div className={`mb-0.5 ${isRightAligned ? 'text-right' : 'text-left'}`}>
                        <div className="inline-flex items-center gap-1.5 text-xs text-void-text-muted cursor-pointer hover:text-void-text transition-colors">
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

                    {/* Message bubble */}
                    {msg.is_deleted ? (
                      <div className={`${d.bubblePadding} rounded-2xl text-sm italic text-void-text-muted bg-void-bg-hover/50`}>
                        [deleted]
                      </div>
                    ) : (() => {
                      const hasRealContent = msg.content && msg.content !== '[encrypted]';
                      if (!hasRealContent && msg.attachments?.length) return null;
                      return (
                        <div className={`${d.bubblePadding} rounded-2xl text-sm whitespace-pre-wrap break-words ${
                          isRightAligned
                            ? 'rounded-br-sm bg-void-accent text-white'
                            : isOwn
                              ? 'rounded-bl-sm bg-void-accent text-white'
                              : 'rounded-bl-sm bg-void-bg-hover text-void-text'
                        }`}>
                          {hasRealContent ? msg.content : <span className="italic opacity-50 text-xs">encrypted</span>}
                          {msg.is_edited && <span className="text-[10px] opacity-60 ml-1.5">(edited)</span>}
                        </div>
                      );
                    })()}

                    {/* Attachments */}
                    {!msg.is_deleted && msg.attachments && msg.attachments.length > 0 && (() => {
                      const parsed = parseAttachments(msg.attachments);
                      const rawUrls = parsed.map(a => a.url);
                      return (
                        <div className={`mt-1 grid gap-1 ${
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

                    {/* Reactions */}
                    {!msg.is_deleted && Object.keys(msgReactions).length > 0 && (
                      <div className="mt-1">
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

                  {/* Hover action bar (Tied to the specific message!) */}
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
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col relative">
      <Virtuoso
        ref={virtuosoRef}
        className="flex-1"
        data={groupedMessages}
        atBottomThreshold={48}
        followOutput={false}
        initialTopMostItemIndex={Math.max(0, groupedMessages.length - 1)}
        atBottomStateChange={(isAtBottom) => {
          atBottomRef.current = isAtBottom;
          setIsAtBottom(isAtBottom);
          if (isAtBottom) {
            setHasUnseenMessages(false);
          }
          setIsAtPresent(isAtBottom && !hasNewer);
        }}
        startReached={handleStartReached}
        endReached={() => {
          if (!isAtPresent && hasNewer) loadNewer();
        }}
        overscan={150}
        itemContent={renderGroup}
        components={{
          Header: () => (
            <div className="p-4">
              {!hasOlder && groupedMessages.length > 0 && (
                <div className="mt-4 mb-6">
                  <div className="w-16 h-16 bg-void-bg-hover rounded-full flex items-center justify-center mb-4">
                    {getConversationIcon()}
                  </div>
                  <h1 className="text-2xl font-bold mb-1 text-void-text">
                    {conversation.type === 'dm'
                      ? conversation.dm_display_name || conversation.dm_username
                      : conversation.name}
                  </h1>
                  <p className="text-void-text-muted text-sm">
                    This is the beginning of your conversation.
                  </p>
                </div>
              )}
              {loadingOlder && (
                <div className="flex justify-center py-2">
                  <div className="w-4 h-4 border-2 border-void-accent border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
          ),
          Footer: () => (
            <div className="pt-2 pb-3">
              {loadingNewer && (
                <div className="flex justify-center py-2">
                  <div className="w-4 h-4 border-2 border-void-accent border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
          ),
          EmptyPlaceholder: () => (
            <p className="text-center text-void-text-muted text-sm py-8">
              No messages yet. Say something!
            </p>
          ),
        }}
      />

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
              const el = document.querySelector(`[data-msg-id="${contextMenu.msg.message_id}"]`);
              if (el) {
                const rect = el.getBoundingClientRect();
                setEmojiPickerTarget({
                  messageId: contextMenu.msg.message_id,
                  position: { x: rect.left, y: rect.bottom + 8 },
                });
              }
              setContextMenu(null);
            }}
            className="w-full text-left px-3 py-2 text-sm text-void-text hover:bg-void-accent hover:text-white flex items-center gap-2 transition-colors"
          >
            <Smile className="w-4 h-4" />
            Add Reaction
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
