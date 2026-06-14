/**
 * Local embedding generation using transformers.js (Hugging Face).
 * Runs entirely on CPU — no external API, no cost, ~2-5ms/query (q8).
 *
 * Model and config imported from shared/embedding-config.ts (single source of truth).
 * Lazy-loaded on first call — subsequent calls reuse the pipeline.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { EMBEDDING_MODEL, EMBEDDING_DTYPE, EMBEDDING_DIM } from '../../shared/embedding-config.js';
import logger from '../util/logger.js';
import { isServerFallbackUnavailable, tryServerEmbedding } from './embedding-server-fallback.js';

// Re-export shared constants for backward compatibility with existing imports
export { EMBEDDING_DIM, cosineSimilarity } from '../../shared/embedding-config.js';

/**
 * Resolve where transformers.js should cache the downloaded embedding model.
 *
 * Why this isn't just "leave it to transformers' default": transformers.js
 * defaults to `<package-install-dir>/.cache` (i.e. inside
 * `node_modules/@huggingface/transformers/.cache`). For ANY system-level
 * imcodes install — `npm i -g` on Linux landing in `/usr/lib/node_modules/`,
 * Homebrew installs under `/opt/homebrew/lib/node_modules/`, Docker images
 * with the package owned by root, etc. — a non-root daemon process cannot
 * write into that path and crashes the model load with EACCES on first use.
 * Real-world hit on 172.16.253.212 (2026-04-27): every embedding attempt
 * logged `EACCES: permission denied, mkdir
 * '/usr/lib/node_modules/imcodes/node_modules/@huggingface/transformers/.cache'`
 * and semantic memory recall was permanently disabled for the process.
 *
 * Defaulting to `~/.imcodes/embedding-cache/` makes the cache always live
 * somewhere the daemon owns. Users / ops can still override via
 * `IMCODES_EMBEDDING_CACHE_DIR` for shared caches, ramdisk, NFS, etc.
 */
function resolveEmbeddingCacheDir(): string {
  const fromEnv = process.env.IMCODES_EMBEDDING_CACHE_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), '.imcodes', 'embedding-cache');
}

// ── Engine abstraction ──────────────────────────────────────────────────────
// The raw transformers.js model load + feature-extraction inference is
// synchronous native CPU work. Running it on the daemon main thread froze the
// event loop for tens of seconds on loaded hosts and starved the server link.
// So the actual load/inference lives behind an EmbeddingEngine:
//   - WorkerEngine   (production): runs in a worker thread (embedding-worker.ts).
//   - InProcessEngine (tests / fallback): the original in-process path, so the
//     existing `vi.mock('@huggingface/transformers')` unit tests keep working.
// All sticky-failure / server-fallback / status POLICY stays in this module.

interface EmbeddingEngine {
  /** Load the model. Rejects with `.code` preserved on failure. */
  load(): Promise<void>;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
  dispose(): void;
}

const USE_WORKER_ENGINE = !(process.env.VITEST || process.env.NODE_ENV === 'test');

// Test seam: unit tests run in-process (so `@huggingface/transformers` mocks
// apply); a focused integration test overrides this to exercise the real
// worker path. null → follow USE_WORKER_ENGINE.
let forcedEngineKindForTests: 'worker' | 'inprocess' | null = null;

let engine: EmbeddingEngine | null = null;
function getEngine(): EmbeddingEngine {
  if (!engine) {
    const useWorker = forcedEngineKindForTests
      ? forcedEngineKindForTests === 'worker'
      : USE_WORKER_ENGINE;
    engine = useWorker ? new WorkerEmbeddingEngine() : new InProcessEmbeddingEngine();
  }
  return engine;
}

/** Test-only: force a specific engine and reset load state. */
export function __setEmbeddingEngineKindForTests(kind: 'worker' | 'inprocess' | null): void {
  _resetEmbeddingStateForTests();
  forcedEngineKindForTests = kind;
}

