import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LogLevel, type ListRange, type VirtuosoHandle, Virtuoso } from 'react-virtuoso';
import { ArrowDown } from 'lucide-react';
import { useMessageList } from '../../../Services/hooks/Chats/useMessageList';
import { useMessageDisplay } from '../../../Services/hooks/Chats/useMessageDisplay';
import { useReactions } from '../../../Services/hooks/Chats/useReactions';
import type { ConversationSecurityState } from '../../../Services/Chat/conversationSecurityState';
import { parseAttachments } from '../../../Services/Chat/chatService';
import { type Conversation, type ConversationMember, type Message } from '../../../Services/Chat/chatService';
import { isEncryptedAttachment, resolveAttachmentObjectUrl } from '../../../Services/Crypto/attachmentEncryption';
import {
  debugMessageList,
  ensureChatDebugHelpers,
  isMessageListDebugEnabled,
  rawDebugMessageList,
} from '../../../Services/hooks/Chats/MessageList/messageListDebug';
import { useUser } from '../../../Services/Auth/UserContext';
import { useFriends } from '../../../Services/hooks/Friends/useFriends';
import { useUserProfile } from '../../../Services/hooks/editProfile/userProfile';
import { useTheme } from '../../../Services/hooks/Settings/useTheme';
import { formatConversationPreview, setConversationPreview } from '../../../Services/Chat/conversationPreviewCache';
import {
  MessageViewSkeleton,
} from '../../common/Skeleton';
import MessageItem from '../MessageItem';
import MessageOverlays from '../MessageOverlays';
import { buildMessageViewHeaderIdentity } from '../MessageViewHeader';
import {
  extractMessageTextSegments,
  getInviteCodeFromMessageUrl,
  getMessageLinkHostname,
  isTrustedMessageUrl,
} from '../messageLinks';
import ExternalLinkModal from '../MessageViewParts/ExternalLinkModal';
import {
  type MessageViewVirtuosoContext,
  VirtuosoEmptyPlaceholder,
  VirtuosoFooter,
  VirtuosoHeader,
} from './MessageViewVirtuosoParts';
import TypingIndicator, { type TypingParticipant } from '../TypingIndicator';
import { useMessageActions } from '../useMessageActions';
import { useMessageLayout } from '../useMessageLayout';

interface MessageViewProps {
  conversation: Conversation;
  encryptionKey: CryptoKey | null;
  keyVersion?: number;
  encryptionError?: string | null;
  conversationSecurityState?: ConversationSecurityState;
  members: Record<string, ConversationMember>;
  typingParticipants?: TypingParticipant[];
  onReply?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  newMessage?: Message | null;
  userAvatar?: string;
  gateway?: any;
  messageUpdate?: { message_id: string; content: string; is_edited: boolean; edited_at: string } | null;
  messageDelete?: { message_id: string } | null;
}

type MessageListItem =
  | { kind: 'message'; message: Message }
  | { kind: 'typing'; id: 'typing-indicator' };

const normalizeText = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

const virtuosoDefaultItemHeight = 84;
const defaultLayoutTraits = Object.freeze({ startsGroup: true, showDateSeparator: false });
const emptyReactions: Record<string, unknown> = Object.freeze({});
const virtuosoMinOverscanItemCount = { top: 6, bottom: 4 } as const;
const virtuosoIncreaseViewportBy = { top: 900, bottom: 180 } as const;
const initialTopMostItemIndex = { index: 'LAST' as const, align: 'end' as const };

