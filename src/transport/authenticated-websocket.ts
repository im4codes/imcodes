export interface AuthenticatedWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  on(event: 'open' | 'close' | 'error' | 'message', listener: (...args: any[]) => void): this;
}

export type AuthenticatedWebSocketFactory = (url: string) => AuthenticatedWebSocketLike;

export interface AuthenticatedWebSocketOptions {
  url: string;
  auth: Record<string, unknown>;
  createSocket: AuthenticatedWebSocketFactory;
  onMessage: (data: unknown) => void | Promise<void>;
  onOpen?: () => void;
  onClose?: () => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  connectTimeoutMs?: number;
  heartbeatMs?: number;
  silenceTimeoutMs?: number;
  heartbeatMessage?: Record<string, unknown>;
}

/** Minimal authenticated reconnecting transport shared by thin clients. */
export class AuthenticatedWebSocketClient {
  private socket: AuthenticatedWebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private backoffMs: number;
  private lastInboundAt = 0;

  constructor(private readonly options: AuthenticatedWebSocketOptions) {
    this.backoffMs = options.initialBackoffMs ?? 500;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.watchdogTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'client_stopped');
    // The close listener intentionally ignores a socket once stop() clears its
    // identity, so invoke lifecycle cleanup here exactly once as well.
    this.options.onClose?.();
  }

  send(message: unknown): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: AuthenticatedWebSocketLike;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    const connectTimeoutMs = this.options.connectTimeoutMs ?? 20_000;
    this.connectTimer = setTimeout(() => this.failSocket(socket), connectTimeoutMs);
    this.connectTimer.unref?.();

    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.backoffMs = this.options.initialBackoffMs ?? 500;
      this.lastInboundAt = Date.now();
      socket.send(JSON.stringify(this.options.auth));
      this.startWatchdog(socket);
      this.options.onOpen?.();
    });
    socket.on('message', (data: unknown) => {
      if (this.socket !== socket || this.stopped) return;
      this.lastInboundAt = Date.now();
      void Promise.resolve(this.options.onMessage(data)).catch(() => {});
    });
    socket.on('error', () => this.failSocket(socket));
    socket.on('close', () => {
      this.handleSocketLoss(socket);
    });
  }

  /** Finalize one socket generation exactly once and arm the next attempt. */
  private handleSocketLoss(socket: AuthenticatedWebSocketLike): boolean {
    if (this.socket !== socket) return false;
    this.socket = null;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    try {
      this.options.onClose?.();
    } catch {
      // A lifecycle observer must not disable the reconnect owner.
    }
    this.scheduleReconnect();
    return true;
  }

  /** Force a failed socket closed even when its implementation never emits close. */
  private failSocket(socket: AuthenticatedWebSocketLike): void {
    if (!this.handleSocketLoss(socket)) return;
    try {
      if (socket.terminate) socket.terminate();
      else socket.close();
    } catch {
      // Reconnect was already scheduled by handleSocketLoss().
    }
  }

  private startWatchdog(socket: AuthenticatedWebSocketLike): void {
    if (!this.options.heartbeatMessage) return;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    const heartbeatMs = this.options.heartbeatMs ?? 5_000;
    const silenceTimeoutMs = this.options.silenceTimeoutMs ?? 30_000;
    this.watchdogTimer = setInterval(() => {
      if (this.socket !== socket || this.stopped) return;
      if (Date.now() - this.lastInboundAt >= silenceTimeoutMs) {
        this.failSocket(socket);
        return;
      }
      if (socket.readyState === 1) socket.send(JSON.stringify(this.options.heartbeatMessage));
    }, heartbeatMs);
    this.watchdogTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 5_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // This client is the controlled node's long-lived process owner. Once the
    // socket closes there may be no other referenced handles, so unref'ing the
    // retry timer lets Node exit cleanly before reconnecting. Keep it referenced
    // until stop() explicitly clears it.
  }
}
