interface ConversationWindowSnapshot {
  loadedCount: number;
  hasOlder: boolean;
  topVisibleMessageId?: string;
}

const conversationWindowCache = new Map<string, ConversationWindowSnapshot>();

export const getConversationWindowSnapshot = (conversationId: string) =>
  conversationWindowCache.get(conversationId);

export const setConversationWindowSnapshot = (
  conversationId: string,
  snapshot: ConversationWindowSnapshot,
) => {
  conversationWindowCache.set(conversationId, snapshot);
};

export const saveConversationScrollPosition = (conversationId: string, messageId: string) => {
  const existing = getConversationWindowSnapshot(conversationId);
  setConversationWindowSnapshot(conversationId, {
    loadedCount: existing?.loadedCount ?? 0,
    hasOlder: existing?.hasOlder ?? false,
    topVisibleMessageId: messageId,
  });
};

export const resolveInitialHasOlder = ({
  localHasMore,
  sessionSnapshot,
  syncHasMore = false,
}: {
  localHasMore: boolean;
  localCount: number;
  requestedLimit: number;
  sessionSnapshot?: ConversationWindowSnapshot;
  syncHasMore?: boolean;
}) => {
  return (
    localHasMore ||
    syncHasMore ||
    sessionSnapshot?.hasOlder === true
  );
};

export type { ConversationWindowSnapshot };
