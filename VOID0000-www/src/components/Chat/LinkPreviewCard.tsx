import { ExternalLink, Link2, X } from 'lucide-react';
import type { LinkPreviewMetadata } from '../../Services/Chat/chatService';

interface LinkPreviewCardProps {
  preview: LinkPreviewMetadata;
  onOpenLink?: (url: string) => void;
  onRemove?: () => void;
  onMediaLoad?: () => void;
  loading?: boolean;
}

function getHostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

const LinkPreviewCard = ({
  preview,
  onOpenLink,
  onRemove,
  onMediaLoad,
  loading = false,
}: LinkPreviewCardProps) => {
  const hostname = getHostname(preview.url);
  const siteName = preview.site_name || hostname;

  const openPreview = () => {
    if (loading) return;
    if (onOpenLink) {
      onOpenLink(preview.url);
      return;
    }
    window.open(preview.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="group/linkpreview relative w-full max-w-[340px] overflow-hidden rounded-2xl border border-void-bg-hover bg-void-bg-main/90 shadow-sm">
      {onRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRemove();
          }}
          className="absolute right-2 top-2 z-10 rounded-full bg-black/55 p-1 text-white/80 transition-colors hover:bg-black/75 hover:text-white"
          aria-label="Remove link preview"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      <button
        type="button"
        onClick={openPreview}
        disabled={loading}
        className="block w-full text-left disabled:cursor-default"
      >
        {preview.image ? (
          <div className="h-36 w-full overflow-hidden bg-void-bg-hover">
            <img
              src={preview.image}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onLoad={onMediaLoad}
              className={`h-full w-full object-cover transition-transform duration-300 ${
                loading ? 'opacity-55 grayscale' : 'group-hover/linkpreview:scale-[1.02]'
              }`}
            />
          </div>
        ) : (
          <div className="flex h-16 items-center justify-center bg-void-bg-hover/55 text-void-text-muted">
            <Link2 className="h-6 w-6" />
          </div>
        )}

        <div className="space-y-1.5 p-3">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-void-text-muted">
            {preview.favicon ? (
              <img
                src={preview.favicon}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onLoad={onMediaLoad}
                className="h-3.5 w-3.5 rounded-sm"
              />
            ) : (
              <ExternalLink className="h-3.5 w-3.5" />
            )}
            <span className="truncate">{siteName}</span>
          </div>

          {preview.title ? (
            <div className="line-clamp-2 text-sm font-semibold leading-snug text-void-text">
              {preview.title}
            </div>
          ) : null}

          {preview.description ? (
            <div className="line-clamp-3 text-xs leading-relaxed text-void-text-muted">
              {preview.description}
            </div>
          ) : null}

          {loading ? (
            <div className="h-1.5 w-20 animate-pulse rounded-full bg-void-bg-hover" />
          ) : null}
        </div>
      </button>
    </div>
  );
};

export default LinkPreviewCard;
