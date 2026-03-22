/**
 * WebSocket client for terminal stream + session commands.
 * Handles auth, reconnect, and message dispatch.
 */
import type { TerminalDiff } from './types.js';
import { apiFetch } from './api.js';
import type { TimelineEvent } from '../../src/shared/timeline/types.js';
import type {
  FsLsResponse,
  FsReadResponse,
  FsGitStatusResponse,
  FsGitDiffResponse,
} from '../../src/shared/transport/fs.js';

export type MessageHandler = (msg: ServerMessage) => void;

export type ServerMessage =
  | { type: 'terminal.diff'; diff: TerminalDiff }
  | { type: 'terminal.history'; sessionName: string; content: string }
  | { type: 'terminal.stream_reset'; session: string; reason: string }
  | { type: 'session.event'; event: string; session: string; state: string }
  | { type: 'session.error'; project: string; message: string }
  | { type: 'session.idle'; session: string; project: string; agentType: string }
  | { type: 'session.notification'; session: string; project: string; title: string; message: string }
  | { type: 'session.tool'; session: string; tool: string | null }
  | { type: 'daemon.reconnected' }
  | { type: 'daemon.disconnected' }
  | { type: 'session_list'; daemonVersion?: string | null; sessions: Array<{ name: string; project: string; role: string; agentType: string; agentVersion?: string; state: string }> }
  | { type: 'outbound'; platform: string; channelId: string; content: string }
  | { type: 'timeline.event'; event: TimelineEvent }
  | { type: 'timeline.replay'; sessionName: string; requestId?: string; events: TimelineEvent[]; truncated: boolean; epoch: number }
  | { type: 'timeline.history'; sessionName: string; requestId?: string; events: TimelineEvent[]; epoch: number }
  | { type: 'command.ack'; commandId: string; status: string; session: string }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  | { type: 'subsession.shells'; shells: string[] }
  | { type: 'subsession.response'; sessionName: string; status: 'working' | 'idle'; response?: string }
  | { type: 'discussion.started'; requestId?: string; discussionId: string; topic: string; maxRounds: number; filePath: string; participants: Array<{ sessionName: string; roleLabel: string; agentType: string; model?: string }> }
  | { type: 'discussion.update'; discussionId: string; state: string; currentRound: number; maxRounds: number; currentSpeaker?: string; lastResponse?: string }
  | { type: 'discussion.done'; discussionId: string; filePath: string; conclusion: string }
  | { type: 'discussion.error'; discussionId?: string; requestId?: string; error: string }
  | { type: 'discussion.list'; discussions: Array<{ id: string; topic: string; state: string; currentRound: number; maxRounds: number; currentSpeaker?: string; conclusion?: string; filePath?: string }> }
  | { type: 'daemon.stats'; daemonVersion?: string | null; cpu: number; memUsed: number; memTotal: number; load1: number; load5: number; load15: number; uptime: number }
  | FsLsResponse
  | FsReadResponse
  | FsGitStatusResponse
  | { type: 'file.search_response'; requestId: string; results: string[]; error?: string }
  | { type: 'p2p.run_update'; run: any }
  | { type: 'p2p.conflict'; existingRunId: string; initiatorSession: string; commandId: string }
  | { type: 'p2p.run_started'; runId: string; session: string }
  | { type: 'p2p.cancel_response'; runId: string; ok: boolean }
  | { type: 'p2p.status_response'; runId?: string; run?: any; runs?: any[] }
  | { type: 'p2p.list_discussions_response'; discussions: Array<{ id: string; fileName: string; preview: string; mtime: number }> }
  | { type: 'p2p.read_discussion_response'; id?: string; content?: string; error?: string }
  | FsGitDiffResponse
  | { type: 'repo.detect_response'; requestId: string; projectDir: string; context: any }
  | { type: 'repo.issues_response'; requestId: string; projectDir: string; items: any[]; page: number; hasMore: boolean }
  | { type: 'repo.prs_response'; requestId: string; projectDir: string; items: any[]; page: number; hasMore: boolean }
  | { type: 'repo.branches_response'; requestId: string; projectDir: string; items: any[]; page: number; hasMore: boolean }
  | { type: 'repo.commits_response'; requestId: string; projectDir: string; items: any[]; page: number; hasMore: boolean }
  | { type: 'repo.error'; requestId: string; projectDir?: string; error: string }
  | { type: 'repo.detected'; projectDir: string; context: any };

export type {
  TimelineEvent,
} from '../../src/shared/timeline/types.js';

export type {
  FsEntry,
  GitStatusEntry,
  FsLsResponse,
  FsReadResponse,
  FsGitStatusResponse,
  FsGitDiffResponse,
} from '../../src/shared/transport/fs.js';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_MS = 25000;

