import { authService } from '../Auth/authServiceApi';
import { SOCKET_URL } from '../config';
import { debugLog } from '../utils/debugLog';

const OP = {
  EVENT: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  HEARTBEAT_ACK: 3,
  RESUME: 6,
  RESUMED: 7,
  HELLO: 10,
};

type EventHandler = (data: any) => void;
type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';

class Gateway {
  private static readonly CLIENT_INSTANCE_STORAGE_KEY = 'void_gateway_client_instance_id';
  private ws: WebSocket | null = null;
  private heartbeatInterval: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private handlers: Map<string, EventHandler[]> = new Map();
  private userId: string | null = null;
  private isDisconnecting = false;
  private isRefreshing = false;
  private isConnecting = false;
  private lastRefreshTime = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingForAck = false;
  private missedHeartbeatAcks = 0;
  private readonly clientInstanceId = Gateway.getOrCreateClientInstanceId();

  // Session resume state
  private sessionId: string | null = null;
  private lastSequence = 0;
  private canResume = false;

  // Connection state (exposed to UI)
  private _connectionState: ConnectionState = 'disconnected';
  private _hasEverConnected = false;

  private static getOrCreateClientInstanceId() {
    const existing = window.sessionStorage.getItem(Gateway.CLIENT_INSTANCE_STORAGE_KEY);
    if (existing) return existing;

    const nextId = crypto.randomUUID();
    window.sessionStorage.setItem(Gateway.CLIENT_INSTANCE_STORAGE_KEY, nextId);
    return nextId;
  }

