import { Worker } from 'node:worker_threads';

type Kind = 'open' | 'message' | 'error' | 'close';
type Listener = (event: Event & { data?: unknown; message?: string; code?: number; reason?: string }) => void;
export type CoreLanePriority = 'priority' | 'normal';
export type CoreLaneSocketOptions = {
  auth?: string;
  daemonVersion?: string;
  stallRestartMs?: number;
  heartbeatMs?: number;
  connectTimeoutMs?: number;
  authorizedSessions?: string[];
  inboundInboxPath?: string;
  maxQueueBytes?: number;
  priorityReserveBytes?: number;
};

const DEFAULT_QUEUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_PRIORITY_RESERVE_BYTES = 1024 * 1024;
const WORKER_RESPAWN_BASE_MS = 250;
const WORKER_RESPAWN_MAX_MS = 30_000;

/** WebSocket-compatible facade. The actual socket and its timers live off-main-thread. */
export class CoreLaneSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  bufferedAmount = 0;
  private worker!: Worker;
  private readonly listeners = new Map<Kind, Set<Listener>>();
  private readonly pendingPriority: string[] = [];
  private readonly pendingNormal: string[] = [];
  private pendingPriorityBytes = 0;
  private pendingNormalBytes = 0;
  private readonly maxQueueBytes: number;
  private readonly priorityReserveBytes: number;
  private readonly options: CoreLaneSocketOptions;
  private stopping = false;
  private respawnTimer?: ReturnType<typeof setTimeout>;
  private respawnAttempt = 0;
  private workerFailureHandled = false;

  constructor(private readonly url: string, options: CoreLaneSocketOptions = {}) {
    this.options = options;
    this.maxQueueBytes = Math.max(64 * 1024, Math.trunc(options.maxQueueBytes ?? DEFAULT_QUEUE_BYTES));
    this.priorityReserveBytes = Math.min(
      this.maxQueueBytes - 1,
      Math.max(1, Math.trunc(options.priorityReserveBytes ?? DEFAULT_PRIORITY_RESERVE_BYTES)),
    );
    this.spawnWorker();
  }

  private spawnWorker(): void {
    if (this.stopping) return;
    const workerFile = 'server-link-worker-bootstrap.mjs';
    const worker = new Worker(new URL(`./${workerFile}`, import.meta.url), {
      workerData: { url: this.url, ...this.options },
      execArgv: process.execArgv,
    });
    this.worker = worker;
    this.workerFailureHandled = false;
    this.readyState = 0;
    worker.on('message', (message: {
      event: Kind | 'drained' | 'reconnecting' | 'liveness_timeout';
      data?: unknown;
      binary?: boolean;
      message?: string;
      code?: number;
      reason?: string;
      bytes?: number;
      inboundId?: string;
    }) => {
      if (worker !== this.worker) return;
      if (message.event === 'open') {
        this.readyState = CoreLaneSocket.OPEN;
        this.respawnAttempt = 0;
        this.flushPending();
      }
      if (message.event === 'close') this.readyState = CoreLaneSocket.CLOSED;
      if (message.event === 'drained') {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - Number(message.bytes ?? 0));
        return;
      }
      const event = Object.assign(new Event(message.event), {
        data: message.binary ? Buffer.from(message.data as ArrayBuffer) : message.data,
        message: message.message,
        code: message.code,
        reason: message.reason,
        inboundId: message.inboundId,
      });
      if (message.event === 'liveness_timeout') {
        // Preserve observability without making liveness depend on the main
        // event loop; the worker will terminate and reconnect independently.
        for (const listener of this.listeners.get('error') ?? []) listener(event);
        return;
      }
      for (const listener of this.listeners.get(message.event as Kind) ?? []) listener(event);
      // The daemon calls commitInbound after its synchronous dispatch has
      // installed the command in its idempotency/delivery path. Until then
      // the worker's fsynced inbox will replay it after a crash.

    });
    worker.on('error', (error) => {
      if (worker !== this.worker) return;
      const event = Object.assign(new Event('error'), { message: error.message });
      for (const listener of this.listeners.get('error') ?? []) listener(event);
      this.handleWorkerFailure(worker, 1011, error.message);
    });
    worker.on('exit', (code) => {
      if (worker !== this.worker || this.stopping || code === 0) return;
      this.handleWorkerFailure(worker, 1011, `worker_exit:${code}`);
    });
  }

  private handleWorkerFailure(worker: Worker, code: number, reason: string): void {
    if (this.workerFailureHandled || this.stopping || worker !== this.worker) return;
    this.workerFailureHandled = true;
    this.readyState = CoreLaneSocket.CLOSED;
    const closeEvent = Object.assign(new Event('close'), { code, reason });
    for (const listener of this.listeners.get('close') ?? []) listener(closeEvent);
    if (this.respawnTimer) return;
    const delay = Math.min(WORKER_RESPAWN_MAX_MS, WORKER_RESPAWN_BASE_MS * (2 ** Math.min(this.respawnAttempt++, 7)));
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined;
      this.spawnWorker();
    }, delay);
  }

  private flushPending(): void {
    const pending = [...this.pendingPriority, ...this.pendingNormal];
    this.pendingPriority.length = 0;
    this.pendingNormal.length = 0;
    this.pendingPriorityBytes = 0;
    this.pendingNormalBytes = 0;
    for (const payload of pending) {
      const bytes = Buffer.byteLength(payload);
      this.bufferedAmount += bytes;
      this.worker.postMessage({ type: 'send', payload });
    }
  }

  addEventListener(kind: Kind, listener: Listener): void {
    let listeners = this.listeners.get(kind);
    if (!listeners) this.listeners.set(kind, listeners = new Set());
    listeners.add(listener);
  }

  send(payload: string | Uint8Array, priority: CoreLanePriority = 'normal'): void {
    const bytes = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
    if (typeof payload !== 'string' && this.readyState !== CoreLaneSocket.OPEN) {
      throw new Error('core lane queues only serialized text while reconnecting');
    }
    const normalLimit = this.maxQueueBytes - this.priorityReserveBytes;
    if (this.readyState !== CoreLaneSocket.OPEN) {
      if (priority === 'priority') {
        if (this.pendingPriorityBytes + bytes > this.priorityReserveBytes) throw new Error('core lane priority queue is full');
        this.pendingPriority.push(payload as string);
        this.pendingPriorityBytes += bytes;
      } else {
        if (this.pendingNormalBytes + bytes > normalLimit) throw new Error('core lane normal queue is full');
        this.pendingNormal.push(payload as string);
        this.pendingNormalBytes += bytes;
      }
      return;
    }
    const normalCapExceeded = priority === 'normal' && this.bufferedAmount + bytes > normalLimit;
    if (normalCapExceeded || this.bufferedAmount + bytes > this.maxQueueBytes) {
      throw new Error(`core lane ${priority} queue is full`);
    }
    this.bufferedAmount += bytes;
    if (typeof payload === 'string') this.worker.postMessage({ type: 'send', payload });
    else this.worker.postMessage({ type: 'send', payload }, [payload.buffer as ArrayBuffer]);
  }

  updateAuthorizedSessions(sessions: readonly string[]): void {
    if (this.stopping) return;
    this.worker.postMessage({ type: 'sessions', sessions: [...sessions] });
  }

  commitInbound(inboundId: string): void {
    if (!inboundId || this.stopping) return;
    this.worker.postMessage({ type: 'inbound_commit', inboundId });
  }

  updateMainLag(lagMs: number): void {
    this.worker.postMessage({ type: 'lag', lagMs: Math.max(0, Math.trunc(lagMs)) });
  }

  close(code?: number, reason?: string): void {
    this.stopping = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.worker.postMessage({ type: 'close', code, reason });
    this.readyState = CoreLaneSocket.CLOSED;
    void this.worker.terminate();
  }

  terminate(): void {
    this.stopping = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.worker.postMessage({ type: 'terminate' });
    void this.worker.terminate();
    this.readyState = CoreLaneSocket.CLOSED;
  }
}

export function coreLaneWorkerEnabled(): boolean {
  return process.env.IMCODES_CORE_LINK_WORKER !== '0' && !process.env.VITEST;
}
