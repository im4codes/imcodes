import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STARTUP_BOOTSTRAP_SOURCES,
  STARTUP_MEMORY_STAGES,
  buildStartupBootstrapSelection,
  selectStartupMemoryByPolicy,
  selectStartupMemoryItems,
} from '../../src/context/startup-memory.js';
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

  it('uses named collect/prioritize/quota/trim/dedup/render stages for bounded startup policy', () => {
    const report = selectStartupMemoryByPolicy([
      { id: 'recent-1', source: 'recent', text: 'drop first under pressure', estimatedTokens: 6, updatedAt: 30 },
      { id: 'durable-1', source: 'durable', text: 'keep durable', estimatedTokens: 4, updatedAt: 10 },
      { id: 'pinned-1', source: 'pinned', text: 'keep pinned verbatim', estimatedTokens: 4, updatedAt: 1 },
      { id: 'durable-dup', source: 'durable', text: 'KEEP DURABLE', estimatedTokens: 4, updatedAt: 20 },
      { id: 'project-doc', source: 'project_docs', text: 'keep docs', estimatedTokens: 2, updatedAt: 5 },
    ], {
      totalTokens: 10,
      pinnedTokens: 10,
      durableTokens: 10,
      recentTokens: 10,
      projectDocsTokens: 10,
      skillTokens: 10,
    });

    expect(report.stages).toEqual(STARTUP_MEMORY_STAGES);
    expect(report.bootstrapSources).toEqual(STARTUP_BOOTSTRAP_SOURCES);
    expect(report.selected.map((item) => item.id)).toEqual(['pinned-1', 'durable-dup', 'project-doc']);
    expect(report.usedTokens).toBe(10);
    expect(report.dropped).toEqual([
      { id: 'durable-1', source: 'durable', reason: 'duplicate' },
      { id: 'recent-1', source: 'recent', reason: 'total_budget' },
    ]);
  });

  it('unifies startup memory, preferences, project/user context, and skills through the same named-stage bootstrap', () => {
    const report = buildStartupBootstrapSelection({
      recent: [{ id: 'recent', text: 'recent turn', estimatedTokens: 2 }],
      durable: [{ id: 'durable', text: 'durable fact', estimatedTokens: 2 }],
      projectContext: [{ id: 'project-doc', text: 'project convention', estimatedTokens: 2 }],
      userContext: [{ id: 'user-context', text: 'user context', estimatedTokens: 2 }],
      preferences: [{ id: 'pref', text: 'Use pnpm', estimatedTokens: 2 }],
      skills: [{ id: 'skill', text: 'Test first', estimatedTokens: 2 }],
    }, {
      totalTokens: 20,
      pinnedTokens: 20,
      durableTokens: 20,
      recentTokens: 20,
      projectDocsTokens: 20,
      skillTokens: 20,
    });

    expect(report.stages).toEqual(STARTUP_MEMORY_STAGES);
    expect(report.bootstrapSources).toEqual([
      'startup_memory',
      'preferences',
      'project_context',
      'user_context',
      'skills',
    ]);
    expect(report.selected.map((item) => `${item.source}:${item.id}`)).toEqual([
      'skill:skill',
      'preference:pref',
      'user_context:user-context',
      'durable:durable',
      'project_docs:project-doc',
      'recent:recent',
    ]);
  });

  it('omits a failing or over-budget source without changing ordinary startup compatibility', () => {
    const report = selectStartupMemoryByPolicy([
      { id: 'durable-1', source: 'durable', text: 'durable', estimatedTokens: 3 },
      { id: 'recent-too-large', source: 'recent', text: 'recent', estimatedTokens: 20 },
      { id: 'skill-too-large', source: 'skill', text: 'skill', estimatedTokens: 20 },
    ], {
      totalTokens: 20,
      durableTokens: 10,
      recentTokens: 5,
      skillTokens: 5,
      pinnedTokens: 10,
      projectDocsTokens: 10,
    });

    expect(report.selected.map((item) => item.id)).toEqual(['durable-1']);
    expect(report.dropped).toEqual([
      { id: 'skill-too-large', source: 'skill', reason: 'source_quota' },
      { id: 'recent-too-large', source: 'recent', reason: 'source_quota' },
    ]);
  });
});
