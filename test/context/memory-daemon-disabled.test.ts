import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { generateEmbedding } from '../../src/context/embedding.js';
import { searchLocalMemory } from '../../src/context/memory-recall-core.js';
import { listContextEvents, listProcessedProjections, recordContextEvent, resetContextStoreForTests, writeProcessedProjection } from '../../src/store/context-store.js';
import { setMemoryDaemonEnabled } from '../../src/store/memory-daemon-switch.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('daemon-wide memory disable gate', () => {
  let tempDir: string;
  const target = { namespace: { scope: 'personal' as const, projectId: 'repo' }, kind: 'session' as const, sessionName: 'deck_repo_brain' };

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('memory-daemon-disabled');
    process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH = join(tempDir, 'memory-switch.json');
    setMemoryDaemonEnabled(false);
  });

  afterEach(async () => {
    setMemoryDaemonEnabled(true);
    delete process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH;
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('does not stage events, write projections, search, or start embedding while disabled', async () => {
    const event = recordContextEvent({ id: 'disabled-event', target, eventType: 'user.message', content: 'must not persist', createdAt: 1 });
    expect(event.id).toBe('disabled-event');
    expect(listContextEvents(target)).toEqual([]);
    expect(() => writeProcessedProjection({ namespace: target.namespace, class: 'recent_summary', sourceEventIds: [], summary: 'must not persist', content: {}, createdAt: 1, updatedAt: 1 })).toThrowError(/memory.*disabled/i);
    expect(listProcessedProjections(target.namespace)).toEqual([]);
    expect(searchLocalMemory({ query: 'must not persist' }).items).toEqual([]);
    expect(await generateEmbedding('must not compute')).toBeNull();
  });

  it('preserves existing rows when disabled and resumes only after explicit enable', () => {
    setMemoryDaemonEnabled(true);
    writeProcessedProjection({ namespace: target.namespace, class: 'recent_summary', sourceEventIds: [], summary: 'existing memory', content: {}, createdAt: 1, updatedAt: 1 });
    setMemoryDaemonEnabled(false);
    expect(listProcessedProjections(target.namespace)).toHaveLength(1);
    setMemoryDaemonEnabled(true);
    expect(() => writeProcessedProjection({ namespace: target.namespace, class: 'recent_summary', sourceEventIds: [], summary: 'new memory', content: {}, createdAt: 2, updatedAt: 2 })).not.toThrow();
    expect(listProcessedProjections(target.namespace)).toHaveLength(2);
  });
});
