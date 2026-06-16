import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMessageList } from '../../../Services/hooks/Chats/useMessageList';
import { useMessageDisplay } from '../../../Services/hooks/Chats/useMessageDisplay';
import { useReactions } from '../../../Services/hooks/Chats/useReactions';
import type { ConversationSecurityState } from '../../../Services/Chat/conversationSecurityState';
import {
  sendImageOnlyMessage,
  sendMessage,
} from '../../../Services/Chat/chatService';
import { type Conversation, type ConversationMember, type Message } from '../../../Services/Chat/chatService';
import { useUser } from '../../../Services/Auth/UserContext';
import { debugLog } from '../../../Services/utils/debugLog';
import { useFriends } from '../../../Services/hooks/Friends/useFriends';
import { useProfileRecord } from '../../../Services/hooks/profile/useProfileRecord';
import { useTheme, type Density } from '../../../Services/hooks/Settings/useTheme';
import { MessageViewSkeleton } from '../../common/Skeleton';
import MessageItem from '../Messages/MessageItem';
import MessageOverlays from '../Messages/MessageOverlays';
import MessageViewHeader, { buildMessageViewHeaderIdentity } from './MessageViewHeader';
import {
  getMessageLinkHostname,
  isTrustedMessageUrl,
} from '../Messages/messageLinks';
import ExternalLinkModal from './ExternalLinkModal';
import TypingIndicator, { type TypingParticipant } from '../Messages/TypingIndicator';
import { useMessageActions } from '../Messages/useMessageActions';
import { useMessageLayout } from '../Messages/useMessageLayout';
import { useMessageScrollGeometry } from './useMessageScrollGeometry';
import { useMessageTimelineVirtualizer } from './useMessageTimelineVirtualizer';
import { estimateMessageRowHeight } from '../Messages/messageRowHeight';
import { useNearViewportMessages } from '../Messages/useNearViewportMessages';
import EmptyMessageTimelineState from './EmptyMessageTimelineState';
import JumpToPresentButton from './JumpToPresentButton';
import MessageJumpNotice from './MessageJumpNotice';
import MessageTimelineViewport from './MessageTimelineViewport';
import {
  HISTORY_PAGE_PLACEHOLDER_HEIGHT,
  HISTORY_SKELETON_ROW_HEIGHT,
} from './historySkeletonConstants';
import { useConversationPreviewCache } from './useConversationPreviewCache';
import { useMobileKeyboardOpen } from './useMobileKeyboardOpen';
import { useMessageRowMeasurements } from './useMessageRowMeasurements';
import {
  getFirstVisibleMessageAnchor,
  getMessageAnchorsAroundViewport,
  getMessageElementById,
  restoreHistoryRangeReplacementAnchor,
  restoreVisibleMessageAnchor,
  updateHistoryRangeReplacementPosition,
  type HistoryLoadScrollSnapshot,
  type HistoryRangeReplacementSnapshot,
  type NewerHistoryLoadScrollSnapshot,
  type ViewportAnchorLock,
} from './historyScrollAnchors';
import type {
  MessageDelete,
  MessageStreamEvent,
  MessageUpdate,
} from '../../../Services/hooks/Chats/MessageList/messageListTypes';

interface MessageViewProps {
  conversation: Conversation;
  encryptionKey: CryptoKey | null;
  keyVersion?: number;
  encryptionError?: string | null;
  conversationSecurityState?: ConversationSecurityState;
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
  ownSendJumpRequest?: number;
  onOwnSendHistoryModeChange?: (shouldJumpToPresent: boolean) => void;
  onOwnSendJumpSettled?: () => void;
}

type MessageListItem =
  | { kind: 'message'; message: Message }
  | { kind: 'typing'; id: 'typing-indicator' };

const normalizeText = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

const defaultLayoutTraits = Object.freeze({ startsGroup: true, showDateSeparator: false });
const emptyReactions: Record<string, unknown> = Object.freeze({});
const BOTTOM_THRESHOLD = 16;
const JUMP_TO_PRESENT_REVEAL_DISTANCE = 180;
const OLDER_LOAD_SCROLL_UPDATE_THRESHOLD = 1;
const UNDERFILL_AUTOFILL_THRESHOLD = 48;
const HISTORY_RATE_LIMIT_FALLBACK_MS = 6_000;
const HISTORY_RATE_LIMIT_MAX_MS = 30_000;
const ENABLE_SCROLL_GEOMETRY_COMPACTION = true;
const MAX_PHYSICAL_HISTORY_SPACER_HEIGHT = 4_000;
const OLDER_HISTORY_PREFETCH_DISTANCE: Record<Density, number> = {
  compact: 720,
  comfortable: 640,
};
const NEWER_HISTORY_PREFETCH_DISTANCE: Record<Density, number> = {
  compact: 720,
  comfortable: 640,
};

// IntersectionObserver catches the exact boundary. The scroll handler below
// starts history fetches earlier so fast scrolling is less likely to hit a
// temporary loading wall at either edge of the active message window.
const OLDER_SENTINEL_ROOT_MARGIN = '0px 0px 0px 0px';

