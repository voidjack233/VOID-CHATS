// server/gateway/presence-fanout.js
//
// Subscribes to `void:presence_change` (published by the Phoenix gateway)
// and fans out PRESENCE_UPDATE events to each friend via `void:gateway`.
//
// Flow:
//   Phoenix writes presence to Valkey → publishes {userId, status, lastActive}
//   to void:presence_change → this subscriber picks it up → resolves friend IDs
//   from Postgres → publishes individual PRESENCE_UPDATE events to void:gateway
//   → Phoenix fans out to connected sockets via EventDispatcher.

import Redis from 'ioredis';
import { EVENTS } from './protocol.js';
import { debugLog } from '../utils/debugLog.js';

const CHANNEL = 'void:presence_change';

let subscriber = null;

/**
 * Start the presence-change subscriber.
 * Call once at server startup, after initPublisher().
 */
export function initPresenceFanout() {
  if (subscriber) return;

  subscriber = new Redis({
    host: process.env.VALKEY_HOST || '127.0.0.1',
    port: parseInt(process.env.VALKEY_PORT || '6379', 10),
    maxRetriesPerRequest: 3,
  });

  subscriber.on('connect', () =>
    debugLog(`📡 Presence fanout subscriber connected`)
  );
  subscriber.on('error', (err) =>
    console.error('📡 Presence fanout subscriber error:', err.message)
  );

  subscriber.subscribe(CHANNEL, (err) => {
    if (err) console.error(`📡 Presence fanout subscribe error:`, err);
    else debugLog(`📡 Subscribed to ${CHANNEL}`);
  });

  subscriber.on('message', (channel, raw) => {
    if (channel !== CHANNEL) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('📡 Presence fanout: invalid JSON');
      return;
    }

    const { userId, status, lastActive } = msg;
    if (!userId || !status) return;

    handlePresenceChange(userId, status, lastActive);
  });
}

async function handlePresenceChange(userId, status, lastActive) {
  try {
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

    const data = { user_id: userId, status, last_active: lastActive };

    for (const row of result.rows) {
      publishToGateway(EVENTS.PRESENCE_UPDATE, row.friend_id, data);
    }
  } catch (err) {
    console.error('📡 Presence fanout error:', err);
  }
}
