import { randomUUID } from 'node:crypto';
import type { SessionRuntime } from './session-runtime.js';
import { RUNTIME_TYPES } from './session-runtime.js';
import type { AgentStatus } from './detect.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { TransportProvider, ProviderError, SessionConfig, SessionInfoUpdate, ProviderStatusUpdate, ProviderUsageUpdate } from './transport-provider.js';
import { PROVIDER_ERROR_CODES } from './transport-provider.js';
import type { ApprovalRequest } from './transport-provider.js';
import type { TransportEffortLevel } from '../../shared/effort-levels.js';
import {
  SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT,
  SESSION_CONTROL_TIMELINE_STATE_COMPACTING,
  SESSION_CONTROL_METADATA_COMMAND_FIELD,
  isSessionCompactCommandText,
  shouldResetTransportPreferenceContextForSessionControl,
} from '../../shared/session-control-commands.js';
import type { TransportAttachment } from '../../shared/transport-attachments.js';
import {
  SharedContextDispatchError,
  dispatchSharedContextSend,
  resolveTransportDispatchAuthority,
} from './transport-runtime-assembly.js';
import type {
  ContextFreshness,
  ContextAuthorityDecision,
  ContextNamespace,
  SharedScopePolicyOverride,
  TransportMemoryRecallArtifact,
  TransportMemoryRecallItem,
} from '../../shared/context-types.js';
import type { MemoryContextTimelinePayload, MemoryContextTimelinePreferenceItem } from '../shared/timeline/types.js';
import { buildMemoryContextTimelinePayload, buildMemoryContextStatusPayload } from '../daemon/memory-context-timeline.js';
import { timelineEmitter } from '../daemon/timeline-emitter.js';
import { searchLocalMemorySemantic, type MemorySearchResultItem } from '../context/memory-search.js';
import { isTemplatePrompt, isTemplateOriginSummary, isImperativeCommand } from '../../shared/template-prompt-patterns.js';
import { applyRecallCapRule } from '../../shared/memory-scoring.js';
import {
  filterRecentlyInjected,
  recordRecentInjection,
  clearRecentInjectionHistory,
} from '../context/recent-injection-history.js';
import { getContextModelConfig } from '../context/context-model-config.js';
import { PREFERENCE_CONTEXT_END, PREFERENCE_CONTEXT_START } from '../../shared/preference-ingest.js';
import { clampUserSessionText } from '../../shared/user-session-text-caps.js';
import { resolveRuntimeAuthoredContext } from '../context/shared-context-runtime.js';
import { buildTransportStartupMemory, type TransportContextBootstrap } from './runtime-context-bootstrap.js';
import { recordMemoryHits } from '../store/context-store.js';
import logger from '../util/logger.js';
import { incrementCounter } from '../util/metrics.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';

export interface PendingTransportMessage {
  clientMessageId: string;
  /** User-visible task text, without daemon-rendered memory/context preambles. */
  text: string;
  /** Provider-visible per-turn context rendered through the shared context preamble path. */
  messagePreamble?: string;
  attachments?: TransportAttachment[];
  /** Server-authored share actor for attribution only; never injected into provider prompts. */
  sharedActor?: SharedActorEnvelope;
}

export interface TransportSendMetadata {
  sharedActor?: SharedActorEnvelope;
}

export interface TransportRuntimeDiagnosticSnapshot {
  status: AgentStatus;
  sending: boolean;
  pendingCount: number;
  pendingVersion: number;
  activeDispatchCount: number;
  stalePendingRecoveryActive: boolean;
  providerSessionBound: boolean;
  providerDiagnostics?: Record<string, unknown>;
  lastActivityAt: number;
  lastActivityAgeMs: number;
}

const DEFAULT_TRANSPORT_CONTEXT_BUDGET_MS = 2_500;
const DEFAULT_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS = 60_000;
const DEFAULT_TRANSPORT_STALE_PENDING_RECOVERY_MS = 300_000;
const MIN_TRANSPORT_CONTEXT_BUDGET_MS = 50;
const MAX_TRANSPORT_CONTEXT_BUDGET_MS = 30_000;
const MIN_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS = 50;
const MAX_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS = 10 * 60_000;
const MIN_TRANSPORT_STALE_PENDING_RECOVERY_MS = 10_000;
const MAX_TRANSPORT_STALE_PENDING_RECOVERY_MS = 30 * 60_000;

type TimeoutOutcome<T> =
  | { timedOut: false; value: T }
  | { timedOut: true };

function readBoundedTimeoutMs(
  envName: string,
  fallbackMs: number,
  minMs: number,
  maxMs: number,
  options?: { allowZero?: boolean },
): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallbackMs;
  if (options?.allowZero && parsed === 0) return 0;
  if (parsed < minMs) return minMs;
  if (parsed > maxMs) return maxMs;
  return parsed;
}

export function getTransportContextBudgetMs(): number {
  return readBoundedTimeoutMs(
    'IMCODES_TRANSPORT_CONTEXT_BUDGET_MS',
    DEFAULT_TRANSPORT_CONTEXT_BUDGET_MS,
    MIN_TRANSPORT_CONTEXT_BUDGET_MS,
    MAX_TRANSPORT_CONTEXT_BUDGET_MS,
    { allowZero: false },
  );
}

export function getTransportProviderSendTimeoutMs(): number {
  return readBoundedTimeoutMs(
    'IMCODES_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS',
    DEFAULT_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS,
    MIN_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS,
    MAX_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS,
    { allowZero: true },
  );
}

export function getTransportStalePendingRecoveryMs(): number {
  return readBoundedTimeoutMs(
    'IMCODES_TRANSPORT_STALE_PENDING_RECOVERY_MS',
    DEFAULT_TRANSPORT_STALE_PENDING_RECOVERY_MS,
    MIN_TRANSPORT_STALE_PENDING_RECOVERY_MS,
    MAX_TRANSPORT_STALE_PENDING_RECOVERY_MS,
    { allowZero: false },
  );
}