// In-process engine: the original transformers.js path, kept verbatim so the
// `@huggingface/transformers`-mocking unit tests still exercise real code, and
// as a fallback when a worker cannot be spawned.
class InProcessEmbeddingEngine implements EmbeddingEngine {
  private pipe: ((text: string, opts: unknown) => Promise<{ data: ArrayLike<number> }>) | null = null;

  async load(): Promise<void> {
    const { pipeline, env } = await import('@huggingface/transformers');
    const cacheDir = resolveEmbeddingCacheDir();
    if (cacheDir) (env as { cacheDir?: string }).cacheDir = cacheDir;
    logger.info({ model: EMBEDDING_MODEL, dtype: EMBEDDING_DTYPE, cacheDir: (env as { cacheDir?: string }).cacheDir }, 'Loading embedding model...');
    this.pipe = (await pipeline('feature-extraction', EMBEDDING_MODEL, {
      dtype: EMBEDDING_DTYPE,
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    })) as unknown as typeof this.pipe;
    logger.info({ model: EMBEDDING_MODEL, dim: EMBEDDING_DIM }, 'Embedding model loaded');
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.pipe) throw new Error('embedding pipeline not loaded');
    const result = await this.pipe(text, { pooling: 'mean', normalize: true });
    return result.data instanceof Float32Array ? result.data : Float32Array.from(result.data);
  }

  async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    const out: (Float32Array | null)[] = [];
    for (const text of texts) {
      try { out.push(await this.embed(text)); } catch { out.push(null); }
    }
    return out;
  }

  dispose(): void { this.pipe = null; }
}

// Worker engine: tiny request/response RPC to embedding-worker.ts. Self-heals a
// crashed worker by dropping the handle so the next load() respawns it.
class WorkerEmbeddingEngine implements EmbeddingEngine {
  private worker: import('node:worker_threads').Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private async ensureWorker(): Promise<import('node:worker_threads').Worker> {
    if (this.worker) return this.worker;
    const { Worker } = await import('node:worker_threads');
    // Spawn the plain-ESM bootstrap (NOT the .ts directly): a worker thread
    // doesn't inherit tsx's loader, so a raw .ts worker can't resolve our
    // `.js`-suffixed TS imports. The bootstrap registers tsx then imports the
    // real worker (.ts in dev, compiled .js in prod). Matches the other
    // *-worker-bootstrap.mjs workers; copy-worker-bootstraps.mjs ships it.
    const workerUrl = new URL('./embedding-worker-bootstrap.mjs', import.meta.url);
    const worker = new Worker(workerUrl, {
      workerData: { cacheDir: resolveEmbeddingCacheDir() },
    });
    worker.unref();
    worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string; code?: string | null }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else {
        const err = new Error(msg.error ?? 'embedding worker error') as Error & { code?: string };
        if (msg.code) err.code = msg.code;
        p.reject(err);
      }
    });
    const onDead = (err: Error) => {
      this.worker = null;
      for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(err); }
    };
    worker.on('error', (err) => onDead(err instanceof Error ? err : new Error(String(err))));
    worker.on('exit', (code) => { if (code !== 0 || this.pending.size) onDead(new Error(`embedding_worker_exit:${code}`)); });
    this.worker = worker;
    return worker;
  }

  private async request<T>(message: { type: string; text?: string; texts?: string[] }): Promise<T> {
    const worker = await this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, ...message });
    });
  }

  async load(): Promise<void> { await this.request<true>({ type: 'warmup' }); }
  embed(text: string): Promise<Float32Array> { return this.request<Float32Array>({ type: 'embed', text }); }
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]> { return this.request<(Float32Array | null)[]>({ type: 'embedBatch', texts }); }

  dispose(): void {
    const w = this.worker;
    this.worker = null;
    for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new Error('embedding worker disposed')); }
    if (w) void w.terminate();
  }
}

