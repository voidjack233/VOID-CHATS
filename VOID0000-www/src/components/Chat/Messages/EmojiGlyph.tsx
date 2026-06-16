import { memo } from 'react';
import type { CSSProperties } from 'react';

interface EmojiGlyphProps {
  emoji: string;
  className?: string;
  fallbackClassName?: string;
}

const EMOJI_STYLE: CSSProperties = {
  fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
  lineHeight: 1,
  verticalAlign: '-0.08em',
};

const EmojiGlyph = memo(function EmojiGlyph({
  emoji,
  className,
  fallbackClassName = 'text-base',
}: EmojiGlyphProps) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block select-none ${className || fallbackClassName}`}
      style={EMOJI_STYLE}
    >
      {emoji}
    </span>
  );
});

export default EmojiGlyph;
