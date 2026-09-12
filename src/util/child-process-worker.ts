import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Worker-like facade backed by a dedicated Node OS process and IPC channel. */
export interface ChildProcessWorkerHandle {
  readonly pid: number | undefined;
  unref(): void;
  on(event: 'message', listener: (message: any) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
  /** Unconditional SIGKILL. `terminate()` sends SIGTERM and only resolves on
   *  `exit`, so a child wedged inside a blocking call (e.g. SQLite) never
   *  confirms; the owner needs an escalation that cannot be ignored. */
  forceKill(): void;
}

class ForkedWorkerHandle implements ChildProcessWorkerHandle {
  constructor(private readonly child: ChildProcess) {}

  get pid(): number | undefined { return this.child.pid; }

  /**
   * Do not retain the daemon merely because the OS child exists. Keep the IPC
   * channel referenced so an awaited request cannot disappear underneath a
   * short-lived caller; daemon shutdown uses process.exit, which disconnects
   * the channel and makes worker-runtime-port terminate the child.
   */
  unref(): void {
    this.child.unref();
  }

  on(event: 'message' | 'error' | 'exit', listener: (value: any) => void): this {
    if (event === 'exit') {
      this.child.on('exit', (code) => listener(code ?? 1));
    } else if (event === 'error') {
      this.child.on('error', listener);
    } else {
      this.child.on('message', listener);
    }
    return this;
  }

  postMessage(message: unknown): void {
    if (!this.child.connected) throw new Error('child_process_worker_disconnected');
    this.child.send(message as Parameters<ChildProcess['send']>[0], (error) => {
      if (error) this.child.emit('error', error);
    });
  }

  terminate(): Promise<number> {
    if (this.child.exitCode !== null) return Promise.resolve(this.child.exitCode);
    return new Promise((resolve) => {
      this.child.once('exit', (code) => resolve(code ?? 1));
      this.child.kill('SIGTERM');
    });
  }

  forceKill(): void {
    if (this.child.exitCode !== null) return;
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export function spawnChildProcessWorker(
  bootstrapUrl: URL,
  options: { env?: Record<string, string | undefined> } = {},
): ChildProcessWorkerHandle {
  const child = fork(fileURLToPath(bootstrapUrl), [], {
    execArgv: [],
    env: { ...process.env, ...options.env },
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  return new ForkedWorkerHandle(child);
}
