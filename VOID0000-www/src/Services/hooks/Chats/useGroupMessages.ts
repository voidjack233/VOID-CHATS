import { useMemo } from 'react';
import { Message } from '../../Chat/chatService';

const GROUP_TIME_WINDOW_MS = 5 * 60 * 1000;

export interface MessageGroupData {
  id: string;
  sender_id: string;
  created_at: string;
  message_type: string;
  messages: Message[];
  showDateSeparator: boolean;
}

const isSameDay = (a: string, b: string) => {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
};

export const useGroupMessages = (messages: Message[], breakBeforeIds?: ReadonlySet<string>) => {
  return useMemo(() => {
    const oldestFirst = [...messages].reverse();
    const groups: MessageGroupData[] = [];
    let currentGroup: MessageGroupData | null = null;

    oldestFirst.forEach((msg, index) => {
      const prev = index > 0 ? oldestFirst[index - 1] : null;
      const showDateSeparator = !prev || !isSameDay(msg.created_at, prev.created_at);
      const timeDiff = prev ? new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() : 0;
      const hasPaginationBreak = breakBeforeIds?.has(msg.message_id) ?? false;

      const isConsecutive =
        !!prev &&
        !hasPaginationBreak &&
        !msg.reply_to &&
        prev.sender_id === msg.sender_id &&
        prev.message_type === msg.message_type &&
        !showDateSeparator &&
        timeDiff < GROUP_TIME_WINDOW_MS;

      if (isConsecutive && currentGroup) {
        currentGroup.messages.push(msg);
      } else {
        currentGroup = {
          id: msg.message_id,
          sender_id: msg.sender_id,
          created_at: msg.created_at,
          message_type: msg.message_type,
          messages: [msg],
          showDateSeparator,
        };
        groups.push(currentGroup);
      }
    });

    return groups;
  }, [messages, breakBeforeIds]);
};
