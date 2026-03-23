import { useCallback, useMemo } from 'react';
import { Virtuoso, type ScrollSeekPlaceholderProps } from 'react-virtuoso';
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
import {
  ChatMessageSkeletonRow,
  getMessageSkeletonBubbleWidth,
  MessageViewSkeleton,
} from '../common/Skeleton';
import MessageItem from './MessageItem';
import MessageOverlays from './MessageOverlays';
import MessageViewHeader, { buildMessageViewHeaderIdentity } from './MessageViewHeader';
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

const MessageView = ({
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
}: MessageViewProps) => {
  const { user } = useUser();
  const { density, messageGroupSpacing, chatFontScale } = useTheme();
  const { friends } = useFriends();
  const { profile: myProfile } = useUserProfile(user?.profile_id || '');
  const { reactions, handleToggleReaction, initReactionsFromMessages } =
    useReactions(conversation.id, gateway, user?.id);

  const {
    messages,
    loading,
    loadingOlder,
    prefetchingOlder,
    loadingNewer,
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
    prefetchOlder,
    initialScrollToMessageId,
  } = useMessageList(
    conversation,
    user?.id,
    encryptionKey,
    keyVersion,
    newMessage,
    messageUpdate,
    messageDelete,
    initReactionsFromMessages,
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
    handleVirtuosoScroll,
    handleStartReached,
    handleRangeChanged,
    scrollSeekConfiguration,
    handleJumpToPresent,
    followOutput,
    handleAtBottomStateChange,
  } = useMessageScroll({
    conversationId: conversation.id,
    currentUserId: user?.id,
    visualMessages,
    loading,
    loadingOlder,
    prefetchingOlder,
    hasOlder,
    hasNewer,
    firstItemIndex,
    initialScrollToMessageId,
    newMessage,
    setIsAtPresent,
    jumpToPresent,
    loadOlder,
    prefetchOlder,
  });

  const getSmartDisplayName = useCallback((senderId: string) => {
    if (senderId === user?.id) {
      return normalizeText(myProfile?.display_name) || normalizeText(user?.username) || 'You';
    }
    const friend = friends.find((entry) => entry.id === senderId);
    const friendDisplayName = normalizeText(friend?.display_name);
    if (friendDisplayName) return friendDisplayName;
    const friendUsername = normalizeText(friend?.username);
    if (friendUsername) return friendUsername;
    return getSenderName(senderId);
  }, [friends, getSenderName, myProfile, user]);

  const getSmartUsername = useCallback((senderId: string) => {
    if (senderId === user?.id) {
      return normalizeText(user?.username);
    }
    const friend = friends.find((entry) => entry.id === senderId);
    return normalizeText(friend?.username) || normalizeText(members[senderId]?.username);
  }, [friends, members, user?.id, user?.username]);

  const headerIdentity = useMemo(
    () => buildMessageViewHeaderIdentity({ conversation, members, friends, currentUserId: user?.id }),
    [conversation, friends, members, user?.id],
  );

  const metaFontSize = Math.max(10, chatFontScale - 4);
  const replyFontSize = Math.max(11, chatFontScale - 2);
  const bubbleFontSize = chatFontScale;
  const encryptedFontSize = Math.max(10, chatFontScale - 3);

  const listItems: MessageListItem[] = useMemo(() => [
    ...visualMessages.map((message) => ({ kind: 'message' as const, message })),
    ...(typingParticipants.length > 0 ? [{ kind: 'typing' as const, id: 'typing-indicator' as const }] : []),
  ], [typingParticipants.length, visualMessages]);

  const renderScrollSeekPlaceholder = useCallback(({ height, index }: ScrollSeekPlaceholderProps) => {
    const alignment = density === 'comfortable' && index % 4 === 1 ? 'outgoing' : 'incoming';
    const startsGroup = index % 3 !== 1;
    const bubbleHeight =
      index % 5 === 2
        ? 'h-12'
        : index % 2 === 0
          ? 'h-10'
          : 'h-8';

    return (
      <div style={{ height }} className="overflow-hidden px-2">
        <div className="flex h-full items-center">
          <div className="w-full">
            <ChatMessageSkeletonRow
              density={density}
              alignment={alignment}
              showAvatar={alignment === 'incoming' && startsGroup}
              showMeta={startsGroup}
              metaWidth={alignment === 'outgoing' ? 'w-20' : index % 4 === 0 ? 'w-24' : 'w-16'}
              bubbleWidth={getMessageSkeletonBubbleWidth(density, alignment, index)}
              bubbleHeight={bubbleHeight}
            />
          </div>
        </div>
      </div>
    );
  }, [density]);

  const renderPaginationSkeleton = useCallback((position: 'top' | 'bottom') => {
    const isBottom = position === 'bottom';
    const alignment = density === 'comfortable' && isBottom ? 'outgoing' : 'incoming';

    return (
      <div className={`pointer-events-none px-4 ${isBottom ? 'pb-3 pt-2' : 'pb-2 pt-3'}`}>
        <div className={`flex ${alignment === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
          <div className="w-full max-w-[min(100%,42rem)] rounded-2xl bg-void-bg-main/70 px-2 py-3 opacity-95 backdrop-blur-sm">
            <ChatMessageSkeletonRow
              density={density}
              alignment={alignment}
              showAvatar={alignment === 'incoming'}
              showMeta
              metaWidth={alignment === 'outgoing' ? 'w-20' : 'w-24'}
              bubbleWidth={getMessageSkeletonBubbleWidth(density, alignment, isBottom ? 1 : 3)}
              bubbleHeight={isBottom ? 'h-9' : 'h-10'}
            />
          </div>
        </div>
      </div>
    );
  }, [density]);

  const showCachedHistoryFallback = Boolean(
    !encryptionKey &&
      (
        conversationSecurityState?.showCachedHistoryFallback ||
        encryptionError
      ),
  );

  if (loading && messages.length === 0) return <MessageViewSkeleton density={density} />;

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      <Virtuoso
        key={headerIdentity.key}
        ref={virtuosoRef}
        scrollerRef={handleScrollerRef}
        className="flex-1 min-h-0"
        data={listItems}
        computeItemKey={(_index, item) => item.kind === 'message' ? item.message.message_id : item.id}
        firstItemIndex={firstItemIndex}
        atBottomThreshold={12}
        alignToBottom
        increaseViewportBy={{ top: topRenderBufferPx, bottom: bottomRenderBufferPx }}
        minOverscanItemCount={{ top: 8, bottom: 4 }}
        scrollSeekConfiguration={scrollSeekConfiguration}
        onScroll={handleVirtuosoScroll}
        startReached={handleStartReached}
        rangeChanged={handleRangeChanged}
        followOutput={followOutput}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        atBottomStateChange={handleAtBottomStateChange}
        endReached={() => {
          if (!isAtPresent && hasNewer) loadNewer();
        }}
        itemContent={(_index, item) => {
          if (item.kind === 'typing') return <TypingIndicator typingParticipants={typingParticipants} />;
          const message = item.message;
          const traits = layoutTraitsById[message.message_id] || { startsGroup: true, showDateSeparator: false };

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
              messageReactions={reactions[message.message_id] || message.reactions || {}}
              formatTime={formatTime}
              getSenderName={getSmartDisplayName}
              getSenderUsername={getSmartUsername}
              getSenderAvatarUrl={getSenderAvatarUrl}
              onProfileClick={handleProfileClick}
              onOpenEmojiPicker={openEmojiPicker}
              onContextMenu={
                message.local_status === 'sending' || message.local_status === 'queued'
                  ? undefined
                  : (event) => handleContextMenu(event, message)
              }
              onReply={onReply}
              onEdit={onEdit}
              onDelete={handleDelete}
              onToggleReaction={handleToggleReaction}
              onOpenImageViewer={openImageViewer}
            />
          );
        }}
        components={{
          ScrollSeekPlaceholder: renderScrollSeekPlaceholder,
          Header: () => (
            <>
              {loadingOlder && renderPaginationSkeleton('top')}
              {hasOlder ? null : <MessageViewHeader conversation={conversation} headerIdentity={headerIdentity} onProfileClick={handleProfileClick} />}
            </>
          ),
          Footer: () => (
            <>
              {loadingNewer ? renderPaginationSkeleton('bottom') : null}
            </>
          ),
          EmptyPlaceholder: () => (
            <p className="text-center text-void-text-muted text-sm py-8">
              {showCachedHistoryFallback
                ? conversationSecurityState?.detail || 'Cached history will appear here after this device regains the latest conversation keys.'
                : 'No messages yet. Say something!'}
            </p>
          ),
        }}
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
};

export default MessageView;
