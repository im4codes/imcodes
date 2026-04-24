/**
 * Main-thread client for the JSONL parse worker.
 *
 * Responsibility:
 *   - Lazily spawn a single worker thread on first use
 *   - Route requests by numeric id, handle timeouts
 *   - On worker crash / unexpected exit: mark pool permanently disabled so the
 *     caller falls back to main-thread parsing. (We don't auto-restart because
 *     the pending tool-call state lives in the worker and would be lost —
 *     logging and continuing on main is simpler and safe.)
 *
 * The worker is **disabled by default**: the project's hot paths are moving
 * to SDK-based transport providers, and every agent's chat now runs through
 * `timeline-projection-worker` for persistence — so the main-thread parseLine
 * cost on Claude JSONL is no longer a priority to offload. The worker code
 * is kept in-tree (plus its parity tests) as an opt-in escape hatch: set
 * `IM4CODES_JSONL_WORKER=1` (or true/yes/on) to turn it back on without a
 * redeploy.
 */

import { Worker } from 'node:worker_threads';
import type { ParseLinesRequest, ParseLinesResult } from './jsonl-parse-core.js';
import type {
  JsonlParseEnvelope,
  JsonlParseRequestMap,
  JsonlParseRequestType,
  JsonlParseResponse,
  JsonlParseResponseMap,
} from './jsonl-parse-worker-types.js';
import logger from '../util/logger.js';

const DEFAULT_PARSE_TIMEOUT_MS = 500;
const DEFAULT_FORGET_TIMEOUT_MS = 200;

/**
 * Resolve the worker entry URL.
 *
 * The entry is a `.mjs` bootstrap (not a `.ts` file) so Node can load it
 * directly in any mode. The bootstrap then registers the tsx loader (dev)
 * and imports the real worker module. See `jsonl-parse-worker-bootstrap.mjs`.
 */
function getWorkerModuleUrl(): URL {
  return new URL('./jsonl-parse-worker-bootstrap.mjs', import.meta.url);
}

/**
 * `true` if the pool should be used in place of main-thread parseLine.
 *
 * Default: `false`. Set `IM4CODES_JSONL_WORKER` to `1`/`true`/`yes`/`on` to
 * opt in (e.g. if a specific deployment notices JSONL parsing pressure on
 * the main event loop).
 */
export function isJsonlWorkerEnabled(): boolean {
  const raw = process.env.IM4CODES_JSONL_WORKER;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

class JsonlParsePool {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private permanentlyDisabled = false;

  /** True if the pool is currently alive (or may be lazily started). */
  isAvailable(): boolean {
    return !this.permanentlyDisabled;
  }

  private ensureWorker(): Worker | null {
    if (this.permanentlyDisabled) return null;
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(getWorkerModuleUrl());
      worker.unref();
      worker.on('message', (message: JsonlParseResponse) => this.handleWorkerMessage(message));
      worker.on('error', (err) => {
        logger.warn({ err }, 'JsonlParse: worker failed');
        this.failAllPending(err instanceof Error ? err : new Error(String(err)));
        this.worker = null;
        this.permanentlyDisabled = true;
      });
      worker.on('exit', (code) => {
        if (code !== 0) {
          logger.warn({ code }, 'JsonlParse: worker exited unexpectedly');
        }
        this.failAllPending(new Error(`jsonl_parse_worker_exit:${code}`));
        this.worker = null;
        // Only disable on non-zero exit; a clean shutdown is caller-initiated.
        if (code !== 0) this.permanentlyDisabled = true;
      });
      this.worker = worker;
      return worker;
    } catch (err) {
      logger.warn({ err }, 'JsonlParse: failed to start worker');
      this.permanentlyDisabled = true;
      return null;
    }
  }

  private handleWorkerMessage(message: JsonlParseResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error));
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  private request<TOp extends JsonlParseRequestType>(
    type: TOp,
    payload: JsonlParseRequestMap[TOp],
    timeoutMs: number,
  ): Promise<JsonlParseResponseMap[TOp]> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.reject(new Error('jsonl_parse_worker_unavailable'));
    const id = this.nextId++;
    return new Promise<JsonlParseResponseMap[TOp]>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`jsonl_parse_timeout:${type}`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const envelope: JsonlParseEnvelope<TOp> = { id, type, payload };
      worker.postMessage(envelope);
    });
  }

  /**
   * Parse a batch of JSONL lines in the worker.
   * Returns `null` on worker failure / timeout so the caller can fall back to
   * main-thread parsing.
   */
  async parseLines(req: ParseLinesRequest, timeoutMs = DEFAULT_PARSE_TIMEOUT_MS): Promise<ParseLinesResult | null> {
    if (this.permanentlyDisabled) return null;
    try {
      return await this.request('parseLines', req, timeoutMs);
    } catch (err) {
      logger.debug(
        { err, sessionName: req?.sessionName, count: Array.isArray(req?.items) ? req.items.length : -1 },
        'JsonlParse: parseLines failed, falling back',
      );
      return null;
    }
  }

  /** Drop worker-side pending tool-call state for a session. Best-effort. */
  async forgetSession(sessionName: string, timeoutMs = DEFAULT_FORGET_TIMEOUT_MS): Promise<void> {
    if (this.permanentlyDisabled) return;
    try {
      await this.request('forgetSession', { sessionName }, timeoutMs);
    } catch (err) {
      logger.debug({ err, sessionName }, 'JsonlParse: forgetSession failed');
    }
  }

  async shutdown(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    this.failAllPending(new Error('jsonl_parse_pool_shutdown'));
    try {
      await worker.terminate();
    } catch (err) {
      logger.debug({ err }, 'JsonlParse: terminate failed');
    }
    // terminate() exits the worker with a non-zero code, which would otherwise
    // trip the exit handler's permanentlyDisabled guard. Reset explicitly so
    // the pool can be restarted (useful for tests and, in principle, runtime
    // recovery via an admin reset).
    this.permanentlyDisabled = false;
  }
}

export const jsonlParsePool = new JsonlParsePool();
