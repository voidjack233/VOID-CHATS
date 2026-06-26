import { useMemo } from 'react';
import type { Message } from '../../../Services/Chat/chatService';

export const GROUP_TIME_WINDOW_MS = 5 * 60 * 1000;

export interface MessageLayoutTraits {
  startsGroup: boolean;
  showDateSeparator: boolean;
}

export function isSameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function getMessageDateLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const isSameDayDate = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (isSameDayDate(date, today)) return 'Today';
  if (isSameDayDate(date, yesterday)) return 'Yesterday';

  return date.toLocaleDateString([], {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function useMessageLayout(
  visualMessages: Message[],
  groupBreakBeforeIds: Set<string>,
  hasOlder: boolean,
): Record<string, MessageLayoutTraits> {
  return useMemo(() => {
    const next: Record<string, MessageLayoutTraits> = {};

    for (let i = 0; i < visualMessages.length; i += 1) {
      const msg = visualMessages[i];
      if (!msg) continue;

      const prev = i > 0 ? visualMessages[i - 1] : null;
      const hasPaginationBreak = groupBreakBeforeIds.has(msg.message_id);
      const isWindowStartWithUnknownHistory = !prev && hasOlder;
      const showDateSeparator =
        (!prev && !isWindowStartWithUnknownHistory) ||
        (!!prev && !isSameDay(msg.created_at, prev.created_at));
      const timeDiff = prev
        ? new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime()
        : 0;
      const startsGroup =
        hasPaginationBreak ||
        !!msg.reply_to ||
        !prev ||
        (!!prev && (
          prev.sender_id !== msg.sender_id ||
          prev.message_type !== msg.message_type ||
          showDateSeparator ||
          timeDiff >= GROUP_TIME_WINDOW_MS
        ));

      next[msg.message_id] = { startsGroup, showDateSeparator };
    }

    return next;
  }, [groupBreakBeforeIds, hasOlder, visualMessages]);
}
