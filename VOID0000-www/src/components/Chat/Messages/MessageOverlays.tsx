import { Suspense, lazy, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Forward,
  Plus,
  Pencil,
  RefreshCcw,
  Reply,
  Smile,
  Trash2,
  X,
} from 'lucide-react';
import type { Message } from '../../../Services/Chat/chatService';
import { MAX_UNIQUE_REACTIONS_PER_MESSAGE, getUniqueReactionCount, hasActiveReactionEntry } from '../../../Services/Chat/reactionLimits';
import type { Friend } from '../../../Services/hooks/Friends/useFriends';
import FriendProfile from '../../common/Friends/FriendProfile';
import UserProfileModal from '../../common/Profile/UserProfileModal';
import EmojiGlyph from './EmojiGlyph';
import type {
  ContextMenuState,
  EmojiPickerTarget,
  ImageViewerState,
} from './useMessageActions';

const EmojiPicker = lazy(() => import('./EmojiPicker'));

interface MessageOverlaysProps {
  contextMenu: ContextMenuState | null;
  emojiPickerTarget: EmojiPickerTarget | null;
  selectedProfileId: string | null;
  selectedFriend: Friend | null;
  imageViewer: ImageViewerState | null;
  currentUserId?: string;
  onCloseContextMenu: () => void;
  onOpenEmojiPickerAtPosition: (messageId: string, position: { x: number; y: number }) => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onEmojiSelect: (emoji: string) => void;
  onCloseEmojiPicker: () => void;
  onCopyMessageText: (content?: string) => Promise<void>;
  onReply?: (message: Message) => void;
  onForward?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onRetryFailed?: (message: Message) => void;
  onDelete: (messageId: string) => void | Promise<void>;
  onCloseProfile: () => void;
  onCloseFriend: () => void;
  onCloseImageViewer: () => void;
  onPreviousImage: () => void;
  onNextImage: () => void;
  onSelectImageIndex: (index: number) => void;
}

const QUICK_REACTIONS = [
  { emoji: '❤️', label: 'Heart' },
  { emoji: '😂', label: 'Haha' },
  { emoji: '😮', label: 'Wow' },
  { emoji: '😢', label: 'Sad' },
  { emoji: '😡', label: 'Angry' },
  { emoji: '👍', label: 'Like' },
];

function messageHasUserReaction(message: Message, emoji: string, currentUserId?: string) {
  if (!currentUserId) return false;

  const reactionData = (message.reactions as Record<string, any> | undefined)?.[emoji];
  if (!reactionData) return false;

  if (Array.isArray(reactionData)) {
    return reactionData.includes(currentUserId);
  }

  if (typeof reactionData === 'object') {
    return Boolean(reactionData.me);
  }

  return false;
}

function messageCanAddReaction(message: Message, emoji?: string) {
  const reactions = message.reactions as Record<string, unknown> | undefined;
  const uniqueReactionCount = getUniqueReactionCount(reactions);

  if (uniqueReactionCount < MAX_UNIQUE_REACTIONS_PER_MESSAGE) {
    return true;
  }

  if (!emoji) {
    return false;
  }

  return hasActiveReactionEntry(reactions, emoji);
}

