import type { SessionRuntime } from './session-runtime.js';
import { RUNTIME_TYPES } from './session-runtime.js';
import type { AgentStatus, AgentType } from './detect.js';
import { detectStatusAsync } from './detect.js';
import { sendKeys, killSession } from './tmux.js';

export class ProcessSessionRuntime implements SessionRuntime {
  readonly type = RUNTIME_TYPES.PROCESS;
  private _status: AgentStatus = 'unknown';

  constructor(
    private readonly sessionName: string,
    private readonly agentType: AgentType,
  ) {}

  async send(message: string): Promise<void> {
    await sendKeys(this.sessionName, message);
  }

  getStatus(): AgentStatus {
    return this._status;
  }

  /** Update cached status — called by the status poller. */
  updateStatus(status: AgentStatus): void {
    this._status = status;
  }

  /** Refresh status from terminal (async). */
  async refreshStatus(): Promise<AgentStatus> {
    this._status = await detectStatusAsync(this.sessionName, this.agentType);
    return this._status;
  }

  async kill(): Promise<void> {
    await killSession(this.sessionName);
  }
}
