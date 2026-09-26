export interface AuthenticatedWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  on(event: 'open' | 'close' | 'error' | 'message', listener: (...args: any[]) => void): this;
}

export type AuthenticatedWebSocketFactory = (url: string) => AuthenticatedWebSocketLike;

export type AuthenticatedWebSocketLossReason =
  | 'socket_create_error'
  | 'connect_timeout'
  | 'socket_error'
  | 'socket_close'
  | 'authentication_failed'
  | 'credential_revoked'
  | 'capabilities_rejected'
  | 'manual_reconnect'
  | 'inbound_silence'
  | 'system_resume_or_clock_change';

export type AuthenticatedWebSocketDiagnostic =
  | { type: 'socket_opened' }
  | { type: 'socket_lost'; reason: AuthenticatedWebSocketLossReason }
  | { type: 'reconnect_scheduled'; delayMs: number };

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
  /** A function is evaluated per send, so each heartbeat can carry its own send time. */
  heartbeatMessage?: Record<string, unknown> | (() => Record<string, unknown>);
  /** Monotonic clock for liveness. Wall-clock corrections must not suspend it. */
  monotonicNow?: () => number;
  /** Wall clock is sampled only to detect suspend/resume and clock corrections. */
  wallNow?: () => number;
  /** Contains no URL, credential or message data and is safe for local logs. */
  onDiagnostic?: (event: AuthenticatedWebSocketDiagnostic) => void;
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
  private lastWatchdogTickAt = 0;
  private lastWatchdogWallAt = 0;

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

  /**
   * End the current socket generation and connect a fresh one.
   *
   * For state that is only ever sent when a connection authenticates. The
   * server reads a node's capabilities from its auth frame and nowhere else,
   * so a change after connecting -- components just installed, a permission
   * just granted -- is invisible until the next connection. Without a way to
   * start one, the browser kept showing the old state no matter how often the
   * operator pressed the button that had already worked.
   *
   * Goes through the ordinary loss path rather than `stop()`: that runs the
   * same once-only finalisation and reconnect a network drop would, instead of
   * the permanent shutdown `stop()` performs.
   */
  reconnect(): void {
    if (this.stopped || !this.socket) return;
    this.failSocket(this.socket, 'manual_reconnect');
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
      this.emitDiagnostic({ type: 'socket_lost', reason: 'socket_create_error' });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    const connectTimeoutMs = this.options.connectTimeoutMs ?? 20_000;
    this.connectTimer = setTimeout(() => this.failSocket(socket, 'connect_timeout'), connectTimeoutMs);
    this.connectTimer.unref?.();

    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.backoffMs = this.options.initialBackoffMs ?? 500;
      const monotonicNow = this.monotonicNow();
      this.lastInboundAt = monotonicNow;
      this.lastWatchdogTickAt = monotonicNow;
      this.lastWatchdogWallAt = this.wallNow();
      socket.send(JSON.stringify(this.options.auth));
      this.startWatchdog(socket);
      this.emitDiagnostic({ type: 'socket_opened' });
      this.options.onOpen?.();
    });
    socket.on('message', (data: unknown) => {
      if (this.socket !== socket || this.stopped) return;
      this.lastInboundAt = this.monotonicNow();
      void Promise.resolve(this.options.onMessage(data)).catch(() => {});
    });
    socket.on('error', () => this.failSocket(socket, 'socket_error'));
    socket.on('close', (code?: number) => {
      const reason: AuthenticatedWebSocketLossReason = code === 4001
        ? 'authentication_failed'
        : code === 4002
          ? 'capabilities_rejected'
          : code === 4003
            ? 'credential_revoked'
            : 'socket_close';
      this.handleSocketLoss(socket, reason);
    });
  }

  /** Finalize one socket generation exactly once and arm the next attempt. */
  private handleSocketLoss(
    socket: AuthenticatedWebSocketLike,
    reason: AuthenticatedWebSocketLossReason,
  ): boolean {
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
    this.emitDiagnostic({ type: 'socket_lost', reason });
    this.scheduleReconnect();
    return true;
  }

  /** Force a failed socket closed even when its implementation never emits close. */
  private failSocket(socket: AuthenticatedWebSocketLike, reason: AuthenticatedWebSocketLossReason): void {
    if (!this.handleSocketLoss(socket, reason)) return;
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
      const monotonicNow = this.monotonicNow();
      const wallNow = this.wallNow();
      const monotonicGap = monotonicNow - this.lastWatchdogTickAt;
      const wallGap = wallNow - this.lastWatchdogWallAt;
      this.lastWatchdogTickAt = monotonicNow;
      this.lastWatchdogWallAt = wallNow;
      // Across platforms, the monotonic clock may either advance or pause in
      // sleep. Sampling both clocks catches both forms, plus backward clock
      // corrections. Never reuse a pre-suspend TCP/TLS socket after wake.
      if (monotonicGap < 0 || wallGap < 0
        || monotonicGap >= silenceTimeoutMs || wallGap >= silenceTimeoutMs) {
        this.failSocket(socket, 'system_resume_or_clock_change');
        return;
      }
      if (monotonicNow - this.lastInboundAt >= silenceTimeoutMs) {
        this.failSocket(socket, 'inbound_silence');
        return;
      }
      if (socket.readyState === 1) {
        const heartbeat = this.options.heartbeatMessage;
        socket.send(JSON.stringify(typeof heartbeat === 'function' ? heartbeat() : heartbeat));
      }
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
    this.emitDiagnostic({ type: 'reconnect_scheduled', delayMs: delay });
    // This client is the controlled node's long-lived process owner. Once the
    // socket closes there may be no other referenced handles, so unref'ing the
    // retry timer lets Node exit cleanly before reconnecting. Keep it referenced
    // until stop() explicitly clears it.
  }

  private monotonicNow(): number {
    return this.options.monotonicNow?.() ?? performance.now();
  }

  private wallNow(): number {
    return this.options.wallNow?.() ?? Date.now();
  }

  private emitDiagnostic(event: AuthenticatedWebSocketDiagnostic): void {
    try {
      this.options.onDiagnostic?.(event);
    } catch {
      // Observability must never take ownership of transport recovery.
    }
  }
}
