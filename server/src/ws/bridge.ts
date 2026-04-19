/**
 * WsBridge: per-server WebSocket bridge between daemon and browser clients.
 * Replaces the CF DaemonBridge Durable Object.
 *
 * Binary routing: daemon binary raw frames are routed only to browsers
 * subscribed to the target session in raw mode (not broadcast). Subscription
 * state is tracked by intercepting terminal.subscribe/unsubscribe browser
 * messages.
 *
 * Per-(session,browser) forwarding queue: text snapshot frames and binary raw
 * frames share a single queue for ordered delivery. Overflow (512KB) triggers
 * terminal.stream_reset and unsubscribes the browser from that session.
 */

import WebSocket from 'ws';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { MemoryRateLimiter } from './rate-limiter.js';
import { sha256Hex } from '../security/crypto.js';
import { DAEMON_MSG } from '../../../shared/daemon-events.js';
import { REPO_RELAY_TYPES } from '../../../shared/repo-types.js';
import { TRANSPORT_RELAY_TYPES, TRANSPORT_MSG } from '../../../shared/transport-events.js';
import {
  MSG_COMMAND_ACK,
  MSG_COMMAND_FAILED,
  MSG_DAEMON_ONLINE,
  MSG_DAEMON_OFFLINE,
  ACK_FAILURE_DAEMON_OFFLINE,
  ACK_FAILURE_ACK_TIMEOUT,
  RECONNECT_GRACE_MS,
  ACK_TIMEOUT_MS,
  ACK_DEDUP_TTL_MS,
  INFLIGHT_GC_TTL_MS,
  type AckFailureReason,
} from '../../../shared/ack-protocol.js';
import {
  PREVIEW_BINARY_FRAME,
  PREVIEW_ERROR,
  PREVIEW_LIMITS,
  PREVIEW_MSG,
  PREVIEW_TERMINAL_OUTCOME,
  packPreviewBinaryFrame,
  packPreviewWsFrame,
  parsePreviewBinaryFrame,
  parsePreviewWsFrame,
  type PreviewErrorMessage,
  type PreviewResponseStartMessage,
  type PreviewWsCloseMessage,
  type PreviewWsErrorMessage,
  type PreviewWsOpenedMessage,
} from '../../../shared/preview-types.js';
import { LocalWebPreviewRegistry } from '../preview/registry.js';
import { updateServerHeartbeat, updateServerStatus, upsertDiscussion, insertDiscussionRound, createSubSession, updateSubSession, upsertOrchestrationRun, updateProviderStatus, clearProviderStatus, updateProviderRemoteSessions } from '../db/queries.js';
import logger from '../util/logger.js';
import { pickReadableSessionDisplay } from '../../../shared/session-display.js';
import { isKnownTestSessionLike } from '../../../shared/test-session-guard.js';

const AUTH_TIMEOUT_MS = 5000;
const MAX_QUEUE_SIZE = 100;
const MAX_BROWSER_PAYLOAD = 65536; // 64KB (subsession.rebuild_all can include many sessions)
const BROWSER_RATE_LIMIT = 120;   // messages (desktop with pinned panels sends 30+ on init)
const BROWSER_RATE_WINDOW = 10_000; // 10s
const QUEUE_MAX_BYTES = 1024 * 1024; // 1MB per (session, browser) — increased from 512KB to reduce stream_reset cascades

/**
 * Safe ws.send: checks readyState, wraps in try/catch.
 * Returns true if sent, false if socket not open or send threw.
 * Calls onFail() if the send could not be delivered.
 */
function safeSend(ws: WebSocket, data: string | Buffer, onComplete?: (err?: Error) => void): boolean {
  if (ws.readyState !== WebSocket.OPEN) {
    onComplete?.(new Error('not open'));
    return false;
  }
  try {
    ws.send(data, { binary: Buffer.isBuffer(data) }, (err) => {
      onComplete?.(err);
    });
    return true;
  } catch (e) {
    onComplete?.(e instanceof Error ? e : new Error(String(e)));
    return false;
  }
}

/** Message types allowed to be forwarded from browser → daemon */
// Browser→daemon message filtering: auth + rate-limit + payload-size are the real
// security boundaries. The daemon command-handler ignores unknown types via its
// switch default. No whitelist needed — it only caused silent message drops when
// new features were added to the daemon but not mirrored here.

// ── Terminal forwarding queue (per (session, browser)) ────────────────────────

/**
 * Per-(session, browser) forwarding queue.
 * Tracks in-flight bytes via ws.send() callbacks.
 * On overflow, triggers the provided overflow handler (send reset, unsubscribe).
 */
class TerminalForwardQueue {
  private bufferedBytes = 0;

  send(ws: WebSocket, data: string | Buffer, onOverflow: () => void): void {
    const size = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
    this.bufferedBytes += size;

    if (this.bufferedBytes > QUEUE_MAX_BYTES) {
      this.bufferedBytes -= size;
      onOverflow();
      return;
    }

    safeSend(ws, data, (err) => {
      this.bufferedBytes -= size;
      if (err) {
        // Socket closed or errored — treat as overflow to trigger cleanup
        onOverflow();
      }
    });
  }
}

// ── Parse session name from binary frame header ───────────────────────────────

/**
 * Parse session name from binary frame v1 header.
 * Returns null if the frame is malformed.
 */
function parseRawFrameSession(data: Buffer): string | null {
  if (data.length < 3 || data[0] !== 0x01) return null;
  const nameLen = data.readUInt16BE(1);
  if (data.length < 3 + nameLen) return null;
  return data.subarray(3, 3 + nameLen).toString('utf8');
}

type PreviewStartPayload = {
  status: number;
  statusText?: string;
  headers: Record<string, string | string[]>;
};

export interface WatchRecentTextRow {
  eventId: string;
  type: 'user.message' | 'assistant.text' | 'session.error';
  text: string;
  ts: number;
}

export interface WatchActiveMainSessionRow {
  name: string;
  project: string;
  state: string;
  agentType: string;
  label?: string;
}

type WatchActiveSubSessionRow = {
  name: string;
  parentSession?: string;
  agentType?: string;
  label?: string;
};

type PendingPreviewRequest = {
  readable: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  started: boolean;
  terminalOutcome: string | null;
  responseBytes: number;
  timer: ReturnType<typeof setTimeout>;
  timerMode: 'start' | 'idle';
  resolveStart: (payload: PreviewStartPayload) => void;
  rejectStart: (err: Error) => void;
};

// ── WS tunnel state ───────────────────────────────────────────────────────────

interface WsTunnelState {
  /** The browser-side WebSocket for this tunnel. */
  browserWs: WebSocket;
  previewId: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  openTimer: ReturnType<typeof setTimeout> | null;
  state: 'pending' | 'active';
  /** Messages queued while waiting for preview.ws.opened. */
  messageQueue: Buffer[];
  queueBytes: number;
  createdAt: number;
}

type PendingHttpTimelineRequest = {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const WATCH_RECENT_TEXT_CAP = 5;
const WATCH_RECENT_TEXT_MAX_CHARS = 160;
const HTTP_TIMELINE_TIMEOUT_MS = 15_000;

function normalizeRecentText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  return normalized.length > WATCH_RECENT_TEXT_MAX_CHARS
    ? `${normalized.slice(0, WATCH_RECENT_TEXT_MAX_CHARS - 1)}…`
    : normalized;
}

function recentTextRowFromTimelineEvent(rawEvent: Record<string, unknown>): WatchRecentTextRow | null {
  const sessionId = rawEvent.sessionId;
  const eventId = rawEvent.eventId;
  const ts = rawEvent.ts;
  const type = rawEvent.type;
  const payload = rawEvent.payload;
  if (typeof sessionId !== 'string' || typeof eventId !== 'string' || typeof ts !== 'number' || typeof type !== 'string') {
    return null;
  }
  if (type !== 'user.message' && type !== 'assistant.text') return null;
  const text = normalizeRecentText((payload as Record<string, unknown> | undefined)?.text);
  if (!text) return null;
  return { eventId, type, text, ts };
}

function mergeRecentTextRows(rows: WatchRecentTextRow[]): WatchRecentTextRow[] {
  const deduped = new Map<string, WatchRecentTextRow>();
  for (const row of rows) deduped.set(row.eventId, row);
  const merged = [...deduped.values()].sort((a, b) => a.ts - b.ts);
  if (merged.length > WATCH_RECENT_TEXT_CAP) {
    return merged.slice(merged.length - WATCH_RECENT_TEXT_CAP);
  }
  return merged;
}

// ── Inflight command bookkeeping (ack reliability) ───────────────────────

type InflightState = 'buffered' | 'dispatched' | 'acked';

interface InflightCommand {
  commandId: string;
  sessionName: string;
  browser: WebSocket;
  rawPayload: string;          // the original session.send JSON as received from browser
  state: InflightState;
  sentAt: number;              // when the inflight was created (dispatch or buffer)
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

// Periodic cleanup interval handle (module-level, shared across all bridge instances)
let cleanupSweepHandle: ReturnType<typeof setInterval> | null = null;

// ── WsBridge ─────────────────────────────────────────────────────────────────

export class WsBridge {
  private static instances = new Map<string, WsBridge>();

  private daemonWs: WebSocket | null = null;
  private authenticated = false;
  private daemonVersion: string | null = null;
  private upgradeAttempts = 0;
  private browserSockets = new Set<WebSocket>();
  private mobileSockets = new Set<WebSocket>();
  private queue: string[] = [];
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private browserRateLimiter = new MemoryRateLimiter();

  /** browser socket → session name → raw-enabled flag */
  private browserSubscriptions = new Map<WebSocket, Map<string, boolean>>();

  /** browser socket → set of subscribed transport session IDs */
  private transportSubscriptions = new Map<WebSocket, Set<string>>();

  /** browser socket → userId (for session ownership checks) */
  private browserUserIds = new Map<WebSocket, string>();

  /** db reference for session ownership checks */
  private db: Database | null = null;

  /** Cached provider connection status — pushed to browsers on connect, persisted to DB. */
  private providerStatus = new Map<string, boolean>();
  /** Cached remote sessions from providers — pushed to browsers on connect, persisted to DB. */
  private providerRemoteSessions = new Map<string, unknown[]>();

  /**
   * Per-request fs.ls pending map: requestId → { socket, timer }.
   * Used to single-cast fs.ls_response back to the requesting browser.
   */
  private pendingFsRequests = new Map<string, { socket: WebSocket; timer: ReturnType<typeof setTimeout> }>();

  /**
   * Per-request fs.read pending map: requestId → { socket, timer }.
   * Used to single-cast fs.read_response back to the requesting browser.
   */
  private pendingFsReadRequests = new Map<string, { socket: WebSocket; timer: ReturnType<typeof setTimeout> }>();

  /** Per-request fs.git_status pending map. */
  private pendingFsGitStatusRequests = new Map<string, { socket: WebSocket; timer: ReturnType<typeof setTimeout> }>();

  /** Per-request fs.git_diff pending map. */
  private pendingFsGitDiffRequests = new Map<string, { socket: WebSocket; timer: ReturnType<typeof setTimeout> }>();
  private pendingFileSearchRequests = new Map<string, { socket: WebSocket; timer: ReturnType<typeof setTimeout> }>();

  /** Per-request fs.write pending map. */
  private pendingFsWriteRequests = new Map<string, { socket: WebSocket; timer: ReturnType<typeof setTimeout> }>();

  /** Per-request timeline.history / timeline.replay pending map — routes responses via requestId unicast. */
  private pendingTimelineRequests = new Map<string, { socket: WebSocket; timer: ReturnType<typeof setTimeout> }>();

  /** Per-request HTTP timeline/history relay pending map. */
  private pendingHttpTimelineRequests = new Map<string, PendingHttpTimelineRequest>();
  private pendingRecentTextBackfills = new Map<string, Promise<WatchRecentTextRow[]>>();

  /** Lightweight per-session hot cache for Watch first-paint text. */
  private recentTextBySession = new Map<string, WatchRecentTextRow[]>();

  /** Latest daemon-owned active main-session snapshot for watch list responses. */
  private activeMainSessions = new Map<string, WatchActiveMainSessionRow>();
  /** Latest daemon-owned active sub-session snapshot for push title resolution. */
  private activeSubSessions = new Map<string, WatchActiveSubSessionRow>();
  private hasActiveMainSessionSnapshot = false;

