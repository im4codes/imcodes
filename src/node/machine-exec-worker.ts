// Controlled-node exec worker (10.8): validates every inbound MACHINE_EXEC against
// the SHARED envelope schema (never a bare cast), enforces a bounded per-node
// concurrency pool, registers every in-flight command's AbortController so a WS
// disconnect kills all process groups, and echoes the `correlationId` (not any
// client-declared identity).
import { tmpdir } from 'node:os';
import { validateMachineExecFrame } from '../../shared/remote-exec.js';
import type { RemoteExecOutputChunk } from '../../shared/remote-exec.js';
import { runRemoteExec } from './exec-runner.js';

export interface ExecReply {
  correlationId: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  timedOut?: boolean;
  durationMs: number;
  error?: string;
}

type RunFn = typeof runRemoteExec;

export const DEFAULT_MACHINE_EXEC_CONCURRENCY = 10;

export class MachineExecWorker {
  private readonly active = new Set<AbortController>();

  constructor(
    private readonly run: RunFn = runRemoteExec,
    private readonly defaultCwd: string = tmpdir(),
    private readonly maxConcurrency: number = DEFAULT_MACHINE_EXEC_CONCURRENCY,
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError('maxConcurrency must be a positive integer');
    }
  }

  /** Handle one inbound MACHINE_EXEC frame. Returns the reply envelope, or null if the frame lacks a usable correlationId. */
  async handle(rawFrame: unknown, onChunk?: (chunk: RemoteExecOutputChunk) => void): Promise<ExecReply | null> {
    const v = validateMachineExecFrame(rawFrame);
    if (!v.ok) {
      const cid = typeof (rawFrame as { correlationId?: unknown })?.correlationId === 'string'
        ? (rawFrame as { correlationId: string }).correlationId
        : '';
      if (!cid) return null;
      return { correlationId: cid, ok: false, exitCode: null, stdout: '', stderr: '', durationMs: 0, error: `invalid_exec:${v.error}` };
    }
    const frame = v.value;
    if (this.active.size >= this.maxConcurrency) {
      return { correlationId: frame.correlationId, ok: false, exitCode: null, stdout: '', stderr: '', durationMs: 0, error: 'busy' };
    }
    const ac = new AbortController();
    this.active.add(ac);
    try {
      const result = await this.run(
        { requestId: frame.correlationId, command: frame.command, shell: frame.shell, cwd: frame.cwd ?? this.defaultCwd, timeoutMs: frame.timeoutMs },
        { signal: ac.signal, onChunk },
      );
      return {
        correlationId: frame.correlationId,
        ok: result.ok,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.timedOut ? { timedOut: true } : {}),
        durationMs: result.durationMs,
        ...(result.error ? { error: result.error } : {}),
      };
    } finally {
      this.active.delete(ac);
    }
  }

  /** Abort every in-flight command (e.g. the relay connection dropped). */
  abortAll(): void {
    for (const controller of this.active) controller.abort();
  }

  get isBusy(): boolean {
    return this.active.size >= this.maxConcurrency;
  }

  get inFlightCount(): number {
    return this.active.size;
  }
}
