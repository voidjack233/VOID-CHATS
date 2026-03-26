import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef } from 'react';
import EmojiPickerReact, {
  EmojiStyle,
  Theme,
  type EmojiClickData,
} from 'emoji-picker-react';

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  position?: { x: number; y: number };
}

const PICKER_WIDTH = 352;
const PICKER_HEIGHT = 436;
const VIEWPORT_MARGIN = 16;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const getPickerPosition = (position?: { x: number; y: number }): React.CSSProperties => {
  if (typeof window === 'undefined') {
    return { position: 'fixed', top: VIEWPORT_MARGIN, left: VIEWPORT_MARGIN };
  }

  if (!position) {
    return {
      position: 'fixed',
      top: Math.max(VIEWPORT_MARGIN, (window.innerHeight - PICKER_HEIGHT) / 2),
      left: Math.max(VIEWPORT_MARGIN, (window.innerWidth - PICKER_WIDTH) / 2),
      zIndex: 1000,
    };
  }

  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - PICKER_WIDTH - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - PICKER_HEIGHT - VIEWPORT_MARGIN);
  const topCandidate =
    position.y > window.innerHeight / 2
      ? position.y - PICKER_HEIGHT
      : position.y + 12;

  return {
    position: 'fixed',
    left: clamp(position.x - PICKER_WIDTH / 2, VIEWPORT_MARGIN, maxLeft),
    top: clamp(topCandidate, VIEWPORT_MARGIN, maxTop),
    zIndex: 1000,
  };
};

export default function EmojiPicker({ onSelect, onClose, position }: EmojiPickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', handlePointerDown);
      document.addEventListener('keydown', handleKeyDown);
    }, 50);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const pickerStyle = useMemo(() => ({
    ...getPickerPosition(position),
    boxShadow: '0 24px 48px -12px rgba(0,0,0,0.5)',
    borderRadius: '16px',
    overflow: 'hidden',
    '--epr-bg-color': 'var(--bg-main)',
    '--epr-text-color': 'var(--text-main)',
    '--epr-highlight-color': 'var(--accent)',
    '--epr-hover-bg-color': 'color-mix(in srgb, var(--accent) 18%, transparent)',
    '--epr-hover-bg-color-reduced-opacity': 'color-mix(in srgb, var(--accent) 12%, transparent)',
    '--epr-focus-bg-color': 'color-mix(in srgb, var(--accent) 22%, transparent)',
    '--epr-search-input-bg-color': 'var(--bg-sec)',
    '--epr-search-input-bg-color-active': 'var(--bg-sec)',
    '--epr-search-input-text-color': 'var(--text-main)',
    '--epr-search-input-placeholder-color': 'color-mix(in srgb, var(--text-main) 60%, transparent)',
    '--epr-picker-border-color': 'color-mix(in srgb, var(--text-main) 12%, var(--bg-main))',
    '--epr-category-label-bg-color': 'color-mix(in srgb, var(--bg-sec) 92%, transparent)',
    '--epr-category-label-text-color': 'color-mix(in srgb, var(--text-main) 72%, transparent)',
    '--epr-category-icon-active-color': 'var(--accent)',
    '--epr-reactions-bg-color': 'color-mix(in srgb, var(--bg-main) 92%, transparent)',
    '--epr-emoji-variation-picker-bg-color': 'var(--bg-main)',
    '--epr-preview-border-color': 'color-mix(in srgb, var(--text-main) 12%, var(--bg-main))',
  }) as React.CSSProperties, [position]);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div ref={pickerRef}>
      <EmojiPickerReact
        onEmojiClick={(emojiData: EmojiClickData) => {
          onSelect(emojiData.emoji);
          onClose();
        }}
        theme={Theme.DARK}
        emojiStyle={EmojiStyle.NATIVE}
        width={PICKER_WIDTH}
        height={PICKER_HEIGHT}
        lazyLoadEmojis
        autoFocusSearch
        searchPlaceholder="Search emoji..."
        previewConfig={{ showPreview: false }}
        style={pickerStyle}
      />
    </div>,
    document.body,
  );
}
