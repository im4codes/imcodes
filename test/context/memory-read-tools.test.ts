import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContextNamespace } from '../../shared/context-types.js';
import { archiveEventsForMaterialization, recordContextEvent, resetContextStoreForTests, writeProcessedProjection } from '../../src/store/context-store.js';
import { chatGetEvent, chatSearchFts, createMemoryToolCaller, memoryGetSources } from '../../src/context/memory-read-tools.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('memory read tools', () => {
  let tempDir: string;
  let configDir: string;
  let configPath: string;
  const bobRepo: ContextNamespace = { scope: 'personal', projectId: 'repo', userId: 'bob' };
  const bobOtherRepo: ContextNamespace = { scope: 'personal', projectId: 'other-repo', userId: 'bob' };
  const aliceRepo: ContextNamespace = { scope: 'personal', projectId: 'repo', userId: 'alice' };

  function expectForbidden(fn: () => unknown): void {
    try {
      fn();
      throw new Error('expected IMCODES_MEMORY_FORBIDDEN');
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBe('IMCODES_MEMORY_FORBIDDEN');
    }
  }

  function caller(userId: string, namespace: ContextNamespace) {
    return createMemoryToolCaller({ userId, namespace });
  }

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('memory-read-tools');
    configDir = join(tmpdir(), `imc-server-config-${process.pid}-${Math.random().toString(16).slice(2)}`);
    await mkdir(configDir, { recursive: true });
    configPath = join(configDir, 'server.json');
    process.env.IMCODES_SERVER_CONFIG_PATH = configPath;
    await writeFile(configPath, JSON.stringify({ userId: 'bob' }), 'utf8');
  });
  afterEach(async () => {
    delete process.env.IMCODES_SERVER_CONFIG_PATH;
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
    await rm(configDir, { recursive: true, force: true });
  });

  it('returns archived event content for owner and rejects cross-user chat_get_event', () => {
    const target = { namespace: bobRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({ id: 'evt-1', target, eventType: 'user.message', content: 'secret raw content', createdAt: 1 });
    archiveEventsForMaterialization([event], 2);
    expect(chatGetEvent('evt-1', caller('bob', bobRepo))?.content).toBe('secret raw content');
    expectForbidden(() => chatGetEvent('evt-1', caller('alice', aliceRepo)));
  });

  it('fails closed for malformed callers while allowing daemon-local fallback without bound user', async () => {
    const target = { namespace: bobRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({ id: 'evt-auth', target, eventType: 'user.message', content: 'secret raw content', createdAt: 1 });
    archiveEventsForMaterialization([event], 2);

    expectForbidden(() => (chatGetEvent as unknown as (id: string) => unknown)('evt-auth'));
    expectForbidden(() => (memoryGetSources as unknown as (id: string) => unknown)('projection-id'));
    expectForbidden(() => (chatSearchFts as unknown as (query: string) => unknown)('secret'));
    expectForbidden(() => chatGetEvent('evt-auth', { userId: 'bob' } as never));
    expectForbidden(() => chatSearchFts('secret', 10, { userId: 'bob' } as never));

    await rm(configPath, { force: true });
    expectForbidden(() => chatGetEvent('evt-auth', caller('bob', bobRepo)));
    expect(() => chatSearchFts('secret', 10, caller('daemon-local', { scope: 'personal', projectId: 'repo', userId: 'daemon-local' }))).not.toThrow();

    await writeFile(configPath, '{not-json', 'utf8');
    expectForbidden(() => chatGetEvent('evt-auth', caller('bob', bobRepo)));
    expect(() => chatSearchFts('secret', 10, caller('daemon-local', { scope: 'personal', projectId: 'repo', userId: 'daemon-local' }))).not.toThrow();
  });

  it('filters raw event and FTS results to the caller namespace', () => {
    const bobTarget = { namespace: bobRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const otherTarget = { namespace: bobOtherRepo, kind: 'session' as const, sessionName: 'deck_other_brain' };
    const aliceTarget = { namespace: aliceRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const bobEvent = recordContextEvent({ id: 'evt-bob-repo', target: bobTarget, eventType: 'user.message', content: 'needle visible to repo', createdAt: 1 });
    const otherEvent = recordContextEvent({ id: 'evt-bob-other', target: otherTarget, eventType: 'user.message', content: 'needle hidden other repo', createdAt: 2 });
    const aliceEvent = recordContextEvent({ id: 'evt-alice-repo', target: aliceTarget, eventType: 'user.message', content: 'needle hidden alice repo', createdAt: 3 });
    archiveEventsForMaterialization([bobEvent, otherEvent, aliceEvent], 4);

    expectForbidden(() => chatGetEvent('evt-bob-other', caller('bob', bobRepo)));
    expectForbidden(() => chatGetEvent('evt-alice-repo', caller('bob', bobRepo)));

    const matches = chatSearchFts('needle', 10, caller('bob', bobRepo));
    expect(matches.map((row) => row.id)).toEqual(['evt-bob-repo']);
    expect(matches.map((row) => row.content).join('\n')).not.toContain('hidden');
  });

  it('returns source rows for projections', () => {
    const target = { namespace: bobRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({ id: 'evt-2', target, eventType: 'assistant.text', content: 'done', createdAt: 1 });
    archiveEventsForMaterialization([event], 2);
    const projection = writeProcessedProjection({ namespace: bobRepo, class: 'recent_summary', sourceEventIds: ['evt-2'], summary: 'done', content: {} });
    const sources = memoryGetSources(projection.id, caller('bob', bobRepo));
    expect(sources.sourceEventCount).toBe(1);
    expect(sources.sources?.[0]).toMatchObject({ eventId: 'evt-2', status: 'archived', content: 'done' });
    expect(sources.partial).toBe(false);
  });

  it('does not leak cross-namespace projection source counts beyond recency caps', () => {
    const projection = writeProcessedProjection({
      namespace: bobRepo,
      class: 'recent_summary',
      sourceEventIds: ['old-1', 'old-2', 'old-3'],
      summary: 'old target projection',
      content: {},
      updatedAt: 1,
    });
    for (let index = 0; index < 1050; index += 1) {
      writeProcessedProjection({
        namespace: bobOtherRepo,
        class: 'recent_summary',
        sourceEventIds: [`new-${index}`],
        summary: `newer projection ${index}`,
        content: {},
        updatedAt: 10_000 + index,
      });
    }

    const response = memoryGetSources(projection.id, caller('bob', bobOtherRepo));
    expect(response).toEqual({
      projectionId: projection.id,
      sourceEventCount: 0,
      sources: [],
    });
    const missing = memoryGetSources('missing-projection-id', caller('bob', bobOtherRepo));
    expect({ sourceEventCount: response.sourceEventCount, sources: response.sources }).toEqual({
      sourceEventCount: missing.sourceEventCount,
      sources: missing.sources,
    });
  });

  it('falls back safely for malformed FTS queries without leaking other namespaces', () => {
    const target = { namespace: bobRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const otherTarget = { namespace: bobOtherRepo, kind: 'session' as const, sessionName: 'deck_other_brain' };
    const event = recordContextEvent({ id: 'evt-malformed-ok', target, eventType: 'user.message', content: 'literal malformed token foo" survives', createdAt: 1 });
    const otherEvent = recordContextEvent({ id: 'evt-malformed-other', target: otherTarget, eventType: 'user.message', content: 'literal malformed token foo" hidden', createdAt: 2 });
    archiveEventsForMaterialization([event, otherEvent], 3);

    expect(() => chatSearchFts('foo"', 10, caller('bob', bobRepo))).not.toThrow();
    expect(chatSearchFts('foo"', 10, caller('bob', bobRepo)).map((row) => row.id)).toEqual(['evt-malformed-ok']);
  });
});