function withTimeoutOutcome<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<TimeoutOutcome<T>> {
  if (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return promise.then((value) => ({ timedOut: false, value }));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<TimeoutOutcome<T>>((resolve, reject) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isTransportSlashControl(message: string | undefined): boolean {
  return message?.trim().startsWith('/') === true;
}

function makeCancelledProviderError(): ProviderError {
  return {
    code: PROVIDER_ERROR_CODES.CANCELLED,
    message: 'Transport turn cancelled',
    recoverable: true,
  };
}

/**
 * Transport session runtime — manages a single conversation with a remote provider.
 *
 * Send model:
 *   - Idle: send() dispatches immediately, starts a new turn.
 *   - Busy: send() enqueues the message. When the active turn completes,
 *     ALL pending messages are merged into a single message and dispatched
 *     as one turn. This batches rapid-fire user input instead of creating
 *     N sequential turns.
 *
 * Status lifecycle:
 *   idle → thinking → streaming → idle   (normal turn)
 *   idle → thinking → error              (provider error)
 *   idle → thinking → idle               (cancel / no streaming)
 *
 * onStatusChange fires on every transition (deduplicated).
 */
export class TransportSessionRuntime implements SessionRuntime {
  readonly type = RUNTIME_TYPES.TRANSPORT;

  private _status: AgentStatus = 'idle';
  private _history: AgentMessage[] = [];
  private _providerSessionId: string | null = null;
  private _sending = false;
  /** Epoch ms of the last sign of life for the active turn — any provider
   *  event (delta / completion / error / tool call / session info) or a turn
   *  dispatch we initiated. Frozen if the provider wedges mid-turn (e.g. a
   *  lost `onComplete` leaves `_status='streaming'` / `_sending=true`
   *  forever). The daemon-upgrade gate reads its age to detect a phantom
   *  in-progress turn and stop blocking upgrades indefinitely — one stuck SDK
   *  session must never pin the daemon on an old version. */
  private _lastActivityAt = Date.now();
  private _description: string | undefined;
  private _systemPrompt: string | undefined;
  /**
   * Session-stable IM.codes identity (exact session name + display label).
   * Injected at assembly-time into `sessionSystemText`, peer-level with
   * `MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE`, so it lives OUTSIDE the
   * `USER_SESSION_TEXT_MAX_CHARS` cap that bounds user-authored
   * `_description` / `_systemPrompt`. See p2p audit 37bfbb85-430 N-A.
   */
  private _sessionIdentity: { sessionName: string; label: string | null } | undefined;
  private _agentId: string | undefined;
  private _effort: TransportEffortLevel | undefined;
  private _contextNamespace: ContextNamespace | undefined;
  private _contextNamespaceDiagnostics: string[] = [];
  private _contextRemoteProcessedFreshness: ContextFreshness | undefined;
  private _contextLocalProcessedFreshness: ContextFreshness | undefined;
  private _contextRetryExhausted = false;
  private _contextSharedPolicyOverride: SharedScopePolicyOverride | undefined;
  private _contextAuthoredContextLanguage: string | undefined;
  private _contextAuthoredContextFilePath: string | undefined;
  private _projectDir: string | undefined;
  private _startupMemory: TransportMemoryRecallArtifact | null = null;
  private _startupMemoryTimelineEmitted = false;
  private _startupMemoryInjected = false;
  /** Last provider-visible preference context block injected into this provider conversation.
   *  Preferences are stable session context, not per-turn recall; repeat injection
   *  bloats SDK prompt windows and can trigger provider auto-compaction. */
  private _lastInjectedPreferenceContextSignature: string | null = null;
  private _preferenceContextInjectionAttempt: { previous: string | null } | null = null;
  private _contextBootstrapResolver: (() => Promise<TransportContextBootstrap>) | undefined;
  private _unsubscribes: Array<() => void> = [];
  private _onStatusChange?: (status: AgentStatus) => void;

  /** Current turn completion signal — resolved by onComplete, rejected by onError. */
  private _activeTurn: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: ProviderError) => void;
  } | null = null;

  /** Messages queued while a turn is in flight. Drained and merged on turn completion. */
  private _pendingMessages: PendingTransportMessage[] = [];
  /**
   * Monotonic version of the pending-queue, bumped on EVERY mutation
   * (enqueue / drain / edit / remove / kill). The runtime owns the queue,
   * so it owns the authoritative ordering. Every daemon event that carries
   * a pending snapshot also carries this version; the UI ignores any
   * snapshot whose version is older than the newest it has already applied.
   * This is what prevents a stale snapshot (e.g. a `session_list` heartbeat
   * or `session.state:queued` built before a drain but delivered after it,
   * common on weak networks) from resurrecting already-drained entries —
   * the root cause of UI/daemon queue desync.
   */
  private _pendingVersion = 0;
  /** Original message entries for the currently in-flight dispatch. */
  private _activeDispatchEntries: PendingTransportMessage[] = [];
  /** True after a user stop request until the active provider turn settles. */
  private _activeDispatchCancelled = false;
  /** True once the active dispatch has crossed into provider.send(). */
  private _activeDispatchProviderStarted = false;
  private _activeDispatchId: number | null = null;
  private _activeDispatchStaleRecoveryStarted = false;
  private _nextDispatchId = 0;
  private readonly _locallyCancelledDispatchIds = new Set<number>();
  private _externalCompletionSettlementsToIgnore = 0;

  /** Callback fired when pending messages are drained into a new turn. */
  private _onDrain?: (messages: PendingTransportMessage[], mergedMessage: string, count: number) => void;
  private _onSessionInfoChange?: (info: SessionInfoUpdate) => void;
  private _onApprovalRequest?: (request: ApprovalRequest) => void;
  /** Fired exactly once per runtime lifetime, after startup memory is accepted
   *  by the provider on the first dispatch. Session-manager persists the flag
   *  to SessionRecord so future restores skip injection. */
  private _onStartupMemoryInjected?: () => void;

  constructor(
    private readonly provider: TransportProvider,
    private readonly sessionKey: string,
  ) {
    this._unsubscribes.push(
      this.provider.onDelta((sid: string, _delta: MessageDelta) => {
        if (sid !== this._providerSessionId) return;
        this._lastActivityAt = Date.now();
        if (this._activeDispatchCancelled) return;
        // A delta with no active turn is a late/stray callback from an
        // already-settled turn (provider callbacks are not dispatch-id scoped).
        // This is COSMETIC only: the relay forwards the delta TEXT independently
        // of this runtime state, so nothing is dropped here — we merely avoid
        // resurrecting the "working" animation for a turn that is already done.
        // (Reply delivery is governed by onComplete/onError below, which must
        // never silently drop a settlement.)
        if (!this.hasActiveTurnWork()) return;
        this.setStatus('streaming');
      }),
      this.provider.onComplete((sid: string, message: AgentMessage) => {
        if (sid !== this._providerSessionId) return;
        this._lastActivityAt = Date.now();
        if (this._externalCompletionSettlementsToIgnore > 0) {
          this._externalCompletionSettlementsToIgnore--;
          logger.warn(
            { sessionKey: this.sessionKey, status: this._status },
            'transport runtime ignored late provider completion for externally completed dispatch',
          );
          return;
        }
        if (!this.hasActiveTurnWork()) {
          // Late/out-of-band completion with no active turn to resolve (provider
          // callbacks are not dispatch-id scoped, so hasActiveTurnWork() can lag
          // reality after a settle/drain). Do NOT return early — that would DROP
          // the message: skip recording it to history and stall queued work.
          // Per "a transport turn must never silently complete" AND "never drop
          // any update/text", fall through to the normal settle path so the
          // message IS pushed to history and any queued message drains. The
          // body's null-guarded `_activeTurn?.resolve()` is a safe no-op.
          logger.warn(
            { sessionKey: this.sessionKey, status: this._status, pendingCount: this._pendingMessages.length },
            'transport runtime got provider completion without active turn; settling normally (not dropped)',
          );
        }
        if (this._activeDispatchCancelled) {
          this._sending = false;
          this._activeTurn?.reject(makeCancelledProviderError());
          this._activeTurn = null;
          this._activeDispatchEntries = [];
          this._activeDispatchCancelled = false;
          this._activeDispatchProviderStarted = false;
          if (this._activeDispatchId !== null) {
            this._locallyCancelledDispatchIds.delete(this._activeDispatchId);
          }
          this._activeDispatchId = null;
          this._activeDispatchStaleRecoveryStarted = false;
          if (!this._drainPending()) {
            this.setStatus('idle');
          }
          return;
        }
        if (isTransportCompactionCompletion(message)) {
          this._lastInjectedPreferenceContextSignature = null;
        }
        this._sending = false;
        this._history.push(message);
        this._activeTurn?.resolve();
        this._activeTurn = null;
        this._activeDispatchEntries = [];
        this._activeDispatchProviderStarted = false;
        this._activeDispatchId = null;
        this._activeDispatchStaleRecoveryStarted = false;
        // Drain pending messages before transitioning to idle.
        // If there are queued messages, merge and send — status stays running.
        if (!this._drainPending()) {
          this.setStatus('idle');
        }
      }),
      this.provider.onError((sid: string, error: ProviderError) => {
        if (sid !== this._providerSessionId) return;
        this._lastActivityAt = Date.now();
        if (this._externalCompletionSettlementsToIgnore > 0) {
          this._externalCompletionSettlementsToIgnore--;
          logger.warn(
            { sessionKey: this.sessionKey, status: this._status, errorCode: error.code },
            'transport runtime ignored late provider error for externally completed dispatch',
          );
          return;
        }
        if (!this.hasActiveTurnWork()) {
          // Late/out-of-band error with no active turn to reject. If there is no
          // queued work, keep the already-settled session idle instead of
          // resurrecting a stale provider callback into a user-visible error. If
          // queued work exists, fall through so recoverable/cancel errors can
          // drain it through the normal path; unrecoverable errors still surface
          // as terminal error without consuming the queue.
          logger.warn(
            { sessionKey: this.sessionKey, status: this._status, errorCode: error.code, pendingCount: this._pendingMessages.length },
            'transport runtime got provider error without active turn',
          );
          if (this._pendingMessages.length === 0) {
            this._activeDispatchCancelled = false;
            this._activeDispatchProviderStarted = false;
            this._activeDispatchId = null;
            this._activeDispatchStaleRecoveryStarted = false;
            if (this.isInProgressStatus(this._status) || this._status === 'error') this.setStatus('idle');
            return;
          }
        }
        this._sending = false;
        this._activeTurn?.reject(error);
        this._activeTurn = null;
        this._activeDispatchProviderStarted = false;
        if (this._activeDispatchId !== null) {
          this._locallyCancelledDispatchIds.delete(this._activeDispatchId);
        }
        this._activeDispatchId = null;
        this._activeDispatchStaleRecoveryStarted = false;
        // Only drain pending on recoverable/cancel errors — unrecoverable errors
        // (auth failure, provider down) would just fail again and consume queued messages.
        const canDrain = error.code === 'CANCELLED' || error.recoverable;
        this._activeDispatchCancelled = false;
        if (canDrain) {
          this._activeDispatchEntries = [];
          if (this._drainPending()) return;
        }
        this.setStatus(error.code === 'CANCELLED' ? 'idle' : 'error');
      }),
      ...(this.provider.onSessionInfo ? [this.provider.onSessionInfo((sid: string, info: SessionInfoUpdate) => {
        if (sid !== this._providerSessionId) return;
        this._lastActivityAt = Date.now();
        this._onSessionInfoChange?.(info);
      })] : []),
      ...(this.provider.onStatus ? [this.provider.onStatus((sid: string, _status: ProviderStatusUpdate) => {
        if (sid !== this._providerSessionId) return;
        this._lastActivityAt = Date.now();
      })] : []),
      ...(this.provider.onUsage ? [this.provider.onUsage((sid: string, _update: ProviderUsageUpdate) => {
        if (sid !== this._providerSessionId) return;
        this._lastActivityAt = Date.now();
      })] : []),
    );
    const unsubscribeToolCall = this.provider.onToolCall?.((sid: string) => {
      if (sid !== this._providerSessionId) return;
      this._lastActivityAt = Date.now();
      if (this._activeDispatchId === null || !this._activeTurn) return;
      // Provider-visible tool events mean the SDK has already accepted work,
      // even if the shared-context dispatcher has not crossed its provider.send
      // callback boundary yet. STOP must then delegate to provider.cancel so
      // SDKs can abort/rotate poisoned sessions instead of taking the purely
      // local pre-send skip path.
      this._activeDispatchProviderStarted = true;
    }) as unknown;
    if (typeof unsubscribeToolCall === 'function') {
      this._unsubscribes.push(unsubscribeToolCall as () => void);
    }
    if (this.provider.onApprovalRequest) {
      this.provider.onApprovalRequest((sid: string, req: ApprovalRequest) => {
        if (sid !== this._providerSessionId) return;
        this._lastActivityAt = Date.now();
        this._onApprovalRequest?.(req);
      });
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Register a callback for status changes (idle/streaming/thinking/error). */
  set onStatusChange(cb: (status: AgentStatus) => void) { this._onStatusChange = cb; }

  /** Register a callback for when pending messages are drained into a new turn. */
  set onDrain(cb: (messages: PendingTransportMessage[], mergedMessage: string, count: number) => void) { this._onDrain = cb; }
  /** Register a callback fired exactly once when startup memory reaches the provider. */
  set onStartupMemoryInjected(cb: () => void) { this._onStartupMemoryInjected = cb; }
  /** Register a callback for provider session metadata updates. */
  set onSessionInfoChange(cb: (info: SessionInfoUpdate) => void) { this._onSessionInfoChange = cb; }
  set onApprovalRequest(cb: (request: ApprovalRequest) => void) { this._onApprovalRequest = cb; }

  /** Set providerSessionId directly (restore from store without initialize). */
  setProviderSessionId(id: string): void { this._providerSessionId = id; }
  setDescription(desc: string): void { this._description = clampUserSessionText(desc); }
  setSystemPrompt(prompt: string): void { this._systemPrompt = clampUserSessionText(prompt); }
  /**
   * Update the session-stable IM.codes identity injected into every
   * transport turn's `sessionSystemText`. Daemon-injected and NOT subject
   * to `USER_SESSION_TEXT_MAX_CHARS` — see p2p audit 37bfbb85-430 N-A.
   */
  setSessionIdentity(sessionName: string, label: string | null | undefined): void {
    const exact = sessionName.trim();
    if (!exact) return;
    this._sessionIdentity = { sessionName: exact, label: label?.trim() || null };
  }
  setAgentId(agentId: string): void {
    this._agentId = agentId;
    if (this._providerSessionId) {
      this.provider.setSessionAgentId?.(this._providerSessionId, agentId);
    }
  }
  setEffort(effort: TransportEffortLevel): void {
    this._effort = effort;
    if (this._providerSessionId) {
      this.provider.setSessionEffort?.(this._providerSessionId, effort);
    }
  }

  get providerSessionId(): string | null { return this._providerSessionId; }
  get sending(): boolean { return this._sending; }
  /** Number of messages waiting in the queue. */
  get pendingCount(): number { return this._pendingMessages.length; }
  /** Monotonic version of the pending-queue. See `_pendingVersion`. */
  get pendingVersion(): number { return this._pendingVersion; }
  /** Snapshot of queued messages waiting to be drained (legacy text-only view). */
  get pendingMessages(): string[] { return this._pendingMessages.map((entry) => entry.text); }
  /** Snapshot of queued messages waiting to be drained (stable entity ids for UI/edit/undo). */
  get pendingEntries(): PendingTransportMessage[] { return this._pendingMessages.map((entry) => ({ ...entry })); }
  /** Snapshot of the message entries currently being dispatched. */
  get activeDispatchEntries(): PendingTransportMessage[] { return this._activeDispatchEntries.map((entry) => ({ ...entry })); }

  getDiagnosticSnapshot(nowMs: number = Date.now()): TransportRuntimeDiagnosticSnapshot {
    let providerDiagnostics: Record<string, unknown> | null | undefined;
    if (this._providerSessionId) {
      try {
        providerDiagnostics = this.provider.getSessionDiagnostics?.(this._providerSessionId);
      } catch (err) {
        logger.warn({
          provider: this.provider.id,
          providerSessionId: this._providerSessionId,
          err,
        }, 'Transport provider diagnostics read failed');
      }
    }
    return {
      status: this._status,
      sending: this._sending,
      pendingCount: this._pendingMessages.length,
      pendingVersion: this._pendingVersion,
      activeDispatchCount: this._activeDispatchEntries.length,
      stalePendingRecoveryActive: this._activeDispatchStaleRecoveryStarted,
      providerSessionBound: !!this._providerSessionId,
      ...(providerDiagnostics ? { providerDiagnostics } : {}),
      lastActivityAt: this._lastActivityAt,
      lastActivityAgeMs: Math.max(0, nowMs - this._lastActivityAt),
    };
  }

  /**
   * Repair the only invalid queue-visible idle state: no active turn, runtime
   * status idle, but queued messages are still waiting. This can happen when a
   * provider surfaces an idle/finished status without a matching completion
   * callback. The daemon polls session-list frequently, so nudging here keeps
   * the queue moving without requiring a user Stop click.
   */
  drainPendingIfIdle(reason = 'idle-observed'): boolean {
    if (this._status !== 'idle') return false;
    return this.drainPendingIfNoActiveTurn(reason);
  }

  /**
   * Queue-visible watchdog for the harder split-brain case: the provider/UI
   * has gone quiet, but the runtime never received onComplete/onError, so an
   * active dispatch pins `_sending=true` and queued user messages never drain.
   * We do not abandon the active turn locally because late provider callbacks
   * are not dispatch-id scoped. Instead, nudge the provider's normal cancel
   * path once; its recoverable CANCELLED callback owns the existing drain path.
   */
  cancelStaleActiveTurnWithPending(options?: {
    reason?: string;
    nowMs?: number;
    staleMs?: number;
  }): boolean {
    if (this._activeDispatchStaleRecoveryStarted) return false;
    if (!this._providerSessionId) return false;
    if (this._pendingMessages.length === 0) return false;
    if (!this._sending && !this._activeTurn && this._activeDispatchEntries.length === 0) return false;
    const nowMs = options?.nowMs ?? Date.now();
    const staleMs = options?.staleMs ?? getTransportStalePendingRecoveryMs();
    const lastActivityAgeMs = Math.max(0, nowMs - this._lastActivityAt);
    if (lastActivityAgeMs < staleMs) return false;

    this._activeDispatchStaleRecoveryStarted = true;
    logger.warn(
      {
        sessionKey: this.sessionKey,
        reason: options?.reason ?? 'stale-pending',
        status: this._status,
        sending: this._sending,
        activeDispatchCount: this._activeDispatchEntries.length,
        pendingCount: this._pendingMessages.length,
        pendingVersion: this._pendingVersion,
        lastActivityAgeMs,
        staleMs,
      },
      'transport runtime active turn is stale with queued messages; cancelling once so pending work can drain',
    );
    void this.cancel().catch((err) => {
      this._activeDispatchStaleRecoveryStarted = false;
      logger.warn(
        { err, sessionKey: this.sessionKey, pendingCount: this._pendingMessages.length },
        'transport stale pending recovery cancel failed',
      );
    });
    return true;
  }

  /**
   * Some daemon workflows have their own durable completion proof outside the
   * provider stream, such as an Auto Deliver or P2P marker file. Once that
   * proof is accepted, waiting for a late SDK onComplete/onError can keep the
   * session visually "working" and block queued workflow continuations. Settle
   * the current dispatch locally, optionally nudge the provider to stop in the
   * background, and then drain queued runtime sends through the normal
   * one-turn-at-a-time path.
   */
  settleActiveDispatchFromExternalCompletion(reason = 'external-completion'): boolean {
    if (!this.hasActiveTurnWork()) return false;
    const dispatchId = this._activeDispatchId;
    if (dispatchId !== null) this._locallyCancelledDispatchIds.add(dispatchId);
    const providerSessionId = this._providerSessionId;
    const providerStarted = this._activeDispatchProviderStarted;
    const providerCanCancel = !!this.provider.cancel && !!providerSessionId;
    if (providerStarted && providerCanCancel) this._externalCompletionSettlementsToIgnore += 1;

    logger.warn(
      {
        sessionKey: this.sessionKey,
        reason,
        status: this._status,
        activeDispatchCount: this._activeDispatchEntries.length,
        pendingCount: this._pendingMessages.length,
        providerStarted,
      },
      'transport runtime active dispatch externally completed; settling locally',
    );

    this._sending = false;
    this._activeTurn?.resolve();
    this._activeTurn = null;
    this._activeDispatchEntries = [];
    this._activeDispatchCancelled = false;
    this._activeDispatchProviderStarted = false;
    this._activeDispatchId = null;
    this._activeDispatchStaleRecoveryStarted = false;

    if (providerStarted && providerCanCancel) {
      try {
        const cancelResult = this.provider.cancel!(providerSessionId);
        void Promise.resolve(cancelResult).catch((err) => {
          logger.warn(
            { err, sessionKey: this.sessionKey, providerSessionId, reason },
            'transport runtime external completion provider cancel failed',
          );
        });
      } catch (err) {
        logger.warn(
          { err, sessionKey: this.sessionKey, providerSessionId, reason },
          'transport runtime external completion provider cancel threw',
        );
      }
    }

    if (!this._drainPending()) {
      this.setStatus('idle');
    }
    return true;
  }

  private drainPendingIfNoActiveTurn(reason: string): boolean {
    if (this._sending || this._activeTurn) return false;
    if (this._pendingMessages.length === 0 || !this._providerSessionId) return false;
    logger.warn(
      {
        sessionKey: this.sessionKey,
        pendingCount: this._pendingMessages.length,
        pendingVersion: this._pendingVersion,
        reason,
      },
      'transport runtime idle with pending messages; draining queued messages',
    );
    return this._drainPending();
  }

  private hasActiveTurnWork(): boolean {
    return this._sending || !!this._activeTurn || this._activeDispatchEntries.length > 0;
  }

  private isInProgressStatus(status: AgentStatus): boolean {
    return status === 'streaming'
      || status === 'thinking'
      || status === 'tool_running'
      || status === 'permission';
  }

  setContextBootstrapResolver(
    resolver: (() => Promise<TransportContextBootstrap>) | undefined,
  ): void {
    this._contextBootstrapResolver = resolver;
  }

  async initialize(config: SessionConfig): Promise<void> {
    // When resuming/restoring an existing conversation, mark startup memory
    // injected BEFORE applyContextBootstrap runs so the bootstrap's
    // `if (!this._startupMemoryInjected) this._startupMemory = …` guard
    // leaves `_startupMemory` as null. This is the mechanism that prevents
    // re-injecting "related past work" into a session that already has it.
    const alreadyInjected = config.startupMemoryAlreadyInjected === true;
    if (alreadyInjected) {
      this._startupMemoryInjected = true;
      this._startupMemoryTimelineEmitted = true;
      this._startupMemory = null;
    }

    this._providerSessionId = await this.provider.createSession(config);
    // Cap user-authored text so a single oversized paste can't bloat every
    // subsequent turn — these get re-injected into the system prompt on
    // every model call. See `shared/user-session-text-caps.ts`.
    this._description = clampUserSessionText(config.description);
    this._systemPrompt = clampUserSessionText(config.systemPrompt);
    // Capture identity for assembly-time injection. Daemon-injected and
    // NOT subject to the user-authored cap — see p2p audit 37bfbb85-430 N-A.
    if (config.sessionName) {
      this.setSessionIdentity(config.sessionName, config.label);
    }
    this._projectDir = config.cwd;
    this._agentId = config.agentId;
    this._effort = config.effort;
    this.applyContextBootstrap({
      namespace: config.contextNamespace,
      diagnostics: config.contextNamespaceDiagnostics ?? [],
      remoteProcessedFreshness: config.contextRemoteProcessedFreshness,
      localProcessedFreshness: config.contextLocalProcessedFreshness,
      retryExhausted: config.contextRetryExhausted,
      sharedPolicyOverride: config.contextSharedPolicyOverride,
      authoredContextLanguage: config.contextAuthoredContextLanguage,
      authoredContextFilePath: config.contextAuthoredContextFilePath,
    });
    await this.refreshContextBootstrap({ phase: 'initialize' });

    if (!alreadyInjected) {
      // Fresh conversation — reset the gate so the next turn will build and
      // inject startup memory. The timeline card is emitted later in
      // `_dispatchTurn` at the same boundary where the provider actually
      // accepts the startup payload (and `startupMemoryInjected` is
      // persisted). Emitting it here would leak a new card on every
      // restart-before-first-message, because the flag never gets persisted
      // until a turn lands — those duplicate cards then stack forever in
      // the timeline replay.
      this._startupMemoryTimelineEmitted = false;
      this._startupMemoryInjected = false;
    }
  }

  /**
   * Send a message to the provider.
   *
   * - If idle: dispatches immediately (starts a new turn).
   * - If busy: enqueues. When the current turn completes, all pending
   *   messages are merged and dispatched as a single turn.
   *
   * Returns 'sent' if dispatched immediately, 'queued' if enqueued.
   */
  send(
    message: string,
    clientMessageId?: string,
    attachments?: TransportAttachment[],
    messagePreamble?: string,
    metadata?: TransportSendMetadata,
  ): 'sent' | 'queued' {
    if (!this._providerSessionId) {
      throw new Error('TransportSessionRuntime not initialized — call initialize() first');
    }
    if (isSessionCompactCommandText(message) && this.provider.capabilities.compact?.execution === 'unsupported') {
      const reason = this.provider.capabilities.compact.reason?.trim();
      throw new Error(reason || `${this.provider.id} does not support /compact`);
    }

    const entry: PendingTransportMessage = {
      clientMessageId: clientMessageId ?? randomUUID(),
      text: message,
      ...(messagePreamble?.trim() ? { messagePreamble: messagePreamble.trim() } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(metadata?.sharedActor ? { sharedActor: metadata.sharedActor } : {}),
    };

    if (this.hasActiveTurnWork()) {
      this._pendingMessages.push(entry);
      this._pendingVersion++;
      return 'queued';
    }

    // N-R8 defense-in-depth (audit 0419d1ac-1f4) — wrap direct dispatch so a
    // synchronous prologue throw inside `_dispatchTurn` (e.g. some future
    // listener regression in `setStatus → _onStatusChange`) cannot leave
    // `_sending` true with no in-flight turn. After C1b isolates
    // `setStatus`, this path's sync prologue rarely throws, but the
    // exception path must reset state and rethrow so the caller's error
    // handling (`command-handler.ts` send try/catch) emits the proper
    // error ack instead of silently looking like a successful send.
    try {
      this._dispatchTurn(message, entry.clientMessageId, attachments, [entry]);
    } catch (err) {
      logger.error(
        { err, providerSessionId: this._providerSessionId, clientMessageId: entry.clientMessageId },
        'runtime.send: _dispatchTurn synchronous prologue threw — rethrowing for caller error path',
      );
      // _dispatchTurn may have partially advanced state before throwing.
      // Reset so the runtime is usable for the next send.
      this._sending = false;
      this._activeTurn = null;
      this._activeDispatchEntries = [];
      this._activeDispatchProviderStarted = false;
      this._activeDispatchCancelled = false;
      this._activeDispatchId = null;
      this._activeDispatchStaleRecoveryStarted = false;
      throw err;
    }
    return 'sent';
  }

  editPendingMessage(clientMessageId: string, text: string): boolean {
    const nextText = text.trim();
    if (!clientMessageId || !nextText) return false;
    const entry = this._pendingMessages.find((item) => item.clientMessageId === clientMessageId);
    if (!entry) return false;
    entry.text = nextText;
    entry.messagePreamble = undefined;
    this._pendingVersion++;
    return true;
  }

  removePendingMessage(clientMessageId: string): PendingTransportMessage | null {
    if (!clientMessageId) return null;
    const index = this._pendingMessages.findIndex((item) => item.clientMessageId === clientMessageId);
    if (index < 0) return null;
    const [removed] = this._pendingMessages.splice(index, 1);
    this._pendingVersion++;
    return removed ?? null;
  }

  async cancel(): Promise<void> {
    if (!this._providerSessionId) {
      throw new Error('TransportSessionRuntime not initialized — call initialize() first');
    }
    // STOP/CANCEL is a cut-in-line operation, not a queued transport turn.
    // It must be effective while the active turn is still in the async
    // pre-provider phase (context bootstrap, memory recall, authored context
    // assembly) as well as after provider.send() has started. If provider.send()
    // has not started yet, cancel locally and skip that send entirely; if it
    // has started, delegate to the provider-specific interrupt/abort path.
    // Keep queued user messages intact so they may drain after the cancelled
    // turn settles; only the currently active turn is being interrupted.
    const dispatchId = this._activeDispatchId;
    if (dispatchId !== null) {
      this._locallyCancelledDispatchIds.add(dispatchId);
      this._activeDispatchCancelled = true;
    }
    if (this._activeTurn && !this._activeDispatchProviderStarted) {
      this.cancelActiveDispatchLocally(dispatchId);
      return;
    }
    if (!this.provider.cancel) {
      this.cancelActiveDispatchLocally(dispatchId);
      return;
    }
    // The provider's CANCELLED callback (onComplete/onError) settles the turn
    // and owns the queue drain, but it can arrive late or not at all. Until it
    // does, getStatus() stays at streaming/thinking — which makes
    // resolveTransportSessionListState() report 'running' on the next
    // session_list pass and resurrect the "working" sweep/pulse after the user
    // stopped (the UI animation never syncs to idle). Reflect idle now when
    // nothing is queued — without draining here, since the callback owns the
    // drain, so a session with queued work keeps running through to its next
    // turn.
    if (this.pendingCount === 0) this.setStatus('idle');
    await this.provider.cancel(this._providerSessionId);
  }

  getStatus(): AgentStatus { return this._status; }

  /** Epoch ms of the last provider event or turn dispatch. The daemon-upgrade
   *  gate uses `Date.now() - lastActivityAt` to detect a phantom in-progress
   *  turn (wedged provider) and avoid blocking upgrades forever. */
  get lastActivityAt(): number { return this._lastActivityAt; }

  async kill(): Promise<void> {
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes = [];

    if (this._providerSessionId) {
      await this.provider.endSession(this._providerSessionId);
      this._providerSessionId = null;
    }
    if (this._activeTurn) {
      this._activeTurn.reject({ code: 'CANCELLED', message: 'Session killed', recoverable: false });
    }
    this.setStatus('idle');
    this._sending = false;
    this._activeTurn = null;
    this._activeDispatchEntries = [];
    this._activeDispatchCancelled = false;
    this._activeDispatchProviderStarted = false;
    this._activeDispatchId = null;
    this._activeDispatchStaleRecoveryStarted = false;
    this._locallyCancelledDispatchIds.clear();
    this._externalCompletionSettlementsToIgnore = 0;
    if (this._pendingMessages.length > 0) {
      logger.warn(
        { sessionKey: this.sessionKey, pendingCount: this._pendingMessages.length },
        'transport runtime kill cleared pending messages',
      );
      this._pendingVersion++;
    }
    this._pendingMessages = [];
    // Per-session memory injection history is daemon-scoped to this session;
    // a kill ends that scope. clear() is called on session.clear separately.
    clearRecentInjectionHistory(this.sessionKey);
  }

  getHistory(): AgentMessage[] { return [...this._history]; }

  // ── Internal ────────────────────────────────────────────────────────────────

  private setStatus(status: AgentStatus): void {
    if (status === 'idle' && this.drainPendingIfNoActiveTurn('setStatus')) return;
    if (this._status === status) return;
    this._status = status;
    if (!this._onStatusChange) return;
    // Cx1 §2 / observer-isolation fix (audit 0419d1ac-1f4) — the status
    // observer is an external callback (registered by
    // `wireTransportCallbacks` in session-manager.ts) that synchronously
    // emits timeline events. State-machine progress MUST NOT depend on
    // observer success: a throwing listener used to propagate through
    // `setStatus` and abort `_dispatchTurn`'s sync prologue (N-R7),
    // leaving runtime wedged. Catch + warn; never let observer exceptions
    // tear down the state machine.
    try {
      this._onStatusChange(status);
    } catch (err) {
      logger.warn(
        { err, providerSessionId: this._providerSessionId, status },
        'setStatus: onStatusChange listener threw',
      );
    }
  }

  /** Dispatch a single turn to the provider. Assumes _sending is false. */
  private _dispatchTurn(
    message: string,
    clientMessageId?: string,
    attachments?: TransportAttachment[],
    dispatchedEntries?: PendingTransportMessage[],
  ): void {
    const dispatchId = ++this._nextDispatchId;
    this._lastActivityAt = Date.now();
    this._sending = true;
    this._activeDispatchCancelled = false;
    this._activeDispatchProviderStarted = false;
    this._activeDispatchId = dispatchId;
    this._activeDispatchStaleRecoveryStarted = false;
    this._activeDispatchEntries = (dispatchedEntries ?? [{
      clientMessageId: clientMessageId ?? randomUUID(),
      text: message,
      ...(attachments?.length ? { attachments } : {}),
    }]).map((entry) => ({ ...entry }));

    let resolve!: () => void;
    let reject!: (err: ProviderError) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej as (err: ProviderError) => void;
    });
    void promise.catch(() => {}); // prevent unhandled rejection
    this._activeTurn = { promise, resolve, reject };

    this._history.push({
      id: randomUUID(),
      sessionId: this._providerSessionId!,
      kind: 'text',
      role: 'user',
      content: message,
      timestamp: Date.now(),
      status: 'complete',
    });

    this.setStatus('thinking');

    if (shouldResetTransportPreferenceContextForSessionControl(message)) {
      this._lastInjectedPreferenceContextSignature = null;
    }

    if (isSessionCompactCommandText(message)) {
      timelineEmitter.emit(this.sessionKey, 'session.state', {
        state: SESSION_CONTROL_TIMELINE_STATE_COMPACTING,
        reason: SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT,
      }, { source: 'daemon', confidence: 'high' });
    }

    void (async () => {
      await this.refreshContextBootstrap({ phase: 'dispatch' });
      if (this.isDispatchLocallyCancelled(dispatchId)) {
        this.cancelActiveDispatchLocally(dispatchId);
        return;
      }
      const isSlashControl = isTransportSlashControl(message);
      const authority = resolveTransportDispatchAuthority(this.provider, {
        namespace: this._contextNamespace,
        remoteProcessedFreshness: this._contextRemoteProcessedFreshness,
        localProcessedFreshness: this._contextLocalProcessedFreshness,
        retryExhausted: this._contextRetryExhausted,
        sharedPolicyOverride: this._contextSharedPolicyOverride,
      }).authority;
      const startupMemory = isSlashControl ? null : (this._startupMemory ?? (
        !this._startupMemoryInjected && authority.authoritySource === 'processed_local' && this._contextNamespace
          ? buildTransportStartupMemory(this._contextNamespace, { projectDir: this._projectDir })
          : null
      ));
      const memoryRecallResult = isSlashControl
        ? {
            artifact: null,
            statusPayload: buildMemoryContextStatusPayload(message.trim().slice(0, 200), 'skipped_control_message', 'message', {
              runtimeFamily: 'transport',
              authoritySource: authority.authoritySource,
              sourceKind: 'local_processed',
            }),
          }
        : await this.buildTransportMessageRecallResultWithinBudget(message, authority.authoritySource);
      const memoryRecall = memoryRecallResult.artifact;
      const messagePreamble = isSlashControl ? undefined : this.mergeMessagePreambles(dispatchedEntries, message);
      if (this.isDispatchLocallyCancelled(dispatchId)) {
        this.cancelActiveDispatchLocally(dispatchId);
        return;
      }
      // Daemon-injected identity is stable session metadata — same on
      // every turn, NOT user-authored — so we always pass it through.
      // Slash control commands still get it: it is cheap, reinforces the
      // model's identity for control replies, and skipping it on `/foo`
      // would leak the exact session name out of the model's awareness
      // on follow-up turns when the cached system text is rebuilt from
      // a slash-only tail. The 300-char user-authored cap stays in
      // force on `description` / `systemPrompt`; identity is peer-level.
      // Generated Image Reporting is now appended in Codex SDK's own
      // `baseInstructions` tail (Codex-only, once per thread/start) —
      // it does NOT ride the per-turn payload at all.
      const dispatchResult = await dispatchSharedContextSend(this.provider, this._providerSessionId!, {
        userMessage: message,
        messagePreamble,
        description: isSlashControl ? undefined : this._description,
        systemPrompt: isSlashControl ? undefined : this._systemPrompt,
        suppressMcpMemorySearchGuidance: isSlashControl,
        suppressAgentProgressGuidance: isSlashControl,
        attachments,
        namespace: this._contextNamespace,
        namespaceDiagnostics: this._contextNamespaceDiagnostics,
        remoteProcessedFreshness: this._contextRemoteProcessedFreshness,
        localProcessedFreshness: this._contextLocalProcessedFreshness,
        retryExhausted: this._contextRetryExhausted,
        sharedPolicyOverride: this._contextSharedPolicyOverride,
        authoredContextRepository: isSlashControl ? undefined : this.resolveAuthoredContextRepository(),
        authoredContextLanguage: isSlashControl ? undefined : this._contextAuthoredContextLanguage,
        authoredContextFilePath: isSlashControl ? undefined : this._contextAuthoredContextFilePath,
        ...(this._sessionIdentity ? { sessionIdentity: this._sessionIdentity } : {}),
        ...(startupMemory ? { startupMemory } : {}),
        ...(memoryRecall ? { memoryRecall } : {}),
      }, {
        resolveAuthoredContext: (input) => {
          if (isSlashControl) return Promise.resolve([]);
          if (!input.namespace) return Promise.resolve([]);
          return resolveRuntimeAuthoredContext(input.namespace, {
            language: input.authoredContextLanguage,
            filePath: input.authoredContextFilePath,
          });
        },
        sendTimeoutMs: getTransportProviderSendTimeoutMs(),
        onBeforeProviderSend: () => {
          if (this.isDispatchLocallyCancelled(dispatchId)) {
            throw makeCancelledProviderError();
          }
          if (this._activeDispatchId === dispatchId) {
            this._activeDispatchProviderStarted = true;
          }
        },
      });
      if (this.isDispatchLocallyCancelled(dispatchId)) {
        await this.provider.cancel?.(this._providerSessionId!).catch((err: unknown) => {
          logger.warn({ err, providerSessionId: this._providerSessionId }, 'runtime dispatch noticed late cancel after provider send accepted');
        });
        return;
      }
      if (dispatchResult.payload?.memoryRecall) {
        const hitIds = dispatchResult.payload.memoryRecall.items.map((item) => item.id);
        if (hitIds.length > 0) {
          try { recordMemoryHits(hitIds); } catch { /* non-fatal */ }
        }
        this.emitMemoryContextEvent(dispatchResult.payload.memoryRecall, clientMessageId);
      } else if (memoryRecallResult.statusPayload) {
        this.emitMemoryContextStatusEvent(memoryRecallResult.statusPayload, clientMessageId);
      }
      this._preferenceContextInjectionAttempt = null;
      if (!this._startupMemoryInjected && dispatchResult.payload?.startupMemory) {
        this._startupMemoryInjected = true;
        // Emit the "Historical context · injected" timeline card at the
        // same commit boundary as the persisted flag. Doing this here
        // (instead of eagerly in `initialize`) guarantees restart-before-
        // first-message never leaks an unbacked card — the card appears
        // exactly once, for the turn that actually carried the preamble.
        this.emitStartupMemoryContext(
          dispatchResult.payload.startupMemory,
          extractPreferenceContextTimelineItems(dispatchResult.payload.messagePreamble),
        );
        this._startupMemory = null;
        // Notify session-manager so the flag is persisted to SessionRecord.
        // Invoked synchronously — the callback just schedules an upsert and
        // returns, so there's no ordering risk with the rest of this turn.
        try { this._onStartupMemoryInjected?.(); } catch (err) {
          logger.warn({ err, sessionKey: this.sessionKey }, 'onStartupMemoryInjected callback failed');
        }
      }
    })()
      .catch((err) => {
        // Only handle if the provider didn't already fire onError callback.
        // Shared-context dispatch denial is surfaced here as a send failure
        // because the outer runtime contract is still send-oriented.
        if (this._preferenceContextInjectionAttempt) {
          this._lastInjectedPreferenceContextSignature = this._preferenceContextInjectionAttempt.previous;
          this._preferenceContextInjectionAttempt = null;
        }
        if (this._activeDispatchId !== dispatchId || !this._sending || !this._activeTurn) {
          this._locallyCancelledDispatchIds.delete(dispatchId);
          return;
        }
        this.setStatus('error');
        this._sending = false;
        this._activeTurn.reject(
          err instanceof SharedContextDispatchError
            ? err.toProviderError()
            : (typeof err === 'object' && err && 'code' in err
                ? err
                : { code: 'PROVIDER_ERROR', message: String(err), recoverable: false }),
        );
        this._activeTurn = null;
        this._activeDispatchProviderStarted = false;
        this._activeDispatchCancelled = false;
        if (this._activeDispatchId === dispatchId) {
          this._activeDispatchId = null;
        }
        this._activeDispatchStaleRecoveryStarted = false;
        this._locallyCancelledDispatchIds.delete(dispatchId);
        // Preserve the in-flight payload so session-manager can replay it
        // after automatically rebuilding the transport runtime.
        // Don't drain on async send failure — the provider is likely broken.
      });
  }

  private resolveAuthoredContextRepository(): string | undefined {
    const projectId = this._contextNamespace?.projectId?.trim();
    if (!projectId || projectId.startsWith('local/')) return undefined;
    return projectId;
  }

  /**
   * Drain all pending messages into a single merged turn.
   * Called after onComplete/onError. Returns true if a new turn was started.
   */
  private _drainPending(): boolean {
    if (this._pendingMessages.length === 0 || !this._providerSessionId) return false;

    const messages = this._pendingMessages.splice(0);
    // Bump the queue version the moment the queue empties. The onDrain
    // callback below emits this new version on both the per-entry
    // `user.message` events and the cleared `session.state`, so a stale
    // pre-drain snapshot (lower version) delivered later cannot resurrect
    // these entries in the UI.
    this._pendingVersion++;
    const merged = messages.map((entry) => entry.text).join('\n\n');
    const attachments = messages.flatMap((entry) => entry.attachments ?? []);
    // N1 defensive fix (audit f395d49c-78c) — set `_sending=true` BEFORE
    // calling `_onDrain` so any synchronous re-entrant `runtime.send` from
    // an onDrain listener queues into `_pendingMessages` instead of
    // initiating a parallel dispatch.
    this._sending = true;
    // N-R1 fix (audit 0419d1ac-1f4) — isolate `_onDrain` so an observer
    // exception does NOT skip `_dispatchTurn`. Before this fix, the
    // sequence `_sending=true` → `_onDrain throws` → propagation aborted
    // `_dispatchTurn` AND left `_sending` permanently true with
    // `_pendingMessages` already spliced empty — runtime stuck forever,
    // user-visible as bug 2 "bot stays asleep".
    try {
      this._onDrain?.(messages, merged, messages.length);
    } catch (err) {
      logger.warn(
        { err, providerSessionId: this._providerSessionId, count: messages.length },
        '_drainPending: onDrain listener threw',
      );
    }
    // N-R7 fix (audit 0419d1ac-1f4) — `_dispatchTurn` synchronous prologue
    // (`_history.push`, `setStatus`, `_activeTurn` setup) can in principle
    // throw via the `setStatus → _onStatusChange → timelineEmitter.emit`
    // chain. After C1b isolates `setStatus`, this becomes much harder to
    // trigger, but defense-in-depth: if the sync prologue ever throws,
    // we MUST reset `_sending` and surface an error status, otherwise the
    // runtime is wedged at `_sending=true` with no in-flight turn.
    try {
      this._dispatchTurn(
        merged,
        messages.length === 1 ? messages[0]?.clientMessageId : undefined,
        attachments.length > 0 ? attachments : undefined,
        messages,
      );
    } catch (err) {
      logger.error(
        { err, providerSessionId: this._providerSessionId, count: messages.length },
        '_drainPending: _dispatchTurn synchronous prologue threw — resetting runtime state',
      );
      this._sending = false;
      this._activeTurn = null;
      this._activeDispatchEntries = [];
      this._activeDispatchProviderStarted = false;
      this._activeDispatchCancelled = false;
      this._activeDispatchId = null;
      this._activeDispatchStaleRecoveryStarted = false;
      // Last-resort status update; `setStatus` itself is isolated post-C1b
      // but wrap defensively in case future code regresses that contract.
      try { this.setStatus('error'); } catch { /* swallow */ }
      // Note: `messages` are NOT restored to `_pendingMessages`. Restoring
      // would create a tight retry loop against the same failing path.
      // The user must resend; the error status notifies them.
    }
    return true;
  }

  private isDispatchLocallyCancelled(dispatchId: number): boolean {
    return this._locallyCancelledDispatchIds.has(dispatchId);
  }

  private cancelActiveDispatchLocally(dispatchId: number | null = this._activeDispatchId): void {
    if (dispatchId !== null && this._activeDispatchId !== dispatchId) {
      this._locallyCancelledDispatchIds.delete(dispatchId);
      return;
    }
    if (!this._activeTurn && !this._sending) {
      if (dispatchId !== null) this._locallyCancelledDispatchIds.delete(dispatchId);
      this._activeDispatchCancelled = false;
      this._activeDispatchProviderStarted = false;
      this._activeDispatchId = null;
      this._activeDispatchStaleRecoveryStarted = false;
      return;
    }
    this._sending = false;
    this._activeTurn?.reject(makeCancelledProviderError());
    this._activeTurn = null;
    this._activeDispatchEntries = [];
    this._activeDispatchCancelled = false;
    this._activeDispatchProviderStarted = false;
    this._activeDispatchId = null;
    this._activeDispatchStaleRecoveryStarted = false;
    if (!this._drainPending()) {
      this.setStatus('idle');
    }
  }

  private mergeMessagePreambles(entries: PendingTransportMessage[] | undefined, userMessage?: string): string | undefined {
    if (!entries || entries.length === 0) return undefined;
    const seen = new Set<string>();
    const parts: string[] = [];
    const isControlMessage = userMessage?.trim().startsWith('/') === true;
    if (userMessage && shouldResetTransportPreferenceContextForSessionControl(userMessage)) {
      // The compact control command must stay raw, and the next real turn
      // should re-seed stable preferences because the provider may have
      // discarded prior context during compaction.
      this._lastInjectedPreferenceContextSignature = null;
    }
    for (const entry of entries) {
      const preamble = entry.messagePreamble?.trim();
      if (!preamble) continue;
      const filtered = this.filterOneShotPreferenceContext(preamble, isControlMessage);
      if (!filtered || seen.has(filtered)) continue;
      seen.add(filtered);
      parts.push(filtered);
    }
    return parts.join('\n\n') || undefined;
  }

  private filterOneShotPreferenceContext(preamble: string, isControlMessage: boolean): string | undefined {
    const extracted = extractPreferenceContextBlocks(preamble);
    if (extracted.blocks.length === 0) return preamble;
    const signature = normalizePreferenceContextSignature(extracted.blocks);
    if (isControlMessage) return extracted.withoutBlocks || undefined;
    if (signature && signature === this._lastInjectedPreferenceContextSignature) {
      return extracted.withoutBlocks || undefined;
    }
    if (signature) {
      this._preferenceContextInjectionAttempt ??= {
        previous: this._lastInjectedPreferenceContextSignature,
      };
      this._lastInjectedPreferenceContextSignature = signature;
    }
    return preamble;
  }

  private async refreshContextBootstrap(options?: {
    phase?: 'initialize' | 'dispatch';
    timeoutMs?: number;
  }): Promise<'applied' | 'skipped' | 'timeout' | 'failed'> {
    if (!this._contextBootstrapResolver) return 'skipped';
    const phase = options?.phase ?? 'dispatch';
    const timeoutMs = options?.timeoutMs ?? getTransportContextBudgetMs();
    let bootstrapPromise: Promise<TransportContextBootstrap>;
    try {
      bootstrapPromise = Promise.resolve(this._contextBootstrapResolver());
    } catch (err) {
      incrementCounter('transport.context.bootstrap_failed', { phase });
      logger.warn({ err, sessionKey: this.sessionKey, phase }, 'transport context bootstrap failed before dispatch; continuing with existing context');
      return 'failed';
    }

    try {
      const outcome = await withTimeoutOutcome(bootstrapPromise, timeoutMs);
      if (outcome.timedOut) {
        incrementCounter('transport.context.bootstrap_timeout', { phase });
        logger.warn({
          sessionKey: this.sessionKey,
          provider: this.provider.id,
          phase,
          timeoutMs,
        }, 'transport context bootstrap timed out; continuing with existing context');
        return 'timeout';
      }
      this.applyContextBootstrap(outcome.value);
      return 'applied';
    } catch (err) {
      incrementCounter('transport.context.bootstrap_failed', { phase });
      logger.warn({ err, sessionKey: this.sessionKey, phase }, 'transport context bootstrap failed; continuing with existing context');
      return 'failed';
    }
  }

  private applyContextBootstrap(
    bootstrap: Partial<TransportContextBootstrap> & {
      namespace?: ContextNamespace;
      diagnostics?: string[];
      authoredContextLanguage?: string;
      authoredContextFilePath?: string;
    },
  ): void {
    this._contextNamespace = bootstrap.namespace;
    this._contextNamespaceDiagnostics = [...(bootstrap.diagnostics ?? [])];
    this._contextRemoteProcessedFreshness = bootstrap.remoteProcessedFreshness;
    this._contextLocalProcessedFreshness = bootstrap.localProcessedFreshness;
    this._contextRetryExhausted = !!bootstrap.retryExhausted;
    this._contextSharedPolicyOverride = bootstrap.sharedPolicyOverride;
    this._contextAuthoredContextLanguage = bootstrap.authoredContextLanguage;
    this._contextAuthoredContextFilePath = bootstrap.authoredContextFilePath;
    if (!this._startupMemoryInjected) this._startupMemory = bootstrap.startupMemory ?? null;
    this._onSessionInfoChange?.({
      contextNamespace: this._contextNamespace,
      contextNamespaceDiagnostics: [...this._contextNamespaceDiagnostics],
      contextRemoteProcessedFreshness: this._contextRemoteProcessedFreshness,
      contextLocalProcessedFreshness: this._contextLocalProcessedFreshness,
      contextRetryExhausted: this._contextRetryExhausted,
      contextSharedPolicyOverride: this._contextSharedPolicyOverride,
    });
  }

  private async buildTransportMessageRecallResultWithinBudget(
    message: string,
    authoritySource: ContextAuthorityDecision['authoritySource'],
  ): Promise<{
    artifact: TransportMemoryRecallArtifact | null;
    statusPayload?: Omit<MemoryContextTimelinePayload, 'relatedToEventId'>;
  }> {
    const timeoutMs = getTransportContextBudgetMs();
    let cancelled = false;
    const trimmed = message.trim();
    const query = trimmed.slice(0, 200);
    const recallPromise = this.buildTransportMessageRecallResult(message, authoritySource, {
      isCancelled: () => cancelled,
    });
    try {
      const outcome = await withTimeoutOutcome(recallPromise, timeoutMs);
      if (!outcome.timedOut) return outcome.value;
      cancelled = true;
      incrementCounter('transport.context.memory_recall_timeout', { provider: this.provider.id });
      logger.warn({
        sessionKey: this.sessionKey,
        provider: this.provider.id,
        timeoutMs,
      }, 'transport message recall timed out; dispatching without recall');
      return {
        artifact: null,
        statusPayload: buildMemoryContextStatusPayload(query, 'failed', 'message', {
          runtimeFamily: 'transport',
          authoritySource,
          sourceKind: 'local_processed',
        }),
      };
    } catch (err) {
      cancelled = true;
      incrementCounter('transport.context.memory_recall_failed', { provider: this.provider.id });
      logger.warn({ err, sessionKey: this.sessionKey }, 'transport message recall failed before status payload; continuing without recall');
      return {
        artifact: null,
        statusPayload: buildMemoryContextStatusPayload(query, 'failed', 'message', {
          runtimeFamily: 'transport',
          authoritySource,
          sourceKind: 'local_processed',
        }),
      };
    }
  }

  private async buildTransportMessageRecallResult(
    message: string,
    authoritySource: ContextAuthorityDecision['authoritySource'],
    options?: { isCancelled?: () => boolean },
  ): Promise<{
    artifact: TransportMemoryRecallArtifact | null;
    statusPayload?: Omit<MemoryContextTimelinePayload, 'relatedToEventId'>;
  }> {
    const trimmed = message.trim();
    const query = trimmed.slice(0, 200);
    if (!trimmed) {
      logger.debug({ sessionKey: this.sessionKey }, 'transport message recall skipped: empty message');
      return { artifact: null };
    }
    if (trimmed.startsWith('/')) {
      logger.debug({ sessionKey: this.sessionKey }, 'transport message recall skipped: control message');
      return {
        artifact: null,
        statusPayload: buildMemoryContextStatusPayload(query, 'skipped_control_message', 'message', {
          runtimeFamily: 'transport',
          authoritySource,
          sourceKind: 'local_processed',
        }),
      };
    }
    if (trimmed.length < 10) {
      logger.debug({ sessionKey: this.sessionKey, length: trimmed.length }, 'transport message recall skipped: short message');
      return {
        artifact: null,
        statusPayload: buildMemoryContextStatusPayload(query, 'skipped_short_prompt', 'message', {
          runtimeFamily: 'transport',
          authoritySource,
          sourceKind: 'local_processed',
        }),
      };
    }
    if (isTemplatePrompt(trimmed)) {
      logger.debug({ sessionKey: this.sessionKey }, 'transport message recall skipped: template prompt');
      return {
        artifact: null,
        statusPayload: buildMemoryContextStatusPayload(query, 'skipped_template_prompt', 'message', {
          runtimeFamily: 'transport',
          authoritySource,
          sourceKind: 'local_processed',
        }),
      };
    }
    if (isImperativeCommand(trimmed)) {
      logger.debug({ sessionKey: this.sessionKey, text: trimmed }, 'transport message recall skipped: imperative command');
      return {
        artifact: null,
        // Reuse the 'skipped_control_message' reason — imperative commands are
        // a form of control input (task-level verb, not a semantic query) and
        // we don't need to surface a separate status banner for them.
        statusPayload: buildMemoryContextStatusPayload(query, 'skipped_control_message', 'message', {
          runtimeFamily: 'transport',
          authoritySource,
          sourceKind: 'local_processed',
        }),
      };
    }
    try {
      // Broaden candidate pool — the cap rule trims to 3 (up to 5 if all
      // results are strong). See shared/memory-scoring.ts.
      const result = await searchLocalMemorySemantic({
        query,
        namespace: this._contextNamespace,
        currentEnterpriseId: this._contextNamespace?.enterpriseId,
        repo: this._contextNamespace?.projectId ?? this.resolveAuthoredContextRepository(),
        limit: 10,
      });
      if (options?.isCancelled?.()) {
        logger.debug({ sessionKey: this.sessionKey, query }, 'transport message recall result ignored after timeout');
        return { artifact: null };
      }
      // 1) Template-origin legacy summaries never surface through recall.
      const processed = result.items
        .filter((item): item is MemorySearchResultItem => item.type === 'processed')
        .filter((item) => !isTemplateOriginSummary(item.summary));
      // 2) Per-session dedup: skip items injected in this session's last
      //    10 turns. Cleared on session.clear.
      const procIds = processed.map((item) => item.id);
      const keepIds = new Set(filterRecentlyInjected(this.sessionKey, procIds));
      const deduped = processed.filter((item) => keepIds.has(item.id));
      const dedupedCount = Math.max(0, processed.length - deduped.length);
      // 3) Cap rule: floor 0.5, top 3, extend to 5 iff all >= 0.6.
      const scored = deduped.map((item) => ({ item, score: item.relevanceScore ?? 0 }));
      const finalScored = applyRecallCapRule(scored, {
        minFloor: getContextModelConfig().memoryRecallMinScore,
      });
      const items = finalScored.map((s) => toTransportMemoryRecallItem(s.item));
      if (items.length === 0) {
        logger.debug({ sessionKey: this.sessionKey, query }, 'transport message recall skipped: no processed matches');
        return {
          artifact: null,
          statusPayload: deduped.length === 0 && processed.length > 0
            ? buildMemoryContextStatusPayload(query, 'deduped_recently', 'message', {
                runtimeFamily: 'transport',
                authoritySource,
                sourceKind: 'local_processed',
                matchedCount: processed.length,
                dedupedCount,
              })
            : buildMemoryContextStatusPayload(query, 'no_matches', 'message', {
                runtimeFamily: 'transport',
                authoritySource,
                sourceKind: 'local_processed',
                matchedCount: processed.length,
              }),
        };
      }
      if (options?.isCancelled?.()) {
        logger.debug({ sessionKey: this.sessionKey, query }, 'transport message recall injection ignored after timeout');
        return { artifact: null };
      }
      // 4) Record injection into the per-session ring buffer.
      recordRecentInjection(this.sessionKey, items.map((it) => it.id));
      const supportClass = this.provider.capabilities.contextSupport ?? 'full-normalized-context-injection';
      const injectionSurface = supportClass === 'full-normalized-context-injection'
        ? 'normalized-payload'
        : 'degraded-message-side';
      const payload = buildMemoryContextTimelinePayload(query, items, 'message', {
        runtimeFamily: 'transport',
        injectionSurface,
        authoritySource,
        sourceKind: 'local_processed',
      });
      if (!payload?.injectedText) return { artifact: null };
      return {
        artifact: {
          reason: 'message',
          runtimeFamily: 'transport',
          authoritySource,
          sourceKind: 'local_processed',
          injectionSurface,
          query,
          items,
          injectedText: payload.injectedText,
        },
      };
    } catch (err) {
      logger.warn({ err, sessionKey: this.sessionKey }, 'transport message recall failed; continuing without recall');
      return {
        artifact: null,
        statusPayload: buildMemoryContextStatusPayload(query, 'failed', 'message', {
          runtimeFamily: 'transport',
          authoritySource,
          sourceKind: 'local_processed',
        }),
      };
    }
  }

  private emitStartupMemoryContext(
    startupMemory: TransportMemoryRecallArtifact | null,
    preferenceItems: MemoryContextTimelinePreferenceItem[] = [],
  ): void {
    if (this._startupMemoryTimelineEmitted || !startupMemory || startupMemory.items.length === 0) return;
    const payload = buildMemoryContextTimelinePayload(undefined, startupMemory.items, 'startup', {
      runtimeFamily: 'transport',
      injectionSurface: startupMemory.injectionSurface,
      injectedText: startupMemory.injectedText,
      authoritySource: startupMemory.authoritySource,
      sourceKind: startupMemory.sourceKind,
      preferenceItems,
    });
    if (!payload) return;
    timelineEmitter.emit(this.sessionKey, 'memory.context', payload, { source: 'daemon', confidence: 'high' });
    this._startupMemoryTimelineEmitted = true;
  }

  private emitMemoryContextEvent(
    memoryRecall: TransportMemoryRecallArtifact,
    clientMessageId?: string,
  ): void {
    const payload = buildMemoryContextTimelinePayload(memoryRecall.query, memoryRecall.items, memoryRecall.reason, {
      runtimeFamily: 'transport',
      injectionSurface: memoryRecall.injectionSurface,
      injectedText: memoryRecall.injectedText,
      authoritySource: memoryRecall.authoritySource,
      sourceKind: memoryRecall.sourceKind,
    });
    if (!payload) return;
    timelineEmitter.emit(
      this.sessionKey,
      'memory.context',
      {
        ...payload,
        ...(clientMessageId ? { relatedToEventId: `transport-user:${clientMessageId}` } : {}),
      },
      { source: 'daemon', confidence: 'high' },
    );
  }

  private emitMemoryContextStatusEvent(
    payload: Omit<MemoryContextTimelinePayload, 'relatedToEventId'>,
    clientMessageId?: string,
  ): void {
    timelineEmitter.emit(
      this.sessionKey,
      'memory.context',
      {
        ...payload,
        ...(clientMessageId ? { relatedToEventId: `transport-user:${clientMessageId}` } : {}),
      },
      { source: 'daemon', confidence: 'high' },
    );
  }

  async respondApproval(requestId: string, approved: boolean): Promise<void> {
    if (!this._providerSessionId) {
      throw new Error('TransportSessionRuntime not initialized — call initialize() first');
    }
    if (!this.provider.respondApproval) {
      throw new Error(`Provider ${this.provider.id} does not support approval responses`);
    }
    await this.provider.respondApproval(this._providerSessionId, requestId, approved);
  }
}

function toTransportMemoryRecallItem(item: MemorySearchResultItem): TransportMemoryRecallItem {
  return {
    id: item.id,
    type: item.type,
    projectId: item.projectId,
    scope: item.scope,
    ...(item.enterpriseId ? { enterpriseId: item.enterpriseId } : {}),
    ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
    ...(item.userId ? { userId: item.userId } : {}),
    summary: item.summary,
    ...(item.projectionClass ? { projectionClass: item.projectionClass } : {}),
    ...(typeof item.hitCount === 'number' ? { hitCount: item.hitCount } : {}),
    ...(typeof item.lastUsedAt === 'number' ? { lastUsedAt: item.lastUsedAt } : {}),
    ...(item.status ? { status: item.status } : {}),
    ...(typeof item.relevanceScore === 'number' ? { relevanceScore: item.relevanceScore } : {}),
    createdAt: item.createdAt,
    ...(typeof item.updatedAt === 'number' ? { updatedAt: item.updatedAt } : {}),
  };
}

function extractPreferenceContextBlocks(text: string): { blocks: string[]; withoutBlocks: string } {
  const blocks: string[] = [];
  const retained: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(PREFERENCE_CONTEXT_START, cursor);
    if (start < 0) {
      retained.push(text.slice(cursor));
      break;
    }
    const end = text.indexOf(PREFERENCE_CONTEXT_END, start + PREFERENCE_CONTEXT_START.length);
    if (end < 0) {
      retained.push(text.slice(cursor));
      break;
    }
    retained.push(text.slice(cursor, start));
    const blockEnd = end + PREFERENCE_CONTEXT_END.length;
    blocks.push(text.slice(start, blockEnd).trim());
    cursor = blockEnd;
  }
  return {
    blocks,
    withoutBlocks: retained.join('').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

function extractPreferenceContextTimelineItems(text: string | undefined): MemoryContextTimelinePreferenceItem[] {
  const blocks = extractPreferenceContextBlocks(text ?? '').blocks;
  const items: MemoryContextTimelinePreferenceItem[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const body = block
      .replace(PREFERENCE_CONTEXT_START, '')
      .replace(PREFERENCE_CONTEXT_END, '')
      .trim();
    for (const line of body.split(/\r?\n/)) {
      const match = line.trim().match(/^-\s+(.+)$/);
      if (!match) continue;
      const text = match[1].trim();
      const key = text.replace(/\s+/g, ' ').toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      items.push({ id: `preference-${items.length + 1}`, text });
    }
  }
  return items;
}

function normalizePreferenceContextSignature(blocks: readonly string[]): string {
  return blocks.map((block) => block.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

function isTransportCompactionCompletion(message: AgentMessage): boolean {
  const metadata = message.metadata;
  const event = typeof metadata === 'object' && metadata !== null
    ? (metadata as Record<string, unknown>).event
    : undefined;
  return message.kind === 'system'
    && message.role === 'system'
    && (
      (typeof metadata === 'object'
        && metadata !== null
        && (metadata as Record<string, unknown>)[SESSION_CONTROL_METADATA_COMMAND_FIELD] === 'compact')
      || event === 'thread/compacted'
      || event === 'session.history.compact'
    );
}
