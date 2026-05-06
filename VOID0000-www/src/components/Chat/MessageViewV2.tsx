import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowDown, Loader2 } from 'lucide-react';
import { useMessageList } from '../../Services/hooks/Chats/useMessageList';
import { useMessageDisplay } from '../../Services/hooks/Chats/useMessageDisplay';
import { useReactions } from '../../Services/hooks/Chats/useReactions';
import type { ConversationSecurityState } from '../../Services/Chat/conversationSecurityState';
import {
  parseAttachments,
  sendImageOnlyMessage,
  sendMessage,
} from '../../Services/Chat/chatService';
import { MESSAGE_PAGE_SIZE } from '../../Services/Chat/chatConstants';
import { type Conversation, type ConversationMember, type Message } from '../../Services/Chat/chatService';
import { isEncryptedAttachment, resolveAttachmentObjectUrl } from '../../Services/Crypto/attachmentEncryption';
import { useUser } from '../../Services/Auth/UserContext';
import { useFriends } from '../../Services/hooks/Friends/useFriends';
import { useProfileRecord } from '../../Services/hooks/profile/useProfileRecord';
import { useTheme, type Density } from '../../Services/hooks/Settings/useTheme';
import { formatConversationPreview, setConversationPreview } from '../../Services/Chat/conversationPreviewCache';
import { MessageViewSkeleton, Skeleton } from '../common/Skeleton';
import MessageItem from './MessageItem';
import MessageOverlays from './MessageOverlays';
import MessageViewHeader, { buildMessageViewHeaderIdentity } from './MessageViewHeader';
import {
  getMessageLinkHostname,
  isTrustedMessageUrl,
} from './messageLinks';
import ExternalLinkModal from './MessageViewParts/ExternalLinkModal';
import TypingIndicator, { type TypingParticipant } from './TypingIndicator';
import { useMessageActions } from './useMessageActions';
import { useMessageLayout } from './useMessageLayout';
import type {
  MessageDelete,
  MessageStreamEvent,
  MessageUpdate,
} from '../../Services/hooks/Chats/MessageList/messageListTypes';

interface MessageViewProps {
  conversation: Conversation;
  encryptionKey: CryptoKey | null;
  keyVersion?: number;
  encryptionError?: string | null;
  conversationSecurityState?: ConversationSecurityState;
  sendNotice?: string | null;
  onSendNotice?: (message: string | null) => void;
  members: Record<string, ConversationMember>;
  typingParticipants?: TypingParticipant[];
  onReply?: (message: Message) => void;
  onForward?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  messageEvents?: MessageStreamEvent[];
  userAvatar?: string;
  gateway?: any;
  messageUpdate?: MessageUpdate | null;
  messageDelete?: MessageDelete | null;
}

type MessageListItem =
  | { kind: 'message'; message: Message }
  | { kind: 'typing'; id: 'typing-indicator' };

type HistoryRangeStatus = 'idle' | 'loading' | 'loaded' | 'error';

interface OlderLoadScrollSnapshot {
  scrollHeight: number;
  scrollTop: number;
}

const normalizeText = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

const defaultLayoutTraits = Object.freeze({ startsGroup: true, showDateSeparator: false });
const emptyReactions: Record<string, unknown> = Object.freeze({});
const BOTTOM_THRESHOLD = 16;
const OLDER_LOAD_SCROLL_UPDATE_THRESHOLD = 1;
const UNDERFILL_AUTOFILL_THRESHOLD = 48;
const OLDER_HISTORY_LOADER_SLOT_HEIGHT: Record<Density, number> = {
  compact: 268,
  comfortable: 216,
};
const OLDER_HISTORY_PREFETCH_DISTANCE: Record<Density, number> = {
  compact: 720,
  comfortable: 640,
};
const NEWER_HISTORY_PREFETCH_DISTANCE: Record<Density, number> = {
  compact: 720,
  comfortable: 640,
};
const HISTORY_LOGICAL_ROW_ESTIMATE: Record<Density, number> = {
  compact: 56,
  comfortable: 76,
};
const ESTIMATED_MESSAGE_ROW_HEIGHT: Record<Density, number> = {
  compact: 56,
  comfortable: 76,
};
const MAX_VISIBLE_SKELETON_ROWS = 16;

// IntersectionObserver catches the exact boundary. The scroll handler below
// starts history fetches earlier so fast scrolling is less likely to hit a
// temporary loading wall at either edge of the active message window.
const OLDER_SENTINEL_ROOT_MARGIN = '0px 0px 0px 0px';

const OLDER_SKELETON_PATTERNS: Record<Density, number[][]> = {
  compact: [
    [1, 2, 1],
    [2, 1, 2],
    [1, 1, 3],
    [3, 1, 1],
  ],
  comfortable: [
    [1, 2],
    [2, 1],
    [1, 3],
  ],
};

const OLDER_SKELETON_BUBBLE_WIDTHS = [
  'w-[54%] sm:w-[42%]',
  'w-[72%] sm:w-[56%]',
  'w-[46%] sm:w-[36%]',
  'w-[82%] sm:w-[64%]',
  'w-[62%] sm:w-[48%]',
  'w-[38%] sm:w-[30%]',
];

const OLDER_SKELETON_META_WIDTHS = [
  'w-16',
  'w-20',
  'w-24',
  'w-14',
];

