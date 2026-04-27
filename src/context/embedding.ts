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

// Lazy-loaded pipeline singleton
let pipelineInstance: any = null;
let loadingPromise: Promise<any> | null = null;
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

async function getPipeline(): Promise<any> {
  if (pipelineInstance) return pipelineInstance;
  if (unavailable) throw new Error(`embedding model unavailable (${unavailableReason ?? 'unknown'})`);
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      const cacheDir = resolveEmbeddingCacheDir();
      if (cacheDir) env.cacheDir = cacheDir;
      logger.info({ model: EMBEDDING_MODEL, dtype: EMBEDDING_DTYPE, cacheDir: env.cacheDir }, 'Loading embedding model...');
      const p = await pipeline('feature-extraction', EMBEDDING_MODEL, {
        dtype: EMBEDDING_DTYPE,
      });
      logger.info({ model: EMBEDDING_MODEL, dim: EMBEDDING_DIM }, 'Embedding model loaded');
      pipelineInstance = p;
      return p;
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
  pipelineInstance = null;
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
 * Generate a normalized embedding vector for a text string.
 * Returns a Float32Array of EMBEDDING_DIM dimensions, or null if model unavailable.
 */
export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  try {
    const pipe = await getPipeline();
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    return result.data as Float32Array;
  } catch {
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
    const pipe = await getPipeline();
    const results: (Float32Array | null)[] = [];
    for (const text of texts) {
      try {
        const result = await pipe(text, { pooling: 'mean', normalize: true });
        results.push(result.data as Float32Array);
      } catch {
        results.push(null);
      }
    }
    return results;
  } catch {
    return texts.map(() => null);
  }
}

/**
 * Check if the embedding model is available (loaded or loadable).
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  try {
    await getPipeline();
    return true;
  } catch {
    return false;
  }
}
