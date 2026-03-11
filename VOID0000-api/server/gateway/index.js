import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import cookie from 'cookie';
import jwt from 'jsonwebtoken';
import valkey from '../valkey.js';

// Op codes
export const OP = {
  EVENT: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  HEARTBEAT_ACK: 3,
  STATUS_UPDATE: 4,
  RESUME: 6,
  RESUMED: 7,
  HELLO: 10,
};

// Event types
export const EVENTS = {
  READY: 'READY',
  PROFILE_UPDATE: 'PROFILE_UPDATE',
  FRIEND_REQUEST: 'FRIEND_REQUEST',
  FRIEND_ACCEPT: 'FRIEND_ACCEPT',
  FRIEND_REMOVE: 'FRIEND_REMOVE',
  PRESENCE_UPDATE: 'PRESENCE_UPDATE',
  CONVERSATION_UPDATE: 'CONVERSATION_UPDATE',
  MESSAGE_CREATE: 'MESSAGE_CREATE',
  TYPING_START: 'TYPING_START',
  TOKEN_EXPIRING: 'TOKEN_EXPIRING',
  REACTION_ADD: 'REACTION_ADD',
  REACTION_REMOVE: 'REACTION_REMOVE',
};

const CLOSE = {
  AUTH_TIMEOUT: 4000,
  UNAUTHORIZED: 4001,
  PROTOCOL_ERROR: 4002,
  FORBIDDEN: 4003,
  INVALID_SESSION: 4007,
  RATE_LIMITED: 4008,
  SESSION_REPLACED: 4009,
  SLOW_CONSUMER: 4010,
};

const WS_LIMITS = {
  maxPayload: 64 * 1024,
  maxBufferedAmount: 512 * 1024,
  handshake: {
    maxAttempts: 20,
    windowMs: 60_000,
  },
  preAuth: {
    maxMessages: 5,
    windowMs: 10_000,
  },
  authenticated: {
    maxMessages: 30,
    windowMs: 60_000,
  },
};

const MAX_CONNECTIONS_PER_USER = 5;
const VALID_STATUSES = new Set(['online', 'idle']);

// Store connections: userId -> Set of WebSocket connections
const connections = new Map();
const connectionInfo = new WeakMap();

// Presence store: userId -> { status, lastActive }
const presenceStore = new Map();

// Friend cache: userId -> Set<friendId>
const friendCache = new Map();

const handshakeAttempts = new Map();

// ==================== SESSION RESUME CONFIG ====================

const SESSION_BUFFER_MAX = 256;
const SESSION_BUFFER_TTL = 300;
const SESSION_KEY_PREFIX = 'sess:';
const SESSION_META_PREFIX = 'sessmeta:';
const SESSION_ID_BYTES = 18;

