import { execFile as execFileCb, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import {
  EXEC_HELPER_ENV_SWITCH,
  EXEC_HELPER_ERROR_CODE,
  EXEC_HELPER_FORWARDED_OPTIONS,
  EXEC_HELPER_MSG,
  type ExecHelperErrorInfo,
  type ExecHelperOptions,
  type ExecHelperRequest,
  type ExecHelperResponse,
} from '../../shared/exec-helper-protocol.js';
import { spawnChildProcessWorker, type ChildProcessWorkerHandle } from './child-process-worker.js';
import logger from './logger.js';

/**
 * Off-main-thread `execFile`.
 *
 * `child_process.execFile` forks from the calling process, and fork cost grows with
 * that process's RSS: on a loaded host a 2 GB daemon spends 90-200 ms of main thread
 * per tmux / git / ps call. The daemon therefore starts one tiny long-lived helper
 * process at boot (`startExecHelper`, while RSS is still small) and `execFileOffMain`
 * posts each call there. The helper runs the same `execFile`, so output, exit code,
 * timeout, killSignal and error fields are those of a direct call.
 *
 * Direct spawn stays the behaviour whenever the helper is not usable: before it has
 * reported ready, in every process that never started one (CLI, tests), after
 * shutdown, in a crash loop, when `IMCODES_EXEC_HELPER=0`, and for options that cannot
 * cross IPC. Only a call that was already in flight when the helper died fails
 * (`EXEC_HELPER_CRASHED`), because the tool may have run.
 */

const directExecFile = promisify(execFileCb);

/** Two crashes inside this window are a crash loop: spawn directly for the cooldown, then retry. */
export const EXEC_HELPER_CRASH_WINDOW_MS = 60_000;
export const EXEC_HELPER_CRASH_LIMIT = 3;
export const EXEC_HELPER_COOLDOWN_MS = 60_000;
/** How long past its own timeout a call may wait for the helper before the helper counts as wedged. */
export const EXEC_HELPER_RESPONSE_GRACE_MS = 2_000;
export const EXEC_HELPER_SHUTDOWN_DRAIN_MS = 1_500;

export interface ExecHelperStats {
  ready: boolean;
  pid: number | undefined;
  viaHelper: number;
  direct: number;
  crashes: number;
  spawns: number;
  inFlight: number;
}

interface PendingCall {
  file: string;
  resolve(value: { stdout: string | Uint8Array; stderr: string | Uint8Array }): void;
  reject(error: Error): void;
  guard?: NodeJS.Timeout;
}

type WorkerFactory = (bootstrapUrl: URL) => ChildProcessWorkerHandle;

function isDisabledByEnv(): boolean {
  const value = process.env[EXEC_HELPER_ENV_SWITCH];
  if (value === '0') return true;
  // Under vitest the helper is opt-in so module mocks of child_process keep seeing every call.
  return value !== '1' && Boolean(process.env.VITEST);
}

function rebuildError(info: ExecHelperErrorInfo): Error {
  const error = new Error(info.message);
  error.name = info.name;
  const fields: Partial<ExecHelperErrorInfo> = { ...info };
  delete fields.name;
  delete fields.message;
  return Object.assign(error, fields);
}

function helperError(code: string, message: string, file: string): Error {
  return Object.assign(new Error(message), { code, cmd: file, killed: false });
}

/** The options node's own `execFile` would honour, reduced to what the helper forwards; `null` = spawn directly. */
function forwardableOptions(options: unknown): ExecHelperOptions | null {
  const forwarded: Record<string, unknown> = {};
  if (options !== undefined && options !== null) {
    if (typeof options !== 'object') return null;
    for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
      if (value === undefined) continue;
      if (!(EXEC_HELPER_FORWARDED_OPTIONS as readonly string[]).includes(key)) return null;
      forwarded[key] = value;
    }
  }
  if (forwarded.cwd !== undefined && typeof forwarded.cwd !== 'string') return null;
  // A direct call reads these at call time, so the helper (forked at boot) must be told them per call.
  forwarded.cwd ??= process.cwd();
  forwarded.env ??= { ...process.env };
  return forwarded as ExecHelperOptions;
}