const MessageViewV2 = memo(function MessageViewV2({
  conversation,
  encryptionKey,
  keyVersion,
  encryptionError,
  conversationSecurityState,
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
  ownSendJumpRequest = 0,
  onOwnSendHistoryModeChange,
  onOwnSendJumpSettled,
}: MessageViewProps) {
  const { user } = useUser();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollerElement, setScrollerElement] = useState<HTMLDivElement | null>(null);
  const olderSentinelRef = useRef<HTMLDivElement | null>(null);
  const newerSentinelRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const forceFollowOutputRef = useRef(false);
  const initialLatestRestoreDoneRef = useRef(false);
  const previousListCountRef = useRef(0);
  const lastFollowedMessageEventSequenceRef = useRef(0);
  const lastOwnSendJumpRequestRef = useRef(ownSendJumpRequest);
  const pendingOlderLoadScrollSnapshotRef = useRef<HistoryLoadScrollSnapshot | null>(null);
  const pendingNewerLoadScrollSnapshotRef = useRef<NewerHistoryLoadScrollSnapshot | null>(null);
  const historyScrollTransactionActiveRef = useRef(false);
  const viewportAnchorLockRef = useRef<ViewportAnchorLock | null>(null);
  const viewportAnchorRestoreInProgressRef = useRef(false);
  const showJumpToPresentRef = useRef(false);
  const pendingMessageJumpTargetRef = useRef<string | null>(null);
  const hasOlderRef = useRef(false);
  const hasNewerRef = useRef(false);
  const loadingOlderStateRef = useRef(false);
  const loadingNewerStateRef = useRef(false);
  const loadingOlderRequestInFlightRef = useRef(false);
  const loadingNewerRequestInFlightRef = useRef(false);
  const autofillOlderRequestInFlightRef = useRef(false);
  const messageHeightCacheRef = useRef<Map<string, number>>(new Map());
  const historyLoadPausedUntilRef = useRef(0);
  const ownSendJumpRequestRef = useRef(ownSendJumpRequest);
  const onOwnSendHistoryModeChangeRef = useRef(onOwnSendHistoryModeChange);
  const messageHighlightTimeoutRef = useRef<number | null>(null);
  const messageJumpNoticeTimeoutRef = useRef<number | null>(null);
  const messageJumpFallbackTimeoutRef = useRef<number | null>(null);
  const [pendingExternalLink, setPendingExternalLink] = useState<{ url: string; hostname: string } | null>(null);
  const [showJumpToPresent, setShowJumpToPresent] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [messageJumpNotice, setMessageJumpNotice] = useState<string | null>(null);
  const [olderRangeError, setOlderRangeError] = useState(false);
  const [newerRangeError, setNewerRangeError] = useState(false);
  const [historyLoadPausedUntil, setHistoryLoadPausedUntil] = useState(0);
  const [historyRestoreRevision, setHistoryRestoreRevision] = useState(0);
  const isMobileKeyboardOpen = useMobileKeyboardOpen();
  const setScrollerRef = useCallback((element: HTMLDivElement | null) => {
    scrollerRef.current = element;
    setScrollerElement(element);
  }, []);


  const { density, messageGroupSpacing, chatFontScale } = useTheme();
  const historyLogicalSlotHeight = HISTORY_PAGE_PLACEHOLDER_HEIGHT[density];
  const historySkeletonRowHeight = HISTORY_SKELETON_ROW_HEIGHT[density];
  const olderTopLoadThreshold = OLDER_HISTORY_PREFETCH_DISTANCE[density];
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
  const handleHistoryRateLimited = useCallback((retryAfterMs?: number) => {
    const pauseMs = Math.min(
      HISTORY_RATE_LIMIT_MAX_MS,
      Math.max(1_000, retryAfterMs ?? HISTORY_RATE_LIMIT_FALLBACK_MS),
    );
    const pausedUntil = Date.now() + pauseMs;

    if (pausedUntil <= historyLoadPausedUntilRef.current) {
      return;
    }

    historyLoadPausedUntilRef.current = pausedUntil;
    setHistoryLoadPausedUntil(pausedUntil);
    setOlderRangeError(false);
    setNewerRangeError(false);
  }, []);
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
    recordMessageHeights,
    handleDelete,
    getReplyParent,
    isReplyParentLoading,
    mergeVisibleMessages,
    loadMessageContext,
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
    {
      getMessageHeight: getMessageHeightForWindowing,
      onHistoryRateLimited: handleHistoryRateLimited,
    },
  );
  ownSendJumpRequestRef.current = ownSendJumpRequest;
  onOwnSendHistoryModeChangeRef.current = onOwnSendHistoryModeChange;
  hasOlderRef.current = hasOlder;
  hasNewerRef.current = hasNewer;
  loadingOlderStateRef.current = loadingOlder;
  loadingNewerStateRef.current = loadingNewer;

  const { reactions, handleToggleReaction, initReactionsFromMessages } =
    useReactions(conversation.id, gateway, user?.id, isAtPresent);
  initReactionsFromMessagesRef.current = initReactionsFromMessages;

  const { formatTime, getSenderName, getSenderAvatarUrl } = useMessageDisplay(members, userAvatar);
  const visualMessages = messages;
  const maxPhysicalBottomSpacerHeight = Math.min(
    MAX_PHYSICAL_HISTORY_SPACER_HEIGHT,
    historyLogicalSlotHeight,
  );
  const nearViewportMessageIds = useNearViewportMessages(scrollerElement, conversation.id);
  const firstVisualMessageId = visualMessages[0]?.message_id;
  const lastVisualMessageId = visualMessages[visualMessages.length - 1]?.message_id;
  const layoutTraitsById = useMessageLayout(visualMessages, groupBreakBeforeIds, hasOlder);
  const retryingFailedMessageIdsRef = useRef<Set<string>>(new Set());
  const {
    topLogicalRangeHeight,
    bottomLogicalRangeHeight,
    renderedTopSpacerHeight,
    renderedBottomSpacerHeight,
    olderRangeStatus,
    newerRangeStatus,
    getScrollState,
    getOlderBoundaryDistance,
    getNewerBoundaryDistance,
    isOlderRangeVisible,
    isNewerRangeVisible,
    getLoadedScrollHeight,
  } = useMessageScrollGeometry({
    scrollerRef,
    scrollCompensationBlockerRef: historyScrollTransactionActiveRef,
    resetKey: conversation.id,
    topSpacerHeight,
    bottomSpacerHeight,
    hasOlder,
    hasNewer,
    loadingOlder,
    loadingNewer,
    olderRangeError,
    newerRangeError,
    historyLogicalSlotHeight,
    bottomThreshold: BOTTOM_THRESHOLD,
    jumpToPresentRevealDistance: JUMP_TO_PRESENT_REVEAL_DISTANCE,
    enablePhysicalSpacerWindowing: ENABLE_SCROLL_GEOMETRY_COMPACTION,
    maxPhysicalSpacerHeight: MAX_PHYSICAL_HISTORY_SPACER_HEIGHT,
    maxPhysicalBottomSpacerHeight,
  });
  const olderTopExhaustionThreshold = renderedTopSpacerHeight + 8;
  const topHistorySkeletonRowCount = Math.max(
    4,
    Math.ceil(renderedTopSpacerHeight / historySkeletonRowHeight) + 1,
  );
  const bottomHistorySkeletonRowCount = Math.max(
    4,
    Math.ceil(renderedBottomSpacerHeight / historySkeletonRowHeight) + 1,
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
        linkPreview: failedMessage.link_preview ?? null,
      };
      const sentMessage = content.trim()
        ? await sendMessage(conversation.id, content, encryptionKey, {
            client_message_id: localClientId,
            ...retryOptions,
            secure_attachments: attachments,
          })
        : await sendImageOnlyMessage(conversation.id, encryptionKey, attachments, {
            client_message_id: localClientId,
            ...retryOptions,
          });

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
    pendingNewerLoadScrollSnapshotRef.current = null;
    historyScrollTransactionActiveRef.current = false;
    viewportAnchorLockRef.current = null;
    viewportAnchorRestoreInProgressRef.current = false;
    showJumpToPresentRef.current = false;
    pendingMessageJumpTargetRef.current = null;
    hasOlderRef.current = false;
    hasNewerRef.current = false;
    loadingOlderStateRef.current = false;
    loadingNewerStateRef.current = false;
    loadingOlderRequestInFlightRef.current = false;
    loadingNewerRequestInFlightRef.current = false;
    autofillOlderRequestInFlightRef.current = false;
    messageHeightCacheRef.current.clear();
    historyLoadPausedUntilRef.current = 0;
    lastOwnSendJumpRequestRef.current = ownSendJumpRequestRef.current;
    onOwnSendHistoryModeChangeRef.current?.(false);
    if (messageHighlightTimeoutRef.current) {
      window.clearTimeout(messageHighlightTimeoutRef.current);
      messageHighlightTimeoutRef.current = null;
    }
    if (messageJumpNoticeTimeoutRef.current) {
      window.clearTimeout(messageJumpNoticeTimeoutRef.current);
      messageJumpNoticeTimeoutRef.current = null;
    }
    if (messageJumpFallbackTimeoutRef.current) {
      window.clearTimeout(messageJumpFallbackTimeoutRef.current);
      messageJumpFallbackTimeoutRef.current = null;
    }
    setHistoryLoadPausedUntil(0);
    setHistoryRestoreRevision(0);
    setShowJumpToPresent(false);
    setHighlightedMessageId(null);
    setMessageJumpNotice(null);
    setOlderRangeError(false);
    setNewerRangeError(false);
    if (scrollerRef.current) scrollerRef.current.style.opacity = '0';
  }, [conversation.id]);

  useEffect(() => () => {
    if (messageHighlightTimeoutRef.current) {
      window.clearTimeout(messageHighlightTimeoutRef.current);
    }
    if (messageJumpNoticeTimeoutRef.current) {
      window.clearTimeout(messageJumpNoticeTimeoutRef.current);
    }
    if (messageJumpFallbackTimeoutRef.current) {
      window.clearTimeout(messageJumpFallbackTimeoutRef.current);
    }
  }, []);

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

  useConversationPreviewCache({
    conversation,
    messages,
    currentUserId: user?.id,
    hasNewer,
    bottomSpacerHeight,
  });

  const captureViewportAnchorLock = useCallback((scroller = scrollerRef.current) => {
    if (!scroller) {
      return false;
    }

    const anchors = getMessageAnchorsAroundViewport(scroller);
    if (anchors.length === 0) {
      return false;
    }

    viewportAnchorLockRef.current = { anchors };
    return true;
  }, []);

  const restoreViewportAnchorLock = useCallback(() => {
    const scroller = scrollerRef.current;
    const lock = viewportAnchorLockRef.current;
    if (!scroller || !lock || atBottomRef.current) {
      return false;
    }

    viewportAnchorRestoreInProgressRef.current = true;
    try {
      for (const anchor of lock.anchors) {
        if (restoreVisibleMessageAnchor(scroller, {
          anchorMessageId: anchor.messageId,
          anchorOffsetTop: anchor.offsetTop,
        })) {
          return true;
        }
      }
    } finally {
      viewportAnchorRestoreInProgressRef.current = false;
    }

    return false;
  }, []);

  useMessageRowMeasurements({
    scrollerRef,
    density,
    recordMessageHeights,
    restoreViewportAnchorLock,
    visualMessagesLength: visualMessages.length,
    firstVisualMessageId,
    lastVisualMessageId,
    messageHeightCacheRef,
    historyScrollTransactionActiveRef,
    atBottomRef,
    showJumpToPresentRef,
  });

  useEffect(() => {
    const scroller = scrollerRef.current;
    const domRowCount = scroller?.querySelectorAll('[data-message-id]').length ?? 0;

    debugLog('[MessageWindowRuntime]', {
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

  const showMessageJumpNotice = useCallback((message: string) => {
    if (messageJumpNoticeTimeoutRef.current) {
      window.clearTimeout(messageJumpNoticeTimeoutRef.current);
    }

    setMessageJumpNotice(message);
    messageJumpNoticeTimeoutRef.current = window.setTimeout(() => {
      setMessageJumpNotice(null);
      messageJumpNoticeTimeoutRef.current = null;
    }, 2400);
  }, []);

  const highlightMessage = useCallback((messageId: string) => {
    if (messageHighlightTimeoutRef.current) {
      window.clearTimeout(messageHighlightTimeoutRef.current);
    }

    setHighlightedMessageId(messageId);
    messageHighlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightedMessageId((current) => (current === messageId ? null : current));
      messageHighlightTimeoutRef.current = null;
    }, 1800);
  }, []);

  const captureHistoryLoadScrollSnapshot = useCallback((): HistoryLoadScrollSnapshot | null => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const shouldMapVisibleRange = Boolean(
      firstVisualMessageId &&
      renderedTopSpacerHeight > 1 &&
      isOlderRangeVisible(scroller),
    );
    const rangeReplacement: HistoryRangeReplacementSnapshot | null = shouldMapVisibleRange
      ? {
          direction: 'older',
          seamMessageId: firstVisualMessageId!,
          sourceStart: Math.max(0, renderedTopSpacerHeight - historyLogicalSlotHeight),
          sourceEnd: renderedTopSpacerHeight,
          rowHeight: historySkeletonRowHeight,
          anchor: {
            kind: 'start',
            offsetTop: 0,
          },
          rangeStartOffsetTop: 0,
          rangeEndOffsetTop: 0,
          mapped: false,
        }
      : null;
    if (rangeReplacement) {
      updateHistoryRangeReplacementPosition(scroller, rangeReplacement);
    }
    const anchor = rangeReplacement ? null : getFirstVisibleMessageAnchor(scroller);

    const snapshot = {
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      anchorMessageId: anchor?.messageId ?? null,
      anchorOffsetTop: anchor?.offsetTop ?? null,
      rangeReplacement,
      readyToRestore: false,
    };
    pendingOlderLoadScrollSnapshotRef.current = snapshot;
    historyScrollTransactionActiveRef.current = true;
    if (rangeReplacement) {
      viewportAnchorLockRef.current = null;
    } else {
      captureViewportAnchorLock(scroller);
    }
    return snapshot;
  }, [
    captureViewportAnchorLock,
    firstVisualMessageId,
    historyLogicalSlotHeight,
    historySkeletonRowHeight,
    isOlderRangeVisible,
    renderedTopSpacerHeight,
  ]);

  const captureNewerHistoryLoadScrollSnapshot = useCallback((): NewerHistoryLoadScrollSnapshot | null => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const shouldMapVisibleRange = Boolean(
      lastVisualMessageId &&
      renderedBottomSpacerHeight > 1 &&
      isNewerRangeVisible(scroller),
    );
    const bottomRangeStart = scroller.scrollHeight - renderedBottomSpacerHeight;
    const rangeReplacement: HistoryRangeReplacementSnapshot | null = shouldMapVisibleRange
      ? {
          direction: 'newer',
          seamMessageId: lastVisualMessageId!,
          sourceStart: bottomRangeStart,
          sourceEnd: Math.min(
            scroller.scrollHeight,
            bottomRangeStart + historyLogicalSlotHeight,
          ),
          rowHeight: historySkeletonRowHeight,
          anchor: {
            kind: 'start',
            offsetTop: 0,
          },
          rangeStartOffsetTop: 0,
          rangeEndOffsetTop: 0,
          mapped: false,
        }
      : null;
    if (rangeReplacement) {
      updateHistoryRangeReplacementPosition(scroller, rangeReplacement);
    }
    const anchors = rangeReplacement ? [] : getMessageAnchorsAroundViewport(scroller);
    const anchor = anchors[0] ?? null;

    const snapshot = {
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      anchorMessageId: anchor?.messageId ?? null,
      anchorOffsetTop: anchor?.offsetTop ?? null,
      rangeReplacement,
      readyToRestore: false,
      fallbackAnchors: anchors.slice(1),
      distanceFromBottom: scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight),
    };
    pendingNewerLoadScrollSnapshotRef.current = snapshot;
    historyScrollTransactionActiveRef.current = true;
    if (rangeReplacement) {
      viewportAnchorLockRef.current = null;
    } else {
      captureViewportAnchorLock(scroller);
    }
    return snapshot;
  }, [
    captureViewportAnchorLock,
    historyLogicalSlotHeight,
    historySkeletonRowHeight,
    isNewerRangeVisible,
    lastVisualMessageId,
    renderedBottomSpacerHeight,
  ]);

  const syncScrollState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const pendingOlderSnapshot = pendingOlderLoadScrollSnapshotRef.current;
    if (
      pendingOlderSnapshot &&
      Math.abs(scroller.scrollHeight - pendingOlderSnapshot.scrollHeight) <= OLDER_LOAD_SCROLL_UPDATE_THRESHOLD
    ) {
      const scrollDelta = scroller.scrollTop - pendingOlderSnapshot.scrollTop;
      pendingOlderSnapshot.scrollTop = scroller.scrollTop;
      if (pendingOlderSnapshot.rangeReplacement) {
        updateHistoryRangeReplacementPosition(scroller, pendingOlderSnapshot.rangeReplacement);
      } else {
        const anchor = getFirstVisibleMessageAnchor(scroller);
        if (anchor) {
          pendingOlderSnapshot.anchorMessageId = anchor.messageId;
          pendingOlderSnapshot.anchorOffsetTop = anchor.offsetTop;
        } else if (pendingOlderSnapshot.anchorOffsetTop !== null) {
          pendingOlderSnapshot.anchorOffsetTop -= scrollDelta;
        }
      }
    }

    const pendingNewerSnapshot = pendingNewerLoadScrollSnapshotRef.current;
    if (
      pendingNewerSnapshot &&
      Math.abs(scroller.scrollHeight - pendingNewerSnapshot.scrollHeight) <= OLDER_LOAD_SCROLL_UPDATE_THRESHOLD
    ) {
      const scrollDelta = scroller.scrollTop - pendingNewerSnapshot.scrollTop;
      pendingNewerSnapshot.scrollTop = scroller.scrollTop;
      pendingNewerSnapshot.distanceFromBottom =
        scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
      if (pendingNewerSnapshot.rangeReplacement) {
        updateHistoryRangeReplacementPosition(scroller, pendingNewerSnapshot.rangeReplacement);
      } else {
        const anchors = getMessageAnchorsAroundViewport(scroller);
        const anchor = anchors[0];
        if (anchor) {
          pendingNewerSnapshot.anchorMessageId = anchor.messageId;
          pendingNewerSnapshot.anchorOffsetTop = anchor.offsetTop;
          pendingNewerSnapshot.fallbackAnchors = anchors.slice(1);
        } else {
          if (pendingNewerSnapshot.anchorOffsetTop !== null) {
            pendingNewerSnapshot.anchorOffsetTop -= scrollDelta;
          }
          pendingNewerSnapshot.fallbackAnchors = pendingNewerSnapshot.fallbackAnchors.map(
            (fallbackAnchor) => ({
              ...fallbackAnchor,
              offsetTop: fallbackAnchor.offsetTop - scrollDelta,
            }),
          );
        }
      }
    }

    const scrollState = getScrollState(scroller);

    atBottomRef.current = scrollState.atBottom;
    showJumpToPresentRef.current = scrollState.shouldShowJumpToPresent;
    setShowJumpToPresent(scrollState.shouldShowJumpToPresent);
    onOwnSendHistoryModeChange?.(
      !scrollState.atBottom ||
      scrollState.shouldShowJumpToPresent ||
      hasNewer ||
      !scrollState.isAtPresent ||
      !isAtPresent
    );

    if (scrollState.atBottom) {
      forceFollowOutputRef.current = false;
      if (!historyScrollTransactionActiveRef.current) {
        viewportAnchorLockRef.current = null;
      }
    } else if (!viewportAnchorRestoreInProgressRef.current) {
      captureViewportAnchorLock(scroller);
    }

    setIsAtPresent(scrollState.isAtPresent);
  }, [
    captureViewportAnchorLock,
    getScrollState,
    hasNewer,
    isAtPresent,
    onOwnSendHistoryModeChange,
    setIsAtPresent,
  ]);

  const scrollToMessageById = useCallback((
    messageId: string,
    behavior: ScrollBehavior = 'smooth',
    options?: { highlight?: boolean },
  ) => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return false;
    }

    const messageElement = getMessageElementById(scroller, messageId);
    if (!messageElement) {
      return false;
    }

    const targetTop = messageElement.offsetTop;
    const centeredTop = targetTop - (scroller.clientHeight / 2) + (messageElement.offsetHeight / 2);
    scroller.scrollTo({
      top: Math.max(0, centeredTop),
      behavior,
    });
    if (options?.highlight !== false) {
      highlightMessage(messageId);
    }
    requestAnimationFrame(syncScrollState);
    return true;
  }, [highlightMessage, syncScrollState]);

  const handleJumpToMessage = useCallback(async (targetMessageId: string) => {
    if (!targetMessageId) {
      return;
    }

    setMessageJumpNotice(null);
    if (scrollToMessageById(targetMessageId, 'smooth', { highlight: true })) {
      return;
    }

    if (!encryptionKey) {
      showMessageJumpNotice('Message unavailable');
      return;
    }

    pendingMessageJumpTargetRef.current = targetMessageId;
    pendingOlderLoadScrollSnapshotRef.current = null;
    pendingNewerLoadScrollSnapshotRef.current = null;
    historyScrollTransactionActiveRef.current = false;
    viewportAnchorLockRef.current = null;
    viewportAnchorRestoreInProgressRef.current = false;
    forceFollowOutputRef.current = false;
    setOlderRangeError(false);
    setNewerRangeError(false);
    if (messageJumpFallbackTimeoutRef.current) {
      window.clearTimeout(messageJumpFallbackTimeoutRef.current);
      messageJumpFallbackTimeoutRef.current = null;
    }

    const didLoadContext = await loadMessageContext(targetMessageId);
    if (!didLoadContext) {
      if (pendingMessageJumpTargetRef.current === targetMessageId) {
        pendingMessageJumpTargetRef.current = null;
      }
      showMessageJumpNotice('Message unavailable');
      return;
    }

    messageJumpFallbackTimeoutRef.current = window.setTimeout(() => {
      if (pendingMessageJumpTargetRef.current === targetMessageId) {
        pendingMessageJumpTargetRef.current = null;
        showMessageJumpNotice('Message unavailable');
      }
      messageJumpFallbackTimeoutRef.current = null;
    }, 1200);
  }, [
    encryptionKey,
    loadMessageContext,
    scrollToMessageById,
    showMessageJumpNotice,
  ]);

  const restoreHistoryLoadScrollSnapshot = useCallback((snapshot: HistoryLoadScrollSnapshot) => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return false;
    }

    const replacement = snapshot.rangeReplacement;
    if (replacement) {
      if (!replacement.mapped) {
        const messageElements = Array.from(
          scroller.querySelectorAll<HTMLElement>('[data-message-id]'),
        );
        const seamIndex = messageElements.findIndex(
          (element) => element.dataset.messageId === replacement.seamMessageId,
        );

        if (seamIndex > 0) {
          const insertedElements = messageElements.slice(0, seamIndex);
          const firstInsertedElement = insertedElements[0]!;
          const seamElement = messageElements[seamIndex]!;
          const scrollerRect = scroller.getBoundingClientRect();
          restoreHistoryRangeReplacementAnchor({
            scroller,
            replacement,
            insertedElements,
            rangeStartOffsetTop:
              firstInsertedElement.getBoundingClientRect().top - scrollerRect.top,
            rangeEndOffsetTop:
              seamElement.getBoundingClientRect().top - scrollerRect.top,
          });
        } else if (snapshot.readyToRestore && !hasOlderRef.current) {
          scroller.scrollTop = 0;
          replacement.mapped = true;
        }
      }

      if (replacement.mapped) {
        syncScrollState();
        return true;
      }

      return false;
    }

    if (!hasOlderRef.current && snapshot.scrollTop <= olderTopExhaustionThreshold) {
      scroller.scrollTop = 0;
      syncScrollState();
      return true;
    }

    if (restoreVisibleMessageAnchor(scroller, snapshot)) {
      syncScrollState();
      return true;
    }

    const scrollHeightDelta = scroller.scrollHeight - snapshot.scrollHeight;
    if (Math.abs(scrollHeightDelta) > 0.5) {
      scroller.scrollTop = snapshot.scrollTop + scrollHeightDelta;
      syncScrollState();
      return true;
    }

    syncScrollState();
    return true;
  }, [olderTopExhaustionThreshold, syncScrollState]);

  const restoreNewerHistoryLoadScrollSnapshot = useCallback((snapshot: NewerHistoryLoadScrollSnapshot) => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return false;
    }

    const replacement = snapshot.rangeReplacement;
    if (replacement) {
      if (!replacement.mapped) {
        const messageElements = Array.from(
          scroller.querySelectorAll<HTMLElement>('[data-message-id]'),
        );
        const seamIndex = messageElements.findIndex(
          (element) => element.dataset.messageId === replacement.seamMessageId,
        );

        if (seamIndex >= 0 && seamIndex < messageElements.length - 1) {
          const seamElement = messageElements[seamIndex]!;
          const insertedElements = messageElements.slice(seamIndex + 1);
          const lastInsertedElement = insertedElements[insertedElements.length - 1]!;
          const scrollerRect = scroller.getBoundingClientRect();
          restoreHistoryRangeReplacementAnchor({
            scroller,
            replacement,
            insertedElements,
            rangeStartOffsetTop:
              seamElement.getBoundingClientRect().bottom - scrollerRect.top,
            rangeEndOffsetTop:
              lastInsertedElement.getBoundingClientRect().bottom - scrollerRect.top,
          });
        } else if (snapshot.readyToRestore && !hasNewerRef.current) {
          scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          replacement.mapped = true;
        }
      }

      if (replacement.mapped) {
        syncScrollState();
        return true;
      }

      return false;
    }

    if (restoreVisibleMessageAnchor(scroller, snapshot)) {
      syncScrollState();
      return true;
    }

    for (const anchor of snapshot.fallbackAnchors) {
      if (restoreVisibleMessageAnchor(scroller, {
        anchorMessageId: anchor.messageId,
        anchorOffsetTop: anchor.offsetTop,
      })) {
        syncScrollState();
        return true;
      }
    }

    scroller.scrollTop = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight - snapshot.distanceFromBottom,
    );
    syncScrollState();
    return true;
  }, [syncScrollState]);

  const loadOlderPreservingViewport = useCallback(async () => {
    const snapshot = captureHistoryLoadScrollSnapshot();
    const didLoad = await loadOlder();
    const isHistoryPaused = historyLoadPausedUntilRef.current > Date.now();
    setOlderRangeError(didLoad === false && !isHistoryPaused);
    if (didLoad && snapshot && pendingOlderLoadScrollSnapshotRef.current === snapshot) {
      snapshot.readyToRestore = true;
      setHistoryRestoreRevision((current) => current + 1);
    } else if (!didLoad && snapshot && pendingOlderLoadScrollSnapshotRef.current === snapshot) {
      pendingOlderLoadScrollSnapshotRef.current = null;
      if (!pendingNewerLoadScrollSnapshotRef.current) {
        historyScrollTransactionActiveRef.current = false;
      }
    }
  }, [captureHistoryLoadScrollSnapshot, loadOlder]);

  const loadNewerPreservingViewport = useCallback(async () => {
    const snapshot = captureNewerHistoryLoadScrollSnapshot();
    const didLoad = await loadNewer();
    const isHistoryPaused = historyLoadPausedUntilRef.current > Date.now();
    setNewerRangeError(didLoad === false && !isHistoryPaused);
    if (didLoad && snapshot && pendingNewerLoadScrollSnapshotRef.current === snapshot) {
      snapshot.readyToRestore = true;
      setHistoryRestoreRevision((current) => current + 1);
    } else if (!didLoad && snapshot && pendingNewerLoadScrollSnapshotRef.current === snapshot) {
      pendingNewerLoadScrollSnapshotRef.current = null;
      if (!pendingOlderLoadScrollSnapshotRef.current) {
        historyScrollTransactionActiveRef.current = false;
      }
    }
  }, [captureNewerHistoryLoadScrollSnapshot, loadNewer]);

  useLayoutEffect(() => {
    const targetMessageId = pendingMessageJumpTargetRef.current;
    if (!targetMessageId) {
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pendingMessageJumpTargetRef.current !== targetMessageId) {
          return;
        }

        const firstPassFound = scrollToMessageById(targetMessageId, 'auto', { highlight: false });
        requestAnimationFrame(() => {
          if (pendingMessageJumpTargetRef.current !== targetMessageId) {
            return;
          }

          const finalPassFound = scrollToMessageById(targetMessageId, 'auto', { highlight: true });
          if (firstPassFound || finalPassFound) {
            pendingMessageJumpTargetRef.current = null;
            if (messageJumpFallbackTimeoutRef.current) {
              window.clearTimeout(messageJumpFallbackTimeoutRef.current);
              messageJumpFallbackTimeoutRef.current = null;
            }
          }
        });
      });
    });
  }, [
    scrollToMessageById,
    visualMessages.length,
    firstVisualMessageId,
    lastVisualMessageId,
  ]);

  const {
    handleScroll,
    maybeStartBestHistoryLoad,
  } = useMessageTimelineVirtualizer({
    scrollerRef,
    resetKey: conversation.id,
    initialLatestRestoreDoneRef,
    pendingOlderLoadScrollSnapshotRef,
    pendingNewerLoadScrollSnapshotRef,
    loadingOlderRequestInFlightRef,
    loadingNewerRequestInFlightRef,
    loadingOlderStateRef,
    loadingNewer,
    historyLoadPausedUntil,
    hasOlder,
    hasNewer,
    olderRangeStatus,
    newerRangeStatus,
    olderTopLoadThreshold,
    newerBottomLoadThreshold,
    getOlderBoundaryDistance,
    getNewerBoundaryDistance,
    isOlderRangeVisible,
    isNewerRangeVisible,
    loadOlderPreservingViewport,
    loadNewerPreservingViewport,
    syncScrollState,
  });

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
  }, [
    conversation.id,
    olderTopScrollLockThreshold,
  ]);

  const keepPresentPinnedToBottom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (
      !scroller ||
      !initialHydrationSettled ||
      loadingOlder ||
      loadingNewer ||
      pendingNewerLoadScrollSnapshotRef.current ||
      pendingMessageJumpTargetRef.current
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
  }, [initialHydrationSettled, loadingNewer, loadingOlder, scrollToBottom, syncScrollState]);

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

        maybeStartBestHistoryLoad('older');
      },
      {
        root: scroller,
        rootMargin: OLDER_SENTINEL_ROOT_MARGIN,
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [maybeStartBestHistoryLoad, conversation.id]);

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

        maybeStartBestHistoryLoad('newer');
      },
      {
        root: scroller,
        rootMargin: `0px 0px ${newerBottomLoadThreshold}px 0px`,
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNewer, loadingNewer, maybeStartBestHistoryLoad, newerBottomLoadThreshold, conversation.id]);

  const jumpToPresentAndScroll = useCallback(async () => {
    forceFollowOutputRef.current = true;
    pendingOlderLoadScrollSnapshotRef.current = null;
    pendingNewerLoadScrollSnapshotRef.current = null;
    historyScrollTransactionActiveRef.current = false;
    viewportAnchorLockRef.current = null;
    viewportAnchorRestoreInProgressRef.current = false;
    pendingMessageJumpTargetRef.current = null;
    setOlderRangeError(false);
    setNewerRangeError(false);
    await jumpToPresent();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottom('auto');
        syncScrollState();
      });
    });
  }, [jumpToPresent, scrollToBottom, syncScrollState]);

  useEffect(() => {
    if (!ownSendJumpRequest || ownSendJumpRequest === lastOwnSendJumpRequestRef.current) {
      return;
    }

    lastOwnSendJumpRequestRef.current = ownSendJumpRequest;
    void jumpToPresentAndScroll().finally(() => {
      onOwnSendJumpSettled?.();
    });
  }, [jumpToPresentAndScroll, onOwnSendJumpSettled, ownSendJumpRequest]);

  const handleJumpToPresent = useCallback(async () => {
    await jumpToPresentAndScroll();
  }, [jumpToPresentAndScroll]);

  const handleAttachmentLoad = useCallback(() => {
    if (highlightedMessageId) {
      requestAnimationFrame(() => {
        scrollToMessageById(highlightedMessageId, 'auto', { highlight: false });
      });
      return;
    }

    if (!atBottomRef.current && !forceFollowOutputRef.current) {
      restoreViewportAnchorLock();
      return;
    }

    requestAnimationFrame(() => {
      scrollToBottom('auto');
      forceFollowOutputRef.current = false;
    });
  }, [
    highlightedMessageId,
    restoreViewportAnchorLock,
    scrollToBottom,
    scrollToMessageById,
  ]);

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
    firstVisualMessageId,
    lastVisualMessageId,
  ]);

  // ── Follow output for new messages / own sends ──
  useLayoutEffect(() => {
    const nextCount = listItems.length;
    const previousCount = previousListCountRef.current;
    const countIncreased = nextCount > previousCount;

    if (
      countIncreased &&
      !loadingNewer &&
      !pendingNewerLoadScrollSnapshotRef.current &&
      !pendingMessageJumpTargetRef.current &&
      (forceFollowOutputRef.current || atBottomRef.current)
    ) {
      requestAnimationFrame(() => {
        scrollToBottom(forceFollowOutputRef.current ? 'auto' : 'smooth');
        forceFollowOutputRef.current = false;
        syncScrollState();
      });
    }

    previousListCountRef.current = nextCount;
  }, [listItems.length, loadingNewer, scrollToBottom, syncScrollState]);

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

    const loadedScrollHeight = getLoadedScrollHeight(scroller);
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
    getLoadedScrollHeight,
    hasOlder,
    initialHydrationSettled,
    loadOlderPreservingViewport,
    loading,
    loadingOlder,
  ]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    // Pagination state can commit before the load promise settles. Compensate
    // that commit immediately so the skeleton-to-message swap never paints
    // without its captured viewport anchor.
    let restoredHistoryViewport = false;
    const olderSnapshot = pendingOlderLoadScrollSnapshotRef.current;
    const newerSnapshot = pendingNewerLoadScrollSnapshotRef.current;
    viewportAnchorRestoreInProgressRef.current = Boolean(olderSnapshot || newerSnapshot);

    try {
      if (olderSnapshot) {
        const restoredOlderViewport = restoreHistoryLoadScrollSnapshot(olderSnapshot);
        restoredHistoryViewport = restoredOlderViewport || restoredHistoryViewport;
        if (olderSnapshot.readyToRestore && restoredOlderViewport) {
          pendingOlderLoadScrollSnapshotRef.current = null;
        }
      }

      if (newerSnapshot) {
        const restoredNewerViewport = restoreNewerHistoryLoadScrollSnapshot(newerSnapshot);
        restoredHistoryViewport = restoredNewerViewport || restoredHistoryViewport;
        if (newerSnapshot.readyToRestore && restoredNewerViewport) {
          pendingNewerLoadScrollSnapshotRef.current = null;
        }
      }
    } finally {
      viewportAnchorRestoreInProgressRef.current = false;
    }

    if (restoredHistoryViewport) {
      captureViewportAnchorLock(scroller);
    }

    historyScrollTransactionActiveRef.current = Boolean(
      pendingOlderLoadScrollSnapshotRef.current ||
      pendingNewerLoadScrollSnapshotRef.current
    );
  }, [
    bottomSpacerHeight,
    captureViewportAnchorLock,
    hasOlder,
    hasNewer,
    historyRestoreRevision,
    restoreNewerHistoryLoadScrollSnapshot,
    restoreHistoryLoadScrollSnapshot,
    topSpacerHeight,
    visualMessages.length,
    firstVisualMessageId,
    lastVisualMessageId,
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
      if (
        historyScrollTransactionActiveRef.current ||
        !atBottomRef.current ||
        showJumpToPresentRef.current
      ) {
        restoreViewportAnchorLock();
      }
      syncScrollState();
    });

    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [
    attemptInitialBottomRestore,
    maybeAutofillOlder,
    restoreViewportAnchorLock,
    syncScrollState,
  ]);

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
        replyParentLoading={message.reply_to ? isReplyParentLoading(message.reply_to) : false}
        messageReactions={reactions[message.message_id] || message.reactions || emptyReactions}
        isHighlighted={highlightedMessageId === message.message_id}
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
        onJumpToMessage={handleJumpToMessage}
        onEdit={onEdit}
        onRetryFailed={encryptionKey ? handleRetryFailedMessage : undefined}
        onDelete={handleDelete}
        onToggleReaction={handleToggleReaction}
        onOpenImageViewer={openImageViewer}
        onAttachmentLoad={handleAttachmentLoad}
        canLoadAttachments={nearViewportMessageIds.has(message.message_id)}
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
    isReplyParentLoading,
    getSenderAvatarUrl,
    getSmartDisplayName,
    getSmartUsername,
    handleAttachmentLoad,
    handleContextMenu,
    handleDelete,
    handleJumpToMessage,
    handleOpenMessageLink,
    handleProfileClick,
    handleRetryFailedMessage,
    handleToggleReaction,
    highlightedMessageId,
    layoutTraitsById,
    messageGroupSpacing,
    metaFontSize,
    nearViewportMessageIds,
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
      <MessageJumpNotice message={messageJumpNotice} />
      <MessageTimelineViewport
        setScrollerRef={setScrollerRef}
        onScroll={handleScroll}
        initialRestoreDone={initialLatestRestoreDoneRef.current}
        topLogicalRangeHeight={topLogicalRangeHeight}
        renderedTopSpacerHeight={renderedTopSpacerHeight}
        topHistorySkeletonRowCount={topHistorySkeletonRowCount}
        olderRangeStatus={olderRangeStatus}
        hasOlder={hasOlder}
        olderSentinelRef={olderSentinelRef}
        showHeader={!hasOlder && topLogicalRangeHeight <= 1}
        header={(
          <MessageViewHeader
            conversation={conversation}
            headerIdentity={headerIdentity}
            onProfileClick={handleProfileClick}
          />
        )}
        bottomLogicalRangeHeight={bottomLogicalRangeHeight}
        renderedBottomSpacerHeight={renderedBottomSpacerHeight}
        bottomHistorySkeletonRowCount={bottomHistorySkeletonRowCount}
        newerRangeStatus={newerRangeStatus}
        hasNewer={hasNewer}
        loadingNewer={loadingNewer}
        newerSentinelRef={newerSentinelRef}
        density={density}
      >
        {listItems.length === 0 ? (
          <EmptyMessageTimelineState
            isSecureChatPreparing={isSecureChatPreparing}
            showCachedHistoryFallback={showCachedHistoryFallback}
            conversationSecurityState={conversationSecurityState}
          />
        ) : (
          listItems.map((item) => (
            <Fragment key={item.kind === 'message' ? item.message.message_id : item.id}>
              {renderListItem(item)}
            </Fragment>
          ))
        )}
      </MessageTimelineViewport>

      <JumpToPresentButton
        visible={showJumpToPresent}
        disabledByKeyboard={isMobileKeyboardOpen}
        onJump={handleJumpToPresent}
      />

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
