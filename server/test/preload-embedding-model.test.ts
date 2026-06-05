import { afterEach, describe, expect, it, vi } from 'vitest';

const CONFIG_SOURCE = `
export const EMBEDDING_MODEL = 'test/model';
export const EMBEDDING_DTYPE = 'q8';
`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DTYPE;
  delete process.env.IMCODES_EMBEDDING_PRELOAD_ATTEMPTS;
  delete process.env.IMCODES_EMBEDDING_PRELOAD_RETRY_DELAY_MS;
  delete process.env.IMCODES_EMBEDDING_PRELOAD_SOFT_FAIL;
});

describe('preload-embedding-model resolveEmbeddingConfig', () => {
  it('reads config from repo layout when available', async () => {
    const readFile = vi.fn(async () => CONFIG_SOURCE);
    vi.doMock('node:fs/promises', () => ({ readFile }));

    const mod = await import('../scripts/preload-embedding-model.mjs');
    await expect(mod.resolveEmbeddingConfig()).resolves.toEqual({ model: 'test/model', dtype: 'q8' });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(String(readFile.mock.calls[0]?.[0])).toContain('/shared/embedding-config.ts');
  });

  it('falls back to docker layout when repo-relative path is missing', async () => {
    const readFile = vi.fn(async () => {
      if (readFile.mock.calls.length === 1) {
        const error = new Error('missing');
        Object.assign(error, { code: 'ENOENT' });
        throw error;
      }
      return CONFIG_SOURCE;
    });
    vi.doMock('node:fs/promises', () => ({ readFile }));

    const mod = await import('../scripts/preload-embedding-model.mjs');
    await expect(mod.resolveEmbeddingConfig()).resolves.toEqual({ model: 'test/model', dtype: 'q8' });
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it('parses retry configuration from environment', async () => {
    process.env.IMCODES_EMBEDDING_PRELOAD_ATTEMPTS = '5';
    process.env.IMCODES_EMBEDDING_PRELOAD_RETRY_DELAY_MS = '7';
    process.env.IMCODES_EMBEDDING_PRELOAD_SOFT_FAIL = 'true';

    const mod = await import('../scripts/preload-embedding-model.mjs');
    expect(mod.resolvePreloadRetryConfig()).toEqual({
      attempts: 5,
      retryDelayMs: 7,
      softFail: true,
    });
  });

  it('retries transient preload failures before succeeding', async () => {
    process.env.EMBEDDING_MODEL = 'test/model';
    process.env.EMBEDDING_DTYPE = 'q8';
    const pipeline = vi
      .fn()
      .mockRejectedValueOnce(new Error('gateway timeout'))
      .mockResolvedValueOnce({});
    const logger = { log: vi.fn(), warn: vi.fn() };

    const mod = await import('../scripts/preload-embedding-model.mjs');
    await expect(mod.preloadEmbeddingModel({
      importTransformers: async () => ({ pipeline, env: {} }),
      logger,
      retryConfig: { attempts: 2, retryDelayMs: 0, softFail: false },
    })).resolves.toBe(true);

    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('soft-fails after all preload attempts fail', async () => {
    process.env.EMBEDDING_MODEL = 'test/model';
    process.env.EMBEDDING_DTYPE = 'q8';
    const pipeline = vi.fn().mockRejectedValue(new Error('gateway timeout'));
    const logger = { log: vi.fn(), warn: vi.fn() };

    const mod = await import('../scripts/preload-embedding-model.mjs');
    await expect(mod.preloadEmbeddingModel({
      importTransformers: async () => ({ pipeline, env: {} }),
      logger,
      retryConfig: { attempts: 2, retryDelayMs: 0, softFail: true },
    })).resolves.toBe(false);

    expect(pipeline).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
