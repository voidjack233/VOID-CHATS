import { WebSocketServer } from 'ws';
import cookie from 'cookie';
import jwt from 'jsonwebtoken';

// Op codes
export const OP = {
  EVENT: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  HEARTBEAT_ACK: 3,
  STATUS_UPDATE: 4,
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
  MESSAGE_CREATE: 'MESSAGE_CREATE',
  TYPING_START: 'TYPING_START',
  TOKEN_EXPIRING: 'TOKEN_EXPIRING',
};

// Store connections: userId -> Set of WebSocket connections
const connections = new Map();
const connectionInfo = new WeakMap(); // ws -> { userId, deviceId, lastHeartbeat, tokenRefreshTimer }

// Presence store: userId -> { status, lastActive }
const presenceStore = new Map();

let sequenceNumber = 0;
let wssRef = null;

// ==================== WS RATE LIMITING ====================

const WS_RATE_LIMIT = {
  maxMessages: 30,
  windowMs: 60000,
  closeCode: 4008,
  closeReason: 'Rate limited',
};

function checkWsRateLimit(ws) {
  const info = connectionInfo.get(ws);
  if (!info) return true;

  const now = Date.now();

  if (!info.rateLimit) {
    info.rateLimit = { count: 0, windowStart: now };
  }

  const rl = info.rateLimit;

  if (now - rl.windowStart > WS_RATE_LIMIT.windowMs) {
    rl.count = 0;
    rl.windowStart = now;
  }

  rl.count++;

  if (rl.count > WS_RATE_LIMIT.maxMessages) {
    console.warn(`⚠️ WS rate limit hit for user ${info.userId?.substring(0, 8)}... (${rl.count} msgs in ${Math.round((now - rl.windowStart) / 1000)}s)`);
    return false;
  }

  return true;
}

// ==================== DEBUG ====================

function logConnectionStats() {
  console.log('📊 Connection Stats:');
  connections.forEach((sockets, userId) => {
    console.log(`   User ${userId.substring(0, 8)}... has ${sockets.size} connection(s)`);
  });
  console.log(`   Total users: ${connections.size}`);
}

// ==================== GATEWAY SETUP ====================

