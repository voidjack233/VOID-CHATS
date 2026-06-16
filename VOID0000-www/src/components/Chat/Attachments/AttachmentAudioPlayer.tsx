import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Download, FileAudio, Loader2 } from 'lucide-react';
import type { Attachment } from '../../../Services/Chat/chatTypes';
import { resolveAttachmentBlob } from '../../../Services/Crypto/attachmentEncryption';

interface AttachmentAudioPlayerProps {
  attachment: Attachment;
  conversationId?: string | null;
  disabled?: boolean;
  canLoad?: boolean;
  onLoad?: () => void;
}

const AUDIO_EXTENSION_MIME: Record<string, string> = {
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  weba: 'audio/webm',
  webm: 'audio/webm',
};

function formatAttachmentSize(size?: number): string {
  if (!Number.isFinite(size) || !size || size <= 0) {
    return 'Audio';
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
    const pathname = new URL(attachment.url, window.location.origin).pathname;
    const lastSegment = pathname.split('/').pop();
    if (lastSegment) {
      return decodeURIComponent(lastSegment);
    }
  } catch {
    // Keep the fallback below for malformed or relative URLs.
  }

  return 'audio attachment';
}

function getExtensionFromName(value?: string | null): string | null {
  if (!value) return null;
  const cleanValue = value.split('?')[0]?.split('#')[0] || value;
  const extension = cleanValue.split('.').pop()?.toLowerCase();
  return extension && extension !== cleanValue.toLowerCase() ? extension : null;
}

function getAudioMime(attachment: Attachment): string | null {
  if (attachment.mime?.startsWith('audio/')) {
    return attachment.mime;
  }

  const nameExtension = getExtensionFromName(attachment.name);
  if (nameExtension && AUDIO_EXTENSION_MIME[nameExtension]) {
    return AUDIO_EXTENSION_MIME[nameExtension];
  }

  try {
    const pathname = new URL(attachment.url, window.location.origin).pathname;
    const urlExtension = getExtensionFromName(pathname);
    return urlExtension ? AUDIO_EXTENSION_MIME[urlExtension] || null : null;
  } catch {
    return null;
  }
}

export function isAudioAttachment(attachment: Attachment): boolean {
  return Boolean(getAudioMime(attachment));
}

export default function AttachmentAudioPlayer({
  attachment,
  conversationId,
  disabled = false,
  canLoad = true,
  onLoad,
}: AttachmentAudioPlayerProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const displayName = useMemo(() => getAttachmentDisplayName(attachment), [attachment]);
  const playableMime = useMemo(() => getAudioMime(attachment), [attachment]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setFailed(false);

    if (disabled || !canLoad) {
      setSrc(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setSrc(null);

    resolveAttachmentBlob(attachment, { conversationId })
      .then((blob) => {
        if (cancelled) return;

        const playableBlob = playableMime && !blob.type.startsWith('audio/')
          ? new Blob([blob], { type: playableMime })
          : blob;

        objectUrl = URL.createObjectURL(playableBlob);
        setSrc(objectUrl);
      })
      .catch((error) => {
        console.error('Failed to load audio attachment:', error);
        if (!cancelled) {
          setFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [
    attachment.encrypted,
    attachment.iv,
    attachment.key,
    attachment.mime,
    attachment.name,
    attachment.url,
    canLoad,
    conversationId,
    disabled,
    playableMime,
  ]);

  const handleDownload = () => {
    if (!src || disabled || loading) return;

    const anchor = document.createElement('a');
    anchor.href = src;
    anchor.download = displayName;
    anchor.rel = 'noopener noreferrer';
    anchor.click();
  };

  return (
    <div
      className="w-72 max-w-full rounded-xl border border-void-bg-hover bg-void-bg-hover/75 px-3 py-3"
    >
      <div className="mb-2 flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-void-bg-main/80">
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin text-void-accent" />
          ) : failed ? (
            <AlertCircle className="h-5 w-5 text-orange-300" />
          ) : (
            <FileAudio className="h-5 w-5 text-void-accent" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-void-text">
            {displayName}
          </div>
          <div className="truncate text-xs text-void-text-muted">
            {failed ? 'Could not load audio' : formatAttachmentSize(attachment.size)}
          </div>
        </div>

        <button
          type="button"
          onClick={handleDownload}
          disabled={!src || disabled || loading}
          className="rounded-lg p-2 text-void-text-muted transition-colors hover:bg-void-bg-main/60 hover:text-void-text disabled:cursor-not-allowed disabled:opacity-40"
          title="Download audio"
          aria-label="Download audio"
        >
          <Download className="h-4 w-4" />
        </button>
      </div>

      {src ? (
        <audio
          controls
          preload="metadata"
          src={src}
          onLoadedMetadata={onLoad}
          className="block h-9 w-full min-w-0"
        />
      ) : (
        <div className="flex h-9 items-center rounded-lg bg-void-bg-main/50 px-3 text-xs text-void-text-muted">
          {failed
            ? 'Audio preview unavailable'
            : canLoad
              ? 'Loading audio...'
              : 'Audio loads when nearby'}
        </div>
      )}
    </div>
  );
}
