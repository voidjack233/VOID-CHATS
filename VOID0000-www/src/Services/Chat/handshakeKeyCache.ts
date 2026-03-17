// src/Services/Chat/handshakeKeyCache.ts
//
// Module-level cache for per-conversation crypto handshake results.
//
// Previously this was a useRef<Record<string, HandshakeCacheEntry>> inside
// useChatManager. Moving it here means the cache survives component remounts,
// avoiding repeat handshakes on navigation back to a conversation already opened
// in the same session.
//
// Entries are keyed by the conversation's key-scope ID (the group/DM root id).
// resolveMessageKey in useChatManager mutates entries in-place via the object
// reference returned by getHandshakeEntry — this is safe because Map stores
// references, not copies.

import { HandshakeCacheEntry } from './chatTypes';

const cache = new Map<string, HandshakeCacheEntry>();

export const getHandshakeEntry = (id: string): HandshakeCacheEntry | undefined =>
  cache.get(id);

export const setHandshakeEntry = (id: string, entry: HandshakeCacheEntry): void => {
  cache.set(id, entry);
};

export const deleteHandshakeEntry = (id: string): void => {
  cache.delete(id);
};
