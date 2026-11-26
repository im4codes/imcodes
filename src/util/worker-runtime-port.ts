import { parentPort, workerData } from 'node:worker_threads';

export interface WorkerRuntimePort {
  on(event: 'message', listener: (message: any) => void): void;
  postMessage(message: unknown, transferList?: readonly ArrayBuffer[]): void;
}

/** Bind one worker implementation to a thread port or an isolated child IPC channel. */
export function resolveWorkerRuntime(): { port: WorkerRuntimePort; data: unknown } {
  if (parentPort) return { port: parentPort as WorkerRuntimePort, data: workerData };
  if (typeof process.send === 'function') {
    process.once('disconnect', () => process.exit(0));
    return {
      port: {
        on: (_event, listener) => { process.on('message', listener); },
        // Advanced child-process serialization preserves Buffer/typed arrays;
        // transfer lists are a worker-thread optimization and are ignored here.
        postMessage: (message) => { process.send!(message); },
      },
      data: undefined,
    };
  }
  throw new Error('worker runtime requires a worker thread or IPC child process');
}