export class ExecHelperClient {
  private worker: ChildProcessWorkerHandle | null = null;
  private ready = false;
  private closed = false;
  private seq = 0;
  private readonly pending = new Map<number, PendingCall>();
  private crashTimes: number[] = [];
  private cooldownUntil = 0;
  private stats = { viaHelper: 0, direct: 0, crashes: 0, spawns: 0 };

  constructor(
    private readonly createWorker: WorkerFactory = (url) => spawnChildProcessWorker(url),
    private readonly now: () => number = Date.now,
  ) {}

  /** Fork the helper. Call once, as early as possible: fork cost is paid at the RSS of this moment. */
  start(): void {
    if (this.closed || this.worker) return;
    if (this.now() < this.cooldownUntil) return;
    const generation = ++this.stats.spawns;
    let worker: ChildProcessWorkerHandle;
    try {
      worker = this.createWorker(new URL('./exec-helper-worker-bootstrap.mjs', import.meta.url));
    } catch (error) {
      logger.warn({ err: error }, 'exec helper failed to start; spawning directly');
      return;
    }
    this.worker = worker;
    worker.unref();
    worker.on('message', (message: ExecHelperResponse) => {
      if (this.worker !== worker) return;
      this.onMessage(message);
    });
    worker.on('error', (error) => {
      if (this.worker === worker) this.onDown(worker, `error: ${error instanceof Error ? error.message : String(error)}`);
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.onDown(worker, `exit code ${code}`);
    });
    logger.debug({ generation, pid: worker.pid }, 'exec helper starting');
  }

  get isReady(): boolean {
    return this.ready && !this.closed;
  }

  getStats(): ExecHelperStats {
    return { ready: this.isReady, pid: this.worker?.pid, ...this.stats, inFlight: this.pending.size };
  }

  execFile: typeof directExecFile = ((file: string, args?: readonly string[] | null, options?: unknown) => {
    const helperOptions = this.isReady && Array.isArray(args) && typeof file === 'string' ? forwardableOptions(options) : null;
    if (!helperOptions) return this.direct(file, args, options);
    return this.viaHelper(file, args as string[], helperOptions, options);
  }) as never;

  private direct(file: string, args: unknown, options: unknown): Promise<unknown> {
    this.stats.direct += 1;
    // Same arity as the caller's, so module mocks and node see exactly what a plain call would.
    const call = directExecFile as unknown as (...params: unknown[]) => Promise<unknown>;
    if (options !== undefined) return call(file, args, options);
    if (args !== undefined) return call(file, args);
    return call(file);
  }

