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
    <div className="flex flex-wrap items-center gap-1 mt-1">
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
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs transition-all border ${
              hasReacted
                ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300 hover:bg-indigo-500/30'
                : 'bg-void-bg-hover/50 border-void-border/50 text-void-text-muted hover:bg-void-bg-hover hover:border-void-border'
            }`}
            title={`${count} reaction${count > 1 ? 's' : ''}`}
          >
            <span className="text-sm leading-none">{emoji}</span>
            <span className="font-medium leading-none">{count}</span>
          </button>
        );
      })}

      <button
        onClick={(e) => onAddReaction(e)}
        className="inline-flex items-center justify-center w-6 h-6 rounded-md text-xs text-void-text-muted hover:text-void-text hover:bg-void-bg-hover/50 border border-transparent hover:border-void-border/50 transition-all"
        title="Add reaction"
      >
        +
      </button>
    </div>
  );
};

export default ReactionBar;
