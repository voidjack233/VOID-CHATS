import type { Conversation, ConversationMember } from '../../../Chat/chatService';

interface HistoryAccessFence {
  joinedAtMs: number | null;
  keyVersionFloor: number | null;
}

const normalizeHistoryVersion = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
};

const createHistoryAccessFence = (
  conversation: Conversation,
  currentMember?: ConversationMember | null,
): HistoryAccessFence | null => {
  if (conversation.type === 'dm' || !currentMember) {
    return null;
  }

  const joinedAtMs = currentMember.joined_at
    ? new Date(currentMember.joined_at).getTime()
    : Number.NaN;
  const safeJoinedAtMs = Number.isFinite(joinedAtMs) ? joinedAtMs : null;
  const joinedKeyVersion = normalizeHistoryVersion(currentMember.joined_key_version);
  const historyStartVersion = normalizeHistoryVersion(currentMember.history_start_version);
  const keyVersionFloor = Math.max(joinedKeyVersion || 0, historyStartVersion || 0) || null;

  if (safeJoinedAtMs === null && keyVersionFloor === null) {
    return null;
  }

  return {
    joinedAtMs: safeJoinedAtMs,
    keyVersionFloor,
  };
};

const isMessageVisibleForHistoryFence = (
  message: { created_at: string; key_version?: number | null },
  historyAccessFence: HistoryAccessFence | null,
): boolean => {
  if (!historyAccessFence) {
    return true;
  }

  if (
    historyAccessFence.keyVersionFloor !== null &&
    typeof message.key_version === 'number' &&
    message.key_version > 0 &&
    message.key_version < historyAccessFence.keyVersionFloor
  ) {
    return false;
  }

  if (historyAccessFence.joinedAtMs !== null) {
    const createdAtMs = new Date(message.created_at).getTime();
    if (Number.isFinite(createdAtMs) && createdAtMs < historyAccessFence.joinedAtMs) {
      return false;
    }
  }

  return true;
};

const filterMessagesByHistoryFence = <T extends { created_at: string; key_version?: number | null }>(
  messages: T[],
  historyAccessFence: HistoryAccessFence | null,
): T[] => {
  if (!historyAccessFence || messages.length === 0) {
    return messages;
  }

  const filtered = messages.filter((message) =>
    isMessageVisibleForHistoryFence(message, historyAccessFence)
  );

  return filtered.length === messages.length ? messages : filtered;
};

export {
  createHistoryAccessFence,
  filterMessagesByHistoryFence,
  isMessageVisibleForHistoryFence,
  normalizeHistoryVersion,
};
export type { HistoryAccessFence };
