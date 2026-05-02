/**
 * WebSocket client for terminal stream + session commands.
 * Handles auth, reconnect, and message dispatch.
 */
import type { TerminalDiff } from './types.js';
import { apiFetch, ApiError } from './api.js';
import type { TimelineEvent } from '../../src/shared/timeline/types.js';
import { REPO_MSG } from '@shared/repo-types.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { P2P_CONFIG_MSG } from '@shared/p2p-config-events.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';
import { CC_PRESET_MSG, type CcPreset, type CcPresetModelInfo } from '@shared/cc-presets.js';
import { MEMORY_WS } from '@shared/memory-ws.js';
import type {
  MemoryFeatureAdminRecord,
  MemoryFeatureSetResponse,
  MemoryManagementErrorCode,
  MemoryObservationAdminRecord,
  MemoryPreferenceAdminRecord,
  MemorySkillAdminRecord,
} from '@shared/memory-management.js';
import type { MemoryProjectResolveResponsePayload } from '@shared/memory-project-options.js';
import {
  MSG_COMMAND_FAILED,
  MSG_DAEMON_ONLINE,
  MSG_DAEMON_OFFLINE,
  type AckFailureReason,
} from '@shared/ack-protocol.js';
import type {
  FsLsResponse,
  FsReadResponse,
  FsGitStatusResponse,
  FsGitDiffResponse,
  FsWriteResponse,
  FsMkdirResponse,
} from '../../src/shared/transport/fs.js';

export type MessageHandler = (msg: ServerMessage) => void;

export interface TransportUpgradeBlockedSession {
  name: string;
  sessionState?: string;
  runtime?: {
    status: string;
    sending: boolean;
    pendingCount: number;
    blockReason?: string;
  } | null;
}

