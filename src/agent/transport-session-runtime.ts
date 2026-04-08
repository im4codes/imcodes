import { randomUUID } from 'node:crypto';
import type { SessionRuntime } from './session-runtime.js';
import { RUNTIME_TYPES } from './session-runtime.js';
import type { AgentStatus } from './detect.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { TransportProvider, ProviderError, SessionConfig, SessionInfoUpdate } from './transport-provider.js';
import type { TransportEffortLevel } from '../../shared/effort-levels.js';

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
  private _agentId: string | undefined;
  private _effort: TransportEffortLevel | undefined;
  private _unsubscribes: Array<() => void> = [];
  private _onStatusChange?: (status: AgentStatus) => void;

  /** Current turn completion signal — resolved by onComplete, rejected by onError. */
  private _activeTurn: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: ProviderError) => void;
  } | null = null;

  /** Messages queued while a turn is in flight. Drained and merged on turn completion. */
  private _pendingMessages: string[] = [];

  /** Callback fired when pending messages are drained into a new turn.
   *  Allows command-handler to emit timeline events for the batched send. */
  private _onDrain?: (mergedMessage: string, count: number) => void;
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
  set onDrain(cb: (mergedMessage: string, count: number) => void) { this._onDrain = cb; }
  /** Register a callback for provider session metadata updates. */
  set onSessionInfoChange(cb: (info: SessionInfoUpdate) => void) { this._onSessionInfoChange = cb; }

  /** Set providerSessionId directly (restore from store without initialize). */
  setProviderSessionId(id: string): void { this._providerSessionId = id; }
  setDescription(desc: string): void { this._description = desc; }
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

  async initialize(config: SessionConfig): Promise<void> {
    this._providerSessionId = await this.provider.createSession(config);
    this._description = config.description;
    this._agentId = config.agentId;
    this._effort = config.effort;
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
  send(message: string): 'sent' | 'queued' {
    if (!this._providerSessionId) {
      throw new Error('TransportSessionRuntime not initialized — call initialize() first');
    }

    if (this._sending) {
      this._pendingMessages.push(message);
      return 'queued';
    }

    this._dispatchTurn(message);
    return 'sent';
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

    try {
      const sendResult = this.provider.send(this._providerSessionId!, message, undefined, this._description);
      // Catch async rejections from providers that return Promises (e.g. OpenClaw RPC)
      if (sendResult && typeof (sendResult as Promise<void>).catch === 'function') {
        (sendResult as Promise<void>).catch((err) => {
          // Only handle if the provider didn't already fire onError callback
          if (this._sending && this._activeTurn) {
            this.setStatus('error');
            this._sending = false;
            this._activeTurn.reject(
              typeof err === 'object' && err && 'code' in err ? err : { code: 'PROVIDER_ERROR', message: String(err), recoverable: false },
            );
            this._activeTurn = null;
            // Don't drain on async send failure — the provider is likely broken
          }
        });
      }
    } catch {
      // Sync throw from provider.send() — emit error (not silent idle)
      this.setStatus('error');
      this._sending = false;
      if (this._activeTurn) {
        this._activeTurn.reject({ code: 'PROVIDER_ERROR', message: 'provider.send() threw synchronously', recoverable: false });
        this._activeTurn = null;
      }
    }
  }

  /**
   * Drain all pending messages into a single merged turn.
   * Called after onComplete/onError. Returns true if a new turn was started.
   */
  private _drainPending(): boolean {
    if (this._pendingMessages.length === 0 || !this._providerSessionId) return false;

    const messages = this._pendingMessages.splice(0);
    const merged = messages.join('\n\n');
    this._onDrain?.(merged, messages.length);
    this._dispatchTurn(merged);
    return true;
  }
}
