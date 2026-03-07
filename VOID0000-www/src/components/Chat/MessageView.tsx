// src/components/Chat/MessageView.tsx

import { useState, useCallback, useEffect } from 'react';
import { Hash, MessageCircle, Users, Pencil, Trash2, Reply, CornerUpRight, Smile, Image, ArrowDown } from 'lucide-react';
import { useMessageList } from '../../Services/hooks/Chats/useMessageList';
import { useMessageDisplay } from '../../Services/hooks/Chats/useMessageDisplay';
import { useReactions } from '../../Services/hooks/Chats/useReactions';
import { Message, Conversation, ConversationMember } from '../../Services/Chat/chatService';
import { useUser } from '../../Services/Auth/UserContext';
import { useFriends, Friend } from '../../Services/hooks/Friends/useFriends';
import { useUserProfile } from '../../Services/hooks/editProfile/userProfile';
import { useTheme, Density } from '../../Services/hooks/Settings/useTheme';
import FriendProfile from '../common/Friends/FriendProfile';
import UserProfile from '../common/Profile/userProfile';
import EmojiPicker from './EmojiPicker';
import ReactionBar from './ReactionBar';

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

/* Avatar width (w-8 = 32px) + gap-2 (8px) = 40px */
const AVATAR_OFFSET = 'pl-10';
const AVATAR_MARGIN = 'ml-10'; // used on flex row for consecutive messages

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
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ msg: Message; x: number; y: number } | null>(null);
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<{ messageId: string; position: { x: number; y: number } } | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);

  const { friends } = useFriends();
  const { profile: myProfile } = useUserProfile(user?.profile_id || '');
  const { getMessageReactions, handleToggleReaction, initReactionsFromMessages } = useReactions(conversation.id, gateway, user?.id);

  const {
    messages,
    loading,
    loadingOlder,
    loadingNewer,
    hasOlder,
    isAtPresent,
    bottomRef,
    containerRef,
    handleScroll,
    handleDelete,
    getReplyParent,
    jumpToPresent,
  } = useMessageList(
    conversation.id,
    encryptionKey,
    newMessage,
    messageUpdate,
    messageDelete,
    initReactionsFromMessages
  );

  const { formatTime, getSenderName, getSenderAvatarUrl } = useMessageDisplay(members, userAvatar);

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

  if (loading) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-void-accent border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (encryptionError) return (
    <div className="flex-1 flex items-center justify-center text-red-400 p-4 text-center">
      <p>Encryption Error: {encryptionError}</p>
    </div>
  );

  if (!encryptionKey) return (
    <div className="flex-1 flex items-center justify-center text-void-text-muted">
      <p>Setting up encryption...</p>
    </div>
  );

  const getDateLabel = (dateStr: string) => {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const isSameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (isSameDay(date, today)) return 'Today';
    if (isSameDay(date, yesterday)) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  };

  const isSameDay = (a: string, b: string) => {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
  };

  const rendered = [...messages].reverse();

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4">
      {loadingOlder && (
        <div className="flex justify-center py-2">
          <div className="w-4 h-4 border-2 border-void-accent border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!hasOlder && (
        <div className="mt-4 mb-6">
          <div className="w-16 h-16 bg-void-bg-hover rounded-full flex items-center justify-center mb-4">
            {getConversationIcon()}
          </div>
          <h1 className="text-2xl font-bold mb-1 text-void-text">
            {conversation.type === 'dm' ? conversation.dm_display_name || conversation.dm_username : conversation.name}
          </h1>
          <p className="text-void-text-muted text-sm">This is the beginning of your conversation.</p>
        </div>
      )}

      {rendered.map((msg, index) => {
        const prevMsg = index > 0 ? rendered[index - 1] : null;
        const showDateSeparator = !prevMsg || !isSameDay(msg.created_at, prevMsg.created_at);
        const timeDiff = prevMsg ? new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime() : 0;
        const isOwn = msg.sender_id === user?.id;
        const isReply = !!msg.reply_to;
        const isConsecutive = !isReply && prevMsg && prevMsg.sender_id === msg.sender_id && timeDiff < 5 * 60 * 1000;
        const replyParent = msg.reply_to ? getReplyParent(msg.reply_to) : null;
        const msgReactions = getMessageReactions(msg.message_id);

        const d = DENSITY[density];
        const isRightAligned = isOwn && density === 'comfortable';
        const showAvatar = density === 'compact' ? true : !isOwn;

        // In compact mode, indent header/reply/bubble rows to align with avatar
        // For consecutive messages, we apply the margin directly on the flex row instead
        const leftIndent = !isRightAligned && showAvatar ? AVATAR_OFFSET : '';

        return (
          <div key={msg.message_id + '-wrapper'}>
            {showDateSeparator && (
              <div className="flex items-center gap-3 my-4 px-2">
                <div className="flex-1 h-px bg-void-bg-hover" />
                <span className="text-xs text-void-text-muted font-medium shrink-0">
                  {getDateLabel(msg.created_at)}
                </span>
                <div className="flex-1 h-px bg-void-bg-hover" />
              </div>
            )}
          <div
            key={msg.message_id}
            onMouseEnter={() => setHoveredId(msg.message_id)}
            onMouseLeave={() => setHoveredId(null)}
            onContextMenu={(e) => handleContextMenu(e, msg)}
            className={`relative group px-2 ${isConsecutive ? d.consecutiveGap : d.groupGap}`}
          >

            {/* Header row: Name + Time — only on first message of a group */}
            {!isConsecutive && (
              <div
                className={`flex items-center gap-2 text-xs mb-0.5 px-1 ${
                  isRightAligned ? 'justify-end' : leftIndent
                }`}
              >
                {isRightAligned ? (
                  <>
                    <span className="text-void-text-muted">
                      {formatTime(msg.created_at)}
                    </span>
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
                    <span className="text-void-text-muted">
                      {formatTime(msg.created_at)}
                    </span>
                  </>
                )}
              </div>
            )}

            {/* Reply preview — above the avatar+bubble row */}
            {msg.reply_to && (
              <div className={`mb-0.5 ${isRightAligned ? 'text-right' : leftIndent}`}>
                <div className="inline-flex items-center gap-1.5 text-xs text-void-text-muted cursor-pointer hover:text-void-text transition-colors">
                  <CornerUpRight className="w-3 h-3 flex-shrink-0" />
                  {replyParent ? (
                    <>
                      <span className="font-semibold text-void-accent/70">{getSmartDisplayName(replyParent.sender_id)}</span>
                      {(() => {
                        const hasRealContent = replyParent.content && replyParent.content !== '[encrypted]' && replyParent.content !== '[deleted]';
                        if (replyParent.is_deleted) {
                          return <span className="italic opacity-60">[deleted]</span>;
                        }
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
                              {replyParent.content!.substring(0, 60) + (replyParent.content!.length > 60 ? '…' : '')}
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

            {/* Avatar + Bubble row */}
            {/*
              - Non-consecutive: avatar renders naturally, gap-2 handles spacing
              - Consecutive: no avatar rendered, so we apply AVATAR_MARGIN (ml-10)
                to the flex row itself to keep bubbles aligned with the group above
            */}
            <div className={`flex ${isRightAligned ? 'flex-row-reverse' : 'flex-row'} items-center gap-2 ${
              isConsecutive && !isRightAligned ? AVATAR_MARGIN : ''
            }`}>
              {/* Avatar — only on first message of a group */}
              {!isConsecutive && showAvatar && (
                <div
                  className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 bg-void-bg-hover cursor-pointer hover:opacity-80 transition-opacity self-start"
                  onClick={() => handleProfileClick(msg.sender_id)}
                >
                  <img src={getSenderAvatarUrl(msg.sender_id)} alt="avatar" className="w-full h-full object-cover" />
                </div>
              )}

              <div className={`flex flex-col ${isRightAligned ? 'items-end' : 'items-start'} ${d.maxWidth} min-w-0`}>
                {/* Message bubble */}
                {msg.is_deleted ? (
                  <div className={`${d.bubblePadding} rounded-2xl text-sm italic text-void-text-muted bg-void-bg-hover/50`}>
                    [deleted]
                  </div>
                ) : (() => {
                  const hasRealContent = msg.content && msg.content !== '[encrypted]';
                  if (!hasRealContent && msg.attachments?.length) return null;
                  return (
                    <div className={`${d.bubblePadding} rounded-2xl text-sm break-words ${
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
                {!msg.is_deleted && msg.attachments && msg.attachments.length > 0 && (
                  <div className={`mt-1 grid gap-1 ${
                    msg.attachments.length === 1 ? 'grid-cols-1' :
                    msg.attachments.length === 2 ? 'grid-cols-2' :
                    'grid-cols-3'
                  } max-w-xs`}>
                    {msg.attachments.map((url, i) => (
                      <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block rounded-xl overflow-hidden bg-void-bg-hover">
                        <img src={url} alt="attachment" className="w-full object-cover max-h-56 hover:opacity-90 transition-opacity" loading="lazy" />
                      </a>
                    ))}
                  </div>
                )}

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

              {/* Hover action bar — inline, centered next to bubble */}
              {hoveredId === msg.message_id && !msg.is_deleted && (
                <div
                  data-msg-id={msg.message_id}
                  className="flex items-center gap-0.5 bg-void-bg-main border border-void-bg-hover rounded-md p-0.5 shadow-lg shrink-0"
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
          </div>
        );
      })}

      {messages.length === 0 && !loading && (
        <p className="text-center text-void-text-muted text-sm py-8">No messages yet. Say something!</p>
      )}

      {loadingNewer && (
        <div className="flex justify-center py-2">
          <div className="w-4 h-4 border-2 border-void-accent border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      <div ref={bottomRef} />

      {/* Jump to Present button */}
      {!isAtPresent && (
        <button
          onClick={jumpToPresent}
          className="sticky bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-4 py-2 bg-void-accent hover:bg-void-accent-hover text-white text-xs font-bold rounded-full shadow-lg transition-all z-10"
        >
          <ArrowDown className="w-3.5 h-3.5" />
          Jump to Present
        </button>
      )}

      {emojiPickerTarget && (
        <EmojiPicker
          onSelect={handleEmojiSelect}
          onClose={() => setEmojiPickerTarget(null)}
          position={emojiPickerTarget.position}
        />
      )}

      {contextMenu && !contextMenu.msg.is_deleted && (
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
        </div>
      )}

      {selectedProfileId && (
        <UserProfile profileId={selectedProfileId} onClose={() => setSelectedProfileId(null)} />
      )}
      {selectedFriend && (
        <FriendProfile friend={selectedFriend} onClose={() => setSelectedFriend(null)} />
      )}
    </div>
  );
};

export default MessageView;