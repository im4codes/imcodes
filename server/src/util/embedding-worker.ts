/**
 * Embedding worker — runs `@huggingface/transformers` in a separate
 * `worker_threads` worker so model load (~1.4 s first time) and inference
 * (~5 ms per call) never block the server's main event loop.
 *
 * Protocol (kept tiny, structured-clone-friendly):
 *
 *   parent → worker:
 *     { id, type: 'embed', text: string }
 *
 *   worker → parent:
 *     { id, type: 'result', embedding: Float32Array }
 *     { id, type: 'error',  code: string | null, message: string }
 *
 * The worker lazy-loads the pipeline on first request; subsequent requests
 * reuse the pipeline. Permanent failures (native binding load failure,
 * @huggingface/transformers missing) propagate to the parent which marks
 * the pool unavailable and falls back accordingly.
 *
 * No heartbeats, no graceful shutdown beyond `process.exit(0)` on signal —
 * the parent owns lifecycle.
 */

import { parentPort } from 'node:worker_threads';
import {
  EMBEDDING_DIM,
  EMBEDDING_DTYPE,
  EMBEDDING_MODEL,
} from '../../../shared/embedding-config.js';

if (!parentPort) {
  // Loaded directly (not as a worker) — abort. Importing this file from a
  // unit test should never happen; tests should drive the pool with a mock
  // Worker. If a contributor hits this, the message tells them why.
  throw new Error('embedding-worker: must be spawned via worker_threads');
}

const port = parentPort;

type EmbedRequest = { id: number; type: 'embed'; text: string };
type EmbedResult = { id: number; type: 'result'; embedding: Float32Array };
type EmbedError = { id: number; type: 'error'; code: string | null; message: string };
type WorkerResponse = EmbedResult | EmbedError;

let pipelineInstance: ((text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>) | null = null;
let loadingPromise: Promise<typeof pipelineInstance> | null = null;

function resolveCacheDir(): string {
  return process.env.IMCODES_EMBEDDING_CACHE_DIR?.trim() || '';
}

async function getPipeline(): Promise<NonNullable<typeof pipelineInstance>> {
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise) {
    const inst = await loadingPromise;
    if (!inst) throw new Error('embedding pipeline failed to load');
    return inst;
  }

  loadingPromise = (async () => {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      const cacheDir = resolveCacheDir();
      if (cacheDir) env.cacheDir = cacheDir;
      const p = await pipeline('feature-extraction', EMBEDDING_MODEL, {
        dtype: EMBEDDING_DTYPE,
      }) as unknown as NonNullable<typeof pipelineInstance>;
      pipelineInstance = p;
      return p;
    } catch (err) {
      // Reset loading state so subsequent calls can retry transient
      // failures (network, OOM during model download). Deterministic
      // failures (MODULE_NOT_FOUND, ERR_DLOPEN_FAILED) will fail again
      // on retry — the pool is responsible for sticky-disabling.
      loadingPromise = null;
      throw err;
    }
  })();

  const inst = await loadingPromise;
  if (!inst) throw new Error('embedding pipeline failed to load');
  return inst;
}

async function handleEmbed(req: EmbedRequest): Promise<WorkerResponse> {
  try {
    const pipe = await getPipeline();
    const result = await pipe(req.text, { pooling: 'mean', normalize: true });
    if (!(result.data instanceof Float32Array) || result.data.length !== EMBEDDING_DIM) {
      return {
        id: req.id,
        type: 'error',
        code: 'INVALID_OUTPUT',
        message: `expected Float32Array(${EMBEDDING_DIM}), got ${typeof result.data}`,
      };
    }
    // Copy out to a fresh Float32Array — `result.data` may share its
    // underlying ArrayBuffer with subsequent calls and structured-clone
    // would otherwise transfer a stale view.
    const embedding = new Float32Array(result.data.length);
    embedding.set(result.data);
    return { id: req.id, type: 'result', embedding };
  } catch (err: unknown) {
    const code = (err && typeof err === 'object' && 'code' in err) ? String((err as { code: unknown }).code) : null;
    const message = err instanceof Error ? err.message : String(err);
    return { id: req.id, type: 'error', code, message };
  }
}

port.on('message', async (msg: unknown) => {
  if (!msg || typeof msg !== 'object') return;
  const req = msg as EmbedRequest;
  if (req.type !== 'embed' || typeof req.id !== 'number' || typeof req.text !== 'string') {
    // Malformed message — silently drop. Pool relies on per-request
    // timeout to unblock callers when this happens.
    return;
  }
  const response = await handleEmbed(req);
  port.postMessage(response);
});

// Clean exit on parent disconnect — the worker has no other reason to live.
port.on('close', () => process.exit(0));
