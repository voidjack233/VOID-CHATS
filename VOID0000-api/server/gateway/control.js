export async function syncLiveTokenExpiry(userId, deviceId, newExp) {
  if (!userId || !deviceId || !Number.isInteger(newExp)) return;

  const { publishGatewayCommand } = await import('../valkey-pubsub.js');
  publishGatewayCommand('updateTokenExpiry', { userId, deviceId, newExp });
}

export async function disconnectLiveSession(
  userId,
  deviceId,
  code = 4001,
  reason = 'Session revoked'
) {
  if (!userId) return;

  const { publishGatewayCommand } = await import('../valkey-pubsub.js');
  publishGatewayCommand('disconnectSession', { userId, deviceId, code, reason });
}
