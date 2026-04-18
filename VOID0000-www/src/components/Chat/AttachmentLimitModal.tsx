import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

interface AttachmentLimitModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  message: string;
}

export default function AttachmentLimitModal({
  isOpen,
  onClose,
  title = 'Upload Limit Reached',
  message,
}: AttachmentLimitModalProps) {
  useEffect(() => {
    if (!isOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[340] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-void-bg-hover bg-void-bg-sec shadow-2xl">
        <div className="border-b border-void-bg-hover px-5 py-4">
          <div className="flex items-center gap-2 text-void-text">
            <AlertTriangle className="h-5 w-5 text-amber-300" />
            <h3 className="text-base font-semibold">{title}</h3>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-void-text-muted">
            {message}
          </p>
        </div>

        <div className="flex items-center justify-end px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-void-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-void-accent-hover"
          >
            Okay
          </button>
        </div>
      </div>
    </div>
  );
}
