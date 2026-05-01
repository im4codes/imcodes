/**
 * Regression tests for the sticky-disable behavior in embedding.ts.
 *
 * Pins two production failure modes that previously turned every memory
 * recall into a hot-loop of failed dlopen attempts:
 *
 *   1. ERR_MODULE_NOT_FOUND — @huggingface/transformers (an optional dep)
 *      not installed. Pre-fix: warn once, then re-attempt the dynamic
 *      import on every embedding call. Post-fix: sticky-disable, throw
 *      cleanly thereafter.
 *
 *   2. ERR_DLOPEN_FAILED — onnxruntime-node's native binding can't load.
 *      The pinned 1.20.1 prebuild covers AVX2+ CPUs (Haswell 2013+), but
 *      machines older than that, or Windows boxes where DirectML.dll has
 *      been stripped and System32's copy is ABI-incompatible, will hit
 *      ERR_DLOPEN_FAILED. Pre-fix: every embedding call retried the import,
 *      hammered DllMain, and re-emitted the warn line forever. Post-fix:
 *      sticky-disable so the next call short-circuits with a clean error.
 *
 * The test exercises the gate via a mocked `@huggingface/transformers`
 * import so we can deterministically inject the failure code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pipelineFactory: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  // The dynamic `await import('@huggingface/transformers')` in embedding.ts
  // pulls these named exports. By default the mock returns a working
  // pipeline; individual tests override pipelineFactory to throw.
  pipeline: (...args: unknown[]) => mocks.pipelineFactory(...args),
  env: { cacheDir: undefined } as { cacheDir: string | undefined },
}));

// Mock the server-fallback module so the test exercises ONLY the local
// sticky-disable path. Without this, generateEmbedding's catch block
// falls through to `tryServerEmbedding`, which on a bound dev machine
// reads ~/.imcodes/server.json and POSTs to the real bound server —
// returning a real Float32Array and breaking the "expected null" assertion.
//
// We mark the fallback as already-unavailable so generateEmbedding's
// `if (isServerFallbackUnavailable()) return null` short-circuit fires
// and we never try a network call.
vi.mock('../../src/context/embedding-server-fallback.js', () => ({
  isServerFallbackUnavailable: () => true,
  tryServerEmbedding: vi.fn(async () => null),
  getServerFallbackDisableReason: () => 'mocked_off',
  _resetServerFallbackStateForTests: vi.fn(),
}));

// embedding.ts is module-scoped state; we need a clean slate per test.
import {
  _resetEmbeddingStateForTests,
  generateEmbedding,
  getEmbeddingUnavailableReason,
  isEmbeddingAvailable,
} from '../../src/context/embedding.js';

beforeEach(() => {
  _resetEmbeddingStateForTests();
  mocks.pipelineFactory.mockReset();
});

afterEach(() => {
  _resetEmbeddingStateForTests();
});

describe('embedding sticky-disable behavior', () => {
  it('sticky-disables after ERR_DLOPEN_FAILED and skips re-import on subsequent calls', async () => {
    // Reproduce the production scenario: the bundled onnxruntime.dll fails
    // to initialize its DllMain (pre-1.20.1 pin: AVX-512 missing on
    // Broadwell-EP; post-pin: a future native-binding regression). Pre-fix
    // every generateEmbedding() call burned CPU re-running the import.
    const dlopenError = Object.assign(new Error('A dynamic link library (DLL) initialization routine failed.'), {
      code: 'ERR_DLOPEN_FAILED',
    });
    mocks.pipelineFactory.mockRejectedValue(dlopenError);

    const first = await generateEmbedding('hello');
    expect(first).toBeNull();
    expect(mocks.pipelineFactory).toHaveBeenCalledTimes(1);

    // Reason exposed for observability (UI can show "your CPU is too old").
    expect(getEmbeddingUnavailableReason()).toBe('ERR_DLOPEN_FAILED');

    // Second call must NOT touch the import again — sticky-disabled.
    const second = await generateEmbedding('world');
    expect(second).toBeNull();
    expect(mocks.pipelineFactory).toHaveBeenCalledTimes(1);

    // Third call from a different code path (isEmbeddingAvailable) also
    // short-circuits cleanly to false without re-attempting.
    const available = await isEmbeddingAvailable();
    expect(available).toBe(false);
    expect(mocks.pipelineFactory).toHaveBeenCalledTimes(1);
  });

  it('sticky-disables after ERR_MODULE_NOT_FOUND (transformers package missing)', async () => {
    const missingError = Object.assign(new Error("Cannot find package '@huggingface/transformers'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    mocks.pipelineFactory.mockRejectedValue(missingError);

    expect(await generateEmbedding('hello')).toBeNull();
    expect(await generateEmbedding('world')).toBeNull();
    expect(await generateEmbedding('foo')).toBeNull();

    // One pipelineFactory call total — second/third short-circuited.
    expect(mocks.pipelineFactory).toHaveBeenCalledTimes(1);
    expect(getEmbeddingUnavailableReason()).toBe('ERR_MODULE_NOT_FOUND');
  });

  it("does NOT sticky-disable on transient errors (e.g. network OOM during model download)", async () => {
    // Transient errors must keep the retry path alive — a temporary blip
    // (network timeout, OOM during weight download) should not permanently
    // kill semantic search for the rest of the daemon's lifetime.
    const transientError = new Error('fetch failed: ECONNRESET');
    mocks.pipelineFactory.mockRejectedValueOnce(transientError);

    expect(await generateEmbedding('hello')).toBeNull();
    expect(getEmbeddingUnavailableReason()).toBeNull(); // NOT sticky

    // Subsequent call DOES retry the import — pipelineFactory is called
    // again. (Our second mock resolves successfully so the embedding is
    // produced.)
    const fakeVec = new Float32Array(384).fill(0.1);
    mocks.pipelineFactory.mockResolvedValueOnce(async (_text: string) => ({ data: fakeVec }));

    const second = await generateEmbedding('world');
    // Note: the second call's `pipeline()` mock resolves to a function that
    // is then invoked by embedding.ts to produce the embedding. Whether it
    // actually returns fakeVec depends on the real code path — what we
    // care about for the regression test is that retry happened at all.
    expect(mocks.pipelineFactory).toHaveBeenCalledTimes(2);
    // Sticky flag still NOT set — transient blips don't kill recall.
    expect(getEmbeddingUnavailableReason()).toBeNull();
    // Either succeeded or failed transiently — both fine, just not sticky.
    void second;
  });

  it("isEmbeddingAvailable returns false cleanly when sticky-disabled", async () => {
    const dlopenError = Object.assign(new Error('dlopen failed'), { code: 'ERR_DLOPEN_FAILED' });
    mocks.pipelineFactory.mockRejectedValue(dlopenError);

    // First call sticky-disables.
    await generateEmbedding('hello');
    expect(getEmbeddingUnavailableReason()).toBe('ERR_DLOPEN_FAILED');

    // isEmbeddingAvailable() must NOT throw — it must catch the disabled
    // state and return false. Memory-recall code paths use this as a
    // pre-flight check before deciding whether to compute embeddings.
    await expect(isEmbeddingAvailable()).resolves.toBe(false);
  });
});
