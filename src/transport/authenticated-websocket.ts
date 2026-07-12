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
  }

  send(message: unknown): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = this.options.createSocket(this.options.url);
    this.socket = socket;
    const connectTimeoutMs = this.options.connectTimeoutMs ?? 20_000;
    this.connectTimer = setTimeout(() => socket.terminate?.() ?? socket.close(4000, 'connect_timeout'), connectTimeoutMs);
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
    socket.on('error', () => {
      // close is authoritative and schedules the retry.
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.watchdogTimer) clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.options.onClose?.();
      this.scheduleReconnect();
    });
  }

  private startWatchdog(socket: AuthenticatedWebSocketLike): void {
    if (!this.options.heartbeatMessage) return;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    const heartbeatMs = this.options.heartbeatMs ?? 5_000;
    const silenceTimeoutMs = this.options.silenceTimeoutMs ?? 30_000;
    this.watchdogTimer = setInterval(() => {
      if (this.socket !== socket || this.stopped) return;
      if (Date.now() - this.lastInboundAt >= silenceTimeoutMs) {
        if (socket.terminate) socket.terminate();
        else socket.close(4001, 'inbound_silence');
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
    this.reconnectTimer.unref?.();
  }
}
