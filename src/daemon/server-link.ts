import os from 'node:os';
import type { TimelineEvent } from './timeline-event.js';
import logger from '../util/logger.js';
import { DAEMON_VERSION } from '../util/version.js';
import { setTransportRelaySend } from './transport-relay.js';
import { setProviderRegistryServerLink } from '../agent/provider-registry.js';
import { getDefaultAckOutbox } from './ack-outbox.js';
import { getEmbeddingStatus } from '../context/embedding.js';
import type { EmbeddingStatus } from '../../shared/embedding-status.js';
import {
  P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
  P2P_WORKFLOW_CAPABILITY_V1,
  P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
  type P2pWorkflowCapability,
} from '../../shared/p2p-workflow-constants.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import { SESSION_GROUP_CLONE_CAPABILITY_V1 } from '../../shared/session-group-clone.js';

interface SystemStats {
  cpu: number;
  memUsed: number;
  memTotal: number;
  load1: number;
  load5: number;
  load15: number;
  uptime: number;
  /** Embedding pipeline + server-fallback liveness for status-bar display.
   *  Carried in every heartbeat / daemon.stats so the UI tooltip never
   *  goes stale across reconnects. See `getEmbeddingStatus` for state
   *  semantics. */
  embedding: EmbeddingStatus;
}

/** Collect lightweight system stats for daemon.stats messages. */
function collectSystemStats(): SystemStats {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const [load1, load5, load15] = os.loadavg();
  // CPU usage: approximate from load average vs CPU count
  const cpuCount = os.cpus().length;
  const cpu = Math.min(100, Math.round((load1 / cpuCount) * 100));
  return {
    cpu,
    memUsed: memTotal - memFree,
    memTotal,
    load1: +load1.toFixed(2),
    load5: +load5.toFixed(2),
    load15: +load15.toFixed(2),
    uptime: os.uptime(),
    embedding: getEmbeddingStatus(),
  };
}

const HEARTBEAT_MS = 5_000;
const STATS_MS = 5_000; // daemon.stats update interval (separate from heartbeat)
/**
 * Audit fix (94b9b837-822 / A6) — reconnect tuning.
 *
 * Previously `INITIAL_BACKOFF_MS=1_000`, `MAX_BACKOFF_MS=60_000`. A typical
 * `docker compose pull && up -d server` outage is 5-30 s — well below the
 * 60 s ceiling — but the daemon's exponential backoff (1s → 2s → 4s → 8s
 * → 16s → 32s → 60s) climbs past 30 s in five attempts, so when the
 * server came back the daemon could still be sitting in a 32-60 s wait.
 * That was the user-visible "等很久" reconnect symptom.
 *
 * Server-side `daemonConnectLimiter.check(daemon:${ip}, 5, 10_000)` in
 * `server/src/index.ts:322` allows 5 attempts per 10 s per IP, so a 500
 * ms initial / 5 s ceiling stays comfortably inside the budget while
 * cutting the worst-case "first attempt after server is back" delay
 * from 60 s to 5 s.
 */
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5_000;
/**
 * Audit fix (94b9b837-822 / A6) — explicit per-attempt connect timeout.
 *
 * `new WebSocket(url)` does not enforce a connect deadline; if the TCP
 * SYN never gets a SYN-ACK (server still pulling images, ingress
 * reconfiguring) the OS layer waits ~75 s on macOS or up to ~127 s on
 * Linux (`tcp_syn_retries=6`) before giving up. During that window
 * neither `error` nor `close` fires, so the backoff cursor doesn't
 * advance and the daemon looks frozen. 8 s is short enough to keep the
 * client responsive without aborting genuinely slow handshakes.
 */
const CONNECT_TIMEOUT_MS = 8_000;
/**
 * Audit fix (94b9b837-822 / A6) — ±20% jitter ratio on scheduled
 * reconnects. Without jitter, multiple daemons behind a single NAT or
 * the CI test cluster all retry on the same millisecond and trip the
 * server-side IP rate limiter together.
 */
