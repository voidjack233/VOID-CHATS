import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowRight,
  CornerUpRight,
  FileText,
  Image,
  Pencil,
  RefreshCcw,
  Reply,
  Smile,
  Trash2,
} from 'lucide-react';
import type { Message } from '../../../Services/Chat/chatService';
import type { Attachment } from '../../../Services/Chat/chatTypes';
import type { Density } from '../../../Services/hooks/Settings/useTheme';
import ReactionBar from './ReactionBar';
import AttachmentImage from '../Attachments/AttachmentImage';
import AttachmentAudioPlayer, { isAudioAttachment } from '../Attachments/AttachmentAudioPlayer';
import AttachmentFileCard from '../Attachments/AttachmentFileCard';
import FormattedMessageText from './FormattedMessageText';
import InviteEmbed from './InviteEmbed';
import LinkPreviewCard from './LinkPreviewCard';
import MessagePreviewText from './MessagePreviewText';
import UserAvatar from '../../common/UserAvatar';
import { parseAttachment, parseAttachments } from '../../../Services/Chat/chatService';
import { CHAT_FORWARDED_MLS_MESSAGE_TYPE } from '../../../Services/Chat/chatUtils';
import { getMentionUsernames } from '../../../Services/Chat/messageMentions';
import { MAX_UNIQUE_REACTIONS_PER_MESSAGE, getUniqueReactionCount } from '../../../Services/Chat/reactionLimits';
import {
  getCachedAttachmentObjectUrl,
  resolveAttachmentObjectUrl,
} from '../../../Services/Crypto/attachmentEncryption';
import { getMessageDateLabel } from './useMessageLayout';
import {
  extractMessageTextSegments,
  getInviteCodeFromMessageUrl,
  isMessageUrlInsideSpoiler,
  messageTextContainsUrl,
} from './messageLinks';
import {
  getSingleAttachmentReservedPresentation,
  looksLikeImageAttachment,
  MULTI_ATTACHMENT_MAX_WIDTH,
} from '../Attachments/messageAttachmentLayout';

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
const UNAVAILABLE_REPLY_CONTENT = '[deleted or unavailable]';
const replyPreviewAttachmentUrlCache = new Map<string, string>();
const replyPreviewAttachmentUrlPromises = new Map<string, Promise<string>>();

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
  replyParentLoading?: boolean;
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
  onJumpToMessage?: (messageId: string) => void;
  onEdit?: (message: Message) => void;
  onRetryFailed?: (message: Message) => void;
  onDelete: (messageId: string) => void | Promise<void>;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onOpenImageViewer: (urls: string[], index: number) => void;
  onAttachmentLoad?: () => void;
  canLoadAttachments?: boolean;
  onOpenLink?: (url: string) => void;
  isHighlighted?: boolean;
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

function isUnavailableReplyPlaceholder(message: Message): boolean {
  return message.is_deleted && message.content === UNAVAILABLE_REPLY_CONTENT;
}

function getReplyAttachmentDisplayName(attachment: Attachment): string | null {
  if (attachment.name?.trim()) {
    return attachment.name.trim();
  }

  try {
    const pathname = new URL(attachment.url, window.location.origin).pathname;
    const lastSegment = pathname.split('/').pop();
    return lastSegment ? decodeURIComponent(lastSegment) : null;
  } catch {
    return null;
  }
}

function isTextReplyAttachment(attachment: Attachment): boolean {
  const mime = attachment.mime?.toLowerCase() || '';
  if (
    mime.startsWith('text/') ||
    mime.includes('json') ||
    mime.includes('javascript') ||
    mime.includes('xml')
  ) {
    return true;
  }

  const displayName = getReplyAttachmentDisplayName(attachment)?.toLowerCase() || '';
  return /\.(txt|md|json|js|jsx|ts|tsx|css|html|xml|py|rb|go|rs|java|c|cpp|h|sh|yaml|yml)$/i.test(displayName);
}

function getReplyAttachmentLabel(attachment: Attachment): string {
  if (looksLikeImageAttachment(attachment)) {
    return 'Photo';
  }

  if (attachment.name?.trim()) {
    return `File: ${attachment.name.trim()}`;
  }

  if (isTextReplyAttachment(attachment)) {
    return 'Text file';
  }

  const displayName = getReplyAttachmentDisplayName(attachment);
  if (displayName) {
    return `File: ${displayName}`;
  }

  return 'File';
}

