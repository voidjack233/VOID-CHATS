import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import AttachmentImage from './AttachmentImage';
import InviteEmbed from './InviteEmbed';
import UserAvatar from '../common/UserAvatar';
import { parseAttachments } from '../../Services/Chat/chatService';
import { resolveAttachmentObjectUrl } from '../../Services/Crypto/attachmentEncryption';
import { getMessageDateLabel } from './useMessageLayout';
import { extractMessageTextSegments, getInviteCodeFromMessageUrl } from './messageLinks';

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
const SWIPE_START_THRESHOLD = 12;
const SWIPE_START_THRESHOLD_ATTACHMENT = 18;
const SWIPE_ACTION_THRESHOLD = 68;
const SWIPE_ACTION_THRESHOLD_ATTACHMENT = 84;

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
  onContextMenu?: (event: React.MouseEvent, message: Message) => void;
  onOpenContextMenuAtPosition?: (message: Message, position: { x: number; y: number }) => void;
  onReply?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onDelete: (messageId: string) => void | Promise<void>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenImageViewer: (urls: string[], index: number) => void;
  onAttachmentLoad?: () => void;
  onOpenLink?: (url: string) => void;
}

const areMessageItemPropsEqual = (prev: MessageItemProps, next: MessageItemProps) => (
  prev.message === next.message &&
  prev.startsGroup === next.startsGroup &&
  prev.showDateSeparator === next.showDateSeparator &&
  prev.density === next.density &&
  prev.messageGroupSpacing === next.messageGroupSpacing &&
  prev.metaFontSize === next.metaFontSize &&
  prev.replyFontSize === next.replyFontSize &&
  prev.bubbleFontSize === next.bubbleFontSize &&
  prev.encryptedFontSize === next.encryptedFontSize &&
  prev.currentUserId === next.currentUserId &&
  prev.replyParent === next.replyParent &&
  prev.messageReactions === next.messageReactions &&
  prev.formatTime === next.formatTime &&
  prev.getSenderName === next.getSenderName &&
  prev.getSenderUsername === next.getSenderUsername &&
  prev.getSenderAvatarUrl === next.getSenderAvatarUrl &&
  prev.onAttachmentLoad === next.onAttachmentLoad
);

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
  onContextMenu,
  onOpenContextMenuAtPosition,
  onReply,
  onEdit,
  onDelete,
  onToggleReaction,
  onOpenImageViewer,
  onAttachmentLoad,
  onOpenLink,
}: MessageItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [openingImageViewer, setOpeningImageViewer] = useState(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const longPressTimerRef = useRef<number | null>(null);
  const touchStateRef = useRef<{
    active: boolean;
    swiping: boolean;
    longPressTriggered: boolean;
    startedOnAttachment: boolean;
    startX: number;
    startY: number;
    touchId: number | null;
  }>({
    active: false,
    swiping: false,
    longPressTriggered: false,
    startedOnAttachment: false,
    startX: 0,
    startY: 0,
    touchId: null,
  });
  const d = DENSITY[density];
  const isSystem = message.message_type === 'system';
  const isOwn = message.sender_id === currentUserId;
  const isSending = message.local_status === 'sending';
  const isQueued = message.local_status === 'queued';
  const isPending = isSending || isQueued;
  const isRightAligned = isOwn && density === 'comfortable';
  const canSwipeReply = Boolean(onReply);
  const canSwipeEdit = Boolean(isOwn && onEdit);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearLongPressTimer(), [clearLongPressTimer]);

  const blurActiveComposer = useCallback(() => {
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

  const handleOpenAttachmentViewer = useCallback(async (attachmentUrls: string[], index: number) => {
    if (isPending || openingImageViewer) return;

    setOpeningImageViewer(true);
    try {
      const resolvedUrls = await Promise.all(
        parseAttachments(attachmentUrls).map((attachment) => resolveAttachmentObjectUrl(attachment))
      );
      onOpenImageViewer(resolvedUrls, index);
    } catch (error) {
      console.error('Failed to open attachment viewer:', error);
    } finally {
      setOpeningImageViewer(false);
    }
  }, [isPending, onOpenImageViewer, openingImageViewer]);
  const showSenderMeta = startsGroup;
  const showAvatar = showSenderMeta && (density === 'compact' ? true : !isOwn);
  const leftIndent = !isRightAligned && showAvatar ? AVATAR_OFFSET : '';
  const rowIndent = !isRightAligned && !showAvatar ? AVATAR_OFFSET : '';
  const linkClassName = isRightAligned || isOwn
    ? 'box-decoration-clone break-all rounded-md bg-white/12 px-1 py-0.5 font-medium text-sky-100 underline decoration-sky-100/90 decoration-2 underline-offset-2 transition-colors hover:bg-white/18 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/35'
    : 'box-decoration-clone break-all rounded-md bg-void-bg-main/65 px-1 py-0.5 font-medium text-sky-400 underline decoration-sky-400/90 decoration-2 underline-offset-2 transition-colors hover:bg-void-bg-main hover:text-sky-300 focus:outline-none focus:ring-2 focus:ring-void-accent/35';
  const inviteUrl = useMemo(() => {
    if (!message.content || message.content === '[encrypted]') return null;
    const segments = extractMessageTextSegments(message.content);
    const inviteSegment = segments.find((segment) => (
      segment.type === 'link' && getInviteCodeFromMessageUrl(segment.url)
    ));

    return inviteSegment?.type === 'link' ? inviteSegment.url : null;
  }, [message.content]);
  const inviteCode = useMemo(
    () => (inviteUrl ? getInviteCodeFromMessageUrl(inviteUrl) : null),
    [inviteUrl],
  );

  const renderMessageText = useCallback((content: string) => {
    const lines = content.split('\n');

    return lines.map((line, lineIndex) => {
      const segments = extractMessageTextSegments(line);

      return (
        <Fragment key={`line-${lineIndex}`}>
          {segments.map((segment, segmentIndex) => {
            if (segment.type === 'text') {
              return (
                <Fragment key={`text-${lineIndex}-${segmentIndex}`}>
                  {segment.value}
                </Fragment>
              );
            }

            return (
              <a
                key={`link-${lineIndex}-${segmentIndex}`}
                href={segment.url}
                onClick={(event) => {
                  event.preventDefault();
                  onOpenLink?.(segment.url);
                }}
                className={`${linkClassName} inline cursor-pointer text-left align-baseline`}
                title={segment.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                {segment.value}
              </a>
            );
          })}
          {lineIndex < lines.length - 1 ? <br /> : null}
        </Fragment>
      );
    });
  }, [linkClassName, onOpenLink]);

  const resetTouchGesture = useCallback(() => {
    touchStateRef.current.active = false;
    touchStateRef.current.swiping = false;
    touchStateRef.current.longPressTriggered = false;
    touchStateRef.current.startedOnAttachment = false;
    touchStateRef.current.touchId = null;
    setIsSwiping(false);
    setSwipeOffset(0);
  }, []);

  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (isPending || event.touches.length !== 1) return;

    const target = event.target as HTMLElement | null;
    const gestureTarget = target?.closest('[data-message-gesture-target]');
    const allowsMessageGesture = gestureTarget?.getAttribute('data-message-gesture-target') === 'attachment';

    if (!allowsMessageGesture && target?.closest('button, a, input, textarea')) {
      return;
    }

    const touch = event.touches[0];
    if (!touch) return;
    touchStateRef.current = {
      active: true,
      swiping: false,
      longPressTriggered: false,
      startedOnAttachment: allowsMessageGesture,
      startX: touch.clientX,
      startY: touch.clientY,
      touchId: touch.identifier,
    };

    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      const state = touchStateRef.current;
      if (!state.active || state.swiping || state.longPressTriggered) return;

      state.longPressTriggered = true;
      blurActiveComposer();
      window.getSelection?.()?.removeAllRanges();
      onOpenContextMenuAtPosition?.(message, {
        x: touch.clientX,
        y: touch.clientY,
      });
      navigator.vibrate?.(10);
    }, 360);
  }, [blurActiveComposer, clearLongPressTimer, isPending, message, onOpenContextMenuAtPosition]);

  const handleTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const state = touchStateRef.current;
    if (!state.active) return;

    const touch = Array.from(event.touches).find((item) => item.identifier === state.touchId) || event.touches[0];
    if (!touch) return;

    const deltaX = touch.clientX - state.startX;
    const deltaY = touch.clientY - state.startY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    const swipeStartThreshold = state.startedOnAttachment
      ? SWIPE_START_THRESHOLD_ATTACHMENT
      : SWIPE_START_THRESHOLD;

    if (state.longPressTriggered) {
      event.preventDefault();
      return;
    }

    if (absY > 18 && absY > absX) {
      clearLongPressTimer();
      resetTouchGesture();
      return;
    }

    if (absX > swipeStartThreshold && absX > absY * 1.25) {
      clearLongPressTimer();
      state.swiping = true;
      setIsSwiping(true);

      let nextOffset = deltaX;
      if (nextOffset > 0 && !canSwipeReply) nextOffset = 0;
      if (nextOffset < 0 && !canSwipeEdit) nextOffset = 0;
      nextOffset = Math.max(-88, Math.min(88, nextOffset));
      setSwipeOffset(nextOffset);
      event.preventDefault();
      return;
    }

    if (absX > 8 || absY > 8) {
      clearLongPressTimer();
    }
  }, [canSwipeEdit, canSwipeReply, clearLongPressTimer, resetTouchGesture]);

  const handleTouchEnd = useCallback(() => {
    const state = touchStateRef.current;
    clearLongPressTimer();

    if (!state.active) {
      resetTouchGesture();
      return;
    }

    if (state.longPressTriggered) {
      resetTouchGesture();
      return;
    }

    if (state.swiping) {
      const swipeActionThreshold = state.startedOnAttachment
        ? SWIPE_ACTION_THRESHOLD_ATTACHMENT
        : SWIPE_ACTION_THRESHOLD;

      if (swipeOffset >= swipeActionThreshold && onReply) {
        onReply(message);
      } else if (swipeOffset <= -swipeActionThreshold && isOwn && onEdit) {
        onEdit(message);
      }
    }

    resetTouchGesture();
  }, [clearLongPressTimer, isOwn, message, onEdit, onReply, resetTouchGesture, swipeOffset]);

  const handleTouchCancel = useCallback(() => {
    clearLongPressTimer();
    resetTouchGesture();
  }, [clearLongPressTimer, resetTouchGesture]);

  const handleOpenEmojiPickerFromButton = useCallback((event: React.MouseEvent<HTMLElement>) => {
    blurActiveComposer();
    onOpenEmojiPicker(message.message_id, event.currentTarget);
  }, [blurActiveComposer, message.message_id, onOpenEmojiPicker]);

  const handleOpenEmojiPickerFromReactionBar = useCallback((event: React.MouseEvent<HTMLElement>) => {
    blurActiveComposer();
    onOpenEmojiPicker(message.message_id, event.currentTarget, 'bottom');
  }, [blurActiveComposer, message.message_id, onOpenEmojiPicker]);

  const handleToggleReactionWithBlur = useCallback((emoji: string) => {
    blurActiveComposer();
    onToggleReaction(message.message_id, emoji);
  }, [blurActiveComposer, message.message_id, onToggleReaction]);

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
          if (!isPending) setIsHovered(true);
        }}
        onMouseLeave={() => setIsHovered(false)}
        className={`relative flex ${isRightAligned ? 'flex-row-reverse' : 'flex-row'} items-end gap-2 max-w-full ${rowIndent} ${isPending ? 'opacity-65 saturate-50' : ''}`}
      >
        {canSwipeReply && (
          <div
            className={`pointer-events-none absolute inset-y-0 ${isRightAligned ? 'right-2' : 'left-2'} flex items-center text-void-accent transition-opacity`}
            style={{ opacity: swipeOffset > 8 ? Math.min(1, swipeOffset / 56) : 0 }}
          >
            <Reply className="h-4 w-4" />
          </div>
        )}
        {canSwipeEdit && (
          <div
            className={`pointer-events-none absolute inset-y-0 ${isRightAligned ? 'left-2' : 'right-2'} flex items-center text-void-accent transition-opacity`}
            style={{ opacity: swipeOffset < -8 ? Math.min(1, Math.abs(swipeOffset) / 56) : 0 }}
          >
            <Pencil className="h-4 w-4" />
          </div>
        )}

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

        <div
          onContextMenu={isPending ? undefined : (e) => onContextMenu?.(e, message)}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
          className={`flex flex-col ${isRightAligned ? 'items-end' : 'items-start'} ${d.maxWidth} min-w-0 select-none md:select-text ${isSwiping ? '' : 'transition-transform duration-200 ease-out'}`}
          style={{
            transform: `translateX(${swipeOffset}px)`,
            WebkitTouchCallout: 'none',
          }}
        >
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
                } ${isPending ? 'brightness-90' : ''}`}
                style={{ fontSize: `${bubbleFontSize}px` }}
              >
                {hasRealContent ? (
                  renderMessageText(message.content || '')
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
                    onClick={() => { void handleOpenAttachmentViewer(message.attachments || [], index); }}
                    data-message-gesture-target="attachment"
                    disabled={isPending || openingImageViewer}
                    className={`block rounded-xl overflow-hidden bg-void-bg-hover focus:outline-none aspect-square ${isPending ? 'cursor-not-allowed' : ''}`}
                  >
                    <AttachmentImage
                      attachment={attachment}
                      alt="attachment"
                      className="w-full h-full object-cover hover:opacity-90"
                      onLoad={onAttachmentLoad}
                    />
                  </button>
                ))}
              </div>
            );
          })()}

          {!message.is_deleted && inviteUrl && inviteCode && (
            <InviteEmbed
              inviteCode={inviteCode}
              inviteUrl={inviteUrl}
              onOpenInvite={(url) => onOpenLink?.(url)}
            />
          )}

          {!message.is_deleted && Object.keys(messageReactions || {}).length > 0 && (
            <div className="pt-1">
              <ReactionBar
                reactions={messageReactions as any}
                currentUserId={currentUserId || ''}
                onToggle={handleToggleReactionWithBlur}
                onAddReaction={handleOpenEmojiPickerFromReactionBar}
              />
            </div>
          )}

          {isPending && (
            <div className={`pt-1 ${isRightAligned ? 'text-right' : 'text-left'}`}>
              <span className="text-[10px] italic text-void-text-muted">
                {isQueued ? 'queued' : 'sending...'}
              </span>
            </div>
          )}
        </div>

        {!message.is_deleted && !isPending && (
          <div
            className={`flex items-center gap-0.5 bg-void-bg-main border border-void-bg-hover rounded-md p-0.5 shadow-lg shrink-0 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          >
            <button
              onClick={handleOpenEmojiPickerFromButton}
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
}, areMessageItemPropsEqual);

export default MessageItem;