const RECONNECT_JITTER_RATIO = 0.4;
const WATCHDOG_MS = 15_000;           // check connection health every 15s
const PONG_TIMEOUT_MS = 10_000;       // if no pong within 10s, connection is dead
const DAEMON_STATIC_CAPABILITIES = [
  SESSION_GROUP_CLONE_CAPABILITY_V1,
] as const;

export interface ServerLinkOpts {
  workerUrl: string;
  serverId: string;
  token: string;
}

export type MessageHandler = (msg: unknown) => void;
export type BinaryMessageHandler = (data: Buffer) => void;

export class ServerLink {
  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private binaryHandlers: BinaryMessageHandler[] = [];
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private statsTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private pongTimer?: ReturnType<typeof setTimeout>;
  /** A6 connect-timeout watchdog. Cleared on open/close/error. */
  private connectTimeoutTimer?: ReturnType<typeof setTimeout>;
  private backoffMs = INITIAL_BACKOFF_MS;
  private stopping = false;
  private reconnecting = false;
  private lastPong = 0;               // timestamp of last received message (any message counts as proof of life)
  private seq = 0;
  private readonly workerUrl: string;
  private readonly serverId: string;
  private readonly token: string;
  readonly daemonVersion = DAEMON_VERSION;
  private helloEpoch = 0;
  private lastHelloSentAt = 0;
  private p2pWorkflowCapabilities: readonly string[] = [
    P2P_WORKFLOW_CAPABILITY_V1,
    P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
    P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
  ];

  constructor(opts: ServerLinkOpts) {
    this.workerUrl = opts.workerUrl;
    this.serverId = opts.serverId;
    this.token = opts.token;
  }

  getServerId(): string {
    return this.serverId;
  }

  connect(): void {
    // Clean up previous connection if any
    this.stopHeartbeat();
    this.stopWatchdog();
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = undefined; }