  /**
   * File transfer correlation: requestId → { resolve, reject, timer }.
   * Used by HTTP upload/download handlers to await daemon responses.
   */
  private pendingFileTransfers = new Map<string, {
    resolve: (msg: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private pendingPreviewRequests = new Map<string, PendingPreviewRequest>();

  /** Active preview WS tunnels: wsId → WsTunnelState */
  private previewWsTunnels = new Map<string, WsTunnelState>();

  /**
   * Per-session subscription reference counts derived from browser sockets.
   * totalRefs tracks active browser subscribers; rawRefs tracks raw-enabled subscribers.
   */
  private daemonSessionRefs = new Map<string, { totalRefs: number; rawRefs: number }>();

  /**
   * browser socket → session name → monotonically increasing intent revision.
   * Used to ignore stale async subscribe callbacks when a later subscribe/unsubscribe wins.
   */
  private terminalSubscriptionRevisions = new Map<WebSocket, Map<string, number>>();

  /**
   * Per-(session, browser) forwarding queues.
   * Used for both terminal_update (snapshot JSON) and binary raw frames.
   * session → browser → queue
   */
  private terminalQueues = new Map<string, Map<WebSocket, TerminalForwardQueue>>();

  // ── Command ack reliability (see shared/ack-protocol.ts) ────────────────
  /** commandId → inflight state; sticky-pod makes this authoritative per daemon. */
  private inflightCommands = new Map<string, InflightCommand>();
  /** LRU-ish dedup for replayed acks from daemon outbox flushes. */
  private seenCommandAcks = new Map<string, number>();
  /** Set while the daemon WS is closed but we're still inside the grace window. */
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** True iff we have broadcast `daemon.offline` for the current outage (resets on online). */
  private daemonOfflineAnnounced = false;
  /** Periodic GC for inflightCommands + seenCommandAcks. */
  private ackHousekeepingTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(private serverId: string) {
    // Start periodic cleanup sweep (shared across all bridge instances)
    if (!cleanupSweepHandle) {
      cleanupSweepHandle = setInterval(() => {
        for (const bridge of WsBridge.instances.values()) {
          bridge.sweepStaleTunnels();
        }
      }, 60_000);
      // Don't keep the process alive just for cleanup
      cleanupSweepHandle.unref?.();
    }
  }

  static get(serverId: string): WsBridge {
    let bridge = WsBridge.instances.get(serverId);
    if (!bridge) {
      bridge = new WsBridge(serverId);
      WsBridge.instances.set(serverId, bridge);
    }
    return bridge;
  }

  static getAll(): Map<string, WsBridge> {
    return WsBridge.instances;
  }

  // ── Daemon connection ──────────────────────────────────────────────────────

  handleDaemonConnection(ws: WebSocket, db: Database, env: Env, onAuthenticated?: () => void): void {
    this.db = db;
    // Replace existing daemon connection
    if (this.daemonWs) {
      try { this.daemonWs.close(1001, 'replaced'); } catch { /* ignore */ }
    }
    this.daemonWs = ws;
    this.authenticated = false;

    // Auth timeout
    this.authTimer = setTimeout(() => {
      if (!this.authenticated) {
        logger.warn({ serverId: this.serverId }, 'Daemon auth timeout');
        ws.close(4001, 'auth_timeout');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', async (data, isBinary) => {
      // Handle binary raw PTY frames
      if (isBinary) {
        this.routeBinaryFrame(data as Buffer);
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse((data as Buffer).toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      if (!this.authenticated) {
        if (msg.type !== 'auth' || typeof msg.token !== 'string' || typeof msg.serverId !== 'string') {
          ws.close(4001, 'auth_required');
          return;
        }
        if (this.authTimer) clearTimeout(this.authTimer);

        const tokenHash = sha256Hex(msg.token);
        const server = await db.queryOne<{ token_hash: string }>('SELECT token_hash FROM servers WHERE id = $1', [this.serverId]);

        if (!server || server.token_hash !== tokenHash) {
          logger.warn({ serverId: this.serverId }, 'Daemon auth failed');
          ws.close(4001, 'auth_failed');
          return;
        }

        this.authenticated = true;
        this.daemonVersion = typeof msg.daemonVersion === 'string' ? msg.daemonVersion : null;
        this.recentTextBySession.clear();
        this.activeMainSessions.clear();
        this.hasActiveMainSessionSnapshot = false;
        logger.info({ serverId: this.serverId, daemonVersion: this.daemonVersion }, 'Daemon authenticated');
        onAuthenticated?.();

        updateServerHeartbeat(db, this.serverId, this.daemonVersion).catch((err) =>
          logger.error({ err }, 'Failed to update heartbeat on auth'),
        );

        // Auto-upgrade: on each reconnect, retry up to 3 times with 10-minute intervals.
        // Always target the server's exact version so dev↔stable mismatches converge to
        // the same channel in both directions.
        const serverVersion = process.env.APP_VERSION;
        const shouldUpgrade = Boolean(
          serverVersion
          && serverVersion !== '0.0.0'
          && this.daemonVersion
          && this.daemonVersion !== serverVersion,
        );
        if (shouldUpgrade) {
          this.upgradeAttempts = (this.upgradeAttempts ?? 0) + 1;
          if (this.upgradeAttempts <= 3) {
            logger.info({ serverId: this.serverId, daemonVersion: this.daemonVersion, serverVersion, attempt: this.upgradeAttempts }, 'Version mismatch — sending daemon.upgrade');
            setTimeout(() => {
              try { ws.send(JSON.stringify({ type: 'daemon.upgrade', targetVersion: serverVersion })); } catch { /* ignore */ }
            }, 5000);
            // Schedule retry: if daemon reconnects with the same old version after 10 min, the counter is already incremented.
            // If daemon doesn't reconnect (upgrade succeeded and restarted), the next auth will have matching version → no upgrade sent.
          } else {
            logger.warn({ serverId: this.serverId, daemonVersion: this.daemonVersion, serverVersion, attempts: this.upgradeAttempts }, 'Version mismatch — max upgrade attempts reached, giving up');
          }
        } else {
          // Version matches, daemon is newer, or auto-upgrade does not apply — reset retry counter
          this.upgradeAttempts = 0;
        }

        // Replay queued messages, skipping terminal.subscribe/unsubscribe — refs replay below is authoritative
        for (const queued of this.queue) {
          try {
            const parsed = JSON.parse(queued) as { type?: string };
            if (parsed.type === 'terminal.subscribe' || parsed.type === 'terminal.unsubscribe') continue;
            ws.send(queued);
          } catch { /* ignore */ }
        }
        this.queue = [];

        this.broadcastToBrowsers(JSON.stringify({ type: DAEMON_MSG.RECONNECTED }));

        // Re-subscribe daemon to all sessions that still have active browser subscribers
        for (const [sessionName, refs] of this.daemonSessionRefs) {
          if (refs.totalRefs > 0) {
            try {
              ws.send(JSON.stringify({
                type: 'terminal.subscribe',
                session: sessionName,
                raw: refs.rawRefs > 0,
              }));
            } catch { /* ignore */ }
          }
        }

        // ── Ack reliability: cancel grace, replay inflight, announce online ──
        if (this.graceTimer) {
          clearTimeout(this.graceTimer);
          this.graceTimer = null;
        }
        this.daemonOfflineAnnounced = false;
        this.replayInflightToDaemon();
        this.broadcastToBrowsers(JSON.stringify({ type: MSG_DAEMON_ONLINE }));
        this.startAckHousekeepingIfNeeded();

        return;
      }

      if (msg.type === 'heartbeat') {
        updateServerHeartbeat(db, this.serverId).catch((err) =>
          logger.error({ err }, 'Failed to update heartbeat'),
        );
        // Ack heartbeat so daemon watchdog doesn't consider the connection dead
        try { ws.send(JSON.stringify({ type: 'heartbeat_ack' })); } catch { /* ignore */ }
      }

      this.relayToBrowsers(msg);

      // Push notifications for key events
      if (env) {
        const pushType = msg.type as string;
        if (pushType === 'session.idle' || pushType === 'session.notification' || pushType === 'session.error') {
          this.dispatchEventPush(db, env, msg).catch((err) =>
            logger.error({ err }, 'Push dispatch failed'),
          );
        }
        // Timeline events: session.state(idle) and ask.question
        if (pushType === 'timeline.event') {
          const event = (msg as Record<string, unknown>).event as Record<string, unknown> | undefined;
          if (event?.type === 'ask.question') {
            this.dispatchEventPush(db, env, {
              type: 'ask.question',
              session: event.sessionId ?? '',
              ...event.payload as Record<string, unknown>,
            }).catch((err) => logger.error({ err }, 'Push dispatch failed'));
          }
          // session.state idle from timeline (covers all agent types: CC, codex, gemini)
          if (event?.type === 'session.state' && (event.payload as Record<string, unknown>)?.state === 'idle') {
            this.dispatchEventPush(db, env, {
              type: 'session.idle',
              session: event.sessionId ?? '',
              lastText: (msg as Record<string, unknown>).lastText ?? '',
            }).catch((err) => logger.error({ err }, 'Push dispatch failed'));
          }
        }
      }
    });

    ws.on('close', () => {
      if (this.daemonWs === ws) {
        this.daemonWs = null;
        this.authenticated = false;
        this.recentTextBySession.clear();
        this.activeMainSessions.clear();
        this.activeSubSessions.clear();
        this.hasActiveMainSessionSnapshot = false;
        this.rejectAllPendingFileTransfers('daemon_disconnected');
        this.rejectAllPendingHttpTimelineRequests('daemon_disconnected');
        this.rejectAllPendingPreviewRequests('daemon_disconnected');
        // Close all preview WS tunnels — daemon is gone
        this.closeAllPreviewWsTunnels(1001, 'daemon disconnected');
        // Clear provider statuses — daemon is gone, providers are unreachable
        for (const [providerId] of this.providerStatus) {
          this.broadcastToBrowsers(JSON.stringify({ type: TRANSPORT_MSG.PROVIDER_STATUS, providerId, connected: false }));
        }
        this.providerStatus.clear();
        this.broadcastToBrowsers(JSON.stringify({ type: DAEMON_MSG.DISCONNECTED }));
        void clearProviderStatus(db, this.serverId).catch(() => {});
        updateServerStatus(db, this.serverId, 'offline').catch((err) =>
          logger.error({ err }, 'Failed to mark server offline'),
        );

        // ── Ack reliability: start grace window, don't yet announce offline ──
        // If daemon reconnects within RECONNECT_GRACE_MS, we replay inflight
        // commands and users never see a failure.
        if (this.graceTimer) clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          this.onReconnectGraceExpired();
        }, RECONNECT_GRACE_MS);
      }
      this.maybeCleanup();
    });

    ws.on('error', (err) => {
      logger.error({ serverId: this.serverId, err }, 'Daemon WS error');
      this.rejectAllPendingFileTransfers('daemon_error');
      this.rejectAllPendingHttpTimelineRequests('daemon_error');
      this.rejectAllPendingPreviewRequests('daemon_error');
    });
  }

  // ── Browser connection ─────────────────────────────────────────────────────

  handleBrowserConnection(ws: WebSocket, userId: string, db: Database, isMobile = false): void {
    this.db = db;
    this.browserSockets.add(ws);
    if (isMobile) this.mobileSockets.add(ws);
    this.browserSubscriptions.set(ws, new Map());
    this.transportSubscriptions.set(ws, new Set());
    this.browserUserIds.set(ws, userId);

    // Push cached provider statuses so the browser has them immediately — no WS race.
    for (const [providerId, connected] of this.providerStatus) {
      safeSend(ws, JSON.stringify({ type: TRANSPORT_MSG.PROVIDER_STATUS, providerId, connected }));
    }
    // Push cached remote sessions for each connected provider
    for (const [providerId, sessions] of this.providerRemoteSessions) {
      safeSend(ws, JSON.stringify({ type: TRANSPORT_MSG.SESSIONS_RESPONSE, providerId, sessions }));
    }

    ws.on('message', (data) => {
      const raw = (data as Buffer).toString();
      if (Buffer.byteLength(raw, 'utf8') > MAX_BROWSER_PAYLOAD) {
        logger.warn({ serverId: this.serverId }, 'Browser message too large — dropped');
        try { ws.send(JSON.stringify({ type: 'error', error: 'payload_too_large' })); } catch { /* ignore */ }
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Browser rate limit — drop with error response so frontend can handle it
      {
        const browserId = this.getBrowserId(ws);
        if (!this.browserRateLimiter.check(browserId, BROWSER_RATE_LIMIT, BROWSER_RATE_WINDOW)) {
          logger.warn({ serverId: this.serverId, type: msg.type }, 'Browser rate limit exceeded — dropped');
          safeSend(ws, JSON.stringify({ type: 'error', code: 'rate_limited', message: 'Too many requests', originalType: msg.type, requestId: msg.requestId }));
          return;
        }
      }

      if (typeof msg.type !== 'string') {
        return;
      }

      // Track fs.ls requests for single-cast response routing
      if (msg.type === 'fs.ls' && typeof msg.requestId === 'string') {
        const reqId = msg.requestId;
        const timer = setTimeout(() => this.pendingFsRequests.delete(reqId), 20_000);
        this.pendingFsRequests.set(reqId, { socket: ws, timer });
      }

      // Track fs.read requests for single-cast response routing
      if (msg.type === 'fs.read' && typeof msg.requestId === 'string') {
        const reqId = msg.requestId;
        const timer = setTimeout(() => this.pendingFsReadRequests.delete(reqId), 20_000);
        this.pendingFsReadRequests.set(reqId, { socket: ws, timer });
      }

      // Track fs.git_status requests for single-cast response routing
      if (msg.type === 'fs.git_status' && typeof msg.requestId === 'string') {
        const reqId = msg.requestId;
        const timer = setTimeout(() => this.pendingFsGitStatusRequests.delete(reqId), 20_000);
        this.pendingFsGitStatusRequests.set(reqId, { socket: ws, timer });
      }

      // Track fs.git_diff requests for single-cast response routing
      if (msg.type === 'fs.git_diff' && typeof msg.requestId === 'string') {
        const reqId = msg.requestId;
        const timer = setTimeout(() => this.pendingFsGitDiffRequests.delete(reqId), 20_000);
        this.pendingFsGitDiffRequests.set(reqId, { socket: ws, timer });
      }

      // Track file.search requests for single-cast response routing
      if (msg.type === 'file.search' && typeof msg.requestId === 'string') {
        const reqId = msg.requestId;
        const timer = setTimeout(() => this.pendingFileSearchRequests.delete(reqId), 20_000);
        this.pendingFileSearchRequests.set(reqId, { socket: ws, timer });
      }

      // Track fs.write requests for single-cast response routing
      if (msg.type === 'fs.write' && typeof msg.requestId === 'string') {
        const reqId = msg.requestId;
        const timer = setTimeout(() => this.pendingFsWriteRequests.delete(reqId), 20_000);
        this.pendingFsWriteRequests.set(reqId, { socket: ws, timer });
      }

      // Track timeline.history_request / timeline.replay_request for single-cast response routing
      // This eliminates the race where terminal.subscribe's async ownership check hasn't completed
      // before the daemon responds with timeline.history — without this, the response is silently dropped.
      if ((msg.type === 'timeline.history_request' || msg.type === 'timeline.replay_request') && typeof msg.requestId === 'string') {
        const reqId = msg.requestId;
        const timer = setTimeout(() => this.pendingTimelineRequests.delete(reqId), 30_000);
        this.pendingTimelineRequests.set(reqId, { socket: ws, timer });
      }

      // Track terminal subscriptions for binary routing + ref-counted daemon forwarding
      if (msg.type === 'terminal.subscribe' && typeof msg.session === 'string') {
        const sessionName = msg.session;
        const rawMode = typeof msg.raw === 'boolean' ? msg.raw : true;
        const revision = this.bumpTerminalSubscriptionRevision(ws, sessionName);
        void this.verifySessionOwnership(sessionName).then((allowed) => {
          if (!allowed) {
            logger.warn({ serverId: this.serverId, sessionName }, 'terminal.subscribe: session not owned by this server — rejected');
            return;
          }
          if (!this.isCurrentTerminalSubscriptionRevision(ws, sessionName, revision)) return;
          this.addBrowserSessionSubscription(ws, sessionName, rawMode, raw, revision);
        });
        return;
      } else if (msg.type === 'terminal.unsubscribe' && typeof msg.session === 'string') {
        this.removeBrowserSessionSubscription(ws, msg.session);
        return; // forwarding handled inside (only on 1→0)
      }

      // Track transport (chat) subscriptions for session-scoped transport event delivery
      if (msg.type === TRANSPORT_MSG.CHAT_SUBSCRIBE && typeof msg.sessionId === 'string') {
        this.transportSubscriptions.get(ws)?.add(msg.sessionId);
        // Forward to daemon so it can replay cached history
        this.sendToDaemon(raw);
        return;
      }
      if (msg.type === TRANSPORT_MSG.CHAT_UNSUBSCRIBE && typeof msg.sessionId === 'string') {
        this.transportSubscriptions.get(ws)?.delete(msg.sessionId);
        return;
      }

      // ── command.ack reliability: intercept session.send ────────────────
      //
      // Three cases:
      //   1. daemon fully offline (past grace)       → immediately command.failed
      //   2. daemon transiently offline (in grace)   → buffer + replay on reconnect
      //   3. daemon online                           → forward + arm 5s ack timeout
      //
      // In all cases we record an inflight entry so that the later command.ack
      // (or timeout / disconnect) can correlate back to the right browser.
      if (msg.type === 'session.send' && typeof msg.commandId === 'string') {
        const sessionName = typeof msg.sessionName === 'string'
          ? msg.sessionName
          : (typeof msg.session === 'string' ? msg.session : '');
        if (sessionName) {
          this.handleOutboundSessionSend(ws, msg.commandId, sessionName, raw);
          return;
        }
        // Malformed: no sessionName — fall through to regular forwarding,
        // the daemon will ignore it. Don't drop silently here.
      }

      this.sendToDaemon(raw);
    });

    ws.on('close', () => {
      this.cleanupBrowserSocket(ws);
      this.maybeCleanup();
    });

    ws.on('error', () => {
      this.cleanupBrowserSocket(ws);
      this.maybeCleanup();
    });
  }

  // ── Relay helpers ──────────────────────────────────────────────────────────

  /**
   * Relay a daemon→browser message. Default-allow: unrecognised types are
   * broadcast to all browsers. Session-scoped types still require a session
   * identifier (missing → discard + warn). DB-only types (discussion.save,
   * subsession.sync, etc.) are consumed server-side and never forwarded.
   */
  private relayToBrowsers(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    // ── Preview WS tunnel control messages ──────────────────────────────────
    if (type === PREVIEW_MSG.WS_OPENED) {
      this.resolvePreviewWsOpened(msg as unknown as PreviewWsOpenedMessage);
      return;
    }
    if (type === PREVIEW_MSG.WS_ERROR) {
      this.handlePreviewWsError(msg as unknown as PreviewWsErrorMessage);
      return;
    }
    if (type === PREVIEW_MSG.WS_CLOSE) {
      this.handlePreviewWsClose(msg as unknown as PreviewWsCloseMessage);
      return;
    }

    if (type === PREVIEW_MSG.RESPONSE_START) {
      this.resolvePreviewStart(msg as unknown as PreviewResponseStartMessage);
      return;
    }

    if (type === PREVIEW_MSG.RESPONSE_END) {
      this.completePreviewRequest((msg.requestId as string | undefined) ?? '', PREVIEW_TERMINAL_OUTCOME.RESPONSE_END);
      return;
    }

    if (type === PREVIEW_MSG.ERROR) {
      this.failPreviewRequest(msg as unknown as PreviewErrorMessage);
      return;
    }

    // ── fs.ls_response: single-cast back to requesting browser ────────────────
    if (type === 'fs.ls_response') {
      const requestId = msg.requestId as string | undefined;
      if (requestId) {
        const pending = this.pendingFsRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingFsRequests.delete(requestId);
          if (pending.socket.readyState === WebSocket.OPEN) {
            pending.socket.send(JSON.stringify(msg));
          }
        }
      }
      return;
    }

    // ── fs.read_response: single-cast back to requesting browser ─────────────
    if (type === 'fs.read_response') {
      const requestId = msg.requestId as string | undefined;
      if (requestId) {
        const pending = this.pendingFsReadRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingFsReadRequests.delete(requestId);
          if (pending.socket.readyState === WebSocket.OPEN) {
            pending.socket.send(JSON.stringify(msg));
          }
        }
      }
      return;
    }

    // ── fs.git_status_response: single-cast back to requesting browser ────────
    if (type === 'fs.git_status_response') {
      const requestId = msg.requestId as string | undefined;
      if (requestId) {
        const pending = this.pendingFsGitStatusRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingFsGitStatusRequests.delete(requestId);
          if (pending.socket.readyState === WebSocket.OPEN) {
            pending.socket.send(JSON.stringify(msg));
          }
        }
      }
      return;
    }

    // ── fs.git_diff_response: single-cast back to requesting browser ──────────
    if (type === 'fs.git_diff_response') {
      const requestId = msg.requestId as string | undefined;
      if (requestId) {
        const pending = this.pendingFsGitDiffRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingFsGitDiffRequests.delete(requestId);
          if (pending.socket.readyState === WebSocket.OPEN) {
            pending.socket.send(JSON.stringify(msg));
          }
        }
      }
      return;
    }

    // ── fs.write_response: single-cast back to requesting browser ────────────
    if (type === 'fs.write_response') {
      const requestId = msg.requestId as string | undefined;
      if (requestId) {
        const pending = this.pendingFsWriteRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingFsWriteRequests.delete(requestId);
          if (pending.socket.readyState === WebSocket.OPEN) {
            pending.socket.send(JSON.stringify(msg));
          }
        }
      }
      return;
    }

