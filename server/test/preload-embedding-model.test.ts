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
});
