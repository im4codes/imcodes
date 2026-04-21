import { describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.js';
import { purgeRemoteMemoryNoiseProjections } from '../src/util/memory-noise-cleanup.js';

describe('purgeRemoteMemoryNoiseProjections', () => {
  it('deletes noisy remote projections and their embeddings', async () => {
    const executeCalls: Array<{ sql: string; params: unknown[] }> = [];
    const db: Database = {
      query: async () => [
        { id: 'good-1', summary: 'Useful summary' },
        { id: 'bad-1', summary: '**Assistant:** [API Error: Connection error. (cause: fetch failed)]' },
      ],
      queryOne: async () => null,
      execute: async (sql: string, params: unknown[] = []) => {
        executeCalls.push({ sql, params });
        return { changes: 1 };
      },
      exec: async () => {},
      close: async () => {},
    } as unknown as Database;

    await expect(purgeRemoteMemoryNoiseProjections(db)).resolves.toBe(1);
    expect(executeCalls).toEqual([
      expect.objectContaining({
        sql: expect.stringContaining('DELETE FROM shared_context_embeddings'),
        params: ['bad-1'],
      }),
      expect.objectContaining({
        sql: expect.stringContaining('DELETE FROM shared_context_projections'),
        params: ['bad-1'],
      }),
    ]);
  });
});
