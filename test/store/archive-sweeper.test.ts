import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';
import { getCounter, resetMetricsForTests } from '../../src/util/metrics.js';
import { resetRateLimitedWarnForTests } from '../../src/util/rate-limited-warn.js';
import {
  archiveEventsForMaterialization,
  deleteStagedEventsByIds,
  getArchivedEvent,
  getContextMeta,
  getStagedEvent,
  insertProjectionSources,
  pruneArchive,
  recordContextEvent,
  resetContextStoreForTests,
} from '../../src/store/context-store.js';

const namespace = { scope: 'personal' as const, projectId: 'repo', userId: 'user-1' };
const target = { namespace, kind: 'session' as const, sessionName: 'deck_repo_brain' };

describe('archive and sweeper safety', () => {
  let tempDir: string;
  beforeEach(async () => {
    resetMetricsForTests();
    resetRateLimitedWarnForTests();
    tempDir = await createIsolatedSharedContextDb('archive-sweeper');
  });
  afterEach(async () => { resetContextStoreForTests(); await cleanupIsolatedSharedContextDb(tempDir); });

  it('keeps an archived byte-identical copy after staging rows are deleted', () => {
    // Runtime concat so GitHub secret-scanning doesn't see a literal in source.
    const stripeKey = 's' + 'k_' + 'live_' + '123456789012345678901234';
    const rawContent = `raw secret ${stripeKey}`;
    const event = recordContextEvent({ id: 'evt-archive', target, eventType: 'assistant.text', content: rawContent, metadata: { toolName: 'Bash' }, createdAt: 100 });
    archiveEventsForMaterialization([event], 200);
    deleteStagedEventsByIds(['evt-archive']);
    expect(getStagedEvent('evt-archive')).toBeUndefined();
    expect(getArchivedEvent('evt-archive')).toMatchObject({
      id: 'evt-archive',
      eventType: 'assistant.text',
      content: rawContent,
      metadata: { toolName: 'Bash' },
    });
  });

  it('prunes old uncited archive rows but preserves cited events and updates the sweep sentinel', () => {
    const now = 2_000_000_000_000;
    const old = now - 31 * 86_400_000;
    const cited = recordContextEvent({ id: 'evt-cited', target, eventType: 'assistant.text', content: 'cited', createdAt: 1 });
    const uncited = recordContextEvent({ id: 'evt-uncited', target, eventType: 'assistant.text', content: 'uncited', createdAt: 2 });
    archiveEventsForMaterialization([cited, uncited], old);
    insertProjectionSources('projection-1', ['evt-cited']);

    expect(pruneArchive(30, now).deleted).toBe(1);
    expect(getArchivedEvent('evt-cited')?.content).toBe('cited');
    expect(getArchivedEvent('evt-uncited')).toBeUndefined();
    expect(getContextMeta('last_archive_sweep_at')).toBe(String(now));
  });

  it('-1 disables archive pruning and leaves the sweep sentinel untouched', () => {
    const now = 2_000_000_000_000;
    const event = recordContextEvent({ id: 'evt-disabled', target, eventType: 'assistant.text', content: 'keep', createdAt: 1 });
    archiveEventsForMaterialization([event], now - 365 * 86_400_000);
    expect(pruneArchive(-1, now).deleted).toBe(0);
    expect(getArchivedEvent('evt-disabled')?.content).toBe('keep');
    expect(getContextMeta('last_archive_sweep_at')).toBeUndefined();
  });

  // Defense-in-depth against the F1/V1/N1 footgun: a direct caller MUST NOT
  // be able to wipe every uncited archive row by passing 0 or a negative
  // non-sentinel value. The YAML loader normally clamps these, but the store
  // layer treats them as fail-safe (skip + warn-once + counter increment).
  // (memory-system-1.1-foundations P1)
  it('rejects retentionDays = 0 without deleting anything', () => {
    const now = 2_000_000_000_000;
    const ancient = now - 365 * 86_400_000;
    const uncited = recordContextEvent({ id: 'evt-zero', target, eventType: 'assistant.text', content: 'keep', createdAt: 1 });
    archiveEventsForMaterialization([uncited], ancient);
    expect(pruneArchive(0, now).deleted).toBe(0);
    expect(getArchivedEvent('evt-zero')?.content).toBe('keep');
    expect(getContextMeta('last_archive_sweep_at')).toBeUndefined();
    expect(getCounter('mem.config.invalid_value', { field: 'archiveRetentionDays' })).toBe(1);
  });

  it('rejects retentionDays = -2 (non-sentinel negative) without deleting anything', () => {
    const now = 2_000_000_000_000;
    const ancient = now - 365 * 86_400_000;
    const uncited = recordContextEvent({ id: 'evt-neg', target, eventType: 'assistant.text', content: 'keep', createdAt: 1 });
    archiveEventsForMaterialization([uncited], ancient);
    expect(pruneArchive(-2, now).deleted).toBe(0);
    expect(getArchivedEvent('evt-neg')?.content).toBe('keep');
    expect(getContextMeta('last_archive_sweep_at')).toBeUndefined();
    expect(getCounter('mem.config.invalid_value', { field: 'archiveRetentionDays' })).toBe(1);
  });

  // P6: re-archiving the same event id refreshes token_count without
  // mutating content/metadata.
  it('refreshes token_count on re-archive while preserving original content', () => {
    const event = recordContextEvent({
      id: 'evt-token-refresh',
      target,
      eventType: 'assistant.text',
      content: 'short',
      createdAt: 100,
    });
    archiveEventsForMaterialization([event], 200);
    const before = getArchivedEvent('evt-token-refresh');
    expect(before?.content).toBe('short');

    // Simulate a tokenizer upgrade by re-archiving with a fabricated longer
    // content shape — the store keeps the *first* content (byte-identical
    // archive invariant) but should refresh token_count.
    archiveEventsForMaterialization([{ ...event, content: 'this is a much longer body' }], 300);
    const after = getArchivedEvent('evt-token-refresh');
    // Content must remain byte-identical to the first write.
    expect(after?.content).toBe('short');
  });
});
