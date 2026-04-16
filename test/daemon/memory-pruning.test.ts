import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import {
  pruneLocalMemory,
  restoreArchivedMemory,
  writeProcessedProjection,
  listProcessedProjections,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('memory-pruning', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let _target: ContextTargetRef;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('memory-pruning');
    namespace = { scope: 'personal', projectId: 'repo', userId: 'user-1' };
    _target = { namespace, kind: 'session', sessionName: 'deck_repo_brain' };
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('archives stale recent_summary with hit_count=0', () => {
    const now = Date.now();
    const staleTime = now - 31 * DAY_MS;

    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'stale summary',
      content: { text: 'old data' },
      createdAt: staleTime,
      updatedAt: staleTime,
    });

    const result = pruneLocalMemory(now);
    expect(result.archived).toBe(1);

    // Verify the projection is no longer returned with default active-only listing
    // (listProcessedProjections returns all statuses, so check the raw DB)
    const all = listProcessedProjections(namespace);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('archived');
  });

  it('keeps stale recent_summary with hit_count>0 active', () => {
    const now = Date.now();
    const staleTime = now - 31 * DAY_MS;

    // Write a projection then simulate a hit by directly updating the DB
    // Since writeProcessedProjection doesn't set hit_count, we need to use the DB
    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-2'],
      summary: 'used summary',
      content: { text: 'used data' },
      createdAt: staleTime,
      updatedAt: staleTime,
    });

    // Manually update hit_count via a raw DB connection
    const db = new DatabaseSync(process.env.IMCODES_CONTEXT_DB_PATH!);
    db.prepare('UPDATE context_processed_local SET hit_count = 5 WHERE id = ?').run(projection.id);
    db.close();

    const result = pruneLocalMemory(now);
    expect(result.archived).toBe(0);

    const all = listProcessedProjections(namespace);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('active');
  });

  it('never auto-archives durable_memory_candidate regardless of hit_count', () => {
    const now = Date.now();
    const staleTime = now - 31 * DAY_MS;

    writeProcessedProjection({
      namespace,
      class: 'durable_memory_candidate',
      sourceEventIds: ['evt-3'],
      summary: 'durable memory',
      content: { text: 'important' },
      createdAt: staleTime,
      updatedAt: staleTime,
    });

    const result = pruneLocalMemory(now);
    expect(result.archived).toBe(0);

    const all = listProcessedProjections(namespace);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('active');
  });

  it('keeps fresh recent_summary active', () => {
    const now = Date.now();
    const freshTime = now - 10 * DAY_MS; // 10 days ago — within 30-day window

    writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-4'],
      summary: 'fresh summary',
      content: { text: 'recent data' },
      createdAt: freshTime,
      updatedAt: freshTime,
    });

    const result = pruneLocalMemory(now);
    expect(result.archived).toBe(0);

    const all = listProcessedProjections(namespace);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('active');
  });

  it('restoreArchivedMemory sets status back to active', () => {
    const now = Date.now();
    const staleTime = now - 31 * DAY_MS;

    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-5'],
      summary: 'archived then restored',
      content: { text: 'revived' },
      createdAt: staleTime,
      updatedAt: staleTime,
    });

    // Archive it
    const pruneResult = pruneLocalMemory(now);
    expect(pruneResult.archived).toBe(1);

    // Restore it
    const restored = restoreArchivedMemory(projection.id);
    expect(restored).toBe(true);

    const all = listProcessedProjections(namespace);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('active');
  });

  it('restoreArchivedMemory returns false for non-archived projection', () => {
    const now = Date.now();

    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-6'],
      summary: 'active projection',
      content: { text: 'still active' },
      createdAt: now,
      updatedAt: now,
    });

    const restored = restoreArchivedMemory(projection.id);
    expect(restored).toBe(false);
  });
});
