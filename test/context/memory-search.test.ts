import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { searchLocalMemory, formatSearchResults } from '../../src/context/memory-search.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
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

  it('searches processed projections by text query', () => {
    const coordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'fix the download button', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'removed stale constants', createdAt: 101 });
    coordinator.materializeTarget(target, 'manual', 500);

    const result = searchLocalMemory({ query: 'download' });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].type).toBe('processed');
    expect(result.items[0].summary).toContain('download');
    expect(result.stats.totalRecords).toBeGreaterThan(0);
  });

  it('filters by repo', () => {
    const coordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'something', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'done', createdAt: 101 });
    coordinator.materializeTarget(target, 'manual', 500);

    const matchResult = searchLocalMemory({ repo: 'github.com/acme/repo' });
    expect(matchResult.items.length).toBeGreaterThan(0);

    const noMatchResult = searchLocalMemory({ repo: 'github.com/other/repo' });
    expect(noMatchResult.items).toHaveLength(0);
  });

  it('includes raw events when includeRaw is set', () => {
    const coordinator = new MaterializationCoordinator({
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

  it('formats results as JSON', () => {
    const coordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'test', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'done', createdAt: 101 });
    coordinator.materializeTarget(target, 'manual', 500);

    const result = searchLocalMemory({});
    const json = formatSearchResults(result, 'json');
    const parsed = JSON.parse(json);
    expect(parsed.items).toBeDefined();
    expect(parsed.stats).toBeDefined();
    expect(parsed.stats.totalRecords).toBeGreaterThan(0);
  });

  it('formats results as Markdown document', () => {
    const coordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'deploy fix', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'deployed', createdAt: 101 });
    coordinator.materializeTarget(target, 'manual', 500);

    const result = searchLocalMemory({});
    const doc = formatSearchResults(result, 'document');
    expect(doc).toContain('# Memory Search Results');
    expect(doc).toContain('github.com/acme/repo');
    expect(doc).toContain('deploy');
  });

  it('formats results as table', () => {
    const coordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'test', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'done', createdAt: 101 });
    coordinator.materializeTarget(target, 'manual', 500);

    const result = searchLocalMemory({});
    const table = formatSearchResults(result, 'table');
    expect(table).toContain('TYPE');
    expect(table).toContain('processed');
    expect(table).toContain('recent_summary');
  });

  it('applies pagination with limit and offset', () => {
    const coordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    // Create 3 materializations
    for (let i = 0; i < 3; i++) {
      coordinator.ingestEvent({ target, eventType: 'user.turn', content: `task ${i}`, createdAt: i * 100 });
      coordinator.ingestEvent({ target, eventType: 'assistant.text', content: `done ${i}`, createdAt: i * 100 + 1 });
      coordinator.materializeTarget(target, 'manual', i * 100 + 50);
    }

    const page1 = searchLocalMemory({ limit: 2, offset: 0 });
    expect(page1.items).toHaveLength(2);
    expect(page1.stats.matchedRecords).toBeGreaterThanOrEqual(3);

    const page2 = searchLocalMemory({ limit: 2, offset: 2 });
    expect(page2.items.length).toBeGreaterThanOrEqual(1);
  });
});
