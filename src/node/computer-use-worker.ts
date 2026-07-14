import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  validateComputerUseFrame,
  COMPUTER_USE_DEFAULT_TIMEOUT_MS,
  type ComputerUseFrame,
  type ComputerUseResult,
} from '../../shared/computer-use.js';
import { ComputerUseIpcHost } from './computer-use-ipc.js';

export class ComputerUseWorker {
  private readonly host = new ComputerUseIpcHost();
  private busy = false;

  async handle(raw: unknown): Promise<ComputerUseResult | null> {
    const validation = validateComputerUseFrame(raw);
    if (!validation.ok) return null;
    if (this.busy) return this.failure(validation.value, 'computer_use_busy');
    this.busy = true;
    try {
      const result = await this.host.call(validation.value);
      const { type: _type, ...payload } = result;
      return payload;
    } catch (error) {
      return this.failure(validation.value, error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
    }
  }

  abortAll(): void {
    this.host.close();
    this.busy = false;
  }

  private failure(frame: ComputerUseFrame, error: string): ComputerUseResult {
    return {
      correlationId: frame.correlationId,
      ok: false,
      tool: frame.tool,
      content: [],
      durationMs: frame.timeoutMs ?? COMPUTER_USE_DEFAULT_TIMEOUT_MS,
      error: error || 'computer_use_failed',
    };
  }
}
