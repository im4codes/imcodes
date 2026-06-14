/**
 * Embedding inference worker.
 *
 * transformers.js (onnxruntime-node) does its model LOAD and feature-extraction
 * inference as synchronous native CPU work. Running it on the daemon main thread
 * froze the event loop for tens of seconds on session-heavy / loaded hosts (211:
 * event-loop drift up to 52s), which starved the server-link heartbeat and drove
 * a reconnect storm. This worker moves that CPU off the main thread; the host
 * (`embedding.ts`) talks to it over a tiny request/response protocol and keeps
 * all the sticky-failure / server-fallback / status policy.
 *
 * Protocol: host posts { id, type, payload }, worker replies
 *   { id, ok: true, result } | { id, ok: false, error, code }.
 * Embedding vectors are returned as Float32Array and transferred (zero-copy).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { EMBEDDING_MODEL, EMBEDDING_DTYPE } from '../../shared/embedding-config.js';

export type EmbeddingWorkerRequest =
  | { id: number; type: 'warmup' }
  | { id: number; type: 'embed'; text: string }
  | { id: number; type: 'embedBatch'; texts: string[] };

export type EmbeddingWorkerResponse =
  | { id: number; ok: true; result: true | Float32Array | (Float32Array | null)[] }
  | { id: number; ok: false; error: string; code: string | null };

const port = parentPort;
if (!port) throw new Error('embedding-worker must run as a worker thread');

let pipelineInstance: ((text: string, opts: unknown) => Promise<{ data: ArrayLike<number> }>) | null = null;
let loadingPromise: Promise<typeof pipelineInstance> | null = null;

async function getPipeline(): Promise<NonNullable<typeof pipelineInstance>> {
  if (pipelineInstance) return pipelineInstance;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      const cacheDir = typeof workerData?.cacheDir === 'string' ? workerData.cacheDir : '';
      if (cacheDir) env.cacheDir = cacheDir;
      const p = await pipeline('feature-extraction', EMBEDDING_MODEL, {
        dtype: EMBEDDING_DTYPE,
        // Cap onnxruntime's native thread pools (one is ample for this tiny
        // 384-dim q8 MiniLM). Mirrors the in-process engine and keeps the
        // per-thread glibc-arena memory multiplier off this worker too.
        session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
      });
      pipelineInstance = p as unknown as typeof pipelineInstance;
      return pipelineInstance;
    })().catch((err) => {
      loadingPromise = null;
      throw err;
    });
  }
  const loaded = await loadingPromise;
  if (!loaded) throw new Error('embedding pipeline unavailable');
  return loaded;
}

function toFloat32(data: ArrayLike<number>): Float32Array {
  return data instanceof Float32Array ? data : Float32Array.from(data);
}

async function embedOne(text: string): Promise<Float32Array> {
  const pipe = await getPipeline();
  const result = await pipe(text, { pooling: 'mean', normalize: true });
  return toFloat32(result.data);
}

port.on('message', async (msg: EmbeddingWorkerRequest) => {
  try {
    if (msg.type === 'warmup') {
      await getPipeline();
      port.postMessage({ id: msg.id, ok: true, result: true } satisfies EmbeddingWorkerResponse);
      return;
    }
    if (msg.type === 'embed') {
      const vec = await embedOne(msg.text);
      port.postMessage({ id: msg.id, ok: true, result: vec } satisfies EmbeddingWorkerResponse, [vec.buffer as ArrayBuffer]);
      return;
    }
    if (msg.type === 'embedBatch') {
      // Load once up front: a load failure must fail the whole batch (so the
      // host can apply its sticky/fallback policy), but a per-text inference
      // failure only nulls that entry.
      await getPipeline();
      const out: (Float32Array | null)[] = [];
      for (const text of msg.texts) {
        try { out.push(await embedOne(text)); } catch { out.push(null); }
      }
      const transfer = out.filter((v): v is Float32Array => v !== null).map((v) => v.buffer as ArrayBuffer);
      port.postMessage({ id: msg.id, ok: true, result: out } satisfies EmbeddingWorkerResponse, transfer);
      return;
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? null;
    const error = err instanceof Error ? err.message : String(err);
    port.postMessage({ id: (msg as { id: number }).id, ok: false, error, code } satisfies EmbeddingWorkerResponse);
  }
});
