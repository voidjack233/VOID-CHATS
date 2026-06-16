import { memo } from 'react';
import UserAvatar from '../../common/UserAvatar';

export interface TypingParticipant {
  userId: string;
  displayName: string;
  username?: string | null;
  avatarUrl?: string | null;
}

const normalizeText = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
};

const TypingIndicator = memo(function TypingIndicator({
  typingParticipants,
}: {
  typingParticipants: TypingParticipant[];
}) {
  if (typingParticipants.length === 0) return null;

  const typingVisibleParticipants = typingParticipants.slice(0, 3);
  const typingOverflowCount = Math.max(0, typingParticipants.length - typingVisibleParticipants.length);
  const names = typingParticipants
    .map((participant) => normalizeText(participant.displayName) || normalizeText(participant.username) || 'Someone')
    .filter(Boolean) as string[];

  const typingText = (() => {
    if (names.length === 0) return '';
    if (names.length === 1) return `${names[0]} is typing...`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
    if (names.length === 3) return `${names[0]}, ${names[1]}, ${names[2]} are typing...`;
    return `${names[0]}, ${names[1]} and others are typing...`;
  })();

  if (!typingText) return null;

  return (
    <div className="px-2 pb-2 pt-1">
      <div className="flex max-w-full items-center gap-2">
        {typingOverflowCount > 0 && (
          <span className="rounded-full bg-void-bg-hover px-1.5 py-0.5 text-[10px] font-semibold text-void-text-muted">
            +{typingOverflowCount}
          </span>
        )}

        <div className="flex items-center pr-0.5">
          {typingVisibleParticipants.map((participant, index) => (
            <div
              key={participant.userId}
              className={`h-5 w-5 overflow-hidden rounded-full ring-2 ring-void-bg-main ${index === 0 ? '' : '-ml-1.5'}`}
            >
              <UserAvatar
                src={participant.avatarUrl}
                displayName={participant.displayName}
                username={participant.username}
                className="h-5 w-5 rounded-full"
                fallbackClassName="text-[9px]"
              />
            </div>
          ))}
        </div>

        <span className="max-w-full truncate rounded-2xl bg-void-bg-hover px-3 py-1.5 text-xs text-void-text-muted">
          {typingText}
        </span>
      </div>
    </div>
  );
});

export default TypingIndicator;
