import { createRequire } from 'module';
import valkey from '../valkey.js';

const require = createRequire(import.meta.url);
const config = require('../config.json');
const isCluster = config.cluster.enabled;

const PRESENCE_KEY_PREFIX = 'presence:';
const PRESENCE_COUNT_KEY_PREFIX = 'presence_count:';
const VALID_PRESENCE_STATUSES = new Set(['online', 'idle', 'offline']);

function presenceKey(userId) {
  return `${PRESENCE_KEY_PREFIX}${userId}`;
}

function presenceCountKey(userId) {
  return `${PRESENCE_COUNT_KEY_PREFIX}${userId}`;
}

function normalizePresence(rawPresence, activeCount = 0) {
  if (!rawPresence || typeof rawPresence !== 'object') {
    return {
      status: activeCount > 0 ? 'online' : 'offline',
      lastActive: null,
      activeCount,
    };
  }

  const status = activeCount === 0
    ? 'offline'
    : (rawPresence.status === 'idle' ? 'idle' : 'online');
  const lastActive = Number.isInteger(rawPresence.lastActive) ? rawPresence.lastActive : null;

  return { status, lastActive, activeCount };
}

function parseSharedActiveCount(rawPresence, rawCount) {
  const parsedCount = Number.parseInt(rawCount || '', 10);
  if (Number.isInteger(parsedCount) && parsedCount >= 0) {
    return parsedCount;
  }

  const snapshotCount = rawPresence?.activeCount;
  if (Number.isInteger(snapshotCount) && snapshotCount >= 0) {
    return snapshotCount;
  }

  return 0;
}

export function sendLiveEventToUser(userId, event, data) {
  if (!userId || !event) return;

  void (async () => {
    try {
      if (isCluster) {
        const { publishToGateway } = await import('../valkey-pubsub.js');
        publishToGateway(event, userId, data);
        return;
      }

      const { sendToUser } = await import('./index.js');
      sendToUser(userId, event, data);
    } catch (err) {
      console.error('Gateway user dispatch error:', err);
    }
  })();
}

export function broadcastLiveEventToFriends(userId, event, data) {
  if (!userId || !event) return;

  void (async () => {
    try {
      if (isCluster) {
        const { publishBroadcastToFriends } = await import('../valkey-pubsub.js');
        publishBroadcastToFriends(userId, event, data);
        return;
      }

      const { broadcastToFriends } = await import('./index.js');
      await broadcastToFriends(userId, event, data);
    } catch (err) {
      console.error('Gateway friend broadcast error:', err);
    }
  })();
}

export function invalidateLiveFriendCachePair(userId1, userId2) {
  if (!userId1 || !userId2) return;

  void (async () => {
    try {
      if (isCluster) {
        const { publishGatewayCommand } = await import('../valkey-pubsub.js');
        publishGatewayCommand('invalidateFriendCachePair', { userId1, userId2 });
        return;
      }

      const { invalidateFriendCachePair } = await import('./index.js');
      invalidateFriendCachePair(userId1, userId2);
    } catch (err) {
      console.error('Gateway friend cache invalidation error:', err);
    }
  })();
}

export async function getLiveUserPresence(userId) {
  if (!userId) {
    return { status: 'offline', lastActive: null, activeCount: 0 };
  }

  try {
    const pipeline = valkey.pipeline();
    pipeline.get(presenceKey(userId));
    pipeline.get(presenceCountKey(userId));
    const results = await pipeline.exec();
    const rawPresence = results?.[0]?.[1];
    const rawCount = results?.[1]?.[1];
    const parsedPresence = rawPresence ? JSON.parse(rawPresence) : null;
    const activeCount = parseSharedActiveCount(parsedPresence, rawCount);

    return normalizePresence(
      parsedPresence,
      activeCount
    );
  } catch (err) {
    console.error('Gateway presence lookup error:', err);
  }

  if (!isCluster) {
    const { getUserPresence } = await import('./index.js');
    const localPresence = getUserPresence(userId);
    const localActiveCount = localPresence?.status === 'offline' ? 0 : 1;
    return normalizePresence(localPresence, localActiveCount);
  }

  return { status: 'offline', lastActive: null, activeCount: 0 };
}
