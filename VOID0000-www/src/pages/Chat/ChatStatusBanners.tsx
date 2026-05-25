import { ShieldAlert } from 'lucide-react';

interface ServiceIssue {
  message: string;
}

interface ChatStatusBannersProps {
  isOnline: boolean;
  showReconnectBanner: boolean;
  serviceIssue: ServiceIssue | null;
  serviceIssueCount: number;
}

export default function ChatStatusBanners({
  isOnline,
  showReconnectBanner,
  serviceIssue,
  serviceIssueCount,
}: ChatStatusBannersProps) {
  return (
    <>
      {showReconnectBanner && (
        <div className="flex shrink-0 items-center gap-2 border-b border-white/8 bg-neutral-900/95 px-4 py-2 text-xs text-white/65">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/25 border-t-white/60" />
          {isOnline
            ? 'Reconnecting\u2026'
            : 'You\u2019re offline \u2014 reconnecting when network returns'}
        </div>
      )}
      {isOnline && serviceIssue && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-400/15 bg-amber-500/10 px-4 py-2 text-xs text-amber-100/85">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-200/90" />
          <span className="min-w-0 truncate">
            {serviceIssue.message}
            {serviceIssueCount > 1 ? ` +${serviceIssueCount - 1} more` : ''}
          </span>
        </div>
      )}
    </>
  );
}
