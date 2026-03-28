import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

interface ConfirmDialogProps {
  title: string;
  description: ReactNode;
  detail?: ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  confirmVariant?: 'accent' | 'danger';
  confirmIcon?: ReactNode;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const variantClasses = {
  accent: 'bg-void-accent text-white hover:bg-void-accent-hover',
  danger: 'bg-red-500/20 text-red-300 hover:bg-red-500/30',
};

export default function ConfirmDialog({
  title,
  description,
  detail,
  cancelLabel = 'Cancel',
  confirmLabel,
  confirmVariant = 'accent',
  confirmIcon,
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-[340] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-void-bg-hover bg-void-bg-sec shadow-2xl">
        <div className="border-b border-void-bg-hover px-5 py-4">
          <h3 className="text-base font-semibold text-void-text">{title}</h3>
          <div className="mt-1 text-sm text-void-text-muted">{description}</div>
          {detail ? (
            <div className="mt-2 text-xs text-void-text-muted">{detail}</div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-xl border border-void-bg-hover bg-void-bg-sec/70 px-4 py-2.5 text-sm font-medium text-void-text transition-colors hover:bg-void-bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${variantClasses[confirmVariant]}`}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : confirmIcon}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
