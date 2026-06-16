import { AlertCircle } from 'lucide-react';

interface MessageJumpNoticeProps {
  message: string | null;
}

export default function MessageJumpNotice({ message }: MessageJumpNoticeProps) {
  if (!message) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4">
      <div className="inline-flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-full border border-orange-400/25 bg-void-bg-main/95 px-3 py-1.5 text-xs font-medium text-orange-200 shadow-lg shadow-black/20 supports-[backdrop-filter]:backdrop-blur">
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-orange-300" />
        <span className="truncate">{message}</span>
      </div>
    </div>
  );
}
