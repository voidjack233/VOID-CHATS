import { Suspense, lazy, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Forward,
  Pencil,
  Reply,
  Smile,
  Trash2,
  X,
} from 'lucide-react';
import type { Message } from '../../Services/Chat/chatService';
import type { Friend } from '../../Services/hooks/Friends/useFriends';
import FriendProfile from '../common/Friends/FriendProfile';
import UserProfileModal from '../common/Profile/UserProfileModal';
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
  onEmojiSelect: (emoji: string) => void;
  onCloseEmojiPicker: () => void;
  onCopyMessageText: (content?: string) => Promise<void>;
  onReply?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onDelete: (messageId: string) => void | Promise<void>;
  onCloseProfile: () => void;
  onCloseFriend: () => void;
  onCloseImageViewer: () => void;
  onPreviousImage: () => void;
  onNextImage: () => void;
  onSelectImageIndex: (index: number) => void;
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
  onEmojiSelect,
  onCloseEmojiPicker,
  onCopyMessageText,
  onReply,
  onEdit,
  onDelete,
  onCloseProfile,
  onCloseFriend,
  onCloseImageViewer,
  onPreviousImage,
  onNextImage,
  onSelectImageIndex,
}: MessageOverlaysProps) {
  const [contextMenuInteractive, setContextMenuInteractive] = useState(false);

  useEffect(() => {
    if (!contextMenu) {
      setContextMenuInteractive(false);
      return;
    }

    setContextMenuInteractive(false);
    const timer = window.setTimeout(() => {
      setContextMenuInteractive(true);
    }, 180);

    return () => window.clearTimeout(timer);
  }, [contextMenu]);

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
        <div
          className={`fixed z-[70] w-48 overflow-hidden rounded-lg border border-void-bg-hover bg-void-bg-main py-1.5 shadow-2xl flex flex-col select-none ${contextMenuInteractive ? 'pointer-events-auto' : 'pointer-events-none'}`}
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            onClick={() => {
              onOpenEmojiPickerAtPosition(contextMenu.msg.message_id, {
                x: contextMenu.x,
                y: contextMenu.y,
              });
              onCloseContextMenu();
            }}
            className="flex w-full touch-manipulation items-center gap-2 px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-accent hover:text-white"
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <Smile className="w-4 h-4" />
            Add Reaction
          </button>
          <button
            onClick={async () => {
              await onCopyMessageText(contextMenu.msg.content);
              onCloseContextMenu();
            }}
            className="flex w-full touch-manipulation items-center gap-2 px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-accent hover:text-white"
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <Copy className="w-4 h-4" />
            Copy Text
          </button>
          {onReply && (
            <button
              onClick={() => {
                onReply(contextMenu.msg);
                onCloseContextMenu();
              }}
              className="flex w-full touch-manipulation items-center gap-2 px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-accent hover:text-white"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <Reply className="w-4 h-4" />
              Reply
            </button>
          )}
          <button
            disabled
            className="flex w-full cursor-not-allowed items-center gap-2 px-3 py-2 text-left text-sm text-void-text-muted/60"
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <Forward className="w-4 h-4" />
            Forward Message
          </button>
          {contextMenu.msg.sender_id === currentUserId && (
            <>
              <div className="h-px w-full bg-void-bg-hover my-1" />
              {onEdit && (
                <button
                  onClick={() => {
                  onEdit(contextMenu.msg);
                  onCloseContextMenu();
                }}
                  className="flex w-full touch-manipulation items-center gap-2 px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-accent hover:text-white"
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
                className="flex w-full touch-manipulation items-center gap-2 px-3 py-2 text-left text-sm text-red-400 transition-colors hover:bg-red-500 hover:text-white"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Trash2 className="w-4 h-4" />
                Delete Message
              </button>
            </>
          )}
        </div>,
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