function sessionKey(sessionId) {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

function sessionMetaKey(sessionId) {
  return `${SESSION_META_PREFIX}${sessionId}`;
}

function createSessionId() {
  return crypto.randomBytes(SESSION_ID_BYTES).toString('base64url');
}

async function persistSessionIdentity(sessionId, userId, deviceId) {
  if (!sessionId || !userId || !deviceId) return;

  try {
    await valkey.set(
      sessionMetaKey(sessionId),
      JSON.stringify({ userId, deviceId }),
      'EX',
      SESSION_BUFFER_TTL
    );
  } catch (err) {
    console.error('Session metadata persist error:', err);
  }
}

async function getSessionIdentity(sessionId) {
  if (!sessionId) return null;

  try {
    const raw = await valkey.get(sessionMetaKey(sessionId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('Session metadata lookup error:', err);
    return null;
  }
}

async function bufferEvent(sessionId, payload) {
  if (!sessionId) return;

  const key = sessionKey(sessionId);

  try {
    await valkey.rpush(key, payload);
    await valkey.ltrim(key, -SESSION_BUFFER_MAX, -1);
    await valkey.expire(key, SESSION_BUFFER_TTL);
  } catch (err) {
    console.error('Session buffer error:', err);
  }
}

async function replayEvents(ws, sessionId, lastSequence) {
  const key = sessionKey(sessionId);

  try {
    const events = await valkey.lrange(key, 0, -1);
    let replayed = 0;
    let earliestSequence = null;
    let latestSequence = lastSequence;

    for (const raw of events) {
      let parsed;

      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      if (!Number.isInteger(parsed.s)) {
        continue;
      }

      if (earliestSequence === null) {
        earliestSequence = parsed.s;
      }

      if (parsed.s > latestSequence) {
        latestSequence = parsed.s;
      }

      if (parsed.s > lastSequence) {
        if (!sendRaw(ws, raw)) {
          break;
        }

        replayed++;
      }
    }

    return {
      replayed,
      gapDetected: earliestSequence !== null && lastSequence < earliestSequence - 1,
      latestSequence,
    };
  } catch (err) {
    console.error('Session replay error:', err);
    return { replayed: 0, gapDetected: true, latestSequence: lastSequence };
  }
}

// ==================== VALIDATION HELPERS ====================

class GatewayProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function assertPlainObject(value, message = 'Invalid payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, message);
  }
}

function validateIdentifyPayload(payload) {
  assertPlainObject(payload, 'Invalid identify');

  if (typeof payload.user_id !== 'string' || payload.user_id.length === 0 || payload.user_id.length > 64) {
    throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Invalid identify');
  }

  return { user_id: payload.user_id };
}

function validateResumePayload(payload) {
  assertPlainObject(payload, 'Invalid resume');

  if (typeof payload.session_id !== 'string' || payload.session_id.length === 0 || payload.session_id.length > 128) {
    throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Invalid resume');
  }

  if (!Number.isInteger(payload.last_sequence) || payload.last_sequence < 0) {
    throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Invalid resume');
  }

  return {
    session_id: payload.session_id,
    last_sequence: payload.last_sequence,
  };
}

function validateStatusPayload(payload) {
  assertPlainObject(payload, 'Invalid status update');

  if (!VALID_STATUSES.has(payload.status)) {
    throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Invalid status update');
  }

  return { status: payload.status };
}

function parseIncomingMessage(raw) {
  let message;

  try {
    message = JSON.parse(raw.toString());
  } catch {
    throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Invalid JSON');
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Invalid payload');
  }

  if (!Number.isInteger(message.op)) {
    throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Invalid opcode');
  }

  switch (message.op) {
    case OP.IDENTIFY:
      return { op: message.op, d: validateIdentifyPayload(message.d) };

    case OP.RESUME:
      return { op: message.op, d: validateResumePayload(message.d) };

    case OP.HEARTBEAT:
      if (message.d !== undefined && message.d !== null && typeof message.d !== 'number') {
        throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Invalid heartbeat');
      }
      return { op: message.op, d: message.d };

    case OP.STATUS_UPDATE:
      return { op: message.op, d: validateStatusPayload(message.d) };

    default:
      throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Unknown opcode');
  }
}

// ==================== CONNECTION HELPERS ====================

function getAllowedOrigins() {
  return new Set([
    process.env.FRONT_URL ?? 'http://localhost:5173',
    'https://void0000.online',
    'https://www.void0000.online',
    'http://localhost:5173',
    'http://localhost',
  ].filter(Boolean));
}

function getRequestIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = req.headers['cf-connecting-ip']
    || (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : null)
    || req.socket?.remoteAddress
    || null;

  if (!ip) return 'unknown';
  if (ip === '::1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
}

function isAllowedOrigin(origin) {
  if (!origin) return true;

  try {
    return getAllowedOrigins().has(new URL(origin).origin);
  } catch {
    return false;
  }
}

function checkHandshakeRateLimit(clientIp) {
  const now = Date.now();
  const limit = handshakeAttempts.get(clientIp);

  if (!limit || now - limit.windowStart > WS_LIMITS.handshake.windowMs) {
    handshakeAttempts.set(clientIp, { count: 1, windowStart: now });
    return true;
  }

  limit.count++;
  return limit.count <= WS_LIMITS.handshake.maxAttempts;
}

function clearConnectionTimers(info) {
  if (!info) return;

  if (info.identifyTimer) {
    clearTimeout(info.identifyTimer);
    info.identifyTimer = null;
  }

  if (info.tokenRefreshTimer) {
    clearTimeout(info.tokenRefreshTimer);
    info.tokenRefreshTimer = null;
  }

  if (info.tokenExpiryTimer) {
    clearTimeout(info.tokenExpiryTimer);
    info.tokenExpiryTimer = null;
  }
}

function closeSocket(ws, code, reason) {
  if (ws.readyState < 2) {
    ws.close(code, reason);
  }
}

// ==================== WS RATE LIMITING ====================

function checkWsRateLimit(ws) {
  const info = connectionInfo.get(ws);
  if (!info) return false;

  const now = Date.now();
  const policy = info.state === 'identified'
    ? WS_LIMITS.authenticated
    : WS_LIMITS.preAuth;

  if (!info.rateLimit) {
    info.rateLimit = { count: 0, windowStart: now };
  }

  const rateLimit = info.rateLimit;

  if (now - rateLimit.windowStart > policy.windowMs) {
    rateLimit.count = 0;
    rateLimit.windowStart = now;
  }

  rateLimit.count++;

  if (rateLimit.count > policy.maxMessages) {
    const actor = info.userId ? `user ${info.userId.substring(0, 8)}...` : `ip ${info.clientIp}`;
    console.warn(`WS rate limit hit for ${actor}`);
    return false;
  }

  return true;
}

// ==================== DEBUG ====================

function logConnectionStats() {
  console.log('Connection Stats:');
  connections.forEach((sockets, userId) => {
    console.log(`   User ${userId.substring(0, 8)}... has ${sockets.size} connection(s)`);
  });
  console.log(`   Total users: ${connections.size}`);
}

// ==================== GATEWAY SETUP ====================

export function setupGateway(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: WS_LIMITS.maxPayload,
    verifyClient: ({ origin, req }, done) => {
      const clientIp = getRequestIp(req);

      if (origin && !isAllowedOrigin(origin)) {
        console.warn(`Rejected WS origin ${origin} from ${clientIp}`);
        done(false, 403, 'Forbidden');
        return;
      }

      if (!checkHandshakeRateLimit(clientIp)) {
        console.warn(`Rejected WS flood from ${clientIp}`);
        done(false, 429, 'Rate limited');
        return;
      }

      done(true);
    },
  });

  wss.on('connection', (ws, req) => {
    const clientIp = getRequestIp(req);

    console.log(`New WebSocket connection attempt from ${clientIp}`);

    try {
      const cookies = cookie.parse(req.headers.cookie || '');
      const token = cookies.accessToken;

      if (!token) {
        console.log('No access token in cookies');
        closeSocket(ws, CLOSE.UNAUTHORIZED, 'Unauthorized');
        return;
      }

      const decoded = jwt.verify(token, process.env.ACCESS_SECRET);
      ws.verifiedUserId = decoded.id;
      ws.verifiedDeviceId = decoded.device_id;
      ws.tokenExp = decoded.exp;

      console.log(`Token verified for user ${decoded.id.substring(0, 8)}...`);
    } catch (err) {
      console.error('Connection refused:', err.message);
      closeSocket(ws, CLOSE.UNAUTHORIZED, 'Invalid token');
      return;
    }

    connectionInfo.set(ws, {
      userId: null,
      deviceId: ws.verifiedDeviceId || null,
      sessionId: null,
      seq: 0,
      lastHeartbeat: Date.now(),
      tokenRefreshTimer: null,
      tokenExpiryTimer: null,
      identifyTimer: null,
      rateLimit: null,
      state: 'awaiting_auth',
      clientIp,
    });

    send(ws, {
      op: OP.HELLO,
      d: {
        heartbeat_interval: 30000,
      },
    });

    const identifyTimer = setTimeout(() => {
      const info = connectionInfo.get(ws);

      if (info?.state !== 'identified') {
        console.log('Identify timeout, closing connection');
        closeSocket(ws, CLOSE.AUTH_TIMEOUT, 'Auth timeout');
      }
    }, 10000);

    const info = connectionInfo.get(ws);
    if (info) {
      info.identifyTimer = identifyTimer;
    }

    ws.on('message', async (raw) => {
      try {
        const message = parseIncomingMessage(raw);

        if (!checkWsRateLimit(ws)) {
          closeSocket(ws, CLOSE.RATE_LIMITED, 'Rate limited');
          return;
        }

        await handleMessage(ws, message);
      } catch (err) {
        if (err instanceof GatewayProtocolError) {
          console.warn(`WS protocol error from ${clientIp}: ${err.message}`);
          closeSocket(ws, err.code, err.message);
          return;
        }

        console.error('WebSocket message error:', err);
        closeSocket(ws, 1011, 'Internal error');
      }
    });

    ws.on('close', (code) => {
      console.log(`WebSocket closed with code ${code}`);
      handleDisconnect(ws);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });
  });

  setInterval(() => {
    const now = Date.now();
    let terminatedCount = 0;

    connections.forEach((sockets, userId) => {
      sockets.forEach((ws) => {
        const info = connectionInfo.get(ws);

        if (info && now - info.lastHeartbeat > 60000) {
          console.log(`Terminating idle connection for user ${userId.substring(0, 8)}...`);
          ws.terminate();
          terminatedCount++;
        }
      });
    });

    if (terminatedCount > 0) {
      console.log(`Terminated ${terminatedCount} idle connection(s)`);
    }
  }, 30000);

  const gracefulShutdown = (signal) => {
    console.log(`\nReceived ${signal}, performing graceful shutdown...`);

    wss.close(() => {
      console.log('No longer accepting new WebSocket connections');
    });

    let notifiedCount = 0;
    connections.forEach((sockets) => {
      sockets.forEach((ws) => {
        if (ws.readyState === 1) {
          dispatch(ws, 'SHUTDOWN', { reconnect: true, in: 5000 });
          notifiedCount++;
        }
      });
    });

    console.log(`Notified ${notifiedCount} client(s) of shutdown`);

    setTimeout(() => {
      let terminated = 0;
      connections.forEach((sockets) => {
        sockets.forEach((ws) => {
          clearConnectionTimers(connectionInfo.get(ws));
          ws.terminate();
          terminated++;
        });
      });

      console.log(`Terminated ${terminated} remaining connection(s)`);
      console.log('Gateway shutdown complete');
      process.exit(0);
    }, 5000);

    setTimeout(() => {
      console.error('Forced exit after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  console.log('WebSocket Gateway initialized');
  return wss;
}

// ==================== MESSAGE HANDLING ====================

async function handleMessage(ws, message) {
  const info = connectionInfo.get(ws);

  if (!info) {
    throw new GatewayProtocolError(CLOSE.UNAUTHORIZED, 'Unauthorized');
  }

  const { op, d } = message;

  switch (op) {
    case OP.IDENTIFY:
      if (info.state !== 'awaiting_auth') {
        throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Unexpected identify');
      }

      await handleIdentify(ws, d);
      return;

    case OP.RESUME:
      if (info.state !== 'awaiting_auth') {
        throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Unexpected resume');
      }

      await handleResume(ws, d);
      return;

    case OP.HEARTBEAT:
      handleHeartbeat(ws);
      return;

    case OP.STATUS_UPDATE:
      if (info.state !== 'identified') {
        throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Unexpected status update');
      }

      handleStatusUpdate(ws, d);
      return;

    default:
      throw new GatewayProtocolError(CLOSE.PROTOCOL_ERROR, 'Unknown opcode');
  }
}

function deduplicateDevice(userId, deviceId) {
  const existingSockets = connections.get(userId);
  if (!existingSockets) return;

  for (const existingWs of existingSockets) {
    const existingInfo = connectionInfo.get(existingWs);

    if (existingInfo?.deviceId === deviceId) {
      console.log(`Replacing stale connection for device ${deviceId.substring(0, 8)}...`);
      existingSockets.delete(existingWs);
      clearConnectionTimers(existingInfo);
      connectionInfo.delete(existingWs);
      closeSocket(existingWs, CLOSE.SESSION_REPLACED, 'Session replaced');
    }
  }

  if (existingSockets.size >= MAX_CONNECTIONS_PER_USER) {
    const oldest = existingSockets.values().next().value;
    const oldestInfo = connectionInfo.get(oldest);

    console.log(`Max connections reached for ${userId.substring(0, 8)}..., closing oldest`);
    existingSockets.delete(oldest);
    clearConnectionTimers(oldestInfo);
    connectionInfo.delete(oldest);
    closeSocket(oldest, CLOSE.SESSION_REPLACED, 'Too many connections');
  }
}

function registerConnection(ws, userId, deviceId, sessionId) {
  const existingInfo = connectionInfo.get(ws) || {};

  connectionInfo.set(ws, {
    ...existingInfo,
    userId,
    deviceId,
    sessionId,
    seq: 0,
    lastHeartbeat: Date.now(),
    tokenRefreshTimer: existingInfo.tokenRefreshTimer || null,
    tokenExpiryTimer: existingInfo.tokenExpiryTimer || null,
    identifyTimer: null,
    rateLimit: null,
    state: 'identified',
  });

  if (!connections.has(userId)) {
    connections.set(userId, new Set());
  }

  connections.get(userId).add(ws);
  return sessionId;
}

async function handleIdentify(ws, data) {
  const info = connectionInfo.get(ws);

  if (!info) {
    throw new GatewayProtocolError(CLOSE.UNAUTHORIZED, 'Unauthorized');
  }

  if (data.user_id !== ws.verifiedUserId) {
    console.warn(`Identity spoofing attempt! Token: ${ws.verifiedUserId}, Claimed: ${data.user_id}`);
    throw new GatewayProtocolError(CLOSE.FORBIDDEN, 'Forbidden');
  }

  info.state = 'authenticating';
  clearConnectionTimers(info);

  const userId = data.user_id;
  const deviceId = ws.verifiedDeviceId || 'unknown';
  const sessionId = createSessionId();

  deduplicateDevice(userId, deviceId);
  registerConnection(ws, userId, deviceId, sessionId);

  await persistSessionIdentity(sessionId, userId, deviceId);
  await valkey.del(sessionKey(sessionId)).catch(() => {});

  console.log(`User identified: ${userId.substring(0, 8)}... (device: ${deviceId.substring(0, 8)}...)`);
  logConnectionStats();

  presenceStore.set(userId, { status: 'online', lastActive: Date.now() });

  const friendPresences = await getFriendPresences(userId);

  dispatch(ws, EVENTS.READY, {
    user_id: userId,
    device_id: deviceId,
    session_id: sessionId,
    timestamp: Date.now(),
    presences: friendPresences,
  });

  setupTokenExpiryNotification(ws);

  void broadcastToFriends(userId, EVENTS.PRESENCE_UPDATE, {
    user_id: userId,
    status: 'online',
  });
}

async function handleResume(ws, data) {
  const info = connectionInfo.get(ws);

  if (!info) {
    throw new GatewayProtocolError(CLOSE.UNAUTHORIZED, 'Unauthorized');
  }

  info.state = 'authenticating';
  clearConnectionTimers(info);

  const userId = ws.verifiedUserId;
  const deviceId = ws.verifiedDeviceId || 'unknown';
  const sessionIdentity = await getSessionIdentity(data.session_id);

  if (!sessionIdentity || sessionIdentity.userId !== userId || sessionIdentity.deviceId !== deviceId) {
    console.warn(`Resume rejected for ${userId?.substring(0, 8)}...`);
    throw new GatewayProtocolError(CLOSE.INVALID_SESSION, 'Invalid session');
  }

  deduplicateDevice(userId, deviceId);
  registerConnection(ws, userId, deviceId, data.session_id);
  await persistSessionIdentity(data.session_id, userId, deviceId);

  console.log(`Session resume: ${userId.substring(0, 8)}... from seq ${data.last_sequence}`);

  const replay = await replayEvents(ws, data.session_id, data.last_sequence);

  if (replay.gapDetected) {
    console.warn(`Resume gap detected for ${userId.substring(0, 8)}...`);
    closeSocket(ws, CLOSE.INVALID_SESSION, 'Resume out of date');
    return;
  }

  const liveInfo = connectionInfo.get(ws);
  if (liveInfo) {
    liveInfo.seq = Math.max(data.last_sequence, replay.latestSequence);
  }

  send(ws, {
    op: OP.RESUMED,
    d: { replayed: replay.replayed },
  });

  console.log(`Resumed: replayed ${replay.replayed} events for ${userId.substring(0, 8)}...`);

  const currentPresence = presenceStore.get(userId);
  if (!currentPresence || currentPresence.status !== 'online') {
    presenceStore.set(userId, { status: 'online', lastActive: Date.now() });
    void broadcastToFriends(userId, EVENTS.PRESENCE_UPDATE, {
      user_id: userId,
      status: 'online',
    });
  }

  setupTokenExpiryNotification(ws);
}

// ==================== TOKEN EXPIRY ====================

function setupTokenExpiryNotification(ws) {
  const info = connectionInfo.get(ws);
  if (!info) return;

  if (info.tokenRefreshTimer) {
    clearTimeout(info.tokenRefreshTimer);
    info.tokenRefreshTimer = null;
  }

  if (info.tokenExpiryTimer) {
    clearTimeout(info.tokenExpiryTimer);
    info.tokenExpiryTimer = null;
  }

  const tokenExp = ws.tokenExp;
  if (!Number.isInteger(tokenExp)) return;

  const now = Math.floor(Date.now() / 1000);
  const timeUntilExpiry = tokenExp - now;

  if (timeUntilExpiry <= 0) {
    closeSocket(ws, CLOSE.UNAUTHORIZED, 'Token expired');
    return;
  }

  const notifyBefore = 120;
  const notifyIn = Math.max(timeUntilExpiry - notifyBefore, 0) * 1000;

  if (timeUntilExpiry > notifyBefore) {
    console.log(`Token refresh scheduled in ${Math.round(notifyIn / 1000)}s for user ${info.userId.substring(0, 8)}...`);

    info.tokenRefreshTimer = setTimeout(() => {
      if (ws.readyState === 1) {
        dispatch(ws, EVENTS.TOKEN_EXPIRING, {
          expires_in: notifyBefore,
          timestamp: Date.now(),
        });
      }
    }, notifyIn);
  } else {
    dispatch(ws, EVENTS.TOKEN_EXPIRING, {
      expires_in: timeUntilExpiry,
      timestamp: Date.now(),
    });
  }

  info.tokenExpiryTimer = setTimeout(() => {
    console.log(`Closing expired socket for user ${info.userId.substring(0, 8)}...`);
    closeSocket(ws, CLOSE.UNAUTHORIZED, 'Token expired');
  }, timeUntilExpiry * 1000);
}

export function updateTokenExpiry(userId, newExp, deviceId = null) {
  if (!Number.isInteger(newExp)) return;

  const userSockets = connections.get(userId);
  if (!userSockets) return;

  userSockets.forEach((ws) => {
    const info = connectionInfo.get(ws);
    if (!info) return;
    if (deviceId && info.deviceId !== deviceId) return;

    ws.tokenExp = newExp;
    setupTokenExpiryNotification(ws);
  });
}

export function disconnectUserSession(
  userId,
  deviceId = null,
  code = CLOSE.UNAUTHORIZED,
  reason = 'Session revoked'
) {
  const userSockets = connections.get(userId);
  if (!userSockets) return 0;

  let disconnected = 0;

  userSockets.forEach((ws) => {
    const info = connectionInfo.get(ws);

    if (!info) return;
    if (deviceId && info.deviceId !== deviceId) return;

    disconnected++;
    closeSocket(ws, code, reason);
  });

  return disconnected;
}

// ==================== HEARTBEAT & DISCONNECT ====================

function handleHeartbeat(ws) {
  const info = connectionInfo.get(ws);

  if (info) {
    info.lastHeartbeat = Date.now();

    if (info.sessionId && info.userId && info.deviceId) {
      void persistSessionIdentity(info.sessionId, info.userId, info.deviceId);
    }

    if (info.userId) {
      const currentPresence = presenceStore.get(info.userId);

      if (currentPresence?.status === 'idle') {
        presenceStore.set(info.userId, { status: 'online', lastActive: Date.now() });
        void broadcastToFriends(info.userId, EVENTS.PRESENCE_UPDATE, {
          user_id: info.userId,
          status: 'online',
          last_active: Date.now(),
        });
      } else if (currentPresence?.status === 'online') {
        presenceStore.set(info.userId, { ...currentPresence, lastActive: Date.now() });
      }
    }
  }

  send(ws, { op: OP.HEARTBEAT_ACK });
}

function handleDisconnect(ws) {
  const info = connectionInfo.get(ws);
  if (!info) return;

  clearConnectionTimers(info);
  connectionInfo.delete(ws);

  const { userId, deviceId } = info;

  if (!userId) {
    return;
  }

  const userSockets = connections.get(userId);
  if (userSockets) {
    userSockets.delete(ws);

    if (userSockets.size === 0) {
      connections.delete(userId);

      const presence = presenceStore.get(userId);
      presenceStore.set(userId, {
        status: 'offline',
        lastActive: presence?.lastActive || Date.now(),
      });

      void broadcastToFriends(userId, EVENTS.PRESENCE_UPDATE, {
        user_id: userId,
        status: 'offline',
        last_active: presence?.lastActive || Date.now(),
      });
    }
  }

  cleanupFriendCache(userId);
  console.log(`User disconnected: ${userId.substring(0, 8)}... (device: ${deviceId?.substring(0, 8)}...)`);
  logConnectionStats();
}

// ==================== FRIEND CACHE ====================

async function getFriendIds(userId) {
  if (friendCache.has(userId)) {
    return friendCache.get(userId);
  }

  const { pool } = await import('../db.js');

  try {
    const result = await pool.query(
      `SELECT
        CASE WHEN requester_id = $1 THEN addressee_id
             ELSE requester_id
        END as friend_id
       FROM friendships
       WHERE (requester_id = $1 OR addressee_id = $1)
         AND status = 'accepted'`,
      [userId]
    );

    const friendIds = new Set(result.rows.map((row) => row.friend_id));
    friendCache.set(userId, friendIds);
    return friendIds;
  } catch (err) {
    console.error('Friend cache fetch error:', err);
    return new Set();
  }
}

export function invalidateFriendCache(userId) {
  friendCache.delete(userId);
}

export function invalidateFriendCachePair(userId1, userId2) {
  friendCache.delete(userId1);
  friendCache.delete(userId2);
}

function cleanupFriendCache(userId) {
  if (!connections.has(userId)) {
    friendCache.delete(userId);
  }
}

async function getFriendPresences(userId) {
  const friendIds = await getFriendIds(userId);
  const presences = [];

  friendIds.forEach((friendId) => {
    const presence = presenceStore.get(friendId);

    if (presence && connections.has(friendId)) {
      presences.push({
        user_id: friendId,
        status: presence.status,
        last_active: presence.lastActive,
      });
    }
  });

  return presences;
}

function handleStatusUpdate(ws, data) {
  const info = connectionInfo.get(ws);
  if (!info?.userId) return;

  const { status } = data;
  const currentPresence = presenceStore.get(info.userId);

  if (currentPresence?.status === status) return;

  presenceStore.set(info.userId, {
    status,
    lastActive: status === 'online'
      ? Date.now()
      : (currentPresence?.lastActive || Date.now()),
  });

  void broadcastToFriends(info.userId, EVENTS.PRESENCE_UPDATE, {
    user_id: info.userId,
    status,
    last_active: presenceStore.get(info.userId).lastActive,
  });
}

export function getUserPresence(userId) {
  if (connections.has(userId)) {
    return presenceStore.get(userId) || { status: 'online', lastActive: Date.now() };
  }

  return { status: 'offline', lastActive: presenceStore.get(userId)?.lastActive || null };
}

// ==================== HELPERS ====================

function sendRaw(ws, payload) {
  if (ws.readyState !== 1) {
    return false;
  }

  if (ws.bufferedAmount > WS_LIMITS.maxBufferedAmount) {
    const info = connectionInfo.get(ws);
    console.warn(`Closing slow consumer for ${info?.userId?.substring(0, 8) || info?.clientIp || 'unknown'}`);
    closeSocket(ws, CLOSE.SLOW_CONSUMER, 'Slow consumer');
    return false;
  }

  try {
    ws.send(payload, (err) => {
      if (err) {
        console.error('WebSocket send error:', err);
        ws.terminate();
      }
    });

    return true;
  } catch (err) {
    console.error('WebSocket send throw:', err);
    ws.terminate();
    return false;
  }
}

function send(ws, data) {
  return sendRaw(ws, JSON.stringify(data));
}

function dispatch(ws, event, data) {
  const info = connectionInfo.get(ws);
  const seq = info ? ++info.seq : 0;

  const msg = {
    op: OP.EVENT,
    t: event,
    s: seq,
    d: data,
  };

  const payload = JSON.stringify(msg);
  const sent = sendRaw(ws, payload);

  if (info?.sessionId) {
    void bufferEvent(info.sessionId, payload);
  }

  return sent;
}

export function sendToUser(userId, event, data) {
  const userSockets = connections.get(userId);
  if (!userSockets) return;

  console.log(`Sending ${event} to user ${userId.substring(0, 8)}... (${userSockets.size} device(s))`);

  userSockets.forEach((ws) => {
    dispatch(ws, event, data);
  });
}

export async function broadcastToFriends(userId, event, data) {
  const friendIds = await getFriendIds(userId);

  friendIds.forEach((friendId) => {
    sendToUser(friendId, event, data);
  });
}

export function getConnectionStats() {
  const stats = {
    totalUsers: connections.size,
    users: {},
  };

  connections.forEach((sockets, userId) => {
    stats.users[userId] = sockets.size;
  });

  return stats;
}

export { connections };
