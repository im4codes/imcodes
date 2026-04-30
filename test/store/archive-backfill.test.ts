import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getContextMeta,
  getProcessedProjectionById,
  listProjectionSources,
  resetContextStoreForTests,
  runArchiveBackfillBatch,
} from '../../src/store/context-store.js';
import { serializeContextNamespace } from '../../src/context/context-keys.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const namespaceKey = serializeContextNamespace({ scope: 'personal', userId: 'user-1', projectId: 'repo' });

function insertLegacyProjection(input: {
  id: string;
  sourceIds: string[];
  summary: string;
  updatedAt: number;
}): void {
  const database = new DatabaseSync(process.env.IMCODES_CONTEXT_DB_PATH!);
  database.prepare(`
    INSERT INTO context_processed_local (
      id, namespace_key, class, source_event_ids_json, summary, content_json, created_at, updated_at
    ) VALUES (?, ?, 'recent_summary', ?, ?, '{}', ?, ?)
  `).run(
    input.id,
    namespaceKey,
    JSON.stringify(input.sourceIds),
    input.summary,
    input.updatedAt,
    input.updatedAt,
  );
  database.close();
}

describe('archive/source backfill', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('archive-backfill');
    // Initializes schema without waiting for the background backfill timer.
    expect(getContextMeta('migration_archive_backfilled')).toBeUndefined();
  });

  afterEach(async () => {
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('runs in resumable batches and marks older fingerprint collisions archived', () => {
    insertLegacyProjection({ id: 'legacy-newer', sourceIds: ['evt-newer'], summary: 'same summary', updatedAt: 30 });
    insertLegacyProjection({ id: 'legacy-older', sourceIds: ['evt-older'], summary: 'same summary', updatedAt: 20 });
    insertLegacyProjection({ id: 'legacy-unique', sourceIds: ['evt-unique-a', 'evt-unique-b'], summary: 'unique summary', updatedAt: 10 });

    expect(runArchiveBackfillBatch(2)).toEqual({ processed: 2, done: false });
    expect(getContextMeta('migration_archive_backfilled')).toBeUndefined();
    expect(listProjectionSources('legacy-newer').map((row) => row.eventId)).toEqual(['evt-newer']);
    expect(listProjectionSources('legacy-older').map((row) => row.eventId)).toEqual(['evt-older']);
    expect(getProcessedProjectionById('legacy-newer')?.status).toBe('active');
    expect(getProcessedProjectionById('legacy-older')?.status).toBe('archived_dedup');

    expect(runArchiveBackfillBatch(2)).toEqual({ processed: 1, done: true });
    expect(getContextMeta('migration_archive_backfilled')).toBe('1');
    expect(listProjectionSources('legacy-unique').map((row) => row.eventId)).toEqual(['evt-unique-a', 'evt-unique-b']);
  });
});
