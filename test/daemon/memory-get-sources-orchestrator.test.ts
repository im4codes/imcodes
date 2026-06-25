/**
 * Orchestrator tests cover:
 *   - cache hit avoids the cloud round trip
 *   - cache miss + cloud success → routes correctly
 *   - cache miss + cloud unreachable → falls back to local SQLite
 *   - resolved owner = self → local path with local serverId stamped
 *   - resolved owner != self → remote HTTP path with serverId in query
 *   - error mapping (403 / 409 / 404 / 500 / network)
 *
 * No real WS or DB I/O — all deps are injected.
 */
import { describe, expect, it, vi } from 'vitest';
import { getMemorySourcesOrchestrated } from '../../src/daemon/memory-get-sources-orchestrator.js';
import { createProjectionOwnerCache } from '../../src/daemon/memory-projection-owner-cache.js';
import { createMemoryToolCaller } from '../../src/context/memory-read-tools.js';
import type { MemoryGetSourcesResult } from '../../src/context/memory-read-tools.js';
import { TIMELINE_HISTORY_ERROR_REASONS } from '../../shared/timeline-history-errors.js';

const SELF_SERVER_ID = 'srv-self';
const REMOTE_SERVER_ID = 'srv-remote';

const callerNamespace = { scope: 'personal' as const, projectId: 'proj-1', userId: 'user-1' };
const caller = createMemoryToolCaller({ userId: 'user-1', namespace: callerNamespace });

function fakeCredentials() {
  return {
    workerUrl: 'https://api.example.test',
    serverId: SELF_SERVER_ID,
    token: 'server-token',
  };
}

function localResolvesTo(result: Partial<MemoryGetSourcesResult>): typeof import('../../src/context/memory-read-tools.js').memoryGetSources {
  return (async (projectionId: string) => ({
    projectionId,
    sourceEventCount: 0,
    sources: [],
    ...result,
  })) as typeof import('../../src/context/memory-read-tools.js').memoryGetSources;
}

