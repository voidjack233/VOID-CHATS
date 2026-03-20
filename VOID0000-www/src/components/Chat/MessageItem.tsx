import { memo, useState } from 'react';
import {
  CornerUpRight,
  Image,
  Pencil,
  Reply,
  Smile,
  Trash2,
} from 'lucide-react';
import type { Message } from '../../Services/Chat/chatService';
import type { Density } from '../../Services/hooks/Settings/useTheme';
import ReactionBar from './ReactionBar';
import BlurImage from '../common/BlurImage';
import UserAvatar from '../common/UserAvatar';
import { parseAttachments } from '../../Services/Chat/chatService';
import { getMessageDateLabel } from './useMessageLayout';

const DENSITY: Record<Density, {
  consecutiveGap: number;
  bubblePadding: string;
  maxWidth: string;
}> = {
  compact: {
    consecutiveGap: 2,
    bubblePadding: 'px-3 py-1.5',
    maxWidth: 'max-w-[85%]',
  },
  comfortable: {
    consecutiveGap: 6,
    bubblePadding: 'px-4 py-2.5',
    maxWidth: 'max-w-[70%]',
  },
};

const AVATAR_OFFSET = 'pl-10';

interface MessageItemProps {
  message: Message;
  startsGroup: boolean;
  showDateSeparator: boolean;
  density: Density;
  messageGroupSpacing: number;
  metaFontSize: number;
  replyFontSize: number;
  bubbleFontSize: number;
  encryptedFontSize: number;
  currentUserId?: string;
  replyParent: Message | null;
  messageReactions: Record<string, any>;
  formatTime: (dateStr: string) => string;
  getSenderName: (senderId: string) => string;
  getSenderUsername: (senderId: string) => string | null;
  getSenderAvatarUrl: (senderId: string) => string | null;
  onProfileClick: (senderId: string) => void;
  onOpenEmojiPicker: (
    messageId: string,
    anchor: HTMLElement,
    placement?: 'top' | 'bottom',
  ) => void;
  onReply?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onDelete: (messageId: string) => void | Promise<void>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenImageViewer: (urls: string[], index: number) => void;
}

