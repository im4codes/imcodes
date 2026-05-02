import { randomUUID } from 'node:crypto';
import type { SessionRuntime } from './session-runtime.js';
import { RUNTIME_TYPES } from './session-runtime.js';
import type { AgentStatus } from './detect.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { TransportProvider, ProviderError, SessionConfig, SessionInfoUpdate } from './transport-provider.js';
import type { ApprovalRequest } from './transport-provider.js';
import type { TransportEffortLevel } from '../../shared/effort-levels.js';
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
import type { MemoryContextTimelinePayload } from '../shared/timeline/types.js';
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
import { resolveRuntimeAuthoredContext } from '../context/shared-context-runtime.js';
import { buildTransportStartupMemory, type TransportContextBootstrap } from './runtime-context-bootstrap.js';
import { recordMemoryHits } from '../store/context-store.js';
import logger from '../util/logger.js';
import { incrementCounter } from '../util/metrics.js';

export interface PendingTransportMessage {
  clientMessageId: string;
  /** User-visible task text, without daemon-rendered memory/context preambles. */
  text: string;
  /** Provider-visible per-turn context rendered through the shared context preamble path. */
  messagePreamble?: string;
  attachments?: TransportAttachment[];
}

const DEFAULT_TRANSPORT_CONTEXT_BUDGET_MS = 2_500;
const DEFAULT_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS = 60_000;
const MIN_TRANSPORT_CONTEXT_BUDGET_MS = 50;
const MAX_TRANSPORT_CONTEXT_BUDGET_MS = 30_000;
const MIN_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS = 50;
const MAX_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS = 10 * 60_000;

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
  private _description: string | undefined;
  private _systemPrompt: string | undefined;
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
  /** Original message entries for the currently in-flight dispatch. */
  private _activeDispatchEntries: PendingTransportMessage[] = [];

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
        this.setStatus('streaming');
      }),
      this.provider.onComplete((sid: string, message: AgentMessage) => {
        if (sid !== this._providerSessionId) return;
        if (isTransportCompactionCompletion(message)) {
          this._lastInjectedPreferenceContextSignature = null;
        }
        this._sending = false;
        this._history.push(message);
        this._activeTurn?.resolve();
        this._activeTurn = null;
        this._activeDispatchEntries = [];
        // Drain pending messages before transitioning to idle.
        // If there are queued messages, merge and send — status stays running.
        if (!this._drainPending()) {
          this.setStatus('idle');
        }
      }),
      this.provider.onError((sid: string, error: ProviderError) => {
        if (sid !== this._providerSessionId) return;
        this._sending = false;
        this._activeTurn?.reject(error);
        this._activeTurn = null;
        // Only drain pending on recoverable/cancel errors — unrecoverable errors
        // (auth failure, provider down) would just fail again and consume queued messages.
        const canDrain = error.code === 'CANCELLED' || error.recoverable;
        if (canDrain) {
          this._activeDispatchEntries = [];
          if (this._drainPending()) return;
        }
        this.setStatus(error.code === 'CANCELLED' ? 'idle' : 'error');
      }),
      ...(this.provider.onSessionInfo ? [this.provider.onSessionInfo((sid: string, info: SessionInfoUpdate) => {
        if (sid !== this._providerSessionId) return;
        this._onSessionInfoChange?.(info);
      })] : []),
    );
    if (this.provider.onApprovalRequest) {
      this.provider.onApprovalRequest((sid: string, req: ApprovalRequest) => {
        if (sid !== this._providerSessionId) return;
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
  setDescription(desc: string): void { this._description = desc; }
  setSystemPrompt(prompt: string): void { this._systemPrompt = prompt; }
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
  /** Snapshot of queued messages waiting to be drained (legacy text-only view). */
  get pendingMessages(): string[] { return this._pendingMessages.map((entry) => entry.text); }
  /** Snapshot of queued messages waiting to be drained (stable entity ids for UI/edit/undo). */
  get pendingEntries(): PendingTransportMessage[] { return this._pendingMessages.map((entry) => ({ ...entry })); }
  /** Snapshot of the message entries currently being dispatched. */
  get activeDispatchEntries(): PendingTransportMessage[] { return this._activeDispatchEntries.map((entry) => ({ ...entry })); }

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
    this._description = config.description;
    this._systemPrompt = config.systemPrompt;
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
  ): 'sent' | 'queued' {
    if (!this._providerSessionId) {
      throw new Error('TransportSessionRuntime not initialized — call initialize() first');
    }

    const entry: PendingTransportMessage = {
      clientMessageId: clientMessageId ?? randomUUID(),
      text: message,
      ...(messagePreamble?.trim() ? { messagePreamble: messagePreamble.trim() } : {}),
      ...(attachments?.length ? { attachments } : {}),
    };

    if (this._sending) {
      this._pendingMessages.push(entry);
      return 'queued';
    }

    this._dispatchTurn(message, entry.clientMessageId, attachments, [entry]);
    return 'sent';
  }

  editPendingMessage(clientMessageId: string, text: string): boolean {
    const nextText = text.trim();
    if (!clientMessageId || !nextText) return false;
    const entry = this._pendingMessages.find((item) => item.clientMessageId === clientMessageId);
    if (!entry) return false;
    entry.text = nextText;
    entry.messagePreamble = undefined;
    return true;
  }

  removePendingMessage(clientMessageId: string): PendingTransportMessage | null {
    if (!clientMessageId) return null;
    const index = this._pendingMessages.findIndex((item) => item.clientMessageId === clientMessageId);
    if (index < 0) return null;
    const [removed] = this._pendingMessages.splice(index, 1);
    return removed ?? null;
  }

  async cancel(): Promise<void> {
    if (!this._providerSessionId) {
      throw new Error('TransportSessionRuntime not initialized — call initialize() first');
    }
    if (!this.provider.cancel) return;
    await this.provider.cancel(this._providerSessionId);
  }

  getStatus(): AgentStatus { return this._status; }

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
    this._pendingMessages = [];
    // Per-session memory injection history is daemon-scoped to this session;
    // a kill ends that scope. clear() is called on session.clear separately.
    clearRecentInjectionHistory(this.sessionKey);
  }

  getHistory(): AgentMessage[] { return [...this._history]; }

  // ── Internal ────────────────────────────────────────────────────────────────

  private setStatus(status: AgentStatus): void {
    if (this._status === status) return;
    this._status = status;
    this._onStatusChange?.(status);
  }

  /** Dispatch a single turn to the provider. Assumes _sending is false. */
  private _dispatchTurn(
    message: string,
    clientMessageId?: string,
    attachments?: TransportAttachment[],
    dispatchedEntries?: PendingTransportMessage[],
  ): void {
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
    this._sending = true;
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

    void (async () => {
      await this.refreshContextBootstrap({ phase: 'dispatch' });
      const authority = resolveTransportDispatchAuthority(this.provider, {
        namespace: this._contextNamespace,
        remoteProcessedFreshness: this._contextRemoteProcessedFreshness,
        localProcessedFreshness: this._contextLocalProcessedFreshness,
        retryExhausted: this._contextRetryExhausted,
        sharedPolicyOverride: this._contextSharedPolicyOverride,
      }).authority;
      const startupMemory = this._startupMemory ?? (
        !this._startupMemoryInjected && authority.authoritySource === 'processed_local' && this._contextNamespace
          ? buildTransportStartupMemory(this._contextNamespace, { projectDir: this._projectDir })
          : null
      );
      const memoryRecallResult = await this.buildTransportMessageRecallResultWithinBudget(message, authority.authoritySource);
      const memoryRecall = memoryRecallResult.artifact;
      const dispatchResult = await dispatchSharedContextSend(this.provider, this._providerSessionId!, {
        userMessage: message,
        messagePreamble: this.mergeMessagePreambles(dispatchedEntries, message),
        description: this._description,
        systemPrompt: this._systemPrompt,
        attachments,
        namespace: this._contextNamespace,
        namespaceDiagnostics: this._contextNamespaceDiagnostics,
        remoteProcessedFreshness: this._contextRemoteProcessedFreshness,
        localProcessedFreshness: this._contextLocalProcessedFreshness,
        retryExhausted: this._contextRetryExhausted,
        sharedPolicyOverride: this._contextSharedPolicyOverride,
        authoredContextRepository: this.resolveAuthoredContextRepository(),
        authoredContextLanguage: this._contextAuthoredContextLanguage,
        authoredContextFilePath: this._contextAuthoredContextFilePath,
        ...(startupMemory ? { startupMemory } : {}),
        ...(memoryRecall ? { memoryRecall } : {}),
      }, {
        resolveAuthoredContext: (input) => {
          if (!input.namespace) return Promise.resolve([]);
          return resolveRuntimeAuthoredContext(input.namespace, {
            language: input.authoredContextLanguage,
            filePath: input.authoredContextFilePath,
          });
        },
        sendTimeoutMs: getTransportProviderSendTimeoutMs(),
      });
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
        this.emitStartupMemoryContext(this._startupMemory);
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
        if (!this._sending || !this._activeTurn) return;
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
    const merged = messages.map((entry) => entry.text).join('\n\n');
    const attachments = messages.flatMap((entry) => entry.attachments ?? []);
    this._onDrain?.(messages, merged, messages.length);
    this._dispatchTurn(
      merged,
      messages.length === 1 ? messages[0]?.clientMessageId : undefined,
      attachments.length > 0 ? attachments : undefined,
      messages,
    );
    return true;
  }

  private mergeMessagePreambles(entries: PendingTransportMessage[] | undefined, userMessage?: string): string | undefined {
    if (!entries || entries.length === 0) return undefined;
    const seen = new Set<string>();
    const parts: string[] = [];
    const isControlMessage = userMessage?.trim().startsWith('/') === true;
    if (userMessage?.trim() === '/compact') {
      // The provider-native compact command must stay raw, and the next real
      // turn should re-seed stable preferences because the SDK may have
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

  private emitStartupMemoryContext(startupMemory: TransportMemoryRecallArtifact | null): void {
    if (this._startupMemoryTimelineEmitted || !startupMemory || startupMemory.items.length === 0) return;
    const payload = buildMemoryContextTimelinePayload(undefined, startupMemory.items, 'startup', {
      runtimeFamily: 'transport',
      injectionSurface: startupMemory.injectionSurface,
      injectedText: startupMemory.injectedText,
      authoritySource: startupMemory.authoritySource,
      sourceKind: startupMemory.sourceKind,
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

function normalizePreferenceContextSignature(blocks: readonly string[]): string {
  return blocks.map((block) => block.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

function isTransportCompactionCompletion(message: AgentMessage): boolean {
  const metadata = message.metadata;
  return message.kind === 'system'
    && message.role === 'system'
    && typeof metadata === 'object'
    && metadata !== null
    && (metadata as Record<string, unknown>).event === 'thread/compacted';
}