    // Close previous socket before creating a new one. Without this, the
    // regular `error` / `close` → `scheduleReconnect()` → `connect()` path
    // orphans the old WebSocket: the stale-check guards (`this.ws !== ws`)
    // in the open/message/close handlers let the old WS's events drop safely,
    // but no one actually calls `close()` on it. The OS keeps the TCP socket
    // ESTAB for minutes until network timeout, and the Node WebSocket
    // instance keeps its internal buffers, TLS state, and event emitter
    // closures alive the whole time. Under reconnect flapping we observed
    // 7 parallel ESTAB connections on a single daemon which correlated with
    // the OOM cascade. `forceReconnect()` already does this; regular
    // scheduled reconnects must too.
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }

    const wsUrl = this.workerUrl.replace(/^http/, 'ws') + `/api/server/${this.serverId}/ws`;
    logger.info({ url: wsUrl }, 'ServerLink: connecting');
    this.reconnecting = false;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    // Audit fix (94b9b837-822 / A6) — kill the connect attempt after
    // CONNECT_TIMEOUT_MS so a hung TCP SYN cannot wedge the daemon
    // for 75-127 s. Cleared on any of open/close/error.
    if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);
    this.connectTimeoutTimer = setTimeout(() => {
      if (this.ws !== ws) return;
      if (ws.readyState === WebSocket.OPEN) return;
      logger.warn(
        { url: wsUrl, timeoutMs: CONNECT_TIMEOUT_MS },
        'ServerLink: connect timeout — closing socket so reconnect can proceed',
      );
      try { ws.close(); } catch { /* ignore */ }
      // close handler will schedule reconnect.
    }, CONNECT_TIMEOUT_MS);
    try { (this.connectTimeoutTimer as { unref?: () => void }).unref?.(); } catch { /* ignore */ }

    const clearConnectTimeout = () => {
      if (this.connectTimeoutTimer) {
        clearTimeout(this.connectTimeoutTimer);
        this.connectTimeoutTimer = undefined;
      }
    };

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return; // replaced before open
      clearConnectTimeout();
      logger.info('ServerLink: connected');
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.lastPong = Date.now();
      // Send auth handshake immediately — server closes the socket if this is not
      // the first message or if credentials are invalid (5s timeout enforced server-side).
      ws.send(JSON.stringify({ type: 'auth', serverId: this.serverId, token: this.token, daemonVersion: this.daemonVersion }));
      this.sendDaemonHello();
      // Wire transport relay so provider callbacks can send events to browsers via this socket.
      setTransportRelaySend((msg) => {
        try {
          this.send(msg);
        } catch {
          // Not connected — transport relay events are best-effort
        }
      });
      setProviderRegistryServerLink(this);
      this.startHeartbeat();
      this.startWatchdog();

      // Flush any acks that couldn't be sent before/during previous disconnects.
      // The outbox handles ordering, attempt caps, TTL, and isConnected() gating.
      const outbox = getDefaultAckOutbox();
      const sender = Object.assign(
        (msg: Parameters<typeof this.send>[0]) => this.send(msg),
        { isConnected: () => this.isConnected() },
      );
      outbox.flushOnReconnect(sender as never).catch((err) => {
        logger.warn({ err }, 'AckOutbox flush on reconnect failed');
      });

      // Refresh the supervisor global-defaults cache on every (re)connect so
      // user edits to "Global custom instructions" land in the daemon within
      // one WS round-trip, not next restart. See `supervisor-defaults-cache.ts`.
      void (async () => {
        try {
          const { refreshSupervisorDefaultsCache } = await import('./supervisor-defaults-cache.js');
          await refreshSupervisorDefaultsCache();
        } catch (err) {
          logger.debug({ err }, 'supervisor-defaults-cache: reconnect refresh failed');
        }
      })();
    });

    ws.addEventListener('error', (event) => {
      if (this.ws !== ws) return; // stale socket — a newer connection already took over
      clearConnectTimeout();
      logger.warn({ error: (event as ErrorEvent).message ?? 'unknown' }, 'ServerLink: error');
      // Close event *should* fire after error, but in edge cases (non-101 response,
      // DNS failure) it may not. Schedule reconnect as a safety net — scheduleReconnect()
      // is idempotent (guards with `this.reconnecting`), so no double-reconnect risk
      // when close does fire.
      if (!this.stopping) this.scheduleReconnect();
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      if (this.ws !== ws) return; // stale socket
      this.lastPong = Date.now();
      if (typeof event.data !== 'string') {
        const buffer = Buffer.isBuffer(event.data) ? event.data : Buffer.from(event.data as ArrayBuffer);
        for (const h of this.binaryHandlers) h(buffer);
        return;
      }
      try {
        const msg = JSON.parse(event.data);
        for (const h of this.handlers) h(msg);
      } catch {
        // ignore parse errors
      }
    });

    ws.addEventListener('close', (event: CloseEvent) => {
      // If this.ws has already been replaced by a newer socket (e.g. because we called
      // connect() again while this socket was still in-flight), the server will close
      // this one with 1001 "replaced" — that's expected and we must NOT reconnect,
      // otherwise the newer connection gets kicked and we loop forever.
      if (this.ws !== ws) return;
      clearConnectTimeout();
      logger.info({ code: event.code, reason: event.reason }, 'ServerLink: closed');
      this.stopHeartbeat();
      this.stopWatchdog();
      setTransportRelaySend(() => { /* disconnected — discard */ });
      if (!this.stopping) this.scheduleReconnect();
    });
  }

  send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Best-effort: silently drop messages when the link isn't up. Throwing
      // here would become an unhandled rejection in any fire-and-forget
      // caller (handleP2pConfigSave, repo-handler, command-handler, etc.)
      // since the daemon must never die from transient disconnects.
      // Callers that need delivery confirmation should check isConnected()
      // or await a response event before acting on `send()`.
      return;
    }
    this.seq++;
    this.ws.send(JSON.stringify({ ...((msg as object) ?? {}), seq: this.seq }));
  }

  updateP2pWorkflowCapabilities(capabilities: readonly (P2pWorkflowCapability | string)[]): void {
    const next = [...new Set(capabilities)].sort();
    if (
      next.length === this.p2pWorkflowCapabilities.length &&
      next.every((capability, index) => capability === this.p2pWorkflowCapabilities[index])
    ) {
      return;
    }
    this.p2pWorkflowCapabilities = next;
    this.sendDaemonHello();
  }

  getP2pWorkflowCapabilities(): readonly string[] {
    return [...this.p2pWorkflowCapabilities];
  }

  getDaemonCapabilities(): readonly string[] {
    return [...new Set([
      ...this.p2pWorkflowCapabilities,
      ...DAEMON_STATIC_CAPABILITIES,
    ])];
  }

  /**
   * Most recent `daemon.hello` epoch sent by this daemon. Bind context stores
   * this in `capabilitySnapshot.helloEpoch` so the projection records which
   * capability advertisement governed the run, instead of synthesising `0`.
   */
  getHelloEpoch(): number {
    return this.helloEpoch;
  }

  /**
   * Wall-clock timestamp (ms) of the most recent `daemon.hello`. Returns 0
   * when no hello has been sent yet (pre-`sendDaemonHello`).
   */
  getHelloSentAt(): number {
    return this.lastHelloSentAt;
  }

  private sendDaemonHello(): void {
    const sentAt = Date.now();
    this.helloEpoch++;
    this.lastHelloSentAt = sentAt;
    this.send({
      type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
      daemonId: this.serverId,
      capabilities: this.getDaemonCapabilities(),
      helloEpoch: this.helloEpoch,
      sentAt,
    });
  }

  /** Reports whether the underlying WebSocket is currently OPEN. */
  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Send a binary WebSocket frame (raw PTY data). Best-effort: no throw on disconnect. */
  sendBinary(data: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(data);
  }

  /** Send a timeline event to connected browsers via the server relay. */
  sendTimelineEvent(event: TimelineEvent): void {
    try {
      this.send({ type: 'timeline.event', event });
    } catch {
      // Not connected — timeline events are best-effort
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  onBinaryMessage(handler: BinaryMessageHandler): void {
    this.binaryHandlers.push(handler);
  }

  disconnect(): void {
    this.stopping = true;
    this.stopHeartbeat();
    this.stopWatchdog();
    if (this.pongTimer) clearTimeout(this.pongTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = undefined;
    }
    this.ws?.close();
    this.ws = null;
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'heartbeat', daemonVersion: this.daemonVersion, ...collectSystemStats() });
      }
    }, HEARTBEAT_MS);
    // Stats updates more frequently than heartbeat
    this.statsTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'daemon.stats', daemonVersion: this.daemonVersion, ...collectSystemStats() });
      }
    }, STATS_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = undefined; }
  }

  /** Watchdog: periodically verifies the connection is truly alive.
   *  If no message received within PONG_TIMEOUT after a heartbeat ping,
   *  the connection is considered dead and forcibly recycled. */
  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      if (this.stopping) return;

      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // Not connected — force reconnect if not already scheduled
        logger.warn('ServerLink watchdog: not connected, forcing reconnect');
        this.forceReconnect();
        return;
      }

      const silenceMs = Date.now() - this.lastPong;
      if (silenceMs > HEARTBEAT_MS + PONG_TIMEOUT_MS) {
        // Haven't received anything for heartbeat interval + timeout — dead connection
        logger.warn({ silenceMs }, 'ServerLink watchdog: connection silent, forcing reconnect');
        this.forceReconnect();
        return;
      }
    }, WATCHDOG_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = undefined; }
  }

  /** Kill current connection and force immediate reconnect */
  private forceReconnect(): void {
    this.stopHeartbeat();
    this.stopWatchdog();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.reconnecting = false;
    // Force-close existing socket (will trigger close event, but we handle reconnect ourselves)
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    // Reset backoff for forced reconnects — we want to come back fast
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    // Prevent double scheduling from error+close firing in sequence
    if (this.reconnecting) return;
    this.reconnecting = true;
    // Audit fix (94b9b837-822 / A6) — apply ±20% jitter to the
    // scheduled delay so multiple daemons behind one NAT don't all
    // fire on the same millisecond. `Math.max(0, …)` guards against
    // a negative jittered delay if the ratio config ever goes wild.
    const jitterMultiplier = 1 + (Math.random() - 0.5) * RECONNECT_JITTER_RATIO;
    const delayMs = Math.max(0, Math.round(this.backoffMs * jitterMultiplier));
    logger.info({ backoffMs: this.backoffMs, delayMs }, 'ServerLink: scheduling reconnect');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }, delayMs);
  }
}
