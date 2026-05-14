// server/valkey-pubsub.js
// Bridges API workers ↔ Gateway via Valkey Pub/Sub
import Redis from 'ioredis';
import { debugLog } from './utils/debugLog.js';

const CHANNEL = 'void:gateway';

let publisher = null;
let subscriber = null;
let messageHandler = null;

/**
 * Initialize the publisher (used by API workers to send events to gateway)
 */
export function initPublisher() {
  if (publisher) return publisher;

  publisher = new Redis({
    host: process.env.VALKEY_HOST || '127.0.0.1',
    port: parseInt(process.env.VALKEY_PORT || '6379', 10),
    maxRetriesPerRequest: 3,
  });

  publisher.on('connect', () => debugLog('📡 Pub/Sub publisher connected'));
  publisher.on('error', (err) => console.error('📡 Publisher error:', err.message));

  return publisher;
}

/**
 * Initialize the subscriber (used by gateway to receive events from workers)
 */
export function initSubscriber(handler) {
  if (subscriber) return subscriber;

  messageHandler = handler;

  subscriber = new Redis({
    host: process.env.VALKEY_HOST || '127.0.0.1',
    port: parseInt(process.env.VALKEY_PORT || '6379', 10),
    maxRetriesPerRequest: 3,
  });

  subscriber.on('connect', () => debugLog('📡 Pub/Sub subscriber connected'));
  subscriber.on('error', (err) => console.error('📡 Subscriber error:', err.message));

  subscriber.subscribe(CHANNEL, (err) => {
    if (err) console.error('📡 Subscribe error:', err);
    else debugLog(`📡 Subscribed to channel: ${CHANNEL}`);
  });

  subscriber.on('message', (channel, message) => {
    if (channel === CHANNEL && messageHandler) {
      try {
        const parsed = JSON.parse(message);
        messageHandler(parsed);
      } catch (err) {
        console.error('📡 Failed to parse pub/sub message:', err);
      }
    }
  });

  return subscriber;
}

/**
 * Publish an event from API worker to gateway
 * Used by routes that need to notify connected WebSocket clients
 */
export function publishToGateway(event, targetUserId, data) {
  if (!publisher) {
    console.warn('📡 Publisher not initialized, skipping publish');
    return;
  }

  const message = JSON.stringify({
    event,
    targetUserId,
    data,
    timestamp: Date.now(),
  });

  publisher.publish(CHANNEL, message).catch((err) => {
    console.error('📡 Publish error:', err);
  });
}

export function publishGatewayCommand(command, data) {
  if (!publisher) {
    console.warn('📡 Publisher not initialized, skipping gateway command');
    return;
  }

  const message = JSON.stringify({
    type: 'command',
    command,
    data,
    timestamp: Date.now(),
  });

  publisher.publish(CHANNEL, message).catch((err) => {
    console.error('📡 Command publish error:', err);
  });
}

/**
 * Cleanup connections
 */
export async function closePubSub() {
  if (publisher) await publisher.quit();
  if (subscriber) await subscriber.quit();
}