  private resolveGatewayUrl() {
    if (import.meta.env.DEV) {
      return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/gateway`;
    }

    const fallbackBase = SOCKET_URL || 'https://api.void0000.online';

    try {
      const url = new URL(fallbackBase);
      url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';

      if (!url.pathname || url.pathname === '/') {
        url.pathname = '/gateway';
      }

      return url.toString();
    } catch {
      return 'wss://api.void0000.online/gateway';
    }
  }

  connect(userId: string) {
    if (this.isConnecting) {
      debugLog('Connection attempt already in progress, skipping');
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      if (this.userId === userId) return;
      this.disconnect();
    }

    this.userId = userId;
    this.isDisconnecting = false;
    this.isConnecting = true;
    this.setConnectionState('reconnecting');

    window.addEventListener('online', this.handleOnline);

    const wsUrl = this.resolveGatewayUrl();
    debugLog('[GATEWAY] connecting', {
      user_id: userId,
      resumable: this.canResume && Boolean(this.sessionId),
      client_instance_id: this.clientInstanceId,
    });

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      this.isConnecting = false;
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      debugLog('Gateway connected');
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.waitingForAck = false;
      this.missedHeartbeatAcks = 0;
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

      // Auth failed — try refresh
      if (event.code === 4001 || event.code === 4003) {
        debugLog('Gateway auth failed, attempting refresh...');
        this.setConnectionState('reconnecting');
        this.cleanup();
        this.handleAuthFailure();
        return;
      }

      if (event.code === 4009) {
        debugLog('Session replaced by newer connection, reconnecting...');
        this.setConnectionState('reconnecting');
        this.invalidateSession();
        this.cleanup();
        this.scheduleReconnect();
        return;
      }

      if (event.code === 4007) {
        debugLog('[GATEWAY] session resume rejected, reconnecting with fresh identify');
        this.setConnectionState('reconnecting');
        this.invalidateSession();
        this.cleanup();
        this.scheduleReconnect();
        return;
      }

      // Mark session as resumable (normal disconnect, not auth failure)
      if (this.sessionId && this.lastSequence > 0) {
        this.canResume = true;
      }

      debugLog('[GATEWAY] closed', {
        code: event.code,
        can_resume: this.canResume,
        last_sequence: this.lastSequence,
        session_id: this.sessionId,
      });
      this.setConnectionState('reconnecting');
      this.cleanup();
      this.scheduleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('Gateway error:', error);
    };
  }

  private handleMessage(message: any) {
    const { op, t, s, d } = message;

    // Track sequence number from every EVENT
    if (op === OP.EVENT && typeof s === 'number') {
      this.lastSequence = s;
    }

    switch (op) {
      case OP.HELLO:
        this.heartbeatInterval = d.heartbeat_interval;
        this.startHeartbeat();

        // Try resume if we have a valid session, otherwise identify fresh
        if (this.canResume && this.sessionId) {
          debugLog('[GATEWAY] hello received, attempting resume', {
            session_id: this.sessionId,
            last_sequence: this.lastSequence,
          });
          this.resume();
        } else {
          debugLog('[GATEWAY] hello received, identifying fresh');
          this.identify();
        }
        break;

      case OP.HEARTBEAT_ACK:
        this.waitingForAck = false;
        this.missedHeartbeatAcks = 0;
        this.clearHeartbeatProbe();
        break;

      case OP.RESUMED:
        debugLog(`Session resumed, ${d.replayed} events replayed`);
        this.canResume = false;
        this.setConnectionState('connected');
        this.emit('RESUMED', d);
        break;

      case OP.EVENT:
        if (t === 'READY') {
          // Store session_id from READY for future resume
          if (d.session_id) {
            this.sessionId = d.session_id;
            this.canResume = false;
          }
          this.setConnectionState('connected');
          this.emit(t, d);
        } else if (t === 'TOKEN_EXPIRING') {
          this.handleTokenExpiring(d);
        } else if (t === 'SHUTDOWN') {
          debugLog(`Server shutting down, reconnecting in ${d.in / 1000}s...`);
          // Mark resumable before cleanup
          if (this.sessionId && this.lastSequence > 0) {
            this.canResume = true;
          }
          this.setConnectionState('reconnecting');
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
      debugLog('Skipping refresh - cooldown active');
      return;
    }

    if (this.isRefreshing) {
      debugLog('Skipping refresh - already in progress');
      return;
    }

    this.isRefreshing = true;
    this.lastRefreshTime = now;
    debugLog(`Token expiring in ${data.expires_in}s, refreshing...`);

    try {
      const success = await authService.refreshToken();

      if (success) {
        debugLog('Token refreshed successfully');
        this.reconnectWithNewToken();
      } else {
        console.error('Token refresh failed');
      }
    } catch (err) {
      console.error('Token refresh error:', err);
    } finally {
      this.isRefreshing = false;
    }
  }

  private async handleAuthFailure() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;

    // Auth failure means session is invalid
    this.invalidateSession();

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        debugLog(`Auth recovery attempt ${attempt}/3...`);
        const success = await authService.refreshToken();

        if (success) {
          debugLog('Token refreshed after WS auth failure, reconnecting...');
          this.isRefreshing = false;
          this.reconnectAttempts = 0;
          this.reconnectWithNewToken();
          return;
        }
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }

    debugLog('Auth recovery failed, falling back to reconnect loop...');
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
    this.lastSequence = 0;
    this.sessionId = null;
    this.canResume = false;
    debugLog('[GATEWAY] identify', {
      user_id: this.userId,
      client_instance_id: this.clientInstanceId,
    });
    this.send({
      op: OP.IDENTIFY,
      d: {
        user_id: this.userId,
        client_instance_id: this.clientInstanceId,
      },
    });
  }

  private resume() {
    debugLog('[GATEWAY] resume', {
      session_id: this.sessionId,
      last_sequence: this.lastSequence,
    });
    this.send({
      op: OP.RESUME,
      d: {
        session_id: this.sessionId,
        last_sequence: this.lastSequence,
      },
    });
  }

  private invalidateSession() {
    this.sessionId = null;
    this.lastSequence = 0;
    this.canResume = false;
  }

  private startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.waitingForAck = false;
    this.missedHeartbeatAcks = 0;

    this.heartbeatTimer = setInterval(() => {
      if (this.waitingForAck) {
        this.missedHeartbeatAcks += 1;

        if (this.missedHeartbeatAcks >= 2) {
          debugLog('[GATEWAY] missed two heartbeat ACKs, reconnecting websocket');
          this.ws?.close();
          return;
        }

        debugLog('[GATEWAY] missed heartbeat ACK, tolerating one miss before reconnect');
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

  sendRaw(data: any) {
    this.send(data);
  }

  sendEvent(event: string, data: any) {
    this.send({
      op: OP.EVENT,
      t: event,
      d: data,
    });
  }

  private cleanup() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.clearHeartbeatProbe();
    this.waitingForAck = false;
    this.missedHeartbeatAcks = 0;
  }

  private clearHeartbeatProbe() {
    if (this.heartbeatProbeTimer) {
      clearTimeout(this.heartbeatProbeTimer);
      this.heartbeatProbeTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.isDisconnecting) return;

    this.reconnectAttempts++;

    const baseDelay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    const maxJitter = baseDelay >= 30000 ? 15000 : 1000;
    const jitter = Math.random() * maxJitter;
    const delay = baseDelay + jitter;

    debugLog(`Reconnecting in ${Math.round(delay / 1000)}s... (attempt ${this.reconnectAttempts})`);

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

  resetReconnect() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (this.heartbeatProbeTimer) return;

      const probedSocket = this.ws;
      debugLog('[GATEWAY] app active, probing open websocket');
      this.waitingForAck = true;
      this.send({ op: OP.HEARTBEAT });
      this.heartbeatProbeTimer = setTimeout(() => {
        this.heartbeatProbeTimer = null;
        if (
          this.ws !== probedSocket ||
          probedSocket.readyState !== WebSocket.OPEN ||
          !this.waitingForAck
        ) {
          return;
        }

        debugLog('[GATEWAY] wake probe timed out, reconnecting for event replay');
        probedSocket.close();
      }, 5_000);
      return;
    }
    if (this.isConnecting) return;
    if (!this.userId) return;
    if (this.isDisconnecting) return;

    if (this.reconnectTimer) {
      debugLog('App focused, reconnect already scheduled');
      return;
    }

    debugLog('App focused, reconnecting immediately...');
    this.reconnectAttempts = 0;
    this.ws = null;
    this.connect(this.userId);
  }

  getConnectionState(): ConnectionState {
    return this._connectionState;
  }

  getHasEverConnected(): boolean {
    return this._hasEverConnected;
  }

  private setConnectionState(state: ConnectionState) {
    if (this._connectionState === state) return;
    this._connectionState = state;
    if (state === 'connected') this._hasEverConnected = true;
    this.emit('CONNECTION_STATE', { state });
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

    debugLog('Network back, reconnecting immediately...');

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
    this.setConnectionState('disconnected');
    this.cleanup();
    this.invalidateSession();
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
