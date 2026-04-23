import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowRight,
  CornerUpRight,
  FileText,
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
import AttachmentFileCard from './AttachmentFileCard';
import FormattedMessageText from './FormattedMessageText';
import InviteEmbed from './InviteEmbed';
import MessagePreviewText from './MessagePreviewText';
import UserAvatar from '../common/UserAvatar';
import { parseAttachment, parseAttachments } from '../../Services/Chat/chatService';
import { CHAT_FORWARDED_MLS_MESSAGE_TYPE } from '../../Services/Chat/chatUtils';
import { getMentionUsernames } from '../../Services/Chat/messageMentions';
import { MAX_UNIQUE_REACTIONS_PER_MESSAGE, getUniqueReactionCount } from '../../Services/Chat/reactionLimits';
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
    maxWidth: 'max-w-[88%] md:max-w-[85%]',
  },
  comfortable: {
    consecutiveGap: 6,
    bubblePadding: 'px-4 py-2.5',
    maxWidth: 'max-w-[80%] md:max-w-[70%]',
  },
};

const AVATAR_OFFSET = 'pl-10';
const SWIPE_START_THRESHOLD = 12;
const SWIPE_START_THRESHOLD_ATTACHMENT = 18;
const SWIPE_ACTION_THRESHOLD = 68;
const SWIPE_ACTION_THRESHOLD_ATTACHMENT = 84;
const SINGLE_ATTACHMENT_MAX_LANDSCAPE_WIDTH = 280;
const SINGLE_ATTACHMENT_MAX_PORTRAIT_WIDTH = 220;
const SINGLE_ATTACHMENT_MAX_SQUARE_WIDTH = 240;
const SINGLE_ATTACHMENT_MAX_HEIGHT = 320;
const SINGLE_ATTACHMENT_MIN_WIDTH = 160;
const SINGLE_ATTACHMENT_FALLBACK_WIDTH = 220;
const MULTI_ATTACHMENT_MAX_WIDTH = 320;
const LANDSCAPE_ATTACHMENT_RATIO_THRESHOLD = 1.2;
const PORTRAIT_ATTACHMENT_RATIO_THRESHOLD = 0.9;

interface MessageItemProps {
  message: Message;
  enableMentions?: boolean;
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
  onOpenContextMenuAtPosition?: (
    message: Message,
    position: { x: number; y: number },
    mode?: 'full' | 'reactions',
  ) => void;
  onReply?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onDelete: (messageId: string) => void | Promise<void>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenImageViewer: (urls: string[], index: number) => void;
  onAttachmentLoad?: () => void;
  canLoadAttachments?: boolean;
  onOpenLink?: (url: string) => void;
}

function getSingleAttachmentPresentation(attachment: {
  width?: number;
  height?: number;
}): { width: number; aspectRatio: string } | null {
  const width = attachment.width;
  const height = attachment.height;

  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  const aspectRatio = width / height;
  const maxWidth = aspectRatio >= LANDSCAPE_ATTACHMENT_RATIO_THRESHOLD
    ? SINGLE_ATTACHMENT_MAX_LANDSCAPE_WIDTH
    : aspectRatio <= PORTRAIT_ATTACHMENT_RATIO_THRESHOLD
      ? SINGLE_ATTACHMENT_MAX_PORTRAIT_WIDTH
      : SINGLE_ATTACHMENT_MAX_SQUARE_WIDTH;

  let displayWidth = Math.min(width, maxWidth);
  displayWidth = Math.max(SINGLE_ATTACHMENT_MIN_WIDTH, displayWidth);
  let displayHeight = displayWidth * (height / width);

  if (displayHeight > SINGLE_ATTACHMENT_MAX_HEIGHT) {
    displayHeight = SINGLE_ATTACHMENT_MAX_HEIGHT;
    displayWidth = displayHeight * (width / height);
  }

  displayWidth = Math.max(SINGLE_ATTACHMENT_MIN_WIDTH, Math.min(displayWidth, maxWidth));

  return {
    width: Math.round(displayWidth),
    aspectRatio: `${width} / ${height}`,
  };
}

function getMultiAttachmentGridClass(attachmentCount: number): string {
  if (attachmentCount <= 1) {
    return 'flex';
  }

  return 'grid grid-cols-2 gap-1';
}

