import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { searchLocalMemory, searchLocalMemoryAuthorized, formatSearchResults } from '../../src/context/memory-search.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import { localOnlyCompressor } from '../../src/context/summary-compressor.js';
import { writeProcessedProjection } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('memory-search', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let target: ContextTargetRef;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('memory-search');
    namespace = { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' };
    target = { namespace, kind: 'session', sessionName: 'deck_repo_brain' };
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('searches processed projections by text query', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'fix the download button', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'removed stale constants', createdAt: 101 });
    await coordinator.materializeTarget(target, 'manual', 500);

    const result = searchLocalMemory({ query: 'download' });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].type).toBe('processed');
    expect(result.items[0].summary).toContain('download');
    expect(result.stats.totalRecords).toBeGreaterThan(0);
  });

  it('filters by repo', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'something', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'done', createdAt: 101 });
    await coordinator.materializeTarget(target, 'manual', 500);

    const matchResult = searchLocalMemory({ repo: 'github.com/acme/repo' });
    expect(matchResult.items.length).toBeGreaterThan(0);

    const noMatchResult = searchLocalMemory({ repo: 'github.com/other/repo' });
    expect(noMatchResult.items).toHaveLength(0);
  });

  it('filters by full namespace instead of mixing scopes for the same repo', () => {
    writeProcessedProjection({
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' },
      class: 'recent_summary',
      sourceEventIds: ['evt-personal'],
      summary: 'Personal fix',
      content: {},
    });
    writeProcessedProjection({
      namespace: { scope: 'project_shared', projectId: 'github.com/acme/repo', enterpriseId: 'ent-1', workspaceId: 'ws-1' },
      class: 'recent_summary',
      sourceEventIds: ['evt-shared'],
      summary: 'Shared fix',
      content: {},
    });

    const personalResult = searchLocalMemory({
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' },
    });
    const sharedResult = searchLocalMemory({
      namespace: { scope: 'project_shared', projectId: 'github.com/acme/repo', enterpriseId: 'ent-1', workspaceId: 'ws-1' },
    });

    expect(personalResult.items).toHaveLength(1);
    expect(personalResult.items[0]?.summary).toContain('Personal');
    expect(sharedResult.items).toHaveLength(1);
    expect(sharedResult.items[0]?.summary).toContain('Shared');
  });

  it('filters by scope, owner, and repo without requiring an exact namespace object', () => {
    writeProcessedProjection({
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' },
      class: 'recent_summary',
      sourceEventIds: ['evt-personal'],
      summary: 'User one personal memory',
      content: {},
      updatedAt: 400,
    });
    writeProcessedProjection({
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-2' },
      class: 'recent_summary',
      sourceEventIds: ['evt-other-user'],
      summary: 'Other user personal memory',
      content: {},
      updatedAt: 300,
    });
    writeProcessedProjection({
      namespace: { scope: 'user_private', projectId: 'github.com/acme/repo', userId: 'user-1' },
      class: 'recent_summary',
      sourceEventIds: ['evt-user-private'],
      summary: 'User one owner private memory',
      content: {},
      updatedAt: 200,
    });
    writeProcessedProjection({
      namespace: { scope: 'project_shared', projectId: 'github.com/acme/repo', enterpriseId: 'ent-1', workspaceId: 'ws-1' },
      class: 'recent_summary',
      sourceEventIds: ['evt-shared'],
      summary: 'Shared project memory',
      content: {},
      updatedAt: 100,
    });

    const result = searchLocalMemory({
      scope: 'personal',
      userId: 'user-1',
      repo: 'github.com/acme/repo',
    });

    expect(result.items.map((item) => item.summary)).toEqual(['User one personal memory']);
    expect(result.stats.matchedRecords).toBe(1);
  });


  it('management-authorized search excludes other users personal rows before stats and pagination', () => {
    writeProcessedProjection({
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' },
      class: 'recent_summary',
      sourceEventIds: ['evt-user-1'],
      summary: 'User one private memory',
      content: { text: 'secret for user one' },
      updatedAt: 300,
    });
    writeProcessedProjection({
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-2' },
      class: 'recent_summary',
      sourceEventIds: ['evt-user-2'],
      summary: 'User two private memory',
      content: { text: 'secret for user two' },
      updatedAt: 200,
    });
    writeProcessedProjection({
      namespace: { scope: 'project_shared', projectId: 'github.com/acme/repo', enterpriseId: 'ent-1', workspaceId: 'ws-1' },
      class: 'recent_summary',
      sourceEventIds: ['evt-shared'],
      summary: 'Shared project memory',
      content: { text: 'visible to project' },
      updatedAt: 100,
    });

    const result = searchLocalMemoryAuthorized({
      authorizedNamespaces: [
        { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' },
        { scope: 'project_shared', projectId: 'github.com/acme/repo', enterpriseId: 'ent-1', workspaceId: 'ws-1' },
      ],
      limit: 10,
    });

    expect(result.items.map((item) => item.summary)).toEqual([
      'User one private memory',
      'Shared project memory',
    ]);
    expect(result.items.some((item) => item.userId === 'user-2')).toBe(false);
    expect(result.stats.matchedRecords).toBe(2);
    expect(result.stats.recentSummaryCount).toBe(2);
  });

  it('management-authorized search paginates after authorization', () => {
    writeProcessedProjection({
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-2' },
      class: 'recent_summary',
      sourceEventIds: ['evt-other'],
      summary: 'Other user newest private memory',
      content: {},
      updatedAt: 400,
    });
    writeProcessedProjection({
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' },
      class: 'recent_summary',
      sourceEventIds: ['evt-own-a'],
      summary: 'Own first memory',
      content: {},
      updatedAt: 300,
    });
    writeProcessedProjection({
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' },
      class: 'recent_summary',
      sourceEventIds: ['evt-own-b'],
      summary: 'Own second memory',
      content: {},
      updatedAt: 200,
    });

    const result = searchLocalMemoryAuthorized({
      authorizedNamespaces: [{ scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' }],
      limit: 1,
      offset: 1,
    });

    expect(result.items.map((item) => item.summary)).toEqual(['Own second memory']);
    expect(result.stats.matchedRecords).toBe(2);
  });

  it('includes raw events when includeRaw is set', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'investigate', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.delta', content: 'partial', createdAt: 101 });

    const withRaw = searchLocalMemory({ includeRaw: true });
    const rawItems = withRaw.items.filter((i) => i.type === 'raw');
    expect(rawItems.length).toBeGreaterThan(0);

    const withoutRaw = searchLocalMemory({ includeRaw: false });
    const noRaw = withoutRaw.items.filter((i) => i.type === 'raw');
    expect(noRaw).toHaveLength(0);
  });

  it('formats results as JSON', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'test', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'done', createdAt: 101 });
    await coordinator.materializeTarget(target, 'manual', 500);

    const result = searchLocalMemory({});
    const json = formatSearchResults(result, 'json');
    const parsed = JSON.parse(json);
    expect(parsed.items).toBeDefined();
    expect(parsed.stats).toBeDefined();
    expect(parsed.stats.totalRecords).toBeGreaterThan(0);
  });

  it('formats results as Markdown document', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'deploy fix', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'deployed', createdAt: 101 });
    await coordinator.materializeTarget(target, 'manual', 500);

    const result = searchLocalMemory({});
    const doc = formatSearchResults(result, 'document');
    expect(doc).toContain('# Memory Search Results');
    expect(doc).toContain('github.com/acme/repo');
    expect(doc).toContain('deploy');
  });

  it('formats results as table', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'test', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'done', createdAt: 101 });
    await coordinator.materializeTarget(target, 'manual', 500);

    const result = searchLocalMemory({});
    const table = formatSearchResults(result, 'table');
    expect(table).toContain('TYPE');
    expect(table).toContain('processed');
    expect(table).toContain('recent_summary');
  });

  it('applies pagination with limit and offset', async () => {
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    // Create 3 materializations
    for (let i = 0; i < 3; i++) {
      coordinator.ingestEvent({ target, eventType: 'user.turn', content: `task ${i}`, createdAt: i * 100 });
      coordinator.ingestEvent({ target, eventType: 'assistant.text', content: `done ${i}`, createdAt: i * 100 + 1 });
      await coordinator.materializeTarget(target, 'manual', i * 100 + 50);
    }

    const page1 = searchLocalMemory({ limit: 2, offset: 0 });
    expect(page1.items).toHaveLength(2);
    expect(page1.stats.matchedRecords).toBeGreaterThanOrEqual(3);

    const page2 = searchLocalMemory({ limit: 2, offset: 2 });
    expect(page2.items.length).toBeGreaterThanOrEqual(1);
  });
});
