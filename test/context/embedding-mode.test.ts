import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIM } from '../../shared/embedding-config.js';

const mocks = vi.hoisted(() => ({
  pipelineFactory: vi.fn(),
  loadCredentials: vi.fn(),
}));

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => mocks.pipelineFactory(...args),
  env: { cacheDir: undefined } as { cacheDir: string | undefined },
}));

vi.mock('../../src/bind/bind-flow.js', () => ({
  loadCredentials: (...args: unknown[]) => mocks.loadCredentials(...args),
}));

import {
  _resetEmbeddingStateForTests,
  __setEmbeddingModeForTests,
  generateEmbedding,
  generateEmbeddings,
  getEmbeddingMode,
  getEmbeddingStatus,
  getEmbeddingUnavailableReason,
  isEmbeddingAvailable,
} from '../../src/context/embedding.js';
import { _resetServerFallbackStateForTests } from '../../src/context/embedding-server-fallback.js';

describe('Embedding Modes and Offloading', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.IMCODES_EMBEDDING_MODE;
    delete process.env.IMCODES_DISABLE_LOCAL_EMBEDDING;
    delete process.env.IMCODES_EMBEDDING_DISABLED;
    _resetEmbeddingStateForTests();
    _resetServerFallbackStateForTests();
    mocks.pipelineFactory.mockReset();
    mocks.loadCredentials.mockReset();
    mocks.loadCredentials.mockResolvedValue(null);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('getEmbeddingMode resolution', () => {
    it('defaults to auto when unset', () => {
      expect(getEmbeddingMode()).toBe('auto');
    });

    it('resolves server mode from IMCODES_EMBEDDING_MODE', () => {
      process.env.IMCODES_EMBEDDING_MODE = 'server';
      expect(getEmbeddingMode()).toBe('server');
      process.env.IMCODES_EMBEDDING_MODE = '  SERVER ';
      expect(getEmbeddingMode()).toBe('server');
      process.env.IMCODES_EMBEDDING_MODE = 'remote';
      expect(getEmbeddingMode()).toBe('server');
    });

    it('resolves off mode from IMCODES_EMBEDDING_MODE or IMCODES_EMBEDDING_DISABLED', () => {
      process.env.IMCODES_EMBEDDING_MODE = 'off';
      expect(getEmbeddingMode()).toBe('off');
      process.env.IMCODES_EMBEDDING_MODE = 'disabled';
      expect(getEmbeddingMode()).toBe('off');
      process.env.IMCODES_EMBEDDING_MODE = 'none';
      expect(getEmbeddingMode()).toBe('off');

      delete process.env.IMCODES_EMBEDDING_MODE;
      process.env.IMCODES_EMBEDDING_DISABLED = '1';
      expect(getEmbeddingMode()).toBe('off');
    });

    it('resolves server mode from IMCODES_DISABLE_LOCAL_EMBEDDING', () => {
      process.env.IMCODES_DISABLE_LOCAL_EMBEDDING = '1';
      expect(getEmbeddingMode()).toBe('server');
    });

    it('allows test override via __setEmbeddingModeForTests', () => {
      process.env.IMCODES_EMBEDDING_MODE = 'server';
      __setEmbeddingModeForTests('off');
      expect(getEmbeddingMode()).toBe('off');
    });
  });

  describe('Mode "off"', () => {
    beforeEach(() => {
      __setEmbeddingModeForTests('off');
    });

    it('generateEmbedding returns null immediately without touching local engine', async () => {
      const result = await generateEmbedding('test query');
      expect(result).toBeNull();
      expect(mocks.pipelineFactory).not.toHaveBeenCalled();
    });

    it('generateEmbeddings returns array of nulls', async () => {
      const results = await generateEmbeddings(['one', 'two']);
      expect(results).toEqual([null, null]);
      expect(mocks.pipelineFactory).not.toHaveBeenCalled();
    });

    it('isEmbeddingAvailable returns false', async () => {
      const available = await isEmbeddingAvailable();
      expect(available).toBe(false);
      expect(mocks.pipelineFactory).not.toHaveBeenCalled();
    });

    it('getEmbeddingStatus returns state unavailable with reason configured_off', () => {
      const status = getEmbeddingStatus();
      expect(status).toEqual({ state: 'unavailable', reason: 'configured_off' });
      expect(getEmbeddingUnavailableReason()).toBe('configured_off');
    });
  });

  describe('Mode "server"', () => {
    beforeEach(() => {
      __setEmbeddingModeForTests('server');
    });

    it('generateEmbedding bypasses local pipeline and uses server fallback endpoint', async () => {
      mocks.loadCredentials.mockResolvedValue({
        serverId: 'srv-1',
        token: 'tok-123',
        workerUrl: 'https://api.example.com',
      });

      const fakeVector = new Array(EMBEDDING_DIM).fill(0.123);
      const fakeFetch = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, embedding: fakeVector, dim: EMBEDDING_DIM }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fakeFetch);

      const result = await generateEmbedding('hello world');
      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(Float32Array);
      expect(result?.length).toBe(EMBEDDING_DIM);

      // Local transformers pipeline was never initialized
      expect(mocks.pipelineFactory).not.toHaveBeenCalled();

      // Fetched from server
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      const call = fakeFetch.mock.calls[0];
      expect(call[0]).toBe('https://api.example.com/api/embedding');

      vi.unstubAllGlobals();
    });

    it('isEmbeddingAvailable returns true when server credentials exist', async () => {
      mocks.loadCredentials.mockResolvedValue({
        serverId: 'srv-1',
        token: 'tok-123',
        workerUrl: 'https://api.example.com',
      });

      expect(await isEmbeddingAvailable()).toBe(true);
      expect(mocks.pipelineFactory).not.toHaveBeenCalled();
    });

    it('isEmbeddingAvailable returns false when server credentials do not exist', async () => {
      mocks.loadCredentials.mockResolvedValue(null);

      expect(await isEmbeddingAvailable()).toBe(false);
      expect(mocks.pipelineFactory).not.toHaveBeenCalled();
    });

    it('getEmbeddingStatus reports fallback state with configured_server_offload', () => {
      const status = getEmbeddingStatus();
      expect(status).toEqual({ state: 'fallback', reason: 'configured_server_offload' });
      expect(mocks.pipelineFactory).not.toHaveBeenCalled();
    });

    it('generateEmbeddings returns server embeddings sequentially without loading local engine', async () => {
      mocks.loadCredentials.mockResolvedValue({
        serverId: 'srv-1',
        token: 'tok-123',
        workerUrl: 'https://api.example.com',
      });

      const fakeVector = new Array(EMBEDDING_DIM).fill(0.456);
      const fakeFetch = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, embedding: fakeVector, dim: EMBEDDING_DIM }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      vi.stubGlobal('fetch', fakeFetch);

      const results = await generateEmbeddings(['text a', 'text b']);
      expect(results.length).toBe(2);
      expect(results[0]).toBeInstanceOf(Float32Array);
      expect(results[1]).toBeInstanceOf(Float32Array);
      expect(fakeFetch).toHaveBeenCalledTimes(2);
      expect(mocks.pipelineFactory).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });
  });

  describe('Reuse: Caching and In-flight Deduplication', () => {
    it('caches calculated vectors in LRU cache and reuses on subsequent calls', async () => {
      const fakePipe = vi.fn(async () => ({ data: new Float32Array(EMBEDDING_DIM) }));
      mocks.pipelineFactory.mockResolvedValue(fakePipe);

      const v1 = await generateEmbedding('reuse me');
      const v2 = await generateEmbedding('reuse me');

      expect(v1).toBeDefined();
      expect(v2).toBe(v1); // exact same cached Float32Array instance
      expect(mocks.pipelineFactory).toHaveBeenCalledTimes(1);
      expect(fakePipe).toHaveBeenCalledTimes(1); // inference executed only ONCE
    });

    it('deduplicates concurrent in-flight embedding requests for identical text', async () => {
      let resolvePipe: (v: unknown) => void = () => {};
      const pendingPromise = new Promise((resolve) => {
        resolvePipe = resolve;
      });
      const fakePipe = vi.fn(async () => {
        await pendingPromise;
        return { data: new Float32Array(EMBEDDING_DIM) };
      });
      mocks.pipelineFactory.mockResolvedValue(fakePipe);

      const p1 = generateEmbedding('concurrent query');
      const p2 = generateEmbedding('concurrent query');

      resolvePipe(null);
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBeDefined();
      expect(r2).toBe(r1);
      expect(fakePipe).toHaveBeenCalledTimes(1);
    });

    it('generateEmbeddings reuses cached vectors and only computes missing ones', async () => {
      const fakePipe = vi.fn(async (t: string) => ({ data: new Float32Array(EMBEDDING_DIM).fill(t.length) }));
      mocks.pipelineFactory.mockResolvedValue(fakePipe);

      const v1 = await generateEmbedding('apple');
      expect(fakePipe).toHaveBeenCalledTimes(1);

      const list = await generateEmbeddings(['apple', 'banana']);
      expect(list[0]).toBe(v1);
      expect(list[1]).toBeDefined();
      expect(fakePipe).toHaveBeenCalledTimes(2); // Only 'banana' was computed!
    });
  });
});
