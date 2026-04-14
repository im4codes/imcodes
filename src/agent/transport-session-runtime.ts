import { randomUUID } from 'node:crypto';
import type { SessionRuntime } from './session-runtime.js';
import { RUNTIME_TYPES } from './session-runtime.js';
import type { AgentStatus } from './detect.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { TransportProvider, ProviderError, SessionConfig, SessionInfoUpdate } from './transport-provider.js';
import type { TransportEffortLevel } from '../../shared/effort-levels.js';
import { SharedContextDispatchError, dispatchSharedContextSend } from './transport-runtime-assembly.js';
import type { ContextFreshness, ContextNamespace, SharedScopePolicyOverride } from '../../shared/context-types.js';
import { resolveRuntimeAuthoredContext } from '../context/shared-context-runtime.js';
import type { TransportContextBootstrap } from './runtime-context-bootstrap.js';

export interface PendingTransportMessage {
  clientMessageId: string;
  text: string;
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

  /** Callback fired when pending messages are drained into a new turn. */
  private _onDrain?: (messages: PendingTransportMessage[], mergedMessage: string, count: number) => void;
  private _onSessionInfoChange?: (info: SessionInfoUpdate) => void;

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
        this._sending = false;
        this._history.push(message);
        this._activeTurn?.resolve();
        this._activeTurn = null;
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
        if (canDrain && this._drainPending()) return;
        this.setStatus(error.code === 'CANCELLED' ? 'idle' : 'error');
      }),
      ...(this.provider.onSessionInfo ? [this.provider.onSessionInfo((sid: string, info: SessionInfoUpdate) => {
        if (sid !== this._providerSessionId) return;
        this._onSessionInfoChange?.(info);
      })] : []),
    );
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Register a callback for status changes (idle/streaming/thinking/error). */
  set onStatusChange(cb: (status: AgentStatus) => void) { this._onStatusChange = cb; }

  /** Register a callback for when pending messages are drained into a new turn. */
  set onDrain(cb: (messages: PendingTransportMessage[], mergedMessage: string, count: number) => void) { this._onDrain = cb; }
  /** Register a callback for provider session metadata updates. */
  set onSessionInfoChange(cb: (info: SessionInfoUpdate) => void) { this._onSessionInfoChange = cb; }

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

  setContextBootstrapResolver(
    resolver: (() => Promise<TransportContextBootstrap>) | undefined,
  ): void {
    this._contextBootstrapResolver = resolver;
  }

  async initialize(config: SessionConfig): Promise<void> {
    this._providerSessionId = await this.provider.createSession(config);
    this._description = config.description;
    this._systemPrompt = config.systemPrompt;
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
  send(message: string, clientMessageId?: string): 'sent' | 'queued' {
    if (!this._providerSessionId) {
      throw new Error('TransportSessionRuntime not initialized — call initialize() first');
    }

    if (this._sending) {
      this._pendingMessages.push({
        clientMessageId: clientMessageId ?? randomUUID(),
        text: message,
      });
      return 'queued';
    }

    this._dispatchTurn(message);
    return 'sent';
  }

  editPendingMessage(clientMessageId: string, text: string): boolean {
    const nextText = text.trim();
    if (!clientMessageId || !nextText) return false;
    const entry = this._pendingMessages.find((item) => item.clientMessageId === clientMessageId);
    if (!entry) return false;
    entry.text = nextText;
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
    this._pendingMessages = [];
  }

  getHistory(): AgentMessage[] { return [...this._history]; }

  // ── Internal ────────────────────────────────────────────────────────────────

  private setStatus(status: AgentStatus): void {
    if (this._status === status) return;
    this._status = status;
    this._onStatusChange?.(status);
  }

  /** Dispatch a single turn to the provider. Assumes _sending is false. */
  private _dispatchTurn(message: string): void {
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

    let resolve!: () => void;
    let reject!: (err: ProviderError) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej as (err: ProviderError) => void;
    });
    void promise.catch(() => {}); // prevent unhandled rejection
    this._activeTurn = { promise, resolve, reject };

    void this.refreshContextBootstrap()
      .then(() => dispatchSharedContextSend(this.provider, this._providerSessionId!, {
        userMessage: message,
        description: this._description,
        systemPrompt: this._systemPrompt,
        namespace: this._contextNamespace,
        namespaceDiagnostics: this._contextNamespaceDiagnostics,
        remoteProcessedFreshness: this._contextRemoteProcessedFreshness,
        localProcessedFreshness: this._contextLocalProcessedFreshness,
        retryExhausted: this._contextRetryExhausted,
        sharedPolicyOverride: this._contextSharedPolicyOverride,
        authoredContextRepository: this.resolveAuthoredContextRepository(),
        authoredContextLanguage: this._contextAuthoredContextLanguage,
        authoredContextFilePath: this._contextAuthoredContextFilePath,
      }, {
        resolveAuthoredContext: (input) => {
          if (!input.namespace) return Promise.resolve([]);
          return resolveRuntimeAuthoredContext(input.namespace, {
            language: input.authoredContextLanguage,
            filePath: input.authoredContextFilePath,
          });
        },
      }))
      .catch((err) => {
        // Only handle if the provider didn't already fire onError callback.
        // Shared-context dispatch denial is surfaced here as a send failure
        // because the outer runtime contract is still send-oriented.
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
    this._onDrain?.(messages, merged, messages.length);
    this._dispatchTurn(merged);
    return true;
  }

  private async refreshContextBootstrap(): Promise<void> {
    if (!this._contextBootstrapResolver) return;
    const bootstrap = await this._contextBootstrapResolver();
    this.applyContextBootstrap(bootstrap);
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
  }
}
