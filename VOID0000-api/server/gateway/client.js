import valkey from '../valkey.js';

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
      const { publishToGateway } = await import('../valkey-pubsub.js');
      publishToGateway(event, userId, data);
    } catch (err) {
      console.error('Gateway user dispatch error:', err);
    }
  })();
}

export function broadcastLiveEventToFriends(userId, event, data) {
  if (!userId || !event) return;

  void (async () => {
    try {
      // Resolve friend IDs in Node so Phoenix receives explicit per-user events
      // and never needs to touch Postgres itself.
      const { publishToGateway } = await import('../valkey-pubsub.js');
      const { pool } = await import('../db.js');

      const result = await pool.query(
        `SELECT CASE WHEN requester_id = $1 THEN addressee_id
                     ELSE requester_id
                END AS friend_id
         FROM friendships
         WHERE (requester_id = $1 OR addressee_id = $1)
           AND status = 'accepted'`,
        [userId]
      );

      for (const row of result.rows) {
        publishToGateway(event, row.friend_id, data);
      }
    } catch (err) {
      console.error('Gateway friend broadcast error:', err);
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

  return { status: 'offline', lastActive: null, activeCount: 0 };
}
