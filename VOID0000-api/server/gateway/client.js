import valkey from '../valkey.js';

const PRESENCE_KEY_PREFIX = 'presence:';
const PRESENCE_COUNT_KEY_PREFIX = 'presence_count:';
const VALID_PRESENCE_STATUSES = new Set(['online', 'idle', 'offline']);
const REACTION_BATCH_WINDOW_MS = 150;
const reactionFanoutBuffer = new Map();

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

function reactionBatchKey(userId, payload) {
  return [
    userId,
    payload?.conversation_id || '',
    payload?.message_id || '',
  ].join(':');
}

export function queueReactionEventToUser(userId, payload) {
  if (!userId || !payload?.conversation_id || !payload?.message_id) return;

  const key = reactionBatchKey(userId, payload);
  const existing = reactionFanoutBuffer.get(key);

  if (existing) {
    existing.events.push({
      event_id: payload.event_id,
      emoji: payload.emoji,
      user_id: payload.user_id,
      action: payload.action,
    });
    return;
  }

  const entry = {
    userId,
    conversation_id: payload.conversation_id,
    conversation_public_id: payload.conversation_public_id || null,
    message_id: payload.message_id,
    events: [{
      event_id: payload.event_id,
      emoji: payload.emoji,
      user_id: payload.user_id,
      action: payload.action,
    }],
    timer: null,
  };

  entry.timer = setTimeout(() => {
    reactionFanoutBuffer.delete(key);
    sendLiveEventToUser(entry.userId, 'REACTIONS_BATCH', {
      conversation_id: entry.conversation_id,
      conversation_public_id: entry.conversation_public_id,
      message_id: entry.message_id,
      events: entry.events,
    });
  }, REACTION_BATCH_WINDOW_MS);

  reactionFanoutBuffer.set(key, entry);
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

/**
 * Bulk presence lookup — single Valkey pipeline instead of N individual calls.
 * Returns a Map<userId, { status, lastActive, activeCount }>.
 */
export async function getBulkUserPresence(userIds) {
  const result = new Map();
  if (!userIds || userIds.length === 0) return result;

  const offline = { status: 'offline', lastActive: null, activeCount: 0 };

  try {
    const pipeline = valkey.pipeline();
    for (const userId of userIds) {
      pipeline.get(presenceKey(userId));
      pipeline.get(presenceCountKey(userId));
    }
    const results = await pipeline.exec();

    for (let i = 0; i < userIds.length; i++) {
      const rawPresence = results?.[i * 2]?.[1];
      const rawCount = results?.[i * 2 + 1]?.[1];
      const parsedPresence = rawPresence ? JSON.parse(rawPresence) : null;
      const activeCount = parseSharedActiveCount(parsedPresence, rawCount);
      result.set(userIds[i], normalizePresence(parsedPresence, activeCount));
    }
  } catch (err) {
    console.error('Gateway bulk presence lookup error:', err);
    for (const userId of userIds) {
      if (!result.has(userId)) result.set(userId, offline);
    }
  }

  return result;
}
