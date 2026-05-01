/**
 * Tests for `getEmbeddingStatus()` — the synchronous status snapshot the
 * daemon broadcasts in every `daemon.stats` heartbeat. The web UI maps
 * this struct directly to a status icon + tooltip, so the wire-format
 * states must be stable and the no-side-effect contract must hold even
 * when the local pipeline has never been touched.
 *
 * The mock @huggingface/transformers seam is the same as
 * `embedding-sticky.test.ts` — keep them in sync.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pipelineFactory: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => mocks.pipelineFactory(...args),
  env: { cacheDir: undefined } as { cacheDir: string | undefined },
}));

vi.mock('../../src/bind/bind-flow.js', () => ({
  loadCredentials: vi.fn(),
}));

import { loadCredentials } from '../../src/bind/bind-flow.js';
const loadCredentialsMock = loadCredentials as unknown as ReturnType<typeof vi.fn>;

import {
  _resetEmbeddingStateForTests,
  generateEmbedding,
  getEmbeddingStatus,
} from '../../src/context/embedding.js';
import {
  _resetServerFallbackStateForTests,
} from '../../src/context/embedding-server-fallback.js';

beforeEach(() => {
  _resetEmbeddingStateForTests();
  _resetServerFallbackStateForTests();
  mocks.pipelineFactory.mockReset();
  loadCredentialsMock.mockReset();
  loadCredentialsMock.mockResolvedValue(null); // default: not bound
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getEmbeddingStatus — initial state', () => {
  it('reports `idle` before any embedding has been requested', () => {
    expect(getEmbeddingStatus()).toEqual({ state: 'idle', reason: null });
  });

  it('does NOT trigger pipeline load (zero side effects on the heartbeat path)', () => {
    void getEmbeddingStatus();
    void getEmbeddingStatus();
    void getEmbeddingStatus();
    expect(mocks.pipelineFactory).not.toHaveBeenCalled();
  });
});

describe('getEmbeddingStatus — happy path', () => {
  it('reports `ready` once the pipeline has loaded successfully', async () => {
    const fakePipe = vi.fn(async () => ({ data: new Float32Array(384) }));
    mocks.pipelineFactory.mockResolvedValue(fakePipe);
    await generateEmbedding('warm');
    expect(getEmbeddingStatus()).toEqual({ state: 'ready', reason: null });
  });

  it('stays `ready` across many subsequent calls (no flapping back to loading/idle)', async () => {
    const fakePipe = vi.fn(async () => ({ data: new Float32Array(384) }));
    mocks.pipelineFactory.mockResolvedValue(fakePipe);
    await generateEmbedding('warm');
    for (let i = 0; i < 5; i++) {
      await generateEmbedding('hello ' + i);
      expect(getEmbeddingStatus().state).toBe('ready');
    }
  });
});

describe('getEmbeddingStatus — local sticky-disabled', () => {
  it('reports `unavailable` with the local reason when local AND server fallback are both dead', async () => {
    // Local: deterministic MODULE_NOT_FOUND (sticky)
    const err = Object.assign(new Error('Cannot find module @huggingface/transformers'), { code: 'MODULE_NOT_FOUND' });
    mocks.pipelineFactory.mockRejectedValue(err);

    await generateEmbedding('hi'); // trips sticky-disable on local
    // Server fallback also unavailable: bind-flow mock returns null →
    // tryServerEmbedding sticky-disables with reason 'not_bound'. Trigger it
    // by attempting a fallback path through generateEmbedding once more.
    await generateEmbedding('again'); // local sticky → falls through to server → not_bound

    const status = getEmbeddingStatus();
    expect(status.state).toBe('unavailable');
    expect(status.reason).toBe('MODULE_NOT_FOUND');
  });

  it('reports `fallback` with the local reason when local is dead but server fallback is still eligible', async () => {
    // Local: deterministic ERR_DLOPEN_FAILED (sticky)
    const err = Object.assign(new Error('dlopen failed'), { code: 'ERR_DLOPEN_FAILED' });
    mocks.pipelineFactory.mockRejectedValue(err);

    // Bound credentials present + transient network failure on fetch →
    // server fallback returns null but does NOT sticky-disable (transient
    // policy). This is the realistic mid-recall state we want to surface
    // as yellow ⚠️ rather than red ✗.
    loadCredentialsMock.mockResolvedValue({
      serverId: 'srv-1', token: 'tok', workerUrl: 'https://example.com',
    });
    const fakeFetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
    // We can't intercept fetch through generateEmbedding directly, so just
    // call the server-fallback path inside the daemon's logic by triggering
    // a recall — generateEmbedding's fallback uses the global fetch.
    vi.stubGlobal('fetch', fakeFetch);

    await generateEmbedding('hi');

    const status = getEmbeddingStatus();
    expect(status.state).toBe('fallback');
    expect(status.reason).toBe('ERR_DLOPEN_FAILED');

    vi.unstubAllGlobals();
  });

  it('does not include a reason in the `idle` or `ready` state', () => {
    expect(getEmbeddingStatus()).toEqual({ state: 'idle', reason: null });
  });
});