// Load lifecycle state (engine-agnostic).
let engineReady = false;
let loadingPromise: Promise<void> | null = null;
/** Sticky flag set when semantic search is permanently unavailable for this
 *  process. Two failure modes set it:
 *
 *    1. `ERR_MODULE_NOT_FOUND` — `@huggingface/transformers` (an optional
 *       dep) wasn't installed, e.g. the user's npm install skipped its
 *       onnxruntime-node postinstall under restrictive networks.
 *
 *    2. `ERR_DLOPEN_FAILED` — `onnxruntime-node`'s native binary cannot be
 *       loaded. On Windows this typically means either:
 *         - The CPU is missing AVX-512 / AVX-VNNI required by the prebuilt
 *           onnxruntime.dll. We pin to onnxruntime-node@1.20.1 in the
 *           package.json overrides specifically because 1.21+ Windows
 *           prebuilds were compiled with /arch:AVX512, breaking every
 *           Broadwell-EP and earlier x86 CPU. If even 1.20.1 fails, the CPU
 *           is older than Haswell (no AVX2) — semantic search is genuinely
 *           unsupported.
 *         - DirectML.dll has been removed and System32's copy is
 *           ABI-incompatible with the bundled onnxruntime.dll.
 *
 *  Both modes are deterministic: re-trying the import on every call burns
 *  CPU and re-emits the same warning forever. Stickying the flag means we
 *  log once and then quietly return null on subsequent calls. */
let unavailable = false;
let unavailableReason: string | null = null;

// ── Float32 ⇄ Buffer helpers ────────────────────────────────────────────────
// Used by the persistent embedding store in context-store.ts to stash the
// L2-normalized query-time output as a BLOB. Every vector is EMBEDDING_DIM
// floats (= 384 × 4 bytes = 1.5 KB).

/** Encode a Float32Array to a little-endian Buffer suitable for SQLite BLOB. */
export function encodeEmbedding(vec: Float32Array): Buffer {
  // Copy because Float32Array's underlying ArrayBuffer may include unrelated
  // bytes when the view was created via .slice() on a larger buffer.
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

/** Decode a SQLite BLOB back into a Float32Array. Returns null if size mismatches. */
export function decodeEmbedding(buf: Buffer | Uint8Array | null | undefined): Float32Array | null {
  if (!buf) return null;
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (bytes.length !== EMBEDDING_DIM * 4) return null;
  const out = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) out[i] = bytes.readFloatLE(i * 4);
  return out;
}

/** Sticky failure codes — these are deterministic per-machine, so retrying
 *  burns CPU without ever recovering. See the unavailableReason doc above. */
const STICKY_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_DLOPEN_FAILED',
]);

async function ensureEngineLoaded(): Promise<void> {
  if (engineReady) return;
  if (unavailable) throw new Error(`embedding model unavailable (${unavailableReason ?? 'unknown'})`);
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      await getEngine().load();
      engineReady = true;
    } catch (err) {
      loadingPromise = null;
      const code = (err as { code?: string } | null)?.code;
      // Deterministic failures get the sticky treatment so we don't re-try
      // (and re-warn) on every embedding call for the rest of the process.
      // Transient failures (network, OOM during model download) keep the
      // retry path so a blip doesn't permanently kill semantic search.
      if (code && STICKY_FAILURE_CODES.has(code)) {
        unavailable = true;
        unavailableReason = code;
        if (code === 'ERR_DLOPEN_FAILED') {
          // Almost always: onnxruntime.dll's prebuilt binary uses AVX-512 /
          // AVX-VNNI instructions this CPU doesn't have (true on every x86
          // CPU older than Skylake-X server / Ice Lake desktop), or the
          // bundled DirectML.dll was stripped and System32's copy is ABI-
          // incompatible. Print actionable detail; users with old hardware
          // need to know "your CPU is too old for the bundled binary"
          // rather than seeing a cryptic stack trace.
          logger.warn(
            { code, message: (err as { message?: string }).message },
            'onnxruntime native binding failed to load (DLL init error). '
              + 'Likely cause: CPU lacks AVX2 / AVX-512, or bundled DirectML.dll is missing. '
              + 'Semantic memory recall disabled for this process.',
          );
        } else {
          logger.warn(
            { code },
            '@huggingface/transformers not installed — semantic search disabled (install the optional dep to enable)',
          );
        }
      } else {
        logger.warn({ err }, 'Failed to load embedding model — will retry on next call');
      }
      throw err;
    }
  })();

  return loadingPromise;
}

