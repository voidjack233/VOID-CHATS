import { useEffect } from 'react';
import { ExternalLink, ShieldAlert } from 'lucide-react';

interface PendingExternalLink {
  url: string;
  hostname: string;
}

interface ExternalLinkModalProps {
  pendingExternalLink: PendingExternalLink | null;
  onClose: () => void;
  onConfirm: () => void;
}

export default function ExternalLinkModal({
  pendingExternalLink,
  onClose,
  onConfirm,
}: ExternalLinkModalProps) {
  useEffect(() => {
    if (!pendingExternalLink) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, pendingExternalLink]);

  if (!pendingExternalLink) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[330] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-void-bg-hover bg-void-bg-sec shadow-2xl">
        <div className="border-b border-void-bg-hover px-5 py-4">
          <div className="flex items-center gap-2 text-void-text">
            <ShieldAlert className="h-5 w-5 text-amber-300" />
            <h3 className="text-base font-semibold">Open External Link?</h3>
          </div>
          <p className="mt-2 text-sm text-void-text-muted">
            You are leaving VOID to open <span className="font-medium text-void-text">{pendingExternalLink.hostname}</span>.
          </p>
          <div className="mt-3 rounded-xl border border-void-bg-hover bg-void-bg-main/60 px-3 py-2 text-xs text-void-text-muted break-all">
            {pendingExternalLink.url}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-4 py-2.5 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-void-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-void-accent-hover"
          >
            <ExternalLink className="h-4 w-4" />
            Open Link
          </button>
        </div>
      </div>
    </div>
  );
}