function getMultiAttachmentTileClass(attachmentCount: number, index: number): string {
  if (attachmentCount === 2) {
    return 'aspect-square';
  }

  if (attachmentCount >= 3) {
    if (index === 0) {
      return 'col-span-2 aspect-[16/9]';
    }

    return 'aspect-square';
  }

  return 'aspect-square';
}

function getAttachmentLayoutKey(attachment: { url: string; name?: string }, index: number): string {
  return `${attachment.url}::${attachment.name || 'attachment'}::${index}`;
}

function looksLikeImageAttachment(attachment: {
  url: string;
  mime?: string;
  blurhash?: string;
  width?: number;
  height?: number;
}): boolean {
  if (attachment.mime?.startsWith('image/')) {
    return true;
  }

  if (attachment.blurhash || attachment.width || attachment.height) {
    return true;
  }

  try {
    const pathname = new URL(attachment.url, window.location.origin).pathname.toLowerCase();
    return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(pathname);
  } catch {
    return false;
  }
}

const areMessageItemPropsEqual = (prev: MessageItemProps, next: MessageItemProps) => (
  prev.message === next.message &&
  prev.enableMentions === next.enableMentions &&
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
  prev.canLoadAttachments === next.canLoadAttachments &&
  prev.onAttachmentLoad === next.onAttachmentLoad
);