function hashSkeletonSeed(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

const OlderHistorySkeleton = memo(function OlderHistorySkeleton({
  density,
  seed,
  rowCount,
  active = false,
}: {
  density: Density;
  seed: string;
  rowCount?: number;
  active?: boolean;
}) {
  const hash = hashSkeletonSeed(seed);
  const patterns = OLDER_SKELETON_PATTERNS[density];
  const pattern = rowCount
    ? Array.from({ length: rowCount }, (_, index) => {
        const maxBubbles = density === 'comfortable' ? 2 : 3;
        return 1 + ((hash + index) % maxBubbles);
      })
    : patterns[hash % patterns.length] || patterns[0]!;

  return (
    <div className={`pointer-events-none flex h-full w-full flex-col overflow-hidden px-2 transition-opacity ${active ? 'opacity-100' : 'opacity-75'} ${rowCount ? 'justify-start' : 'justify-center'} ${density === 'comfortable' ? 'gap-4 py-4' : 'gap-3 py-3'}`}>
      {pattern.map((bubbleCount, groupIndex) => {
        const isOutgoing = density === 'comfortable'
          ? (rowCount ? (hash + groupIndex) % 4 === 1 : groupIndex === pattern.length - 1 && hash % 2 === 1)
          : false;
        const contentMaxWidth = density === 'comfortable'
          ? 'max-w-[80%] md:max-w-[70%]'
          : 'max-w-[88%] md:max-w-[85%]';
        const bubbleHeight = density === 'comfortable' ? 'h-10' : 'h-8';
        const avatarSize = 'h-8 w-8';

        return (
          <div
            key={`${groupIndex}-${bubbleCount}`}
            className={`flex w-full max-w-full ${isOutgoing ? 'justify-end' : 'justify-start'}`}
          >
            <div className={`flex w-full ${contentMaxWidth} items-start gap-2 ${isOutgoing ? 'flex-row-reverse' : 'flex-row'}`}>
              {!isOutgoing && (
                <Skeleton className={avatarSize} rounded="full" />
              )}
              <div className={`flex min-w-0 flex-1 flex-col gap-1.5 ${isOutgoing ? 'items-end' : 'items-start'}`}>
                {!isOutgoing && (
                  <Skeleton
                    className={`h-3 ${OLDER_SKELETON_META_WIDTHS[(hash + groupIndex) % OLDER_SKELETON_META_WIDTHS.length]}`}
                  />
                )}
                {Array.from({ length: bubbleCount }).map((_, bubbleIndex) => (
                  <Skeleton
                    key={`${groupIndex}-${bubbleIndex}`}
                    className={`${bubbleHeight} ${OLDER_SKELETON_BUBBLE_WIDTHS[(hash + groupIndex + bubbleIndex) % OLDER_SKELETON_BUBBLE_WIDTHS.length]} max-w-full`}
                    rounded="2xl"
                  />
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});

const estimateMessageRowHeight = (message: Message, density: Density): number => {
  if (message.message_type === 'system') {
    return density === 'comfortable' ? 44 : 36;
  }

  const baseHeight = ESTIMATED_MESSAGE_ROW_HEIGHT[density];
  const content = typeof message.content === 'string' ? message.content : '';
  const approxCharsPerLine = density === 'comfortable' ? 44 : 52;
  const approxLines = Math.max(1, Math.ceil(content.length / approxCharsPerLine));
  const textHeight = Math.min(180, approxLines * (density === 'comfortable' ? 22 : 19));
  const attachmentHeight = parseAttachments(message.attachments).length > 0
    ? (density === 'comfortable' ? 240 : 200)
    : 0;
  const replyHeight = message.reply_to ? 38 : 0;
  const forwardedHeight = message.forwarded ? 24 : 0;

  return Math.max(baseHeight, baseHeight + textHeight + attachmentHeight + replyHeight + forwardedHeight);
};

const MessageViewV2 = memo(function MessageViewV2({
  conversation,
  encryptionKey,
  keyVersion,
  encryptionError,
  conversationSecurityState,
  sendNotice,
  onSendNotice,
  members,
  typingParticipants = [],
  onReply,
  onForward,
  onEdit,
  messageEvents = [],
  userAvatar,
  gateway,
  messageUpdate,
  messageDelete,
}: MessageViewProps) {
  const { user } = useUser();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const olderSentinelRef = useRef<HTMLDivElement | null>(null);
  const newerSentinelRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const forceFollowOutputRef = useRef(false);
  const initialLatestRestoreDoneRef = useRef(false);
  const previousListCountRef = useRef(0);
  const lastFollowedMessageEventSequenceRef = useRef(0);
  const pendingOlderLoadScrollSnapshotRef = useRef<OlderLoadScrollSnapshot | null>(null);
  const hasOlderRef = useRef(false);
  const loadingOlderStateRef = useRef(false);
  const loadingOlderRequestInFlightRef = useRef(false);
  const loadingNewerRequestInFlightRef = useRef(false);
  const autofillOlderRequestInFlightRef = useRef(false);
  const messageHeightCacheRef = useRef<Map<string, number>>(new Map());
  const [pendingExternalLink, setPendingExternalLink] = useState<{ url: string; hostname: string } | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [olderRangeError, setOlderRangeError] = useState(false);
  const [newerRangeError, setNewerRangeError] = useState(false);


  const { density, messageGroupSpacing, chatFontScale } = useTheme();
  const olderHistoryLoaderSlotHeight = OLDER_HISTORY_LOADER_SLOT_HEIGHT[density];
  const olderTopLoadThreshold = OLDER_HISTORY_PREFETCH_DISTANCE[density];
  const historyLogicalRowEstimate = HISTORY_LOGICAL_ROW_ESTIMATE[density];
  const historyLogicalSlotHeight = Math.max(
    olderHistoryLoaderSlotHeight,
    MESSAGE_PAGE_SIZE * historyLogicalRowEstimate,
  );
  const olderTopScrollLockThreshold = 2;
  const newerBottomLoadThreshold = NEWER_HISTORY_PREFETCH_DISTANCE[density];
  const { friends } = useFriends();
  const { profile: myProfile } = useProfileRecord(user?.profile_id || '');
  const currentMember = user?.id ? members[user.id] || null : null;
  const waitForEncryptionBootstrap = !encryptionKey && conversationSecurityState?.status === 'recovering';
  const getMessageHeightForWindowing = useCallback((message: Message) => {
    const cachedHeight = messageHeightCacheRef.current.get(String(message.message_id));
    if (typeof cachedHeight === 'number' && Number.isFinite(cachedHeight) && cachedHeight > 0) {
      return cachedHeight;
    }
    return estimateMessageRowHeight(message, density);
  }, [density]);
  const initReactionsFromMessagesRef = useRef<(messages: Array<{ message_id: string; reactions?: any }>) => void>(() => {});
  const handleInitReactionsFromMessages = useCallback((loadedMessages: Array<{ message_id: string; reactions?: any }>) => {
    initReactionsFromMessagesRef.current(loadedMessages);
  }, []);

  const {
    messages,
    loading,
    initialHydrationSettled,
    loadingOlder,
    loadingNewer,
    hasOlder,
    hasNewer,
    isAtPresent,
    runtimeStats,
    topSpacerHeight,
    bottomSpacerHeight,
    groupBreakBeforeIds,
    setIsAtPresent,
    handleDelete,
    getReplyParent,
    mergeVisibleMessages,
    jumpToPresent,
    loadOlder,
    loadNewer,
  } = useMessageList(
    conversation,
    user?.id,
    currentMember,
    encryptionKey,
    keyVersion,
    messageEvents,
    messageUpdate,
    messageDelete,
    handleInitReactionsFromMessages,
    waitForEncryptionBootstrap,
    { getMessageHeight: getMessageHeightForWindowing },
  );
  hasOlderRef.current = hasOlder;
  loadingOlderStateRef.current = loadingOlder;

  const { reactions, handleToggleReaction, initReactionsFromMessages } =
    useReactions(conversation.id, gateway, user?.id, isAtPresent);
  initReactionsFromMessagesRef.current = initReactionsFromMessages;

  const { formatTime, getSenderName, getSenderAvatarUrl } = useMessageDisplay(members, userAvatar);
  const visualMessages = messages;
  const layoutTraitsById = useMessageLayout(visualMessages, groupBreakBeforeIds, hasOlder);
  const retryingFailedMessageIdsRef = useRef<Set<string>>(new Set());
  const olderSkeletonSeed = `${conversation.id}:${visualMessages[0]?.message_id || 'empty'}`;
  const newerSkeletonSeed = `${conversation.id}:${visualMessages[visualMessages.length - 1]?.message_id || 'empty'}:newer`;
  const topTrimmedSpacerHeight = Math.max(0, topSpacerHeight);
  const bottomTrimmedSpacerHeight = Math.max(0, bottomSpacerHeight);
  const topEstimatedLoadingHeight = hasOlder && topTrimmedSpacerHeight <= 1 ? historyLogicalSlotHeight : 0;
  const bottomEstimatedLoadingHeight = hasNewer && bottomTrimmedSpacerHeight <= 1 ? historyLogicalSlotHeight : 0;
  const topLogicalRangeHeight = topTrimmedSpacerHeight + topEstimatedLoadingHeight;
  const bottomLogicalRangeHeight = bottomTrimmedSpacerHeight + bottomEstimatedLoadingHeight;
  const olderRangeStatus: HistoryRangeStatus = loadingOlder
    ? 'loading'
    : olderRangeError
      ? 'error'
    : topLogicalRangeHeight <= 1
      ? 'loaded'
      : hasOlder
        ? 'idle'
        : 'error';
  const newerRangeStatus: HistoryRangeStatus = loadingNewer
    ? 'loading'
    : newerRangeError
      ? 'error'
    : bottomLogicalRangeHeight <= 1
      ? 'loaded'
      : hasNewer
        ? 'idle'
        : 'error';
  const olderTopExhaustionThreshold = topLogicalRangeHeight + 8;
  const historySkeletonRowCount = Math.max(
    4,
    Math.min(MAX_VISIBLE_SKELETON_ROWS, Math.ceil(historyLogicalSlotHeight / historyLogicalRowEstimate)),
  );

  const {
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
  } = useMessageActions({
    userId: user?.id,
    userProfileId: user?.profile_id,
    friends,
    members,
    onToggleReaction: handleToggleReaction,
  });

  const handleRetryFailedMessage = useCallback(async (failedMessage: Message) => {
    if (!encryptionKey || failedMessage.local_status !== 'failed') {
      return;
    }

    const localClientId = failedMessage.local_client_id || failedMessage.message_id;
    if (!localClientId || retryingFailedMessageIdsRef.current.has(localClientId)) {
      return;
    }

    const content = typeof failedMessage.content === 'string' &&
      failedMessage.content !== '[encrypted]' &&
      failedMessage.content !== '[deleted]'
      ? failedMessage.content
      : '';
    const attachments = failedMessage.attachments || [];

    if (!content.trim() && attachments.length === 0) {
      return;
    }

    retryingFailedMessageIdsRef.current.add(localClientId);
    onSendNotice?.(null);
    mergeVisibleMessages({
      incoming: [{
        ...failedMessage,
        local_status: 'sending',
        local_client_id: localClientId,
        created_at: new Date().toISOString(),
      }],
      currentUserId: user?.id,
      trimFrom: 'old',
      isAtPresent: true,
    });

    try {
      const retryOptions = {
        key_version: failedMessage.key_version || keyVersion || 1,
        message_type: failedMessage.message_type || 'mls_application',
        reply_to: failedMessage.reply_to || undefined,
        forwarded: failedMessage.forwarded || null,
        mentions: failedMessage.mentions || undefined,
      };
      const sentMessage = content.trim()
        ? await sendMessage(conversation.id, content, encryptionKey, {
            ...retryOptions,
            secure_attachments: attachments,
          })
        : await sendImageOnlyMessage(conversation.id, encryptionKey, attachments, retryOptions);

      forceFollowOutputRef.current = true;
      onSendNotice?.(null);
      mergeVisibleMessages({
        incoming: [{
          ...sentMessage,
          local_status: 'sent',
          local_client_id: localClientId,
        }],
        currentUserId: user?.id,
        trimFrom: 'old',
        isAtPresent: true,
      });
    } catch (error) {
      console.error('Retry failed message failed:', error);
      const retryNotice = error instanceof Error && error.message
        ? error.message
        : 'Message retry failed. Check your connection and try again.';
      mergeVisibleMessages({
        incoming: [{
          ...failedMessage,
          local_status: 'failed',
          local_client_id: localClientId,
        }],
        currentUserId: user?.id,
        trimFrom: 'old',
      });
      onSendNotice?.(retryNotice);
    } finally {
      retryingFailedMessageIdsRef.current.delete(localClientId);
    }
  }, [conversation.id, encryptionKey, keyVersion, mergeVisibleMessages, onSendNotice, user?.id]);

  // ── Reset on conversation switch ──
  useEffect(() => {
    atBottomRef.current = true;
    forceFollowOutputRef.current = false;
    initialLatestRestoreDoneRef.current = false;
    previousListCountRef.current = 0;
    lastFollowedMessageEventSequenceRef.current = 0;
    pendingOlderLoadScrollSnapshotRef.current = null;
    loadingOlderStateRef.current = false;
    loadingOlderRequestInFlightRef.current = false;
    loadingNewerRequestInFlightRef.current = false;
    autofillOlderRequestInFlightRef.current = false;
    messageHeightCacheRef.current.clear();
    setIsAtBottom(true);
    setOlderRangeError(false);
    setNewerRangeError(false);
    if (scrollerRef.current) scrollerRef.current.style.opacity = '0';
  }, [conversation.id]);

  useEffect(() => {
    if (!hasOlder || topLogicalRangeHeight <= 1) {
      setOlderRangeError(false);
    }
  }, [hasOlder, topLogicalRangeHeight]);

  useEffect(() => {
    if (!hasNewer || bottomLogicalRangeHeight <= 1) {
      setNewerRangeError(false);
    }
  }, [bottomLogicalRangeHeight, hasNewer]);

  // ── Track unseen messages from others ──
  useEffect(() => {
    const pendingEvents = messageEvents.filter(
      (event) => event.sequence > lastFollowedMessageEventSequenceRef.current
    );
    if (pendingEvents.length === 0) {
      return;
    }

    lastFollowedMessageEventSequenceRef.current = Math.max(
      ...pendingEvents.map((event) => event.sequence),
      lastFollowedMessageEventSequenceRef.current,
    );

    const hasOwnMessageEvent = pendingEvents.some(({ message }) => (
      String(message.conversation_id || conversation.id) === String(conversation.id) &&
      message.sender_id === user?.id
    ));

    if (hasOwnMessageEvent) {
      forceFollowOutputRef.current = true;
    }
  }, [conversation.id, messageEvents, user?.id]);

  // ── Stable refs for callbacks ──
  const friendsRef = useRef(friends);
  friendsRef.current = friends;
  const membersRef = useRef(members);
  membersRef.current = members;
  const myProfileRef = useRef(myProfile);
  myProfileRef.current = myProfile;
  const userRef = useRef(user);
  userRef.current = user;
  const typingParticipantsRef = useRef(typingParticipants);
  typingParticipantsRef.current = typingParticipants;

  const getSmartDisplayName = useCallback((senderId: string) => {
    const member = membersRef.current[senderId];
    const memberNickname = normalizeText(member?.nickname);
    if (memberNickname) return memberNickname;

    const memberDisplayName = normalizeText(member?.display_name);
    if (memberDisplayName) return memberDisplayName;

    const memberUsername = normalizeText(member?.username);
    if (memberUsername) return memberUsername;

    if (conversation.type !== 'dm') {
      return getSenderName(senderId);
    }

    const currentUser = userRef.current;
    if (senderId === currentUser?.id) {
      return normalizeText(myProfileRef.current?.display_name) || normalizeText(currentUser?.username) || 'You';
    }

    const friend = friendsRef.current.find((entry) => entry.id === senderId);
    const friendDisplayName = normalizeText(friend?.display_name);
    if (friendDisplayName) return friendDisplayName;
    const friendUsername = normalizeText(friend?.username);
    if (friendUsername) return friendUsername;
    return getSenderName(senderId);
  }, [conversation.type, getSenderName]);

  const getSmartUsername = useCallback((senderId: string) => {
    const currentUser = userRef.current;
    if (senderId === currentUser?.id) {
      return normalizeText(currentUser?.username);
    }
    const friend = friendsRef.current.find((entry) => entry.id === senderId);
    return normalizeText(friend?.username) || normalizeText(membersRef.current[senderId]?.username);
  }, []);

  const headerIdentity = useMemo(
    () => buildMessageViewHeaderIdentity({ conversation, members, friends, currentUserId: user?.id }),
    [conversation, friends, members, user?.id],
  );

  const metaFontSize = Math.max(10, chatFontScale - 4);
  const replyFontSize = Math.max(11, chatFontScale - 2);
  const bubbleFontSize = chatFontScale;
  const encryptedFontSize = Math.max(10, chatFontScale - 3);

  const openBrowserLink = useCallback((url: string) => {
    const openedWindow = window.open(url, '_blank', 'noopener,noreferrer');
    if (openedWindow) {
      openedWindow.opener = null;
    }
  }, []);

  const handleOpenMessageLink = useCallback((url: string) => {
    if (isTrustedMessageUrl(url)) {
      window.location.assign(url);
      return;
    }

    setPendingExternalLink({
      url,
      hostname: getMessageLinkHostname(url) || 'external site',
    });
  }, []);

  const handleConfirmExternalLink = useCallback(() => {
    if (!pendingExternalLink) return;
    openBrowserLink(pendingExternalLink.url);
    setPendingExternalLink(null);
  }, [openBrowserLink, pendingExternalLink]);

  const listItems: MessageListItem[] = useMemo(() => [
    ...visualMessages.map((message) => ({ kind: 'message' as const, message })),
    ...(typingParticipants.length > 0 ? [{ kind: 'typing' as const, id: 'typing-indicator' as const }] : []),
  ], [typingParticipants.length, visualMessages]);

  const showCachedHistoryFallback = Boolean(
    !encryptionKey &&
      (
        conversationSecurityState?.showCachedHistoryFallback ||
        encryptionError
      ),
  );
  const isSecureChatPreparing =
    !encryptionKey &&
    !encryptionError &&
    conversationSecurityState?.status !== 'blocked';

  // ── Preview cache ──
  useEffect(() => {
    const latestMessage = [...messages].reverse().find((message) =>
      String(message.conversation_id || conversation.id) === String(conversation.id)
    ) || null;

    setConversationPreview(
      [conversation.id, conversation.public_id],
      formatConversationPreview(latestMessage, user?.id),
    );
  }, [conversation.id, conversation.public_id, messages, user?.id]);

  // ── Warm encrypted attachment URLs ──
  useEffect(() => {
    visualMessages.forEach((message) => {
      parseAttachments(message.attachments)
        .filter(isEncryptedAttachment)
        .forEach((attachment) => {
          void resolveAttachmentObjectUrl(attachment, {
            conversationId: message.conversation_public_id || message.conversation_id,
          }).catch(() => {});
        });
    });
  }, [visualMessages]);

  // ── Row measurements for logical scroll spacers ──
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return undefined;
    }

    const elements = Array.from(scroller.querySelectorAll<HTMLElement>('[data-message-id]'));
    const measureElement = (element: HTMLElement) => {
      const messageId = element.dataset.messageId;
      if (!messageId) return;

      const measuredHeight = element.getBoundingClientRect().height;
      if (Number.isFinite(measuredHeight) && measuredHeight > 0) {
        messageHeightCacheRef.current.set(String(messageId), measuredHeight);
      }
    };

    elements.forEach(measureElement);

    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.target instanceof HTMLElement) {
          measureElement(entry.target);
        }
      });
    });

    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [
    density,
    visualMessages.length,
    visualMessages[0]?.message_id,
    visualMessages[visualMessages.length - 1]?.message_id,
  ]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const domRowCount = scroller?.querySelectorAll('[data-message-id]').length ?? 0;

    console.debug('[MessageWindowRuntime]', {
      conversationId: conversation.id,
      renderedIdsLength: runtimeStats.renderedIdsLength,
      domRowCount,
      messageByIdSize: runtimeStats.messageByIdSize,
      pagesLength: runtimeStats.pagesLength,
      topSpacerHeight: runtimeStats.topSpacerHeight,
      bottomSpacerHeight: runtimeStats.bottomSpacerHeight,
    });
  }, [
    conversation.id,
    runtimeStats.bottomSpacerHeight,
    runtimeStats.messageByIdSize,
    runtimeStats.pagesLength,
    runtimeStats.renderedIdsLength,
    runtimeStats.topSpacerHeight,
    visualMessages.length,
  ]);

  // ── Scroll helpers ──
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    if (behavior === 'smooth') {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
      return;
    }

    scroller.scrollTop = scroller.scrollHeight;
  }, []);

  const captureOlderLoadScrollSnapshot = useCallback((): OlderLoadScrollSnapshot | null => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;

    const snapshot = {
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
    };
    pendingOlderLoadScrollSnapshotRef.current = snapshot;
    return snapshot;
  }, []);

  const syncScrollState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const pendingOlderSnapshot = pendingOlderLoadScrollSnapshotRef.current;
    if (
      pendingOlderSnapshot &&
      Math.abs(scroller.scrollHeight - pendingOlderSnapshot.scrollHeight) <= OLDER_LOAD_SCROLL_UPDATE_THRESHOLD
    ) {
      pendingOlderSnapshot.scrollTop = scroller.scrollTop;
    }

    const distanceFromBottom = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    const atBottom = distanceFromBottom <= BOTTOM_THRESHOLD && !hasNewer && bottomLogicalRangeHeight <= 1;

    atBottomRef.current = atBottom;
    setIsAtBottom(atBottom);

    if (atBottom) {
      forceFollowOutputRef.current = false;
    }

    setIsAtPresent(atBottom && !hasNewer);
  }, [bottomLogicalRangeHeight, hasNewer, setIsAtPresent]);

  const loadOlderPreservingViewport = useCallback(async () => {
    const snapshot = captureOlderLoadScrollSnapshot();
    const didLoad = await loadOlder();
    setOlderRangeError(didLoad === false);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!snapshot || pendingOlderLoadScrollSnapshotRef.current !== snapshot) {
          return;
        }

        const scroller = scrollerRef.current;
        if (!scroller) {
          pendingOlderLoadScrollSnapshotRef.current = null;
          return;
        }

        if (!hasOlderRef.current && snapshot.scrollTop <= olderTopExhaustionThreshold) {
          scroller.scrollTop = 0;
          pendingOlderLoadScrollSnapshotRef.current = null;
          syncScrollState();
          return;
        }

        const scrollHeightDelta = scroller.scrollHeight - snapshot.scrollHeight;
        if (Math.abs(scrollHeightDelta) > 0.5) {
          scroller.scrollTop = snapshot.scrollTop + scrollHeightDelta;
          syncScrollState();
        }

        pendingOlderLoadScrollSnapshotRef.current = null;
      });
    });
  }, [captureOlderLoadScrollSnapshot, loadOlder, olderTopExhaustionThreshold, syncScrollState]);

  const maybeStartOlderBoundaryLoad = useCallback(() => {
    const scroller = scrollerRef.current;
    const distanceToOlderBoundary = scroller
      ? scroller.scrollTop - Math.max(0, topLogicalRangeHeight)
      : Number.POSITIVE_INFINITY;
    if (
      !scroller ||
      !initialLatestRestoreDoneRef.current ||
      !hasOlder ||
      loadingOlderRequestInFlightRef.current ||
      loadingOlderStateRef.current ||
      distanceToOlderBoundary > olderTopLoadThreshold
    ) {
      return false;
    }

    loadingOlderRequestInFlightRef.current = true;
    void loadOlderPreservingViewport().finally(() => {
      loadingOlderRequestInFlightRef.current = false;
    });
    return true;
  }, [hasOlder, loadOlderPreservingViewport, olderTopLoadThreshold, topLogicalRangeHeight]);

  const maybeStartNewerBoundaryLoad = useCallback(() => {
    const scroller = scrollerRef.current;
    if (
      !scroller ||
      !initialLatestRestoreDoneRef.current ||
      !hasNewer ||
      loadingNewerRequestInFlightRef.current ||
      loadingNewer ||
      (
        scroller.scrollHeight -
        Math.max(0, bottomLogicalRangeHeight) -
        (scroller.scrollTop + scroller.clientHeight)
      ) > newerBottomLoadThreshold
    ) {
      return false;
    }

    loadingNewerRequestInFlightRef.current = true;
    void loadNewer()
      .then((didLoad) => {
        setNewerRangeError(didLoad === false);
      })
      .finally(() => {
        loadingNewerRequestInFlightRef.current = false;
      });
    return true;
  }, [bottomLogicalRangeHeight, hasNewer, loadNewer, loadingNewer, newerBottomLoadThreshold]);

  const isOlderLogicalRangeVisible = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || topLogicalRangeHeight <= 1) {
      return false;
    }

    return scroller.scrollTop < topLogicalRangeHeight &&
      scroller.scrollTop + scroller.clientHeight > 0;
  }, [topLogicalRangeHeight]);

  const isNewerLogicalRangeVisible = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || bottomLogicalRangeHeight <= 1) {
      return false;
    }

    const bottomRangeStart = scroller.scrollHeight - bottomLogicalRangeHeight;
    return scroller.scrollTop + scroller.clientHeight > bottomRangeStart &&
      scroller.scrollTop < scroller.scrollHeight;
  }, [bottomLogicalRangeHeight]);

  const startVisibleSkeletonLoads = useCallback(() => {
    let didStart = false;

    if (olderRangeStatus === 'idle' && isOlderLogicalRangeVisible()) {
      didStart = maybeStartOlderBoundaryLoad() || didStart;
    }

    if (newerRangeStatus === 'idle' && isNewerLogicalRangeVisible()) {
      didStart = maybeStartNewerBoundaryLoad() || didStart;
    }

    return didStart;
  }, [
    isNewerLogicalRangeVisible,
    isOlderLogicalRangeVisible,
    maybeStartNewerBoundaryLoad,
    maybeStartOlderBoundaryLoad,
    newerRangeStatus,
    olderRangeStatus,
  ]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    let lastTouchY: number | null = null;
    const shouldLockOlderBoundary = () => (
      (loadingOlderRequestInFlightRef.current ||
        loadingOlderStateRef.current ||
        pendingOlderLoadScrollSnapshotRef.current !== null) &&
      scroller.scrollTop <= olderTopScrollLockThreshold
    );

    const handleWheelBoundaryLock = (event: WheelEvent) => {
      if (event.deltaY < 0 && shouldLockOlderBoundary()) {
        event.preventDefault();
        scroller.scrollTop = Math.max(0, scroller.scrollTop);
      }
    };

    const handleTouchStartBoundaryLock = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY ?? null;
    };

    const handleTouchMoveBoundaryLock = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      if (nextY === null || lastTouchY === null) {
        lastTouchY = nextY;
        return;
      }

      const isPullingTowardOlderHistory = nextY > lastTouchY;
      if (isPullingTowardOlderHistory && shouldLockOlderBoundary()) {
        event.preventDefault();
      }
      lastTouchY = nextY;
    };

    const clearTouchBoundaryLock = () => {
      lastTouchY = null;
    };

    scroller.addEventListener('wheel', handleWheelBoundaryLock, { passive: false });
    scroller.addEventListener('touchstart', handleTouchStartBoundaryLock, { passive: true });
    scroller.addEventListener('touchmove', handleTouchMoveBoundaryLock, { passive: false });
    scroller.addEventListener('touchend', clearTouchBoundaryLock);
    scroller.addEventListener('touchcancel', clearTouchBoundaryLock);

    return () => {
      scroller.removeEventListener('wheel', handleWheelBoundaryLock);
      scroller.removeEventListener('touchstart', handleTouchStartBoundaryLock);
      scroller.removeEventListener('touchmove', handleTouchMoveBoundaryLock);
      scroller.removeEventListener('touchend', clearTouchBoundaryLock);
      scroller.removeEventListener('touchcancel', clearTouchBoundaryLock);
    };
  }, [conversation.id, olderTopScrollLockThreshold]);

  const keepPresentPinnedToBottom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (
      !scroller ||
      !initialHydrationSettled ||
      loadingOlder
    ) {
      return false;
    }

    // Only pin when the user is actually at the bottom (or we explicitly
    // forced a follow action). A stale "present" state can briefly linger
    // while the user starts scrolling upward, which makes the list feel like
    // it's fighting them and yanking them back down.
    if (!forceFollowOutputRef.current && !atBottomRef.current) {
      return false;
    }

    scrollToBottom('auto');
    syncScrollState();
    forceFollowOutputRef.current = false;
    return true;
  }, [initialHydrationSettled, loadingOlder, scrollToBottom, syncScrollState]);

  const attemptInitialBottomRestore = useCallback(() => {
    const scroller = scrollerRef.current;
    if (
      initialLatestRestoreDoneRef.current ||
      !initialHydrationSettled ||
      visualMessages.length === 0 ||
      !scroller ||
      scroller.clientHeight <= 0
    ) {
      return false;
    }

    scrollToBottom('auto');
    syncScrollState();
    initialLatestRestoreDoneRef.current = true;
    if (scroller) scroller.style.opacity = '1';
    return true;
  }, [initialHydrationSettled, scrollToBottom, syncScrollState, visualMessages.length]);

  // ── IntersectionObserver: load older messages at the top boundary ──
  useEffect(() => {
    const sentinel = olderSentinelRef.current;
    const scroller = scrollerRef.current;
    if (!sentinel || !scroller) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!initialLatestRestoreDoneRef.current) {
          return;
        }
        if (!entry?.isIntersecting) {
          return;
        }

        maybeStartOlderBoundaryLoad();
      },
      {
        root: scroller,
        rootMargin: OLDER_SENTINEL_ROOT_MARGIN,
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [maybeStartOlderBoundaryLoad, conversation.id]);

  // ── IntersectionObserver: load newer messages ──
  useEffect(() => {
    const sentinel = newerSentinelRef.current;
    const scroller = scrollerRef.current;
    if (!sentinel || !scroller || !hasNewer) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!initialLatestRestoreDoneRef.current) {
          return;
        }
        if (
          !entry?.isIntersecting ||
          loadingNewerRequestInFlightRef.current ||
          !hasNewer ||
          loadingNewer
        ) {
          return;
        }

        maybeStartNewerBoundaryLoad();
      },
      {
        root: scroller,
        rootMargin: `0px 0px ${newerBottomLoadThreshold}px 0px`,
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNewer, loadingNewer, maybeStartNewerBoundaryLoad, newerBottomLoadThreshold, conversation.id]);

  // ── Scroll event: sync bottom state only ──
  const handleScroll = useCallback(() => {
    syncScrollState();
    maybeStartOlderBoundaryLoad();
    maybeStartNewerBoundaryLoad();
    startVisibleSkeletonLoads();
  }, [maybeStartNewerBoundaryLoad, maybeStartOlderBoundaryLoad, startVisibleSkeletonLoads, syncScrollState]);

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      startVisibleSkeletonLoads();
    });

    return () => cancelAnimationFrame(frameId);
  }, [startVisibleSkeletonLoads]);

  const handleJumpToPresent = useCallback(async () => {
    forceFollowOutputRef.current = true;
    await jumpToPresent();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
    });
  }, [jumpToPresent, scrollToBottom]);

  const handleAttachmentLoad = useCallback(() => {
    if (!atBottomRef.current && !forceFollowOutputRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      scrollToBottom('auto');
      forceFollowOutputRef.current = false;
    });
  }, [scrollToBottom]);

  // ── Initial scroll to bottom ──
  useLayoutEffect(() => {
    if (!initialHydrationSettled || visualMessages.length === 0 || initialLatestRestoreDoneRef.current) {
      return;
    }

    void attemptInitialBottomRestore();
  }, [attemptInitialBottomRestore, initialHydrationSettled, visualMessages.length]);

  // ── Keep pinned to bottom when at present ──
  useLayoutEffect(() => {
    if (
      !initialLatestRestoreDoneRef.current ||
      visualMessages.length === 0 ||
      loadingOlder
    ) {
      return;
    }

    requestAnimationFrame(() => {
      void keepPresentPinnedToBottom();
    });
  }, [
    keepPresentPinnedToBottom,
    loadingOlder,
    typingParticipants.length,
    visualMessages.length,
    visualMessages[0]?.message_id,
    visualMessages[visualMessages.length - 1]?.message_id,
  ]);

  // ── Follow output for new messages / own sends ──
  useLayoutEffect(() => {
    const nextCount = listItems.length;
    const previousCount = previousListCountRef.current;
    const countIncreased = nextCount > previousCount;

    if (countIncreased && (forceFollowOutputRef.current || atBottomRef.current)) {
      requestAnimationFrame(() => {
        scrollToBottom(forceFollowOutputRef.current ? 'auto' : 'smooth');
        forceFollowOutputRef.current = false;
        syncScrollState();
      });
    }

    previousListCountRef.current = nextCount;
  }, [listItems.length, scrollToBottom, syncScrollState]);

  // ── Sync after layout changes ──
  useEffect(() => {
    requestAnimationFrame(() => {
      syncScrollState();
    });
  }, [syncScrollState, visualMessages.length, typingParticipants.length, hasOlder, hasNewer]);

  // ── Autofill if content shorter than viewport ──
  const maybeAutofillOlder = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return false;
    }

    if (
      !initialHydrationSettled ||
      loading ||
      loadingOlder ||
      !hasOlder ||
      autofillOlderRequestInFlightRef.current ||
      scroller.clientHeight <= 0
    ) {
      return false;
    }

    const estimatedUnloadedHeight = topLogicalRangeHeight + bottomLogicalRangeHeight;
    const loadedScrollHeight = Math.max(0, scroller.scrollHeight - estimatedUnloadedHeight);
    const shouldAutofill =
      loadedScrollHeight <= scroller.clientHeight + UNDERFILL_AUTOFILL_THRESHOLD;
    if (!shouldAutofill) {
      return false;
    }

    autofillOlderRequestInFlightRef.current = true;
    void loadOlderPreservingViewport().finally(() => {
      autofillOlderRequestInFlightRef.current = false;
    });
    return true;
  }, [
    hasOlder,
    bottomLogicalRangeHeight,
    initialHydrationSettled,
    loadOlderPreservingViewport,
    loading,
    loadingOlder,
    topLogicalRangeHeight,
  ]);

  useLayoutEffect(() => {
    const snapshot = pendingOlderLoadScrollSnapshotRef.current;
    const scroller = scrollerRef.current;
    if (!snapshot || !scroller) {
      return;
    }

    const scrollHeightDelta = scroller.scrollHeight - snapshot.scrollHeight;
    if (Math.abs(scrollHeightDelta) > 0.5) {
      scroller.scrollTop = snapshot.scrollTop + scrollHeightDelta;
    }

    pendingOlderLoadScrollSnapshotRef.current = null;
    syncScrollState();
  }, [
    hasOlder,
    syncScrollState,
    visualMessages.length,
    visualMessages[0]?.message_id,
  ]);

  useEffect(() => {
    void maybeAutofillOlder();
  }, [maybeAutofillOlder, visualMessages.length]);

  // ── ResizeObserver ──
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      void attemptInitialBottomRestore();
      void maybeAutofillOlder();
      syncScrollState();
    });

    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [attemptInitialBottomRestore, maybeAutofillOlder, syncScrollState]);

  // ── Render ──
  const renderListItem = useCallback((item: MessageListItem) => {
    if (item.kind === 'typing') {
      return <TypingIndicator typingParticipants={typingParticipantsRef.current} />;
    }

    const message = item.message;
    const traits = layoutTraitsById[message.message_id] || defaultLayoutTraits;

    return (
      <MessageItem
        message={message}
        enableMentions={conversation.type === 'group'}
        startsGroup={traits.startsGroup}
        showDateSeparator={traits.showDateSeparator}
        density={density}
        messageGroupSpacing={messageGroupSpacing}
        metaFontSize={metaFontSize}
        replyFontSize={replyFontSize}
        bubbleFontSize={bubbleFontSize}
        encryptedFontSize={encryptedFontSize}
        currentUserId={user?.id}
        replyParent={message.reply_to ? getReplyParent(message.reply_to) : null}
        messageReactions={reactions[message.message_id] || message.reactions || emptyReactions}
        formatTime={formatTime}
        getSenderName={getSmartDisplayName}
        getSenderUsername={getSmartUsername}
        getSenderAvatarUrl={getSenderAvatarUrl}
        onProfileClick={handleProfileClick}
        onOpenEmojiPicker={openEmojiPicker}
        onContextMenu={
          message.local_status === 'sending' || message.local_status === 'queued'
            ? undefined
            : handleContextMenu
        }
        onOpenContextMenuAtPosition={openContextMenuAtPosition}
        onReply={onReply}
        onEdit={onEdit}
        onRetryFailed={encryptionKey ? handleRetryFailedMessage : undefined}
        onDelete={handleDelete}
        onToggleReaction={handleToggleReaction}
        onOpenImageViewer={openImageViewer}
        onAttachmentLoad={handleAttachmentLoad}
        onOpenLink={handleOpenMessageLink}
      />
    );
  }, [
    conversation.type,
    density,
    encryptionKey,
    encryptedFontSize,
    formatTime,
    getReplyParent,
    getSenderAvatarUrl,
    getSmartDisplayName,
    getSmartUsername,
    handleAttachmentLoad,
    handleContextMenu,
    handleDelete,
    handleOpenMessageLink,
    handleProfileClick,
    handleRetryFailedMessage,
    handleToggleReaction,
    layoutTraitsById,
    messageGroupSpacing,
    metaFontSize,
    onEdit,
    onForward,
    onReply,
    openContextMenuAtPosition,
    openEmojiPicker,
    openImageViewer,
    reactions,
    replyFontSize,
    bubbleFontSize,
    user?.id,
  ]);

  if (loading && messages.length === 0) {
    return <MessageViewSkeleton density={density} />;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      {sendNotice ? (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4">
          <div className="inline-flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-full border border-orange-400/25 bg-void-bg-main/95 px-3 py-1.5 text-xs font-medium text-orange-200 shadow-lg shadow-black/20 supports-[backdrop-filter]:backdrop-blur">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-orange-300" />
            <span className="truncate">{sendNotice}</span>
          </div>
        </div>
      ) : null}
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
        style={{ overflowAnchor: 'auto', opacity: initialLatestRestoreDoneRef.current ? 1 : 0 }}
      >
        {/* Older logical range: lets fast scroll enter unloaded history while the real batch is fetched. */}
        {topLogicalRangeHeight > 1 && (
          <div
            className="relative flex w-full items-start justify-center"
            style={{ height: `${topLogicalRangeHeight}px` }}
          >
            <div
              className="sticky top-0 w-full"
              style={{ height: `${Math.min(historyLogicalSlotHeight, topLogicalRangeHeight)}px` }}
            >
              <OlderHistorySkeleton
                density={density}
                seed={olderSkeletonSeed}
                rowCount={historySkeletonRowCount}
                active={olderRangeStatus === 'loading'}
              />
            </div>
            {hasOlder && <div ref={olderSentinelRef} className="absolute inset-x-0 bottom-0 h-px w-full" />}
          </div>
        )}

        {!hasOlder && topLogicalRangeHeight <= 1 && (
          <MessageViewHeader
            conversation={conversation}
            headerIdentity={headerIdentity}
            onProfileClick={handleProfileClick}
          />
        )}

        {listItems.length === 0 ? (
          isSecureChatPreparing ? (
            <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-blue-400/25 bg-blue-500/10">
                <Loader2 className="h-5 w-5 animate-spin text-blue-300" />
              </div>
              <div>
                <p className="text-sm font-semibold text-void-text">
                  Preparing secure chat...
                </p>
                <p className="mt-1 text-xs text-void-text-muted">
                  Waiting for encryption keys before messages can load.
                </p>
              </div>
            </div>
          ) : (
          <p className="text-center text-void-text-muted text-sm py-8">
            {showCachedHistoryFallback
              ? conversationSecurityState?.detail || 'Cached history will appear here after this device regains the latest conversation keys.'
              : 'No messages yet. Say something!'}
          </p>
          )
        ) : (
          listItems.map((item) => (
            <Fragment key={item.kind === 'message' ? item.message.message_id : item.id}>
              {renderListItem(item)}
            </Fragment>
          ))
        )}

        {/* Newer logical range: real newer rows replace this skeleton area when available. */}
        {bottomLogicalRangeHeight > 1 && (
          <div
            className="relative flex w-full items-start justify-center"
            style={{ height: `${bottomLogicalRangeHeight}px` }}
          >
            {hasNewer && <div ref={newerSentinelRef} className="absolute inset-x-0 top-0 h-px w-full" />}
            <div
              className="sticky top-0 w-full"
              style={{ height: `${Math.min(historyLogicalSlotHeight, bottomLogicalRangeHeight)}px` }}
            >
              <OlderHistorySkeleton
                density={density}
                seed={newerSkeletonSeed}
                rowCount={historySkeletonRowCount}
                active={newerRangeStatus === 'loading'}
              />
            </div>
          </div>
        )}
      </div>

      {!isAtBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
          <button
            onClick={handleJumpToPresent}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-void-accent px-4 py-2 text-xs font-bold text-white shadow-lg transition-colors hover:bg-void-accent-hover"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Jump to Present
          </button>
        </div>
      )}

      <ExternalLinkModal
        pendingExternalLink={pendingExternalLink}
        onClose={() => setPendingExternalLink(null)}
        onConfirm={handleConfirmExternalLink}
      />

      <MessageOverlays
        contextMenu={contextMenu}
        emojiPickerTarget={emojiPickerTarget}
        selectedProfileId={selectedProfileId}
        selectedFriend={selectedFriend}
        imageViewer={imageViewer}
        currentUserId={user?.id}
        onCloseContextMenu={() => setContextMenu(null)}
        onOpenEmojiPickerAtPosition={openEmojiPickerAtPosition}
        onToggleReaction={handleToggleReaction}
        onEmojiSelect={handleEmojiSelect}
        onCloseEmojiPicker={closeEmojiPicker}
        onCopyMessageText={handleCopyMessageText}
        onReply={onReply}
        onForward={onForward}
        onEdit={onEdit}
        onRetryFailed={encryptionKey ? handleRetryFailedMessage : undefined}
        onDelete={handleDelete}
        onCloseProfile={() => setSelectedProfileId(null)}
        onCloseFriend={() => setSelectedFriend(null)}
        onCloseImageViewer={closeImageViewer}
        onPreviousImage={showPreviousImage}
        onNextImage={showNextImage}
        onSelectImageIndex={selectImageIndex}
      />
    </div>
  );
});

export default MessageViewV2;
