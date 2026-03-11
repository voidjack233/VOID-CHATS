import { createRequire } from 'module';
import valkey from '../valkey.js';

const require = createRequire(import.meta.url);
const config = require('../config.json');
const isCluster = config.cluster.enabled;

const PRESENCE_KEY_PREFIX = 'presence:';
const VALID_PRESENCE_STATUSES = new Set(['online', 'idle', 'offline']);

function presenceKey(userId) {
  return `${PRESENCE_KEY_PREFIX}${userId}`;
}

function normalizePresence(rawPresence) {
  if (!rawPresence || typeof rawPresence !== 'object') {
    return { status: 'offline', lastActive: null };
  }

  const status = VALID_PRESENCE_STATUSES.has(rawPresence.status) ? rawPresence.status : 'offline';
  const lastActive = Number.isInteger(rawPresence.lastActive) ? rawPresence.lastActive : null;

  return { status, lastActive };
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
    return { status: 'offline', lastActive: null };
  }

  if (isCluster) {
    try {
      const raw = await valkey.get(presenceKey(userId));
      return normalizePresence(raw ? JSON.parse(raw) : null);
    } catch (err) {
      console.error('Gateway presence lookup error:', err);
      return { status: 'offline', lastActive: null };
    }
  }

  const { getUserPresence } = await import('./index.js');
  return normalizePresence(getUserPresence(userId));
}
