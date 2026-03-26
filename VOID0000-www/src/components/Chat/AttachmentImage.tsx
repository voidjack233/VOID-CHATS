import { useEffect, useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import type { Attachment } from '../../Services/Chat/chatTypes';
import { isEncryptedAttachment, resolveAttachmentObjectUrl } from '../../Services/Crypto/attachmentEncryption';
import BlurImage from '../common/BlurImage';

interface AttachmentImageProps {
  attachment: Attachment;
  alt?: string;
  className?: string;
}

export default function AttachmentImage({
  attachment,
  alt = '',
  className = '',
}: AttachmentImageProps) {
  const [src, setSrc] = useState<string | null>(
    isEncryptedAttachment(attachment) ? null : attachment.url,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    if (!isEncryptedAttachment(attachment)) {
      setSrc(attachment.url);
      return () => {
        cancelled = true;
      };
    }

    setSrc(null);

    resolveAttachmentObjectUrl(attachment)
      .then((nextUrl) => {
        if (!cancelled) {
          setSrc(nextUrl);
        }
      })
      .catch((error) => {
        console.error('Failed to decrypt attachment image:', error);
        if (!cancelled) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    attachment.url,
    attachment.blurhash,
    attachment.encrypted,
    attachment.iv,
    attachment.key,
    attachment.mime,
  ]);

  if (src) {
    return (
      <BlurImage
        src={src}
        blurhash={attachment.blurhash}
        alt={alt}
        className={className}
      />
    );
  }

  return (
    <div className={`${className} flex items-center justify-center bg-void-bg-main/50`}>
      {failed ? (
        <ImageOff className="h-5 w-5 text-void-text-muted" />
      ) : (
        <Loader2 className="h-5 w-5 animate-spin text-void-text-muted" />
      )}
    </div>
  );
}
