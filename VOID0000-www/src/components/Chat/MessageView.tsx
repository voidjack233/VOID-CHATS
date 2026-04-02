import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { ArrowDown } from 'lucide-react';
import { useMessageList } from '../../Services/hooks/Chats/useMessageList';
import { useMessageDisplay } from '../../Services/hooks/Chats/useMessageDisplay';
import { useReactions } from '../../Services/hooks/Chats/useReactions';
import type { ConversationSecurityState } from '../../Services/Chat/conversationSecurityState';
import { type Conversation, type ConversationMember, type Message } from '../../Services/Chat/chatService';
import { useUser } from '../../Services/Auth/UserContext';
import { useFriends } from '../../Services/hooks/Friends/useFriends';
import { useUserProfile } from '../../Services/hooks/editProfile/userProfile';
import { useTheme } from '../../Services/hooks/Settings/useTheme';
import { formatConversationPreview, setConversationPreview } from '../../Services/Chat/conversationPreviewCache';
import {
  MessageViewSkeleton,
} from '../common/Skeleton';
import MessageItem from './MessageItem';
import MessageOverlays from './MessageOverlays';
import { buildMessageViewHeaderIdentity } from './MessageViewHeader';
import { getMessageLinkHostname, isTrustedMessageUrl } from './messageLinks';
import {
  createScrollSeekPlaceholderRenderer,
} from './MessageViewParts/MessageViewPlaceholders';
import ExternalLinkModal from './MessageViewParts/ExternalLinkModal';
import {
  type MessageViewVirtuosoContext,
  VirtuosoEmptyPlaceholder,
  VirtuosoFooter,
  VirtuosoHeader,
} from './MessageViewParts/MessageViewVirtuosoParts';
import TypingIndicator, { type TypingParticipant } from './TypingIndicator';
import { useMessageActions } from './useMessageActions';
import { useMessageLayout } from './useMessageLayout';
import { useMessageScroll } from './useMessageScroll';

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

const topRenderBufferPx = 240;
const bottomRenderBufferPx = 200;
const virtuosoDefaultItemHeight = 64;
const defaultLayoutTraits = Object.freeze({ startsGroup: true, showDateSeparator: false });
const emptyReactions: Record<string, unknown> = Object.freeze({});
const virtuosoIncreaseViewportBy = { top: topRenderBufferPx, bottom: bottomRenderBufferPx } as const;
const virtuosoMinOverscanItemCount = { top: 8, bottom: 4 } as const;
const virtuosoOverscan = { main: 500, reverse: 200 } as const;
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
  const [pendingExternalLink, setPendingExternalLink] = useState<{ url: string; hostname: string } | null>(null);
  const { density, messageGroupSpacing, chatFontScale } = useTheme();
  const { friends } = useFriends();
  const { profile: myProfile } = useUserProfile(user?.profile_id || '');
  const { reactions, handleToggleReaction, initReactionsFromMessages } =
    useReactions(conversation.id, gateway, user?.id);
  const currentMember = user?.id ? members[user.id] || null : null;
  const waitForEncryptionBootstrap = !encryptionKey && conversationSecurityState?.status === 'recovering';

  const {
    messages,
    loading,
    initialHydrationSettled,
    loadingOlder,
    prefetchingOlder,
    loadingNewer,
    hasOlder,
    hasNewer,
    isAtPresent,
    firstItemIndex,
    topLoadingPlaceholderCount,
    groupBreakBeforeIds,
    setIsAtPresent,
    handleDelete,
    getReplyParent,
    jumpToPresent,
    loadOlder,
    loadNewer,
    initialScrollToMessageId,
  } = useMessageList(
    conversation,
    user?.id,
    currentMember,
    encryptionKey,
    keyVersion,
    newMessage,
    messageUpdate,
    messageDelete,
    initReactionsFromMessages,
    waitForEncryptionBootstrap,
  );

  const { formatTime, getSenderName, getSenderAvatarUrl } = useMessageDisplay(members, userAvatar);
  const visualMessages = messages;
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

  const {
    virtuosoRef,
    isAtBottom,
    hasUnseenMessages,
    handleScrollerRef,
    handleStartReached,
    handleRangeChanged,
    scrollSeekConfiguration,
    handleJumpToPresent,
    followOutput,
    handleAtBottomStateChange,
    handleAttachmentLoad,
  } = useMessageScroll({
    conversationId: conversation.id,
    currentUserId: user?.id,
    visualMessages,
    loading,
    loadingOlder,
    loadingNewer,
    prefetchingOlder,
    hasOlder,
    hasNewer,
    initialHydrationSettled,
    firstItemIndex,
    topLoadingPlaceholderCount,
    initialScrollToMessageId,
    newMessage,
    setIsAtPresent,
    jumpToPresent,
    loadOlder,
  });

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

  const effectiveFirstItemIndex = firstItemIndex;

  const renderScrollSeekPlaceholder = useMemo(
    () => createScrollSeekPlaceholderRenderer(density),
    [density],
  );
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

  // Stable Virtuoso component references — defined at module scope so Virtuoso
  // never sees new component types on re-render (which causes unmount/remount blink).
  // Dynamic data is passed through the context prop instead.
  const virtuosoComponents = useMemo(() => ({
    ScrollSeekPlaceholder: renderScrollSeekPlaceholder,
    Header: VirtuosoHeader,
    Footer: VirtuosoFooter,
    EmptyPlaceholder: VirtuosoEmptyPlaceholder,
  }), [renderScrollSeekPlaceholder]);

  const virtuosoContext: MessageViewVirtuosoContext = useMemo(() => ({
    loadingOlder,
    hasOlder,
    conversationRef,
    headerIdentityRef,
    emptyStateRef,
    handleProfileClick,
  }), [emptyStateSignature, hasOlder, handleProfileClick, loadingOlder]);

  const handleEndReached = useCallback(() => {
    if (!isAtPresent && hasNewer) {
      loadNewer();
    }
  }, [hasNewer, isAtPresent, loadNewer]);

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
        firstItemIndex={effectiveFirstItemIndex}
        atBottomThreshold={12}
        alignToBottom
        increaseViewportBy={virtuosoIncreaseViewportBy}
        minOverscanItemCount={virtuosoMinOverscanItemCount}
        overscan={virtuosoOverscan}
        scrollSeekConfiguration={scrollSeekConfiguration}
        startReached={handleStartReached}
        rangeChanged={handleRangeChanged}
        followOutput={followOutput}
        initialTopMostItemIndex={initialTopMostItemIndex}
        atBottomStateChange={handleAtBottomStateChange}
        endReached={handleEndReached}
        itemContent={renderItemContent}
        components={virtuosoComponents}
      />

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