function getReplyPreviewAttachmentCacheKey(attachment: Attachment): string {
  return [
    attachment.url || '',
    attachment.iv || '',
    attachment.key || '',
    attachment.mime || '',
    attachment.name || '',
  ].join('::');
}

interface CompactReplyPreviewProps {
  message: Message;
  replyParent: Message | null;
  replyParentLoading: boolean;
  canLoadAttachments: boolean;
  isOwn: boolean;
  isRightAligned: boolean;
  density: Density;
  replyFontSize: number;
  getSenderName: (senderId: string) => string;
  onJumpToMessage?: (messageId: string) => void;
}

const CompactReplyPreview = memo(function CompactReplyPreview({
  message,
  replyParent,
  replyParentLoading,
  canLoadAttachments,
  isOwn,
  isRightAligned,
  density,
  replyFontSize,
  getSenderName,
  onJumpToMessage,
}: CompactReplyPreviewProps) {
  const isUnavailable = Boolean(
    replyParent &&
    (replyParent.is_deleted || isUnavailableReplyPlaceholder(replyParent)),
  );
  const replyAttachments = useMemo(
    () => isUnavailable ? [] : parseAttachments(replyParent?.attachments),
    [isUnavailable, replyParent?.attachments],
  );
  const firstAttachment = replyAttachments[0] ?? null;
  const firstAttachmentIsImage = Boolean(firstAttachment && looksLikeImageAttachment(firstAttachment));
  const firstAttachmentIsSpoiler = firstAttachment?.spoiler === true;
  const firstAttachmentCacheKey = firstAttachment && firstAttachmentIsImage
    ? getReplyPreviewAttachmentCacheKey(firstAttachment)
    : null;
  const replyAttachmentConversationId =
    replyParent?.conversation_public_id ||
    replyParent?.conversation_id ||
    message.conversation_public_id ||
    message.conversation_id;
  const cachedThumbnailUrl = firstAttachment &&
    firstAttachmentIsImage &&
    !firstAttachmentIsSpoiler &&
    firstAttachmentCacheKey
    ? getCachedAttachmentObjectUrl(firstAttachment) ||
      (firstAttachment.encrypted === true ? null : replyPreviewAttachmentUrlCache.get(firstAttachmentCacheKey)) ||
      null
    : null;
  const [resolvedThumbnail, setResolvedThumbnail] = useState<{ cacheKey: string | null; url: string | null }>({
    cacheKey: firstAttachmentCacheKey,
    url: cachedThumbnailUrl,
  });
  const additionalAttachmentCount = Math.max(0, replyAttachments.length - 1);
  const replyAuthorName = isOwn ? 'You' : getSenderName(message.sender_id);
  const targetName = replyParent?.sender_id
    ? getSenderName(replyParent.sender_id)
    : 'a message';
  const isCompact = density === 'compact';
  const hasPreviewImage = Boolean(firstAttachmentIsImage);
  const thumbnailUrl = !firstAttachmentIsSpoiler ? (
    resolvedThumbnail.cacheKey === firstAttachmentCacheKey
      ? resolvedThumbnail.url
      : null
  ) || cachedThumbnailUrl : null;
  const replyImagePresentation = firstAttachment && firstAttachmentIsImage
    ? getSingleAttachmentReservedPresentation(firstAttachment)
    : null;
  const replyImageStyle: CSSProperties = replyImagePresentation
    ? {
        width: `${replyImagePresentation.width}px`,
        aspectRatio: replyImagePresentation.aspectRatio,
      }
    : {};
  const textShellClass = isCompact
    ? 'min-h-[34px] max-h-11 px-2 py-1'
    : 'min-h-[40px] max-h-14 px-2.5 py-1.5';
  const previewTextClass = isCompact
    ? 'line-clamp-1 max-h-4 leading-4'
    : 'line-clamp-2 max-h-8 leading-4';
  const shellToneClass = isOwn
    ? 'bg-void-accent/45 text-white/90 group-hover:bg-void-accent/55'
    : 'bg-void-bg-hover/55 text-void-text-muted group-hover:bg-void-bg-hover/70';
  const previewBubbleShapeClass = isRightAligned
    ? 'rounded-2xl rounded-br-md'
    : 'rounded-2xl rounded-bl-md';
  const stackWidthClass = isCompact ? 'max-w-[220px]' : 'max-w-[260px]';
  const stackInsetClass = isRightAligned ? 'items-end self-end' : 'items-start self-start';
  const previewClass = isOwn ? 'text-white/80' : 'text-void-text-muted';
  const mediaPlaceholderClass = isOwn ? 'bg-void-accent/45 text-white/80' : 'bg-void-bg-hover/65 text-void-text-muted';
  const hasReadableText = Boolean(
    replyParent?.content &&
    replyParent.content !== '[encrypted]' &&
    replyParent.content !== '[deleted]' &&
    replyParent.content !== UNAVAILABLE_REPLY_CONTENT,
  );
  const summaryFallback = !replyParent
    ? replyParentLoading
      ? 'Loading message...'
      : 'Message unavailable'
    : isUnavailable
      ? 'Message unavailable'
      : hasReadableText
        ? null
        : firstAttachment
          ? getReplyAttachmentLabel(firstAttachment)
          : replyParent.content === '[encrypted]'
            ? 'Encrypted message'
            : 'Message unavailable';
  const shouldShowTextPreview = hasReadableText || !hasPreviewImage;
  const hasTextAndImagePreview = hasPreviewImage && shouldShowTextPreview;
  useEffect(() => {
    if (
      !firstAttachment ||
      !firstAttachmentIsImage ||
      firstAttachmentIsSpoiler ||
      !firstAttachmentCacheKey
    ) {
      setResolvedThumbnail({ cacheKey: null, url: null });
      return undefined;
    }

    const cachedUrl = getCachedAttachmentObjectUrl(firstAttachment) ||
      (firstAttachment.encrypted === true ? null : replyPreviewAttachmentUrlCache.get(firstAttachmentCacheKey)) ||
      null;
    if (cachedUrl) {
      if (firstAttachment.encrypted !== true) {
        replyPreviewAttachmentUrlCache.set(firstAttachmentCacheKey, cachedUrl);
      }
      setResolvedThumbnail({ cacheKey: firstAttachmentCacheKey, url: cachedUrl });
      return undefined;
    }

    if (!canLoadAttachments) {
      setResolvedThumbnail({ cacheKey: firstAttachmentCacheKey, url: null });
      return undefined;
    }

    let cancelled = false;
    const pendingUrl = replyPreviewAttachmentUrlPromises.get(firstAttachmentCacheKey) ||
      resolveAttachmentObjectUrl(firstAttachment, { conversationId: replyAttachmentConversationId })
        .then((url) => {
          if (firstAttachment.encrypted !== true) {
            replyPreviewAttachmentUrlCache.set(firstAttachmentCacheKey, url);
          }
          replyPreviewAttachmentUrlPromises.delete(firstAttachmentCacheKey);
          return url;
        })
        .catch((error) => {
          replyPreviewAttachmentUrlPromises.delete(firstAttachmentCacheKey);
          throw error;
        });

    replyPreviewAttachmentUrlPromises.set(firstAttachmentCacheKey, pendingUrl);
    void pendingUrl
      .then((url) => {
        if (!cancelled) {
          setResolvedThumbnail({ cacheKey: firstAttachmentCacheKey, url });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedThumbnail({ cacheKey: firstAttachmentCacheKey, url: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    canLoadAttachments,
    firstAttachment,
    firstAttachmentCacheKey,
    firstAttachmentIsImage,
    firstAttachmentIsSpoiler,
    replyAttachmentConversationId,
  ]);

  return (
    <div className={`mb-0.5 flex max-w-full flex-col ${stackInsetClass}`}>
      <div
        className="mb-0.5 flex max-w-full items-center gap-1 truncate px-1 font-medium leading-3 text-void-text-muted"
        style={{ fontSize: `${Math.max(10, replyFontSize - 1)}px` }}
      >
        <CornerUpRight className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {replyAuthorName} replied to {targetName}
        </span>
      </div>

      <button
        type="button"
        className={`group block w-fit max-w-full border-0 bg-transparent p-0 text-left ${isRightAligned ? 'text-right' : 'text-left'}`}
        onClick={(event) => {
          event.stopPropagation();
          onJumpToMessage?.(message.reply_to!);
        }}
        title="Jump to replied message"
      >
        {hasTextAndImagePreview ? (
          <div
            data-reply-media-stack="true"
            className={`flex w-fit max-w-full flex-col ${isRightAligned ? 'items-end' : 'items-start'} ${isCompact ? 'gap-1' : 'gap-1.5'}`}
          >
            <div
              data-reply-text-bubble="true"
              className={`my-0 flex w-fit max-w-full items-center overflow-hidden transition-colors ${stackWidthClass} ${shellToneClass} ${previewBubbleShapeClass} ${textShellClass}`}
            >
              <div
                className={`overflow-hidden break-words ${previewClass} ${previewTextClass}`}
                style={{ fontSize: `${replyFontSize}px` }}
              >
                <MessagePreviewText
                  content={replyParent?.content}
                  maxLength={120}
                  fallback="Message unavailable"
                />
              </div>
            </div>

            <div
              data-reply-thumbnail="true"
              className={`relative flex max-w-full shrink-0 items-center justify-center overflow-hidden rounded-xl shadow-sm transition-opacity group-hover:opacity-95 ${mediaPlaceholderClass}`}
              style={replyImageStyle}
            >
              {firstAttachmentIsSpoiler ? (
                <span className="rounded bg-black/55 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white">
                  Spoiler
                </span>
              ) : thumbnailUrl ? (
                <img
                  src={thumbnailUrl}
                  alt=""
                  className="h-full w-full object-cover opacity-70 saturate-75 brightness-75 transition-opacity group-hover:opacity-85"
                  loading="lazy"
                />
              ) : firstAttachmentIsImage ? (
                <Image className="h-4 w-4" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
              {additionalAttachmentCount > 0 ? (
                <span className="absolute bottom-0.5 right-0.5 rounded bg-black/65 px-1 text-[9px] font-semibold leading-3 text-white">
                  +{additionalAttachmentCount}
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex w-fit max-w-full flex-col items-start gap-0.5">
            {shouldShowTextPreview ? (
              <div
                data-reply-text-bubble="true"
                className={`my-0 flex w-fit max-w-full items-center overflow-hidden transition-colors ${stackWidthClass} ${shellToneClass} ${previewBubbleShapeClass} ${textShellClass}`}
              >
                <div
                  className={`overflow-hidden break-words ${previewClass} ${previewTextClass}`}
                  style={{ fontSize: `${replyFontSize}px` }}
                >
                  {hasReadableText ? (
                    <MessagePreviewText
                      content={replyParent?.content}
                      maxLength={120}
                      fallback="Message unavailable"
                    />
                  ) : (
                    <span className={isUnavailable ? 'italic opacity-70' : ''}>
                      {summaryFallback}
                    </span>
                  )}
                </div>
              </div>
            ) : null}

            {hasPreviewImage && firstAttachment ? (
              <div
                data-reply-thumbnail="true"
                className={`relative flex max-w-full shrink-0 items-center justify-center overflow-hidden rounded-xl shadow-sm transition-opacity group-hover:opacity-95 ${mediaPlaceholderClass}`}
                style={replyImageStyle}
              >
                {firstAttachmentIsSpoiler ? (
                  <span className="rounded bg-black/55 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-white">
                    Spoiler
                  </span>
                ) : thumbnailUrl ? (
                  <img
                    src={thumbnailUrl}
                    alt=""
                    className="h-full w-full object-cover opacity-70 saturate-75 brightness-75 transition-opacity group-hover:opacity-85"
                    loading="lazy"
                  />
                ) : firstAttachmentIsImage ? (
                  <Image className="h-4 w-4" />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
                {additionalAttachmentCount > 0 ? (
                  <span className="absolute bottom-0.5 right-0.5 rounded bg-black/65 px-1 text-[9px] font-semibold leading-3 text-white">
                    +{additionalAttachmentCount}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </button>
    </div>
  );
});

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
  prev.replyParentLoading === next.replyParentLoading &&
  prev.messageReactions === next.messageReactions &&
  prev.formatTime === next.formatTime &&
  prev.getSenderName === next.getSenderName &&
  prev.getSenderUsername === next.getSenderUsername &&
  prev.getSenderAvatarUrl === next.getSenderAvatarUrl &&
  prev.onJumpToMessage === next.onJumpToMessage &&
  prev.isHighlighted === next.isHighlighted &&
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
  replyParentLoading = false,
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
  onJumpToMessage,
  onEdit,
  onRetryFailed,
  onDelete,
  onToggleReaction,
  onOpenImageViewer,
  onAttachmentLoad,
  canLoadAttachments = true,
  onOpenLink,
  isHighlighted = false,
}: MessageItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [openingImageViewer, setOpeningImageViewer] = useState(false);
  const [revealedEmbedSpoilers, setRevealedEmbedSpoilers] = useState<{
    messageKey: string;
    spoilerIds: Set<string>;
    coverRevealed: boolean;
  }>(() => ({
    messageKey: '',
    spoilerIds: new Set(),
    coverRevealed: false,
  }));
  const [revealedSpoilerAttachments, setRevealedSpoilerAttachments] = useState<Set<string>>(
    () => new Set(),
  );
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
  const isFailed = message.local_status === 'failed';
  const isPending = isSending || isQueued;
  const pendingStatusLabel = isQueued ? 'queued' : 'sending...';
  const failedStatusLabel = 'failed to send';
  const attachmentConversationId = message.conversation_public_id || message.conversation_id;
  const isRightAligned = isOwn && density === 'comfortable';
  const canSwipeReply = Boolean(onReply && !isFailed);
  const canSwipeEdit = Boolean(isOwn && onEdit && !isFailed);
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
  const audioAttachmentEntries = useMemo(
    () => attachmentEntries.filter(({ attachment }) => !looksLikeImageAttachment(attachment) && isAudioAttachment(attachment)),
    [attachmentEntries],
  );
  const fileAttachmentEntries = useMemo(
    () => attachmentEntries.filter(({ attachment }) => !looksLikeImageAttachment(attachment) && !isAudioAttachment(attachment)),
    [attachmentEntries],
  );
  const singleImageEntry = imageAttachmentEntries.length === 1 ? imageAttachmentEntries[0] : null;
  const singleImagePresentation = singleImageEntry
    ? getSingleAttachmentReservedPresentation(singleImageEntry.attachment)
    : null;
  const singleImageStyle: CSSProperties | undefined = singleImagePresentation
    ? {
        width: `${singleImagePresentation.width}px`,
        aspectRatio: singleImagePresentation.aspectRatio,
      }
    : undefined;

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
    setRevealedSpoilerAttachments(new Set());
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
        parseAttachments(attachmentUrls).map((attachment) =>
          resolveAttachmentObjectUrl(attachment, { conversationId: attachmentConversationId })
        )
      );
      onOpenImageViewer(resolvedUrls, index);
    } catch (error) {
      console.error('Failed to open attachment viewer:', error);
    } finally {
      setOpeningImageViewer(false);
    }
  }, [attachmentConversationId, isPending, onOpenImageViewer, openingImageViewer]);
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
  const firstMessageUrl = useMemo(() => {
    if (!message.content || message.content === '[encrypted]') return null;
    const firstLink = extractMessageTextSegments(message.content).find(
      (segment) => segment.type === 'link',
    );
    return firstLink?.type === 'link' ? firstLink.url : null;
  }, [message.content]);
  // Preview metadata may contain the final redirected URL. Associate it with
  // the original URL in the message so spoiler detection remains accurate.
  const embeddedUrl = inviteUrl || firstMessageUrl || message.link_preview?.url || null;
  const embeddedSpoilerMessageKey = `${message.message_id}:${message.content || ''}:${embeddedUrl || ''}`;
  const isEmbeddedUrlSpoilered = useMemo(() => Boolean(
    embeddedUrl &&
    message.content &&
    isMessageUrlInsideSpoiler(message.content, embeddedUrl)
  ), [embeddedUrl, message.content]);
  const revealedEmbedSpoilerIds =
    revealedEmbedSpoilers.messageKey === embeddedSpoilerMessageKey
      ? revealedEmbedSpoilers.spoilerIds
      : new Set<string>();
  const isEmbedCoverRevealed =
    revealedEmbedSpoilers.messageKey === embeddedSpoilerMessageKey &&
    revealedEmbedSpoilers.coverRevealed;
  const shouldCoverEmbeddedContent =
    isEmbeddedUrlSpoilered &&
    revealedEmbedSpoilerIds.size === 0 &&
    !isEmbedCoverRevealed;

  const handleSpoilerVisibilityChange = useCallback((
    spoilerId: string,
    spoilerContent: string,
    revealed: boolean,
  ) => {
    if (!embeddedUrl || !messageTextContainsUrl(spoilerContent, embeddedUrl)) {
      return;
    }

    setRevealedEmbedSpoilers((current) => {
      const next = new Set(
        current.messageKey === embeddedSpoilerMessageKey
          ? current.spoilerIds
          : [],
      );
      if (revealed) {
        next.add(spoilerId);
      } else {
        next.delete(spoilerId);
      }
      return {
        messageKey: embeddedSpoilerMessageKey,
        spoilerIds: next,
        coverRevealed:
          current.messageKey === embeddedSpoilerMessageKey
            ? current.coverRevealed
            : false,
      };
    });
  }, [embeddedSpoilerMessageKey, embeddedUrl]);

  const handleRevealEmbedCover = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setRevealedEmbedSpoilers((current) => ({
      messageKey: embeddedSpoilerMessageKey,
      spoilerIds:
        current.messageKey === embeddedSpoilerMessageKey
          ? new Set(current.spoilerIds)
          : new Set(),
      coverRevealed: true,
    }));
  }, [embeddedSpoilerMessageKey]);

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

    if (!allowsMessageGesture && !explicitGestureAllowance && target?.closest('button, a, input, textarea, audio')) {
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

  const handleRetryFailedClick = useCallback((event?: React.MouseEvent<HTMLElement>) => {
    event?.preventDefault();
    event?.stopPropagation();
    blurActiveComposer();
    onRetryFailed?.(message);
  }, [blurActiveComposer, message, onRetryFailed]);

  const failedSendControls = isFailed ? (
    <div className={`pt-1 ${isRightAligned ? 'self-end text-right' : 'self-start text-left'}`}>
      <div className={`flex flex-wrap items-center gap-2 ${isRightAligned ? 'justify-end' : 'justify-start'}`}>
        <span className="text-[10px] italic text-orange-300">
          {failedStatusLabel}
        </span>
        {onRetryFailed && (
          <button
            type="button"
            onClick={handleRetryFailedClick}
            className="inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-300 transition-colors hover:bg-orange-500/25"
          >
            <RefreshCcw className="h-3 w-3" />
            Retry
          </button>
        )}
      </div>
    </div>
  ) : null;

  const updateDesktopActionRailPosition = useCallback(() => {
    if (!isHovered || isPending || isFailed || message.is_deleted) {
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
    const composerTop = document
      .querySelector<HTMLElement>('[data-chat-message-input="true"]')
      ?.getBoundingClientRect()
      .top ?? viewportHeight;
    const minTop = Math.max(minInset, headerBottom + gap);
    const maxTop = Math.max(
      minTop,
      Math.min(
        viewportHeight - railHeight - minInset,
        composerTop - railHeight - gap,
      ),
    );
    const preferredTop = rect.top + ((rect.height - railHeight) / 2);

    const nextLeft = isRightAligned
      ? Math.max(minInset, rect.left - railWidth - gap)
      : Math.min(viewportWidth - railWidth - minInset, rect.right + gap);
    const nextTop = Math.min(
      maxTop,
      Math.max(minTop, preferredTop),
    );

    setDesktopActionRailStyle({
      left: `${Math.round(nextLeft)}px`,
      top: `${Math.round(nextTop)}px`,
    });
  }, [attachmentEntries.length, isFailed, isHovered, isPending, isRightAligned, message.is_deleted]);

  useLayoutEffect(() => {
    updateDesktopActionRailPosition();
  }, [updateDesktopActionRailPosition]);

  useEffect(() => {
    if (!isHovered || isPending || isFailed || message.is_deleted) return;

    const handleReposition = () => updateDesktopActionRailPosition();

    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [isFailed, isHovered, isPending, message.is_deleted, updateDesktopActionRailPosition]);

  const desktopActionRail = !message.is_deleted && !isPending && !isFailed ? (
    <div
      ref={desktopActionRailRef}
      className={`fixed z-30 hidden md:flex items-center gap-0.5 rounded-md border border-void-bg-hover bg-void-bg-main p-0.5 shadow-lg transition-opacity ${
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
  const messageHasRealContent = Boolean(message.content && message.content !== '[encrypted]');
  const messageTextBubble = message.is_deleted ? (
    <div
      className={`${d.bubblePadding} rounded-2xl italic text-void-text-muted bg-void-bg-hover/50`}
      style={{ fontSize: `${bubbleFontSize}px` }}
    >
      [deleted]
    </div>
  ) : (() => {
    if (!messageHasRealContent && message.attachments?.length) return null;

    return (
      <div
        ref={textActionAnchorRef}
        className={`min-w-0 max-w-full overflow-hidden ${d.bubblePadding} rounded-2xl whitespace-pre-wrap break-words ${
          isRightAligned
            ? 'rounded-br-sm bg-void-accent text-white'
            : isOwn
              ? 'rounded-bl-sm bg-void-accent text-white'
              : 'rounded-bl-sm bg-void-bg-hover text-void-text'
        } ${isPending ? 'brightness-90' : ''} ${isFailed ? 'ring-1 ring-orange-400/45' : ''}`}
        style={{ fontSize: `${bubbleFontSize}px` }}
      >
        {messageHasRealContent ? (
          <FormattedMessageText
            content={message.content || ''}
            linkClassName={linkClassName}
            onOpenLink={onOpenLink}
            onSpoilerVisibilityChange={handleSpoilerVisibilityChange}
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
  })();
  const replyPreviewElement = message.reply_to ? (
    <CompactReplyPreview
      message={message}
      replyParent={replyParent}
      replyParentLoading={replyParentLoading}
      canLoadAttachments={canLoadAttachments}
      isOwn={isOwn}
      isRightAligned={isRightAligned}
      density={density}
      replyFontSize={replyFontSize}
      getSenderName={getSenderName}
      onJumpToMessage={onJumpToMessage}
    />
  ) : null;

  if (isSystem) {
    const hasContent = typeof message.content === 'string' && message.content.trim().length > 0;
    return (
      <div
        data-message-id={message.message_id}
        className={`px-2 transition-colors duration-300 ${isHighlighted ? 'rounded-2xl bg-void-accent/15 ring-1 ring-void-accent/35 animate-pulse' : ''}`}
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
      className={`px-2 transition-colors duration-300 ${isHighlighted ? 'rounded-2xl bg-void-accent/15 ring-1 ring-void-accent/35 animate-pulse' : ''}`}
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
          {replyPreviewElement}

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

          {messageTextBubble}

          {!message.is_deleted && message.attachments && message.attachments.length > 0 && (() => {
            const imageEntries = imageAttachmentEntries;
            const audioEntries = audioAttachmentEntries;
            const fileEntries = fileAttachmentEntries;

            const imageSection = imageEntries.length > 0
              ? (() => {
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
                      style={imageEntries.length === 1 ? undefined : {
                        width: `${MULTI_ATTACHMENT_MAX_WIDTH}px`,
                        maxWidth: '100%',
                      }}
                    >
                      {visibleImages.map(({ attachment, originalIndex }, index) => {
                        const hasHiddenAttachments = hiddenImageCount > 0 && index === visibleImages.length - 1;
                        const layoutKey = getAttachmentLayoutKey(attachment, originalIndex);
                        const isSpoilerCovered =
                          attachment.spoiler === true &&
                          !revealedSpoilerAttachments.has(layoutKey);

                        return (
                          <button
                            key={`${originalIndex}-${attachment.url}`}
                            onClick={() => {
                              if (isSpoilerCovered) {
                                setRevealedSpoilerAttachments((current) => {
                                  const next = new Set(current);
                                  next.add(layoutKey);
                                  return next;
                                });
                                return;
                              }
                              void handleOpenAttachmentViewer(viewerRawAttachments, index);
                            }}
                            data-message-gesture-target="attachment"
                            disabled={isPending || openingImageViewer}
                            className={`relative block rounded-xl overflow-hidden bg-void-bg-hover focus:outline-none ${
                              imageEntries.length === 1
                                ? 'max-w-full'
                                : getMultiAttachmentTileClass(visibleImages.length, index)
                            } ${isPending ? 'cursor-not-allowed' : ''}`}
                            style={imageEntries.length === 1 ? singleImageStyle : undefined}
                          >
                            <AttachmentImage
                              attachment={attachment}
                              conversationId={attachmentConversationId}
                              alt="attachment"
                              className="w-full h-full object-cover hover:opacity-90"
                              onLoad={onAttachmentLoad}
                              canLoad={canLoadAttachments}
                            />
                            {isSpoilerCovered ? (
                              <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden bg-void-bg-main">
                                <span className="relative rounded bg-black/55 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-white">
                                  Spoiler
                                </span>
                              </div>
                            ) : null}
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

            const audioSection = audioEntries.length > 0 ? (
              <div className={`flex w-full flex-col gap-2 ${imageSection ? 'pt-2' : 'pt-1'}`}>
                {audioEntries.map(({ attachment, originalIndex }) => (
                  <AttachmentAudioPlayer
                    key={`${originalIndex}-${attachment.url}`}
                    attachment={attachment}
                    conversationId={attachmentConversationId}
                    disabled={isPending}
                    canLoad={canLoadAttachments}
                    onLoad={onAttachmentLoad}
                  />
                ))}
              </div>
            ) : null;
            const hasRichAttachmentSection = Boolean(imageSection || audioSection);

            const fileSection = fileEntries.length > 0 ? (
              <div className={`flex w-full flex-col gap-2 ${hasRichAttachmentSection ? 'pt-2' : 'pt-1'}`}>
                {fileEntries.map(({ attachment, originalIndex }) => (
                  <AttachmentFileCard
                    key={`${originalIndex}-${attachment.url}`}
                    attachment={attachment}
                    conversationId={attachmentConversationId}
                    disabled={isPending}
                  />
                ))}
              </div>
            ) : null;

            if (!imageSection && !audioSection && !fileSection) {
              return null;
            }

            return (
              <div
                ref={attachmentActionAnchorRef}
                className={`relative w-fit max-w-full ${isRightAligned ? 'self-end' : 'self-start'}`}
              >
                {imageSection ? <div className="pt-1">{imageSection}</div> : null}
                {audioSection}
                {fileSection}
              </div>
            );
          })()}

          {!message.is_deleted && inviteUrl && inviteCode && (
            <div className="pt-2">
              <div className="relative">
                <InviteEmbed
                  inviteCode={inviteCode}
                  inviteUrl={inviteUrl}
                  onOpenInvite={(url) => onOpenLink?.(url)}
                />
                {shouldCoverEmbeddedContent ? (
                  <button
                    type="button"
                    data-allow-message-gesture="true"
                    onClick={handleRevealEmbedCover}
                    className="absolute inset-0 z-10 flex touch-manipulation select-none items-center justify-center rounded-2xl border border-white/5 bg-void-bg-main text-void-text transition-colors hover:bg-void-bg-hover focus:outline-none focus:ring-2 focus:ring-void-accent/40"
                    aria-label="Reveal spoiler preview"
                    title="Reveal spoiler"
                  >
                    <span className="rounded bg-black/45 px-2 py-1 text-[11px] font-bold uppercase tracking-[0.12em]">
                      Spoiler
                    </span>
                  </button>
                ) : null}
              </div>
            </div>
          )}

          {!message.is_deleted &&
            message.link_preview &&
            !inviteUrl && (
            <div className={`pt-2 ${isRightAligned ? 'self-end' : 'self-start'}`}>
              <div className="relative">
                <LinkPreviewCard
                  preview={message.link_preview}
                  onOpenLink={onOpenLink}
                  onMediaLoad={onAttachmentLoad}
                />
                {shouldCoverEmbeddedContent ? (
                  <button
                    type="button"
                    data-allow-message-gesture="true"
                    onClick={handleRevealEmbedCover}
                    className="absolute inset-0 z-10 flex touch-manipulation select-none items-center justify-center rounded-2xl border border-white/5 bg-void-bg-main text-void-text transition-colors hover:bg-void-bg-hover focus:outline-none focus:ring-2 focus:ring-void-accent/40"
                    aria-label="Reveal spoiler preview"
                    title="Reveal spoiler"
                  >
                    <span className="rounded bg-black/45 px-2 py-1 text-[11px] font-bold uppercase tracking-[0.12em]">
                      Spoiler
                    </span>
                  </button>
                ) : null}
              </div>
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
          {failedSendControls}
        </div>
        {desktopActionRail}
      </div>
    </div>
  );
}, areMessageItemPropsEqual);

export default MessageItem;
