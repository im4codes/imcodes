import { randomUUID } from 'node:crypto';
import type { SessionRuntime } from './session-runtime.js';
import { RUNTIME_TYPES } from './session-runtime.js';
import type { AgentStatus } from './detect.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { TransportProvider, ProviderError, SessionConfig } from './transport-provider.js';

export class TransportSessionRuntime implements SessionRuntime {
  readonly type = RUNTIME_TYPES.TRANSPORT;

  private _status: AgentStatus = 'idle';
  private _history: AgentMessage[] = [];
  private _providerSessionId: string | null = null;
  /** Guard: true while a send is in flight — prevents concurrent sends. */
  private _sending = false;
  /** Session description — passed as extraSystemPrompt on each send. */
  private _description: string | undefined;
  /** Provider-side model/agent selection — passed via SessionConfig.agentId. */
  private _agentId: string | undefined;
  /** Unsubscribe functions for provider callbacks — called in kill(). */
  private _unsubscribes: Array<() => void> = [];
  /** External callback when status changes — wired to emit timeline session.state events. */
  private _onStatusChange?: (status: AgentStatus) => void;
  /** Current turn completion signal — used to queue sends until the active turn finishes. */
  private _activeTurn:
    | {
      promise: Promise<void>;
      resolve: () => void;
      reject: (err: ProviderError) => void;
    }
    | null = null;

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
        this.setStatus('idle');
        this._sending = false;
        this._history.push(message);
        this._activeTurn?.resolve();
        this._activeTurn = null;
      }),
      this.provider.onError((sid: string, error: ProviderError) => {
        if (sid !== this._providerSessionId) return;
        this.setStatus(error.code === 'CANCELLED' ? 'idle' : 'error');
        this._sending = false;
        this._activeTurn?.reject(error);
        this._activeTurn = null;
      }),
    );
  }

  /** Register a callback for status changes (idle/running/streaming/error). */
  set onStatusChange(cb: (status: AgentStatus) => void) { this._onStatusChange = cb; }

  private setStatus(status: AgentStatus): void {
    if (this._status === status) return;
    this._status = status;
    this._onStatusChange?.(status);
  }

  /** Set providerSessionId directly (used when restoring from store without calling initialize). */
  setProviderSessionId(id: string): void { this._providerSessionId = id; }

  /** Set description (used when restoring from store — passed as extraSystemPrompt on send). */
  setDescription(desc: string): void { this._description = desc; }
  setAgentId(agentId: string): void {
    this._agentId = agentId;
    if (this._providerSessionId) {
      this.provider.setSessionAgentId?.(this._providerSessionId, agentId);
    }
  }

  get providerSessionId(): string | null {
    return this._providerSessionId;
  }

  /** Whether a send is currently in flight. */
  get sending(): boolean {
    return this._sending;
  }

  /** Initialize the runtime — must be called after construction to create the provider session. */
  async initialize(config: SessionConfig): Promise<void> {
    this._providerSessionId = await this.provider.createSession(config);
    this._description = config.description;
    this._agentId = config.agentId;
  }

  async send(message: string): Promise<void> {
    if (!this._providerSessionId) {
      throw new Error('TransportSessionRuntime not initialized — call initialize() first');
    }

    if (this._activeTurn) {
      try {
        await this._activeTurn.promise;
      } catch {
        // Previous turn failed. A queued send may still proceed.
      }
    }

    // Record user message in history for complete conversation replay
    this._history.push({
      id: randomUUID(),
      sessionId: this._providerSessionId,
      kind: 'text',
      role: 'user',
      content: message,
      timestamp: Date.now(),
      status: 'complete',
    });

    this.setStatus('thinking');
    this._sending = true;
    this._activeTurn = (() => {
      let resolve!: () => void;
      let reject!: (err: ProviderError) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej as (err: ProviderError) => void;
      });
      void promise.catch(() => {});
      return { promise, resolve, reject };
    })();
    try {
      await this.provider.send(this._providerSessionId, message, undefined, this._description);
    } catch (err) {
      // Reset status so session doesn't get stuck at 'thinking'
      this.setStatus('idle');
      this._sending = false;
      this._activeTurn = null;
      throw err;
    }
  }

  async cancel(): Promise<void> {
    if (!this._providerSessionId) {
      throw new Error('TransportSessionRuntime not initialized — call initialize() first');
    }
    if (!this.provider.cancel) return;
    await this.provider.cancel(this._providerSessionId);
  }

  getStatus(): AgentStatus {
    return this._status;
  }

  async kill(): Promise<void> {
    // Unsubscribe from provider callbacks to prevent O(n) accumulation
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes = [];

    if (this._providerSessionId) {
      await this.provider.endSession(this._providerSessionId);
      this._providerSessionId = null;
    }
    this.setStatus('idle');
    this._sending = false;
    this._activeTurn = null;
  }

  getHistory(): AgentMessage[] {
    return [...this._history];
  }
}