const MessageItem = memo(function MessageItem({
  message,
  enableMentions = false,
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
  canLoadAttachments = true,
  onOpenLink,
}: MessageItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [openingImageViewer, setOpeningImageViewer] = useState(false);
  const [attachmentDimensions, setAttachmentDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const [desktopActionRailStyle, setDesktopActionRailStyle] = useState<CSSProperties | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const swipeAnimationFrameRef = useRef<number | null>(null);
  const swipeOffsetRef = useRef(0);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const textActionAnchorRef = useRef<HTMLDivElement | null>(null);
  const attachmentActionAnchorRef = useRef<HTMLDivElement | null>(null);
  const desktopActionRailRef = useRef<HTMLDivElement | null>(null);
  const replyIndicatorRef = useRef<HTMLDivElement | null>(null);
  const editIndicatorRef = useRef<HTMLDivElement | null>(null);
  const touchStateRef = useRef<{
    active: boolean;
    swiping: boolean;
    longPressTriggered: boolean;
    startedOnAttachment: boolean;
    startedInCodeBlock: boolean;
    startX: number;
    startY: number;
    touchId: number | null;
  }>({
    active: false,
    swiping: false,
    longPressTriggered: false,
    startedOnAttachment: false,
    startedInCodeBlock: false,
    startX: 0,
    startY: 0,
    touchId: null,
  });
  const d = DENSITY[density];
  const isSystem = message.message_type === 'system';
  const isForwardedMessage =
    message.message_type === CHAT_FORWARDED_MLS_MESSAGE_TYPE || Boolean(message.forwarded);
  const isOwn = message.sender_id === currentUserId;
  const isSending = message.local_status === 'sending';
  const isQueued = message.local_status === 'queued';
  const isPending = isSending || isQueued;
  const pendingStatusLabel = isQueued ? 'queued' : 'sending...';
  const isRightAligned = isOwn && density === 'comfortable';
  const canSwipeReply = Boolean(onReply);
  const canSwipeEdit = Boolean(isOwn && onEdit);
  const reachedReactionLimit = getUniqueReactionCount(messageReactions as Record<string, unknown>) >= MAX_UNIQUE_REACTIONS_PER_MESSAGE;
  const attachmentEntries = useMemo(() => (
    (message.attachments || []).map((raw, index) => ({
      raw,
      originalIndex: index,
      attachment: parseAttachment(raw),
    }))
  ), [message.attachments]);
  const imageAttachmentEntries = useMemo(
    () => attachmentEntries.filter(({ attachment }) => looksLikeImageAttachment(attachment)),
    [attachmentEntries],
  );
  const fileAttachmentEntries = useMemo(
    () => attachmentEntries.filter(({ attachment }) => !looksLikeImageAttachment(attachment)),
    [attachmentEntries],
  );
  const singleImageEntry = imageAttachmentEntries.length === 1 ? imageAttachmentEntries[0] : null;
  const singleImageLayoutKey = singleImageEntry
    ? getAttachmentLayoutKey(singleImageEntry.attachment, singleImageEntry.originalIndex)
    : null;
  const singleImageResolvedDimensions = singleImageLayoutKey
    ? attachmentDimensions[singleImageLayoutKey]
    : undefined;
  const singleImagePresentation = singleImageEntry
    ? getSingleAttachmentPresentation({
        ...singleImageEntry.attachment,
        width: singleImageEntry.attachment.width ?? singleImageResolvedDimensions?.width,
        height: singleImageEntry.attachment.height ?? singleImageResolvedDimensions?.height,
      })
    : null;

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const applySwipeVisuals = useCallback((offset: number, animate: boolean) => {
    const contentEl = contentRef.current;
    const replyEl = replyIndicatorRef.current;
    const editEl = editIndicatorRef.current;

    if (contentEl) {
      contentEl.style.transition = animate ? 'transform 200ms ease-out' : 'none';
      contentEl.style.transform = `translateX(${offset}px)`;
    }

    if (replyEl) {
      replyEl.style.opacity = offset > 8 ? `${Math.min(1, offset / 56)}` : '0';
    }

    if (editEl) {
      editEl.style.opacity = offset < -8 ? `${Math.min(1, Math.abs(offset) / 56)}` : '0';
    }
  }, []);

  const scheduleSwipeVisuals = useCallback((offset: number, animate: boolean) => {
    swipeOffsetRef.current = offset;

    if (swipeAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(swipeAnimationFrameRef.current);
    }

    swipeAnimationFrameRef.current = window.requestAnimationFrame(() => {
      swipeAnimationFrameRef.current = null;
      applySwipeVisuals(offset, animate);
    });
  }, [applySwipeVisuals]);

  useEffect(() => () => {
    clearLongPressTimer();

    if (swipeAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(swipeAnimationFrameRef.current);
    }
  }, [clearLongPressTimer]);

  useEffect(() => {
    setAttachmentDimensions({});
  }, [message.message_id]);

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

  const resetTouchGesture = useCallback(() => {
    touchStateRef.current.active = false;
    touchStateRef.current.swiping = false;
    touchStateRef.current.longPressTriggered = false;
    touchStateRef.current.startedOnAttachment = false;
    touchStateRef.current.startedInCodeBlock = false;
    touchStateRef.current.touchId = null;
    scheduleSwipeVisuals(0, true);
  }, [scheduleSwipeVisuals]);

  const handleTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (isPending || event.touches.length !== 1) return;

    const target = event.target as HTMLElement | null;
    const gestureTarget = target?.closest('[data-message-gesture-target]');
    const allowsMessageGesture = gestureTarget?.getAttribute('data-message-gesture-target') === 'attachment';
    const explicitGestureAllowance = target?.closest('[data-allow-message-gesture="true"]');
    const codeBlockScrollZone = target?.closest('[data-code-block-scroll-zone="true"]');

    if (!allowsMessageGesture && !explicitGestureAllowance && target?.closest('button, a, input, textarea')) {
      return;
    }

    const touch = event.touches[0];
    if (!touch) return;
    touchStateRef.current = {
      active: true,
      swiping: false,
      longPressTriggered: false,
      startedOnAttachment: allowsMessageGesture,
      startedInCodeBlock: Boolean(codeBlockScrollZone),
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
      return;
    }

    if (absY > 18 && absY > absX) {
      clearLongPressTimer();
      resetTouchGesture();
      return;
    }

    if (state.startedInCodeBlock && absX > 8 && absX > absY) {
      clearLongPressTimer();
      resetTouchGesture();
      return;
    }

    if (absX > swipeStartThreshold && absX > absY * 1.25) {
      clearLongPressTimer();
      state.swiping = true;

      let nextOffset = deltaX;
      if (nextOffset > 0 && !canSwipeReply) nextOffset = 0;
      if (nextOffset < 0 && !canSwipeEdit) nextOffset = 0;
      nextOffset = Math.max(-88, Math.min(88, nextOffset));
      scheduleSwipeVisuals(nextOffset, false);
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

      if (swipeOffsetRef.current >= swipeActionThreshold && onReply) {
        onReply(message);
      } else if (swipeOffsetRef.current <= -swipeActionThreshold && isOwn && onEdit) {
        onEdit(message);
      }
    }

    resetTouchGesture();
  }, [clearLongPressTimer, isOwn, message, onEdit, onReply, resetTouchGesture]);

  const handleTouchCancel = useCallback(() => {
    clearLongPressTimer();
    resetTouchGesture();
  }, [clearLongPressTimer, resetTouchGesture]);

  const handleOpenReactionActionsFromButton = useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    blurActiveComposer();

    if (onOpenContextMenuAtPosition) {
      const rect = event.currentTarget.getBoundingClientRect();
      onOpenContextMenuAtPosition(message, {
        x: rect.left + rect.width / 2,
        y: rect.top - 8,
      }, 'reactions');
      return;
    }

    if (reachedReactionLimit) return;
    onOpenEmojiPicker(message.message_id, event.currentTarget);
  }, [
    blurActiveComposer,
    message,
    message.message_id,
    onOpenContextMenuAtPosition,
    onOpenEmojiPicker,
    reachedReactionLimit,
  ]);

  const handleOpenEmojiPickerFromReactionBar = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (reachedReactionLimit) return;
    blurActiveComposer();
    onOpenEmojiPicker(message.message_id, event.currentTarget, 'bottom');
  }, [blurActiveComposer, message.message_id, onOpenEmojiPicker, reachedReactionLimit]);

  const handleToggleReactionWithBlur = useCallback((emoji: string) => {
    blurActiveComposer();
    onToggleReaction(message.message_id, emoji);
  }, [blurActiveComposer, message.message_id, onToggleReaction]);

  const updateDesktopActionRailPosition = useCallback(() => {
    if (!isHovered || isPending || message.is_deleted) {
      setDesktopActionRailStyle(null);
      return;
    }

    const anchor = attachmentEntries.length > 0
      ? attachmentActionAnchorRef.current
      : textActionAnchorRef.current;

    if (!anchor) {
      setDesktopActionRailStyle(null);
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const railWidth = desktopActionRailRef.current?.offsetWidth ?? 110;
    const railHeight = desktopActionRailRef.current?.offsetHeight ?? 32;
    const gap = 8;
    const minInset = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const headerBottom = document
      .querySelector<HTMLElement>('[data-chat-conversation-header="true"]')
      ?.getBoundingClientRect()
      .bottom ?? 0;
    const minTop = Math.max(minInset, headerBottom + gap);

    const nextLeft = isRightAligned
      ? Math.max(minInset, rect.left - railWidth - gap)
      : Math.min(viewportWidth - railWidth - minInset, rect.right + gap);
    const nextTop = Math.min(
      viewportHeight - railHeight - minInset,
      Math.max(minTop, rect.top + Math.max(0, (rect.height - railHeight) / 2)),
    );

    setDesktopActionRailStyle({
      left: `${Math.round(nextLeft)}px`,
      top: `${Math.round(nextTop)}px`,
    });
  }, [attachmentEntries.length, isHovered, isPending, isRightAligned, message.is_deleted]);

  useLayoutEffect(() => {
    updateDesktopActionRailPosition();
  }, [updateDesktopActionRailPosition]);

  useEffect(() => {
    if (!isHovered || isPending || message.is_deleted) return;

    const handleReposition = () => updateDesktopActionRailPosition();

    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [isHovered, isPending, message.is_deleted, updateDesktopActionRailPosition]);

  const desktopActionRail = !message.is_deleted && !isPending ? (
    <div
      ref={desktopActionRailRef}
      className={`fixed z-20 hidden md:flex items-center gap-0.5 rounded-md border border-void-bg-hover bg-void-bg-main p-0.5 shadow-lg transition-opacity ${
        isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      style={desktopActionRailStyle ?? { visibility: 'hidden' }}
    >
      <button
        onClick={handleOpenReactionActionsFromButton}
        className="p-1 rounded text-void-text-muted hover:bg-void-bg-hover hover:text-void-text"
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
  ) : null;

  if (isSystem) {
    const hasContent = typeof message.content === 'string' && message.content.trim().length > 0;
    return (
      <div
        data-message-id={message.message_id}
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
      data-message-id={message.message_id}
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
            ref={replyIndicatorRef}
            className={`pointer-events-none absolute inset-y-0 ${isRightAligned ? 'right-2' : 'left-2'} flex items-center text-void-accent transition-opacity`}
            style={{ opacity: 0 }}
          >
            <Reply className="h-4 w-4" />
          </div>
        )}
        {canSwipeEdit && (
          <div
            ref={editIndicatorRef}
            className={`pointer-events-none absolute inset-y-0 ${isRightAligned ? 'left-2' : 'right-2'} flex items-center text-void-accent transition-opacity`}
            style={{ opacity: 0 }}
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
          ref={contentRef}
          onContextMenu={isPending ? undefined : (e) => onContextMenu?.(e, message)}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
          className={`flex flex-col ${isRightAligned ? 'items-end' : 'items-start'} ${d.maxWidth} min-w-0 select-none md:select-text will-change-transform`}
          style={{
            WebkitTouchCallout: 'none',
            touchAction: 'pan-y',
          }}
        >
          {message.reply_to && (
            <div className={`pb-0.5 ${isRightAligned ? 'text-right' : 'text-left'}`}>
              <div
                className="inline-flex min-h-[18px] max-w-[260px] items-center gap-1.5 text-void-text-muted cursor-pointer hover:text-void-text transition-colors"
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
                        const firstReplyAttachment = parseAttachment(replyParent.attachments[0]!);
                        const ReplyAttachmentIcon = looksLikeImageAttachment(firstReplyAttachment) ? Image : FileText;
                        const replyAttachmentLabel = looksLikeImageAttachment(firstReplyAttachment)
                          ? 'Click to see attachment'
                          : 'Click to download file';

                        return (
                          <span className="flex items-center gap-1.5">
                            <ReplyAttachmentIcon className="w-4 h-4 flex-shrink-0" />
                            <span className="italic text-void-text-muted/70 cursor-not-allowed select-none">
                              {replyAttachmentLabel}
                            </span>
                          </span>
                        );
                      }

                      if (hasRealContent) {
                        return (
                          <span className="truncate max-w-[220px]">
                            <MessagePreviewText
                              content={replyParent.content}
                              maxLength={60}
                              fallback="Message unavailable"
                            />
                          </span>
                        );
                      }

                      return <span className="italic opacity-60">Message unavailable</span>;
                    })()}
                  </>
                ) : (
                  <span className="truncate italic opacity-70">Loading reply...</span>
                )}
              </div>
            </div>
          )}

          {isForwardedMessage ? (
            <div className={`mb-1.5 ${isRightAligned ? 'text-right' : 'text-left'}`}>
              <div
                className="inline-flex min-h-[18px] max-w-[260px] items-center gap-1.5 text-void-text-muted"
                style={{ fontSize: `${replyFontSize}px` }}
              >
                <ArrowRight className="w-3 h-3 flex-shrink-0" />
                <span className="font-semibold text-void-accent/70">Forwarded message</span>
              </div>
            </div>
          ) : null}

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
                ref={textActionAnchorRef}
                className={`min-w-0 max-w-full overflow-hidden ${d.bubblePadding} rounded-2xl whitespace-pre-wrap break-words ${
                  isRightAligned
                    ? 'rounded-br-sm bg-void-accent text-white'
                    : isOwn
                      ? 'rounded-bl-sm bg-void-accent text-white'
                      : 'rounded-bl-sm bg-void-bg-hover text-void-text'
                } ${isPending ? 'brightness-90' : ''}`}
                style={{ fontSize: `${bubbleFontSize}px` }}
              >
                {hasRealContent ? (
                  <FormattedMessageText
                    content={message.content || ''}
                    linkClassName={linkClassName}
                    onOpenLink={onOpenLink}
                    enableMentions={enableMentions}
                    mentionUsernames={enableMentions ? getMentionUsernames(message.mentions) : undefined}
                  />
                ) : (
                  <span className="italic opacity-50" style={{ fontSize: `${encryptedFontSize}px` }}>
                    encrypted
                  </span>
                )}
                {message.is_edited && <span className="text-[10px] opacity-60 ml-1.5">(edited)</span>}
                {isPending && (
                  <div
                    className={`mt-1 text-[10px] italic ${
                      isRightAligned || isOwn ? 'text-white/75' : 'text-void-text-muted'
                    }`}
                  >
                    {pendingStatusLabel}
                  </div>
                )}
              </div>
            );
          })()}

          {!message.is_deleted && message.attachments && message.attachments.length > 0 && (() => {
            const imageEntries = imageAttachmentEntries;
            const fileEntries = fileAttachmentEntries;

            const imageSection = imageEntries.length > 0
              ? (() => {
                  const singleAttachmentPresentation = imageEntries.length === 1 ? singleImagePresentation : null;
                  const visibleImages = imageEntries.length > 3 ? imageEntries.slice(0, 3) : imageEntries;
                  const hiddenImageCount = Math.max(0, imageEntries.length - visibleImages.length);
                  const viewerRawAttachments = imageEntries.map(({ raw }) => raw);

                  return (
                    <div
                      className={`${
                        imageEntries.length === 1
                          ? 'flex'
                          : getMultiAttachmentGridClass(visibleImages.length)
                      }`}
                      style={imageEntries.length === 1 ? undefined : { maxWidth: `${MULTI_ATTACHMENT_MAX_WIDTH}px` }}
                    >
                      {visibleImages.map(({ attachment, originalIndex }, index) => {
                        const hasHiddenAttachments = hiddenImageCount > 0 && index === visibleImages.length - 1;

                        return (
                          <button
                            key={`${originalIndex}-${attachment.url}`}
                            onClick={() => { void handleOpenAttachmentViewer(viewerRawAttachments, index); }}
                            data-message-gesture-target="attachment"
                            disabled={isPending || openingImageViewer}
                            className={`relative block rounded-xl overflow-hidden bg-void-bg-hover focus:outline-none ${
                              imageEntries.length === 1 && singleAttachmentPresentation
                                ? 'max-w-full'
                                : getMultiAttachmentTileClass(visibleImages.length, index)
                            } ${isPending ? 'cursor-not-allowed' : ''}`}
                            style={imageEntries.length === 1 && singleAttachmentPresentation
                              ? {
                                  width: `${singleAttachmentPresentation.width}px`,
                                  aspectRatio: singleAttachmentPresentation.aspectRatio,
                                }
                              : imageEntries.length === 1
                                ? {
                                    width: `${SINGLE_ATTACHMENT_FALLBACK_WIDTH}px`,
                                  }
                                : undefined}
                          >
                            <AttachmentImage
                              attachment={attachment}
                              alt="attachment"
                              className="w-full h-full object-cover hover:opacity-90"
                              onLoad={onAttachmentLoad}
                              onDimensionsResolved={(dimensions) => {
                                if (imageEntries.length !== 1) return;
                                const layoutKey = getAttachmentLayoutKey(attachment, originalIndex);
                                setAttachmentDimensions((current) => {
                                  const existing = current[layoutKey];
                                  if (
                                    existing &&
                                    existing.width === dimensions.width &&
                                    existing.height === dimensions.height
                                  ) {
                                    return current;
                                  }

                                  return {
                                    ...current,
                                    [layoutKey]: dimensions,
                                  };
                                });
                              }}
                              canLoad={canLoadAttachments}
                            />
                            {hasHiddenAttachments ? (
                              <div className="absolute inset-0 flex items-center justify-center bg-black/45 text-white">
                                <span className="text-lg font-semibold tracking-tight">
                                  +{hiddenImageCount}
                                </span>
                              </div>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  );
                })()
              : null;

            const fileSection = fileEntries.length > 0 ? (
              <div className={`flex w-full flex-col gap-2 ${imageSection ? 'pt-2' : 'pt-1'}`}>
                {fileEntries.map(({ attachment, originalIndex }) => (
                  <AttachmentFileCard
                    key={`${originalIndex}-${attachment.url}`}
                    attachment={attachment}
                    disabled={isPending}
                  />
                ))}
              </div>
            ) : null;

            if (!imageSection && !fileSection) {
              return null;
            }

            return (
              <div
                ref={attachmentActionAnchorRef}
                className={`relative w-fit max-w-full ${isRightAligned ? 'self-end' : 'self-start'}`}
              >
                {imageSection ? <div className="pt-1">{imageSection}</div> : null}
                {fileSection}
              </div>
            );
          })()}

          {!message.is_deleted && inviteUrl && inviteCode && (
            <div className="pt-2">
              <InviteEmbed
                inviteCode={inviteCode}
                inviteUrl={inviteUrl}
                onOpenInvite={(url) => onOpenLink?.(url)}
              />
            </div>
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

          {isPending && message.attachments && message.attachments.length > 0 && (
            <div className={`pt-1 ${isRightAligned ? 'text-right' : 'text-left'}`}>
              <span className="text-[10px] italic text-void-text-muted">
                {pendingStatusLabel}
              </span>
            </div>
          )}
        </div>
        {desktopActionRail}
      </div>
    </div>
  );
}, areMessageItemPropsEqual);

export default MessageItem;
