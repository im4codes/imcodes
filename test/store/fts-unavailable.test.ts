import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';
import { getCounter, resetMetricsForTests } from '../../src/util/metrics.js';
import { resetRateLimitedWarnForTests } from '../../src/util/rate-limited-warn.js';
import {
  archiveEventsForMaterialization,
  getArchivedEvent,
  getContextMeta,
  recordContextEvent,
  resetContextStoreForTests,
  searchArchiveFts,
  setContextMeta,
} from '../../src/store/context-store.js';

/**
 * Regression for the production crash where Node 23.11.0's bundled SQLite
 * shipped without FTS5 compiled in. The previously-installed `imcodes`
 * called `setupArchiveFts()` unconditionally; the unhandled SQLite error
 * propagated out of `ensureDb()`, throwing the daemon into "degraded
 * state with no server connection" — exactly the symptom the user
 * patched in the installed dist.
 *
 * The source-side fix:
 *   1. Probe FTS5 up front; record `fts_tokenizer = 'unavailable'` and
 *      skip the virtual table + triggers when missing.
 *   2. Outer try-catch at the call site so any unforeseen exception
 *      cannot kill `ensureDb()`.
 *   3. `searchArchiveFts` fast-paths to LIKE when the sentinel is set.
 *
 * We can't actually unload FTS5 from the host SQLite at test time, so
 * these tests simulate the unavailable state by writing the sentinel
 * directly into context_meta and asserting:
 *   - Subsequent archive writes succeed (no "no such table" from triggers).
 *   - `searchArchiveFts` does not increment the FTS match-failure counter
 *     (the LIKE fast-path is taken).
 *   - The LIKE fallback returns the expected hit so the read-tool still
 *     produces honest results.
 */

const namespace = { scope: 'personal' as const, projectId: 'repo', userId: 'user-1' };
const target = { namespace, kind: 'session' as const, sessionName: 'deck_repo_brain' };

describe('FTS5 unavailable host (regression: Node 23.11.0 SQLite without FTS5)', () => {
  let tempDir: string;

  beforeEach(async () => {
    resetMetricsForTests();
    resetRateLimitedWarnForTests();
    tempDir = await createIsolatedSharedContextDb('fts-unavailable');
  });

  afterEach(async () => {
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('with fts_tokenizer="unavailable", archive writes succeed (no trigger crash)', () => {
    // Force the runtime into the "FTS unavailable" state. In production this
    // is set by `setupArchiveFts` after the probe fails.
    setContextMeta('fts_tokenizer', 'unavailable');
    expect(getContextMeta('fts_tokenizer')).toBe('unavailable');

    const event = recordContextEvent({
      id: 'evt-no-fts-1',
      target,
      eventType: 'assistant.text',
      content: 'archive must work without FTS5 support',
      createdAt: 100,
    });
    // Pre-fix this would throw "no such table: context_event_archive_fts"
    // if the AFTER INSERT trigger had been installed.
    expect(() => archiveEventsForMaterialization([event], 200)).not.toThrow();
    expect(getArchivedEvent('evt-no-fts-1')?.content).toBe('archive must work without FTS5 support');
  });

  it('searchArchiveFts fast-paths to LIKE without spamming match-failure counter', () => {
    setContextMeta('fts_tokenizer', 'unavailable');
    const event = recordContextEvent({
      id: 'evt-no-fts-2',
      target,
      eventType: 'user.message',
      content: 'looking for a needle in this content',
      createdAt: 100,
    });
    archiveEventsForMaterialization([event], 200);

    const results = searchArchiveFts('needle', 10, { namespace, userId: namespace.userId });
    expect(results.map((r) => r.id)).toEqual(['evt-no-fts-2']);

    // The fast path must NOT exercise the FTS prepare path, so no failure
    // counter increment per call.
    expect(getCounter('mem.archive_fts.match_failure', { source: 'searchArchiveFts' })).toBe(0);
  });



  it('fallback search treats percent and underscore as literal query characters', () => {
    setContextMeta('fts_tokenizer', 'unavailable');
    const literal = recordContextEvent({
      id: 'evt-like-literal',
      target,
      eventType: 'assistant.text',
      content: 'literal wildcard tokens 100%_done are searchable',
      createdAt: 100,
    });
    const broad = recordContextEvent({
      id: 'evt-like-broad',
      target,
      eventType: 'assistant.text',
      content: 'this row should not match a literal percent underscore query',
      createdAt: 101,
    });
    archiveEventsForMaterialization([literal, broad], 200);

    expect(searchArchiveFts('100%_done', 10, { namespace, userId: namespace.userId }).map((r) => r.id)).toEqual(['evt-like-literal']);
  });

  it('blank query still returns [] under the unavailable sentinel', () => {
    setContextMeta('fts_tokenizer', 'unavailable');
    expect(searchArchiveFts('   ', 10, { namespace, userId: namespace.userId })).toEqual([]);
  });
});
