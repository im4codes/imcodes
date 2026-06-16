import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContextNamespace } from '../../shared/context-types.js';
import { archiveEventsForMaterialization, ensureContextNamespace, recordContextEvent, resetContextStoreForTests, writeContextObservation, writeProcessedProjection } from '../../src/store/context-store.js';
import { chatGetEvent, chatSearchFts, createMemoryToolCaller, memoryGetSources } from '../../src/context/memory-read-tools.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('memory read tools', () => {
  let tempDir: string;
  let configDir: string;
  let configPath: string;
  const bobRepo: ContextNamespace = { scope: 'personal', projectId: 'repo', userId: 'bob' };
  const bobOtherRepo: ContextNamespace = { scope: 'personal', projectId: 'other-repo', userId: 'bob' };
  const aliceRepo: ContextNamespace = { scope: 'personal', projectId: 'repo', userId: 'alice' };

  async function expectForbidden(fn: () => unknown): Promise<void> {
    try {
      await fn();
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

  it('returns archived event content for owner and rejects cross-user chat_get_event', async () => {
    const target = { namespace: bobRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({ id: 'evt-1', target, eventType: 'user.message', content: 'secret raw content', createdAt: 1 });
    archiveEventsForMaterialization([event], 2);
    expect((await chatGetEvent('evt-1', caller('bob', bobRepo)))?.content).toBe('secret raw content');
    await expectForbidden(() => chatGetEvent('evt-1', caller('alice', aliceRepo)));
  });

  it('fails closed for malformed callers while allowing daemon-local fallback without bound user', async () => {
    const target = { namespace: bobRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({ id: 'evt-auth', target, eventType: 'user.message', content: 'secret raw content', createdAt: 1 });
    archiveEventsForMaterialization([event], 2);

    await expectForbidden(() => (chatGetEvent as unknown as (id: string) => unknown)('evt-auth'));
    await expectForbidden(() => (memoryGetSources as unknown as (id: string) => unknown)('projection-id'));
    await expectForbidden(() => (chatSearchFts as unknown as (query: string) => unknown)('secret'));
    await expectForbidden(() => chatGetEvent('evt-auth', { userId: 'bob' } as never));
    await expectForbidden(() => chatSearchFts('secret', 10, { userId: 'bob' } as never));

    await rm(configPath, { force: true });
    await expectForbidden(() => chatGetEvent('evt-auth', caller('bob', bobRepo)));
    await expect(chatSearchFts('secret', 10, caller('daemon-local', { scope: 'personal', projectId: 'repo', userId: 'daemon-local' }))).resolves.not.toThrow();

    await writeFile(configPath, '{not-json', 'utf8');
    await expectForbidden(() => chatGetEvent('evt-auth', caller('bob', bobRepo)));
    await expect(chatSearchFts('secret', 10, caller('daemon-local', { scope: 'personal', projectId: 'repo', userId: 'daemon-local' }))).resolves.not.toThrow();
  });

  it('filters raw event and FTS results to the caller namespace', async () => {
    const bobTarget = { namespace: bobRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const otherTarget = { namespace: bobOtherRepo, kind: 'session' as const, sessionName: 'deck_other_brain' };
    const aliceTarget = { namespace: aliceRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const bobEvent = recordContextEvent({ id: 'evt-bob-repo', target: bobTarget, eventType: 'user.message', content: 'needle visible to repo', createdAt: 1 });
    const otherEvent = recordContextEvent({ id: 'evt-bob-other', target: otherTarget, eventType: 'user.message', content: 'needle hidden other repo', createdAt: 2 });
    const aliceEvent = recordContextEvent({ id: 'evt-alice-repo', target: aliceTarget, eventType: 'user.message', content: 'needle hidden alice repo', createdAt: 3 });
    archiveEventsForMaterialization([bobEvent, otherEvent, aliceEvent], 4);

    await expectForbidden(() => chatGetEvent('evt-bob-other', caller('bob', bobRepo)));
    await expectForbidden(() => chatGetEvent('evt-alice-repo', caller('bob', bobRepo)));

    const matches = await chatSearchFts('needle', 10, caller('bob', bobRepo));
    expect(matches.map((row) => row.id)).toEqual(['evt-bob-repo']);
    expect(matches.map((row) => row.content).join('\n')).not.toContain('hidden');
  });

  it('returns source rows for projections', async () => {
    const target = { namespace: bobRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({ id: 'evt-2', target, eventType: 'assistant.text', content: 'done', createdAt: 1 });
    archiveEventsForMaterialization([event], 2);
    const projection = writeProcessedProjection({ namespace: bobRepo, class: 'recent_summary', sourceEventIds: ['evt-2'], summary: 'done', content: {} });
    const sources = await memoryGetSources(projection.id, caller('bob', bobRepo));
    expect(sources.sourceEventCount).toBe(1);
    expect(sources.sources?.[0]).toMatchObject({ eventId: 'evt-2', status: 'archived', content: 'done' });
    expect(sources.projectionSource).toMatchObject({ eventId: 'evt-2', status: 'projection', content: 'done' });
    expect(sources.partial).toBe(false);
  });

  it('returns legacy personal projection sources for the same project owner namespace', async () => {
    const legacyRepo: ContextNamespace = { scope: 'personal', projectId: 'repo' };
    const target = { namespace: legacyRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({
      id: 'evt-legacy-personal',
      target,
      eventType: 'assistant.text',
      content: 'legacy personal source content',
      createdAt: 1,
    });
    archiveEventsForMaterialization([event], 2);
    const projection = writeProcessedProjection({
      namespace: legacyRepo,
      class: 'recent_summary',
      sourceEventIds: ['evt-legacy-personal'],
      summary: 'legacy personal summary',
      content: {},
    });

    const sources = await memoryGetSources(projection.id, caller('bob', bobRepo));
    expect(sources).toMatchObject({
      projectionId: projection.id,
      sourceEventCount: 1,
      projectionSource: {
        eventId: 'evt-legacy-personal',
        status: 'projection',
        content: 'legacy personal summary',
      },
      partial: false,
      sources: [
        {
          eventId: 'evt-legacy-personal',
          status: 'archived',
          content: 'legacy personal source content',
          eventType: 'assistant.text',
          createdAt: 1,
        },
      ],
    });
  });

  it('returns same-owner user_private projection sources through the project personal namespace', async () => {
    const privateRepo: ContextNamespace = { scope: 'user_private', projectId: 'repo', userId: 'bob' };
    const target = { namespace: privateRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({
      id: 'evt-user-private-projection',
      target,
      eventType: 'assistant.text',
      content: 'private projection source content',
      createdAt: 1,
    });
    archiveEventsForMaterialization([event], 2);
    const projection = writeProcessedProjection({
      namespace: privateRepo,
      class: 'recent_summary',
      sourceEventIds: ['evt-user-private-projection'],
      summary: 'private projection summary',
      content: {},
    });

    const sources = await memoryGetSources(projection.id, caller('bob', bobRepo));
    expect(sources).toMatchObject({
      projectionId: projection.id,
      sourceEventCount: 1,
      partial: false,
      sources: [
        {
          eventId: 'evt-user-private-projection',
          status: 'archived',
          content: 'private projection source content',
        },
      ],
    });
    expect(await memoryGetSources(projection.id, caller('bob', bobOtherRepo))).toEqual({
      projectionId: projection.id,
      sourceEventCount: 0,
      sources: [],
    });
    await expectForbidden(() => memoryGetSources(projection.id, caller('alice', aliceRepo)));
  });

  it('does not bridge user_private projection sources when caller has no project id', async () => {
    const privateRepo: ContextNamespace = { scope: 'user_private', projectId: 'repo', userId: 'bob' };
    const target = { namespace: privateRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const event = recordContextEvent({
      id: 'evt-user-private-unscoped',
      target,
      eventType: 'assistant.text',
      content: 'private projection source content',
      createdAt: 1,
    });
    archiveEventsForMaterialization([event], 2);
    const projection = writeProcessedProjection({
      namespace: privateRepo,
      class: 'recent_summary',
      sourceEventIds: ['evt-user-private-unscoped'],
      summary: 'private projection summary',
      content: {},
    });

    expect(await memoryGetSources(projection.id, caller('bob', { scope: 'personal', userId: 'bob' }))).toEqual({
      projectionId: projection.id,
      sourceEventCount: 0,
      sources: [],
    });
  });

  it('returns manual memory projection text when no raw source event exists', async () => {
    const manualMemoryText = [
      'mock infra server alpha: ssh user@alpha.test.im.codes',
      'mock infra server beta: ssh user@beta.test.im.codes',
    ].join('\n');
    const projection = writeProcessedProjection({
      namespace: bobRepo,
      class: 'durable_memory_candidate',
      sourceEventIds: ['manual-memory:req-1'],
      summary: manualMemoryText,
      content: { text: manualMemoryText, manual: true, origin: 'user_note' },
      origin: 'user_note',
      createdAt: 1,
      updatedAt: 1,
    });

    const sources = await memoryGetSources(projection.id, caller('bob', bobRepo));
    expect(sources.sourceEventCount).toBe(1);
    expect(sources.partial).toBe(false);
    expect(sources.sources).toHaveLength(1);
    expect(sources.sources?.[0]).toMatchObject({
      eventId: 'manual-memory:req-1',
      status: 'projection',
      eventType: 'memory.projection',
      content: expect.stringContaining('alpha.test.im.codes'),
    });
    expect(sources.sources?.[0]?.content).toContain('beta.test.im.codes');
  });

  it('returns projection summary when non-manual raw source events are unavailable', async () => {
    const projection = writeProcessedProjection({
      namespace: bobRepo,
      class: 'recent_summary',
      sourceEventIds: ['evt-missing-summary'],
      summary: 'mock deployment note: alpha.test.im.codes promoted to canary',
      content: { eventCount: 3, ownerUserId: 'bob' },
      origin: 'chat_compacted',
      createdAt: 10,
      updatedAt: 10,
    });

    const sources = await memoryGetSources(projection.id, caller('bob', bobRepo));
    expect(sources.sourceEventCount).toBe(1);
    expect(sources.partial).toBe(false);
    expect(sources.sources).toHaveLength(1);
    expect(sources.sources?.[0]).toMatchObject({
      eventId: 'evt-missing-summary',
      status: 'projection',
      eventType: 'memory.projection',
      content: 'mock deployment note: alpha.test.im.codes promoted to canary',
    });
  });

  it('returns exact observation text by observationId without requiring a projection', async () => {
    const namespace = ensureContextNamespace({ scope: 'user_private', projectId: 'repo', userId: 'bob' }, 10);
    const observation = writeContextObservation({
      namespaceId: namespace.id,
      scope: 'user_private',
      class: 'note',
      origin: 'agent_learned',
      fingerprint: 'obs-source-fp',
      content: { text: 'mock server alpha credential note uses alpha.test.im.codes' },
      text: 'mock server alpha credential note uses alpha.test.im.codes',
      sourceEventIds: ['turn-observation'],
      state: 'candidate',
      now: 20,
    });

    const sources = await memoryGetSources({ observationId: observation.id, kind: 'observation' }, caller('bob', { scope: 'user_private', projectId: 'repo', userId: 'bob' }));
    expect(sources).toMatchObject({
      observationId: observation.id,
      sourceEventCount: 1,
      partial: false,
      sources: [
        {
          eventId: 'turn-observation',
          status: 'observation',
          eventType: 'memory.observation.note',
          content: 'mock server alpha credential note uses alpha.test.im.codes',
        },
      ],
    });
  });

  it('does not leak observation existence across namespaces', async () => {
    const namespace = ensureContextNamespace({ scope: 'user_private', projectId: 'repo', userId: 'bob' }, 10);
    const observation = writeContextObservation({
      namespaceId: namespace.id,
      scope: 'user_private',
      class: 'note',
      origin: 'agent_learned',
      fingerprint: 'obs-hidden-fp',
      content: { text: 'hidden observation text' },
      text: 'hidden observation text',
      state: 'candidate',
      now: 20,
    });

    expect(await memoryGetSources({ observationId: observation.id, kind: 'observation' }, caller('bob', bobOtherRepo))).toEqual({
      observationId: observation.id,
      sourceEventCount: 0,
      sources: [],
    });
  });

  it('does not bridge user_private observations when caller has no project id', async () => {
    const namespace = ensureContextNamespace({ scope: 'user_private', projectId: 'repo', userId: 'bob' }, 10);
    const observation = writeContextObservation({
      namespaceId: namespace.id,
      scope: 'user_private',
      class: 'note',
      origin: 'agent_learned',
      fingerprint: 'obs-unscoped-hidden-fp',
      content: { text: 'hidden observation text' },
      text: 'hidden observation text',
      state: 'candidate',
      now: 20,
    });

    expect(await memoryGetSources({ observationId: observation.id, kind: 'observation' }, caller('bob', { scope: 'personal', userId: 'bob' }))).toEqual({
      observationId: observation.id,
      sourceEventCount: 0,
      sources: [],
    });
  });

  it('does not leak cross-namespace projection source counts beyond recency caps', async () => {
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

    const response = await memoryGetSources(projection.id, caller('bob', bobOtherRepo));
    expect(response).toEqual({
      projectionId: projection.id,
      sourceEventCount: 0,
      sources: [],
    });
    const missing = await memoryGetSources('missing-projection-id', caller('bob', bobOtherRepo));
    expect({ sourceEventCount: response.sourceEventCount, sources: response.sources }).toEqual({
      sourceEventCount: missing.sourceEventCount,
      sources: missing.sources,
    });
  });

  it('falls back safely for malformed FTS queries without leaking other namespaces', async () => {
    const target = { namespace: bobRepo, kind: 'session' as const, sessionName: 'deck_repo_brain' };
    const otherTarget = { namespace: bobOtherRepo, kind: 'session' as const, sessionName: 'deck_other_brain' };
    const event = recordContextEvent({ id: 'evt-malformed-ok', target, eventType: 'user.message', content: 'literal malformed token foo" survives', createdAt: 1 });
    const otherEvent = recordContextEvent({ id: 'evt-malformed-other', target: otherTarget, eventType: 'user.message', content: 'literal malformed token foo" hidden', createdAt: 2 });
    archiveEventsForMaterialization([event, otherEvent], 3);

    await expect(chatSearchFts('foo"', 10, caller('bob', bobRepo))).resolves.not.toThrow();
    expect((await chatSearchFts('foo"', 10, caller('bob', bobRepo))).map((row) => row.id)).toEqual(['evt-malformed-ok']);
  });
});
