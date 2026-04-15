import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextNamespace, ContextTargetRef } from '../../shared/context-types.js';
import { searchLocalMemory, formatSearchResults, type MemorySearchResult } from '../../src/context/memory-search.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('memory-search output formats', () => {
  let tempDir: string;
  let namespace: ContextNamespace;
  let target: ContextTargetRef;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('memory-search-formats');
    namespace = { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' };
    target = { namespace, kind: 'session', sessionName: 'deck_repo_brain' };
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  function seedMemory(): MemorySearchResult {
    const coordinator = new MaterializationCoordinator({
      thresholds: { eventCount: 99, idleMs: 50, scheduleMs: 200 },
    });
    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'fix the flaky CI test', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.text', content: 'added utimes call to set correct mtime', createdAt: 101 });
    coordinator.ingestEvent({ target, eventType: 'decision', content: 'use HFS+ mtime workaround on macOS', createdAt: 102 });
    coordinator.materializeTarget(target, 'manual', 500);
    return searchLocalMemory({});
  }

  describe('JSON format', () => {
    it('produces valid JSON with items and stats', () => {
      const result = seedMemory();
      const json = formatSearchResults(result, 'json');
      const parsed = JSON.parse(json);
      expect(parsed.items).toBeInstanceOf(Array);
      expect(parsed.items.length).toBeGreaterThan(0);
      expect(parsed.stats).toBeDefined();
      expect(typeof parsed.stats.totalRecords).toBe('number');
      expect(typeof parsed.stats.matchedRecords).toBe('number');
      expect(typeof parsed.stats.recentSummaryCount).toBe('number');
      expect(typeof parsed.stats.durableCandidateCount).toBe('number');
      expect(typeof parsed.stats.projectCount).toBe('number');
    });

    it('includes all fields in each item', () => {
      const result = seedMemory();
      const parsed = JSON.parse(formatSearchResults(result, 'json'));
      const item = parsed.items[0];
      expect(item.type).toBeDefined();
      expect(item.id).toBeDefined();
      expect(item.projectId).toBeDefined();
      expect(item.scope).toBeDefined();
      expect(item.summary).toBeDefined();
      expect(typeof item.createdAt).toBe('number');
    });
  });

  describe('document format', () => {
    it('produces Markdown with header and items', () => {
      const result = seedMemory();
      const doc = formatSearchResults(result, 'document');
      expect(doc).toContain('# Memory Search Results');
      expect(doc).toContain('github.com/acme/repo');
      expect(doc).toContain('---');
    });

    it('includes match count and class in Markdown', () => {
      const result = seedMemory();
      const doc = formatSearchResults(result, 'document');
      expect(doc).toMatch(/\d+ matches/);
      expect(doc).toContain('**Type:**');
      expect(doc).toContain('**Class:**');
      expect(doc).toContain('**Date:**');
    });
  });

  describe('table format', () => {
    it('produces table with header and data rows', () => {
      const result = seedMemory();
      const table = formatSearchResults(result, 'table');
      expect(table).toContain('TYPE');
      expect(table).toContain('CLASS');
      expect(table).toContain('PROJECT');
      expect(table).toContain('processed');
      expect(table).toContain('github.com/acme/repo');
    });

    it('shows summary stats in first line', () => {
      const result = seedMemory();
      const table = formatSearchResults(result, 'table');
      const firstLine = table.split('\n')[0];
      expect(firstLine).toContain('Matched:');
      expect(firstLine).toContain('Total:');
      expect(firstLine).toContain('Summaries:');
      expect(firstLine).toContain('Durable:');
      expect(firstLine).toContain('Projects:');
    });
  });

  describe('empty results', () => {
    it('JSON returns empty items array', () => {
      const result = searchLocalMemory({ query: 'nonexistent-query-xyz' });
      const parsed = JSON.parse(formatSearchResults(result, 'json'));
      expect(parsed.items).toEqual([]);
      expect(parsed.stats.totalRecords).toBe(0);
    });

    it('document returns header with zero matches', () => {
      const result = searchLocalMemory({ query: 'nonexistent-query-xyz' });
      const doc = formatSearchResults(result, 'document');
      expect(doc).toContain('# Memory Search Results');
      expect(doc).toContain('0 matches');
    });

    it('table returns header with zero counts', () => {
      const result = searchLocalMemory({ query: 'nonexistent-query-xyz' });
      const table = formatSearchResults(result, 'table');
      expect(table).toContain('Matched: 0');
    });
  });
});
