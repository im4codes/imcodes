/**
 * Local embedding generation using transformers.js (Hugging Face).
 * Runs entirely on CPU — no external API, no cost, ~2-5ms/query (q8).
 *
 * Model and config imported from shared/embedding-config.ts (single source of truth).
 * Lazy-loaded on first call — subsequent calls reuse the pipeline.
 */

import { join } from 'node:path';

import { EMBEDDING_MODEL, EMBEDDING_DTYPE, EMBEDDING_DIM } from '../../shared/embedding-config.js';
import { isMemoryDaemonEnabled } from '../store/memory-daemon-switch.js';
import logger from '../util/logger.js';
import {
  isServerFallbackUnavailable,
  isServerFallbackReady,
  tryServerEmbedding,
  getServerFallbackDisableReason,
} from './embedding-server-fallback.js';
import { getLoadedConfig } from '../config.js';
import {
  spawnChildProcessWorker,
  type ChildProcessWorkerHandle,
} from '../util/child-process-worker.js';
import { imcodesStateDir } from '../util/imcodes-state-dir.js';

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
  return join(imcodesStateDir(), 'embedding-cache');
}

// ── Engine abstraction ──────────────────────────────────────────────────────
// The raw transformers.js model load + feature-extraction inference is
// synchronous native CPU work. Running it on the daemon main thread froze the
// event loop for tens of seconds on loaded hosts and starved the server link.
// So the actual load/inference lives behind an EmbeddingEngine:
//   - WorkerEngine   (production): runs in a child process (embedding-worker.ts).
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

export type ConfiguredEmbeddingMode = 'auto' | 'local' | 'server' | 'off';

let forcedEmbeddingModeForTests: ConfiguredEmbeddingMode | null = null;

/**
 * Resolve the configured embedding mode:
 * - 'server': Offload embeddings to the cloud server endpoint (POST /api/embedding).
 *             Zero local CPU inference, zero ONNX runtime, zero worker process spawned.
 * - 'off':    Disable embedding generation entirely. Gracefully falls back to local
 *             substring / keyword search in memory recall.
 * - 'local':  Run local CPU inference via transformers.js / onnxruntime-node.
 * - 'auto':   Default: attempts local engine, falling back to server if local is unavailable.
 */
export function getEmbeddingMode(): ConfiguredEmbeddingMode {
  if (forcedEmbeddingModeForTests) return forcedEmbeddingModeForTests;

  const envMode = process.env.IMCODES_EMBEDDING_MODE?.trim().toLowerCase();
  if (envMode === 'server' || envMode === 'remote') return 'server';
  if (envMode === 'off' || envMode === 'disabled' || envMode === 'none') return 'off';
  if (envMode === 'local' || envMode === 'worker' || envMode === 'inprocess') return 'local';
  if (envMode === 'auto') return 'auto';

  if (process.env.IMCODES_EMBEDDING_DISABLED === '1' || process.env.IMCODES_EMBEDDING_DISABLED === 'true') {
    return 'off';
  }
  if (process.env.IMCODES_DISABLE_LOCAL_EMBEDDING === '1' || process.env.IMCODES_DISABLE_LOCAL_EMBEDDING === 'true') {
    return 'server';
  }

  // In test runs, don't read host config.yaml unless explicitly configured via env var
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return 'auto';
  }

  const loadedConfig = getLoadedConfig();
  const configMode = loadedConfig?.memory?.embeddingMode?.trim().toLowerCase();
  if (configMode === 'server' || configMode === 'remote') return 'server';
  if (configMode === 'off' || configMode === 'disabled' || configMode === 'none') return 'off';
  if (configMode === 'local' || configMode === 'worker' || configMode === 'inprocess') return 'local';

  return 'auto';
}