export default function MessageOverlays({
  contextMenu,
  emojiPickerTarget,
  selectedProfileId,
  selectedFriend,
  imageViewer,
  currentUserId,
  onCloseContextMenu,
  onOpenEmojiPickerAtPosition,
  onToggleReaction,
  onEmojiSelect,
  onCloseEmojiPicker,
  onCopyMessageText,
  onReply,
  onForward,
  onEdit,
  onRetryFailed,
  onDelete,
  onCloseProfile,
  onCloseFriend,
  onCloseImageViewer,
  onPreviousImage,
  onNextImage,
  onSelectImageIndex,
}: MessageOverlaysProps) {
  const [contextMenuVisible, setContextMenuVisible] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );

  useEffect(() => {
    if (!contextMenu) {
      setContextMenuVisible(false);
      return;
    }

    setContextMenuVisible(false);
    const frame = window.requestAnimationFrame(() => {
      setContextMenuVisible(true);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [contextMenu]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const syncViewport = () => {
      setIsMobileViewport(window.innerWidth < 768);
    };

    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  const contextMenuIsCopyable = Boolean(
    contextMenu?.msg.content &&
    contextMenu.msg.content !== '[encrypted]' &&
    contextMenu.msg.content !== '[deleted]',
  );
  const isFailedLocalMessage = contextMenu?.msg.local_status === 'failed';
  const canForwardMessage = Boolean(
    contextMenu &&
    !isFailedLocalMessage &&
    onForward &&
    contextMenu.msg.message_type !== 'system' &&
    (
      (
        contextMenu.msg.content &&
        contextMenu.msg.content !== '[encrypted]' &&
        contextMenu.msg.content !== '[deleted]'
      ) ||
      (contextMenu.msg.attachments?.length ?? 0) > 0
    ),
  );
  const canOpenReactionPicker = contextMenu && !isFailedLocalMessage ? messageCanAddReaction(contextMenu.msg) : false;
  const desktopReactionsOnly = !isFailedLocalMessage && !isMobileViewport && contextMenu?.mode === 'reactions';
  const handleQuickReaction = (emoji: string) => {
    if (!contextMenu) return;
    if (contextMenu.msg.local_status === 'failed') return;
    if (!messageCanAddReaction(contextMenu.msg, emoji)) return;
    onToggleReaction(contextMenu.msg.message_id, emoji);
    onCloseContextMenu();
  };

  return (
    <>
      {emojiPickerTarget && (
        <Suspense fallback={null}>
          <EmojiPicker
            onSelect={onEmojiSelect}
            onClose={onCloseEmojiPicker}
            position={emojiPickerTarget.position}
          />
        </Suspense>
      )}

      {contextMenu && !contextMenu.msg.is_deleted && createPortal(
        isMobileViewport ? (
          <div className="fixed inset-0 z-[70]">
            <button
              type="button"
              aria-label="Close message actions"
              onClick={onCloseContextMenu}
              className="absolute inset-0"
            />
            <div className="absolute inset-x-0 bottom-0 flex justify-center px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-4">
              <div
                onClick={(event) => event.stopPropagation()}
                className={`flex w-full min-w-0 max-w-[min(100%,24rem)] flex-col gap-2 transition-all duration-200 ease-out ${
                  contextMenuVisible
                    ? 'translate-y-0 scale-100 opacity-100'
                    : 'translate-y-5 scale-[0.98] opacity-0'
                }`}
              >
                {!isFailedLocalMessage && (
                  <div className="overflow-x-hidden rounded-[28px] bg-void-bg-main/95 px-3 py-3 shadow-[0_24px_60px_rgba(0,0,0,0.45)] supports-[backdrop-filter]:backdrop-blur">
                    <div className="rounded-2xl bg-void-bg-hover/35 px-1.5 py-1.5">
                      <div className="flex min-w-0 items-center justify-between gap-1 overflow-hidden">
                        {QUICK_REACTIONS.map(({ emoji, label }) => {
                          const isSelected = messageHasUserReaction(contextMenu.msg, emoji, currentUserId);
                          const isDisabled = !messageCanAddReaction(contextMenu.msg, emoji);

                          return (
                            <button
                              key={emoji}
                              type="button"
                              disabled={isDisabled}
                              onClick={() => handleQuickReaction(emoji)}
                              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl transition-all sm:h-10 sm:w-10 ${
                                isDisabled
                                  ? 'cursor-not-allowed opacity-40'
                                  : isSelected
                                  ? 'bg-void-accent/18 shadow-[0_0_0_1px_rgba(59,130,246,0.18)]'
                                  : 'hover:bg-void-bg-hover/80'
                              }`}
                              aria-label={label}
                              title={isDisabled ? 'Maximum of 10 reactions per message' : label}
                              style={{ WebkitTapHighlightColor: 'transparent' }}
                            >
                              <EmojiGlyph
                                emoji={emoji}
                                className="text-[18px] sm:text-[20px]"
                                fallbackClassName="text-[18px] sm:text-[20px]"
                              />
                            </button>
                          );
                        })}

                        {canOpenReactionPicker && (
                          <button
                            type="button"
                            onClick={(event) => {
                              const rect = event.currentTarget.getBoundingClientRect();
                              onOpenEmojiPickerAtPosition(contextMenu.msg.message_id, {
                                x: rect.left + rect.width / 2,
                                y: rect.top,
                              });
                              onCloseContextMenu();
                            }}
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-void-text-muted transition-all hover:bg-void-bg-hover/80 sm:h-10 sm:w-10"
                            aria-label="Add reaction"
                            title="Add reaction"
                            style={{ WebkitTapHighlightColor: 'transparent' }}
                          >
                            <Plus className="h-5 w-5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="overflow-x-hidden rounded-[28px] bg-void-bg-main/95 px-3 py-3 shadow-[0_24px_60px_rgba(0,0,0,0.45)] supports-[backdrop-filter]:backdrop-blur">
                  <div className="mt-0">
                    {isFailedLocalMessage && onRetryFailed && (
                      <button
                        onClick={() => {
                          onRetryFailed(contextMenu.msg);
                          onCloseContextMenu();
                        }}
                        className="flex w-full touch-manipulation items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium text-orange-300 transition-colors hover:bg-orange-500/15 hover:text-orange-200"
                        style={{ WebkitTapHighlightColor: 'transparent' }}
                      >
                        <RefreshCcw className="h-4 w-4" />
                        Retry Send
                      </button>
                    )}
                    {!isFailedLocalMessage && (
                      <button
                        disabled={!canOpenReactionPicker}
                        onClick={() => {
                          if (!canOpenReactionPicker) return;
                          onOpenEmojiPickerAtPosition(contextMenu.msg.message_id, {
                            x: contextMenu.x,
                            y: contextMenu.y,
                          });
                          onCloseContextMenu();
                        }}
                        className={`flex w-full touch-manipulation items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${
                          canOpenReactionPicker
                            ? 'text-void-text hover:bg-void-bg-hover/90'
                            : 'cursor-not-allowed text-void-text-muted/55'
                        }`}
                        style={{ WebkitTapHighlightColor: 'transparent' }}
                      >
                        <Smile className="h-4 w-4 text-void-accent" />
                        Add Reaction
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        await onCopyMessageText(contextMenu.msg.content);
                        onCloseContextMenu();
                      }}
                      disabled={!contextMenuIsCopyable}
                      className={`flex w-full touch-manipulation items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${
                        contextMenuIsCopyable
                          ? 'text-void-text hover:bg-void-bg-hover/90'
                          : 'cursor-not-allowed text-void-text-muted/55'
                      }`}
                      style={{ WebkitTapHighlightColor: 'transparent' }}
                    >
                      <Copy className="h-4 w-4" />
                      Copy Text
                    </button>
                    {onReply && !isFailedLocalMessage && (
                      <button
                        onClick={() => {
                          onReply(contextMenu.msg);
                          onCloseContextMenu();
                        }}
                        className="flex w-full touch-manipulation items-center gap-3 rounded-xl px-4 py-3 text-left text-sm text-void-text transition-colors hover:bg-void-bg-hover/90"
                        style={{ WebkitTapHighlightColor: 'transparent' }}
                      >
                        <Reply className="h-4 w-4" />
                        Reply
                      </button>
                    )}
                    {!isFailedLocalMessage && (
                      <button
                        disabled={!canForwardMessage}
                        onClick={() => {
                          if (!canForwardMessage || !contextMenu || !onForward) return;
                          onForward(contextMenu.msg);
                          onCloseContextMenu();
                        }}
                        className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm transition-colors ${
                          canForwardMessage
                            ? 'text-void-text hover:bg-void-bg-hover/90'
                            : 'cursor-not-allowed text-void-text-muted/55'
                        }`}
                        style={{ WebkitTapHighlightColor: 'transparent' }}
                      >
                        <Forward className="h-4 w-4" />
                        Forward Message
                      </button>
                    )}
                    {contextMenu.msg.sender_id === currentUserId && !isFailedLocalMessage && (
                      <>
                        <div className="mx-4 h-px bg-void-bg-hover/60" />
                        {onEdit && (
                          <button
                            onClick={() => {
                              onEdit(contextMenu.msg);
                              onCloseContextMenu();
                            }}
                            className="flex w-full touch-manipulation items-center gap-3 rounded-xl px-4 py-3 text-left text-sm text-void-text transition-colors hover:bg-void-bg-hover/90"
                            style={{ WebkitTapHighlightColor: 'transparent' }}
                          >
                            <Pencil className="h-4 w-4" />
                            Edit Message
                          </button>
                        )}
                        <button
                          onClick={() => {
                            onDelete(contextMenu.msg.message_id);
                            onCloseContextMenu();
                          }}
                          className="flex w-full touch-manipulation items-center gap-3 rounded-xl px-4 py-3 text-left text-sm text-red-400 transition-colors hover:bg-red-500/15 hover:text-red-300"
                          style={{ WebkitTapHighlightColor: 'transparent' }}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete Message
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : desktopReactionsOnly ? (
          <div
            className={`fixed z-[70] flex max-w-[calc(100vw-1rem)] items-center gap-1 overflow-hidden rounded-2xl border border-void-bg-hover bg-void-bg-main/95 p-2 shadow-2xl supports-[backdrop-filter]:backdrop-blur select-none transition-all duration-150 ease-out ${
              contextMenuVisible ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-1 scale-[0.98] opacity-0'
            }`}
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            {QUICK_REACTIONS.map(({ emoji, label }) => {
              const isSelected = messageHasUserReaction(contextMenu.msg, emoji, currentUserId);
              const isDisabled = isFailedLocalMessage || !messageCanAddReaction(contextMenu.msg, emoji);

              return (
                <button
                  key={emoji}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => handleQuickReaction(emoji)}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl transition-all ${
                    isDisabled
                      ? 'cursor-not-allowed opacity-40'
                      : isSelected
                      ? 'bg-void-accent/18 shadow-[0_0_0_1px_rgba(59,130,246,0.18)]'
                      : 'hover:bg-void-bg-hover/80'
                  }`}
                  aria-label={label}
                  title={isDisabled ? 'Maximum of 10 reactions per message' : label}
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <EmojiGlyph
                    emoji={emoji}
                    className="text-[18px]"
                    fallbackClassName="text-[18px]"
                  />
                </button>
              );
            })}

            {canOpenReactionPicker && (
              <button
                type="button"
                onClick={() => {
                  onOpenEmojiPickerAtPosition(contextMenu.msg.message_id, {
                    x: contextMenu.x,
                    y: contextMenu.y,
                  });
                  onCloseContextMenu();
                }}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-void-text-muted transition-all hover:bg-void-bg-hover/80"
                aria-label="Add reaction"
                title="Add reaction"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Plus className="h-5 w-5" />
              </button>
            )}
          </div>
        ) : (
          <div
            className={`fixed z-[70] flex max-w-[calc(100vw-1rem)] flex-col items-center gap-2 select-none transition-all duration-150 ease-out ${
              contextMenuVisible ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-1 scale-[0.98] opacity-0'
            }`}
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            {!isFailedLocalMessage && (
            <div className="w-max max-w-[calc(100vw-1rem)] rounded-2xl border border-void-bg-hover bg-void-bg-main/95 p-2 shadow-2xl supports-[backdrop-filter]:backdrop-blur">
              <div className="rounded-2xl bg-void-bg-hover/35 px-1.5 py-1.5">
                <div className="flex w-max min-w-0 items-center gap-1">
                  {QUICK_REACTIONS.map(({ emoji, label }) => {
                    const isSelected = messageHasUserReaction(contextMenu.msg, emoji, currentUserId);
                    const isDisabled = isFailedLocalMessage || !messageCanAddReaction(contextMenu.msg, emoji);

                    return (
                      <button
                        key={emoji}
                        type="button"
                        disabled={isDisabled}
                        onClick={() => handleQuickReaction(emoji)}
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl transition-all ${
                          isDisabled
                            ? 'cursor-not-allowed opacity-40'
                            : isSelected
                              ? 'bg-void-accent/18 shadow-[0_0_0_1px_rgba(59,130,246,0.18)]'
                              : 'hover:bg-void-bg-hover/80'
                        }`}
                        aria-label={label}
                        title={isDisabled ? 'Maximum of 10 reactions per message' : label}
                        style={{ WebkitTapHighlightColor: 'transparent' }}
                      >
                        <EmojiGlyph
                          emoji={emoji}
                          className="text-[18px]"
                          fallbackClassName="text-[18px]"
                        />
                      </button>
                    );
                  })}

                  {canOpenReactionPicker && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenEmojiPickerAtPosition(contextMenu.msg.message_id, {
                          x: contextMenu.x,
                          y: contextMenu.y,
                        });
                        onCloseContextMenu();
                      }}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-void-text-muted transition-all hover:bg-void-bg-hover/80"
                      aria-label="Add reaction"
                      title="Add reaction"
                      style={{ WebkitTapHighlightColor: 'transparent' }}
                    >
                      <Plus className="h-5 w-5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
            )}

            <div className="w-[15.5rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl border border-void-bg-hover bg-void-bg-main/95 p-2 shadow-2xl supports-[backdrop-filter]:backdrop-blur">
              {isFailedLocalMessage && onRetryFailed && (
                <button
                  onClick={() => {
                    onRetryFailed(contextMenu.msg);
                    onCloseContextMenu();
                  }}
                  className="flex w-full touch-manipulation items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-orange-300 transition-colors hover:bg-orange-500/15 hover:text-orange-200"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <RefreshCcw className="w-4 h-4" />
                  Retry Send
                </button>
              )}
              {!isFailedLocalMessage && (
                <button
                  disabled={!canOpenReactionPicker}
                  onClick={() => {
                    if (!canOpenReactionPicker) return;
                    onOpenEmojiPickerAtPosition(contextMenu.msg.message_id, {
                      x: contextMenu.x,
                      y: contextMenu.y,
                    });
                    onCloseContextMenu();
                  }}
                  className={`flex w-full touch-manipulation items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                    canOpenReactionPicker
                      ? 'text-void-text hover:bg-void-accent hover:text-white'
                      : 'cursor-not-allowed text-void-text-muted/60'
                  }`}
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <Smile className="w-4 h-4" />
                  Add Reaction
                </button>
              )}
              <button
                onClick={async () => {
                  await onCopyMessageText(contextMenu.msg.content);
                  onCloseContextMenu();
                }}
                disabled={!contextMenuIsCopyable}
                className={`flex w-full touch-manipulation items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                  contextMenuIsCopyable
                    ? 'text-void-text hover:bg-void-accent hover:text-white'
                    : 'cursor-not-allowed text-void-text-muted/60'
                }`}
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Copy className="w-4 h-4" />
                Copy Text
              </button>
              {onReply && !isFailedLocalMessage && (
                <button
                  onClick={() => {
                    onReply(contextMenu.msg);
                    onCloseContextMenu();
                  }}
                  className="flex w-full touch-manipulation items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-accent hover:text-white"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <Reply className="w-4 h-4" />
                  Reply
                </button>
              )}
              {!isFailedLocalMessage && (
                <button
                  disabled={!canForwardMessage}
                  onClick={() => {
                    if (!canForwardMessage || !contextMenu || !onForward) return;
                    onForward(contextMenu.msg);
                    onCloseContextMenu();
                  }}
                  className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                    canForwardMessage
                      ? 'text-void-text hover:bg-void-accent hover:text-white'
                      : 'cursor-not-allowed text-void-text-muted/60'
                  }`}
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <Forward className="w-4 h-4" />
                  Forward Message
                </button>
              )}
              {contextMenu.msg.sender_id === currentUserId && !isFailedLocalMessage && (
                <>
                  <div className="my-1 h-px w-full bg-void-bg-hover" />
                  {onEdit && (
                    <button
                      onClick={() => {
                        onEdit(contextMenu.msg);
                        onCloseContextMenu();
                      }}
                      className="flex w-full touch-manipulation items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-accent hover:text-white"
                      style={{ WebkitTapHighlightColor: 'transparent' }}
                    >
                      <Pencil className="w-4 h-4" />
                      Edit Message
                    </button>
                  )}
                  <button
                    onClick={() => {
                      onDelete(contextMenu.msg.message_id);
                      onCloseContextMenu();
                    }}
                    className="flex w-full touch-manipulation items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-red-400 transition-colors hover:bg-red-500 hover:text-white"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete Message
                  </button>
                </>
              )}
            </div>
          </div>
        ),
        document.body,
      )}

      {selectedProfileId && (
        <UserProfileModal profileId={selectedProfileId} onClose={onCloseProfile} />
      )}

      {selectedFriend && (
        <FriendProfile friend={selectedFriend} onClose={onCloseFriend} />
      )}

      {imageViewer && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-sm"
          onClick={onCloseImageViewer}
        >
          <div
            className="absolute top-4 right-4 flex items-center gap-2 z-10"
            onClick={(event) => event.stopPropagation()}
          >
            <a
              href={imageViewer.urls[imageViewer.index]}
              download
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
              title="Download"
            >
              <Download className="w-5 h-5" />
            </a>
            <button
              onClick={onCloseImageViewer}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {imageViewer.index > 0 && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                onPreviousImage();
              }}
              className="absolute left-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          )}

          <img
            src={imageViewer.urls[imageViewer.index]}
            alt="attachment"
            className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          />

          {imageViewer.index < imageViewer.urls.length - 1 && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                onNextImage();
              }}
              className="absolute right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors z-10"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          )}

          {imageViewer.urls.length > 1 && (
            <div
              className="absolute bottom-4 flex items-center gap-1.5"
              onClick={(event) => event.stopPropagation()}
            >
              {imageViewer.urls.map((_, index) => (
                <button
                  key={index}
                  onClick={() => onSelectImageIndex(index)}
                  className={`w-2 h-2 rounded-full transition-all ${index === imageViewer.index ? 'bg-white scale-125' : 'bg-white/40 hover:bg-white/70'}`}
                />
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
