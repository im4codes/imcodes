import os from 'node:os';
import { performance } from 'node:perf_hooks';
import type { TimelineEvent } from './timeline-event.js';
import logger from '../util/logger.js';
import { DAEMON_VERSION } from '../util/version.js';
import { setTransportRelaySend } from './transport-relay.js';
import { setProviderRegistryServerLink } from '../agent/provider-registry.js';
import { getDefaultAckOutbox } from './ack-outbox.js';
import { getEmbeddingStatus } from '../context/embedding.js';
import type { EmbeddingStatus } from '../../shared/embedding-status.js';
import { recordDaemonServerLinkStatus } from '../util/daemon-status.js';
import {
  P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
  P2P_WORKFLOW_CAPABILITY_V1,
  P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
  type P2pWorkflowCapability,
} from '../../shared/p2p-workflow-constants.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import { SESSION_GROUP_CLONE_CAPABILITY_V1 } from '../../shared/session-group-clone.js';
import { EXECUTION_CLONE_CAPABILITY_V1 } from '../../shared/execution-clone.js';
import { GIT_REMOTE_CLONE_CAPABILITY_V1 } from '../../shared/git-remote-url.js';
import { TIMELINE_PROTOCOL_CAPABILITY, TIMELINE_PROTOCOL_REVISION } from '../../shared/timeline-protocol.js';
import {
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
  FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
} from '../../shared/transport/file-transfer.js';
import {
  classifyServerSendPlane,
  recordServerLinkDataPlaneBackpressure,
  recordServerLinkDataPlaneStaleDropped,
  recordServerSend,
  stringifyForServerSend,
} from './latency-tracer.js';
import { getDaemonBuildInfo } from './build-info.js';

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
const DEFAULT_DATA_PLANE_SEND_QUEUE_SOFT_CAP = 256;
// Bumped from 512 → 100_000 (regression triage: commit 42dfabec used 512 +
// shift-oldest, which silently dropped timeline.history responses on weak
// links and forced users to refresh the page). 100_000 is an emergency
// ceiling, not an expected steady-state — backpressure telemetry above
// soft-cap is unchanged so ops can still see if a real backlog forms.
const DEFAULT_DATA_PLANE_SEND_QUEUE_HARD_CAP = 100_000;
// Bumped from 30s → 24h. 30s was the same regression: a brief WS hiccup
// (Wi-Fi handoff, mobile background) silently expired the queued history /
// fs / models responses before the link came back, so the reconnect flush
// found an empty queue. With "drain peek-then-shift" (below) we no longer
// rely on stale GC for correctness — this is purely a memory-protection
// upper bound for catastrophic offline periods.
const DEFAULT_DATA_PLANE_SEND_STALE_MS = 24 * 60 * 60 * 1000;
let dataPlaneSendQueueSoftCap = DEFAULT_DATA_PLANE_SEND_QUEUE_SOFT_CAP;
let dataPlaneSendQueueHardCap = DEFAULT_DATA_PLANE_SEND_QUEUE_HARD_CAP;
let dataPlaneSendStaleMs = DEFAULT_DATA_PLANE_SEND_STALE_MS;

type DataPlaneSendQueueItem = {
  msg: unknown;
  msgType?: string;
  requestId?: string;
  enqueuedAt: number;
  deadlineAt: number;
};
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
 * advance and the daemon looks frozen. The cap keeps the client
 * responsive without aborting genuinely slow handshakes.
 *
 * Raised 8s → 20s: on a heavily loaded host (e.g. big test suites on the
 * same box) the WS upgrade + the daemon dispatching its own `open` event can
 * legitimately take well over 8 s. The old 8 s cap fired mid-handshake and
 * turned local CPU pressure into a reconnect storm (each retry adds more
 * load). 20 s still bounds a truly hung SYN.
 */
const CONNECT_TIMEOUT_MS = 20_000;
/**
 * Audit fix (94b9b837-822 / A6) — ±20% jitter ratio on scheduled
 * reconnects. Without jitter, multiple daemons behind a single NAT or
 * the CI test cluster all retry on the same millisecond and trip the
 * server-side IP rate limiter together.
 */