/** Test-only: force a specific embedding mode. */
export function __setEmbeddingModeForTests(mode: ConfiguredEmbeddingMode | null): void {
  forcedEmbeddingModeForTests = mode;
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

// Worker engine: tiny request/response IPC to embedding-worker.ts. Self-heals a
// crashed process by dropping the handle so the next load() respawns it.
class WorkerEmbeddingEngine implements EmbeddingEngine {
  private worker: ChildProcessWorkerHandle | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private async ensureWorker(): Promise<ChildProcessWorkerHandle> {
    if (this.worker) return this.worker;
    // Run ONNX in a dedicated OS process. Native allocation, CPU saturation,
    // and fatal runtime failures cannot block or terminate the daemon, while
    // the process-wide engine still gives every daemon caller one shared model.
    const workerUrl = new URL('./embedding-worker-bootstrap.mjs', import.meta.url);
    const worker = spawnChildProcessWorker(workerUrl, {
      env: { IMCODES_EMBEDDING_CACHE_DIR: resolveEmbeddingCacheDir() },
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
  forcedEmbeddingModeForTests = null;
  embeddingCache.clear();
  inFlightEmbeddings.clear();
  delete process.env.IMCODES_EMBEDDING_MODE;
  delete process.env.IMCODES_DISABLE_LOCAL_EMBEDDING;
  delete process.env.IMCODES_EMBEDDING_DISABLED;
}

const MAX_EMBEDDING_CACHE_SIZE = 2048;
const embeddingCache = new Map<string, Float32Array>();
const inFlightEmbeddings = new Map<string, Promise<Float32Array | null>>();

function cacheEmbedding(text: string, vec: Float32Array): void {
  if (embeddingCache.size >= MAX_EMBEDDING_CACHE_SIZE) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest !== undefined) embeddingCache.delete(oldest);
  }
  embeddingCache.set(text, vec);
}

/**
 * Attempt to delegate embedding generation to the machine-wide daemon hook server.
 * Returns undefined if not applicable or daemon unreachable, so caller falls back to direct.
 */
async function tryDaemonEmbedding(text: string): Promise<Float32Array | null | undefined> {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return undefined;
  }

  try {
    const { isDaemonProcess } = await import('../daemon/process-role.js');
    if (isDaemonProcess()) return undefined;
  } catch {
    return undefined;
  }

  try {
    const { readSavedHookPort } = await import('../daemon/hook-port.js');
    const port = readSavedHookPort();
    if (!port) return undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/daemon/embedding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const body = await res.json() as { ok?: boolean; embedding?: number[] | null };
      if (body.ok) {
        if (Array.isArray(body.embedding)) {
          const vec = new Float32Array(body.embedding);
          cacheEmbedding(text, vec);
          return vec;
        }
        if (body.embedding === null) return null;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function tryDaemonEmbeddings(texts: string[]): Promise<(Float32Array | null)[] | undefined> {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return undefined;
  }

  try {
    const { isDaemonProcess } = await import('../daemon/process-role.js');
    if (isDaemonProcess()) return undefined;
  } catch {
    return undefined;
  }

  try {
    const { readSavedHookPort } = await import('../daemon/hook-port.js');
    const port = readSavedHookPort();
    if (!port) return undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/daemon/embedding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const body = await res.json() as { ok?: boolean; embeddings?: (number[] | null)[] };
      if (body.ok && Array.isArray(body.embeddings)) {
        return body.embeddings.map((arr, i) => {
          if (Array.isArray(arr)) {
            const vec = new Float32Array(arr);
            cacheEmbedding(texts[i], vec);
            return vec;
          }
          return null;
        });
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Direct generation in this process (bypassing daemon hook delegation).
 * Used by the daemon itself to fulfill incoming embedding RPCs or internal calls.
 */
export async function generateEmbeddingDirect(text: string): Promise<Float32Array | null> {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const inFlight = inFlightEmbeddings.get(text);
  if (inFlight) return await inFlight;

  const runPromise = (async () => {
    try {
      const mode = getEmbeddingMode();
      if (mode === 'off') return null;

      if (mode === 'server') {
        if (isServerFallbackUnavailable()) return null;
        const vec = await tryServerEmbedding(text);
        if (vec) cacheEmbedding(text, vec);
        return vec;
      }

      try {
        await ensureEngineLoaded();
        const vec = await getEngine().embed(text);
        if (vec) cacheEmbedding(text, vec);
        return vec;
      } catch {
        if (unavailable) {
          if (isServerFallbackUnavailable()) return null;
          const vec = await tryServerEmbedding(text);
          if (vec) cacheEmbedding(text, vec);
          return vec;
        }
        return null;
      }
    } finally {
      inFlightEmbeddings.delete(text);
    }
  })();

  inFlightEmbeddings.set(text, runPromise);
  return await runPromise;
}

export async function generateEmbeddingsDirect(texts: string[]): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];

  const results: (Float32Array | null | undefined)[] = texts.map((t) => embeddingCache.get(t));
  const missingIndices: number[] = [];
  const missingTexts: string[] = [];

  for (let i = 0; i < texts.length; i++) {
    if (results[i] === undefined) {
      missingIndices.push(i);
      missingTexts.push(texts[i]);
    }
  }

  if (missingTexts.length === 0) {
    return results as (Float32Array | null)[];
  }

  const mode = getEmbeddingMode();
  if (mode === 'off') {
    for (const idx of missingIndices) results[idx] = null;
    return results as (Float32Array | null)[];
  }

  if (mode === 'local' || mode === 'auto') {
    try {
      await ensureEngineLoaded();
      const vecs = await getEngine().embedBatch(missingTexts);
      for (let j = 0; j < missingIndices.length; j++) {
        const v = vecs[j];
        if (v) cacheEmbedding(missingTexts[j], v);
        results[missingIndices[j]] = v;
      }
      return results as (Float32Array | null)[];
    } catch {
      // Local failed; fall through to generateEmbeddingDirect
    }
  }

  for (let j = 0; j < missingIndices.length; j++) {
    results[missingIndices[j]] = await generateEmbeddingDirect(missingTexts[j]);
  }
  return results as (Float32Array | null)[];
}

/** Returns the sticky-failure reason (e.g. 'ERR_DLOPEN_FAILED') if embedding
 *  has been permanently disabled this process, else null. Useful for
 *  surfacing actionable diagnostics in memory-recall code paths so the UI
 *  can degrade gracefully instead of silently returning empty results. */
export function getEmbeddingUnavailableReason(): string | null {
  const mode = getEmbeddingMode();
  if (mode === 'off') return 'configured_off';
  if (mode === 'server') {
    return isServerFallbackUnavailable() ? (getServerFallbackDisableReason() ?? 'server_unavailable') : null;
  }
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
  const mode = getEmbeddingMode();
  if (mode === 'off') {
    return { state: 'unavailable', reason: 'configured_off' };
  }
  if (mode === 'server') {
    if (isServerFallbackUnavailable()) {
      return { state: 'unavailable', reason: getServerFallbackDisableReason() ?? 'server_unavailable' };
    }
    return { state: 'fallback', reason: 'configured_server_offload' };
  }

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
 *   1. In-process LRU cache hit (0ms).
 *   2. In-flight promise deduplication.
 *   3. If non-daemon process: delegate to daemon hook RPC to reuse the daemon's
 *      single shared engine without spawning separate worker processes.
 *   4. Direct generation via server offload or local engine.
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  if (!isMemoryDaemonEnabled()) return null;
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const inFlight = inFlightEmbeddings.get(text);
  if (inFlight) return await inFlight;

  // In non-daemon helper processes (e.g. context-store-worker or memory mcp),
  // reuse the daemon's shared embedding service instead of spawning separate workers.
  const delegated = await tryDaemonEmbedding(text);
  if (delegated !== undefined) {
    return delegated;
  }

  return await generateEmbeddingDirect(text);
}

/**
 * Generate embeddings for multiple texts in batch.
 * More efficient than calling generateEmbedding() in a loop.
 */
export async function generateEmbeddings(texts: string[]): Promise<(Float32Array | null)[]> {
  if (texts.length === 0) return [];
  if (!isMemoryDaemonEnabled()) return texts.map(() => null);

  const results: (Float32Array | null | undefined)[] = texts.map((t) => embeddingCache.get(t));
  const missingIndices: number[] = [];
  const missingTexts: string[] = [];

  for (let i = 0; i < texts.length; i++) {
    if (results[i] === undefined) {
      missingIndices.push(i);
      missingTexts.push(texts[i]);
    }
  }

  if (missingTexts.length === 0) {
    return results as (Float32Array | null)[];
  }

  // In non-daemon helper processes, delegate batch to daemon hook RPC
  const delegated = await tryDaemonEmbeddings(missingTexts);
  if (delegated && delegated.length === missingTexts.length) {
    for (let j = 0; j < missingIndices.length; j++) {
      results[missingIndices[j]] = delegated[j];
    }
    return results as (Float32Array | null)[];
  }

  const direct = await generateEmbeddingsDirect(missingTexts);
  for (let j = 0; j < missingIndices.length; j++) {
    results[missingIndices[j]] = direct[j];
  }
  return results as (Float32Array | null)[];
}

/**
 * Check if the embedding model is available (loaded or loadable).
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  if (!isMemoryDaemonEnabled()) return false;
  const mode = getEmbeddingMode();
  if (mode === 'off') return false;

  if (mode === 'server') {
    if (isServerFallbackUnavailable()) return false;
    return await isServerFallbackReady();
  }

  try {
    await ensureEngineLoaded();
    return true;
  } catch {
    if (unavailable && !isServerFallbackUnavailable()) {
      return await isServerFallbackReady();
    }
    return false;
  }
}
