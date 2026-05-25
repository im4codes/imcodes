/**
 * Daemon-side WS handler for `memory.get_sources_request`.
 *
 * The route at /api/memory/sources forwards a request over the daemon WS;
 * the daemon's command-handler dispatches by `type` and calls the handler
 * below. We exercise the public dispatch entrypoint (`handleWebCommand`) so
 * the dispatch case wiring is also covered.
 *
 * Coverage:
 *   - validates required fields and replies with `validation_failed`
 *   - missing projection → isomorphic empty reply (no oracle for the cloud)
 *   - happy path with a seeded projection + archived event
 *   - cross-namespace events on the same projection row are NOT returned
 *     (namespace check applied per-event)
 *   - partial=true is set when some source events are missing from archive
 */
import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'vitest';
import { writeProcessedProjection, archiveEventsForMaterialization, insertProjectionSources } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';
import { MEMORY_WS } from '../../shared/memory-ws.js';
import type { LocalContextEvent } from '../../shared/context-types.js';

interface FakeServerLink {
  send: (msg: unknown) => void;
  sendBinary: (data: Buffer) => void;
  isConnected: () => boolean;
  close: () => void;
}

function makeFakeServerLink(): FakeServerLink & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    send: (msg: unknown) => { sent.push(msg as Record<string, unknown>); },
    sendBinary: () => {},
    isConnected: () => true,
    close: () => {},
  };
}

let handleWebCommand: (msg: unknown, serverLink: unknown) => void;

beforeAll(async () => {
  ({ handleWebCommand } = await import('../../src/daemon/command-handler.js'));
}, 30_000);