const RECONNECT_JITTER_RATIO = 0.4;
const WATCHDOG_MS = 10_000;           // check connection health every 10s
// Lowered 120s → 30s (STOP-delivery fix). On a half-open/dead link the SERVER
// still believes the daemon is connected and keeps forwarding control commands
// (STOP, approvals, feedback) into a socket the daemon can no longer read — they
// are silently lost until this recycle reconnects. At 120s that was up to a
// 2-minute window where STOP "had no effect / no reaction" (front-end shows its
// optimistic flicker, the agent never receives it). Heartbeats run every 5s and
// a healthy server acks each one, so ~30s of total inbound silence (≈6 missed
// acks) reliably means a dead link. The event-loop-stall guard in
// getOpenSocketSilenceMs() still prevents this from false-reconnecting a healthy
// socket during the daemon's own load spikes (it reports 0 silence then).
const SILENT_CONNECTION_RECYCLE_MS = 30_000;
// Event-loop stall guard. Under heavy local load the daemon's event loop can
// freeze for tens of seconds. The silence-based reconnects measure
// `now - lastPong`, which during a freeze blames the SERVER for the daemon's
// own inability to READ inbound frames — force-reconnecting then drops a
// healthy socket and the reconnect (TLS + auth + resubscribe) piles more load
// on the already-stalled box. A lightweight 1 s probe detects the freeze so the
// silence checks stand down until inbound can actually be read again.
const LOOP_PROBE_MS = 1_000;
const EVENT_LOOP_STALL_THRESHOLD_MS = 3_000; // probe overdue by >3 s ⇒ loop stalled

/**
 * Invoked (async, best-effort) after every successful RE-connect so the session
 * layer can re-broadcast authoritative per-session state that live control-plane
 * relays dropped while the link was down. Registered from daemon startup
 * (lifecycle) to avoid a server-link → session-manager import cycle.
 */
let serverLinkReconnectResyncHandler: (() => void) | null = null;
export function setServerLinkReconnectResyncHandler(handler: (() => void) | null): void {
  serverLinkReconnectResyncHandler = handler;
}
const DAEMON_STATIC_CAPABILITIES = [
  SESSION_GROUP_CLONE_CAPABILITY_V1,
  // Distinct from session-group-clone — gates the dedicated execution-clone
  // MCP send/destroy path (managed ephemeral clones). The two features version
  // and negotiate independently.
  EXECUTION_CLONE_CAPABILITY_V1,
  GIT_REMOTE_CLONE_CAPABILITY_V1,
  TIMELINE_PROTOCOL_CAPABILITY,
  FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
  FILE_TRANSFER_DOWNLOAD_STREAM_CAPABILITY,
] as const;

/**
 * Whether `cap` is part of the daemon's static capability advertisement
 * (`DAEMON_STATIC_CAPABILITIES`). This is the single source of truth consulted
 * by the production stdio memory MCP server so the execution-clone send/destroy
 * gate reflects what the daemon actually advertises to the server instead of
 * defaulting to enabled. Dynamic (P2P-workflow) capabilities are NOT included
 * here — they are negotiated separately and not part of the static set.
 */
export function isDaemonCapabilityAdvertised(cap: string): boolean {
  return (DAEMON_STATIC_CAPABILITIES as readonly string[]).includes(cap);
}

export interface ServerLinkOpts {
  workerUrl: string;
  serverId: string;
  token: string;
}

export type MessageHandler = (msg: unknown) => void;
export type BinaryMessageHandler = (data: Buffer) => void;

async function toWebSocketBinaryBuffer(data: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof (data as Blob).arrayBuffer === 'function') {
    return Buffer.from(await (data as Blob).arrayBuffer());
  }
  return Buffer.from(data as ArrayBuffer);
}

function messageTypeOf(msg: unknown): string | undefined {
  return typeof (msg as { type?: unknown })?.type === 'string'
    ? (msg as { type: string }).type
    : undefined;
}

function requestIdOf(msg: unknown): string | undefined {
  return typeof (msg as { requestId?: unknown })?.requestId === 'string'
    ? (msg as { requestId: string }).requestId
    : undefined;
}

