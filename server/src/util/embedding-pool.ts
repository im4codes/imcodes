/**
 * Main-thread client for the embedding worker.
 *
 * Responsibilities:
 *   - Lazily spawn one worker thread on first use.
 *   - Route requests by numeric id, fail with a per-request timeout.
 *   - Sticky-disable on deterministic failures (`MODULE_NOT_FOUND`,
 *     `ERR_DLOPEN_FAILED`) so we don't burn CPU re-spawning on every
 *     request when the host can't run the model.
 *   - Expose `embed()` and `isAvailable()` to the rest of the server.
 *
 * The pool owns ONE worker. Embedding inference is single-threaded inside
 * the worker (transformers.js uses ONNX runtime which itself parallelizes
 * matmuls), so spawning N workers buys us request-level concurrency at
 * the cost of N× model memory (~700 MB each for q8). For v1 a single
 * worker is enough; a worker count knob can be added later if metrics
 * show queue depth growing.
 *
 * Mirrors `src/daemon/jsonl-parse-pool.ts` in spirit — keep similar
 * lifecycle semantics so operators have one mental model.
 */

import { Worker } from 'node:worker_threads';
import logger from './logger.js';
import { EMBEDDING_DIM } from '../../../shared/embedding-config.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Sticky failure codes: deterministic per-host, retrying just burns CPU. */
const STICKY_FAILURE_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_DLOPEN_FAILED',
]);

type EmbedRequest = { id: number; type: 'embed'; text: string };
type EmbedResult = { id: number; type: 'result'; embedding: Float32Array };
type EmbedError = { id: number; type: 'error'; code: string | null; message: string };
type WorkerResponse = EmbedResult | EmbedError;

interface PendingEntry {
  resolve: (embedding: Float32Array) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Resolve the worker entry URL.
 *
 * The entry is the `.mjs` bootstrap (NOT the `.ts` worker directly) so
 * Node can load it in any mode. The bootstrap registers the tsx loader
 * (dev / vitest) and dynamically imports the real worker module. See
 * `embedding-worker-bootstrap.mjs`.
 */
function getWorkerModuleUrl(): URL {
  return new URL('./embedding-worker-bootstrap.mjs', import.meta.url);
}

export class EmbeddingPool {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private permanentlyDisabled = false;
  private disableReason: string | null = null;

  /** Test-only seam; default factory builds a real worker. */
  constructor(private readonly workerFactory: () => Worker = () => new Worker(getWorkerModuleUrl())) {}

  /** True if the pool may still serve requests. False once a sticky failure has happened. */
  isAvailable(): boolean {
    return !this.permanentlyDisabled;
  }

  /** Reason the pool is disabled, or null if still alive. */
  getDisableReason(): string | null {
    return this.disableReason;
  }

  /**
   * Compute an embedding for `text`. Returns a Float32Array of
   * EMBEDDING_DIM dimensions, or null when the pool is permanently
   * disabled. Throws on transient errors (timeout, malformed response)
   * so the caller can decide whether to retry.
   */
  async embed(text: string, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Float32Array | null> {
    if (this.permanentlyDisabled) return null;

    const worker = this.ensureWorker();
    if (!worker) return null;

    const id = this.nextId++;
    return new Promise<Float32Array | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`embedding request ${id} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (embedding) => {
          clearTimeout(timer);
          resolve(embedding);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });

      try {
        const req: EmbedRequest = { id, type: 'embed', text };
        worker.postMessage(req);
      } catch (err) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          clearTimeout(entry.timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  /**
   * Stop the worker and reject all pending requests. Idempotent. Used by
   * server shutdown and tests.
   */
  async destroy(): Promise<void> {
    this.failAllPending(new Error('embedding pool destroyed'));
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        // best-effort
      }
      this.worker = null;
    }
  }

  private ensureWorker(): Worker | null {
    if (this.permanentlyDisabled) return null;
    if (this.worker) return this.worker;
    try {
      const worker = this.workerFactory();
      worker.unref();
      worker.on('message', (message: WorkerResponse) => this.handleWorkerMessage(message));
      worker.on('error', (err) => {
        logger.warn({ err }, 'EmbeddingPool: worker error');
        this.failAllPending(err instanceof Error ? err : new Error(String(err)));
        this.worker = null;
        // Worker `error` is usually a load-time failure (transformers
        // not installed, native binding crash). Sticky-disable so we
        // don't keep re-spawning a worker that can't even initialize.
        this.permanentlyDisabled = true;
        this.disableReason = err instanceof Error ? (err.message || 'worker_error') : String(err);
      });
      worker.on('exit', (code) => {
        if (code !== 0) {
          logger.warn({ code }, 'EmbeddingPool: worker exited unexpectedly');
        }
        this.failAllPending(new Error(`embedding_worker_exit:${code}`));
        this.worker = null;
        if (code !== 0) {
          // Crash exits sticky-disable so we don't enter a respawn loop.
          this.permanentlyDisabled = true;
          this.disableReason = `worker_exit_${code}`;
        }
      });
      this.worker = worker;
      return worker;
    } catch (err) {
      logger.warn({ err }, 'EmbeddingPool: failed to spawn worker');
      this.permanentlyDisabled = true;
      this.disableReason = err instanceof Error ? (err.message || 'spawn_failed') : 'spawn_failed';
      return null;
    }
  }

  private handleWorkerMessage(message: WorkerResponse): void {
    if (!message || typeof message !== 'object' || typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);

    if (message.type === 'result') {
      if (!(message.embedding instanceof Float32Array) || message.embedding.length !== EMBEDDING_DIM) {
        pending.reject(new Error(`embedding worker returned invalid payload (len=${(message.embedding as { length?: number })?.length ?? '?'})`));
        return;
      }
      pending.resolve(message.embedding);
      return;
    }

    if (message.type === 'error') {
      // Deterministic failure → sticky-disable the whole pool. The pending
      // request gets rejected; subsequent calls short-circuit to null.
      if (message.code && STICKY_FAILURE_CODES.has(message.code)) {
        this.permanentlyDisabled = true;
        this.disableReason = message.code;
        logger.warn({ code: message.code, message: message.message }, 'EmbeddingPool: sticky-disabled by deterministic worker failure');
      }
      pending.reject(new Error(message.message || 'embedding_worker_error'));
      return;
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      try {
        clearTimeout(pending.timer);
      } catch { /* ignore */ }
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────
//
// The server creates one pool per process. Tests can construct their own
// EmbeddingPool with an injected factory.

let sharedPool: EmbeddingPool | null = null;

/** Get (or lazy-create) the process-wide singleton pool. */
export function getEmbeddingPool(): EmbeddingPool {
  if (!sharedPool) sharedPool = new EmbeddingPool();
  return sharedPool;
}

/** Test-only: swap the singleton (or clear it). */
export function __setEmbeddingPoolForTests(pool: EmbeddingPool | null): void {
  sharedPool = pool;
}

/** Server shutdown hook — terminates the worker and resets state. */
export async function shutdownEmbeddingPool(): Promise<void> {
  if (!sharedPool) return;
  await sharedPool.destroy();
  sharedPool = null;
}
