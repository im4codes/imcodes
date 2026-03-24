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
      this._history.push(message);
    });

    this.provider.onError((sid: string, _error: ProviderError) => {
      if (sid !== this._providerSessionId) return;
      this._status = 'idle';
    });
  }

  get providerSessionId(): string | null {
    return this._providerSessionId;
  }

  /** Initialize the runtime — must be called after construction to create the provider session. */
  async initialize(config: SessionConfig): Promise<void> {
    this._providerSessionId = await this.provider.createSession(config);
  }

  async send(message: string): Promise<void> {
    if (!this._providerSessionId) {
      throw new Error('TransportSessionRuntime not initialized — call initialize() first');
    }
    this._status = 'thinking';
    await this.provider.send(this._providerSessionId, message);
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
  }

  getHistory(): AgentMessage[] {
    return [...this._history];
  }
}
