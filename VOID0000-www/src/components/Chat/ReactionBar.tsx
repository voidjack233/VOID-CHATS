// src/components/Chat/ReactionBar.tsx
import type { ReactionMap } from '../../Services/hooks/Chats/useReactions';

interface ReactionBarProps {
  reactions: ReactionMap;
  currentUserId: string;
  onToggle: (emoji: string) => void;
  onAddReaction: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

const ReactionBar = ({ reactions, currentUserId, onToggle, onAddReaction }: ReactionBarProps) => {
  if (!reactions || typeof reactions !== 'object') return null;

  const emojiEntries = Object.entries(reactions);

  if (emojiEntries.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {emojiEntries.map(([emoji, reactionData]) => {
        let hasReacted = false;
        let count = 0;

        if (Array.isArray(reactionData)) {
          // Legacy format from IndexedDB cache
          hasReacted = reactionData.includes(currentUserId);
          count = reactionData.length;
        } else if (reactionData && typeof reactionData === 'object') {
          hasReacted = !!reactionData.me;
          count = reactionData.count || 0;
        }

        if (count === 0) return null;

        return (
          <button
            key={emoji}
            onClick={() => onToggle(emoji)}
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-all active:scale-95 ${
              hasReacted
                ? 'border-void-accent/45 bg-void-accent/18 text-void-text shadow-[0_0_0_1px_rgba(59,130,246,0.12)] hover:bg-void-accent/24'
                : 'border-void-border/65 bg-void-bg-main/85 text-void-text-muted hover:border-void-border hover:bg-void-bg-hover/90 hover:text-void-text'
            }`}
            title={`${count} reaction${count > 1 ? 's' : ''}`}
          >
            <span className="text-[1rem] leading-none sm:text-[1.05rem]">{emoji}</span>
            <span className="min-w-[0.8rem] text-[11px] font-semibold leading-none">{count}</span>
          </button>
        );
      })}

      <button
        onClick={(e) => onAddReaction(e)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-void-border/45 bg-void-bg-main/80 text-sm font-medium text-void-text-muted transition-all hover:border-void-border hover:bg-void-bg-hover/85 hover:text-void-text active:scale-95"
        title="Add reaction"
      >
        +
      </button>
    </div>
  );
};

export default ReactionBar;
