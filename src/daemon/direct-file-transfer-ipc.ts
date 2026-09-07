import { EventEmitter, once } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DIRECT_FILE_TRANSFER_WORKER_KIND,
  type DirectFileTransferWorkerEnvelope,
} from '../../shared/direct-file-transfer.js';

export interface DirectFileTransferIsolate extends EventEmitter {
  readonly pid?: number;
  postMessage(value: DirectFileTransferWorkerEnvelope | Record<string, unknown>): void;
  terminate(): Promise<number>;
}

export interface DirectFileTransferIsolateOptions {
  workerData: {
    kind: typeof DIRECT_FILE_TRANSFER_WORKER_KIND;
    generation: number;
  };
}

const TERMINATE_GRACE_MS = 1_000;

/**
 * Adapter that deliberately keeps the small Worker-like surface used by the
 * daemon proxy while placing the native addon in a different OS process.
 */
class DirectFileTransferChild extends EventEmitter implements DirectFileTransferIsolate {
  private exited = false;
  private exitCode = 0;
  private terminatePromise: Promise<number> | null = null;

  constructor(private readonly child: ChildProcess) {
    super();
    child.on('message', (message) => this.emit('message', message));
    child.on('error', (error) => this.emit('error', error));
    child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitCode = code ?? (signal ? 128 : 0);
      this.emit('exit', code, signal);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  postMessage(value: DirectFileTransferWorkerEnvelope | Record<string, unknown>): void {
    if (this.exited || !this.child.connected) throw new Error('direct_file_transfer_child_not_connected');
    this.child.send(value, (error) => {
      if (error && !this.exited) this.emit('error', error);
    });
  }

  terminate(): Promise<number> {
    if (this.terminatePromise) return this.terminatePromise;
    if (this.exited) return Promise.resolve(this.exitCode);
    this.terminatePromise = (async () => {
      const exited = once(this.child, 'exit').then(([code, signal]) => (
        typeof code === 'number' ? code : signal ? 128 : 0
      ));
      this.child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (!this.exited) this.child.kill('SIGKILL');
      }, TERMINATE_GRACE_MS);
      timer.unref?.();
      try {
        return await exited;
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.terminatePromise;
  }
}

export function spawnDirectFileTransferChild(
  url: URL,
  options: DirectFileTransferIsolateOptions,
): DirectFileTransferIsolate {
  const child = fork(fileURLToPath(url), [], {
    detached: false,
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      IMCODES_DIRECT_FILE_TRANSFER_CHILD: options.workerData.kind,
      IMCODES_DIRECT_FILE_TRANSFER_GENERATION: String(options.workerData.generation),
    },
  });
  return new DirectFileTransferChild(child);
}