export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private baseUrl: string;
  private serverId: string;
  private _connected = false;
  private _connecting = false;
  private _destroyed = false;
  private _pingLatency: number | null = null;
  private _pingSentAt: number | null = null;
  private _onLatency: ((ms: number) => void) | null = null;

  /** Per-session callbacks for raw PTY binary frames. Supports multiple subscribers per session. */
  private _terminalRawHandlers = new Map<string, Set<(data: Uint8Array) => void>>();

  /** Per-session stream reset recovery state. */
  private resetState = new Map<string, {
    count: number;
    windowStart: number;
    retryCount: number;
    inCooldown: boolean;
    retryTimer: ReturnType<typeof setTimeout> | null;
  }>();

  constructor(baseUrl: string, serverId: string) {
    this.baseUrl = baseUrl;
    this.serverId = serverId;
  }

  get connected(): boolean {
    return this._connected;
  }

  get connecting(): boolean {
    return this._connecting || (!this._connected && !this._destroyed && this.reconnectTimer !== null);
  }

  get pingLatency(): number | null {
    return this._pingLatency;
  }

  /** Register a callback for latency updates (called on every pong). */
  onLatency(fn: ((ms: number) => void) | null): void {
    this._onLatency = fn;
  }

  /** Register a per-session callback for raw PTY binary frames. Returns an unsubscribe function. */
  onTerminalRaw(sessionName: string, fn: (data: Uint8Array) => void): () => void {
    let handlers = this._terminalRawHandlers.get(sessionName);
    if (!handlers) {
      handlers = new Set();
      this._terminalRawHandlers.set(sessionName, handlers);
    }
    handlers.add(fn);
    return () => {
      const set = this._terminalRawHandlers.get(sessionName);
      if (set) {
        set.delete(fn);
        if (set.size === 0) this._terminalRawHandlers.delete(sessionName);
      }
    };
  }

  connect(): void {
    if (this.ws) return;
    void this.openSocket();
  }

  disconnect(): void {
    this._destroyed = true;
    this._connecting = false;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
    this._connected = false;
  }

  send(msg: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    const json = JSON.stringify(msg);
    if (json.length > 60_000) {
      throw new Error('Message too large');
    }
    this.ws.send(json);
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscribeTerminal(sessionName: string): void {
    if (!this._connected) return;
    this.send({ type: 'terminal.subscribe', session: sessionName });
  }

  unsubscribeTerminal(sessionName: string): void {
    if (!this._connected) return;
    this.send({ type: 'terminal.unsubscribe', session: sessionName });
  }

  sendSessionCommand(command: 'start' | 'stop' | 'send' | 'restart', payload: object = {}): void {
    this.send({ type: `session.${command}`, ...payload });
  }

  /**
   * Send session.send command with an auto-generated commandId for dedup/ack.
   * Only session.send injects commandId — session.input does not.
   */
  sendSessionMessage(sessionName: string, text: string): void {
    const commandId = crypto.randomUUID();
    this.send({ type: 'session.send', sessionName, text, commandId });
  }

  /** Send raw keyboard input (from xterm onData) to a tmux session. */
  sendInput(sessionName: string, data: string): void {
    this.send({ type: 'session.input', sessionName, data });
  }

  /** Notify the daemon that the terminal viewport has been resized. */
  sendResize(sessionName: string, cols: number, rows: number): void {
    if (!this._connected) return;
    this.send({ type: 'session.resize', sessionName, cols, rows });
  }

  /** Request the current session list from the daemon. */
  requestSessionList(): void {
    this.send({ type: 'get_sessions' });
  }

  // ── Sub-session commands ──────────────────────────────────────────────────

  subSessionStart(id: string, sessionType: string, shellBin?: string, cwd?: string, ccSessionId?: string, parentSession?: string | null): void {
    this.send({ type: 'subsession.start', id, sessionType, shellBin, cwd, ccSessionId, parentSession });
  }

  subSessionStop(sessionName: string): void {
    this.send({ type: 'subsession.stop', sessionName });
  }

  subSessionRebuildAll(subSessions: Array<{ id: string; type: string; shellBin?: string | null; cwd?: string | null; ccSessionId?: string | null; geminiSessionId?: string | null; parentSession?: string | null }>): void {
    this.send({ type: 'subsession.rebuild_all', subSessions });
  }

  subSessionDetectShells(): void {
    this.send({ type: 'subsession.detect_shells' });
  }

  subSessionReadResponse(sessionName: string): void {
    this.send({ type: 'subsession.read_response', sessionName });
  }

  subSessionSetModel(sessionName: string, model: string, cwd?: string): void {
    this.send({ type: 'subsession.set_model', sessionName, model, cwd });
  }

  askAnswer(sessionName: string, answer: string): void {
    this.send({ type: 'ask.answer', sessionName, answer });
  }

  // ── Discussion commands ────────────────────────────────────────────────────

  discussionStart(
    topic: string,
    cwd: string,
    participants: Array<{
      agentType: string;
      model?: string;
      roleId: string;
      roleLabel?: string;
      rolePrompt?: string;
      sessionName?: string;
    }>,
    maxRounds?: number,
    verdictIdx?: number,
  ): void {
    const requestId = crypto.randomUUID();
    this.send({ type: 'discussion.start', requestId, topic, cwd, participants, maxRounds, verdictIdx });
  }

  discussionStatus(discussionId: string): void {
    const requestId = crypto.randomUUID();
    this.send({ type: 'discussion.status', discussionId, requestId });
  }

  discussionStop(discussionId: string): void {
    this.send({ type: 'discussion.stop', discussionId });
  }

  discussionList(): void {
    this.send({ type: 'discussion.list' });
  }

  /** Request timeline event replay from the daemon for reconnection gap-fill. */
  sendTimelineReplayRequest(sessionName: string, afterSeq: number, epoch: number): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'timeline.replay_request', sessionName, afterSeq, epoch, requestId });
    return requestId;
  }

  /** Request a terminal snapshot (fullFrame) for a session. */
  sendSnapshotRequest(sessionName: string): void {
    this.send({ type: 'terminal.snapshot_request', sessionName });
  }

  /** Request a directory listing from the daemon. Returns the requestId for matching the response. */
  fsListDir(path: string, includeFiles = false, includeMetadata = false): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'fs.ls', path, requestId, includeFiles, includeMetadata });
    return requestId;
  }

  /** Request a file's content from the daemon. Returns the requestId for matching the response. */
  fsReadFile(path: string): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'fs.read', path, requestId });
    return requestId;
  }

  /** Create a directory on the daemon. Returns requestId. */
  fsMkdir(path: string): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'fs.mkdir', path, requestId });
    return requestId;
  }

  /** Request git status for a directory. Returns requestId. */
  fsGitStatus(path: string): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'fs.git_status', path, requestId });
    return requestId;
  }

  /** Request git diff for a file. Returns requestId. */
  fsGitDiff(path: string): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'fs.git_diff', path, requestId });
    return requestId;
  }

  // ── Repo commands ──────────────────────────────────────────────────────────

  /** Detect repo context for a project directory. Returns requestId. */
  repoDetect(projectDir: string, opts?: { force?: boolean }): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'repo.detect', requestId, projectDir, ...(opts?.force ? { force: true } : {}) });
    return requestId;
  }

  /** List issues for a project. Returns requestId. */
  repoListIssues(projectDir: string, opts?: { state?: string; page?: number; force?: boolean }): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'repo.list_issues', requestId, projectDir, ...opts });
    return requestId;
  }

  /** List pull requests for a project. Returns requestId. */
  repoListPRs(projectDir: string, opts?: { state?: string; page?: number; force?: boolean }): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'repo.list_prs', requestId, projectDir, ...opts });
    return requestId;
  }

  /** List branches for a project. Returns requestId. */
  repoListBranches(projectDir: string): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'repo.list_branches', requestId, projectDir });
    return requestId;
  }

  /** List commits for a project. Returns requestId. */
  repoListCommits(projectDir: string, opts?: { branch?: string; page?: number }): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'repo.list_commits', requestId, projectDir, ...opts });
    return requestId;
  }

  /** Request full timeline history for a session (used on first load / daemon reconnect).
   *  afterTs: client's latest known event timestamp — server returns only newer events.
   *  beforeTs: for backward pagination — server returns only older events. */
  sendTimelineHistoryRequest(sessionName: string, limit = 500, afterTs?: number, beforeTs?: number): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'timeline.history_request', sessionName, requestId, limit, ...(afterTs !== undefined ? { afterTs } : {}), ...(beforeTs !== undefined ? { beforeTs } : {}) });
    return requestId;
  }

  private async openSocket(): Promise<void> {
    if (this._connecting) return;
    this._connecting = true;

    const wsUrl = this.baseUrl
      .replace(/^http/, 'ws')
      .replace(/\/$/, '');

    // Get a short-lived ws-ticket before connecting.
    let ticket: string;
    try {
      const data = await apiFetch<{ ticket: string }>('/api/auth/ws-ticket', {
        method: 'POST',
        body: JSON.stringify({ serverId: this.serverId }),
      });
      ticket = data.ticket;
    } catch {
      this._connecting = false;
      this.scheduleReconnect();
      return;
    }

    if (this._destroyed) {
      this._connecting = false;
      return;
    }

    const url = `${wsUrl}/api/server/${this.serverId}/terminal?ticket=${encodeURIComponent(ticket)}`;

    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this._connecting = false;

    this.ws.addEventListener('open', () => {
      this._connected = true;
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.dispatch({ type: 'session.event', event: 'connected', session: '', state: 'connected' });
    });

    this.ws.addEventListener('message', (ev) => {
      // Binary frame: raw PTY data
      if (ev.data instanceof ArrayBuffer) {
        this.handleRawFrame(ev.data);
        return;
      }

      try {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        if (msg.type === 'pong') {
          if (this._pingSentAt !== null) {
            this._pingLatency = Date.now() - this._pingSentAt;
            this._pingSentAt = null;
            this._onLatency?.(this._pingLatency);
          }
          return;
        }
        if (msg.type === 'terminal.stream_reset') {
          this.handleStreamReset(msg.session);
          this.dispatch(msg); // Let TerminalView know to reset terminal state
          return;
        }
        this.dispatch(msg);
      } catch {
        // ignore parse errors
      }
    });

    this.ws.addEventListener('close', () => {
      const wasConnected = this._connected;
      this._connected = false;
      this._connecting = false;
      this.ws = null;
      this.clearTimers();
      if (wasConnected) {
        this.dispatch({ type: 'session.event', event: 'disconnected', session: '', state: 'disconnected' });
      }
      if (!this._destroyed) this.scheduleReconnect();
    });

    this.ws.addEventListener('error', () => {
      this.ws?.close();
    });
  }

  /** Parse and dispatch a binary raw PTY frame (v1 protocol). */
  private handleRawFrame(buf: ArrayBuffer): void {
    const data = new Uint8Array(buf);
    if (data.length < 3 || data[0] !== 0x01) return; // invalid header
    const nameLen = (data[1] << 8) | data[2];
    if (data.length < 3 + nameLen) return;
    const sessionName = new TextDecoder().decode(data.slice(3, 3 + nameLen));
    const ptyData = data.slice(3 + nameLen);
    // Data flowing → stream recovered. Reset retry counter so future resets get full budget.
    this.confirmStreamRecovery(sessionName);
    this._terminalRawHandlers.get(sessionName)?.forEach((h) => h(ptyData));
  }

  /** Called when data arrives for a session — confirms stream is healthy, resets retry budget. */
  private confirmStreamRecovery(session: string): void {
    const state = this.resetState.get(session);
    if (state && state.retryCount > 0) {
      state.retryCount = 0;
    }
  }

  /**
   * Handle terminal.stream_reset: schedule resubscribe with exponential backoff.
   * Cooldown: 3+ resets within 60s → 30s pause before retrying.
   */
  private handleStreamReset(session: string): void {
    const now = Date.now();
    let state = this.resetState.get(session);
    if (!state) {
      state = { count: 0, windowStart: now, retryCount: 0, inCooldown: false, retryTimer: null };
      this.resetState.set(session, state);
    }

    // Reset count window every 60s
    if (now - state.windowStart > 60_000) {
      state.count = 0;
      state.windowStart = now;
    }
    state.count++;

    // Cooldown: ≥3 resets in 60s → 30s pause
    if (state.count >= 3 && !state.inCooldown) {
      state.inCooldown = true;
      setTimeout(() => {
        const s = this.resetState.get(session);
        if (s === state) {
          s.inCooldown = false;
          s.retryCount = 0;
        }
      }, 30_000);
      return; // Don't resubscribe during cooldown
    }

    if (state.inCooldown) return;

    if (state.retryCount >= 5) {
      // Max retries — let handler show user-facing prompt (already dispatched)
      return;
    }

    const delays = [1000, 2000, 4000, 8000, 16000];
    const delay = delays[Math.min(state.retryCount, delays.length - 1)];
    state.retryCount++;

    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(() => {
      const s = this.resetState.get(session);
      if (s) s.retryTimer = null;
      // retryCount is NOT reset here — only reset when data actually flows
      // (confirmStreamRecovery called from handleRawFrame on first received frame)
      if (!this._destroyed && this._connected) {
        this.subscribeTerminal(session);
      }
    }, delay);
  }

  private scheduleReconnect(): void {
    if (this._destroyed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      if (!this._destroyed) void this.openSocket();
    }, delay);
  }

  private startHeartbeat(): void {
    // Send first ping immediately to get initial latency
    try {
      this._pingSentAt = Date.now();
      this.send({ type: 'ping' });
    } catch { /* ignore */ }
    this.heartbeatTimer = setInterval(() => {
      try {
        this._pingSentAt = Date.now();
        this.send({ type: 'ping' });
      } catch {
        // ignore
      }
    }, HEARTBEAT_MS);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  private dispatch(msg: ServerMessage): void {
    for (const h of this.handlers) {
      try {
        h(msg);
      } catch {
        // ignore handler errors
      }
    }
  }
}
