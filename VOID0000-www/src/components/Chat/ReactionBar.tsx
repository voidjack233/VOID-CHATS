// src/components/Chat/ReactionBar.tsx
import { ReactionMap } from '../../Services/Chat/chatService';

interface ReactionBarProps {
  reactions: ReactionMap;
  currentUserId: string;
  onToggle: (emoji: string) => void;
  onAddReaction: (e: React.MouseEvent<HTMLButtonElement>) => void; // Updated to accept event
}

const ReactionBar = ({ reactions, currentUserId, onToggle, onAddReaction }: ReactionBarProps) => {
  const emojiEntries = Object.entries(reactions);

  if (emojiEntries.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1">
      {emojiEntries.map(([emoji, userIds]) => {
        const hasReacted = userIds.includes(currentUserId);
        return (
          <button
            key={emoji}
            onClick={() => onToggle(emoji)}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs transition-all border ${
              hasReacted
                ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300 hover:bg-indigo-500/30'
                : 'bg-gray-700/50 border-gray-600/50 text-gray-400 hover:bg-gray-700 hover:border-gray-500'
            }`}
            title={`${userIds.length} reaction${userIds.length > 1 ? 's' : ''}`}
          >
            <span className="text-sm leading-none">{emoji}</span>
            <span className="font-medium leading-none">{userIds.length}</span>
          </button>
        );
      })}

      <button
        onClick={(e) => onAddReaction(e)}
        className="inline-flex items-center justify-center w-6 h-6 rounded-md text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-700/50 border border-transparent hover:border-gray-600/50 transition-all"
        title="Add reaction"
      >
        +
      </button>
    </div>
  );
};

export default ReactionBar;