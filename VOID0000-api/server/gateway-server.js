// server/gateway-server.js
// Standalone WebSocket gateway process
// Only runs when cluster mode is enabled
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import {
  setupGateway,
  sendToUser,
  broadcastToFriends,
  updateTokenExpiry,
  disconnectUserSession,
} from './gateway/index.js';
import { initSubscriber } from './valkey-pubsub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Read config
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const config = require('./config.json');

const PORT = config.cluster.gatewayPort || 3002;

// Create bare HTTP server for WebSocket upgrades
const httpServer = createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'gateway' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// Setup WebSocket gateway
setupGateway(httpServer);

// Subscribe to Valkey Pub/Sub for events from API workers
initSubscriber((message) => {
  try {
    if (message.type === 'broadcastToFriends') {
      void broadcastToFriends(message.userId, message.event, message.data);
    } else if (message.type === 'command') {
      if (message.command === 'updateTokenExpiry') {
        updateTokenExpiry(message.data?.userId, message.data?.newExp, message.data?.deviceId ?? null);
      } else if (message.command === 'disconnectSession') {
        disconnectUserSession(
          message.data?.userId,
          message.data?.deviceId ?? null,
          message.data?.code ?? 4001,
          message.data?.reason ?? 'Session revoked'
        );
      }
    } else if (message.targetUserId) {
      sendToUser(message.targetUserId, message.event, message.data);
    }
  } catch (err) {
    console.error('❌ Gateway pub/sub handler error:', err);
  }
});

// Start
httpServer.listen(PORT, () => {
  console.log(`✅ Gateway server running on port ${PORT}`);
  console.log(`🔌 WebSocket Gateway ready (standalone mode)`);
});
