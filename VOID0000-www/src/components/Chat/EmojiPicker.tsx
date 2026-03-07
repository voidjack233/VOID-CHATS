// src/components/Chat/EmojiPicker.tsx
import { useState, useRef, useEffect } from 'react';

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  position?: { x: number; y: number };
}

type CategoryKey = 'frequent' | 'smileys' | 'gestures' | 'hearts' | 'objects' | 'symbols';

const EMOJI_CATEGORIES: Record<CategoryKey, { label: string; emojis: string[] }> = {
  frequent: {
    label: '⏱ Frequently Used',
    emojis: ['👍', '❤️', '😂', '🔥', '👀', '🎉', '💯', '😊', '🙏', '✅', '👎', '😢'],
  },
  smileys: {
    label: '😀 Smileys',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😊',
      '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋',
      '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🫢', '🤫', '🤔',
      '🫡', '🤐', '🤨', '😐', '😑', '😶', '🫥', '😏', '😒', '🙄',
      '😬', '😮‍💨', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒',
      '🤕', '🤢', '🤮', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳',
      '🥸', '😎', '🤓', '🧐', '😕', '🫤', '😟', '🙁', '☹️', '😮',
      '😯', '😲', '😳', '🥺', '🥹', '😦', '😧', '😨', '😰', '😥',
      '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱',
      '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡',
      '👹', '👺', '👻', '👽', '👾', '🤖',
    ],
  },
  gestures: {
    label: '👋 Gestures',
    emojis: [
      '👋', '🤚', '🖐️', '✋', '🖖', '🫱', '🫲', '🫳', '🫴', '👌',
      '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉',
      '👆', '🖕', '👇', '☝️', '🫵', '👍', '👎', '✊', '👊', '🤛',
      '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '💪', '🦾',
    ],
  },
  hearts: {
    label: '❤️ Hearts',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❤️‍🔥', '❤️‍🩹', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝',
      '💟', '♥️', '🫀',
    ],
  },
  objects: {
    label: '🎉 Objects',
    emojis: [
      '🎉', '🎊', '🎈', '🎁', '🏆', '🥇', '🥈', '🥉', '⭐', '🌟',
      '💫', '✨', '🔥', '💯', '💢', '💥', '💣', '💤', '💨', '🕳️',
      '💬', '👁️‍🗨️', '🗯️', '💭', '🔔', '🎵', '🎶', '🚀', '💎', '🪙',
      '💰', '📌', '📎', '🔑', '🔒', '🔓', '🛠️', '⚙️', '🧪', '🧬',
    ],
  },
  symbols: {
    label: '✅ Symbols',
    emojis: [
      '✅', '❌', '❓', '❗', '‼️', '⁉️', '⚠️', '🚫', '♻️', '✔️',
      '☑️', '➕', '➖', '➗', '✖️', '💲', '💱', '©️', '®️', '™️',
      '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟤', '🔶',
      '🔷', '🔸', '🔹', '🔺', '🔻', '🏳️', '🏴', '🏁', '🚩', '🏳️‍🌈',
    ],
  },
};

const EmojiPicker = ({ onSelect, onClose, position }: EmojiPickerProps) => {
  const [activeCategory, setActiveCategory] = useState<CategoryKey>('frequent');
  const [search, setSearch] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClick), 50);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handleClick); };
  }, [onClose]);

  const getVisibleEmojis = () => {
    if (!search.trim()) return EMOJI_CATEGORIES[activeCategory].emojis;
    const all = Object.values(EMOJI_CATEGORIES).flatMap((cat) => cat.emojis);
    return [...new Set(all)];
  };

  const categoryKeys = Object.keys(EMOJI_CATEGORIES) as CategoryKey[];

  // UX IMPROVEMENTS: Wider width (350px) and centered positioning
  const posStyle: React.CSSProperties = position
    ? {
        position: 'fixed',
        left: Math.max(16, Math.min(position.x - 175, window.innerWidth - 366)),
        top: position.y > window.innerHeight / 2 ? position.y - 420 : position.y + 40,
        zIndex: 1000,
      }
    : { position: 'absolute', bottom: '100%', right: 0, zIndex: 1000 };

  return (
    <div 
      ref={pickerRef} 
      style={posStyle} 
      className="w-[350px] bg-void-bg-main border border-void-border/60 rounded-xl shadow-[0_24px_48px_-12px_rgba(0,0,0,0.5)] overflow-hidden flex flex-col transition-all duration-200 animate-in fade-in zoom-in-95"
    >
      {/* Search Header */}
      <div className="p-4 border-b border-void-border/50">
        <input
          autoFocus
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search emoji..."
          className="w-full px-4 py-2 bg-void-bg-sec/80 border border-transparent rounded-full text-sm text-void-text placeholder-void-text-muted focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all"
        />
      </div>

      {/* Categories Bar */}
      {!search && (
        <div className="flex gap-1 px-3 py-2 bg-void-bg-sec/30 border-b border-void-border/50 overflow-x-auto scrollbar-hide">
          {categoryKeys.map((key) => (
            <button 
              key={key} 
              onClick={() => setActiveCategory(key)} 
              className={`p-2 rounded-lg text-lg transition-all ${activeCategory === key ? 'bg-indigo-500/20 ring-1 ring-indigo-500/50' : 'hover:bg-void-bg-hover/50 grayscale hover:grayscale-0'}`}
              title={EMOJI_CATEGORIES[key].label}
            >
              {EMOJI_CATEGORIES[key].emojis[0]}
            </button>
          ))}
        </div>
      )}

      {/* Category Label */}
      {!search && (
        <div className="px-4 pt-3 pb-1">
          <span className="text-[11px] font-bold text-void-text-muted uppercase tracking-widest">
            {EMOJI_CATEGORIES[activeCategory].label}
          </span>
        </div>
      )}

      {/* Emoji Grid: Increased size for better UX */}
      <div className="p-3 overflow-y-auto max-h-[300px] min-h-[200px] custom-scrollbar">
        <div className="grid grid-cols-8 gap-1">
          {getVisibleEmojis().map((emoji, i) => (
            <button 
              key={`${emoji}-${i}`} 
              onClick={() => { onSelect(emoji); onClose(); }} 
              className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-indigo-500/20 hover:scale-125 transition-all text-xl duration-150"
              title={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default EmojiPicker;