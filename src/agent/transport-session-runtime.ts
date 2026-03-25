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

  constructor(
    private readonly provider: TransportProvider,
    private readonly sessionKey: string,
  ) {
    this.provider.onDelta((sid: string, _delta: MessageDelta) => {
      if (sid !== this._providerSessionId) return;
      this._status = 'streaming';
    });

    this.provider.onComplete((sid: string, message: AgentMessage) => {
      if (sid !== this._providerSessionId) return;
      this._status = 'idle';
      this._sending = false;
      this._history.push(message);
    });

    this.provider.onError((sid: string, _error: ProviderError) => {
      if (sid !== this._providerSessionId) return;
      this._status = 'error';
      this._sending = false;
    });
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
  }

  async send(message: string): Promise<void> {
    if (!this._providerSessionId) {
      throw new Error('TransportSessionRuntime not initialized — call initialize() first');
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

    this._status = 'thinking';
    this._sending = true;
    try {
      await this.provider.send(this._providerSessionId, message);
    } catch (err) {
      // Reset status so session doesn't get stuck at 'thinking'
      this._status = 'idle';
      this._sending = false;
      throw err;
    }
  }

  getStatus(): AgentStatus {
    return this._status;
  }

  async kill(): Promise<void> {
    if (this._providerSessionId) {
      await this.provider.endSession(this._providerSessionId);
      this._providerSessionId = null;
    }
    this._status = 'idle';
    this._sending = false;
  }

  getHistory(): AgentMessage[] {
    return [...this._history];
  }
}