    // ── file.search_response: single-cast back to requesting browser ─────────
    if (type === 'file.search_response') {
      const requestId = msg.requestId as string | undefined;
      if (requestId) {
        const pending = this.pendingFileSearchRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingFileSearchRequests.delete(requestId);
          if (pending.socket.readyState === WebSocket.OPEN) {
            pending.socket.send(JSON.stringify(msg));
          }
        }
      }
      return;
    }

    // ── File transfer responses: resolve HTTP handler Promises ─────────────────
    if (type === 'file.upload_done' || type === 'file.upload_error') {
      const requestId = msg.uploadId as string | undefined;
      if (requestId) this.resolveFileTransfer(requestId, msg);
      return;
    }
    if (type === 'file.download_done' || type === 'file.download_error') {
      const requestId = msg.downloadId as string | undefined;
      if (requestId) this.resolveFileTransfer(requestId, msg);
      return;
    }

    // ── Terminal diff: session-scoped ─────────────────────────────────────────
    if (type === 'terminal_update') {
      const sessionName = (msg.diff as Record<string, unknown> | undefined)?.sessionName as string | undefined;
      if (!sessionName) {
        logger.warn({ serverId: this.serverId }, 'terminal_update missing sessionName — discarded');
        return;
      }
      this.sendToSessionSubscribers(sessionName, JSON.stringify({ ...msg, type: 'terminal.diff' }));
      return;
    }

    // ── Lifecycle events: broadcast whitelist ─────────────────────────────────
    if (type === 'session_event') {
      this.broadcastToBrowsers(JSON.stringify({ ...msg, type: 'session.event' }));
      return;
    }

      if (type === 'session_list') {
        this.replaceActiveMainSessions(msg.sessions);
        this.pruneMainSessionRecentText(msg.sessions);
        this.broadcastToBrowsers(JSON.stringify({
        ...msg,
        daemonVersion: typeof msg.daemonVersion === 'string' ? msg.daemonVersion : this.daemonVersion,
      }));
      return;
    }

    // ── Timeline events: session-scoped ───────────────────────────────────────
    if (type === 'timeline.event') {
      const sessionId = (msg.event as Record<string, unknown> | undefined)?.sessionId as string | undefined;
      if (!sessionId) {
        logger.warn({ serverId: this.serverId }, 'timeline.event missing sessionId — discarded');
        return;
      }
      this.ingestRecentTextFromTimelineEvent(msg.event as Record<string, unknown>);
      this.sendToSessionSubscribers(sessionId, JSON.stringify(msg));
      return;
    }

