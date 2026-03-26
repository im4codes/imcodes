/**
 * WsBridge: per-server WebSocket bridge between daemon and browser clients.
 * Replaces the CF DaemonBridge Durable Object.
 *
 * Binary routing: daemon binary raw frames are routed only to browsers
 * subscribed to the target session (not broadcast). Subscription state is
 * tracked by intercepting terminal.subscribe/unsubscribe browser messages.
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
import { REPO_RELAY_TYPES } from '../../../shared/repo-types.js';
import { TRANSPORT_RELAY_TYPES, TRANSPORT_MSG } from '../../../shared/transport-events.js';
import { updateServerHeartbeat, updateServerStatus, upsertDiscussion, insertDiscussionRound, createSubSession, updateSubSession, upsertOrchestrationRun, updateProviderStatus, clearProviderStatus, updateProviderRemoteSessions } from '../db/queries.js';
import logger from '../util/logger.js';

const AUTH_TIMEOUT_MS = 5000;
const MAX_QUEUE_SIZE = 100;
const MAX_BROWSER_PAYLOAD = 65536; // 64KB (subsession.rebuild_all can include many sessions)
const BROWSER_RATE_LIMIT = 30;    // messages
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

// ── WsBridge ─────────────────────────────────────────────────────────────────

export class WsBridge {
  private static instances = new Map<string, WsBridge>();

  private daemonWs: WebSocket | null = null;
  private authenticated = false;
  private daemonVersion: string | null = null;
  private browserSockets = new Set<WebSocket>();
  private mobileSockets = new Set<WebSocket>();
  private queue: string[] = [];
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private browserRateLimiter = new MemoryRateLimiter();

  /** browser socket → set of subscribed session names */
  private browserSubscriptions = new Map<WebSocket, Set<string>>();

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

  /**
   * File transfer correlation: requestId → { resolve, reject, timer }.
   * Used by HTTP upload/download handlers to await daemon responses.
   */
  private pendingFileTransfers = new Map<string, {
    resolve: (msg: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /**
   * Per-session daemon subscription reference count.
   * Forward terminal.subscribe to daemon only on 0→1.
   * Forward terminal.unsubscribe to daemon only on 1→0 (including on browser disconnect).
   */
  private daemonSessionRefs = new Map<string, number>();

  /**
   * Per-(session, browser) forwarding queues.
   * Used for both terminal_update (snapshot JSON) and binary raw frames.
   * session → browser → queue
   */
  private terminalQueues = new Map<string, Map<WebSocket, TerminalForwardQueue>>();

  private constructor(private serverId: string) {}

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
        logger.info({ serverId: this.serverId }, 'Daemon authenticated');
        onAuthenticated?.();

        updateServerHeartbeat(db, this.serverId, this.daemonVersion).catch((err) =>
          logger.error({ err }, 'Failed to update heartbeat on auth'),
        );

        // Replay queued messages, skipping terminal.subscribe — refs replay below is authoritative
        for (const queued of this.queue) {
          try {
            const parsed = JSON.parse(queued) as { type?: string };
            if (parsed.type === 'terminal.subscribe') continue;
            ws.send(queued);
          } catch { /* ignore */ }
        }
        this.queue = [];

        this.broadcastToBrowsers(JSON.stringify({ type: 'daemon.reconnected' }));

        // Re-subscribe daemon to all sessions that still have active browser subscribers
        for (const [sessionName, refs] of this.daemonSessionRefs) {
          if (refs > 0) {
            try { ws.send(JSON.stringify({ type: 'terminal.subscribe', session: sessionName })); } catch { /* ignore */ }
          }
        }

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
        this.rejectAllPendingFileTransfers('daemon_disconnected');
        // Clear provider statuses — daemon is gone, providers are unreachable
        for (const [providerId] of this.providerStatus) {
          this.broadcastToBrowsers(JSON.stringify({ type: TRANSPORT_MSG.PROVIDER_STATUS, providerId, connected: false }));
        }
        this.providerStatus.clear();
        this.broadcastToBrowsers(JSON.stringify({ type: 'daemon.disconnected' }));
        void clearProviderStatus(db, this.serverId).catch(() => {});
        updateServerStatus(db, this.serverId, 'offline').catch((err) =>
          logger.error({ err }, 'Failed to mark server offline'),
        );
      }
      this.maybeCleanup();
    });

    ws.on('error', (err) => {
      logger.error({ serverId: this.serverId, err }, 'Daemon WS error');
      this.rejectAllPendingFileTransfers('daemon_error');
    });
  }

  // ── Browser connection ─────────────────────────────────────────────────────

  handleBrowserConnection(ws: WebSocket, userId: string, db: Database, isMobile = false): void {
    this.db = db;
    this.browserSockets.add(ws);
    if (isMobile) this.mobileSockets.add(ws);
    this.browserSubscriptions.set(ws, new Set());
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

      // Rate limit — exempt repo.detect (low-volume, critical for UI, easily dropped during init burst)
      if (msg.type !== 'repo.detect') {
        const browserId = this.getBrowserId(ws);
        if (!this.browserRateLimiter.check(browserId, BROWSER_RATE_LIMIT, BROWSER_RATE_WINDOW)) {
          logger.warn({ serverId: this.serverId, type: msg.type }, 'Browser rate limit exceeded — dropped');
          return;
        }
      }

      if (typeof msg.type !== 'string') {
        return;
      }

      // Track fs.ls requests for single-cast response routing
      if (msg.type === 'fs.ls' && typeof msg.requestId === 'string') {
        const reqId = msg.requestId;
        const timer = setTimeout(() => this.pendingFsRequests.delete(reqId), 30_000);
        this.pendingFsRequests.set(reqId, { socket: ws, timer });
      }

      // Track fs.read requests for single-cast response routing
      if (msg.type === 'fs.read' && typeof msg.requestId === 'string') {
        const reqId = msg.requestId;
        const timer = setTimeout(() => this.pendingFsReadRequests.delete(reqId), 30_000);
        this.pendingFsReadRequests.set(reqId, { socket: ws, timer });
      }

      // Track fs.git_status requests for single-cast response routing
      if (msg.type === 'fs.git_status' && typeof msg.requestId === 'string') {
        const reqId = msg.requestId;
        const timer = setTimeout(() => this.pendingFsGitStatusRequests.delete(reqId), 30_000);
        this.pendingFsGitStatusRequests.set(reqId, { socket: ws, timer });
      }

      // Track fs.git_diff requests for single-cast response routing
      if (msg.type === 'fs.git_diff' && typeof msg.requestId === 'string') {
        const reqId = msg.requestId;
        const timer = setTimeout(() => this.pendingFsGitDiffRequests.delete(reqId), 30_000);
        this.pendingFsGitDiffRequests.set(reqId, { socket: ws, timer });
      }

      // Track file.search requests for single-cast response routing
      if (msg.type === 'file.search' && typeof msg.requestId === 'string') {
        const reqId = msg.requestId;
        const timer = setTimeout(() => this.pendingFileSearchRequests.delete(reqId), 30_000);
        this.pendingFileSearchRequests.set(reqId, { socket: ws, timer });
      }

      // Track terminal subscriptions for binary routing + ref-counted daemon forwarding
      if (msg.type === 'terminal.subscribe' && typeof msg.session === 'string') {
        const sessionName = msg.session;
        void this.verifySessionOwnership(sessionName).then((allowed) => {
          if (!allowed) {
            logger.warn({ serverId: this.serverId, sessionName }, 'terminal.subscribe: session not owned by this server — rejected');
            return;
          }
          this.addBrowserSessionSubscription(ws, sessionName, raw);
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
   * Relay a daemon→browser message using a strict default-deny routing policy.
   *
   * Rules:
   *  - Session-scoped types MUST carry a session identifier. If missing → discard + warn.
   *  - Only explicitly whitelisted types may be broadcast to all browsers.
   *  - Any unrecognised type is discarded (never broadcast).
   *
   * Broadcast whitelist: session_list, session_event, daemon.reconnected
   * Session-scoped:      terminal_update, timeline.*, command.ack,
   *                      subsession.response, session.idle/notification/tool
   */
  private relayToBrowsers(msg: Record<string, unknown>): void {
    const type = msg.type as string;

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
      this.sendToSessionSubscribers(sessionId, JSON.stringify(msg));
      return;
    }

    // Timeline history/replay contain all CC conversation content — MUST NOT broadcast.
    if (type === 'timeline.history' || type === 'timeline.replay') {
      const sessionName = msg.sessionName as string | undefined;
      if (!sessionName) {
        logger.warn({ serverId: this.serverId, type }, 'timeline message missing sessionName — discarded');
        return;
      }
      this.sendToSessionSubscribers(sessionName, JSON.stringify(msg));
      return;
    }

    // ── Command & subsession: session-scoped ──────────────────────────────────
    if (type === 'command.ack') {
      const sessionName = msg.session as string | undefined;
      if (!sessionName) {
        logger.warn({ serverId: this.serverId }, 'command.ack missing session — discarded');
        return;
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
          state: 'running',
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
          [Date.now(), id, this.serverId]).catch(() => {});
        this.broadcastToBrowsers(JSON.stringify({ type: 'subsession.removed', id, sessionName: msg.sessionName }));
      }
      return;
    }

    // ── P2P conflict → broadcast to browsers ────────────────────────────────
    if (type === 'p2p.conflict') {
      this.broadcastToBrowsers(JSON.stringify(msg));
      return;
    }

    // ── P2P orchestration run persistence + broadcast ────────────────────────
    if (type === 'p2p.run_save' && this.db) {
      void upsertOrchestrationRun(this.db, msg.run as any).catch(() => {});
      this.broadcastToBrowsers(JSON.stringify({ type: 'p2p.run_update', run: msg.run }));
      return;
    }
    if (type === 'p2p.run_complete' && this.db) {
      const run = msg.run as any;
      run.status = 'completed';
      run.completed_at = new Date().toISOString();
      void upsertOrchestrationRun(this.db, run).catch(() => {});
      this.broadcastToBrowsers(JSON.stringify({ type: 'p2p.run_update', run }));
      return;
    }
    if (type === 'p2p.run_error' && this.db) {
      const run = msg.run as any;
      run.updated_at = new Date().toISOString();
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

    // ── P2P discussion list/read responses → broadcast to browsers ────────────
    if (type === 'p2p.list_discussions_response' || type === 'p2p.read_discussion_response') {
      this.broadcastToBrowsers(JSON.stringify(msg));
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

    // ── Default-deny: unknown type → discard ──────────────────────────────────
    logger.warn({ serverId: this.serverId, type }, 'relayToBrowsers: unknown message type — discarded (default-deny)');
  }

  private routeBinaryFrame(data: Buffer): void {
    const sessionName = parseRawFrameSession(data);
    if (!sessionName) {
      logger.warn({ serverId: this.serverId }, 'Binary frame: invalid v1 header');
      return;
    }
    this.sendToSessionSubscribers(sessionName, data);
  }

  private sendToSessionSubscribers(sessionName: string, data: string | Buffer): void {
    for (const [ws, sessions] of this.browserSubscriptions) {
      if (!sessions.has(sessionName)) continue;
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
   * Add a browser subscription for sessionName.
   * Forwards terminal.subscribe to daemon only on 0→1 transition.
   * rawMsg is the original JSON string to forward on 0→1.
   */
  private addBrowserSessionSubscription(ws: WebSocket, sessionName: string, rawMsg: string): void {
    const subs = this.browserSubscriptions.get(ws);
    if (!subs || subs.has(sessionName)) return; // already subscribed
    subs.add(sessionName);

    const prev = this.daemonSessionRefs.get(sessionName) ?? 0;
    this.daemonSessionRefs.set(sessionName, prev + 1);

    if (prev === 0) {
      // First browser subscriber — tell daemon to start streaming
      this.sendToDaemon(rawMsg);
    }
  }

  /**
   * Remove a browser subscription for sessionName.
   * Forwards terminal.unsubscribe to daemon only on 1→0 transition.
   */
  private removeBrowserSessionSubscription(ws: WebSocket, sessionName: string): void {
    const subs = this.browserSubscriptions.get(ws);
    if (!subs?.has(sessionName)) return; // not subscribed
    subs.delete(sessionName);

    this.terminalQueues.get(sessionName)?.delete(ws);
    if (this.terminalQueues.get(sessionName)?.size === 0) {
      this.terminalQueues.delete(sessionName);
    }

    const prev = this.daemonSessionRefs.get(sessionName) ?? 0;
    const next = Math.max(0, prev - 1);
    if (next === 0) {
      this.daemonSessionRefs.delete(sessionName);
      // Last browser unsubscribed — tell daemon to stop streaming
      this.sendToDaemon(JSON.stringify({ type: 'terminal.unsubscribe', session: sessionName }));
    } else {
      this.daemonSessionRefs.set(sessionName, next);
    }
  }

  private cleanupBrowserSocket(ws: WebSocket): void {
    this.browserSockets.delete(ws);
    this.mobileSockets.delete(ws);
    this.browserUserIds.delete(ws);
    const sessions = this.browserSubscriptions.get(ws);
    if (sessions) {
      for (const sessionName of [...sessions]) {
        // Use removeBrowserSessionSubscription to correctly handle ref counting + daemon notify
        this.removeBrowserSessionSubscription(ws, sessionName);
      }
    }
    this.browserSubscriptions.delete(ws);
    this.transportSubscriptions.delete(ws);
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

  // ── Push notifications ──────────────────────────────────────────────────────

  /** Dedup: last push timestamp per session to avoid duplicate notifications. */
  private lastPushAt = new Map<string, number>();
  private static readonly PUSH_DEDUP_MS = 10_000;

  private async dispatchEventPush(db: Database, env: Env, msg: Record<string, unknown>): Promise<void> {
    // Skip push if mobile app is in foreground (user is actively watching)
    if (this.mobileSockets.size > 0) return;

    // Dedup: same session idle/error can fire from both hook and timeline paths
    const sessionKey = `${msg.type}:${msg.session ?? msg.sessionId ?? ''}`;
    const now = Date.now();
    const lastPush = this.lastPushAt.get(sessionKey);
    if (lastPush && now - lastPush < WsBridge.PUSH_DEDUP_MS) return;
    this.lastPushAt.set(sessionKey, now);

    const server = await db.queryOne<{ user_id: string; name: string }>('SELECT user_id, name FROM servers WHERE id = $1', [this.serverId]);
    if (!server) return;

    const { dispatchPush } = await import('../routes/push.js').catch(() => ({ dispatchPush: null }));
    if (!dispatchPush) return;

    const sessionName = String(msg.session ?? msg.sessionId ?? '');
    const eventType = String(msg.type ?? '');

    // Look up session metadata for human-readable push content
    const sessionRow = await db.queryOne<{ project_name: string; agent_type: string; label: string | null }>(
      'SELECT project_name, agent_type, label FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1',
      [this.serverId, sessionName],
    ).catch(() => null);

    const displayName = sessionRow?.label || sessionRow?.project_name || sessionName;
    const agentType = sessionRow?.agent_type ?? '';
    const agentLabel = agentType ? ` (${agentType})` : '';
    const lastText = String(msg.lastText ?? msg.message ?? '').slice(0, 200);

    let title: string;
    let body: string;
    switch (eventType) {
      case 'session.idle':
        title = `${server.name} · ${displayName}${agentLabel}`;
        body = lastText || 'Task complete — ready for input';
        break;
      case 'session.notification': {
        title = `${server.name} · ${displayName}`;
        body = String(msg.message ?? 'Notification');
        break;
      }
      case 'session.error':
        title = `${server.name} · ${displayName}`;
        body = `Error: ${String(msg.error ?? 'unknown')}`;
        break;
      case 'ask.question':
        title = `${server.name} · ${displayName}${agentLabel}`;
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
    if (!this.daemonWs && this.browserSockets.size === 0) {
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
