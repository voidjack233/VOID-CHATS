import { getAvatarInitial, isGeneratedFallbackAvatarUrl } from '../../Services/Chat/avatarFallback';

interface UserAvatarProps {
  src?: string | null;
  displayName?: string | null;
  username?: string | null;
  alt?: string;
  className?: string;
  fallbackClassName?: string;
  imgClassName?: string;
  fallbackTone?: 'badge' | 'plain';
}

export default function UserAvatar({
  src,
  displayName,
  username,
  alt = '',
  className = '',
  fallbackClassName = '',
  imgClassName = '',
  fallbackTone = 'badge',
}: UserAvatarProps) {
  const normalizedSrc = isGeneratedFallbackAvatarUrl(src) ? null : src;

  if (normalizedSrc) {
    return (
      <img
        src={normalizedSrc}
        alt={alt}
        className={`${className} object-cover ${imgClassName}`.trim()}
      />
    );
  }

  const fallbackToneClass = fallbackTone === 'plain'
    ? 'bg-transparent text-void-text'
    : 'bg-void-accent/15 text-void-accent';

  return (
    <div
      aria-hidden="true"
      className={`${className} flex items-center justify-center ${fallbackToneClass} font-semibold select-none ${fallbackClassName}`.trim()}
    >
      {getAvatarInitial(displayName, username)}
    </div>
  );
}
