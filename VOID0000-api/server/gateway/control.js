import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const config = require('../config.json');
const isCluster = config.cluster.enabled;

export async function syncLiveTokenExpiry(userId, deviceId, newExp) {
  if (!userId || !deviceId || !Number.isInteger(newExp)) return;

  if (isCluster) {
    const { publishGatewayCommand } = await import('../valkey-pubsub.js');
    publishGatewayCommand('updateTokenExpiry', { userId, deviceId, newExp });
    return;
  }

  const { updateTokenExpiry } = await import('./index.js');
  updateTokenExpiry(userId, newExp, deviceId);
}

export async function disconnectLiveSession(
  userId,
  deviceId,
  code = 4001,
  reason = 'Session revoked'
) {
  if (!userId) return;

  if (isCluster) {
    const { publishGatewayCommand } = await import('../valkey-pubsub.js');
    publishGatewayCommand('disconnectSession', { userId, deviceId, code, reason });
    return;
  }

  const { disconnectUserSession } = await import('./index.js');
  disconnectUserSession(userId, deviceId, code, reason);
}