export type ServerMessage =
  | { type: 'terminal.diff'; diff: TerminalDiff }
  | { type: 'terminal.history'; sessionName: string; content: string }
  | { type: 'terminal.stream_reset'; session: string; reason: string }
  | { type: 'session.event'; event: string; session: string; state: string }
  | { type: 'session.error'; project: string; message: string }
  | { type: 'session.idle'; session: string; project: string; agentType: string; label?: string; parentLabel?: string }
  | { type: 'session.notification'; session: string; project: string; title: string; message: string; agentType?: string; label?: string; parentLabel?: string }
  | { type: 'session.tool'; session: string; tool: string | null }
  | { type: typeof TRANSPORT_MSG.CHAT_HISTORY; sessionId: string; events: Array<Record<string, unknown>> }
  | { type: typeof TRANSPORT_MSG.CHAT_APPROVAL; sessionId: string; requestId: string; description: string; tool?: string }
  | { type: typeof TRANSPORT_MSG.APPROVAL_RESPONSE; sessionId: string; requestId: string; approved: boolean }
  | { type: typeof DAEMON_MSG.RECONNECTED }
  | { type: typeof DAEMON_MSG.DISCONNECTED }
  | { type: typeof DAEMON_MSG.UPGRADE_BLOCKED; reason: 'p2p_active'; activeRunIds?: string[] }
  | { type: typeof DAEMON_MSG.UPGRADE_BLOCKED; reason: 'transport_busy'; activeSessionNames?: string[]; blockedSessions?: TransportUpgradeBlockedSession[] }
  | { type: 'daemon.error'; kind: 'uncaughtException' | 'unhandledRejection' | 'warning'; message: string; stack?: string; ts: number }
  | { type: 'session_list'; daemonVersion?: string | null; sessions: Array<{ name: string; project: string; role: string; agentType: string; agentVersion?: string; state: string; projectDir?: string; runtimeType?: 'process' | 'transport'; label?: string; description?: string; qwenModel?: string; requestedModel?: string; activeModel?: string; qwenAuthType?: string; qwenAuthLimit?: string; qwenAvailableModels?: string[]; copilotAvailableModels?: string[]; cursorAvailableModels?: string[]; codexAvailableModels?: string[]; modelDisplay?: string; planLabel?: string; permissionLabel?: string; quotaLabel?: string; quotaUsageLabel?: string; quotaMeta?: import('../../shared/provider-quota.js').ProviderQuotaMeta | null; effort?: import('../../shared/effort-levels.js').TransportEffortLevel; contextNamespace?: import('../../shared/session-context-bootstrap.js').SessionContextBootstrapState['contextNamespace']; contextNamespaceDiagnostics?: string[]; contextRemoteProcessedFreshness?: import('../../shared/context-types.js').ContextFreshness; contextLocalProcessedFreshness?: import('../../shared/context-types.js').ContextFreshness; contextRetryExhausted?: boolean; contextSharedPolicyOverride?: import('../../shared/context-types.js').SharedScopePolicyOverride; transportConfig?: Record<string, unknown> | null; transportPendingMessages?: string[]; transportPendingMessageEntries?: Array<{ clientMessageId: string; text: string }> }> }
  | { type: 'outbound'; platform: string; channelId: string; content: string }
  | { type: 'timeline.event'; event: TimelineEvent }
  | { type: 'timeline.replay'; sessionName: string; requestId?: string; events: TimelineEvent[]; truncated: boolean; epoch: number }
  | { type: 'timeline.history'; sessionName: string; requestId?: string; events: TimelineEvent[]; epoch: number }
  | { type: 'command.ack'; commandId: string; status: string; session: string }
  | { type: typeof MSG_COMMAND_FAILED; commandId: string; session: string; reason: AckFailureReason; retryable: boolean }
  | { type: typeof MSG_DAEMON_ONLINE }
  | { type: typeof MSG_DAEMON_OFFLINE }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  | { type: 'subsession.shells'; shells: string[] }
  | { type: 'subsession.response'; sessionName: string; status: 'working' | 'idle'; response?: string }
  | { type: 'discussion.started'; requestId?: string; discussionId: string; topic: string; maxRounds: number; totalHops?: number; filePath: string; participants: Array<{ sessionName: string; roleLabel: string; agentType: string; model?: string }> }
  | { type: 'discussion.update'; discussionId: string; state: string; currentRound: number; maxRounds: number; completedHops?: number; totalHops?: number; currentSpeaker?: string; lastResponse?: string }
  | { type: 'discussion.done'; discussionId: string; filePath: string; conclusion: string }
  | { type: 'discussion.error'; discussionId?: string; requestId?: string; error: string }
  | { type: 'discussion.list'; discussions: Array<{ id: string; topic: string; state: string; currentRound: number; maxRounds: number; completedHops?: number; totalHops?: number; currentSpeaker?: string; conclusion?: string; filePath?: string }> }
  | { type: 'daemon.stats'; daemonVersion?: string | null; cpu: number; memUsed: number; memTotal: number; load1: number; load5: number; load15: number; uptime: number }
  | FsLsResponse
  | FsReadResponse
  | FsGitStatusResponse
  | { type: 'file.search_response'; requestId: string; results: string[]; error?: string }
  | { type: 'p2p.run_update'; run: any }
  | { type: typeof P2P_CONFIG_MSG.SAVE_RESPONSE; requestId: string; scopeSession: string; ok: boolean; error?: string }
  | { type: 'p2p.conflict'; existingRunId: string; initiatorSession: string; commandId: string }
  | { type: 'subsession.created'; id: string; sessionName: string; sessionType: string; cwd?: string; label?: string; parentSession?: string; state?: string; runtimeType?: 'process' | 'transport' | null; providerId?: string | null; providerSessionId?: string | null; requestedModel?: string | null; activeModel?: string | null; contextNamespace?: import('../../shared/session-context-bootstrap.js').SessionContextBootstrapState['contextNamespace'] | null; contextNamespaceDiagnostics?: string[] | null; contextRemoteProcessedFreshness?: import('../../shared/context-types.js').ContextFreshness | null; contextLocalProcessedFreshness?: import('../../shared/context-types.js').ContextFreshness | null; contextRetryExhausted?: boolean | null; contextSharedPolicyOverride?: import('../../shared/context-types.js').SharedScopePolicyOverride | null; transportConfig?: Record<string, unknown> | null; qwenModel?: string | null; qwenAuthType?: string | null; qwenAvailableModels?: string[] | null; codexAvailableModels?: string[] | null; modelDisplay?: string | null; planLabel?: string | null; permissionLabel?: string | null; quotaLabel?: string | null; quotaUsageLabel?: string | null; quotaMeta?: import('../../shared/provider-quota.js').ProviderQuotaMeta | null; effort?: import('../../shared/effort-levels.js').TransportEffortLevel | null }
  | { type: 'subsession.sync'; id: string; sessionName?: string; state?: string; cwd?: string; label?: string; requestedModel?: string | null; activeModel?: string | null; contextNamespace?: import('../../shared/session-context-bootstrap.js').SessionContextBootstrapState['contextNamespace'] | null; contextNamespaceDiagnostics?: string[] | null; contextRemoteProcessedFreshness?: import('../../shared/context-types.js').ContextFreshness | null; contextLocalProcessedFreshness?: import('../../shared/context-types.js').ContextFreshness | null; contextRetryExhausted?: boolean | null; contextSharedPolicyOverride?: import('../../shared/context-types.js').SharedScopePolicyOverride | null; transportConfig?: Record<string, unknown> | null; qwenModel?: string | null; codexAvailableModels?: string[] | null; modelDisplay?: string | null; planLabel?: string | null; permissionLabel?: string | null; quotaLabel?: string | null; quotaUsageLabel?: string | null; quotaMeta?: import('../../shared/provider-quota.js').ProviderQuotaMeta | null; effort?: import('../../shared/effort-levels.js').TransportEffortLevel | null }
  | { type: 'subsession.removed'; id: string; sessionName: string }
  | { type: 'p2p.run_started'; runId: string; session: string }
  | { type: 'p2p.cancel_response'; runId: string; ok: boolean }
  | { type: 'p2p.status_response'; runId?: string; run?: any; runs?: any[] }
  | { type: 'p2p.list_discussions_response'; discussions: Array<{ id: string; fileName: string; path?: string; preview: string; mtime: number }> }
  | { type: 'p2p.read_discussion_response'; id?: string; requestId?: string; content?: string; error?: string }
  | { type: typeof CC_PRESET_MSG.LIST_RESPONSE; presets: CcPreset[] }
  | { type: typeof CC_PRESET_MSG.SAVE_RESPONSE; ok: boolean }
  | { type: typeof CC_PRESET_MSG.DISCOVER_MODELS_RESPONSE; requestId?: string; presetName: string; ok: boolean; preset?: CcPreset; models?: CcPresetModelInfo[]; endpoint?: string; error?: string }
  | FsGitDiffResponse
  | FsWriteResponse
  | FsMkdirResponse
  | { type: 'repo.detect_response'; requestId: string; projectDir: string; context: any }
  | { type: 'repo.issues_response'; requestId: string; projectDir: string; items: any[]; page: number; hasMore: boolean }
  | { type: 'repo.prs_response'; requestId: string; projectDir: string; items: any[]; page: number; hasMore: boolean }
  | { type: 'repo.branches_response'; requestId: string; projectDir: string; items: any[]; page: number; hasMore: boolean }
  | { type: 'repo.commits_response'; requestId: string; projectDir: string; items: any[]; page: number; hasMore: boolean }
  | { type: 'repo.actions_response'; requestId?: string; projectDir: string; items: any[]; page: number; hasMore: boolean }
  | { type: 'repo.action_detail_response'; requestId?: string; projectDir: string; detail: any }
  | { type: 'repo.commit_detail_response'; requestId?: string; projectDir: string; detail: any }
  | { type: 'repo.pr_detail_response'; requestId?: string; projectDir: string; detail: any }
  | { type: 'repo.issue_detail_response'; requestId?: string; projectDir: string; detail: any }
  | { type: 'repo.error'; requestId: string; projectDir?: string; error: string }
  | { type: 'repo.detected'; projectDir: string; context: any }
  | { type: typeof TRANSPORT_MSG.CHAT_HISTORY; sessionId: string; events: Array<Record<string, unknown>> }
  | { type: typeof TRANSPORT_MSG.CHAT_APPROVAL; sessionId: string; requestId: string; description: string; tool?: string }
  | { type: typeof TRANSPORT_MSG.APPROVAL_RESPONSE; sessionId: string; requestId: string; approved: boolean }
  | { type: 'provider.status'; providerId: string; connected: boolean }
  | { type: 'provider.sessions_response'; providerId: string; sessions: Array<{ key: string; displayName?: string; agentId?: string; updatedAt?: number; percentUsed?: number }>; error?: string }
  | {
    type: typeof MEMORY_WS.PERSONAL_RESPONSE;
    requestId: string;
    stats: import('../../shared/context-types.js').ContextMemoryStatsView;
    records: Array<import('../../shared/context-types.js').ContextMemoryRecordView>;
    pendingRecords?: Array<import('../../shared/context-types.js').ContextPendingEventView>;
    projects?: Array<import('../../shared/context-types.js').ContextMemoryProjectView>;
    error?: string;
    errorCode?: MemoryManagementErrorCode;
  }
  | { type: typeof MEMORY_WS.ARCHIVE_RESPONSE; requestId?: string; success: boolean; error?: string }
  | { type: typeof MEMORY_WS.RESTORE_RESPONSE; requestId?: string; success: boolean; error?: string }
  | { type: typeof MEMORY_WS.DELETE_RESPONSE; requestId?: string; success: boolean; error?: string }
  | ({ type: typeof MEMORY_WS.PROJECT_RESOLVE_RESPONSE } & MemoryProjectResolveResponsePayload)
  | { type: typeof MEMORY_WS.FEATURES_RESPONSE; requestId?: string; records: MemoryFeatureAdminRecord[] }
  | ({ type: typeof MEMORY_WS.FEATURES_SET_RESPONSE } & MemoryFeatureSetResponse)
  | { type: typeof MEMORY_WS.PREF_RESPONSE; requestId?: string; records: MemoryPreferenceAdminRecord[]; featureEnabled?: boolean }
  | { type: typeof MEMORY_WS.PREF_CREATE_RESPONSE; requestId?: string; success: boolean; id?: string; error?: string; errorCode?: MemoryManagementErrorCode }
  | { type: typeof MEMORY_WS.PREF_DELETE_RESPONSE; requestId?: string; success: boolean; error?: string; errorCode?: MemoryManagementErrorCode }
  | { type: typeof MEMORY_WS.SKILL_RESPONSE; requestId?: string; entries: MemorySkillAdminRecord[]; sourceCounts?: Record<string, number>; featureEnabled?: boolean }
  | { type: typeof MEMORY_WS.SKILL_REBUILD_RESPONSE; requestId?: string; success: boolean; userCount?: number; projectCount?: number; error?: string; errorCode?: MemoryManagementErrorCode }
  | { type: typeof MEMORY_WS.SKILL_READ_RESPONSE; requestId?: string; success: boolean; key?: string; layer?: string; content?: string; error?: string; errorCode?: MemoryManagementErrorCode }
  | { type: typeof MEMORY_WS.SKILL_DELETE_RESPONSE; requestId?: string; success: boolean; error?: string; errorCode?: MemoryManagementErrorCode }
  | { type: typeof MEMORY_WS.MD_INGEST_RUN_RESPONSE; requestId?: string; success: boolean; filesChecked?: number; observationsWritten?: number; error?: string; errorCode?: MemoryManagementErrorCode; featureEnabled?: boolean }
  | { type: typeof MEMORY_WS.OBSERVATION_RESPONSE; requestId?: string; records: MemoryObservationAdminRecord[]; featureEnabled?: boolean }
  | { type: typeof MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE; requestId?: string; success: boolean; audit?: Record<string, unknown>; error?: string; errorCode?: MemoryManagementErrorCode };