export function __setServerLinkDataPlaneQueueConfigForTests(options: {
  softCap?: number;
  hardCap?: number;
  staleMs?: number;
} | null): void {
  if (!options) {
    dataPlaneSendQueueSoftCap = DEFAULT_DATA_PLANE_SEND_QUEUE_SOFT_CAP;
    dataPlaneSendQueueHardCap = DEFAULT_DATA_PLANE_SEND_QUEUE_HARD_CAP;
    dataPlaneSendStaleMs = DEFAULT_DATA_PLANE_SEND_STALE_MS;
    return;
  }
  dataPlaneSendQueueSoftCap = Math.max(0, Math.trunc(options.softCap ?? DEFAULT_DATA_PLANE_SEND_QUEUE_SOFT_CAP));
  dataPlaneSendQueueHardCap = Math.max(
    Math.max(1, dataPlaneSendQueueSoftCap),
    Math.trunc(options.hardCap ?? DEFAULT_DATA_PLANE_SEND_QUEUE_HARD_CAP),
  );
  dataPlaneSendStaleMs = Math.max(0, Math.trunc(options.staleMs ?? DEFAULT_DATA_PLANE_SEND_STALE_MS));
}

export class ServerLink {
  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private binaryHandlers: BinaryMessageHandler[] = [];
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private statsTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private loopProbeTimer?: ReturnType<typeof setInterval>;
  /** Wall-clock of the last event-loop probe tick; 0 when not running. */
  private lastLoopProbeAt = 0;
  private pongTimer?: ReturnType<typeof setTimeout>;
  /** A6 connect-timeout watchdog. Cleared on open/close/error. */
  private connectTimeoutTimer?: ReturnType<typeof setTimeout>;
  private backoffMs = INITIAL_BACKOFF_MS;
  private stopping = false;
  private reconnecting = false;
  /** True once this link has completed at least one successful open. Gates the
   *  reconnect state-resync so a daemon's FIRST connect (startup already runs
   *  its own full session sync) does not double-broadcast. */
  private hadConnectedBefore = false;
  private lastPong = 0;               // timestamp of last received message (any message counts as proof of life)
  private seq = 0;
  private readonly workerUrl: string;
  private readonly serverId: string;
  private readonly token: string;
  readonly daemonVersion = DAEMON_VERSION;
  private helloEpoch = 0;
  private lastHelloSentAt = 0;
  private sendBacklogStartedAt: number | null = null;
  private dataPlaneSendQueue: DataPlaneSendQueueItem[] = [];
  private dataPlaneSendScheduled = false;
  private dataPlaneQueueStartedAt: number | null = null;
  private p2pWorkflowCapabilities: readonly string[] = [
    P2P_WORKFLOW_CAPABILITY_V1,
    P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
    P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
  ];
  private lastRuntimeLinkStatusWriteAt = 0;

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
    this.recordRuntimeLinkStatus({ state: 'connecting', workerUrl: this.workerUrl, serverId: this.serverId });
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
      this.recordRuntimeLinkStatus({
        state: 'connected',
        workerUrl: this.workerUrl,
        serverId: this.serverId,
        lastConnectedAt: this.lastPong,
        clearError: true,
      });
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
        (msg: Parameters<typeof this.send>[0]) => this.trySend(msg),
        { isConnected: () => this.isConnected() },
      );
      outbox.flushOnReconnect(sender).catch((err) => {
        logger.warn({ err }, 'AckOutbox flush on reconnect failed');
      });

      // Resume the data-plane drain after reconnect. Anything that piled up
      // in `dataPlaneSendQueue` while the link was down is now safe to send
      // because the new socket is OPEN. Without this kick the queue would
      // sit there until the next enqueue happened to schedule another flush.
      this.flushDataPlaneAfterReconnect();

      // Control-plane messages (live timeline events, incl. the authoritative
      // `session.state: idle`) are DROPPED by trySend while the socket is not
      // OPEN — there is no queue or replay for them. A turn that settles inside
      // an outage window therefore leaves the server and every browser showing
      // "working" forever. On every RE-connect, let the session layer
      // re-broadcast each transport session's current authoritative state so
      // the lost snapshot heals within one round-trip.
      if (this.hadConnectedBefore && serverLinkReconnectResyncHandler) {
        const handler = serverLinkReconnectResyncHandler;
        setImmediate(() => {
          try {
            handler();
          } catch (err) {
            logger.warn({ err }, 'ServerLink: reconnect state resync handler failed');
          }
        });
      }
      this.hadConnectedBefore = true;

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
      const errorMessage = (event as ErrorEvent).message ?? 'unknown';
      logger.warn({ error: errorMessage }, 'ServerLink: error');
      this.recordRuntimeLinkStatus({
        state: 'disconnected',
        lastDisconnectedAt: Date.now(),
        lastError: errorMessage,
      });
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
        void (async () => {
          const buffer = await toWebSocketBinaryBuffer(event.data);
          if (this.ws !== ws) return; // stale socket after async Blob read
          for (const h of this.binaryHandlers) h(buffer);
        })().catch((err) => {
          logger.warn({ err }, 'ServerLink: binary message decode failed');
        });
        return;
      }
      try {
        const msg = JSON.parse(event.data);
        if (msg?.type === 'heartbeat_ack') {
          // Heartbeat acks are the CLI/status proof-of-life source. They must
          // not be throttled behind a just-written heartbeat-sent record, or
          // the runtime file can report a false stale link while acks are
          // arriving normally.
          this.recordRuntimeLinkStatus({
            state: 'connected',
            lastHeartbeatAckAt: this.lastPong,
            clearError: true,
          });
        }
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
      this.recordRuntimeLinkStatus({
        state: 'disconnected',
        lastDisconnectedAt: Date.now(),
        lastError: event.reason || `closed:${event.code}`,
      });
      this.stopHeartbeat();
      this.stopWatchdog();
      setTransportRelaySend(() => { /* disconnected — discard */ });
      if (!this.stopping) this.scheduleReconnect();
    });
  }

  send(msg: unknown): void {
    if (this.shouldDeferDataPlaneSend(msg)) {
      this.enqueueDataPlaneSend(msg);
      this.scheduleDataPlaneFlush();
      return;
    }
    this.trySend(msg);
  }

  trySend(msg: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Best-effort: silently drop messages when the link isn't up. Throwing
      // here would become an unhandled rejection in any fire-and-forget
      // caller (handleP2pConfigSave, repo-handler, command-handler, etc.)
      // since the daemon must never die from transient disconnects.
      // Callers that need delivery confirmation should check isConnected()
      // or await a response event before acting on `send()`.
      return false;
    }
    try {
      this.seq++;
      const serialized = stringifyForServerSend(msg, this.seq);
      const bufferedAmountBefore = typeof this.ws.bufferedAmount === 'number' ? this.ws.bufferedAmount : undefined;
      const sendStart = performance.now();
      const sendBacklogAgeMs = this.updateSendBacklogAge(bufferedAmountBefore, sendStart);
      const outboundQueueDepth = this.dataPlaneSendQueue.length;
      const outboundQueueAgeMs = this.dataPlaneQueueStartedAt === null ? 0 : sendStart - this.dataPlaneQueueStartedAt;
      this.ws.send(serialized.payload);
      const bufferedAmountAfter = typeof this.ws.bufferedAmount === 'number' ? this.ws.bufferedAmount : undefined;
      if ((bufferedAmountAfter ?? 0) > 0 && this.sendBacklogStartedAt === null) {
        this.sendBacklogStartedAt = sendStart;
      } else if ((bufferedAmountAfter ?? 0) === 0) {
        this.sendBacklogStartedAt = null;
      }
      recordServerSend({
        msgType: serialized.msgType,
        commandId: serialized.commandId,
        jsonBytes: serialized.jsonBytes,
        stringifyMs: serialized.stringifyMs,
        wsSendMs: performance.now() - sendStart,
        bufferedAmountBefore,
        bufferedAmountAfter,
        sendBacklogAgeMs,
        outboundQueueDepth,
        outboundQueueAgeMs,
        recipientCount: 1,
        success: true,
      });
      return true;
    } catch (err) {
      recordServerSend({
        msgType: typeof (msg as { type?: unknown })?.type === 'string' ? (msg as { type: string }).type : undefined,
        commandId: typeof (msg as { commandId?: unknown })?.commandId === 'string' ? (msg as { commandId: string }).commandId : undefined,
        jsonBytes: 0,
        stringifyMs: 0,
        wsSendMs: 0,
        bufferedAmountBefore: undefined,
        bufferedAmountAfter: undefined,
        sendBacklogAgeMs: undefined,
        outboundQueueDepth: this.dataPlaneSendQueue.length,
        outboundQueueAgeMs: this.dataPlaneQueueStartedAt === null ? 0 : performance.now() - this.dataPlaneQueueStartedAt,
        recipientCount: 1,
        success: false,
      });
      logger.warn({ err }, 'ServerLink: send failed');
      return false;
    }
  }

  private updateSendBacklogAge(bufferedAmountBefore: number | undefined, now: number): number | undefined {
    if (bufferedAmountBefore === undefined) return undefined;
    if (bufferedAmountBefore <= 0) return 0;
    this.sendBacklogStartedAt ??= now;
    return now - this.sendBacklogStartedAt;
  }

  private shouldDeferDataPlaneSend(msg: unknown): boolean {
    const msgType = messageTypeOf(msg);
    return classifyServerSendPlane(msgType) === 'data';
  }

  private enqueueDataPlaneSend(msg: unknown): void {
    const now = performance.now();
    const msgType = messageTypeOf(msg);
    const requestId = requestIdOf(msg);
    this.dropExpiredDataPlaneSendItems(now, 'enqueue_stale');
    if (this.dataPlaneSendQueue.length >= dataPlaneSendQueueSoftCap) {
      const overflow = Math.max(0, this.dataPlaneSendQueue.length - dataPlaneSendQueueSoftCap + 1);
      recordServerLinkDataPlaneBackpressure({
        msgType,
        requestId,
        queueDepth: this.dataPlaneSendQueue.length,
        softCap: dataPlaneSendQueueSoftCap,
        hardCap: dataPlaneSendQueueHardCap,
        overflow,
      });
      logger.warn({
        msgType,
        requestId,
        overflow,
        queueDepth: this.dataPlaneSendQueue.length,
        softCap: dataPlaneSendQueueSoftCap,
        hardCap: dataPlaneSendQueueHardCap,
      }, 'ServerLink: data-plane queue backpressure');
    }
    if (this.dataPlaneSendQueue.length >= dataPlaneSendQueueHardCap) {
      const dropped = this.dataPlaneSendQueue.shift();
      this.recordDataPlaneSendItemDropped(dropped, now, 'hard_cap_drop_oldest');
      this.dataPlaneQueueStartedAt = this.dataPlaneSendQueue[0]?.enqueuedAt ?? null;
    }
    this.dataPlaneSendQueue.push({
      msg,
      msgType,
      requestId,
      enqueuedAt: now,
      deadlineAt: now + dataPlaneSendStaleMs,
    });
    this.dataPlaneQueueStartedAt ??= now;
  }

  private dropExpiredDataPlaneSendItems(now: number, reason: string): void {
    if (this.dataPlaneSendQueue.length === 0) return;
    const live: DataPlaneSendQueueItem[] = [];
    for (const item of this.dataPlaneSendQueue) {
      if (item.deadlineAt <= now) this.recordDataPlaneSendItemDropped(item, now, reason);
      else live.push(item);
    }
    if (live.length === this.dataPlaneSendQueue.length) return;
    this.dataPlaneSendQueue = live;
    this.dataPlaneQueueStartedAt = this.dataPlaneSendQueue[0]?.enqueuedAt ?? null;
  }

  private recordDataPlaneSendItemDropped(item: DataPlaneSendQueueItem | undefined, now: number, reason: string): void {
    if (!item) return;
    const ageMs = Math.max(0, now - item.enqueuedAt);
    recordServerLinkDataPlaneStaleDropped({
      msgType: item.msgType,
      requestId: item.requestId,
      reason,
      ageMs,
      staleMs: dataPlaneSendStaleMs,
      queueDepth: this.dataPlaneSendQueue.length,
    });
    logger.warn({
      msgType: item.msgType,
      requestId: item.requestId,
      reason,
      ageMs,
      staleMs: dataPlaneSendStaleMs,
      queueDepth: this.dataPlaneSendQueue.length,
    }, 'ServerLink: dropped stale data-plane send');
  }

  /** True if the underlying socket is in a state where `trySend` is expected
   *  to succeed. Used by the drain loop so we never `shift()` a message off
   *  the queue when the link is disconnected — that would silently drop the
   *  message because `trySend` returns false without enqueuing for retry.
   *  See regression triage for commit 42dfabec ("必须手动刷新页面才更新"). */
  private isLinkSendable(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Public hook for the WS `open` handler to kick the data-plane drain
   *  after reconnect. Without this, anything that piled up in the queue
   *  during the disconnect window would never be flushed. */
  flushDataPlaneAfterReconnect(): void {
    if (this.dataPlaneSendQueue.length === 0) return;
    this.scheduleDataPlaneFlush();
  }

  private scheduleDataPlaneFlush(): void {
    if (this.dataPlaneSendScheduled) return;
    this.dataPlaneSendScheduled = true;
    setImmediate(() => {
      this.dataPlaneSendScheduled = false;
      const now = performance.now();
      this.dropExpiredDataPlaneSendItems(now, 'drain_stale');
      // Peek-then-shift: never remove an item from the queue while the link
      // is down. With the old code (`shift()` followed by `trySend()` whose
      // false return was ignored) every message that happened to be at the
      // head of the queue when the WS went non-OPEN was silently lost. The
      // user-visible result was "messages stopped updating" until a manual
      // page refresh re-issued the request. Now: if the link isn't OPEN we
      // leave the queue intact and let `flushDataPlaneAfterReconnect()` (or
      // a subsequent enqueue) restart the drain.
      const item = this.dataPlaneSendQueue[0];
      if (item === undefined) {
        this.dataPlaneQueueStartedAt = null;
        return;
      }
      if (item.deadlineAt <= now) {
        this.dataPlaneSendQueue.shift();
        this.recordDataPlaneSendItemDropped(item, now, 'drain_stale');
      } else if (!this.isLinkSendable()) {
        // Stop the drain and wait for reconnect. Telemetry only — no drop.
        recordServerLinkDataPlaneBackpressure({
          msgType: item.msgType,
          requestId: item.requestId,
          queueDepth: this.dataPlaneSendQueue.length,
          softCap: dataPlaneSendQueueSoftCap,
          hardCap: dataPlaneSendQueueHardCap,
          overflow: 0,
        });
        this.dataPlaneQueueStartedAt = this.dataPlaneSendQueue[0]?.enqueuedAt ?? null;
        return;
      } else {
        const ok = this.trySend(item.msg);
        if (!ok) {
          // trySend failed despite the readyState check (race with close, or
          // a synchronous throw from `ws.send`). Keep the item and back off
          // — the WS close handler will eventually clear the socket and
          // `flushDataPlaneAfterReconnect()` will retry once it's back up.
          this.dataPlaneQueueStartedAt = this.dataPlaneSendQueue[0]?.enqueuedAt ?? null;
          return;
        }
        this.dataPlaneSendQueue.shift();
      }
      if (this.dataPlaneSendQueue.length === 0) {
        this.dataPlaneQueueStartedAt = null;
        return;
      }
      this.dataPlaneQueueStartedAt = this.dataPlaneSendQueue[0]?.enqueuedAt ?? null;
      this.scheduleDataPlaneFlush();
    });
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
      timelineProtocolCapability: TIMELINE_PROTOCOL_CAPABILITY,
      timelineProtocolRevision: TIMELINE_PROTOCOL_REVISION,
      buildInfo: getDaemonBuildInfo() ?? undefined,
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
    this.trySendBinary(data);
  }

  trySendBinary(data: Buffer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      // TS7 models WebSocket BufferSource with an ArrayBuffer-backed view,
      // while Node's Buffer may also be backed by SharedArrayBuffer. Materialize
      // a plain Uint8Array so both runtimes and the native compiler agree.
      this.ws.send(Uint8Array.from(data));
      return true;
    } catch (err) {
      logger.warn({ err }, 'ServerLink: binary send failed');
      return false;
    }
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
    // Runs for the lifetime of a connection so silence checks can tell a real
    // server outage from the daemon's own event-loop stalls.
    this.startLoopProbe();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const now = Date.now();
        const silenceMs = this.getOpenSocketSilenceMs(now);
        if (silenceMs > SILENT_CONNECTION_RECYCLE_MS) {
          this.recycleSilentConnection('heartbeat_silent_connection', silenceMs);
          return;
        }
        const sent = this.trySend({ type: 'heartbeat', daemonVersion: this.daemonVersion, ...collectSystemStats() });
        this.recordRuntimeLinkStatus({
          state: sent ? 'connected' : 'disconnected',
          lastHeartbeatSentAt: now,
          ...(sent ? {} : { lastSendFailedAt: now, lastError: 'heartbeat_send_failed' }),
        }, 10_000);
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
    this.stopLoopProbe();
  }

  /** Watchdog: periodically verifies the connection is truly alive.
   *  A short missed-ack window is tolerated because the worker can update
   *  heartbeat state without returning a timely heartbeat_ack under load. */
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

      // Use the stall-aware silence (returns 0 during/just-after a local
      // event-loop freeze) so a busy daemon doesn't force-reconnect a healthy
      // socket it simply couldn't read from.
      const silenceMs = this.getOpenSocketSilenceMs();
      if (silenceMs > SILENT_CONNECTION_RECYCLE_MS) {
        // Haven't received anything for heartbeat interval + timeout — dead connection
        logger.warn({ silenceMs }, 'ServerLink watchdog: connection silent, forcing reconnect');
        this.forceReconnect('watchdog_silent_connection');
        return;
      }
    }, WATCHDOG_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = undefined; }
  }

  private getOpenSocketSilenceMs(now = Date.now()): number {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return 0;
    if (this.lastPong <= 0) return 0;
    // If the event-loop probe is itself overdue, the daemon is mid- or
    // just-out-of a local stall and could not read inbound frames — the
    // silence is ours, not the server's. Report none so the silence-based
    // reconnects stand down; the probe resets `lastPong` on recovery, so
    // genuine server silence is still caught on the next clean interval.
    if (this.lastLoopProbeAt > 0 && now - this.lastLoopProbeAt > LOOP_PROBE_MS + EVENT_LOOP_STALL_THRESHOLD_MS) {
      return 0;
    }
    return Math.max(0, now - this.lastPong);
  }

  /** Lightweight ticker that detects event-loop freezes (see LOOP_PROBE_MS). */
  private startLoopProbe(): void {
    this.stopLoopProbe();
    this.lastLoopProbeAt = Date.now();
    this.loopProbeTimer = setInterval(() => {
      const now = Date.now();
      const prev = this.lastLoopProbeAt;
      this.lastLoopProbeAt = now;
      if (prev <= 0) return;
      const drift = now - prev - LOOP_PROBE_MS;
      if (drift > EVENT_LOOP_STALL_THRESHOLD_MS && this.lastPong > 0) {
        // The loop was frozen for ~drift ms; inbound couldn't be read. Don't let
        // that window count as server silence — reset the proof baseline so the
        // next interval judges fresh, post-recovery liveness instead of
        // force-reconnecting a healthy socket.
        this.lastPong = now;
        logger.warn({ driftMs: drift }, 'ServerLink: event-loop stall detected — deferring silence-based reconnect');
      }
    }, LOOP_PROBE_MS);
    try { (this.loopProbeTimer as { unref?: () => void }).unref?.(); } catch { /* ignore */ }
  }

  private stopLoopProbe(): void {
    if (this.loopProbeTimer) { clearInterval(this.loopProbeTimer); this.loopProbeTimer = undefined; }
    this.lastLoopProbeAt = 0;
  }

  private recycleSilentConnection(reason: string, silenceMs: number): void {
    logger.warn({ silenceMs, reason }, 'ServerLink: open socket has no inbound proof, forcing reconnect');
    this.forceReconnect(reason);
  }

  /** Kill current connection and force immediate reconnect */
  private forceReconnect(reason = 'watchdog_forced_reconnect'): void {
    this.stopHeartbeat();
    this.stopWatchdog();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    this.reconnecting = false;
    // Force-close existing socket (will trigger close event, but we handle reconnect ourselves)
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.recordRuntimeLinkStatus({
      state: 'disconnected',
      lastDisconnectedAt: Date.now(),
      lastError: reason,
    });
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

  private recordRuntimeLinkStatus(
    update: Parameters<typeof recordDaemonServerLinkStatus>[0],
    minIntervalMs = 0,
  ): void {
    const now = update.nowMs ?? Date.now();
    if (minIntervalMs > 0 && now - this.lastRuntimeLinkStatusWriteAt < minIntervalMs) return;
    this.lastRuntimeLinkStatusWriteAt = now;
    recordDaemonServerLinkStatus({
      ...update,
      nowMs: now,
      version: this.daemonVersion,
      workerUrl: update.workerUrl ?? this.workerUrl,
      serverId: update.serverId ?? this.serverId,
    });
  }
}