export function setupGateway(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });
  wssRef = wss;

  wss.on('connection', (ws, req) => {
    console.log('🔌 New WebSocket connection attempt...');

    try {
      const cookies = cookie.parse(req.headers.cookie || '');
      const token = cookies.accessToken;

      if (!token) {
        console.log('❌ No access token in cookies');
        ws.close(4001, 'Unauthorized');
        return;
      }

      const decoded = jwt.verify(token, process.env.ACCESS_SECRET);
      ws.verifiedUserId = decoded.id;
      ws.verifiedDeviceId = decoded.device_id;
      ws.tokenExp = decoded.exp;

      console.log(`🔓 Token verified for user ${decoded.id.substring(0, 8)}... device ${decoded.device_id?.substring(0, 8)}...`);
    } catch (err) {
      console.error('⛔ Connection refused:', err.message);
      ws.close(4001, 'Invalid Token');
      return;
    }

    // Send HELLO
    send(ws, {
      op: OP.HELLO,
      d: {
        heartbeat_interval: 30000,
      },
    });

    // Set timeout for IDENTIFY
    const identifyTimeout = setTimeout(() => {
      if (!connectionInfo.get(ws)?.userId) {
        console.log('⏰ Identify timeout, closing connection');
        ws.close(4000, 'Auth timeout');
      }
    }, 10000);

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());

        if (connectionInfo.has(ws) && !checkWsRateLimit(ws)) {
          ws.close(WS_RATE_LIMIT.closeCode, WS_RATE_LIMIT.closeReason);
          return;
        }

        handleMessage(ws, message, identifyTimeout);
      } catch (err) {
        console.error('Invalid message:', err);
      }
    });

    ws.on('close', (code, reason) => {
      console.log(`🔌 WebSocket closed with code ${code}`);
      handleDisconnect(ws);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });
  });

  // Heartbeat checker — kill connections that missed 2 heartbeat intervals
  setInterval(() => {
    const now = Date.now();
    let terminatedCount = 0;

    connections.forEach((sockets, userId) => {
      sockets.forEach((ws) => {
        const info = connectionInfo.get(ws);
        if (info && now - info.lastHeartbeat > 60000) {
          console.log(`💀 Terminating idle connection for user ${userId.substring(0, 8)}...`);
          ws.terminate();
          terminatedCount++;
        }
      });
    });

    if (terminatedCount > 0) {
      console.log(`🧹 Terminated ${terminatedCount} idle connection(s)`);
    }
  }, 30000);

  // ==================== GRACEFUL SHUTDOWN ====================

  const gracefulShutdown = (signal) => {
    console.log(`\n🔄 Received ${signal}, performing graceful shutdown...`);

    wss.close(() => {
      console.log('🚫 No longer accepting new WebSocket connections');
    });

    let notifiedCount = 0;
    connections.forEach((sockets, userId) => {
      sockets.forEach((ws) => {
        if (ws.readyState === 1) {
          dispatch(ws, 'SHUTDOWN', { reconnect: true, in: 5000 });
          notifiedCount++;
        }
      });
    });

    console.log(`📢 Notified ${notifiedCount} client(s) of shutdown`);

    setTimeout(() => {
      let terminated = 0;
      connections.forEach((sockets) => {
        sockets.forEach((ws) => {
          const info = connectionInfo.get(ws);
          if (info?.tokenRefreshTimer) {
            clearTimeout(info.tokenRefreshTimer);
          }
          ws.terminate();
          terminated++;
        });
      });

      console.log(`🔌 Terminated ${terminated} remaining connection(s)`);
      console.log('👋 Gateway shutdown complete');
      process.exit(0);
    }, 5000);

    setTimeout(() => {
      console.error('⚠️ Forced exit after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  console.log('🔌 WebSocket Gateway initialized');
  return wss;
}

// ==================== MESSAGE HANDLING ====================

function handleMessage(ws, message, identifyTimeout) {
  const { op, d } = message;

  switch (op) {
    case OP.IDENTIFY:
      handleIdentify(ws, d, identifyTimeout);
      break;

    case OP.HEARTBEAT:
      handleHeartbeat(ws);
      break;

    case OP.STATUS_UPDATE:
      handleStatusUpdate(ws, d);
      break;

    default:
      console.warn('Unknown op:', op);
  }
}

// ==================== MAX CONNECTIONS PER USER ====================
const MAX_CONNECTIONS_PER_USER = 5;

async function handleIdentify(ws, data, identifyTimeout) {
  const { user_id } = data;

  if (!user_id) {
    ws.close(4001, 'Invalid identify');
    return;
  }

  // Verify user_id matches token
  if (user_id !== ws.verifiedUserId) {
    console.warn(`🚨 Identity spoofing attempt! Token: ${ws.verifiedUserId}, Claimed: ${user_id}`);
    ws.close(4003, 'Forbidden');
    return;
  }

  clearTimeout(identifyTimeout);

  const deviceId = ws.verifiedDeviceId || 'unknown';

  // ========== DEDUPLICATE: Close old connection from same device ==========
  const existingSockets = connections.get(user_id);
  if (existingSockets) {
    for (const existingWs of existingSockets) {
      const existingInfo = connectionInfo.get(existingWs);
      if (existingInfo?.deviceId === deviceId) {
        console.log(`♻️ Replacing stale connection for device ${deviceId.substring(0, 8)}...`);
        // Remove from set first to prevent handleDisconnect from broadcasting offline
        existingSockets.delete(existingWs);
        connectionInfo.delete(existingWs);
        // Clear any timers
        if (existingInfo.tokenRefreshTimer) {
          clearTimeout(existingInfo.tokenRefreshTimer);
        }
        // Close it — onclose will fire but handleDisconnect won't find info
        existingWs.close(4009, 'Session replaced');
      }
    }

    // Hard cap: if user somehow has too many devices, close oldest
    if (existingSockets.size >= MAX_CONNECTIONS_PER_USER) {
      const oldest = existingSockets.values().next().value;
      const oldestInfo = connectionInfo.get(oldest);
      console.log(`🔒 Max connections reached for ${user_id.substring(0, 8)}..., closing oldest`);
      existingSockets.delete(oldest);
      connectionInfo.delete(oldest);
      if (oldestInfo?.tokenRefreshTimer) clearTimeout(oldestInfo.tokenRefreshTimer);
      oldest.close(4009, 'Too many connections');
    }
  }

  // Store connection info
  connectionInfo.set(ws, {
    userId: user_id,
    deviceId: deviceId,
    lastHeartbeat: Date.now(),
    tokenRefreshTimer: null,
    rateLimit: null,
  });

  // Add to connections map
  if (!connections.has(user_id)) {
    connections.set(user_id, new Set());
  }
  connections.get(user_id).add(ws);

  console.log(`✅ User identified: ${user_id.substring(0, 8)}... (device: ${deviceId.substring(0, 8)}...)`);
  logConnectionStats();

  // Set presence to online
  presenceStore.set(user_id, { status: 'online', lastActive: Date.now() });

  // Get online/idle friends to include in READY payload
  const friendPresences = await getFriendPresences(user_id);

  // Send READY event
  dispatch(ws, EVENTS.READY, {
    user_id,
    device_id: deviceId,
    timestamp: Date.now(),
    presences: friendPresences,
  });

  // Set up token expiry notification
  setupTokenExpiryNotification(ws);

  // Notify friends user is online
  broadcastToFriends(user_id, EVENTS.PRESENCE_UPDATE, {
    user_id,
    status: 'online',
  });
}

// ==================== TOKEN EXPIRY ====================

function setupTokenExpiryNotification(ws) {
  const info = connectionInfo.get(ws);
  if (!info) return;

  if (info.tokenRefreshTimer) {
    clearTimeout(info.tokenRefreshTimer);
  }

  const tokenExp = ws.tokenExp;
  if (!tokenExp) return;

  const now = Math.floor(Date.now() / 1000);
  const timeUntilExpiry = tokenExp - now;

  const notifyBefore = 120;
  const notifyIn = (timeUntilExpiry - notifyBefore) * 1000;

  if (notifyIn > 0) {
    console.log(`⏰ Token refresh scheduled in ${Math.round(notifyIn / 1000)}s for user ${info.userId.substring(0, 8)}... (device: ${info.deviceId.substring(0, 8)}...)`);

    info.tokenRefreshTimer = setTimeout(() => {
      if (ws.readyState === 1) {
        console.log(`🔄 Sending TOKEN_EXPIRING to ${info.userId.substring(0, 8)}... (device: ${info.deviceId.substring(0, 8)}...)`);
        dispatch(ws, EVENTS.TOKEN_EXPIRING, {
          expires_in: notifyBefore,
          timestamp: Date.now(),
        });
      }
    }, notifyIn);
  } else {
    console.log(`🔄 Token expiring soon, notifying ${info.userId.substring(0, 8)}... immediately`);
    dispatch(ws, EVENTS.TOKEN_EXPIRING, {
      expires_in: Math.max(timeUntilExpiry, 0),
      timestamp: Date.now(),
    });
  }
}

export function updateTokenExpiry(userId, newExp) {
  const userSockets = connections.get(userId);
  if (userSockets) {
    userSockets.forEach((ws) => {
      ws.tokenExp = newExp;
      setupTokenExpiryNotification(ws);
    });
  }
}

// ==================== HEARTBEAT & DISCONNECT ====================

function handleHeartbeat(ws) {
  const info = connectionInfo.get(ws);
  if (info) {
    info.lastHeartbeat = Date.now();
  }
  send(ws, { op: OP.HEARTBEAT_ACK });
}

function handleDisconnect(ws) {
  const info = connectionInfo.get(ws);
  if (!info) return; // Already cleaned up (e.g. by device dedup)

  const { userId, deviceId, tokenRefreshTimer } = info;

  if (tokenRefreshTimer) {
    clearTimeout(tokenRefreshTimer);
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

      broadcastToFriends(userId, EVENTS.PRESENCE_UPDATE, {
        user_id: userId,
        status: 'offline',
        last_active: presence?.lastActive || Date.now(),
      });
    }
  }

  connectionInfo.delete(ws);
  cleanupFriendCache(userId);
  console.log(`🔌 User disconnected: ${userId.substring(0, 8)}... (device: ${deviceId?.substring(0, 8)}...)`);
  logConnectionStats();
}

// ==================== FRIEND CACHE ====================

const friendCache = new Map();

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

    const friendIds = new Set(result.rows.map(row => row.friend_id));
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
  if (!info) return;

  const { status } = data;
  const validStatuses = ['online', 'idle'];
  if (!validStatuses.includes(status)) return;

  const currentPresence = presenceStore.get(info.userId);
  if (currentPresence?.status === status) return;

  presenceStore.set(info.userId, {
    status,
    lastActive: status === 'online' ? Date.now() : (currentPresence?.lastActive || Date.now()),
  });

  broadcastToFriends(info.userId, EVENTS.PRESENCE_UPDATE, {
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

function send(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function dispatch(ws, event, data) {
  send(ws, {
    op: OP.EVENT,
    t: event,
    s: ++sequenceNumber,
    d: data,
  });
}

export function sendToUser(userId, event, data) {
  const userSockets = connections.get(userId);
  if (!userSockets) return; // User not connected — skip silently

  console.log(`📤 Sending ${event} to user ${userId.substring(0, 8)}... (${userSockets.size} device(s))`);

  const payload = JSON.stringify({
    op: OP.EVENT,
    t: event,
    s: ++sequenceNumber,
    d: data,
  });

  userSockets.forEach((ws) => {
    if (ws.readyState === 1) {
      ws.send(payload);
    }
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