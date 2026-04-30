import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';
import { getProcessedProjectionById, listProjectionSources, queryProcessedProjections, resetContextStoreForTests, writeProcessedProjection } from '../../src/store/context-store.js';

const namespace = { scope: 'personal' as const, projectId: 'repo', userId: 'user-1' };

describe('atomic projection dedup merge', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await createIsolatedSharedContextDb('dedup-merge'); });
  afterEach(async () => { resetContextStoreForTests(); await cleanupIsolatedSharedContextDb(tempDir); });

  it('keeps a stable id and merges source ids beyond the legacy 50-row scan window', () => {
    const first = writeProcessedProjection({ namespace, class: 'recent_summary', sourceEventIds: ['evt-a'], summary: 'Same normalized summary', content: { n: 1 } });
    for (let i = 0; i < 60; i++) {
      writeProcessedProjection({ namespace, class: 'recent_summary', sourceEventIds: [`filler-${i}`], summary: `different summary ${i}`, content: {} });
    }
    const second = writeProcessedProjection({ namespace, class: 'recent_summary', sourceEventIds: ['evt-b'], summary: 'Same normalized summary', content: { n: 2 } });
    expect(second.id).toBe(first.id);
    expect(second.sourceEventIds).toEqual(['evt-a', 'evt-b']);
    expect(listProjectionSources(first.id).map((row) => row.eventId)).toEqual(['evt-a', 'evt-b']);
    const rows = queryProcessedProjections({ projectionClass: 'recent_summary', includeArchived: true, limit: 100 });
    expect(rows.filter((row) => row.summary === 'Same normalized summary')).toHaveLength(1);
  });

  it('serializes parallel callers into one row with merged provenance', async () => {
    const writes = Array.from({ length: 8 }, (_, i) => Promise.resolve().then(() => writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: [`evt-${i}`],
      summary: 'Concurrent summary',
      content: { i },
    })));
    const results = await Promise.all(writes);
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    const final = queryProcessedProjections({ projectionClass: 'recent_summary', includeArchived: true, query: 'Concurrent summary', limit: 10 })[0];
    expect(final.sourceEventIds.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `evt-${i}`).sort());
  });

  it('keeps source JSON and reverse index synchronized after capped merges', () => {
    const firstIds = Array.from({ length: 220 }, (_, i) => `evt-a-${i}`);
    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: firstIds,
      summary: 'Capped provenance summary',
      content: { n: 1 },
    });
    expect(projection.sourceEventIds).toHaveLength(200);

    const updated = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: Array.from({ length: 30 }, (_, i) => `evt-b-${i}`),
      summary: 'Capped provenance summary',
      content: { n: 2 },
    });

    expect(updated.id).toBe(projection.id);
    expect(updated.sourceEventIds).toHaveLength(200);
    expect(updated.sourceEventIds).toContain('evt-a-20');
    expect(updated.sourceEventIds).not.toContain('evt-a-30');
    expect(updated.sourceEventIds).toContain('evt-b-29');
    expect(listProjectionSources(updated.id).map((row) => row.eventId)).toEqual(updated.sourceEventIds);
    expect(getProcessedProjectionById(updated.id)?.sourceEventIds).toEqual(updated.sourceEventIds);
  });
});