const MessageView = memo(function MessageView({
  conversation,
  encryptionKey,
  keyVersion,
  encryptionError,
  conversationSecurityState,
  members,
  typingParticipants = [],
  onReply,
  onEdit,
  newMessage,
  userAvatar,
  gateway,
  messageUpdate,
  messageDelete,
}: MessageViewProps) {
  const { user } = useUser();
  const showDebugButton = isMessageListDebugEnabled();
  const scrollerElementRef = useRef<HTMLElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const atBottomRef = useRef(true);
  const forceFollowOutputRef = useRef(false);
  const initialLatestRestoreDoneRef = useRef(false);
  const prependedBatchObserverCleanupRef = useRef<(() => void) | null>(null);
  const renderedMessageItemsRef = useRef<Array<{ messageId: string; originalIndex: number | null }>>([]);
  const visibleRangeRef = useRef<ListRange | null>(null);
  const totalListHeightRef = useRef<number | null>(null);
  const lastStartReachedRef = useRef<{ index: number; at: number } | null>(null);
  const lastExplicitScrollActionRef = useRef<{ action: string; at: number } | null>(null);
  const finalBoundaryBeforeSnapshotRef = useRef<Record<string, unknown> | null>(null);
  const committedAnchorSnapshotRef = useRef<Record<string, unknown> | null>(null);
  const visibleRangeAnchorRef = useRef<{
    messageId: string | null;
    originalIndex: number | null;
  } | null>(null);
  const messageCountRef = useRef(0);
  const listItemCountRef = useRef(0);
  const viewStateSnapshotRef = useRef({
    isAtBottom: true,
    isAtPresent: true,
    hasOlder: false,
    hasNewer: false,
    loadingOlder: false,
  });
  const [pendingExternalLink, setPendingExternalLink] = useState<{ url: string; hostname: string } | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasUnseenMessages, setHasUnseenMessages] = useState(false);
  const { density, messageGroupSpacing, chatFontScale } = useTheme();
  const { friends } = useFriends();
  const { profile: myProfile } = useUserProfile(user?.profile_id || '');
  const currentMember = user?.id ? members[user.id] || null : null;
  const waitForEncryptionBootstrap = !encryptionKey && conversationSecurityState?.status === 'recovering';
  const initReactionsFromMessagesRef = useRef<(messages: Array<{ message_id: string; reactions?: any }>) => void>(() => {});
  const handleInitReactionsFromMessages = useCallback((loadedMessages: Array<{ message_id: string; reactions?: any }>) => {
    initReactionsFromMessagesRef.current(loadedMessages);
  }, []);

  const getScrollerRangeSnapshot = useCallback(() => {
    const scroller = scrollerElementRef.current;
    const renderedMessages = renderedMessageItemsRef.current;
    const lastStartReached = lastStartReachedRef.current;
    const lastExplicitScrollAction = lastExplicitScrollActionRef.current;
    const viewStateSnapshot = viewStateSnapshotRef.current;
    const now = performance.now();
    const scrollHeight = scroller ? Math.round(scroller.scrollHeight) : null;
    const viewportHeight = scroller ? Math.round(scroller.clientHeight) : null;
    const listUnderfilled = (
      scrollHeight != null &&
      viewportHeight != null
        ? scrollHeight <= viewportHeight + 1
        : null
    );

    return {
      scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      scrollHeight,
      viewportHeight,
      listUnderfilled,
      viewportFillMode: listUnderfilled == null ? null : (listUnderfilled ? 'underfilled' : 'scrollable'),
      messageCount: messageCountRef.current,
      listItemCount: listItemCountRef.current,
      alignToBottomEnabled: true,
      initialLatestRestoreDone: initialLatestRestoreDoneRef.current,
      isAtBottom: viewStateSnapshot.isAtBottom,
      isAtPresent: viewStateSnapshot.isAtPresent,
      hasOlder: viewStateSnapshot.hasOlder,
      hasNewer: viewStateSnapshot.hasNewer,
      loadingOlder: viewStateSnapshot.loadingOlder,
      atTopBoundary: scroller ? scroller.scrollTop <= 4 : null,
      visibleRange: visibleRangeRef.current,
      renderedRange: renderedMessages.length > 0
        ? {
            startOriginalIndex: renderedMessages[0]?.originalIndex ?? null,
            endOriginalIndex: renderedMessages[renderedMessages.length - 1]?.originalIndex ?? null,
            firstRenderedMessageId: renderedMessages[0]?.messageId ?? null,
            lastRenderedMessageId: renderedMessages[renderedMessages.length - 1]?.messageId ?? null,
            renderedMessageCount: renderedMessages.length,
          }
        : null,
      totalListHeight: totalListHeightRef.current,
      lastStartReached: lastStartReached
        ? {
            index: lastStartReached.index,
            msAgo: Math.round(now - lastStartReached.at),
          }
        : null,
      lastExplicitScrollAction: lastExplicitScrollAction
        ? {
            action: lastExplicitScrollAction.action,
            msAgo: Math.round(now - lastExplicitScrollAction.at),
          }
        : null,
    };
  }, []);

  const {
    messages,
    loading,
    initialHydrationSettled,
    loadingOlder,
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
    currentMember,
    encryptionKey,
    keyVersion,
    newMessage,
    messageUpdate,
    messageDelete,
    handleInitReactionsFromMessages,
    waitForEncryptionBootstrap,
  );
  const { reactions, handleToggleReaction, initReactionsFromMessages } =
    useReactions(conversation.id, gateway, user?.id, isAtPresent);
  initReactionsFromMessagesRef.current = initReactionsFromMessages;

  const { formatTime, getSenderName, getSenderAvatarUrl } = useMessageDisplay(members, userAvatar);
  const visualMessages = messages;
  messageCountRef.current = visualMessages.length;
  listItemCountRef.current = visualMessages.length + (typingParticipants.length > 0 ? 1 : 0);
  viewStateSnapshotRef.current = {
    isAtBottom,
    isAtPresent,
    hasOlder,
    hasNewer,
    loadingOlder,
  };
  const layoutTraitsById = useMessageLayout(visualMessages, groupBreakBeforeIds, hasOlder);

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

  useEffect(() => {
    ensureChatDebugHelpers();
  }, []);

  useEffect(() => {
    atBottomRef.current = true;
    forceFollowOutputRef.current = false;
    initialLatestRestoreDoneRef.current = false;
    setIsAtBottom(true);
    setHasUnseenMessages(false);
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

  const handleStartReached = useCallback((index: number) => {
    const payload = {
      conversationId: conversation.id,
      index,
      ...getScrollerRangeSnapshot(),
    };
    lastStartReachedRef.current = {
      index,
      at: performance.now(),
    };
    rawDebugMessageList('start_reached', payload);
    debugMessageList('start_reached', payload);
    if (loadingOlder || !hasOlder) {
      return;
    }
    void loadOlder();
  }, [conversation.id, getScrollerRangeSnapshot, hasOlder, loadOlder, loadingOlder]);

  const handleJumpToPresent = useCallback(async () => {
    const payload = {
      conversationId: conversation.id,
      action: 'jump_to_present',
      ...getScrollerRangeSnapshot(),
    };
    lastExplicitScrollActionRef.current = {
      action: 'jump_to_present',
      at: performance.now(),
    };
    rawDebugMessageList('explicit_scroll_action', payload);
    debugMessageList('explicit_scroll_action', payload);
    forceFollowOutputRef.current = true;
    await jumpToPresent();
    setHasUnseenMessages(false);
  }, [conversation.id, getScrollerRangeSnapshot, jumpToPresent]);

  const followOutput = useCallback((atBottom: boolean) => {
    if (loadingOlder) {
      return false;
    }

    if (forceFollowOutputRef.current) {
      return 'auto';
    }

    if (!atBottom || !isAtPresent) {
      return false;
    }

    return 'auto';
  }, [isAtPresent, loadingOlder]);

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom;
    setIsAtBottom(atBottom);

    if (atBottom) {
      setHasUnseenMessages(false);
      forceFollowOutputRef.current = false;
    }

    setIsAtPresent(atBottom && !hasNewer);
  }, [hasNewer, setIsAtPresent]);

  const handleAttachmentLoad = useCallback(() => {
    if (!atBottomRef.current) {
      return;
    }

    const payload = {
      conversationId: conversation.id,
      action: 'attachment_autoscroll_to_bottom',
      ...getScrollerRangeSnapshot(),
    };
    lastExplicitScrollActionRef.current = {
      action: 'attachment_autoscroll_to_bottom',
      at: performance.now(),
    };
    rawDebugMessageList('explicit_scroll_action', payload);
    debugMessageList('explicit_scroll_action', payload);
    requestAnimationFrame(() => {
      virtuosoRef.current?.autoscrollToBottom();
    });
  }, [conversation.id, getScrollerRangeSnapshot]);

  useEffect(() => {
    if (initialLatestRestoreDoneRef.current || !initialHydrationSettled || visualMessages.length === 0) {
      return;
    }

    initialLatestRestoreDoneRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const payload = {
          conversationId: conversation.id,
          action: 'initial_latest_restore',
          ...getScrollerRangeSnapshot(),
        };
        lastExplicitScrollActionRef.current = {
          action: 'initial_latest_restore',
          at: performance.now(),
        };
        rawDebugMessageList('explicit_scroll_action', payload);
        debugMessageList('explicit_scroll_action', payload);
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
      });
    });
  }, [conversation.id, getScrollerRangeSnapshot, initialHydrationSettled, visualMessages.length]);

  // Refs keep callback references stable so MessageItem memo isn't broken
  // by identity changes in friends/members/user during key rotation.
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

    const u = userRef.current;
    if (senderId === u?.id) {
      return normalizeText(myProfileRef.current?.display_name) || normalizeText(u?.username) || 'You';
    }
    const friend = friendsRef.current.find((entry) => entry.id === senderId);
    const friendDisplayName = normalizeText(friend?.display_name);
    if (friendDisplayName) return friendDisplayName;
    const friendUsername = normalizeText(friend?.username);
    if (friendUsername) return friendUsername;
    return getSenderName(senderId);
  }, [conversation.type, getSenderName]);

  const getSmartUsername = useCallback((senderId: string) => {
    const u = userRef.current;
    if (senderId === u?.id) {
      return normalizeText(u?.username);
    }
    const friend = friendsRef.current.find((entry) => entry.id === senderId);
    return normalizeText(friend?.username) || normalizeText(membersRef.current[senderId]?.username);
  }, []);

  const headerIdentity = useMemo(
    () => buildMessageViewHeaderIdentity({ conversation, members, friends, currentUserId: user?.id }),
    [conversation, friends, members, user?.id],
  );
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const headerIdentityRef = useRef(headerIdentity);
  headerIdentityRef.current = headerIdentity;

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
  }, [openBrowserLink]);

  const handleConfirmExternalLink = useCallback(() => {
    if (!pendingExternalLink) return;
    openBrowserLink(pendingExternalLink.url);
    setPendingExternalLink(null);
  }, [openBrowserLink, pendingExternalLink]);

  const listItems: MessageListItem[] = useMemo(() => [
    ...visualMessages.map((message) => ({ kind: 'message' as const, message })),
    ...(typingParticipants.length > 0 ? [{ kind: 'typing' as const, id: 'typing-indicator' as const }] : []),
  ], [typingParticipants.length, visualMessages]);
  const messageIndexById = useMemo(() => {
    const indexById = new Map<string, number>();
    visualMessages.forEach((message, index) => {
      indexById.set(message.message_id, index);
    });
    return indexById;
  }, [visualMessages]);

  const showCachedHistoryFallback = Boolean(
    !encryptionKey &&
      (
        conversationSecurityState?.showCachedHistoryFallback ||
        encryptionError
      ),
  );
  const typingParticipantsSignature = useMemo(
    () => typingParticipants.map((participant) => [
      participant.userId,
      participant.displayName,
      participant.username || '',
      participant.avatarUrl || '',
    ].join(':')).join('|'),
    [typingParticipants],
  );
  const emptyStateSignature = messages.length === 0
    ? `${showCachedHistoryFallback ? '1' : '0'}:${conversationSecurityState?.detail || ''}`
    : '';
  const emptyStateRef = useRef({
    showCachedHistoryFallback,
    securityDetail: conversationSecurityState?.detail,
  });
  const visibleAnchorRef = useRef<{
    messageId: string | null;
    originalIndex: number | null;
  } | null>(null);
  const previousLoadingOlderRef = useRef(loadingOlder);
  const previousFirstItemIndexRef = useRef(firstItemIndex);
  emptyStateRef.current = {
    showCachedHistoryFallback,
    securityDetail: conversationSecurityState?.detail,
  };

  useEffect(() => {
    const latestMessage = [...messages].reverse().find((message) =>
      String(message.conversation_id || conversation.id) === String(conversation.id)
    ) || null;

    setConversationPreview(
      [conversation.id, conversation.public_id],
      formatConversationPreview(latestMessage, user?.id),
    );
  }, [conversation.id, conversation.public_id, messages, user?.id]);

  useEffect(() => {
    visualMessages.forEach((message) => {
      parseAttachments(message.attachments)
        .filter(isEncryptedAttachment)
        .forEach((attachment) => {
          void resolveAttachmentObjectUrl(attachment).catch(() => {});
        });
    });
  }, [visualMessages]);

  const handleScrollerRef = useCallback((element: HTMLElement | Window | null) => {
    scrollerElementRef.current = element instanceof HTMLElement ? element : null;
  }, []);

  const measureVisibleAnchor = useCallback(() => {
    const anchor = visibleRangeAnchorRef.current || visibleAnchorRef.current;
    const scroller = scrollerElementRef.current;

    if (!anchor?.messageId || !scroller) {
      return {
        topVisibleMessageId: anchor?.messageId ?? null,
        topVisibleOriginalIndex: anchor?.originalIndex ?? null,
        topVisibleOffsetPx: null,
        scrollerScrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      };
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const messageElements = Array.from(scroller.querySelectorAll<HTMLElement>('[data-message-id]'));
    const domVisibleAnchor = messageElements.find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > scrollerRect.top + 1 && rect.top < scrollerRect.bottom - 1;
    }) || messageElements.find((element) => element.getBoundingClientRect().bottom > scrollerRect.top + 1) || null;

    if (domVisibleAnchor?.dataset.messageId) {
      const messageId = domVisibleAnchor.dataset.messageId;
      const domRect = domVisibleAnchor.getBoundingClientRect();

      return {
        topVisibleMessageId: messageId,
        topVisibleOriginalIndex: messageIndexById.get(messageId) ?? null,
        topVisibleOffsetPx: Math.round(domRect.top - scrollerRect.top),
        scrollerScrollTop: Math.round(scroller.scrollTop),
        anchorSource: 'dom-visible',
        derivedAnchorMessageId: anchor.messageId,
        derivedAnchorOriginalIndex: anchor.originalIndex,
      };
    }

    const anchorElement = messageElements.find((element) => element.dataset.messageId === anchor.messageId);

    if (!anchorElement) {
      return {
        topVisibleMessageId: anchor.messageId,
        topVisibleOriginalIndex: messageIndexById.get(anchor.messageId) ?? anchor.originalIndex,
        topVisibleOffsetPx: null,
        scrollerScrollTop: Math.round(scroller.scrollTop),
        anchorSource: 'derived-missing-dom',
        derivedAnchorMessageId: anchor.messageId,
        derivedAnchorOriginalIndex: anchor.originalIndex,
      };
    }

    const anchorRect = anchorElement.getBoundingClientRect();

    return {
      topVisibleMessageId: anchor.messageId,
      topVisibleOriginalIndex: messageIndexById.get(anchor.messageId) ?? anchor.originalIndex,
      topVisibleOffsetPx: Math.round(anchorRect.top - scrollerRect.top),
      scrollerScrollTop: Math.round(scroller.scrollTop),
      anchorSource: 'derived-fallback',
      derivedAnchorMessageId: anchor.messageId,
      derivedAnchorOriginalIndex: anchor.originalIndex,
    };
  }, [messageIndexById]);

  const buildAnchorLayoutSnapshot = useCallback((messageId: string | null) => {
    if (!messageId) {
      return {
        anchorMessageId: null,
        layoutKnown: false,
      };
    }

    const anchorIndex = visualMessages.findIndex((message) => message.message_id === messageId);
    if (anchorIndex < 0) {
      return {
        anchorMessageId: messageId,
        layoutKnown: false,
      };
    }

    const anchorMessage = visualMessages[anchorIndex]!;
    const traits = layoutTraitsById[messageId] || defaultLayoutTraits;
    const hasUnknownPreviousContext = anchorIndex === 0 && hasOlder;
    const hasPaginationBreak = groupBreakBeforeIds.has(messageId);
    const isOwn = anchorMessage.sender_id === user?.id;
    const showSenderMeta = traits.startsGroup;
    const showAvatar = showSenderMeta && (density === 'compact' ? true : !isOwn);
    const replyParent = anchorMessage.reply_to ? getReplyParent(anchorMessage.reply_to) : null;
    const attachmentCount = parseAttachments(anchorMessage.attachments).length;

    return {
      anchorMessageId: messageId,
      layoutKnown: true,
      anchorOriginalIndex: anchorIndex,
      startsGroup: traits.startsGroup,
      showDateSeparator: traits.showDateSeparator,
      hasUnknownPreviousContext,
      hasPaginationBreak,
      showSenderMeta,
      showAvatar,
      isOwn,
      hasReplyPreview: Boolean(anchorMessage.reply_to),
      replyPreviewResolved: Boolean(replyParent),
      hasAttachment: attachmentCount > 0,
      attachmentCount,
      messageType: anchorMessage.message_type,
      outerPaddingMode: traits.startsGroup ? 'group' : 'consecutive',
      messageGroupSpacing,
      density,
    };
  }, [
    density,
    getReplyParent,
    groupBreakBeforeIds,
    hasOlder,
    layoutTraitsById,
    messageGroupSpacing,
    user?.id,
    visualMessages,
  ]);

  const buildMessageLayoutSnapshot = useCallback((message: Message) => {
    const traits = layoutTraitsById[message.message_id] || defaultLayoutTraits;
    const messageIndex = visualMessages.findIndex((entry) => entry.message_id === message.message_id);
    const hasUnknownPreviousContext = messageIndex === 0 && hasOlder;
    const hasPaginationBreak = groupBreakBeforeIds.has(message.message_id);
    const isOwn = message.sender_id === user?.id;
    const showSenderMeta = traits.startsGroup;
    const showAvatar = showSenderMeta && (density === 'compact' ? true : !isOwn);
    const attachmentCount = parseAttachments(message.attachments).length;
    const hasInviteEmbed = Boolean(
      message.content &&
      message.content !== '[encrypted]' &&
      extractMessageTextSegments(message.content).some(
        (segment) => segment.type === 'link' && Boolean(getInviteCodeFromMessageUrl(segment.url))
      )
    );

    return {
      messageId: message.message_id,
      messageType: message.message_type,
      startsGroup: traits.startsGroup,
      showDateSeparator: traits.showDateSeparator,
      hasUnknownPreviousContext,
      hasPaginationBreak,
      showSenderMeta,
      showAvatar,
      hasReplyPreview: Boolean(message.reply_to),
      replyPreviewResolved: message.reply_to ? Boolean(getReplyParent(message.reply_to)) : false,
      hasAttachment: attachmentCount > 0,
      attachmentCount,
      hasInviteEmbed,
      outerPaddingMode: traits.startsGroup ? 'group' : 'consecutive',
    };
  }, [
    density,
    getReplyParent,
    groupBreakBeforeIds,
    hasOlder,
    layoutTraitsById,
    user?.id,
    visualMessages,
  ]);

  const summarizeScrollerElement = useCallback((element: HTMLElement, depth = 0): Record<string, unknown> => {
    const computed = window.getComputedStyle(element);
    const childElements = Array.from(element.children).filter((child): child is HTMLElement => child instanceof HTMLElement);

    return {
      depth,
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      className: element.className || null,
      childCount: childElements.length,
      clientHeight: Math.round(element.clientHeight),
      scrollHeight: Math.round(element.scrollHeight),
      offsetHeight: Math.round(element.offsetHeight),
      position: computed.position,
      overflowY: computed.overflowY,
      marginTop: computed.marginTop,
      marginBottom: computed.marginBottom,
      dataset: { ...element.dataset },
      children: depth >= 2
        ? undefined
        : childElements.slice(0, 6).map((child) => summarizeScrollerElement(child, depth + 1)),
    };
  }, []);

  const getFinalBoundaryScrollerSnapshot = useCallback(() => {
    const scroller = scrollerElementRef.current;
    const scrollerTree = scroller ? summarizeScrollerElement(scroller) : null;

    return {
      ...getScrollerRangeSnapshot(),
      scrollerTree,
      scrollerChildCount: scroller?.children.length ?? null,
      renderedMessageNodeCount: scroller?.querySelectorAll('[data-message-id]').length ?? null,
    };
  }, [getScrollerRangeSnapshot, summarizeScrollerElement]);

  useEffect(() => {
    if (!previousLoadingOlderRef.current && loadingOlder) {
      const anchorMeasurement = measureVisibleAnchor();
      if (hasOlder) {
        finalBoundaryBeforeSnapshotRef.current = {
          conversationId: conversation.id,
          firstItemIndex,
          ...anchorMeasurement,
          ...buildAnchorLayoutSnapshot(anchorMeasurement.topVisibleMessageId),
          ...getFinalBoundaryScrollerSnapshot(),
        };
      } else {
        finalBoundaryBeforeSnapshotRef.current = null;
      }
      debugMessageList('visible_anchor_before', {
        conversationId: conversation.id,
        firstItemIndex,
        ...anchorMeasurement,
        ...buildAnchorLayoutSnapshot(anchorMeasurement.topVisibleMessageId),
        ...getScrollerRangeSnapshot(),
      });
    }

    if (previousLoadingOlderRef.current && !loadingOlder) {
      const anchorMeasurement = measureVisibleAnchor();
      debugMessageList('visible_anchor_after', {
        conversationId: conversation.id,
        firstItemIndex,
        ...anchorMeasurement,
        ...buildAnchorLayoutSnapshot(anchorMeasurement.topVisibleMessageId),
        ...getScrollerRangeSnapshot(),
      });

      if (!hasOlder && finalBoundaryBeforeSnapshotRef.current) {
        const afterPayload = {
          conversationId: conversation.id,
          firstItemIndex,
          ...anchorMeasurement,
          ...buildAnchorLayoutSnapshot(anchorMeasurement.topVisibleMessageId),
          ...getFinalBoundaryScrollerSnapshot(),
        };

        rawDebugMessageList('final_boundary_scroller_before', finalBoundaryBeforeSnapshotRef.current);
        debugMessageList('final_boundary_scroller_before', finalBoundaryBeforeSnapshotRef.current);
        rawDebugMessageList('final_boundary_scroller_after', afterPayload);
        debugMessageList('final_boundary_scroller_after', afterPayload);
      }

      finalBoundaryBeforeSnapshotRef.current = null;
    }

    previousLoadingOlderRef.current = loadingOlder;
  }, [
    buildAnchorLayoutSnapshot,
    conversation.id,
    firstItemIndex,
    getFinalBoundaryScrollerSnapshot,
    getScrollerRangeSnapshot,
    hasOlder,
    loadingOlder,
    measureVisibleAnchor,
  ]);

  useLayoutEffect(() => {
    const previousFirstItemIndex = previousFirstItemIndexRef.current;

    if (previousFirstItemIndex === firstItemIndex) {
      return;
    }

    const prependedCount = previousFirstItemIndex > firstItemIndex
      ? previousFirstItemIndex - firstItemIndex
      : 0;

    if (prependedCount <= 0) {
      return;
    }

    const beforePayload = committedAnchorSnapshotRef.current;
    const afterMeasurement = measureVisibleAnchor();
    const afterPayload = {
      conversationId: conversation.id,
      firstItemIndex,
      prependedCount,
      ...afterMeasurement,
      ...buildAnchorLayoutSnapshot(afterMeasurement.topVisibleMessageId),
      ...getScrollerRangeSnapshot(),
    };

    if (beforePayload) {
      rawDebugMessageList('prepend_commit_before', beforePayload);
      debugMessageList('prepend_commit_before', beforePayload);
    }

    rawDebugMessageList('prepend_commit_metrics', afterPayload);
    debugMessageList('prepend_commit_metrics', afterPayload);
  }, [
    buildAnchorLayoutSnapshot,
    conversation.id,
    firstItemIndex,
    getScrollerRangeSnapshot,
    measureVisibleAnchor,
  ]);

  useLayoutEffect(() => {
    const anchorMeasurement = measureVisibleAnchor();
    committedAnchorSnapshotRef.current = {
      conversationId: conversation.id,
      firstItemIndex,
      ...anchorMeasurement,
      ...buildAnchorLayoutSnapshot(anchorMeasurement.topVisibleMessageId),
      ...getScrollerRangeSnapshot(),
    };
  }, [
    buildAnchorLayoutSnapshot,
    conversation.id,
    firstItemIndex,
    getScrollerRangeSnapshot,
    measureVisibleAnchor,
    visualMessages.length,
  ]);

  useEffect(() => {
    const previousFirstItemIndex = previousFirstItemIndexRef.current;

    if (previousFirstItemIndex !== firstItemIndex) {
      debugMessageList('first_item_index_change', {
        conversationId: conversation.id,
        prevFirstItemIndex: previousFirstItemIndex,
        nextFirstItemIndex: firstItemIndex,
        anchor: {
          messageId: measureVisibleAnchor().topVisibleMessageId,
          originalIndex: measureVisibleAnchor().topVisibleOriginalIndex,
        },
        ...getScrollerRangeSnapshot(),
      });

      const prependedCount = previousFirstItemIndex > firstItemIndex
        ? previousFirstItemIndex - firstItemIndex
        : 0;

      if (prependedCount > 0) {
        const prependedMessages = visualMessages.slice(0, prependedCount);
        const prependedRows = prependedMessages.map(buildMessageLayoutSnapshot);
        const activeAnchorMeasurement = measureVisibleAnchor();
        const activeAnchor = {
          messageId: activeAnchorMeasurement.topVisibleMessageId,
          originalIndex: activeAnchorMeasurement.topVisibleOriginalIndex,
        };
        const anchorOriginalIndex = activeAnchor?.originalIndex ?? null;

        debugMessageList('prepend_batch_rows', {
          conversationId: conversation.id,
          prependedCount,
          rows: prependedRows,
        });

        debugMessageList('prepend_rendered_rows_above_anchor', {
          conversationId: conversation.id,
          anchorMessageId: activeAnchor?.messageId ?? null,
          anchorOriginalIndex,
          rows: renderedMessageItemsRef.current
            .filter((item) => (
              prependedRows.some((row) => row.messageId === item.messageId) &&
              (anchorOriginalIndex == null ||
                (typeof item.originalIndex === 'number' && item.originalIndex < anchorOriginalIndex))
            ))
            .map((item) => ({
              ...prependedRows.find((row) => row.messageId === item.messageId),
              originalIndex: item.originalIndex,
            })),
        });

        prependedBatchObserverCleanupRef.current?.();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const scroller = scrollerElementRef.current;
            if (!scroller || prependedRows.length === 0) {
              return;
            }

            const observedHeights = new Map<string, number>();
            const observer = new ResizeObserver((entries) => {
              entries.forEach((entry) => {
                const element = entry.target as HTMLElement;
                const messageId = element.dataset.messageId;
                if (!messageId) return;

                const nextHeight = Math.round(entry.contentRect.height);
                const prevHeight = observedHeights.get(messageId);
                if (typeof prevHeight === 'number' && prevHeight !== nextHeight) {
                  debugMessageList('prepended_row_height_change', {
                    conversationId: conversation.id,
                    prevHeight,
                    nextHeight,
                    ...prependedRows.find((row) => row.messageId === messageId),
                  });
                }
                observedHeights.set(messageId, nextHeight);
              });
            });

            prependedRows.forEach((row) => {
              const element = scroller.querySelector<HTMLElement>(`[data-message-id="${row.messageId}"]`);
              if (!element) {
                return;
              }
              observedHeights.set(row.messageId, Math.round(element.getBoundingClientRect().height));
              observer.observe(element);
            });

            const timeoutId = window.setTimeout(() => {
              observer.disconnect();
              if (prependedBatchObserverCleanupRef.current) {
                prependedBatchObserverCleanupRef.current = null;
              }
            }, 1500);

            prependedBatchObserverCleanupRef.current = () => {
              window.clearTimeout(timeoutId);
              observer.disconnect();
            };
          });
        });
      }

      previousFirstItemIndexRef.current = firstItemIndex;
    }
  }, [buildMessageLayoutSnapshot, conversation.id, firstItemIndex, getScrollerRangeSnapshot, measureVisibleAnchor, visualMessages]);

  useEffect(() => {
    return () => {
      prependedBatchObserverCleanupRef.current?.();
      prependedBatchObserverCleanupRef.current = null;
    };
  }, []);

  // Stable Virtuoso component references — defined at module scope so Virtuoso
  // never sees new component types on re-render (which causes unmount/remount blink).
  // Dynamic data is passed through the context prop instead.
  const virtuosoComponents = useMemo(() => ({
    Header: VirtuosoHeader,
    Footer: VirtuosoFooter,
    EmptyPlaceholder: VirtuosoEmptyPlaceholder,
  }), []);

  const virtuosoContext: MessageViewVirtuosoContext = useMemo(() => ({
    hasOlder,
    conversationRef,
    headerIdentityRef,
    emptyStateRef,
    handleProfileClick,
  }), [emptyStateSignature, hasOlder, handleProfileClick]);
  const handleEndReached = useCallback(() => {
    if (!isAtPresent && hasNewer) {
      loadNewer();
    }
  }, [hasNewer, isAtPresent, loadNewer]);

  const handleItemsRendered = useCallback((items: Array<{ data?: MessageListItem; originalIndex?: number }>) => {
    const renderedMessages = items
      .filter((item): item is { data: Extract<MessageListItem, { kind: 'message' }>; originalIndex?: number } => (
        item.data?.kind === 'message'
      ))
      .map((item) => ({
        messageId: item.data.message.message_id,
        originalIndex: typeof item.originalIndex === 'number' ? item.originalIndex : null,
      }));

    renderedMessageItemsRef.current = renderedMessages;

    const firstMessageItem = items.find((item) => item.data?.kind === 'message');
    if (!firstMessageItem || !firstMessageItem.data || firstMessageItem.data.kind !== 'message') {
      return;
    }

    visibleAnchorRef.current = {
      messageId: firstMessageItem.data.message.message_id,
      originalIndex: typeof firstMessageItem.originalIndex === 'number' ? firstMessageItem.originalIndex : null,
    };
  }, []);

  const handleRangeChanged = useCallback((range: ListRange) => {
    visibleRangeRef.current = range;
    const anchorOffset = range.startIndex - firstItemIndex;
    const anchorItem = listItems[anchorOffset];
    if (anchorOffset >= 0 && anchorItem?.kind === 'message') {
      visibleRangeAnchorRef.current = {
        messageId: anchorItem.message.message_id,
        originalIndex: anchorOffset,
      };
    }
  }, [firstItemIndex, listItems]);

  const handleTotalListHeightChanged = useCallback((height: number) => {
    totalListHeightRef.current = Math.round(height);
  }, []);

  const renderItemContent = useCallback((_index: number, item: MessageListItem) => {
    if (item.kind === 'typing') {
      return <TypingIndicator typingParticipants={typingParticipantsRef.current} />;
    }
    const message = item.message;
    const traits = layoutTraitsById[message.message_id] || defaultLayoutTraits;

    return (
      <MessageItem
        message={message}
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
        onDelete={handleDelete}
        onToggleReaction={handleToggleReaction}
        onOpenImageViewer={openImageViewer}
        onAttachmentLoad={handleAttachmentLoad}
        onOpenLink={handleOpenMessageLink}
      />
    );
  }, [
    density,
    encryptedFontSize,
    formatTime,
    getReplyParent,
    getSenderAvatarUrl,
    getSmartDisplayName,
    getSmartUsername,
    handleContextMenu,
    handleDelete,
    handleAttachmentLoad,
    handleProfileClick,
    handleToggleReaction,
    layoutTraitsById,
    handleOpenMessageLink,
    messageGroupSpacing,
    metaFontSize,
    onEdit,
    onReply,
    openEmojiPicker,
    openContextMenuAtPosition,
    openImageViewer,
    reactions,
    replyFontSize,
    bubbleFontSize,
    typingParticipantsSignature,
    user?.id,
  ]);

  if (loading && messages.length === 0) return <MessageViewSkeleton density={density} />;

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      <Virtuoso<MessageListItem, MessageViewVirtuosoContext>
        ref={virtuosoRef}
        scrollerRef={handleScrollerRef}
        className="flex-1 min-h-0"
        context={virtuosoContext}
        data={listItems}
        computeItemKey={(_index, item) => item.kind === 'message' ? item.message.message_id : item.id}
        defaultItemHeight={virtuosoDefaultItemHeight}
        firstItemIndex={firstItemIndex}
        atBottomThreshold={12}
        alignToBottom
        logLevel={LogLevel.DEBUG}
        increaseViewportBy={virtuosoIncreaseViewportBy}
        minOverscanItemCount={virtuosoMinOverscanItemCount}
        startReached={handleStartReached}
        followOutput={followOutput}
        initialTopMostItemIndex={initialTopMostItemIndex}
        atBottomStateChange={handleAtBottomStateChange}
        endReached={handleEndReached}
        rangeChanged={handleRangeChanged}
        totalListHeightChanged={handleTotalListHeightChanged}
        itemsRendered={handleItemsRendered}
        itemContent={renderItemContent}
        components={virtuosoComponents}
      />

      {showDebugButton && typeof window !== 'undefined' && typeof window.copyFinalBoundaryDebugReport === 'function' && (
        <button
          onClick={() => {
            void window.copyFinalBoundaryDebugReport?.();
          }}
          className="absolute top-3 right-3 z-20 rounded-md border border-white/15 bg-black/70 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-black/80"
        >
          Copy final boundary
        </button>
      )}

      {!isAtBottom && (hasNewer || hasUnseenMessages) && (
        <button
          onClick={handleJumpToPresent}
          className="fixed bottom-20 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-4 py-2 bg-void-accent hover:bg-void-accent-hover text-white text-xs font-bold rounded-full shadow-lg transition-all z-10"
        >
          <ArrowDown className="w-3.5 h-3.5" />
          Jump to Present
        </button>
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
        onEmojiSelect={handleEmojiSelect}
        onCloseEmojiPicker={closeEmojiPicker}
        onCopyMessageText={handleCopyMessageText}
        onReply={onReply}
        onEdit={onEdit}
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

export default MessageView;