describe('get_memory_sources orchestrator', () => {
  it('uses the local path when cache resolves owner = self serverId', async () => {
    const cache = createProjectionOwnerCache();
    cache.set('proj-1', SELF_SERVER_ID);
    const localGetSources = vi.fn(localResolvesTo({
      sourceEventCount: 2,
      sources: [
        { eventId: 'e1', status: 'archived' as const, content: 'event one', eventType: 'chat.assistant', createdAt: 1 },
        { eventId: 'e2', status: 'archived' as const, content: 'event two', eventType: 'chat.assistant', createdAt: 2 },
      ],
    }));
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

    const result = await getMemorySourcesOrchestrated('proj-1', caller, {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredentials: async () => fakeCredentials(),
      localGetSources,
    });

    expect(localGetSources).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.originServerId).toBe(SELF_SERVER_ID);
      expect(result.sourceEventCount).toBe(2);
    }
  });

  it('skips cloud lookup when the cache already has an owner', async () => {
    const cache = createProjectionOwnerCache();
    cache.set('proj-1', REMOTE_SERVER_ID);
    // Cloud projection-owner endpoint must NOT be called.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('projection-owner')) {
        throw new Error('cloud should not be called on cache hit');
      }
      // Remote sources endpoint OK.
      return new Response(JSON.stringify({
        status: 'ok',
        projectionId: 'proj-1',
        sourceEventCount: 1,
        sources: [{ eventId: 'e1', status: 'archived', content: 'remote event', eventType: 'chat.assistant', createdAt: 1 }],
        partial: false,
        originServerId: REMOTE_SERVER_ID,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await getMemorySourcesOrchestrated('proj-1', caller, {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredentials: async () => fakeCredentials(),
      localGetSources: vi.fn(),
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.originServerId).toBe(REMOTE_SERVER_ID);
      expect(result.sourceEventCount).toBe(1);
    }
    // Only the remote-sources fetch should have been made (one call).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain('/api/memory/sources');
    expect(fetchImpl.mock.calls[0][0]).toContain(`serverId=${REMOTE_SERVER_ID}`);
  });

  it('falls back to cloud projection-owner on cache miss and routes remotely', async () => {
    const cache = createProjectionOwnerCache();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('projection-owner')) {
        return new Response(JSON.stringify({ originServerId: REMOTE_SERVER_ID }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        status: 'ok',
        projectionId: 'proj-1',
        sourceEventCount: 1,
        sources: [{ eventId: 'e1', status: 'archived', content: 'remote event', eventType: 'chat.assistant', createdAt: 1 }],
        partial: false,
        originServerId: REMOTE_SERVER_ID,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const result = await getMemorySourcesOrchestrated('proj-1', caller, {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredentials: async () => fakeCredentials(),
      localGetSources: vi.fn(),
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.originServerId).toBe(REMOTE_SERVER_ID);
    }
    // Two HTTP calls: projection-owner then memory/sources.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Cache populated by the orchestrator for the next lookup.
    expect(cache.get('proj-1')).toBe(REMOTE_SERVER_ID);
  });

  it('falls back to local when projection-owner returns 404', async () => {
    const cache = createProjectionOwnerCache();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('projection-owner')) {
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    });
    const localGetSources = vi.fn(localResolvesTo({
      sourceEventCount: 1,
      sources: [{ eventId: 'e-local', status: 'archived' as const, content: 'local event', eventType: 'chat.assistant', createdAt: 1 }],
    }));

    const result = await getMemorySourcesOrchestrated('proj-1', caller, {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredentials: async () => fakeCredentials(),
      localGetSources,
    });

    expect(localGetSources).toHaveBeenCalledOnce();
    // Owner could not be resolved → local path. Stamp self serverId.
    if (result.status === 'ok') {
      expect(result.originServerId).toBe(SELF_SERVER_ID);
      expect(result.sourceEventCount).toBe(1);
    }
    // Only the projection-owner call. memory/sources NOT called.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to local when cloud projection-owner is unreachable', async () => {
    const cache = createProjectionOwnerCache();
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const localGetSources = vi.fn(localResolvesTo({ sourceEventCount: 0, sources: [] }));

    const result = await getMemorySourcesOrchestrated('proj-1', caller, {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredentials: async () => fakeCredentials(),
      localGetSources,
    });

    expect(localGetSources).toHaveBeenCalledOnce();
    expect(result.status).toBe('ok');
  });

  it('maps remote 403 to scope_forbidden', async () => {
    const cache = createProjectionOwnerCache();
    cache.set('proj-1', REMOTE_SERVER_ID);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const result = await getMemorySourcesOrchestrated('proj-1', caller, {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredentials: async () => fakeCredentials(),
      localGetSources: vi.fn(),
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.reason).toBe('scope_forbidden');
    }
  });

  it('maps remote 409 daemon_offline to projection_unavailable', async () => {
    const cache = createProjectionOwnerCache();
    cache.set('proj-1', REMOTE_SERVER_ID);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'daemon_offline' }), { status: 409, headers: { 'Content-Type': 'application/json' } }));

    const result = await getMemorySourcesOrchestrated('proj-1', caller, {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredentials: async () => fakeCredentials(),
      localGetSources: vi.fn(),
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.reason).toBe(TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE);
    }
  });

  it('maps remote 404 to an isomorphic empty result', async () => {
    const cache = createProjectionOwnerCache();
    cache.set('proj-1', REMOTE_SERVER_ID);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));

    const result = await getMemorySourcesOrchestrated('proj-1', caller, {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredentials: async () => fakeCredentials(),
      localGetSources: vi.fn(),
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.sourceEventCount).toBe(0);
      expect(result.sources).toEqual([]);
      expect(result.originServerId).toBe(REMOTE_SERVER_ID);
    }
  });

  it('maps remote network error to internal_error', async () => {
    const cache = createProjectionOwnerCache();
    cache.set('proj-1', REMOTE_SERVER_ID);
    const fetchImpl = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });

    const result = await getMemorySourcesOrchestrated('proj-1', caller, {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredentials: async () => fakeCredentials(),
      localGetSources: vi.fn(),
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.reason).toBe('internal_error');
    }
  });

  it('rejects an empty projectionId with validation_failed', async () => {
    const result = await getMemorySourcesOrchestrated('   ', caller, {
      cache: createProjectionOwnerCache(),
      fetchImpl: (vi.fn() as unknown as typeof fetch),
      loadCredentials: async () => null,
      localGetSources: vi.fn(),
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.reason).toBe('validation_failed');
    }
  });

  it('without credentials uses local path and emits no HTTP', async () => {
    const cache = createProjectionOwnerCache();
    const fetchImpl = vi.fn();
    const localGetSources = vi.fn(localResolvesTo({ sourceEventCount: 0, sources: [] }));

    const result = await getMemorySourcesOrchestrated('proj-1', caller, {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredentials: async () => null,
      localGetSources,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(localGetSources).toHaveBeenCalledOnce();
    expect(result.status).toBe('ok');
    // No bound serverId to stamp.
    if (result.status === 'ok') {
      expect(result.originServerId).toBeUndefined();
    }
  });

  it('propagates partial=true from a remote daemon reply', async () => {
    // Regression for memory-source-server-routing: when the owning daemon
    // can't resolve every source event (some events archive-pruned), it
    // sets `partial: true`. The orchestrator must NOT mask that — callers
    // want to know the reply is incomplete.
    const cache = createProjectionOwnerCache();
    cache.set('proj-partial', REMOTE_SERVER_ID);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      projectionId: 'proj-partial',
      sourceEventCount: 3,
      sources: [
        { eventId: 'e-here', status: 'archived', content: 'present', eventType: 'chat.assistant', createdAt: 1 },
        { eventId: 'e-gone-1', status: 'missing', content: null },
        { eventId: 'e-gone-2', status: 'missing', content: null },
      ],
      partial: true,
      originServerId: REMOTE_SERVER_ID,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await getMemorySourcesOrchestrated('proj-partial', caller, {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredentials: async () => fakeCredentials(),
      localGetSources: vi.fn(),
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.partial).toBe(true);
      expect(result.sourceEventCount).toBe(3);
      expect(result.sources).toHaveLength(3);
      expect(result.originServerId).toBe(REMOTE_SERVER_ID);
    }
  });

  it('skipCloudLookup bypasses the projection-owner fetch entirely', async () => {
    const cache = createProjectionOwnerCache();
    const fetchImpl = vi.fn();
    const localGetSources = vi.fn(localResolvesTo({ sourceEventCount: 0, sources: [] }));

    const result = await getMemorySourcesOrchestrated('proj-1', caller, {
      cache,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadCredentials: async () => fakeCredentials(),
      localGetSources,
      skipCloudLookup: true,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(localGetSources).toHaveBeenCalledOnce();
    expect(result.status).toBe('ok');
  });
});
