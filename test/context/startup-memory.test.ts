import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectStartupMemoryItems } from '../../src/context/startup-memory.js';
import { writeProcessedProjection } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('startup memory selection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('startup-memory');
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('backfills with recent summaries up to the total limit when durable memory is sparse', () => {
    const now = Date.now();
    const namespace = {
      scope: 'personal' as const,
      projectId: 'github.com/acme/startup-fill',
    };

    for (let i = 0; i < 3; i++) {
      writeProcessedProjection({
        namespace,
        class: 'durable_memory_candidate',
        sourceEventIds: [`evt-durable-${i}`],
        summary: `Durable ${i}`,
        content: { durable: true },
        createdAt: now - 10_000 - i,
        updatedAt: now - 9_000 - i,
      });
    }
    for (let i = 0; i < 20; i++) {
      writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: [`evt-recent-${i}`],
        summary: `Recent ${i}`,
        content: { recent: true },
        createdAt: now - i,
        updatedAt: now - i,
      });
    }

    const items = selectStartupMemoryItems(namespace);

    expect(items).toHaveLength(15);
    expect(items.filter((item) => item.projectionClass === 'durable_memory_candidate')).toHaveLength(3);
    expect(items.filter((item) => item.projectionClass === 'recent_summary')).toHaveLength(12);
    expect(items.slice(0, 3).every((item) => item.projectionClass === 'durable_memory_candidate')).toBe(true);
  });

  it('keeps both durable and recent startup memories even when they share source events', () => {
    const now = Date.now();
    const namespace = {
      scope: 'personal' as const,
      projectId: 'github.com/acme/startup-dedupe',
    };

    writeProcessedProjection({
      namespace,
      class: 'durable_memory_candidate',
      sourceEventIds: ['evt-shared'],
      summary: 'Durable architecture decision',
      content: { durable: true },
      createdAt: now - 100,
      updatedAt: now - 100,
    });
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-shared'],
      summary: 'Recent summary for the same source events',
      content: { recent: true },
      createdAt: now - 50,
      updatedAt: now - 50,
    });
    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-other'],
      summary: 'Recent summary for other work',
      content: { recent: true },
      createdAt: now - 10,
      updatedAt: now - 10,
    });

    const items = selectStartupMemoryItems(namespace);

    expect(items).toHaveLength(3);
    expect(items[0]?.summary).toBe('Durable architecture decision');
    expect(items.slice(1).map((item) => item.summary)).toEqual([
      'Recent summary for other work',
      'Recent summary for the same source events',
    ]);
  });
});