/** Test-only: reset the sticky-disable state so each test starts fresh. */
export function _resetEmbeddingStateForTests(): void {
  try { engine?.dispose(); } catch { /* ignore */ }
  engine = null;
  engineReady = false;
  loadingPromise = null;
  unavailable = false;
  unavailableReason = null;
}

/** Returns the sticky-failure reason (e.g. 'ERR_DLOPEN_FAILED') if embedding
 *  has been permanently disabled this process, else null. Useful for
 *  surfacing actionable diagnostics in memory-recall code paths so the UI
 *  can degrade gracefully instead of silently returning empty results. */
export function getEmbeddingUnavailableReason(): string | null {
  return unavailable ? unavailableReason : null;
}

/**
 * High-level embedding status for telemetry / UI display.
 * See `shared/embedding-status.ts` for the wire-format type definition
 * and `state` semantics.
 *
 * No side effects — never triggers a load, never makes a network call.
 * Safe to call on every heartbeat.
 */
export type { EmbeddingStatus } from '../../shared/embedding-status.js';

export function getEmbeddingStatus(): import('../../shared/embedding-status.js').EmbeddingStatus {
  if (engineReady) return { state: 'ready', reason: null };
  if (loadingPromise) return { state: 'loading', reason: null };
  if (!unavailable) return { state: 'idle', reason: null };

  // Local has sticky-failed. Decide between `fallback` and `unavailable`
  // by peeking at the server-fallback module's sticky flag. The accessor
  // never triggers a network call or credential read — it only reads a
  // module-level boolean.
  if (isServerFallbackUnavailable()) {
    return { state: 'unavailable', reason: unavailableReason };
  }
  return { state: 'fallback', reason: unavailableReason };
}

/**
 * Generate a normalized embedding vector for a text string.
 *
 * Resolution order:
 *   1. Local pipeline via `@huggingface/transformers` (fast path, ~5 ms).
 *   2. Server fallback via `POST /api/embedding` if the daemon is bound
 *      and the local pipeline is permanently unavailable (sharp empty
 *      placeholders, onnxruntime DLOPEN failure on old CPUs, etc.).
 *
 * Returns a Float32Array of EMBEDDING_DIM dimensions, or null when both
 * paths fail. The fallback only fires when the LOCAL pipeline has
 * sticky-disabled — we never round-trip the network on the happy path.
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  try {
    await ensureEngineLoaded();
    return await getEngine().embed(text);
  } catch {
    // Local failed. If it's sticky-disabled (deterministic per-host),
    // try the server fallback. Transient local failures fall through to
    // null without burning a network call.
    if (unavailable) {
      if (isServerFallbackUnavailable()) return null;
      return await tryServerEmbedding(text);
    }
    return null;
  }
}

/**
 * Generate embeddings for multiple texts in batch.
 * More efficient than calling generateEmbedding() in a loop.
 */
export async function generateEmbeddings(texts: string[]): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  try {
    await ensureEngineLoaded();
    return await getEngine().embedBatch(texts);
  } catch {
    // Local pipeline dead. Fall back to server one-at-a-time when the
    // local failure is deterministic. Server doesn't have a batch endpoint
    // yet — sequential is fine because the batch path is only hot during
    // recall and a sticky-disabled local pipeline is rare overall.
    if (unavailable) {
      if (isServerFallbackUnavailable()) return texts.map(() => null);
      const out: (Float32Array | null)[] = [];
      for (const text of texts) {
        out.push(await tryServerEmbedding(text));
        if (isServerFallbackUnavailable()) {
          // Server became unavailable mid-batch — fill the rest with null
          // and break, don't keep firing requests at a sticky-disabled server.
          while (out.length < texts.length) out.push(null);
          break;
        }
      }
      return out;
    }
    return texts.map(() => null);
  }
}

/**
 * Check if the embedding model is available (loaded or loadable).
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  try {
    await ensureEngineLoaded();
    return true;
  } catch {
    return false;
  }
}
