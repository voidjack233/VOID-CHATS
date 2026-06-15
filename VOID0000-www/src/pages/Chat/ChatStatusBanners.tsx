import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface ServiceIssue {
  service: string;
  status?: number;
  message: string;
}

interface ChatStatusBannersProps {
  serviceIssue: ServiceIssue | null;
  serviceIssueCount: number;
  notice?: string | null;
  onDismissNotice?: () => void;
}

let alertsDismissedForPage = false;

export default function ChatStatusBanners({
  serviceIssue,
  serviceIssueCount,
  notice,
  onDismissNotice,
}: ChatStatusBannersProps) {
  const [, setDismissRevision] = useState(0);
  const alert = notice
    ? {
        message: notice,
        additionalCount: 0,
        isNotice: true,
      }
    : serviceIssue
      ? {
          message: serviceIssue.message,
          additionalCount: Math.max(0, serviceIssueCount - 1),
          isNotice: false,
        }
      : null;

  if (!alert || alertsDismissedForPage) {
    return null;
  }

  const dismiss = () => {
    alertsDismissedForPage = true;
    if (alert.isNotice) {
      onDismissNotice?.();
    }
    setDismissRevision((revision) => revision + 1);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-[100] flex justify-center px-4">
      <div
        role="alert"
        className="pointer-events-auto flex w-full max-w-xl items-start gap-3 rounded-xl border border-amber-300/20 bg-neutral-950/95 px-4 py-3 text-sm text-amber-50 shadow-2xl shadow-black/40 supports-[backdrop-filter]:backdrop-blur-xl"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <span className="min-w-0 flex-1">
          {alert.message}
          {alert.additionalCount > 0 ? ` +${alert.additionalCount} more` : ''}
        </span>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss error"
          className="-mr-1 -mt-1 rounded-md p-1 text-amber-100/60 transition-colors hover:bg-white/10 hover:text-amber-50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