export type {
  TimelineEvent,
  MemoryContextTimelinePayload,
  MemoryContextTimelineItem,
} from '../../src/shared/timeline/types.js';

export type {
  FsEntry,
  GitStatusEntry,
  FsLsResponse,
  FsReadResponse,
  FsGitStatusResponse,
  FsGitDiffResponse,
  FsMkdirResponse,
} from '../../src/shared/transport/fs.js';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_MS = 10000; // lowered from 25s for faster dead-connection detection
/** If no pong arrives within this window after a ping, assume the socket is a
 *  half-open zombie (iOS/Android commonly leave the TCP open after aggressive
 *  background eviction) and force a fresh reconnect.
 *
 *  Sized to absorb mobile/cellular jitter — 2s was too aggressive and produced
 *  false-positive forced reconnects (and a flurry of resubscribe traffic) on
 *  every momentary RTT spike. With `PONG_MISSES_BEFORE_RECONNECT = 2`, total
 *  detection time is still bounded at ~10s (one missed window + one confirming
 *  ping + miss). Truly dead sockets are caught well before any TCP-level
 *  timeout, but live-but-jittery sockets are no longer torn down. */
// Bumped 5s → 8s. Cellular handoff and CPU-busy daemons regularly took 5–7s
// to ack a ping; the old 5s window forced spurious reconnects (with the full
// resubscribe replay), surfacing as "终端订阅一会就断了". With
// `PONG_MISSES_BEFORE_RECONNECT = 2` the worst-case detection window is
// ~16s of true silence — still well within the user's tolerance for noticing
// a dead tab.
const PONG_TIMEOUT_MS = 8_000;
const RESUME_PROBE_TIMEOUT_MS = 8_000;
const PONG_MISSES_BEFORE_RECONNECT = 2;
/** If we received a pong within this window, treat the socket as already
 *  proven alive and skip the resume probe. This eliminates UI churn (and the
 *  brief "disconnected" flash) when the user rapidly switches tabs / focuses
 *  windows in quick succession — the ping/pong heartbeat already covers
 *  liveness during normal use; foreground probes only need to fire after a
 *  genuine sleep/background gap. */
