import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeProjectionContentHash } from '../../shared/memory-content-hash.js';
import { queryProcessedProjections, recordMemoryHits, writeProcessedProjection } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('persistent memory citation drift content_hash', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('memory-citation-drift');
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('stores canonical content_hash on projection writes and keeps metadata-only hits from changing it', () => {
    const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/repo', userId: 'user-1' };
    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'Remember retry policy',
      content: {
        z: 2,
        a: 1,
        ownerUserId: 'user-1',
        createdByUserId: 'user-1',
        updatedByUserId: 'user-2',
      },
      createdAt: 100,
      updatedAt: 100,
    });
    const expected = computeProjectionContentHash({
      summary: 'Remember retry policy',
      content: { a: 1, z: 2 },
    });

    expect(projection.contentHash).toBe(expected);
    recordMemoryHits([projection.id, projection.id]);

    const [afterHits] = queryProcessedProjections({ projectId: namespace.projectId, limit: 1 });
    expect(afterHits?.contentHash).toBe(expected);
    expect(afterHits?.hitCount).toBe(2);
  });

  it('changes content_hash only when normalized projection content changes', () => {
    const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/repo', userId: 'user-1' };
    const first = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'Stable summary',
      content: { value: 'one' },
      createdAt: 100,
      updatedAt: 100,
    });
    const replay = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-2'],
      summary: 'Stable summary',
      content: { value: 'one' },
      createdAt: 200,
      updatedAt: 200,
    });
    const changed = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-3'],
      summary: 'Stable summary',
      content: { value: 'two' },
      createdAt: 300,
      updatedAt: 300,
    });

    expect(replay.id).toBe(first.id);
    expect(replay.contentHash).toBe(first.contentHash);
    expect(changed.id).toBe(first.id);
    expect(changed.contentHash).not.toBe(first.contentHash);
  });
});
