import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getProcessedProjectionStats,
  listMemoryProjectSummaries,
  queryProcessedProjections,
  resetContextStoreForTests,
  writeProcessedProjection,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

describe('context-store panel query performance', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('context-store-panel-performance');
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('keeps stats, recent records and project summaries bounded at 100k rows', () => {
    const now = Date.now();
    writeProcessedProjection({
      id: 'seed-panel-row',
      namespace: { scope: 'personal', userId: 'panel-user', projectId: 'project-0' },
      class: 'recent_summary',
      sourceEventIds: [],
      summary: 'seed row',
      content: {},
      createdAt: now,
      updatedAt: now,
    });

    // Insert a production-shaped large table in one transaction.  The base
    // implementation selected and iterated every row for each panel query;
    // the aggregate/ORDER BY/LIMIT implementation remains bounded.
    const database = new DatabaseSync(join(tempDir, 'context.sqlite'));
    database.exec('BEGIN');
    const insert = database.prepare(`
      INSERT INTO context_processed_local (
        id, namespace_key, scope, user_id, project_id, class,
        source_event_ids_json, summary, content_json, created_at, updated_at,
        status, is_noise
      ) VALUES (?, ?, 'personal', 'panel-user', ?, ?, '[]', ?, '{}', ?, ?, 'active', 0)
    `);
    for (let index = 0; index < 100_000; index += 1) {
      const projectId = `project-${index % 200}`;
      const projectionClass = index % 3 === 0 ? 'durable_memory_candidate' : 'recent_summary';
      insert.run(
        `panel-row-${index}`,
        `personal::::panel-user:${projectId}`,
        projectId,
        projectionClass,
        `panel summary ${index}`,
        now - index,
        now - index,
      );
    }
    database.exec('COMMIT');
    database.close();

    const started = performance.now();
    const stats = getProcessedProjectionStats({ scope: 'personal', userId: 'panel-user' });
    const records = queryProcessedProjections({ scope: 'personal', userId: 'panel-user', limit: 50 });
    const projects = listMemoryProjectSummaries({ scope: 'personal', userId: 'panel-user' });
    const elapsedMs = performance.now() - started;

    expect(stats.totalRecords).toBe(100_001);
    expect(records).toHaveLength(50);
    expect(projects.length).toBeLessThanOrEqual(200);
    expect(elapsedMs).toBeLessThan(300);
    resetContextStoreForTests();
  });
});
