// Controlled-node exec worker (10.8): validates every inbound MACHINE_EXEC against
// the SHARED envelope schema (never a bare cast), enforces per-node concurrency of
// 1 (a second command in flight is rejected `busy`, never double-spawned), registers
// the in-flight command's AbortController so a WS disconnect kills its process
// group, and echoes the `correlationId` (not any client-declared identity).
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

export class MachineExecWorker {
  private busy = false;
  private current: AbortController | null = null;

  constructor(private readonly run: RunFn = runRemoteExec, private readonly defaultCwd: string = tmpdir()) {}

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
    if (this.busy) {
      return { correlationId: frame.correlationId, ok: false, exitCode: null, stdout: '', stderr: '', durationMs: 0, error: 'busy' };
    }
    this.busy = true;
    const ac = new AbortController();
    this.current = ac;
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
      this.busy = false;
      this.current = null;
    }
  }

  /** Abort the in-flight command (e.g. the relay connection dropped). */
  abortAll(): void {
    this.current?.abort();
  }

  get isBusy(): boolean {
    return this.busy;
  }
}
