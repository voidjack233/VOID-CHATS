import { useMemo, useState } from 'react';
import {
  Download,
  File,
  FileArchive,
  FileAudio,
  FileText,
  FileVideo,
  Loader2,
} from 'lucide-react';
import type { Attachment } from '../../../Services/Chat/chatTypes';
import { resolveAttachmentObjectUrl } from '../../../Services/Crypto/attachmentEncryption';

interface AttachmentFileCardProps {
  attachment: Attachment;
  conversationId?: string | null;
  disabled?: boolean;
}

function formatAttachmentSize(size?: number): string {
  if (!Number.isFinite(size) || !size || size <= 0) {
    return 'File';
  }

  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function getAttachmentDisplayName(attachment: Attachment): string {
  if (attachment.name && attachment.name.trim().length > 0) {
    return attachment.name.trim();
  }

  try {
    const pathname = new URL(attachment.url).pathname;
    const lastSegment = pathname.split('/').pop();
    if (lastSegment) {
      return decodeURIComponent(lastSegment);
    }
  } catch {
    // ignore invalid URL parsing
  }

  return 'attachment';
}

function getAttachmentIcon(mime: string | undefined) {
  if (!mime) return File;
  if (mime.startsWith('audio/')) return FileAudio;
  if (mime.startsWith('video/')) return FileVideo;
  if (
    mime.includes('zip') ||
    mime.includes('tar') ||
    mime.includes('rar') ||
    mime.includes('7z') ||
    mime.includes('archive')
  ) {
    return FileArchive;
  }
  if (
    mime.includes('pdf') ||
    mime.includes('text') ||
    mime.includes('word') ||
    mime.includes('sheet') ||
    mime.includes('presentation') ||
    mime.includes('document')
  ) {
    return FileText;
  }
  return File;
}

export default function AttachmentFileCard({
  attachment,
  conversationId,
  disabled = false,
}: AttachmentFileCardProps) {
  const [downloading, setDownloading] = useState(false);
  const displayName = useMemo(() => getAttachmentDisplayName(attachment), [attachment]);
  const Icon = getAttachmentIcon(attachment.mime);

  const handleDownload = async () => {
    if (disabled || downloading) return;

    setDownloading(true);
    try {
      const url = await resolveAttachmentObjectUrl(attachment, { conversationId });
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = displayName;
      anchor.rel = 'noopener noreferrer';
      anchor.click();
    } catch (error) {
      console.error('Failed to open attachment file:', error);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => { void handleDownload(); }}
      disabled={disabled || downloading}
      className="flex w-full items-center gap-3 rounded-xl border border-void-bg-hover bg-void-bg-hover/75 px-3 py-3 text-left transition-colors hover:bg-void-bg-hover disabled:cursor-not-allowed disabled:opacity-60"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-void-bg-main/80">
        {downloading ? (
          <Loader2 className="h-5 w-5 animate-spin text-void-accent" />
        ) : (
          <Icon className="h-5 w-5 text-void-accent" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-void-text">
          {displayName}
        </div>
        <div className="truncate text-xs text-void-text-muted">
          {formatAttachmentSize(attachment.size)}
        </div>
      </div>

      <Download className="h-4 w-4 shrink-0 text-void-text-muted" />
    </button>
  );
}
