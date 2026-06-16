import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, Trash2, X } from 'lucide-react';
import type { PendingAttachment } from '../../../Services/hooks/Chats/useMessageInput';

interface AttachmentOptionsSheetProps {
  attachment: PendingAttachment | null;
  onClose: () => void;
  onToggleSpoiler: (attachmentId: string) => void;
  onRemove: (attachmentId: string) => void;
}

function formatAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export default function AttachmentOptionsSheet({
  attachment,
  onClose,
  onToggleSpoiler,
  onRemove,
}: AttachmentOptionsSheetProps) {
  useEffect(() => {
    if (!attachment) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [attachment, onClose]);

  if (!attachment || typeof document === 'undefined') {
    return null;
  }

  const sizeLabel = formatAttachmentSize(attachment.size);

  return createPortal(
    <div
      className="fixed inset-0 z-[360] flex items-end justify-center md:hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="attachment-options-title"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 animate-in fade-in bg-black/65 backdrop-blur-[2px] duration-200"
        aria-label="Close attachment options"
      />

      <div className="relative z-[1] w-full max-w-lg animate-in slide-in-from-bottom-5 rounded-t-[28px] border border-void-bg-hover bg-void-bg-main shadow-[0_-20px_60px_rgba(0,0,0,0.48)] duration-200">
        <div className="flex justify-center pb-1 pt-2.5">
          <div className="h-1 w-10 rounded-full bg-void-text-muted/35" />
        </div>

        <div className="flex items-center gap-3 border-b border-void-bg-hover/80 px-4 pb-4 pt-2">
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-void-bg-hover">
            <img
              src={attachment.preview}
              alt=""
              className={`h-full w-full object-cover ${
                attachment.spoiler ? 'scale-110 blur-md brightness-50' : ''
              }`}
            />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="attachment-options-title" className="text-base font-semibold text-void-text">
              Attachment options
            </h2>
            <p className="mt-0.5 truncate text-xs text-void-text-muted">
              {attachment.name}
              {sizeLabel ? ` - ${sizeLabel}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-2 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <button
            type="button"
            onClick={() => {
              onToggleSpoiler(attachment.id);
              onClose();
            }}
            className="flex w-full touch-manipulation items-center gap-3 rounded-2xl bg-void-bg-hover/55 px-4 py-3.5 text-left transition-colors active:bg-void-bg-hover"
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-void-accent/15 text-void-accent">
              {attachment.spoiler ? (
                <Eye className="h-5 w-5" />
              ) : (
                <EyeOff className="h-5 w-5" />
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-void-text">
                {attachment.spoiler ? 'Remove spoiler' : 'Mark as spoiler'}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-void-text-muted">
                {attachment.spoiler
                  ? 'The image will be visible immediately.'
                  : 'People will need to tap the image to reveal it.'}
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              onRemove(attachment.id);
              onClose();
            }}
            className="flex w-full touch-manipulation items-center gap-3 rounded-2xl px-4 py-3.5 text-left text-red-300 transition-colors active:bg-red-500/15"
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/12">
              <Trash2 className="h-5 w-5" />
            </span>
            <span className="text-sm font-semibold">Remove attachment</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
