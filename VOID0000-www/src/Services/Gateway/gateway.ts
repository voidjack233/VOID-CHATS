import { authService } from '../Auth/authServiceApi';

const OP = {
  EVENT: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  HEARTBEAT_ACK: 3,
  HELLO: 10,
};

type EventHandler = (data: any) => void;

class Gateway {
  private ws: WebSocket | null = null;
  private heartbeatInterval: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private handlers: Map<string, EventHandler[]> = new Map();
  private userId: string | null = null;
  private isDisconnecting = false;
  private isRefreshing = false;
  private isConnecting = false; // Prevents parallel connect attempts
  private lastRefreshTime = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingForAck = false; // Heartbeat ACK tracking

  connect(userId: string) {
    // Connection lock: prevent multiple simultaneous connect attempts
    if (this.isConnecting) {
      console.log('⏳ Connection attempt already in progress, skipping');
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      if (this.userId === userId) return;
      this.disconnect();
    }

    this.userId = userId;
    this.isDisconnecting = false;
    this.isConnecting = true;

    // Listen for network recovery — skip countdown and reconnect immediately
    window.addEventListener('online', this.handleOnline);

    const wsUrl = import.meta.env.DEV
      ? 'ws://localhost:3001'
      : 'wss://api.void0000.online';

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('🔌 Failed to create WebSocket:', err);
      this.isConnecting = false;
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('🔌 Gateway connected');
      this.isConnecting = false;
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        this.handleMessage(JSON.parse(event.data));
      } catch (err) {
        console.error('Failed to parse gateway message', err);
      }
    };

    this.ws.onclose = (event) => {
      this.isConnecting = false;

      if (this.isDisconnecting) return;

      // Auth failed — try refresh instead of giving up
      if (event.code === 4001 || event.code === 4003) {
        console.log('🔌 Gateway auth failed, attempting refresh...');
        this.cleanup();
        this.handleAuthFailure();
        return;
      }

      // Session replaced by newer connection on same device — don't reconnect
      if (event.code === 4009) {
        console.log('🔌 Session replaced by newer connection');
        return;
      }

      console.log('🔌 Gateway closed:', event.code);
      this.cleanup();
      this.scheduleReconnect();
    };

    // Don't reconnect from onerror — onclose always fires after onerror
    // Handling both causes duplicate reconnect attempts
    this.ws.onerror = (error) => {
      console.error('🔌 Gateway error:', error);
    };
  }

  private handleMessage(message: any) {
    const { op, t, d } = message;

    switch (op) {
      case OP.HELLO:
        this.heartbeatInterval = d.heartbeat_interval;
        this.startHeartbeat();
        this.identify();
        break;

      case OP.HEARTBEAT_ACK:
        this.waitingForAck = false;
        break;

      case OP.EVENT:
        if (t === 'TOKEN_EXPIRING') {
          this.handleTokenExpiring(d);
        } else if (t === 'SHUTDOWN') {
          console.log(`🔄 Server shutting down, reconnecting in ${d.in / 1000}s...`);
          this.cleanup();
          if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
          }
          this.ws = null;
          setTimeout(() => {
            if (this.userId) {
              this.reconnectAttempts = 0;
              this.connect(this.userId);
            }
          }, d.in || 5000);
        } else {
          this.emit(t, d);
        }
        break;
    }
  }

  private async handleTokenExpiring(data: { expires_in: number }) {
    const now = Date.now();
    if (now - this.lastRefreshTime < 60000) {
      console.log('🔄 Skipping refresh - cooldown active');
      return;
    }

    if (this.isRefreshing) {
      console.log('🔄 Skipping refresh - already in progress');
      return;
    }

    this.isRefreshing = true;
    this.lastRefreshTime = now;
    console.log(`🔄 Token expiring in ${data.expires_in}s, refreshing...`);

    try {
      const success = await authService.refreshToken();

      if (success) {
        console.log('✅ Token refreshed successfully');
        this.reconnectWithNewToken();
      } else {
        console.error('❌ Token refresh failed');
      }
    } catch (err) {
      console.error('❌ Token refresh error:', err);
    } finally {
      this.isRefreshing = false;
    }
  }

  private async handleAuthFailure() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`🔄 Auth recovery attempt ${attempt}/3...`);
        const success = await authService.refreshToken();

        if (success) {
          console.log('✅ Token refreshed after WS auth failure, reconnecting...');
          this.isRefreshing = false;
          this.reconnectAttempts = 0;
          this.reconnectWithNewToken();
          return;
        }
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }

    console.log('🔌 Auth recovery failed, falling back to reconnect loop...');
    this.isRefreshing = false;
    this.scheduleReconnect();
  }

  private reconnectWithNewToken() {
    if (!this.userId) return;

    const userId = this.userId;

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }

    this.cleanup();
    this.ws = null;

    setTimeout(() => {
      this.connect(userId);
    }, 100);
  }

  private identify() {
    if (!this.userId) return;
    this.send({
      op: OP.IDENTIFY,
      d: { user_id: this.userId },
    });
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.waitingForAck = false;

    this.heartbeatTimer = setInterval(() => {
      if (this.waitingForAck) {
        // Never got ACK back from last heartbeat — connection is dead
        console.log('💀 Missed heartbeat ACK, connection is zombie — reconnecting');
        this.ws?.close();
        return;
      }

      this.waitingForAck = true;
      this.send({ op: OP.HEARTBEAT });
    }, this.heartbeatInterval || 30000);
  }

  private send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // Public send — used by idle detector for STATUS_UPDATE
  sendRaw(data: any) {
    this.send(data);
  }

  private cleanup() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.isDisconnecting) return;

    this.reconnectAttempts++;

    // Exponential backoff: 2s, 4s, 8s, 16s, 30s, then 30s forever
    // isConnecting lock ensures only one attempt runs at a time
    const baseDelay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    // Wider jitter at higher attempts to prevent thundering herd
    // Early attempts: 0-1s jitter (reconnect fast)
    // After cap: 0-15s jitter (spread out 10k+ clients over 45s window)
    const maxJitter = baseDelay >= 30000 ? 15000 : 1000;
    const jitter = Math.random() * maxJitter;
    const delay = baseDelay + jitter;

    console.log(`🔌 Reconnecting in ${Math.round(delay / 1000)}s... (attempt ${this.reconnectAttempts})`);

    // Clear any existing reconnect timer to prevent stacking
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.userId && !this.isDisconnecting) {
        this.ws = null;
        this.connect(this.userId);
      }
    }, delay);
  }

  // Reset reconnect counter when app regains focus
  resetReconnect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.isConnecting) return;
    if (!this.userId) return;
    if (this.isDisconnecting) return;

    // If we're already retrying (timer pending), let it continue
    // Only interrupt if we've been idle (no pending timer = hit max retries)
    if (this.reconnectTimer) {
      console.log('🔌 App focused, reconnect already scheduled');
      return;
    }

    console.log('🔌 App focused, reconnecting immediately...');
    this.reconnectAttempts = 0;
    this.ws = null;
    this.connect(this.userId);
  }

  on(event: string, handler: EventHandler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  off(event: string, handler?: EventHandler) {
    if (handler) {
      const handlers = this.handlers.get(event);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index > -1) handlers.splice(index, 1);
      }
    } else {
      this.handlers.delete(event);
    }
  }

  private emit(event: string, data: any) {
    const handlers = this.handlers.get(event) || [];
    handlers.forEach((handler) => handler(data));
  }

  private handleOnline = () => {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.isConnecting) return;
    if (this.isDisconnecting) return;
    if (!this.userId) return;

    console.log('🌐 Network back, reconnecting immediately...');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectAttempts = 0;
    this.ws = null;
    this.connect(this.userId);
  };

  disconnect() {
    this.isDisconnecting = true;
    this.cleanup();
    window.removeEventListener('online', this.handleOnline);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.close();
    }

    this.ws = null;
    this.userId = null;
  }
}

export const gateway = new Gateway();