    // Timeline history/replay: route via requestId unicast (eliminates subscription race),
    // falling back to session subscribers for legacy/live replay without requestId.
    if (type === 'timeline.history' || type === 'timeline.replay') {
      const requestId = msg.requestId as string | undefined;
      if (requestId) {
        const pendingHttp = this.pendingHttpTimelineRequests.get(requestId);
        if (pendingHttp) {
          clearTimeout(pendingHttp.timer);
          this.pendingHttpTimelineRequests.delete(requestId);
          pendingHttp.resolve(msg);
          return;
        }
        const pending = this.pendingTimelineRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingTimelineRequests.delete(requestId);
          if (pending.socket.readyState === WebSocket.OPEN) {
            pending.socket.send(JSON.stringify(msg));
          }
          return;
        }
      }
      // Fallback: no requestId or no pending request — use session subscribers
      const sessionName = msg.sessionName as string | undefined;
      if (!sessionName) {
        logger.warn({ serverId: this.serverId, type }, 'timeline message missing sessionName — discarded');
        return;
      }
      this.sendToSessionSubscribers(sessionName, JSON.stringify(msg));
      return;
    }

    // ── Command & subsession: session-scoped ──────────────────────────────────
    if (type === MSG_COMMAND_ACK) {
      const sessionName = msg.session as string | undefined;
      if (!sessionName) {
        logger.warn({ serverId: this.serverId }, 'command.ack missing session — discarded');
        return;
      }
      const commandId = typeof msg.commandId === 'string' ? msg.commandId : null;
      if (commandId) {
        // Dedup replayed acks from daemon outbox flush (sticky-pod keeps this
        // LRU authoritative within a pod lifetime).
        if (this.seenCommandAcks.has(commandId)) {
          logger.debug({ serverId: this.serverId, commandId }, 'command.ack dedup — dropping replay');
          return;
        }
        this.seenCommandAcks.set(commandId, Date.now());
        this.clearInflightOnAck(commandId);
      }
      this.sendToSessionSubscribers(sessionName, JSON.stringify(msg));
      return;
    }

    // subsession.shells — broadcast to all browsers (response to detect_shells)
    if (type === 'subsession.shells') {
      this.broadcastToBrowsers(JSON.stringify(msg));
      return;
    }

    if (type === 'subsession.response') {
      const sessionName = msg.sessionName as string | undefined;
      if (!sessionName) {
        logger.warn({ serverId: this.serverId }, 'subsession.response missing sessionName — discarded');
        return;
      }
      this.sendToSessionSubscribers(sessionName, JSON.stringify(msg));
      return;
    }

    // ── Session notifications: session-scoped ─────────────────────────────────
    if (type === 'session.idle' || type === 'session.notification' || type === 'session.tool') {
      const sessionName = msg.session as string | undefined;
      if (!sessionName) {
        logger.warn({ serverId: this.serverId, type }, 'session notification missing session — discarded');
        return;
      }
      this.sendToSessionSubscribers(sessionName, JSON.stringify(msg));
      return;
    }

    // ── Sub-session sync: daemon creates sub-sessions → persist to DB ────────
    if (type === 'subsession.sync' && this.db) {
      if (isKnownTestSessionLike({
        name: typeof msg.id === 'string' ? `deck_sub_${msg.id}` : undefined,
        cwd: typeof msg.cwd === 'string' ? msg.cwd : undefined,
        parentSession: typeof msg.parentSession === 'string' ? msg.parentSession : undefined,
      })) {
        return;
      }
      const subSessionName = `deck_sub_${String(msg.id ?? '')}`;
      if (subSessionName !== 'deck_sub_') {
        const label = typeof msg.label === 'string' && msg.label.trim() ? msg.label.trim() : undefined;
        const parentSession = typeof msg.parentSession === 'string' && msg.parentSession ? msg.parentSession : undefined;
        const agentType = typeof msg.sessionType === 'string' && msg.sessionType ? msg.sessionType : undefined;
        this.activeSubSessions.set(subSessionName, { name: subSessionName, label, parentSession, agentType });
      }
      void createSubSession(
        this.db,
        msg.id as string,
        this.serverId,
        msg.sessionType as string,
        (msg.shellBin as string) || null,
        (msg.cwd as string) || null,
        (msg.label as string) || null,
        (msg.ccSessionId as string) || null,
        (msg.geminiSessionId as string) || null,
        (msg.parentSession as string) || null,
        (msg.runtimeType as string) || null,
        (msg.providerId as string) || null,
        (msg.providerSessionId as string) || null,
        (msg.description as string) || null,
        (msg.ccPresetId as string) || null,
        (msg.requestedModel as string) || null,
        ((msg.activeModel as string) || (msg.modelDisplay as string)) || null,
        (msg.effort as string) || null,
        (msg.transportConfig as Record<string, unknown>) || null,
      ).then(() => {
        // Notify browsers so sub-session appears immediately without page refresh
        this.broadcastToBrowsers(JSON.stringify({
          type: 'subsession.created',
          id: msg.id,
          sessionName: `deck_sub_${msg.id}`,
          sessionType: msg.sessionType,
          cwd: msg.cwd || null,
          label: msg.label || null,
          parentSession: msg.parentSession || null,
          ccPresetId: (msg.ccPresetId as string) || null,
          runtimeType: msg.runtimeType || null,
          providerId: msg.providerId || null,
          providerSessionId: msg.providerSessionId || null,
          requestedModel: msg.requestedModel || null,
          activeModel: msg.activeModel || msg.modelDisplay || null,
          effort: msg.effort || null,
          transportConfig: msg.transportConfig || null,
          qwenModel: msg.qwenModel || null,
          qwenAuthType: msg.qwenAuthType || null,
          qwenAvailableModels: msg.qwenAvailableModels || null,
          modelDisplay: msg.modelDisplay || null,
          planLabel: msg.planLabel || null,
          quotaLabel: msg.quotaLabel || null,
          quotaUsageLabel: msg.quotaUsageLabel || null,
          quotaMeta: msg.quotaMeta || null,
          state: (msg.state as string) || 'idle',
        }));
      }).catch((e) => logger.error({ err: e, id: msg.id }, 'Failed to sync sub-session to DB'));
      return;
    }
    if (type === 'subsession.update_gemini_id' && this.db) {
      void updateSubSession(this.db, msg.id as string, this.serverId, {
        gemini_session_id: msg.geminiSessionId as string,
      }).catch((e) => logger.error({ err: e, id: msg.id }, 'Failed to update gemini_session_id'));
      return;
    }
    if (type === 'subsession.close' && this.db) {
      void updateSubSession(this.db, msg.id as string, this.serverId, { closed_at: Date.now() })
        .catch((e) => logger.error({ err: e, id: msg.id }, 'Failed to close sub-session in DB'));
      return;
    }

    // ── Discussion persistence: daemon → DB (not relayed to browsers) ────────
    if (type === 'discussion.save' && this.db) {
      void upsertDiscussion(this.db, {
        id: msg.id as string,
        serverId: this.serverId,
        topic: msg.topic as string,
        state: msg.state as string,
        maxRounds: msg.maxRounds as number,
        currentRound: (msg.currentRound as number) ?? 0,
        totalRounds: (msg.totalRounds as number) ?? 1,
        completedHops: (msg.completedHops as number) ?? 0,
        totalHops: (msg.totalHops as number) ?? 0,
        currentSpeaker: (msg.currentSpeaker as string) || null,
        participants: (msg.participants as string) || null,
        filePath: (msg.filePath as string) || null,
        conclusion: (msg.conclusion as string) || null,
        fileContent: (msg.fileContent as string) || null,
        error: (msg.error as string) || null,
        startedAt: msg.startedAt as number,
        finishedAt: (msg.finishedAt as number) || null,
      }).catch((e) => logger.error({ err: e, discussionId: msg.id }, 'Failed to save discussion'));
      return;
    }
    if (type === 'discussion.round_save' && this.db) {
      void insertDiscussionRound(this.db, {
        id: msg.roundId as string,
        discussionId: msg.discussionId as string,
        serverId: this.serverId,
        round: msg.round as number,
        speakerRole: msg.speakerRole as string,
        speakerAgent: msg.speakerAgent as string,
        speakerModel: (msg.speakerModel as string) || null,
        response: msg.response as string,
      }).catch((e) => logger.error({ err: e, discussionId: msg.discussionId }, 'Failed to save discussion round'));
      return;
    }

    // ── Discussion messages: broadcast to all browsers ────────────────────────
    if (
      type === 'discussion.started' ||
      type === 'discussion.update' ||
      type === 'discussion.done' ||
      type === 'discussion.error' ||
      type === 'discussion.list'
    ) {
      this.broadcastToBrowsers(JSON.stringify(msg));
      return;
    }

    // ── Sub-session closed by daemon → mark in DB + notify browsers ─────────
    if (type === 'subsession.closed' && this.db) {
      const id = msg.id as string;
      if (id) {
        void this.db.execute('UPDATE sub_sessions SET closed_at = $1 WHERE id = $2 AND server_id = $3',
          [Date.now(), id, this.serverId])
          .then(() => {
            const sessionName = `deck_sub_${id}`;
            this.recentTextBySession.delete(sessionName);
            this.activeSubSessions.delete(sessionName);
            this.broadcastToBrowsers(JSON.stringify({ type: 'subsession.removed', id, sessionName: msg.sessionName }));
          })
          .catch((err) => {
            logger.error({ err, id, sessionName: msg.sessionName }, 'Failed to persist sub-session close from daemon');
          });
      }
      return;
    }

    // ── P2P conflict → broadcast to browsers ────────────────────────────────
    if (type === 'p2p.conflict') {
      this.broadcastToBrowsers(JSON.stringify(msg));
      return;
    }

    // ── Cron→P2P linking: update execution detail with discussion ID ──────
    if (type === 'cron.p2p_linked' && this.db) {
      const { jobId, discussionId } = msg as { jobId: string; discussionId: string };
      if (jobId && discussionId) {
        void this.db.execute(
          `UPDATE cron_executions SET detail = $1 WHERE id = (
             SELECT id FROM cron_executions WHERE job_id = $2 ORDER BY created_at DESC LIMIT 1
           )`,
          [`p2p:${discussionId}`, jobId],
        ).catch(() => {});
      }
      this.broadcastToBrowsers(JSON.stringify({ type: 'cron.p2p_linked', jobId, discussionId }));
      return;
    }

    // ── Cron command result: update execution detail with agent response ──
    if (type === 'cron.command_result' && this.db) {
      const { jobId, executionId, detail, status } = msg as { jobId: string; executionId?: string; detail: string; status?: string };
      if (jobId && detail) {
        const params: unknown[] = [detail.slice(0, 4000)];
        let sql = '';
        if (executionId) {
          if (status) {
            sql = 'UPDATE cron_executions SET detail = $1, status = $2 WHERE id = $3';
            params.push(status, executionId);
          } else {
            sql = 'UPDATE cron_executions SET detail = $1 WHERE id = $2';
            params.push(executionId);
          }
        } else if (status) {
          sql = `UPDATE cron_executions SET detail = $1, status = $2 WHERE id = (
             SELECT id FROM cron_executions WHERE job_id = $3 ORDER BY created_at DESC LIMIT 1
           )`;
          params.push(status, jobId);
        } else {
          sql = `UPDATE cron_executions SET detail = $1 WHERE id = (
             SELECT id FROM cron_executions WHERE job_id = $2 ORDER BY created_at DESC LIMIT 1
           )`;
          params.push(jobId);
        }
        void this.db.execute(sql, params).catch(() => {});
      }
      return;
    }

    // ── P2P orchestration run persistence + broadcast ────────────────────────
    if (type === 'p2p.run_save' && this.db) {
      const run = { ...(msg.run as Record<string, unknown>), progress_snapshot: JSON.stringify(msg.run) };
      void upsertOrchestrationRun(this.db, run as any).catch(() => {});
      this.broadcastToBrowsers(JSON.stringify({ type: 'p2p.run_update', run: msg.run }));
      return;
    }
    if (type === 'p2p.run_complete' && this.db) {
      const run = msg.run as any;
      run.status = 'completed';
      run.completed_at = new Date().toISOString();
      run.progress_snapshot = JSON.stringify(run);
      void upsertOrchestrationRun(this.db, run).catch(() => {});
      this.broadcastToBrowsers(JSON.stringify({ type: 'p2p.run_update', run }));
      return;
    }
    if (type === 'p2p.run_error' && this.db) {
      const run = msg.run as any;
      run.updated_at = new Date().toISOString();
      run.progress_snapshot = JSON.stringify(run);
      void upsertOrchestrationRun(this.db, run).catch(() => {});
      this.broadcastToBrowsers(JSON.stringify({ type: 'p2p.run_update', run }));
      return;
    }

    // ── Daemon stats: extract from heartbeat or standalone, broadcast to browsers ─
    if (type === 'daemon.stats' || (type === 'heartbeat' && msg.cpu !== undefined)) {
      if (typeof msg.daemonVersion === 'string') this.daemonVersion = msg.daemonVersion;
      this.broadcastToBrowsers(JSON.stringify({
        type: 'daemon.stats',
        daemonVersion: typeof msg.daemonVersion === 'string' ? msg.daemonVersion : this.daemonVersion,
        cpu: msg.cpu, memUsed: msg.memUsed, memTotal: msg.memTotal,
        load1: msg.load1, load5: msg.load5, load15: msg.load15, uptime: msg.uptime,
      }));
      return;
    }

    // Repo messages: use shared constants to prevent type-name drift between daemon and bridge
    if ((REPO_RELAY_TYPES as Set<string>).has(type)) {
      this.broadcastToBrowsers(JSON.stringify(msg));
      return;
    }

    // Provider status: cache + persist to DB + broadcast to all browsers
    if (type === TRANSPORT_MSG.PROVIDER_STATUS) {
      const providerId = msg.providerId as string;
      const connected = msg.connected as boolean;
      if (providerId) {
        this.providerStatus.set(providerId, connected);
        if (this.db) {
          void updateProviderStatus(this.db, this.serverId, providerId, connected)
            .catch((e) => logger.error({ err: e, providerId }, 'Failed to persist provider status'));
        }
      }
      this.broadcastToBrowsers(JSON.stringify(msg));
      return;
    }

    // Provider remote sessions sync: cache + persist to DB + broadcast to browsers
    if (type === 'provider.sync_sessions') {
      const providerId = msg.providerId as string;
      const sessions = msg.sessions as unknown[];
      if (providerId && Array.isArray(sessions)) {
        this.providerRemoteSessions.set(providerId, sessions);
        if (this.db) {
          void updateProviderRemoteSessions(this.db, this.serverId, providerId, sessions)
            .catch((e) => logger.error({ err: e, providerId }, 'Failed to sync provider remote sessions'));
        }
      }
      // Broadcast as sessions_response so browsers update immediately
      this.broadcastToBrowsers(JSON.stringify({
        type: TRANSPORT_MSG.SESSIONS_RESPONSE,
        providerId,
        sessions: sessions ?? [],
      }));
      return;
    }

    // Transport events: route to browsers subscribed to the transport session
    if ((TRANSPORT_RELAY_TYPES as Set<string>).has(type)) {
      const sessionId = msg.sessionId as string | undefined;
      if (sessionId) {
        this.sendToTransportSubscribers(sessionId, JSON.stringify(msg));
      }
      return;
    }

    // ── Default-allow: forward unrecognised types to all browsers ─────────────
    this.broadcastToBrowsers(JSON.stringify(msg));
  }

  private routeBinaryFrame(data: Buffer): void {
    // WS_DATA frames (type 0x04) are handled separately — parsePreviewBinaryFrame returns null for them.
    if (data.length > 0 && data[0] === PREVIEW_BINARY_FRAME.WS_DATA) {
      const wsFrame = parsePreviewWsFrame(data);
      if (wsFrame) {
        this.relayWsDataToBrowser(wsFrame.wsId, wsFrame.isBinary, wsFrame.payload);
      } else {
        logger.warn({ serverId: this.serverId }, 'Binary frame: malformed WS_DATA frame');
      }
      return;
    }

    const previewFrame = parsePreviewBinaryFrame(data);
    if (previewFrame && previewFrame.frameType === PREVIEW_BINARY_FRAME.RESPONSE_BODY) {
      this.pushPreviewResponseChunk(previewFrame.requestId, previewFrame.payload);
      return;
    }

    const sessionName = parseRawFrameSession(data);
    if (!sessionName) {
      logger.warn({ serverId: this.serverId }, 'Binary frame: invalid v1 header');
      return;
    }
    this.sendToRawSessionSubscribers(sessionName, data);
  }

  getActiveMainSessions(): WatchActiveMainSessionRow[] {
    return Array.from(this.activeMainSessions.values());
  }

  hasReceivedActiveMainSessionSnapshot(): boolean {
    return this.hasActiveMainSessionSnapshot;
  }

  private replaceActiveMainSessions(rawSessions: unknown): void {
    this.activeMainSessions.clear();
    this.hasActiveMainSessionSnapshot = true;
    if (!Array.isArray(rawSessions)) return;
    for (const item of rawSessions) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const name = typeof row.name === 'string' ? row.name : '';
      const project = typeof row.project === 'string' ? row.project : '';
      const state = typeof row.state === 'string' ? row.state : 'stopped';
      const agentType = typeof row.agentType === 'string' ? row.agentType : '';
      const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim() : undefined;
      if (!name) continue;
      this.activeMainSessions.set(name, { name, project, state, agentType, label });
    }
  }

  private pruneMainSessionRecentText(rawSessions: unknown): void {
    if (!Array.isArray(rawSessions)) return;
    const activeMainSessions = new Set<string>();
    for (const item of rawSessions) {
      if (!item || typeof item !== 'object') continue;
      const name = (item as Record<string, unknown>).name;
      if (typeof name === 'string' && name) activeMainSessions.add(name);
    }
    for (const sessionName of this.recentTextBySession.keys()) {
      if (sessionName.startsWith('deck_sub_')) continue;
      if (!activeMainSessions.has(sessionName)) this.recentTextBySession.delete(sessionName);
    }
  }

  private ingestRecentTextFromTimelineEvent(rawEvent: Record<string, unknown>): void {
    const sessionId = rawEvent.sessionId;
    const row = recentTextRowFromTimelineEvent(rawEvent);
    if (typeof sessionId !== 'string' || !row) return;
    const rows = this.recentTextBySession.get(sessionId) ?? [];
    this.recentTextBySession.set(sessionId, mergeRecentTextRows([...rows, row]));
  }

  private sendToSessionSubscribers(sessionName: string, data: string | Buffer): void {
    for (const [ws, sessions] of this.browserSubscriptions) {
      if (!sessions.has(sessionName)) continue;
      const queue = this.getOrCreateQueue(sessionName, ws);
      queue.send(ws, data, () => this.handleQueueOverflow(sessionName, ws));
    }
  }

  private sendToRawSessionSubscribers(sessionName: string, data: string | Buffer): void {
    for (const [ws, sessions] of this.browserSubscriptions) {
      if (sessions.get(sessionName) !== true) continue;
      const queue = this.getOrCreateQueue(sessionName, ws);
      queue.send(ws, data, () => this.handleQueueOverflow(sessionName, ws));
    }
  }

  private sendToTransportSubscribers(sessionId: string, data: string): void {
    for (const [ws, sessions] of this.transportSubscriptions) {
      if (!sessions.has(sessionId)) continue;
      safeSend(ws, data);
    }
  }

  private handleQueueOverflow(sessionName: string, ws: WebSocket): void {
    const resetMsg = JSON.stringify({
      type: 'terminal.stream_reset',
      session: sessionName,
      reason: 'backpressure',
    });

    const sent = safeSend(ws, resetMsg, (err) => {
      if (err) {
        // Send failed (socket CLOSING/CLOSED or threw) — force close
        try { ws.close(1011, 'backpressure_notify_failed'); } catch { /* ignore */ }
      }
    });

    // Always remove subscription regardless of send success
    this.removeBrowserSessionSubscription(ws, sessionName);

    if (!sent) {
      logger.warn({ serverId: this.serverId, sessionName }, 'Backpressure reset failed to send — socket closed');
    }
  }

  private getOrCreateQueue(sessionName: string, ws: WebSocket): TerminalForwardQueue {
    let sessionQueues = this.terminalQueues.get(sessionName);
    if (!sessionQueues) {
      sessionQueues = new Map();
      this.terminalQueues.set(sessionName, sessionQueues);
    }
    let queue = sessionQueues.get(ws);
    if (!queue) {
      queue = new TerminalForwardQueue();
      sessionQueues.set(ws, queue);
    }
    return queue;
  }

  /**
   * Add or update a browser subscription for sessionName.
   * totalRefs/rawRefs are derived from live browser sockets.
   * rawMsg is the original JSON string to forward on the first 0→1 transition.
   */
  private addBrowserSessionSubscription(ws: WebSocket, sessionName: string, raw: boolean, rawMsg: string, revision: number): void {
    if (!this.isCurrentTerminalSubscriptionRevision(ws, sessionName, revision)) return;

    const subs = this.browserSubscriptions.get(ws);
    if (!subs) return;

    const existing = subs.get(sessionName);
    if (existing === raw) return;

    const refs = this.getOrCreateSessionRefs(sessionName);

    if (existing === undefined) {
      subs.set(sessionName, raw);
      refs.totalRefs += 1;
      if (raw) refs.rawRefs += 1;
      this.daemonSessionRefs.set(sessionName, refs);

      if (refs.totalRefs === 1) {
        // First browser subscriber — tell daemon to start streaming
        this.sendToDaemon(rawMsg);
      }
      return;
    }

    subs.set(sessionName, raw);
    if (existing) refs.rawRefs = Math.max(0, refs.rawRefs - 1);
    if (raw) refs.rawRefs += 1;
    this.daemonSessionRefs.set(sessionName, refs);
  }

  private getOrCreateSessionRefs(sessionName: string): { totalRefs: number; rawRefs: number } {
    const existing = this.daemonSessionRefs.get(sessionName);
    if (existing) return existing;
    const refs = { totalRefs: 0, rawRefs: 0 };
    this.daemonSessionRefs.set(sessionName, refs);
    return refs;
  }

  /**
   * Remove a browser subscription for sessionName.
   * Forwards terminal.unsubscribe to daemon only on 1→0 transition.
   */
  private removeBrowserSessionSubscription(ws: WebSocket, sessionName: string): void {
    this.bumpTerminalSubscriptionRevision(ws, sessionName);

    const subs = this.browserSubscriptions.get(ws);
    if (!subs?.has(sessionName)) return; // not subscribed
    const wasRaw = subs.get(sessionName) === true;
    subs.delete(sessionName);

    this.terminalQueues.get(sessionName)?.delete(ws);
    if (this.terminalQueues.get(sessionName)?.size === 0) {
      this.terminalQueues.delete(sessionName);
    }

    const refs = this.daemonSessionRefs.get(sessionName);
    if (!refs) return;

    refs.totalRefs = Math.max(0, refs.totalRefs - 1);
    if (wasRaw) refs.rawRefs = Math.max(0, refs.rawRefs - 1);

    if (refs.totalRefs === 0) {
      this.daemonSessionRefs.delete(sessionName);
      // Last browser unsubscribed — tell daemon to stop streaming
      this.sendToDaemon(JSON.stringify({ type: 'terminal.unsubscribe', session: sessionName }));
    } else {
      this.daemonSessionRefs.set(sessionName, refs);
    }
  }

  private bumpTerminalSubscriptionRevision(ws: WebSocket, sessionName: string): number {
    let sessions = this.terminalSubscriptionRevisions.get(ws);
    if (!sessions) {
      sessions = new Map();
      this.terminalSubscriptionRevisions.set(ws, sessions);
    }
    const next = (sessions.get(sessionName) ?? 0) + 1;
    sessions.set(sessionName, next);
    return next;
  }

  private isCurrentTerminalSubscriptionRevision(ws: WebSocket, sessionName: string, revision: number): boolean {
    return this.terminalSubscriptionRevisions.get(ws)?.get(sessionName) === revision;
  }

  private cleanupBrowserSocket(ws: WebSocket): void {
    this.browserSockets.delete(ws);
    this.mobileSockets.delete(ws);
    this.browserUserIds.delete(ws);
    const sessions = this.browserSubscriptions.get(ws);
    if (sessions) {
      for (const sessionName of [...sessions.keys()]) {
        // Use removeBrowserSessionSubscription to correctly handle ref counting + daemon notify
        this.removeBrowserSessionSubscription(ws, sessionName);
      }
    }
    this.browserSubscriptions.delete(ws);
    this.terminalSubscriptionRevisions.delete(ws);
    this.transportSubscriptions.delete(ws);
    // Clean up pending timeline requests for this socket
    for (const [reqId, pending] of this.pendingTimelineRequests) {
      if (pending.socket === ws) {
        clearTimeout(pending.timer);
        this.pendingTimelineRequests.delete(reqId);
      }
    }
  }

  /**
   * Verify that a session name belongs to this server.
   * Checks both regular sessions and sub-sessions.
   */
  private async verifySessionOwnership(sessionName: string): Promise<boolean> {
    if (!this.db) return true; // no db = dev/test mode, allow all
    try {
      // Check regular sessions
      const row = await this.db.queryOne<Record<string, unknown>>(
        'SELECT 1 FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
        [this.serverId, sessionName],
      );
      if (row) return true;

      // Check sub-sessions: name is deck_sub_{id}
      const subMatch = sessionName.match(/^deck_sub_([a-z0-9]+)$/);
      if (subMatch) {
        const subId = subMatch[1];
        const subRow = await this.db.queryOne<Record<string, unknown>>(
          'SELECT 1 FROM sub_sessions WHERE server_id = $1 AND id = $2 LIMIT 1',
          [this.serverId, subId],
        );
        if (subRow) return true;
      }

      return false;
    } catch (err) {
      logger.warn({ serverId: this.serverId, sessionName, err }, 'verifySessionOwnership: db error — denying');
      return false; // fail-closed: deny on transient DB errors to prevent unauthorized access
    }
  }

  private broadcastToBrowsers(json: string): void {
    for (const bs of this.browserSockets) {
      try {
        bs.send(json);
      } catch {
        this.browserSockets.delete(bs);
      }
    }
  }

  // ── Ack reliability helpers ────────────────────────────────────────────

  /**
   * Entry point for `session.send` interception. Registers an inflight entry
   * and dispatches / buffers / fast-fails based on current daemon state.
   */
  private handleOutboundSessionSend(
    ws: WebSocket,
    commandId: string,
    sessionName: string,
    raw: string,
  ): void {
    // Guard: if we already have an inflight for this commandId, the browser is
    // retrying / double-sending. The daemon-side user.message 5s dedup will
    // absorb duplicates, but we still skip creating a second inflight entry.
    if (this.inflightCommands.has(commandId)) {
      this.sendToDaemon(raw);
      return;
    }

    if (this.isDaemonConnected()) {
      const entry: InflightCommand = {
        commandId,
        sessionName,
        browser: ws,
        rawPayload: raw,
        state: 'dispatched',
        sentAt: Date.now(),
        timeoutTimer: null,
      };
      entry.timeoutTimer = setTimeout(() => this.onAckTimeout(commandId), ACK_TIMEOUT_MS);
      this.inflightCommands.set(commandId, entry);
      this.sendToDaemon(raw);
      this.startAckHousekeepingIfNeeded();
      return;
    }

    if (this.graceTimer) {
      // Transient outage — buffer for replay when the daemon reconnects.
      const entry: InflightCommand = {
        commandId,
        sessionName,
        browser: ws,
        rawPayload: raw,
        state: 'buffered',
        sentAt: Date.now(),
        timeoutTimer: null,
      };
      this.inflightCommands.set(commandId, entry);
      this.startAckHousekeepingIfNeeded();
      return;
    }

    // Fully offline (grace already expired): fail fast.
    this.emitCommandFailed(ws, commandId, sessionName, ACK_FAILURE_DAEMON_OFFLINE);
  }

  /** Replay buffered + dispatched commands to the daemon after reconnect. */
  private replayInflightToDaemon(): void {
    const ordered = [...this.inflightCommands.values()].sort((a, b) => a.sentAt - b.sentAt);
    for (const entry of ordered) {
      if (entry.state === 'acked') continue;
      try {
        this.sendToDaemon(entry.rawPayload);
        if (entry.state === 'buffered') {
          entry.state = 'dispatched';
        }
        // Arm (or re-arm) ack timeout from "now" — daemon's perspective.
        if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
        entry.timeoutTimer = setTimeout(() => this.onAckTimeout(entry.commandId), ACK_TIMEOUT_MS);
      } catch (err) {
        logger.warn({ commandId: entry.commandId, err }, 'replayInflightToDaemon failed for entry');
      }
    }
  }

  /** Called when RECONNECT_GRACE_MS elapses without the daemon coming back. */
  private onReconnectGraceExpired(): void {
    if (this.authenticated) return;  // daemon actually came back — nothing to do
    if (!this.daemonOfflineAnnounced) {
      this.daemonOfflineAnnounced = true;
      this.broadcastToBrowsers(JSON.stringify({ type: MSG_DAEMON_OFFLINE }));
    }
    for (const entry of [...this.inflightCommands.values()]) {
      this.emitCommandFailed(entry.browser, entry.commandId, entry.sessionName, ACK_FAILURE_DAEMON_OFFLINE);
      this.removeInflight(entry.commandId);
    }
  }

  /** Per-command ack timeout fired. */
  private onAckTimeout(commandId: string): void {
    const entry = this.inflightCommands.get(commandId);
    if (!entry) return;
    if (entry.state === 'acked') return;
    logger.warn({ serverId: this.serverId, commandId, sessionName: entry.sessionName }, 'command.ack timeout');
    this.emitCommandFailed(entry.browser, commandId, entry.sessionName, ACK_FAILURE_ACK_TIMEOUT);
    this.removeInflight(commandId);
  }

  /** Ack arrived — clear timer + mark acked. */
  private clearInflightOnAck(commandId: string): void {
    const entry = this.inflightCommands.get(commandId);
    if (!entry) return;
    entry.state = 'acked';
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    // Leave the entry around briefly for housekeeping GC so duplicate acks
    // still hit dedup via `seenCommandAcks`.
    this.removeInflight(commandId);
  }

  private removeInflight(commandId: string): void {
    const entry = this.inflightCommands.get(commandId);
    if (!entry) return;
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    this.inflightCommands.delete(commandId);
  }

  private emitCommandFailed(
    browser: WebSocket,
    commandId: string,
    sessionName: string,
    reason: AckFailureReason,
  ): void {
    const payload = {
      type: MSG_COMMAND_FAILED,
      commandId,
      session: sessionName,
      reason,
      retryable: true,
    };
    try {
      if (browser.readyState === WebSocket.OPEN) {
        browser.send(JSON.stringify(payload));
      }
    } catch (err) {
      logger.warn({ commandId, err }, 'failed to deliver command.failed to browser');
    }
  }

  /** Start periodic GC timer (idempotent). */
  private startAckHousekeepingIfNeeded(): void {
    if (this.ackHousekeepingTimer) return;
    this.ackHousekeepingTimer = setInterval(() => this.ackHousekeepingSweep(), 15_000);
    this.ackHousekeepingTimer.unref?.();
  }

  private ackHousekeepingSweep(): void {
    const now = Date.now();
    // GC stale inflight entries (shouldn't happen unless timers misfire)
    for (const [id, entry] of this.inflightCommands) {
      if (now - entry.sentAt > INFLIGHT_GC_TTL_MS) {
        logger.warn({ commandId: id, ageMs: now - entry.sentAt }, 'inflight GC: dropping stale entry');
        this.removeInflight(id);
      }
    }
    // GC dedup LRU
    for (const [id, ts] of this.seenCommandAcks) {
      if (now - ts > ACK_DEDUP_TTL_MS) this.seenCommandAcks.delete(id);
    }
    if (this.inflightCommands.size === 0 && this.seenCommandAcks.size === 0 && this.ackHousekeepingTimer) {
      clearInterval(this.ackHousekeepingTimer);
      this.ackHousekeepingTimer = null;
    }
  }

  /** Test-only accessor; prefer narrow APIs in production code. */
  _getInflightCountForTest(): number {
    return this.inflightCommands.size;
  }
  _isDaemonOfflineAnnouncedForTest(): boolean {
    return this.daemonOfflineAnnounced;
  }
  _hasSeenAckForTest(commandId: string): boolean {
    return this.seenCommandAcks.has(commandId);
  }

  /** Force-close the daemon WebSocket. Use after token rotation to evict the stale connection. */
  kickDaemon(): void {
    if (this.daemonWs) {
      try { this.daemonWs.close(4001, 'token_rotated'); } catch { /* ignore */ }
      this.daemonWs = null;
      this.authenticated = false;
    }
  }

  sendToDaemon(message: string): void {
    if (this.daemonWs && this.authenticated) {
      try {
        this.daemonWs.send(message);
      } catch (err) {
        logger.error({ serverId: this.serverId, err }, 'Failed to send to daemon');
      }
    } else {
      if (this.queue.length < MAX_QUEUE_SIZE) {
        this.queue.push(message);
      }
    }
  }

  requestTimelineHistory(params: {
    sessionName: string;
    limit?: number;
    beforeTs?: number;
    afterTs?: number;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    if (!this.isDaemonConnected()) {
      return Promise.reject(new Error('daemon_offline'));
    }

    const requestId = `watch-hist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = params.timeoutMs ?? HTTP_TIMELINE_TIMEOUT_MS;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHttpTimelineRequests.delete(requestId);
        reject(new Error('timeout'));
      }, timeoutMs);

      this.pendingHttpTimelineRequests.set(requestId, { resolve, reject, timer });

      try {
        this.daemonWs!.send(JSON.stringify({
          type: 'timeline.history_request',
          sessionName: params.sessionName,
          requestId,
          ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
          ...(typeof params.beforeTs === 'number' ? { beforeTs: params.beforeTs } : {}),
          ...(typeof params.afterTs === 'number' ? { afterTs: params.afterTs } : {}),
        }));
      } catch (err) {
        this.pendingHttpTimelineRequests.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  getRecentText(sessionName: string): WatchRecentTextRow[] {
    const rows = this.recentTextBySession.get(sessionName);
    return rows ? rows.map((row) => ({ ...row })) : [];
  }

  async getRecentTextForWatch(sessionName: string, timeoutMs = 1500): Promise<WatchRecentTextRow[]> {
    const cached = this.getRecentText(sessionName);
    if (cached.length > 0 || !this.isDaemonConnected()) return cached;

    const pending = this.pendingRecentTextBackfills.get(sessionName);
    if (pending) return pending;

    const backfill = this.requestTimelineHistory({
      sessionName,
      limit: WATCH_RECENT_TEXT_CAP * 8,
      timeoutMs,
    }).then((response) => {
      const events = Array.isArray(response.events) ? response.events : [];
      const rows = mergeRecentTextRows(
        events
          .filter((event): event is Record<string, unknown> => !!event && typeof event === 'object')
          .map((event) => recentTextRowFromTimelineEvent(event))
          .filter((row): row is WatchRecentTextRow => row !== null),
      );
      if (rows.length > 0) {
        this.recentTextBySession.set(sessionName, rows);
      }
      return rows.map((row) => ({ ...row }));
    }).catch(() => []).finally(() => {
      this.pendingRecentTextBackfills.delete(sessionName);
    });

    this.pendingRecentTextBackfills.set(sessionName, backfill);
    return backfill;
  }

  createPreviewRelay(requestId: string, timeoutMs = PREVIEW_LIMITS.RESPONSE_START_TIMEOUT_MS): {
    start: Promise<PreviewStartPayload & { body: ReadableStream<Uint8Array> }>;
    abort: (reason?: string) => void;
  } {
    if (!this.isDaemonConnected()) {
      throw new Error(PREVIEW_ERROR.DAEMON_OFFLINE);
    }

    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    let resolveStart!: (payload: PreviewStartPayload & { body: ReadableStream<Uint8Array> }) => void;
    let rejectStart!: (err: Error) => void;

    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllerRef = controller;
      },
      cancel: () => {
        this.abortPreviewRequest(requestId, PREVIEW_ERROR.ABORTED, true);
      },
    });

    const start = new Promise<PreviewStartPayload & { body: ReadableStream<Uint8Array> }>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });

    const timer = setTimeout(() => {
      this.failPreviewRequest({
        type: PREVIEW_MSG.ERROR,
        requestId,
        code: PREVIEW_ERROR.TIMEOUT,
        message: 'preview relay response start timeout',
        terminalOutcome: PREVIEW_TERMINAL_OUTCOME.TIMEOUT,
      });
      this.sendPreviewControl({ type: PREVIEW_MSG.ABORT, requestId, reason: PREVIEW_ERROR.TIMEOUT });
    }, timeoutMs);

    this.pendingPreviewRequests.set(requestId, {
      readable,
      controller: controllerRef,
      started: false,
      terminalOutcome: null,
      responseBytes: 0,
      timer,
      timerMode: 'start',
      resolveStart: (payload) => resolveStart({ ...payload, body: readable }),
      rejectStart,
    });

    return {
      start,
      abort: (reason) => this.abortPreviewRequest(requestId, reason ?? PREVIEW_ERROR.ABORTED, true),
    };
  }

  sendPreviewControl(message: Record<string, unknown>): void {
    this.sendToDaemon(JSON.stringify(message));
  }

  sendPreviewRequestBodyChunk(requestId: string, payload: Uint8Array): void {
    if (!this.daemonWs || !this.authenticated) throw new Error(PREVIEW_ERROR.DAEMON_OFFLINE);
    this.daemonWs.send(packPreviewBinaryFrame(PREVIEW_BINARY_FRAME.REQUEST_BODY, requestId, payload));
  }

  // ── File transfer correlation ──────────────────────────────────────────────

  /** Returns true if the daemon WebSocket is connected and authenticated. */
  isDaemonConnected(): boolean {
    return !!(this.daemonWs && this.authenticated);
  }

  /**
   * Send a file transfer request to daemon and await the correlated response.
   * Rejects if daemon is offline or the request times out.
   */
  sendFileTransferRequest(requestId: string, message: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.isDaemonConnected()) {
      return Promise.reject(new Error('daemon_offline'));
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFileTransfers.delete(requestId);
        reject(new Error('timeout'));
      }, timeoutMs);

      this.pendingFileTransfers.set(requestId, { resolve, reject, timer });

      try {
        this.daemonWs!.send(JSON.stringify(message));
      } catch (err) {
        this.pendingFileTransfers.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Reject all pending file transfer requests (e.g. when daemon disconnects).
   */
  private rejectAllPendingFileTransfers(reason: string): void {
    for (const [, pending] of this.pendingFileTransfers) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingFileTransfers.clear();
  }

  private rejectAllPendingHttpTimelineRequests(reason: string): void {
    for (const [, pending] of this.pendingHttpTimelineRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingHttpTimelineRequests.clear();
  }

  /**
   * Try to resolve a pending file transfer request.
   * Returns true if a matching pending request was found and resolved.
   */
  resolveFileTransfer(requestId: string, msg: Record<string, unknown>): boolean {
    const pending = this.pendingFileTransfers.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingFileTransfers.delete(requestId);
    pending.resolve(msg);
    return true;
  }

  private resolvePreviewStart(msg: PreviewResponseStartMessage): void {
    const pending = this.pendingPreviewRequests.get(msg.requestId);
    if (!pending || pending.terminalOutcome) return;
    if (pending.started) return;
    pending.started = true;
    this.resetPreviewTimeout(msg.requestId, PREVIEW_LIMITS.STREAM_IDLE_TIMEOUT_MS, 'idle');
    pending.resolveStart({
      status: msg.status,
      statusText: msg.statusText,
      headers: msg.headers,
    });
  }

  private pushPreviewResponseChunk(requestId: string, chunk: Buffer): void {
    const pending = this.pendingPreviewRequests.get(requestId);
    if (!pending || pending.terminalOutcome) return;
    if (!pending.started || !pending.controller) {
      this.failPreviewRequest({
        type: PREVIEW_MSG.ERROR,
        requestId,
        code: PREVIEW_ERROR.INVALID_REQUEST,
        message: 'preview response body arrived before response start',
        terminalOutcome: PREVIEW_TERMINAL_OUTCOME.ERROR,
      });
      return;
    }

    pending.responseBytes += chunk.length;
    if (pending.responseBytes > PREVIEW_LIMITS.MAX_RESPONSE_BYTES) {
      this.failPreviewRequest({
        type: PREVIEW_MSG.ERROR,
        requestId,
        code: PREVIEW_ERROR.LIMIT_EXCEEDED,
        message: 'preview response exceeded max bytes',
        terminalOutcome: PREVIEW_TERMINAL_OUTCOME.LIMIT_EXCEEDED,
      });
      this.sendPreviewControl({ type: PREVIEW_MSG.ABORT, requestId, reason: PREVIEW_ERROR.LIMIT_EXCEEDED });
      return;
    }

    this.resetPreviewTimeout(requestId, PREVIEW_LIMITS.STREAM_IDLE_TIMEOUT_MS, 'idle');
    pending.controller.enqueue(chunk);
  }

  private resetPreviewTimeout(requestId: string, timeoutMs: number, mode: 'start' | 'idle'): void {
    const pending = this.pendingPreviewRequests.get(requestId);
    if (!pending || pending.terminalOutcome) return;
    clearTimeout(pending.timer);
    pending.timerMode = mode;
    pending.timer = setTimeout(() => {
      const active = this.pendingPreviewRequests.get(requestId);
      if (!active || active.terminalOutcome) return;
      this.failPreviewRequest({
        type: PREVIEW_MSG.ERROR,
        requestId,
        code: PREVIEW_ERROR.TIMEOUT,
        message: mode === 'start' ? 'preview relay response start timeout' : 'preview relay stream idle timeout',
        terminalOutcome: PREVIEW_TERMINAL_OUTCOME.TIMEOUT,
      });
      this.sendPreviewControl({ type: PREVIEW_MSG.ABORT, requestId, reason: PREVIEW_ERROR.TIMEOUT });
    }, timeoutMs);
  }

  private completePreviewRequest(requestId: string, outcome: string): void {
    const pending = this.pendingPreviewRequests.get(requestId);
    if (!pending || pending.terminalOutcome) return;
    pending.terminalOutcome = outcome;
    clearTimeout(pending.timer);
    if (!pending.started) {
      pending.rejectStart(new Error(outcome));
    } else {
      pending.controller?.close();
    }
    this.pendingPreviewRequests.delete(requestId);
  }

  private failPreviewRequest(msg: PreviewErrorMessage): void {
    const pending = this.pendingPreviewRequests.get(msg.requestId);
    if (!pending || pending.terminalOutcome) return;
    pending.terminalOutcome = msg.terminalOutcome ?? PREVIEW_TERMINAL_OUTCOME.ERROR;
    clearTimeout(pending.timer);
    const error = new Error(msg.message || msg.code);
    if (!pending.started) pending.rejectStart(error);
    else pending.controller?.error(error);
    this.pendingPreviewRequests.delete(msg.requestId);
    logger.warn({
      serverId: this.serverId,
      requestId: msg.requestId,
      code: msg.code,
      message: msg.message,
    }, 'Preview relay failed');
  }

  private abortPreviewRequest(requestId: string, reason: string, propagate: boolean): void {
    const pending = this.pendingPreviewRequests.get(requestId);
    if (!pending || pending.terminalOutcome) return;
    pending.terminalOutcome = PREVIEW_TERMINAL_OUTCOME.ABORTED;
    clearTimeout(pending.timer);
    const error = new Error(reason);
    if (!pending.started) pending.rejectStart(error);
    else pending.controller?.error(error);
    this.pendingPreviewRequests.delete(requestId);
    if (propagate) this.sendPreviewControl({ type: PREVIEW_MSG.ABORT, requestId, reason });
  }

  private rejectAllPendingPreviewRequests(reason: string): void {
    for (const requestId of this.pendingPreviewRequests.keys()) {
      this.abortPreviewRequest(requestId, reason, false);
    }
  }

  // ── Preview WS Tunnel ──────────────────────────────────────────────────────

  /**
   * Create a new WS tunnel in pending state.
   * Sends preview.ws.open to daemon and starts open timeout timer.
   */
  createPreviewWsTunnel(
    wsId: string,
    previewId: string,
    port: number,
    path: string,
    browserWs: WebSocket,
    headers: Record<string, string>,
    protocols: string[],
  ): void {
    const openTimer = setTimeout(() => {
      const tunnel = this.previewWsTunnels.get(wsId);
      if (!tunnel) return;
      logger.warn({ serverId: this.serverId, wsId, previewId }, 'Preview WS tunnel open timeout');
      try { tunnel.browserWs.close(1001, 'open timeout'); } catch { /* ignore */ }
      this.cleanupTunnel(wsId);
    }, PREVIEW_LIMITS.WS_OPEN_TIMEOUT_MS);

    const tunnel: WsTunnelState = {
      browserWs,
      previewId,
      idleTimer: null,
      openTimer,
      state: 'pending',
      messageQueue: [],
      queueBytes: 0,
      createdAt: Date.now(),
    };
    this.previewWsTunnels.set(wsId, tunnel);

    // Wire browser WS events
    browserWs.on('message', (data: Buffer | string, isBinary: boolean) => {
      this.handleBrowserWsTunnelMessage(wsId, data, isBinary);
    });

    browserWs.on('close', (code: number, reason: Buffer) => {
      this.handleBrowserWsTunnelClose(wsId, code, reason.toString());
    });

    browserWs.on('error', () => {
      this.handleBrowserWsTunnelClose(wsId, 1011, 'error');
    });

    // Send preview.ws.open to daemon
    this.sendPreviewControl({
      type: PREVIEW_MSG.WS_OPEN,
      wsId,
      previewId,
      port,
      path,
      headers,
      protocols,
    });
  }

  /**
   * Called when daemon sends preview.ws.opened.
   * Transitions tunnel to active state, flushes queued messages.
   */
  private resolvePreviewWsOpened(msg: PreviewWsOpenedMessage): void {
    const tunnel = this.previewWsTunnels.get(msg.wsId);
    if (!tunnel) return;

    // Cancel open timeout
    if (tunnel.openTimer) {
      clearTimeout(tunnel.openTimer);
      tunnel.openTimer = null;
    }

    tunnel.state = 'active';

    // Flush queued messages to daemon
    for (const queued of tunnel.messageQueue) {
      const isBinary = (queued[0] & 0x01) !== 0;
      const payload = queued.subarray(1);
      if (this.daemonWs && this.authenticated) {
        try {
          this.daemonWs.send(packPreviewWsFrame(msg.wsId, isBinary, payload));
        } catch (err) {
          logger.warn({ serverId: this.serverId, wsId: msg.wsId, err }, 'Failed to flush queued WS message to daemon');
        }
      }
    }
    tunnel.messageQueue = [];
    tunnel.queueBytes = 0;

    // Start idle timer
    this.resetWsTunnelIdleTimer(msg.wsId);

    logger.info({ serverId: this.serverId, wsId: msg.wsId, previewId: tunnel.previewId, protocol: msg.protocol }, 'Preview WS tunnel active');
  }

  /**
   * Called when daemon sends preview.ws.error.
   * Closes browser WS with 1011 and cleans up.
   */
  private handlePreviewWsError(msg: PreviewWsErrorMessage): void {
    const tunnel = this.previewWsTunnels.get(msg.wsId);
    if (!tunnel) return;
    logger.warn({ serverId: this.serverId, wsId: msg.wsId, error: msg.error }, 'Preview WS tunnel error from daemon');
    try { tunnel.browserWs.close(1011, 'upstream error'); } catch { /* ignore */ }
    this.cleanupTunnel(msg.wsId);
  }

  /**
   * Called when daemon sends preview.ws.close.
   * Forwards close frame to browser WS and cleans up.
   */
  private handlePreviewWsClose(msg: PreviewWsCloseMessage): void {
    const tunnel = this.previewWsTunnels.get(msg.wsId);
    if (!tunnel) return;
    try { tunnel.browserWs.close(msg.code, msg.reason); } catch { /* ignore */ }
    this.cleanupTunnel(msg.wsId);
  }

  /**
   * Relay a WS_DATA frame from daemon to the browser WS.
   */
  private relayWsDataToBrowser(wsId: string, isBinary: boolean, payload: Buffer): void {
    const tunnel = this.previewWsTunnels.get(wsId);
    if (!tunnel || tunnel.state !== 'active') return;

    // Enforce max message size
    if (payload.length > PREVIEW_LIMITS.MAX_WS_MESSAGE_BYTES) {
      logger.warn({ serverId: this.serverId, wsId, size: payload.length }, 'Preview WS: daemon→browser message too large — closing with 1009');
      try { tunnel.browserWs.close(1009, 'message too large'); } catch { /* ignore */ }
      this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1009, reason: 'message too large' });
      this.cleanupTunnel(wsId);
      return;
    }

    this.resetWsTunnelIdleTimer(wsId);
    LocalWebPreviewRegistry.get(this.serverId).touch(tunnel.previewId);

    try {
      tunnel.browserWs.send(payload, { binary: isBinary });
    } catch (err) {
      logger.warn({ serverId: this.serverId, wsId, err }, 'Failed to relay WS_DATA to browser');
    }
  }

  /**
   * Handle message from browser on a WS tunnel connection.
   */
  private handleBrowserWsTunnelMessage(wsId: string, data: Buffer | string, isBinary: boolean): void {
    const tunnel = this.previewWsTunnels.get(wsId);
    if (!tunnel) return;

    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data as string);

    // Enforce max message size
    if (payload.length > PREVIEW_LIMITS.MAX_WS_MESSAGE_BYTES) {
      logger.warn({ serverId: this.serverId, wsId, size: payload.length }, 'Preview WS: browser→daemon message too large — closing with 1009');
      try { tunnel.browserWs.close(1009, 'message too large'); } catch { /* ignore */ }
      this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1009, reason: 'message too large' });
      this.cleanupTunnel(wsId);
      return;
    }

    if (tunnel.state === 'pending') {
      // Queue message while waiting for preview.ws.opened
      // Encode binary flag in first byte: 1=binary, 0=text
      const flagByte = Buffer.allocUnsafe(1);
      flagByte[0] = isBinary ? 1 : 0;
      const entry = Buffer.concat([flagByte, payload]);
      const newBytes = tunnel.queueBytes + entry.length;

      if (newBytes > PREVIEW_LIMITS.MAX_WS_PENDING_QUEUE_BYTES) {
        logger.warn({ serverId: this.serverId, wsId }, 'Preview WS: pending queue overflow — closing with 1008');
        try { tunnel.browserWs.close(1008, 'policy violation'); } catch { /* ignore */ }
        this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1008, reason: 'policy violation' });
        this.cleanupTunnel(wsId);
        return;
      }

      tunnel.messageQueue.push(entry);
      tunnel.queueBytes = newBytes;
      return;
    }

    // Active state — relay to daemon
    this.resetWsTunnelIdleTimer(wsId);
    LocalWebPreviewRegistry.get(this.serverId).touch(tunnel.previewId);

    if (this.daemonWs && this.authenticated) {
      try {
        this.daemonWs.send(packPreviewWsFrame(wsId, isBinary, payload));
      } catch (err) {
        logger.warn({ serverId: this.serverId, wsId, err }, 'Failed to relay browser WS message to daemon');
      }
    }
  }

  /**
   * Handle browser-side WS close on a tunnel connection.
   * Notifies daemon and cleans up.
   */
  private handleBrowserWsTunnelClose(wsId: string, code: number, reason: string): void {
    const tunnel = this.previewWsTunnels.get(wsId);
    if (!tunnel) return;
    this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code, reason });
    this.cleanupTunnel(wsId);
  }

  /**
   * Close all WS tunnels for a given previewId.
   * Called when the preview expires or is stopped.
   */
  closeAllPreviewWsForPreview(previewId: string): void {
    for (const [wsId, tunnel] of this.previewWsTunnels) {
      if (tunnel.previewId !== previewId) continue;
      try { tunnel.browserWs.close(1001, 'preview closed'); } catch { /* ignore */ }
      this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1001, reason: 'preview closed' });
      this.cleanupTunnel(wsId);
    }
  }

  /**
   * Close all WS tunnels. Called on daemon disconnect.
   */
  private closeAllPreviewWsTunnels(code: number, reason: string): void {
    for (const [wsId, tunnel] of this.previewWsTunnels) {
      try { tunnel.browserWs.close(code, reason); } catch { /* ignore */ }
      this.cleanupTunnel(wsId);
    }
  }

  /**
   * Clean up a single tunnel entry (timers, map removal).
   * Does NOT close the browserWs or send preview.ws.close — callers handle that.
   */
  private cleanupTunnel(wsId: string): void {
    const tunnel = this.previewWsTunnels.get(wsId);
    if (!tunnel) return;
    if (tunnel.idleTimer) { clearTimeout(tunnel.idleTimer); tunnel.idleTimer = null; }
    if (tunnel.openTimer) { clearTimeout(tunnel.openTimer); tunnel.openTimer = null; }
    this.previewWsTunnels.delete(wsId);
    this.maybeCleanup();
  }

  /**
   * Reset (or start) the idle timer for a tunnel.
   */
  private resetWsTunnelIdleTimer(wsId: string): void {
    const tunnel = this.previewWsTunnels.get(wsId);
    if (!tunnel) return;
    if (tunnel.idleTimer) clearTimeout(tunnel.idleTimer);
    tunnel.idleTimer = setTimeout(() => {
      const t = this.previewWsTunnels.get(wsId);
      if (!t) return;
      logger.info({ serverId: this.serverId, wsId, previewId: t.previewId }, 'Preview WS tunnel idle timeout — closing with 1000');
      try { t.browserWs.close(1000, 'idle timeout'); } catch { /* ignore */ }
      this.sendPreviewControl({ type: PREVIEW_MSG.WS_CLOSE, wsId, code: 1000, reason: 'idle timeout' });
      this.cleanupTunnel(wsId);
    }, PREVIEW_LIMITS.WS_IDLE_TIMEOUT_MS);
  }

  /**
   * Periodic cleanup: remove tunnel entries where browser WS is no longer open.
   * Defense-in-depth against missed close events.
   */
  sweepStaleTunnels(): void {
    for (const [wsId, tunnel] of this.previewWsTunnels) {
      if (tunnel.browserWs.readyState !== WebSocket.OPEN) {
        logger.info({ serverId: this.serverId, wsId }, 'Preview WS tunnel sweep: removing stale entry');
        this.cleanupTunnel(wsId);
      }
    }
  }

  /** Count WS tunnels for a given previewId. Used by route to enforce per-preview limit. */
  getPreviewWsCount(previewId: string): number {
    let count = 0;
    for (const tunnel of this.previewWsTunnels.values()) {
      if (tunnel.previewId === previewId) count++;
    }
    return count;
  }

  /** Total WS tunnel count across all previews. Used by route to enforce per-server limit. */
  getServerWsCount(): number {
    return this.previewWsTunnels.size;
  }

  // ── Push notifications ──────────────────────────────────────────────────────

  /** Dedup: last push timestamp per session to avoid duplicate notifications. */
  private lastPushAt = new Map<string, number>();
  private static readonly PUSH_DEDUP_MS = 10_000;

  private async resolveReadablePushDisplay(
    db: Database,
    sessionName: string,
    daemonLabel: string | undefined,
    daemonParentLabel: string | undefined,
    daemonProject: string | undefined,
  ): Promise<{
    displayName: string;
    agentType?: string;
  }> {
    const visited = new Set<string>();
    const activeMainSession = this.activeMainSessions.get(sessionName);
    let effectiveAgentType = pickReadableSessionDisplay([activeMainSession?.agentType], sessionName);
    let currentSessionName: string | undefined = sessionName;
    let displayName = pickReadableSessionDisplay([daemonLabel], sessionName);

    while (currentSessionName && !visited.has(currentSessionName)) {
      visited.add(currentSessionName);

      const active = this.activeMainSessions.get(currentSessionName);
      const activeSubSession = this.activeSubSessions.get(currentSessionName);
      let sessionRow = await db.queryOne<{ project_name: string; agent_type: string; label: string | null }>(
        'SELECT project_name, agent_type, label FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
        [this.serverId, currentSessionName],
      ).catch(() => null);

      let parentSession: string | undefined;
      let subType: string | undefined;
      if (activeSubSession) {
        subType = activeSubSession.agentType;
        parentSession = activeSubSession.parentSession;
        const activeSubDisplay = pickReadableSessionDisplay([activeSubSession.label], currentSessionName);
        if (!displayName && activeSubDisplay) displayName = activeSubDisplay;
      }
      if (!sessionRow && currentSessionName.startsWith('deck_sub_')) {
        const subRow: { type: string; label: string | null; parent_session: string | null } | null = await db
          .queryOne<{ type: string; label: string | null; parent_session: string | null }>(
            'SELECT type, label, parent_session FROM sub_sessions WHERE server_id = $1 AND id = $2 LIMIT 1',
            [this.serverId, currentSessionName.replace(/^deck_sub_/, '')],
          )
          .catch(() => null);
        if (subRow) {
          subType = subRow.type;
          parentSession = subRow.parent_session ?? undefined;
          const subDisplay = pickReadableSessionDisplay([subRow.label], currentSessionName);
          if (!displayName && subDisplay) displayName = subDisplay;
        }
      }

      effectiveAgentType = effectiveAgentType
        || subType
        || active?.agentType
        || sessionRow?.agent_type
        || undefined;

      if (!displayName) {
        const candidate = pickReadableSessionDisplay(
          [
            active?.label,
            sessionRow?.label,
            active?.project,
            sessionRow?.project_name,
          ],
          currentSessionName,
        );
        if (candidate) displayName = candidate;
      }

      if (displayName) break;
      currentSessionName = parentSession;
    }

    displayName = displayName
      || pickReadableSessionDisplay([activeMainSession?.label, activeMainSession?.project, daemonParentLabel, daemonProject], sessionName)
      || sessionName;

    return {
      displayName,
      ...(effectiveAgentType ? { agentType: effectiveAgentType } : {}),
    };
  }

  private async dispatchEventPush(db: Database, env: Env, msg: Record<string, unknown>): Promise<void> {
    // Always send APNs push — iOS handles foreground display via UNUserNotificationCenterDelegate.
    // Badge count must increment regardless of app state.

    // Dedup: same session idle/error can fire from both hook and timeline paths
    const sessionKey = `${msg.type}:${msg.session ?? msg.sessionId ?? ''}`;
    const now = Date.now();
    const lastPush = this.lastPushAt.get(sessionKey);
    if (lastPush && now - lastPush < WsBridge.PUSH_DEDUP_MS) return;
    this.lastPushAt.set(sessionKey, now);

    const server = await db.queryOne<{ user_id: string; name: string }>('SELECT user_id, name FROM servers WHERE id = $1', [this.serverId]);
    if (!server) return;

    const { dispatchPush } = await import('../routes/push.js').catch((err) => {
      logger.error({ err }, 'Failed to import push module — push notifications disabled');
      return { dispatchPush: null };
    });
    if (!dispatchPush) return;

    const sessionName = String(msg.session ?? msg.sessionId ?? '');
    const eventType = String(msg.type ?? '');
    const daemonLabel = msg.label ? String(msg.label) : undefined;
    const daemonParentLabel = msg.parentLabel ? String(msg.parentLabel) : undefined;
    const daemonProject = msg.project ? String(msg.project) : undefined;
    const resolved = await this.resolveReadablePushDisplay(db, sessionName, daemonLabel, daemonParentLabel, daemonProject);
    const displayName = resolved.displayName;
    const agentType = resolved.agentType || String(msg.agentType ?? '');
    const titleParts = [server.name, displayName];
    if (agentType) titleParts.push(agentType);
    const lastText = String(msg.lastText ?? msg.message ?? '').slice(0, 200);

    let title: string;
    let body: string;
    switch (eventType) {
      case 'session.idle':
        title = titleParts.join(' · ');
        body = lastText || 'Task complete — ready for input';
        break;
      case 'session.notification': {
        title = titleParts.join(' · ');
        body = String(msg.message ?? 'Notification');
        break;
      }
      case 'session.error':
        title = titleParts.join(' · ');
        body = `Error: ${String(msg.error ?? 'unknown')}`;
        break;
      case 'ask.question':
        title = titleParts.join(' · ');
        body = lastText || 'Waiting for your answer';
        break;
      default:
        return;
    }

    await dispatchPush({
      userId: server.user_id,
      title,
      body,
      data: { serverId: this.serverId, session: sessionName, type: eventType },
    }, env);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private getBrowserId(ws: WebSocket): string {
    const id = (ws as WebSocket & { _bridgeId?: string })._bridgeId
      ?? ((ws as WebSocket & { _bridgeId?: string })._bridgeId = Math.random().toString(36).slice(2));
    return id;
  }

  private maybeCleanup(): void {
    if (!this.daemonWs && this.browserSockets.size === 0 && this.previewWsTunnels.size === 0) {
      this.browserRateLimiter.stop();
      WsBridge.instances.delete(this.serverId);
    }
  }

  get browserCount(): number {
    return this.browserSockets.size;
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }
}