  private viaHelper(file: string, args: string[], options: ExecHelperOptions, original: unknown): Promise<unknown> {
    const worker = this.worker!;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const call: PendingCall = { file, resolve, reject };
      const timeout = options.timeout;
      if (typeof timeout === 'number' && timeout > 0) {
        call.guard = setTimeout(() => this.onUnresponsive(worker, id), timeout + EXEC_HELPER_RESPONSE_GRACE_MS);
        call.guard.unref?.();
      }
      this.pending.set(id, call);
      const request: ExecHelperRequest = { type: EXEC_HELPER_MSG.EXEC, id, file, args, options };
      try {
        worker.postMessage(request);
        this.stats.viaHelper += 1;
      } catch {
        // Never reached the helper, so it cannot have run: spawn directly instead of failing.
        this.pending.delete(id);
        if (call.guard) clearTimeout(call.guard);
        this.direct(file, args, original).then(resolve, reject);
      }
    });
  }

  private onMessage(message: ExecHelperResponse): void {
    if (message.type === EXEC_HELPER_MSG.READY) {
      this.ready = true;
      logger.debug({ pid: message.pid }, 'exec helper ready');
      return;
    }
    if (message.type !== EXEC_HELPER_MSG.RESULT) return;
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    if (call.guard) clearTimeout(call.guard);
    if (message.ok) call.resolve({ stdout: message.stdout, stderr: message.stderr });
    else call.reject(rebuildError(message.error));
  }

  private onUnresponsive(worker: ChildProcessWorkerHandle, id: number): void {
    const call = this.pending.get(id);
    if (!call || this.worker !== worker) return;
    this.pending.delete(id);
    call.reject(helperError(EXEC_HELPER_ERROR_CODE.UNRESPONSIVE, `exec helper did not answer ${call.file} in time`, call.file));
    logger.warn({ pid: worker.pid, file: call.file }, 'exec helper unresponsive; restarting it');
    worker.forceKill();
  }

  private onDown(worker: ChildProcessWorkerHandle, reason: string): void {
    this.worker = null;
    const wasReady = this.ready;
    this.ready = false;
    const failed = [...this.pending.values()];
    this.pending.clear();
    for (const call of failed) {
      if (call.guard) clearTimeout(call.guard);
      call.reject(helperError(EXEC_HELPER_ERROR_CODE.CRASHED, `exec helper stopped (${reason}) while running ${call.file}`, call.file));
    }
    worker.forceKill();
    if (this.closed) return;
    const now = this.now();
    this.stats.crashes += 1;
    this.crashTimes = [...this.crashTimes.filter((at) => now - at < EXEC_HELPER_CRASH_WINDOW_MS), now];
    if (this.crashTimes.length >= EXEC_HELPER_CRASH_LIMIT) {
      this.cooldownUntil = now + EXEC_HELPER_COOLDOWN_MS;
      logger.error({ crashes: this.crashTimes.length, reason }, 'exec helper is crash-looping; spawning directly for a while');
      // Retry once the cooldown is over, even if nothing calls start() again.
      const retry = setTimeout(() => this.start(), EXEC_HELPER_COOLDOWN_MS);
      retry.unref?.();
      return;
    }
    logger.warn({ pid: worker.pid, reason, wasReady, failedInFlight: failed.length }, 'exec helper stopped; respawning');
    this.start();
  }

  /** Stop routing to the helper. Calls already posted get a short window to finish; later calls spawn directly. */
  async shutdown(drainMs = EXEC_HELPER_SHUTDOWN_DRAIN_MS): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const worker = this.worker;
    const deadline = Date.now() + drainMs;
    while (this.pending.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.ready = false;
    this.worker = null;
    for (const call of this.pending.values()) {
      if (call.guard) clearTimeout(call.guard);
      call.reject(helperError(EXEC_HELPER_ERROR_CODE.CRASHED, `exec helper shut down while running ${call.file}`, call.file));
    }
    this.pending.clear();
    if (worker) await worker.terminate().catch(() => undefined);
  }
}

let defaultClient: ExecHelperClient | null = null;

/** Start the process-wide helper (daemon boot). No-op when disabled by `IMCODES_EXEC_HELPER=0`, under vitest, or already started. */
export function startExecHelper(): void {
  if (isDisabledByEnv() || defaultClient) return;
  defaultClient = new ExecHelperClient();
  defaultClient.start();
}

export async function shutdownExecHelper(): Promise<void> {
  const client = defaultClient;
  if (!client) return;
  await client.shutdown();
}

/** Drop the process-wide helper without waiting (tests only). */
export function __resetExecHelperForTests(): void {
  const client = defaultClient;
  defaultClient = null;
  void client?.shutdown(0);
}

export function getExecHelperStats(): ExecHelperStats | null {
  return defaultClient?.getStats() ?? null;
}

/** Drop-in for `promisify(execFile)`: same arguments, same `{ stdout, stderr }` result and error fields. */
export const execFileOffMain: typeof directExecFile = ((file: string, args?: readonly string[] | null, options?: ExecFileOptions) => {
  if (defaultClient) return defaultClient.execFile(file, args as never, options as never);
  const call = directExecFile as unknown as (...params: unknown[]) => Promise<unknown>;
  if (options !== undefined) return call(file, args, options);
  if (args !== undefined) return call(file, args);
  return call(file);
}) as never;
