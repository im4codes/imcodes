import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import {
  archiveEventsForMaterialization,
  getArchivedEvent,
  listContextEvents,
  pruneArchive,
  queryProcessedProjections,
  recordContextEvent,
  resetContextStoreForTests,
} from '../../src/store/context-store.js';
import { chatGetEvent, chatSearchFts, memoryGetSources } from '../../src/context/memory-read-tools.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const structuredSummary = [
  '## User Problem',
  'Memory pipeline e2e',
  '',
  '## Resolution',
  'Archived and materialized events',
  '',
  '## Key Decisions',
  '- Preserve raw archive provenance',
  '',
  '## User-Pinned Notes',
  '- e2e invariant',
  '',
  '## Active State',
  'Complete',
  '',
  '## Active Task',
  'None',
  '',
  '## Learned Facts',
  'Memory archive supports round trip',
  '',
  '## State Snapshot',
  'E2E fixture',
  '',
  '## Critical Context',
  'Read tools are owner scoped',
].join('\n');

describe('memory pipeline e2e', () => {
  let tempDbDir: string;
  let configDir: string;
  let configPath: string;
  let namespace: ContextNamespace;
  let target: ContextTargetRef;

  beforeEach(async () => {
    tempDbDir = await createIsolatedSharedContextDb('memory-pipeline-e2e');
    configDir = join(tmpdir(), `imc-memory-e2e-server-${process.pid}-${Math.random().toString(16).slice(2)}`);
    await mkdir(configDir, { recursive: true });
    configPath = join(configDir, 'server.json');
    process.env.IMCODES_SERVER_CONFIG_PATH = configPath;
    await writeFile(configPath, JSON.stringify({ userId: 'bob' }), 'utf8');
    namespace = { scope: 'personal', projectId: 'repo', userId: 'bob' };
    target = { namespace, kind: 'session', sessionName: 'deck_repo_brain' };
  });

  afterEach(async () => {
    delete process.env.IMCODES_SERVER_CONFIG_PATH;
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDbDir);
    await rm(configDir, { recursive: true, force: true });
  });

  it('round-trips ingest, archive, materialize, read tools, dedup merge, sweeper guard, and cross-user rejection', async () => {
    const coordinator = new MaterializationCoordinator({
      compressor: async () => ({ summary: structuredSummary, model: 'fixture', backend: 'fixture', usedBackup: false, fromSdk: true }),
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });

    const original = new Map<string, string>();
    for (let i = 0; i < 12; i += 1) {
      const id = `evt-e2e-${i}`;
      const content = `记忆 pipeline original content ${i}`;
      original.set(id, content);
      coordinator.ingestEvent({ id, target, eventType: i % 2 === 0 ? 'user.message' : 'assistant.text', content, createdAt: 100 + i });
    }

    const first = await coordinator.materializeTarget(target, 'manual', 1000);
    const projection = first.summaryProjection!;
    expect(projection.sourceEventIds).toHaveLength(12);
    expect(listContextEvents(target)).toEqual([]);

    for (const id of projection.sourceEventIds) {
      expect(chatGetEvent(id, { userId: 'bob', namespace })?.content).toBe(original.get(id));
    }
    const sources = memoryGetSources(projection.id, { userId: 'bob', namespace });
    expect(sources.sourceEventCount).toBe(12);
    expect(sources.sources).toHaveLength(12);
    expect(chatSearchFts('记忆', 20, { userId: 'bob', namespace }).map((row) => row.id)).toContain('evt-e2e-0');

    for (let i = 12; i < 16; i += 1) {
      coordinator.ingestEvent({ id: `evt-e2e-${i}`, target, eventType: 'assistant.text', content: `overlap source ${i}`, createdAt: 200 + i });
    }
    const second = await coordinator.materializeTarget(target, 'manual', 2000);
    expect(second.summaryProjection?.id).toBe(projection.id);
    expect(second.summaryProjection?.sourceEventIds).toHaveLength(16);
    expect(queryProcessedProjections({ projectionClass: 'recent_summary', includeArchived: true, limit: 10 })).toHaveLength(1);

    const uncited = recordContextEvent({ id: 'evt-e2e-uncited', target, eventType: 'assistant.text', content: 'uncited old row', createdAt: 50 });
    archiveEventsForMaterialization([uncited], 60);
    const database = new DatabaseSync(process.env.IMCODES_CONTEXT_DB_PATH!);
    database.prepare('UPDATE context_event_archive SET archived_at = ? WHERE id IN (?, ?)').run(1, 'evt-e2e-0', 'evt-e2e-uncited');
    database.close();
    pruneArchive(30, 31 * 86_400_000);
    expect(getArchivedEvent('evt-e2e-0')?.content).toBe(original.get('evt-e2e-0'));
    expect(getArchivedEvent('evt-e2e-uncited')).toBeUndefined();

    expect(() => chatGetEvent('evt-e2e-0', { userId: 'alice', namespace: { ...namespace, userId: 'alice' } })).toThrow(/private|originating|bound/i);
  });
});
