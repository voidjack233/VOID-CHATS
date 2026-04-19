export const MAX_UNIQUE_REACTIONS_PER_MESSAGE = 10;

export function getUniqueReactionCount(
  reactions: Record<string, unknown> | null | undefined,
): number {
  if (!reactions || typeof reactions !== 'object') {
    return 0;
  }

  return Object.entries(reactions).reduce((count, [, value]) => {
    if (Array.isArray(value)) {
      return value.length > 0 ? count + 1 : count;
    }

    if (value && typeof value === 'object') {
      const reactionData = value as { count?: unknown; me?: unknown };
      const numericCount = Number(reactionData.count ?? 0);
      return numericCount > 0 || Boolean(reactionData.me) ? count + 1 : count;
    }

    return count;
  }, 0);
}

export function hasActiveReactionEntry(
  reactions: Record<string, unknown> | null | undefined,
  emoji: string,
): boolean {
  if (!reactions || typeof reactions !== 'object') {
    return false;
  }

  const value = reactions[emoji];
  if (!value) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === 'object') {
    const reactionData = value as { count?: unknown; me?: unknown };
    return Number(reactionData.count ?? 0) > 0 || Boolean(reactionData.me);
  }

  return false;
}