const PROBE_FRESHNESS_MS = 5_000;

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
  /** Wall-clock time of the last received pong. Used by `probeConnection` to
   *  skip a resume probe when a recent heartbeat already proved liveness. */
  private _lastPongAt = 0;
  private _pongTimer: ReturnType<typeof setTimeout> | null = null;
  private _resumeProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private _visibilityListener: (() => void) | null = null;
  private _missedHeartbeatPongs = 0;
  private _resumeProbeMisses = 0;
  private _onLatency: ((ms: number) => void) | null = null;

  /** Per-session callbacks for raw PTY binary frames. Supports multiple subscribers per session. */
  private _terminalRawHandlers = new Map<string, Set<(data: Uint8Array) => void>>();

  /** Effective terminal subscription mode per session. Replayed on browser reconnect. */
  private terminalSubscriptions = new Map<string, boolean>();
  /** Base terminal mode requested by ordinary subscribeTerminal callers. */
  private terminalBaseSubscriptions = new Map<string, boolean>();
  /** Raw-mode holds used by embedded live terminal surfaces that must not be downgraded by passive subscriptions. */
  private terminalRawHolds = new Map<string, number>();

  /** Desired transport-chat subscriptions per session. Replayed on browser reconnect. */
  private transportSubscriptions = new Set<string>();

  /** Per-session stream reset recovery state.
   *  - lastSnapshotAt: rate-limits snapshot requests to avoid hammering the
   *    server during reset bursts (one outstanding snapshot every
   *    SNAPSHOT_REQUEST_MIN_INTERVAL_MS).
   *  - pendingSnapshot: a deferred snapshot timer when we're rate-limited;
   *    guarantees the terminal will eventually catch up even if every reset
   *    fell within the rate-limit window.
   *  No cooldown / no retry budget — overflow recovery is now driven entirely
   *  by re-snapshotting (which the server-side queue-reset path supports).
   *  The terminal can never be permanently frozen by a burst of resets. */
  private resetState = new Map<string, {
    lastSnapshotAt: number;
    pendingSnapshot: ReturnType<typeof setTimeout> | null;
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
    if (!this._connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    const json = JSON.stringify(msg);
    if (json.length > 60_000) {
      throw new Error('Message too large');
    }
    this.ws.send(json);
  }

  /**
   * Bypass the probe-state gate (`_connected`) for urgent commands like
   * `/stop`. Probe state is a heuristic — `readyState === OPEN` is the
   * OS-level truth. Backgrounded tabs can resume with readyState=OPEN
   * while the path is actually dead, which is why probeConnection() flips
   * `_connected = false` until a fresh ping/pong confirms the path. But
   * for STOP we want maximum chance of delivery: try the OS-open socket
   * (likely still works on most resumes), and let the caller fall back to
   * HTTP on throw. The previous "stop has highest priority" guarantee
   * regressed when probeConnection() was added (a604c085) because every
   * focus/visibility tick briefly marks the socket disconnected, and the
   * normal `send()` refuses during that window — so a stop tap landing
   * in that window was silently dropped (caught by `try { ... } catch
   * { /* ignore *​/ }` in SubSessionCard).
   *
   * Throws if there's no socket at all or readyState isn't OPEN — those
   * are real-deadness conditions where HTTP fallback IS necessary.
   */
  sendUrgent(msg: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    const json = JSON.stringify(msg);
    if (json.length > 60_000) {
      throw new Error('Message too large');
    }
    this.ws.send(json);
  }

  /**
   * Urgent variant of `sendSessionCommand` for stop / interrupt / cancel —
   * bypasses the probe-state gate so a focus/visibility tick can't silently
   * swallow it. Caller should still wrap in try/catch and HTTP-fallback
   * on throw.
   */
  sendSessionCommandUrgent(command: 'stop' | 'send' | 'restart', payload: object = {}): void {
    this.sendUrgent({ type: `session.${command}`, ...payload });
  }

  /**
   * Actively verify a foregrounded browser socket before allowing new sends.
   * Backgrounded tabs can resume with readyState=OPEN while the path to the
   * server is dead; a short ping/pong probe catches that without refreshing
   * healthy sockets.
   *
   * Stability guards (in order):
   *   1. If a recent pong (within `PROBE_FRESHNESS_MS`) already proved the
   *      socket is alive, skip the probe entirely — no disconnected flash,
   *      no extra ping. Rapid visibility/focus toggles do not churn the UI.
   *   2. If a probe is already in flight (`_resumeProbeTimer` armed), don't
   *      restart it; the in-flight probe will resolve on its own.
   *   3. Otherwise mark the socket unverified, dispatch `disconnected` so
   *      `send()` callers can't push into a possibly-dead pipe, and ping.
   */
  probeConnection(timeoutMs = RESUME_PROBE_TIMEOUT_MS): void {
    if (this._destroyed) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.reconnectNow(false);
      return;
    }

    // Recent pong → socket is provably alive; nothing to do.
    if (this._connected && this._lastPongAt > 0 && Date.now() - this._lastPongAt < PROBE_FRESHNESS_MS) {
      return;
    }

    // Already probing — let the existing watchdog resolve. Avoids stacking
    // multiple pings/timers when visibility/focus/pageshow all fire.
    if (this._resumeProbeTimer) return;

    const wasConnected = this._connected;
    this._connected = false;
    if (wasConnected) {
      this.dispatch({ type: 'session.event', event: 'disconnected', session: '', state: 'disconnected' });
    }

    this.clearPongWatchdog();
    this._resumeProbeMisses = 0;
    this.sendResumeProbePing(timeoutMs);
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  subscribeTerminal(sessionName: string, raw: boolean): void {
    this.terminalBaseSubscriptions.set(sessionName, raw);
    this.syncTerminalSubscription(sessionName);
  }

  unsubscribeTerminal(sessionName: string): void {
    this.terminalBaseSubscriptions.delete(sessionName);
    if ((this.terminalRawHolds.get(sessionName) ?? 0) > 0) {
      this.syncTerminalSubscription(sessionName);
      return;
    }
    this.terminalSubscriptions.delete(sessionName);
    if (!this._connected) return;
    this.send({ type: 'terminal.unsubscribe', session: sessionName });
  }

  holdTerminalRaw(sessionName: string): () => void {
    this.terminalRawHolds.set(sessionName, (this.terminalRawHolds.get(sessionName) ?? 0) + 1);
    this.syncTerminalSubscription(sessionName);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = Math.max(0, (this.terminalRawHolds.get(sessionName) ?? 0) - 1);
      if (next === 0) this.terminalRawHolds.delete(sessionName);
      else this.terminalRawHolds.set(sessionName, next);
      this.syncTerminalSubscription(sessionName);
    };
  }

  private syncTerminalSubscription(sessionName: string): void {
    const hasBase = this.terminalBaseSubscriptions.has(sessionName);
    const raw = (this.terminalBaseSubscriptions.get(sessionName) ?? false)
      || (this.terminalRawHolds.get(sessionName) ?? 0) > 0;
    if (!hasBase && !raw) {
      this.terminalSubscriptions.delete(sessionName);
      if (!this._connected) return;
      this.send({ type: 'terminal.unsubscribe', session: sessionName });
      return;
    }
    this.terminalSubscriptions.set(sessionName, raw);
    if (!this._connected) return;
    this.send({ type: 'terminal.subscribe', session: sessionName, raw });
  }

  /** Subscribe to transport chat events for a session (history replay + live approval/tool updates). */
  subscribeTransportSession(sessionId: string): void {
    if (!sessionId) return;
    if (this.transportSubscriptions.has(sessionId)) return;
    this.transportSubscriptions.add(sessionId);
    if (!this._connected) return;
    this.send({ type: TRANSPORT_MSG.CHAT_SUBSCRIBE, sessionId });
  }

  /** Unsubscribe from transport chat events for a session. */
  unsubscribeTransportSession(sessionId: string): void {
    if (!sessionId) return;
    if (!this.transportSubscriptions.has(sessionId)) return;
    this.transportSubscriptions.delete(sessionId);
    if (!this._connected) return;
    this.send({ type: TRANSPORT_MSG.CHAT_UNSUBSCRIBE, sessionId });
  }

  /** Respond to a transport approval request. */
  respondTransportApproval(sessionId: string, requestId: string, approved: boolean): void {
    if (!sessionId || !requestId) return;
    this.send({ type: TRANSPORT_MSG.APPROVAL_RESPONSE, sessionId, requestId, approved });
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

  subSessionRestart(sessionName: string): void {
    this.send({ type: 'subsession.restart', sessionName });
  }

  subSessionRebuildAll(subSessions: Array<{ id: string; type: string; runtimeType?: 'process' | 'transport' | null; providerId?: string | null; providerSessionId?: string | null; shellBin?: string | null; cwd?: string | null; ccSessionId?: string | null; geminiSessionId?: string | null; parentSession?: string | null; label?: string | null; ccPresetId?: string | null; requestedModel?: string | null; activeModel?: string | null; effort?: import('../../shared/effort-levels.js').TransportEffortLevel | null; transportConfig?: Record<string, unknown> | null }>): void {
    this.send({ type: 'subsession.rebuild_all', subSessions });
  }

  subSessionDetectShells(): void {
    this.send({ type: 'subsession.detect_shells' });
  }

  subSessionReadResponse(sessionName: string): void {
    this.send({ type: 'subsession.read_response', sessionName });
  }

  subSessionRename(sessionName: string, label: string): void {
    this.send({ type: 'subsession.rename', sessionName, label });
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

  p2pStatus(runId?: string): void {
    this.send(runId ? { type: 'p2p.status', runId } : { type: 'p2p.status' });
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

  /** Write a file via the daemon. Returns requestId for matching the response. */
  fsWriteFile(path: string, content: string, expectedMtime?: number): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'fs.write', path, content, expectedMtime, requestId });
    return requestId;
  }

  /** Create a directory on the daemon. Returns requestId. */
  fsMkdir(path: string): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'fs.mkdir', path, requestId });
    return requestId;
  }

  /** Request git status for a directory. Returns requestId. */
  fsGitStatus(path: string, opts?: { includeStats?: boolean }): string {
    const requestId = crypto.randomUUID();
    this.send({ type: 'fs.git_status', path, requestId, ...(opts?.includeStats ? { includeStats: true } : {}) });
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
    this.send({ type: REPO_MSG.DETECT, requestId, projectDir, ...(opts?.force ? { force: true } : {}) });
    return requestId;
  }

  /** List issues for a project. Returns requestId. */
  repoListIssues(projectDir: string, opts?: { state?: string; page?: number; force?: boolean }): string {
    const requestId = crypto.randomUUID();
    this.send({ type: REPO_MSG.LIST_ISSUES, requestId, projectDir, ...opts });
    return requestId;
  }

  /** List pull requests for a project. Returns requestId. */
  repoListPRs(projectDir: string, opts?: { state?: string; page?: number; force?: boolean }): string {
    const requestId = crypto.randomUUID();
    this.send({ type: REPO_MSG.LIST_PRS, requestId, projectDir, ...opts });
    return requestId;
  }

  /** List branches for a project. Returns requestId. */
  repoListBranches(projectDir: string): string {
    const requestId = crypto.randomUUID();
    this.send({ type: REPO_MSG.LIST_BRANCHES, requestId, projectDir });
    return requestId;
  }

  /** List commits for a project. Returns requestId. */
  repoListCommits(projectDir: string, opts?: { branch?: string; page?: number }): string {
    const requestId = crypto.randomUUID();
    this.send({ type: REPO_MSG.LIST_COMMITS, requestId, projectDir, ...opts });
    return requestId;
  }

  /** List workflow runs (CI/CD actions) for a project. Returns requestId. */
  repoListActions(projectDir: string, opts?: { page?: number; force?: boolean }): string {
    const requestId = crypto.randomUUID();
    this.send({ type: REPO_MSG.LIST_ACTIONS, requestId, projectDir, ...opts });
    return requestId;
  }

  /** Get workflow run jobs/steps for a project. Returns requestId. */
  repoActionDetail(projectDir: string, runId: number, opts?: { force?: boolean }): string {
    const requestId = crypto.randomUUID();
    this.send({ type: REPO_MSG.ACTION_DETAIL, projectDir, runId, requestId, ...opts });
    return requestId;
  }

  /** Get commit detail (diff stats, files). Returns requestId. */
  repoCommitDetail(projectDir: string, sha: string): string {
    const requestId = crypto.randomUUID();
    this.send({ type: REPO_MSG.COMMIT_DETAIL, projectDir, sha, requestId });
    return requestId;
  }

  /** Get PR detail (body, review, checks, stats). Returns requestId. */
  repoPRDetail(projectDir: string, number: number): string {
    const requestId = crypto.randomUUID();
    this.send({ type: REPO_MSG.PR_DETAIL, projectDir, number, requestId });
    return requestId;
  }

  /** Get issue detail (body, comments). Returns requestId. */
  repoIssueDetail(projectDir: string, number: number): string {
    const requestId = crypto.randomUUID();
    this.send({ type: REPO_MSG.ISSUE_DETAIL, projectDir, number, requestId });
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
    } catch (err) {
      this._connecting = false;
      // Auth expired (401) → onAuthExpired already fired, don't keep reconnecting
      if (err instanceof ApiError && err.status === 401) return;
      this.scheduleReconnect();
      return;
    }

    if (this._destroyed) {
      this._connecting = false;
      return;
    }

    const url = `${wsUrl}/api/server/${this.serverId}/ws?ticket=${encodeURIComponent(ticket)}`;

    const socket = new WebSocket(url);
    this.ws = socket;
    socket.binaryType = 'arraybuffer';
    this._connecting = false;

    socket.addEventListener('open', () => {
      if (this.ws !== socket) return;
      this._connected = true;
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      // Reset per-session stream-reset bookkeeping on reconnect. Stale pending
      // snapshot timers from the old socket are cleared so they don't fire
      // after we've already re-issued subscribes here.
      for (const state of this.resetState.values()) {
        if (state.pendingSnapshot) clearTimeout(state.pendingSnapshot);
      }
      this.resetState.clear();
      for (const [session, raw] of this.terminalSubscriptions) {
        try {
          this.send({ type: 'terminal.subscribe', session, raw });
        } catch {
          break;
        }
      }
      for (const sessionId of this.transportSubscriptions) {
        try {
          this.send({ type: TRANSPORT_MSG.CHAT_SUBSCRIBE, sessionId });
        } catch {
          break;
        }
      }
      this.dispatch({ type: 'session.event', event: 'connected', session: '', state: 'connected' });
    });

    socket.addEventListener('message', (ev) => {
      if (this.ws !== socket) return;
      // Binary frame: raw PTY data
      if (ev.data instanceof ArrayBuffer) {
        this.handleRawFrame(ev.data);
        return;
      }

      try {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        if (msg.type === 'pong') {
          this._missedHeartbeatPongs = 0;
          this._resumeProbeMisses = 0;
          this._lastPongAt = Date.now();
          if (this._pingSentAt !== null) {
            this._pingLatency = Date.now() - this._pingSentAt;
            this._pingSentAt = null;
            this._onLatency?.(this._pingLatency);
          }
          // Clear the dead-socket watchdog — we just proved the socket is alive.
          if (this._pongTimer) {
            clearTimeout(this._pongTimer);
            this._pongTimer = null;
          }
          if (this._resumeProbeTimer) {
            clearTimeout(this._resumeProbeTimer);
            this._resumeProbeTimer = null;
            if (!this._connected) {
              this._connected = true;
              this.dispatch({ type: 'session.event', event: 'connected', session: '', state: 'connected' });
            }
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

    socket.addEventListener('close', () => {
      if (this.ws !== socket) return;
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

    socket.addEventListener('error', () => {
      if (this.ws !== socket) return;
      socket.close();
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

  /** Called when data arrives for a session — confirms stream is healthy. */
  private confirmStreamRecovery(_session: string): void {
    // No-op in the rate-limit-only design. The server keeps the subscription
    // alive across overflow (queue is reset, not unsubscribed), so a healthy
    // data flow naturally proves recovery without any client-side state.
  }

  /**
   * Handle terminal.stream_reset: ALWAYS recover by requesting a fresh
   * snapshot, never freeze the terminal.
   *
   * Design (replaces the old retry-with-cooldown path):
   *   - Server keeps the subscription alive across overflow — it just sends
   *     stream_reset + clears its per-(session, ws) queue. So all the client
   *     needs to do on every reset is request a snapshot to re-sync the
   *     visible screen.
   *   - To avoid hammering the server when overflows cascade (a single heavy
   *     output burst can fire many resets in flight), snapshot requests are
   *     rate-limited to one per SNAPSHOT_REQUEST_MIN_INTERVAL_MS. Resets
   *     arriving within the window schedule a deferred snapshot at the end of
   *     the window, so the terminal is GUARANTEED to recover even after a
   *     burst.
   *   - No cooldown that blanks the screen for 5s. No exponential backoff.
   *   - No "max retries" that leaves the terminal frozen. The previous design
   *     could enter a permanently-stuck state ("终端卡住不更新, 刷新后恢复");
   *     this design cannot.
   */
  private handleStreamReset(session: string): void {
    if (!this._connected) return;
    const SNAPSHOT_REQUEST_MIN_INTERVAL_MS = 500;
    const now = Date.now();
    let state = this.resetState.get(session);
    if (!state) {
      state = { lastSnapshotAt: 0, pendingSnapshot: null };
      this.resetState.set(session, state);
    }

    const sinceLast = now - state.lastSnapshotAt;
    if (sinceLast >= SNAPSHOT_REQUEST_MIN_INTERVAL_MS) {
      // Window open — fire snapshot now.
      state.lastSnapshotAt = now;
      try {
        this.send({ type: 'terminal.snapshot_request', sessionName: session });
      } catch {
        // ws not open right now; the next reset (or the reconnect resubscribe
        // replay) will recover.
      }
      return;
    }

    // Inside the rate-limit window — defer one snapshot to the end of the
    // window. If a deferred snapshot is already scheduled, leave it alone:
    // multiple resets in the same window collapse into a single snapshot.
    if (state.pendingSnapshot) return;
    const remaining = SNAPSHOT_REQUEST_MIN_INTERVAL_MS - sinceLast;
    state.pendingSnapshot = setTimeout(() => {
      const s = this.resetState.get(session);
      if (!s) return;
      s.pendingSnapshot = null;
      if (this._destroyed || !this._connected) return;
      s.lastSnapshotAt = Date.now();
      try {
        this.send({ type: 'terminal.snapshot_request', sessionName: session });
      } catch { /* covered by next reset / reconnect */ }
    }, remaining);
  }

  private scheduleReconnect(): void {
    if (this._destroyed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      if (!this._destroyed) void this.openSocket();
    }, delay);
  }

  /** Force immediate reconnect (e.g. app returning from background). */
  reconnectNow(force = false): void {
    if (this._destroyed) return;
    if (!force && this.ws && this.ws.readyState === WebSocket.OPEN) return; // already connected
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;

    if (force && this.ws) {
      const staleSocket = this.ws;
      const wasConnected = this._connected;
      this.ws = null;
      this._connected = false;
      this._connecting = false;
      this.clearTimers();
      if (wasConnected) {
        this.dispatch({ type: 'session.event', event: 'disconnected', session: '', state: 'disconnected' });
      }
      try { staleSocket.close(4001, 'client refresh'); } catch { /* ignore */ }
    }

    void this.openSocket();
  }

  private startHeartbeat(): void {
    // Each ping arms a watchdog. If no pong arrives before the watchdog fires
    // we assume the socket is a zombie (mobile OS commonly half-closes the
    // TCP on background eviction without propagating close() to the WebView)
    // and force a fresh reconnect. Without this, the client believes it's
    // still "connected" indefinitely while no new events ever arrive — which
    // is exactly the "回前台后消息不同步" symptom users reported.
    const armPing = () => {
      if (this.isDocumentHidden()) {
        this.clearPongWatchdog();
        this._missedHeartbeatPongs = 0;
        this._pingSentAt = null;
        return;
      }
      if (this._pongTimer) return;
      try {
        this._pingSentAt = Date.now();
        this.send({ type: 'ping' });
      } catch {
        // If send itself threw, the socket is already broken — let close
        // handler + scheduleReconnect take over.
        return;
      }
      this._pongTimer = setTimeout(() => {
        this._pongTimer = null;
        if (this._destroyed) return;
        this._missedHeartbeatPongs += 1;
        if (this._missedHeartbeatPongs >= PONG_MISSES_BEFORE_RECONNECT) {
          // Socket is half-open. Force a fresh connection so subscriptions
          // and optimistic bubbles get re-synced via the reconnect path.
          this.reconnectNow(true);
          return;
        }
        // One missed pong can be normal under short browser stalls. Confirm
        // with a second immediate ping before tearing down the socket.
        armPing();
      }, PONG_TIMEOUT_MS);
    };
    this.installVisibilityListener();
    armPing(); // send first ping immediately for initial latency
    this.heartbeatTimer = setInterval(armPing, HEARTBEAT_MS);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.clearPongWatchdog();
    if (this._resumeProbeTimer) clearTimeout(this._resumeProbeTimer);
    if (this._visibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityListener);
    }
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this._visibilityListener = null;
    this._resumeProbeTimer = null;
    this._pingSentAt = null;
    this._missedHeartbeatPongs = 0;
    this._resumeProbeMisses = 0;
  }

  private isDocumentHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  private clearPongWatchdog(): void {
    if (!this._pongTimer) return;
    clearTimeout(this._pongTimer);
    this._pongTimer = null;
  }

  private installVisibilityListener(): void {
    if (this._visibilityListener || typeof document === 'undefined') return;
    this._visibilityListener = () => {
      if (!this.isDocumentHidden()) return;
      // Desktop browsers aggressively throttle background timers. A ping sent
      // just before tab hiding can have its pong callback delayed past the
      // foreground 2s watchdog, causing false reconnect loops and subscription
      // churn. Foreground resume still runs probeConnection() immediately,
      // but now also requires two missed pongs before reconnecting.
      this.clearPongWatchdog();
      this._missedHeartbeatPongs = 0;
      this._pingSentAt = null;
    };
    document.addEventListener('visibilitychange', this._visibilityListener);
  }

  private sendResumeProbePing(timeoutMs: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.reconnectNow(false);
      return;
    }
    try {
      this._pingSentAt = Date.now();
      this.ws.send(JSON.stringify({ type: 'ping' }));
    } catch {
      this.reconnectNow(true);
      return;
    }

    this._resumeProbeTimer = setTimeout(() => {
      this._resumeProbeTimer = null;
      if (this._destroyed) return;
      this._resumeProbeMisses += 1;
      if (this._resumeProbeMisses >= PONG_MISSES_BEFORE_RECONNECT) {
        this.reconnectNow(true);
        return;
      }
      this.sendResumeProbePing(timeoutMs);
    }, timeoutMs);
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