const MessageItem = memo(function MessageItem({
  message,
  startsGroup,
  showDateSeparator,
  density,
  messageGroupSpacing,
  metaFontSize,
  replyFontSize,
  bubbleFontSize,
  encryptedFontSize,
  currentUserId,
  replyParent,
  messageReactions,
  formatTime,
  getSenderName,
  getSenderUsername,
  getSenderAvatarUrl,
  onProfileClick,
  onOpenEmojiPicker,
  onReply,
  onEdit,
  onDelete,
  onToggleReaction,
  onOpenImageViewer,
}: MessageItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const d = DENSITY[density];
  const isSystem = message.message_type === 'system';
  const isOwn = message.sender_id === currentUserId;
  const isSending = message.local_status === 'sending';
  const isRightAligned = isOwn && density === 'comfortable';
  const showSenderMeta = startsGroup;
  const showAvatar = showSenderMeta && (density === 'compact' ? true : !isOwn);
  const leftIndent = !isRightAligned && showAvatar ? AVATAR_OFFSET : '';
  const rowIndent = !isRightAligned && !showAvatar ? AVATAR_OFFSET : '';

  if (isSystem) {
    const hasContent = typeof message.content === 'string' && message.content.trim().length > 0;
    return (
      <div
        className="px-2"
        style={{ paddingTop: `${startsGroup ? messageGroupSpacing : d.consecutiveGap}px` }}
      >
        {showDateSeparator && (
          <div className="flex items-center gap-3 py-4">
            <div className="flex-1 h-px bg-void-bg-hover" />
            <span className="text-void-text-muted font-medium shrink-0" style={{ fontSize: `${metaFontSize}px` }}>
              {getMessageDateLabel(message.created_at)}
            </span>
            <div className="flex-1 h-px bg-void-bg-hover" />
          </div>
        )}

        <div className="flex justify-center py-0.5">
          <span
            className="max-w-[92%] rounded-full border border-void-bg-hover bg-void-bg-hover/35 px-3 py-1 text-center text-void-text-muted"
            style={{ fontSize: `${metaFontSize}px` }}
          >
            {hasContent ? message.content : 'System event'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="px-2"
      style={{ paddingTop: `${startsGroup ? messageGroupSpacing : d.consecutiveGap}px` }}
    >
      {showDateSeparator && (
        <div className="flex items-center gap-3 py-4">
          <div className="flex-1 h-px bg-void-bg-hover" />
          <span className="text-void-text-muted font-medium shrink-0" style={{ fontSize: `${metaFontSize}px` }}>
            {getMessageDateLabel(message.created_at)}
          </span>
          <div className="flex-1 h-px bg-void-bg-hover" />
        </div>
      )}

      {showSenderMeta && (
        <div
          className={`flex items-center gap-2 pb-0.5 px-1 ${isRightAligned ? 'justify-end' : leftIndent}`}
          style={{ fontSize: `${metaFontSize}px` }}
        >
          {isRightAligned ? (
            <>
              <span className="text-void-text-muted">{formatTime(message.created_at)}</span>
              <span
                className="font-semibold text-void-accent cursor-pointer hover:underline"
                onClick={() => onProfileClick(message.sender_id)}
              >
                {getSenderName(message.sender_id)}
              </span>
            </>
          ) : (
            <>
              <span
                className="font-semibold text-void-accent cursor-pointer hover:underline"
                onClick={() => onProfileClick(message.sender_id)}
              >
                {getSenderName(message.sender_id)}
              </span>
              <span className="text-void-text-muted">{formatTime(message.created_at)}</span>
            </>
          )}
        </div>
      )}

      <div
        onMouseEnter={() => {
          if (!isSending) setIsHovered(true);
        }}
        onMouseLeave={() => setIsHovered(false)}
        onContextMenu={(event) => {
          if (!isSending) {
            event.preventDefault();
          }
        }}
        className={`relative flex ${isRightAligned ? 'flex-row-reverse' : 'flex-row'} items-end gap-2 max-w-full ${rowIndent} ${isSending ? 'opacity-65 saturate-50' : ''}`}
      >
        {showAvatar && (
          <div
            className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 bg-void-bg-hover cursor-pointer hover:opacity-80 transition-opacity self-start"
            onClick={() => onProfileClick(message.sender_id)}
          >
            <UserAvatar
              src={getSenderAvatarUrl(message.sender_id)}
              displayName={getSenderName(message.sender_id)}
              username={getSenderUsername(message.sender_id)}
              alt="avatar"
              className="w-full h-full rounded-full"
              fallbackClassName="text-xs"
            />
          </div>
        )}

        <div className={`flex flex-col ${isRightAligned ? 'items-end' : 'items-start'} ${d.maxWidth} min-w-0`}>
          {message.reply_to && (
            <div className={`pb-0.5 ${isRightAligned ? 'text-right' : 'text-left'}`}>
              <div
                className="inline-flex items-center gap-1.5 text-void-text-muted cursor-pointer hover:text-void-text transition-colors"
                style={{ fontSize: `${replyFontSize}px` }}
              >
                <CornerUpRight className="w-3 h-3 flex-shrink-0" />
                {replyParent ? (
                  <>
                    <span className="font-semibold text-void-accent/70">{getSenderName(replyParent.sender_id)}</span>
                    {(() => {
                      const hasRealContent =
                        replyParent.content &&
                        replyParent.content !== '[encrypted]' &&
                        replyParent.content !== '[deleted]';

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

          {message.is_deleted ? (
            <div
              className={`${d.bubblePadding} rounded-2xl italic text-void-text-muted bg-void-bg-hover/50`}
              style={{ fontSize: `${bubbleFontSize}px` }}
            >
              [deleted]
            </div>
          ) : (() => {
            const hasRealContent = message.content && message.content !== '[encrypted]';
            if (!hasRealContent && message.attachments?.length) return null;
            return (
              <div
                className={`${d.bubblePadding} rounded-2xl whitespace-pre-wrap break-words ${
                  isRightAligned
                    ? 'rounded-br-sm bg-void-accent text-white'
                    : isOwn
                      ? 'rounded-bl-sm bg-void-accent text-white'
                      : 'rounded-bl-sm bg-void-bg-hover text-void-text'
                } ${isSending ? 'brightness-90' : ''}`}
                style={{ fontSize: `${bubbleFontSize}px` }}
              >
                {hasRealContent ? (
                  message.content
                ) : (
                  <span className="italic opacity-50" style={{ fontSize: `${encryptedFontSize}px` }}>
                    encrypted
                  </span>
                )}
                {message.is_edited && <span className="text-[10px] opacity-60 ml-1.5">(edited)</span>}
              </div>
            );
          })()}

          {!message.is_deleted && message.attachments && message.attachments.length > 0 && (() => {
            const parsed = parseAttachments(message.attachments);
            const rawUrls = parsed.map((attachment) => attachment.url);

            return (
              <div
                className={`pt-1 grid gap-1 ${
                  parsed.length === 1 ? 'grid-cols-1' :
                  parsed.length === 2 ? 'grid-cols-2' :
                  'grid-cols-3'
                } max-w-xs`}
              >
                {parsed.map((attachment, index) => (
                  <button
                    key={index}
                    onClick={() => onOpenImageViewer(rawUrls, index)}
                    disabled={isSending}
                    className={`block rounded-xl overflow-hidden bg-void-bg-hover focus:outline-none aspect-square ${isSending ? 'cursor-not-allowed' : ''}`}
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

          {!message.is_deleted && Object.keys(messageReactions || {}).length > 0 && (
            <div className="pt-1">
              <ReactionBar
                reactions={messageReactions as any}
                currentUserId={currentUserId || ''}
                onToggle={(emoji) => onToggleReaction(message.message_id, emoji)}
                onAddReaction={(event) => onOpenEmojiPicker(message.message_id, event.currentTarget, 'bottom')}
              />
            </div>
          )}

          {isSending && (
            <div className={`pt-1 ${isRightAligned ? 'text-right' : 'text-left'}`}>
              <span className="text-[10px] italic text-void-text-muted">
                sending...
              </span>
            </div>
          )}
        </div>

        {!message.is_deleted && !isSending && (
          <div
            className={`flex items-center gap-0.5 bg-void-bg-main border border-void-bg-hover rounded-md p-0.5 shadow-lg shrink-0 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          >
            <button
              onClick={(event) => onOpenEmojiPicker(message.message_id, event.currentTarget)}
              className="p-1 hover:bg-void-bg-hover rounded text-void-text-muted hover:text-void-text"
              title="React"
            >
              <Smile className="w-3.5 h-3.5" />
            </button>
            {onReply && (
              <button
                onClick={() => onReply(message)}
                className="p-1 hover:bg-void-bg-hover rounded text-void-text-muted hover:text-void-text"
              >
                <Reply className="w-3.5 h-3.5" />
              </button>
            )}
            {isOwn && onEdit && (
              <button
                onClick={() => onEdit(message)}
                className="p-1 hover:bg-void-bg-hover rounded text-void-text-muted hover:text-void-text"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {isOwn && (
              <button
                onClick={() => onDelete(message.message_id)}
                className="p-1 hover:bg-void-bg-hover rounded text-void-text-muted hover:text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default MessageItem;