describe('daemon WS handler: memory.get_sources_request', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('memory-get-sources-rpc');
  });

  afterEach(async () => {
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('replies with validation_failed when projectionId is missing', async () => {
    const link = makeFakeServerLink();
    handleWebCommand({
      type: MEMORY_WS.GET_SOURCES_REQUEST,
      requestId: 'req-1',
      expectedServerId: 'srv-self',
    }, link);
    // Handler is async (uses dynamic import). Allow the microtask queue to drain.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    expect(link.sent).toHaveLength(1);
    expect(link.sent[0]).toMatchObject({
      type: MEMORY_WS.GET_SOURCES_RESPONSE,
      requestId: 'req-1',
      status: 'error',
      reason: 'validation_failed',
      originServerId: 'srv-self',
    });
  });

  it('returns an isomorphic empty reply for an unknown projectionId', async () => {
    const link = makeFakeServerLink();
    handleWebCommand({
      type: MEMORY_WS.GET_SOURCES_REQUEST,
      requestId: 'req-2',
      projectionId: 'does-not-exist',
      expectedServerId: 'srv-self',
    }, link);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    expect(link.sent).toHaveLength(1);
    const reply = link.sent[0];
    expect(reply.type).toBe(MEMORY_WS.GET_SOURCES_RESPONSE);
    expect(reply.requestId).toBe('req-2');
    expect(reply.status).toBe('ok');
    expect(reply.projectionId).toBe('does-not-exist');
    expect(reply.sourceEventCount).toBe(0);
    expect(reply.sources).toEqual([]);
    expect(reply.originServerId).toBe('srv-self');
  });

  it('returns sources for a projection with matching archived events', async () => {
    // Seed a projection + two archived events that share its namespace.
    const namespace = { scope: 'personal' as const, projectId: 'repo-1', userId: 'user-1' };
    const target = { namespace, kind: 'session' as const, name: 'deck_repo1_brain' };

    const eventA: LocalContextEvent = {
      id: 'evt-A',
      target,
      eventType: 'chat.assistant',
      content: 'assistant said A',
      createdAt: 1_000,
    };
    const eventB: LocalContextEvent = {
      id: 'evt-B',
      target,
      eventType: 'chat.assistant',
      content: 'assistant said B',
      createdAt: 2_000,
    };
    archiveEventsForMaterialization([eventA, eventB], 3_000);

    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-A', 'evt-B'],
      summary: 'Summary of A and B',
      content: {},
      updatedAt: 4_000,
    });
    // Some projection paths populate the explicit join table; some don't.
    // Make the join exist so listProjectionSources returns the JOINed shape.
    insertProjectionSources(projection.id, ['evt-A', 'evt-B']);

    const link = makeFakeServerLink();
    handleWebCommand({
      type: MEMORY_WS.GET_SOURCES_REQUEST,
      requestId: 'req-3',
      projectionId: projection.id,
      expectedServerId: 'srv-self',
    }, link);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(link.sent).toHaveLength(1);
    const reply = link.sent[0];
    expect(reply.status).toBe('ok');
    expect(reply.sourceEventCount).toBe(2);
    const sources = reply.sources as Array<{ eventId: string; content: string | null; status: string }>;
    expect(sources).toHaveLength(2);
    const byId = Object.fromEntries(sources.map((s) => [s.eventId, s]));
    expect(byId['evt-A'].content).toBe('assistant said A');
    expect(byId['evt-A'].status).toBe('archived');
    expect(byId['evt-B'].content).toBe('assistant said B');
    // partial only set when content is missing — both events are present,
    // so partial should be false (or undefined when same count).
    expect(reply.partial).toBe(false);
  });

  it('returns manual memory projection text when no archived source event exists', async () => {
    const namespace = { scope: 'personal' as const, projectId: 'repo-1', userId: 'user-1' };
    const manualMemoryText = [
      'mock infra server alpha: ssh user@alpha.test.im.codes',
      'mock infra server beta: ssh user@beta.test.im.codes',
    ].join('\n');
    const projection = writeProcessedProjection({
      namespace,
      class: 'durable_memory_candidate',
      sourceEventIds: ['manual-memory:req-1'],
      summary: manualMemoryText,
      content: { text: manualMemoryText, manual: true, origin: 'user_note' },
      origin: 'user_note',
      updatedAt: 4_000,
    });

    const link = makeFakeServerLink();
    handleWebCommand({
      type: MEMORY_WS.GET_SOURCES_REQUEST,
      requestId: 'req-manual',
      projectionId: projection.id,
      expectedServerId: 'srv-self',
    }, link);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(link.sent).toHaveLength(1);
    const reply = link.sent[0];
    expect(reply.status).toBe('ok');
    expect(reply.sourceEventCount).toBe(1);
    expect(reply.partial).toBe(false);
    const sources = reply.sources as Array<{ eventId: string; content: string | null; status: string; eventType?: string }>;
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      eventId: 'manual-memory:req-1',
      status: 'projection',
      eventType: 'memory.projection',
      content: expect.stringContaining('alpha.test.im.codes'),
    });
    expect(sources[0].content).toContain('beta.test.im.codes');
  });

  it('returns projection summary fallback for non-manual projections whose raw events are unavailable', async () => {
    const namespace = { scope: 'personal' as const, projectId: 'repo-1', userId: 'user-1' };
    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-missing-summary'],
      summary: 'mock deployment note: alpha.test.im.codes is the canary host',
      content: { eventCount: 2, ownerUserId: 'user-1' },
      origin: 'chat_compacted',
      updatedAt: 4_000,
    });

    const link = makeFakeServerLink();
    handleWebCommand({
      type: MEMORY_WS.GET_SOURCES_REQUEST,
      requestId: 'req-summary-fallback',
      projectionId: projection.id,
      expectedServerId: 'srv-self',
    }, link);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(link.sent).toHaveLength(1);
    const reply = link.sent[0];
    expect(reply.status).toBe('ok');
    expect(reply.sourceEventCount).toBe(1);
    expect(reply.partial).toBe(false);
    const sources = reply.sources as Array<{ eventId: string; content: string | null; status: string; eventType?: string }>;
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      eventId: 'evt-missing-summary',
      status: 'projection',
      eventType: 'memory.projection',
      content: 'mock deployment note: alpha.test.im.codes is the canary host',
    });
    expect(JSON.stringify(sources[0])).not.toContain('ownerUserId');
  });

  it('sets partial=true when some source events are missing from the archive', async () => {
    const namespace = { scope: 'personal' as const, projectId: 'repo-1', userId: 'user-1' };
    const target = { namespace, kind: 'session' as const, name: 'deck_repo1_brain' };

    // Archive only ONE of the two source events.
    archiveEventsForMaterialization([{
      id: 'evt-here',
      target,
      eventType: 'chat.assistant',
      content: 'present event',
      createdAt: 1_000,
    }], 3_000);

    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-here', 'evt-gone'],
      summary: 'Half-resolvable projection',
      content: {},
      updatedAt: 4_000,
    });
    insertProjectionSources(projection.id, ['evt-here', 'evt-gone']);

    const link = makeFakeServerLink();
    handleWebCommand({
      type: MEMORY_WS.GET_SOURCES_REQUEST,
      requestId: 'req-4',
      projectionId: projection.id,
      expectedServerId: 'srv-self',
    }, link);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const reply = link.sent[0];
    expect(reply.status).toBe('ok');
    expect(reply.sourceEventCount).toBe(2);
    const sources = reply.sources as Array<{ eventId: string; content: string | null; status: string }>;
    const byId = Object.fromEntries(sources.map((s) => [s.eventId, s]));
    expect(byId['evt-here'].content).toBe('present event');
    // The missing event still appears with `status: 'missing'` and null
    // content — this is what the daemon (and memoryGetSources) returns.
    expect(byId['evt-gone'].content).toBeNull();
    expect(byId['evt-gone'].status).toBe('missing');
    expect(reply.partial).toBe(true);
  });

  it('drops content for events whose namespace does not match the projection', async () => {
    // A source event landed in archive under a DIFFERENT namespace than the
    // projection (corrupt row / past bug). The handler MUST surface the
    // eventId but blank out content/eventType/createdAt.
    const projectionNs = { scope: 'personal' as const, projectId: 'repo-1', userId: 'user-1' };
    const foreignNs = { scope: 'personal' as const, projectId: 'repo-other', userId: 'user-1' };

    archiveEventsForMaterialization([{
      id: 'evt-mismatched',
      target: { namespace: foreignNs, kind: 'session', name: 'deck_other_brain' },
      eventType: 'chat.assistant',
      content: 'cross-namespace leak',
      createdAt: 1_000,
    }], 3_000);

    const projection = writeProcessedProjection({
      namespace: projectionNs,
      class: 'recent_summary',
      sourceEventIds: ['evt-mismatched'],
      summary: 'Projection in repo-1',
      content: {},
      updatedAt: 4_000,
    });
    insertProjectionSources(projection.id, ['evt-mismatched']);

    const link = makeFakeServerLink();
    handleWebCommand({
      type: MEMORY_WS.GET_SOURCES_REQUEST,
      requestId: 'req-5',
      projectionId: projection.id,
      expectedServerId: 'srv-self',
    }, link);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const reply = link.sent[0];
    const sources = reply.sources as Array<{ eventId: string; content: string | null }>;
    expect(sources).toHaveLength(1);
    expect(sources[0].eventId).toBe('evt-mismatched');
    expect(sources[0].content).toBeNull(); // namespace mismatch → no content
  });
});
