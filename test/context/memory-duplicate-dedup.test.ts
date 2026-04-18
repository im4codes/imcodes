import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeProcessedProjection, listProcessedProjections } from '../../src/store/context-store.js';
import { searchLocalMemory, dedupByNormalizedSummary, type MemorySearchResultItem } from '../../src/context/memory-search.js';
import { selectStartupMemoryItems } from '../../src/context/startup-memory.js';
import {
  cleanupIsolatedSharedContextDb,
  createIsolatedSharedContextDb,
} from '../util/shared-context-db.js';

// These tests pin the three-layer duplicate-memory fix: store-time reuse,
// recall-time normalized-summary dedup, and startup-memory fingerprint dedup.
// They are the regression guard for the user-visible "three identical
// Related-history cards with the same 0.529 score" symptom.
describe('processed-projection duplicate defenses', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('memory-dup');
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  describe('writeProcessedProjection — store-time reuse', () => {
    it('reuses the same row id for byte-identical summaries in the same namespace and class', () => {
      const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/dup-store' };
      const summary = 'Key decisions: Docker caching fix — pin HF transformers version.';

      const first = writeProcessedProjection({
        namespace,
        class: 'durable_memory_candidate',
        sourceEventIds: ['evt-1'],
        summary,
        content: { turn: 1 },
      });
      const second = writeProcessedProjection({
        namespace,
        class: 'durable_memory_candidate',
        sourceEventIds: ['evt-2'],
        summary,
        content: { turn: 2 },
      });

      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
      const rows = listProcessedProjections(namespace, 'durable_memory_candidate');
      expect(rows).toHaveLength(1);
    });

    it('collapses summaries that differ only in whitespace or case', () => {
      const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/dup-store-ws' };
      const base = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-base'],
        summary: 'Key Decisions: docker caching fix',
        content: {},
      });
      const withExtraSpace = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-ws'],
        summary: '  Key    Decisions: docker caching fix  ',
        content: {},
      });
      const withDifferentCase = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-case'],
        summary: 'KEY DECISIONS: Docker Caching Fix',
        content: {},
      });

      expect(withExtraSpace.id).toBe(base.id);
      expect(withDifferentCase.id).toBe(base.id);
      const rows = listProcessedProjections(namespace, 'recent_summary');
      expect(rows).toHaveLength(1);
    });

    it('does not cross-collapse across projection classes', () => {
      const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/dup-class-split' };
      const recent = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-a'],
        summary: 'same text',
        content: {},
      });
      const durable = writeProcessedProjection({
        namespace,
        class: 'durable_memory_candidate',
        sourceEventIds: ['evt-b'],
        summary: 'same text',
        content: {},
      });
      expect(durable.id).not.toBe(recent.id);
    });

    it('does not cross-collapse across namespaces', () => {
      const projectA = { scope: 'personal' as const, projectId: 'github.com/acme/a' };
      const projectB = { scope: 'personal' as const, projectId: 'github.com/acme/b' };
      const first = writeProcessedProjection({
        namespace: projectA,
        class: 'recent_summary',
        sourceEventIds: ['evt-a'],
        summary: 'same summary different project',
        content: {},
      });
      const second = writeProcessedProjection({
        namespace: projectB,
        class: 'recent_summary',
        sourceEventIds: ['evt-b'],
        summary: 'same summary different project',
        content: {},
      });
      expect(second.id).not.toBe(first.id);
    });

    it('still honors an explicit id from replication (never collapses remote rows)', () => {
      const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/replicated' };
      const local = writeProcessedProjection({
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-local'],
        summary: 'replicated summary',
        content: {},
      });
      const remote = writeProcessedProjection({
        id: 'remote-uuid-abc',
        namespace,
        class: 'recent_summary',
        sourceEventIds: ['evt-remote'],
        summary: 'replicated summary',
        content: {},
      });
      expect(remote.id).toBe('remote-uuid-abc');
      expect(remote.id).not.toBe(local.id);
    });
  });

  describe('dedupByNormalizedSummary — recall-time defense', () => {
    const makeItem = (overrides: Partial<MemorySearchResultItem>): MemorySearchResultItem => ({
      id: overrides.id ?? 'id',
      type: 'processed',
      summary: overrides.summary ?? '',
      projectId: overrides.projectId,
      projectionClass: overrides.projectionClass ?? 'recent_summary',
      createdAt: overrides.createdAt ?? 0,
      updatedAt: overrides.updatedAt ?? 0,
      ...overrides,
    } as MemorySearchResultItem);

    it('collapses distinct-id items that share a normalized summary, keeping the first-seen (highest-score) one', () => {
      const scored = [
        { item: makeItem({ id: 'a', summary: 'Key decisions: Docker caching' }), score: 0.9 },
        { item: makeItem({ id: 'b', summary: 'key decisions:   docker caching' }), score: 0.8 },
        { item: makeItem({ id: 'c', summary: 'Key decisions: Docker caching' }), score: 0.7 },
      ];
      const result = dedupByNormalizedSummary(scored);
      expect(result.map((e) => e.item.id)).toEqual(['a']);
    });

    it('keeps items independent when they differ by projection class', () => {
      const scored = [
        { item: makeItem({ id: 'recent', summary: 'plan', projectionClass: 'recent_summary' }), score: 0.9 },
        { item: makeItem({ id: 'durable', summary: 'plan', projectionClass: 'durable_memory_candidate' }), score: 0.85 },
      ];
      const result = dedupByNormalizedSummary(scored);
      expect(result.map((e) => e.item.id).sort()).toEqual(['durable', 'recent']);
    });

    it('passes through items without a summary (no fingerprint available)', () => {
      const scored = [
        { item: makeItem({ id: 'empty-1', summary: '' }), score: 0.5 },
        { item: makeItem({ id: 'empty-2', summary: '' }), score: 0.4 },
      ];
      expect(dedupByNormalizedSummary(scored)).toHaveLength(2);
    });
  });

  describe('selectStartupMemoryItems — dedupes already-stored duplicates on cold start', () => {
    it('surfaces only one card even if replication landed three rows with identical summaries', () => {
      const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/already-dup' };
      const base = Date.now() - 60_000;

      // Simulate three already-stored duplicates from before the store-time
      // dedup landed — three distinct IDs, identical summary. Use explicit id
      // to bypass the reuse path the new writer applies to local writes.
      for (let i = 0; i < 3; i++) {
        writeProcessedProjection({
          id: `pre-existing-${i}`,
          namespace,
          class: 'durable_memory_candidate',
          sourceEventIds: [`evt-${i}`],
          summary: 'Key decisions: Docker caching — pin HF transformers version.',
          content: { turn: i },
          createdAt: base + i,
          updatedAt: base + i,
        });
      }
      const stored = listProcessedProjections(namespace, 'durable_memory_candidate');
      expect(stored).toHaveLength(3);

      const items = selectStartupMemoryItems(namespace);
      const durable = items.filter((item) => item.projectionClass === 'durable_memory_candidate');
      expect(durable).toHaveLength(1);
    });
  });

  describe('searchLocalMemory (non-semantic) — interaction with store-time dedup', () => {
    it('returns a single projection even after many identical summary writes', () => {
      const namespace = { scope: 'personal' as const, projectId: 'github.com/acme/single-recall' };
      const summary = 'Key decisions: fix watcher flake';
      for (let i = 0; i < 5; i++) {
        writeProcessedProjection({
          namespace,
          class: 'recent_summary',
          sourceEventIds: [`evt-${i}`],
          summary,
          content: { turn: i },
        });
      }
      const result = searchLocalMemory({ namespace, projectionClass: 'recent_summary' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].summary).toBe(summary);
    });
  });
});
