import { describe, expect, it, vi } from 'vitest';
import { searchMcpMemoryRecall } from '../../src/daemon/memory-mcp-search.js';
import { writeProcessedProjection } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';
import { projectionOwnerCache } from '../../src/daemon/memory-projection-owner-cache.js';

const generateEmbeddingMock = vi.hoisted(() => vi.fn(async () => new Float32Array([1])));

vi.mock('../../src/context/embedding.js', () => ({
  generateEmbedding: generateEmbeddingMock,
  cosineSimilarity: (_query: Float32Array, emb: Float32Array) => emb[0] ?? 0,
  encodeEmbedding: (vec: Float32Array) => Buffer.from(new Uint8Array(vec.buffer.slice(0))),
  decodeEmbedding: (_buf: Buffer | null) => null,
}));

describe('memory MCP recall search', () => {
  it('queries cloud memory recall with daemon server credentials and merges local recall fallback', async () => {
    const tempDir = await createIsolatedSharedContextDb('memory-mcp-search');
    try {
      writeProcessedProjection({
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        class: 'recent_summary',
        sourceEventIds: ['evt-local'],
        summary: 'Local MCP fallback memory',
        content: {},
        updatedAt: 100,
      });
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        results: [
          {
            id: 'cloud-proj-1',
            projectId: 'repo-1',
            class: 'recent_summary',
            summary: 'Cloud MCP recall memory',
            updatedAt: 200,
            score: 0.91,
            matchKind: 'exact',
            source: 'personal',
          },
        ],
        vectorSearch: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

      const result = await searchMcpMemoryRecall({
        query: 'MCP recall memory',
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        repo: 'repo-1',
        includeLegacyPersonalOwner: true,
        limit: 5,
      }, {
        fetchImpl,
        credentials: {
          workerUrl: 'https://app.example.test/',
          serverId: 'srv-1',
          token: 'server-token',
        },
      });

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://app.example.test/api/shared-context/srv-1/shared-context/memory/recall',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer server-token',
            'X-Server-Id': 'srv-1',
          }),
          body: JSON.stringify({ query: 'MCP recall memory', projectId: 'repo-1', limit: 5, mode: 'search' }),
        }),
      );
      const requestBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(requestBody).not.toHaveProperty('userId');
      expect(requestBody).not.toHaveProperty('namespace');
      expect(result.items[0]).toMatchObject({
        projectionId: 'cloud-proj-1',
        summary: 'Cloud MCP recall memory',
        matchKind: 'exact',
        source: 'cloud',
      });
      expect(result.items.some((item) => item.summary === 'Local MCP fallback memory')).toBe(true);
    } finally {
      await cleanupIsolatedSharedContextDb(tempDir);
    }
  });

  it('falls back to local recall when cloud credentials are unavailable', async () => {
    const tempDir = await createIsolatedSharedContextDb('memory-mcp-search-local');
    try {
      writeProcessedProjection({
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        class: 'recent_summary',
        sourceEventIds: ['evt-local'],
        summary: 'Only local recall memory',
        content: {},
        updatedAt: 100,
      });

      const result = await searchMcpMemoryRecall({
        query: 'local recall',
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        repo: 'repo-1',
        includeLegacyPersonalOwner: true,
        limit: 5,
      }, {
        credentials: null,
      });

      expect(result.items.map((item) => item.summary)).toContain('Only local recall memory');
      expect(result.items.every((item) => item.source === 'local')).toBe(true);
    } finally {
      await cleanupIsolatedSharedContextDb(tempDir);
    }
  });

  it('drops cloud recall rows outside the caller project', async () => {
    const tempDir = await createIsolatedSharedContextDb('memory-mcp-search-cloud-project');
    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        results: [
          {
            id: 'cloud-other-project',
            projectId: 'repo-2',
            class: 'recent_summary',
            summary: 'Other project cloud memory must not cross into repo one.',
            updatedAt: 300,
            score: 0.99,
            source: 'personal',
          },
          {
            id: 'cloud-own-project',
            projectId: 'repo-1',
            class: 'recent_summary',
            summary: 'Own project cloud memory is allowed.',
            updatedAt: 200,
            score: 0.9,
            source: 'personal',
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

      const result = await searchMcpMemoryRecall({
        query: 'project cloud memory',
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        repo: 'repo-1',
        includeLegacyPersonalOwner: true,
        limit: 5,
      }, {
        fetchImpl,
        credentials: {
          workerUrl: 'https://app.example.test',
          serverId: 'srv-1',
          token: 'server-token',
        },
      });

      expect(result.items.map((item) => item.projectionId)).toContain('cloud-own-project');
      expect(result.items.map((item) => item.projectionId)).not.toContain('cloud-other-project');
    } finally {
      await cleanupIsolatedSharedContextDb(tempDir);
    }
  });

  // ── originServerId threading (memory-source-server-routing change) ──
  //
  // Once cross-server source resolution lands, the daemon's MCP search must
  // surface the originating daemon for every hit so callers can route
  // `get_memory_sources` back to the machine whose SQLite holds the raw
  // events. Cloud hits use the value the server attached; local hits use
  // the local daemon's bound serverId.

  it('propagates server-supplied originServerId on cloud hits', async () => {
    const tempDir = await createIsolatedSharedContextDb('memory-mcp-search-origin-cloud');
    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        results: [
          {
            id: 'cloud-from-srv-A',
            projectId: 'repo-1',
            class: 'recent_summary',
            summary: 'Hit produced by another daemon',
            updatedAt: 200,
            score: 0.91,
            source: 'personal',
            originServerId: 'srv-A',
          },
          {
            id: 'cloud-from-srv-B',
            projectId: 'repo-1',
            class: 'recent_summary',
            summary: 'Hit produced by yet another daemon',
            updatedAt: 210,
            score: 0.92,
            source: 'personal',
            originServerId: 'srv-B',
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

      const result = await searchMcpMemoryRecall({
        query: 'origin server tagging',
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        repo: 'repo-1',
        includeLegacyPersonalOwner: true,
        limit: 5,
      }, {
        fetchImpl,
        credentials: {
          workerUrl: 'https://app.example.test',
          serverId: 'srv-self',
          token: 'server-token',
        },
      });

      const byId = Object.fromEntries(result.items.map((item) => [item.projectionId, item]));
      expect(byId['cloud-from-srv-A']?.originServerId).toBe('srv-A');
      expect(byId['cloud-from-srv-B']?.originServerId).toBe('srv-B');
      expect(byId['cloud-from-srv-A']?.source).toBe('cloud');
    } finally {
      await cleanupIsolatedSharedContextDb(tempDir);
    }
  });

  it('stamps local-source hits with the local daemon serverId', async () => {
    const tempDir = await createIsolatedSharedContextDb('memory-mcp-search-origin-local');
    try {
      writeProcessedProjection({
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        class: 'recent_summary',
        sourceEventIds: ['evt-local-1'],
        summary: 'Local memory must carry the local serverId',
        content: {},
        updatedAt: 300,
      });

      const result = await searchMcpMemoryRecall({
        query: 'local memory must carry',
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        repo: 'repo-1',
        includeLegacyPersonalOwner: true,
        limit: 5,
      }, {
        credentials: {
          workerUrl: 'https://app.example.test',
          serverId: 'srv-self',
          token: 'server-token',
        },
        // No fetchImpl supplied — cloud path stays empty and we exercise
        // only the local-stamping behavior.
        fetchImpl: (vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch),
      });

      const localHit = result.items.find((item) => item.source === 'local');
      expect(localHit?.originServerId).toBe('srv-self');
    } finally {
      await cleanupIsolatedSharedContextDb(tempDir);
    }
  });

  it('omits originServerId on local hits when daemon credentials are unavailable', async () => {
    const tempDir = await createIsolatedSharedContextDb('memory-mcp-search-origin-no-creds');
    try {
      writeProcessedProjection({
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        class: 'recent_summary',
        sourceEventIds: ['evt-local-1'],
        summary: 'Unbound daemon should still serve local recall',
        content: {},
        updatedAt: 300,
      });

      const result = await searchMcpMemoryRecall({
        query: 'unbound daemon should still',
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        repo: 'repo-1',
        includeLegacyPersonalOwner: true,
        limit: 5,
      }, {
        credentials: null,
      });

      // The hit must still be present (unchanged from prior behavior); only
      // originServerId is omitted because we have nothing to stamp.
      const localHit = result.items.find((item) => item.source === 'local');
      expect(localHit).toBeDefined();
      expect(localHit?.originServerId).toBeUndefined();
    } finally {
      await cleanupIsolatedSharedContextDb(tempDir);
    }
  });

  it('tolerates servers that have not yet rolled out originServerId', async () => {
    const tempDir = await createIsolatedSharedContextDb('memory-mcp-search-origin-legacy-server');
    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        results: [
          {
            // No originServerId — older server build.
            id: 'cloud-legacy',
            projectId: 'repo-1',
            class: 'recent_summary',
            summary: 'Legacy server response without originServerId',
            updatedAt: 200,
            score: 0.91,
            source: 'personal',
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

      const result = await searchMcpMemoryRecall({
        query: 'legacy server response',
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        repo: 'repo-1',
        includeLegacyPersonalOwner: true,
        limit: 5,
      }, {
        fetchImpl,
        credentials: {
          workerUrl: 'https://app.example.test',
          serverId: 'srv-self',
          token: 'server-token',
        },
      });

      const cloudHit = result.items.find((item) => item.projectionId === 'cloud-legacy');
      expect(cloudHit).toBeDefined();
      // No fabricated value — origin stays undefined when the server didn't
      // supply one. We must NOT fall back to the local serverId here.
      expect(cloudHit?.originServerId).toBeUndefined();
    } finally {
      await cleanupIsolatedSharedContextDb(tempDir);
    }
  });

  it('keeps local fallback scoped to the caller project and user', async () => {
    const tempDir = await createIsolatedSharedContextDb('memory-mcp-search-local-scope');
    try {
      writeProcessedProjection({
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        class: 'recent_summary',
        sourceEventIds: ['evt-own'],
        summary: 'Scoped local memory for repo one and daemon local user',
        content: {},
        updatedAt: 300,
      });
      writeProcessedProjection({
        namespace: { scope: 'personal', projectId: 'repo-2', userId: 'daemon-local' },
        class: 'recent_summary',
        sourceEventIds: ['evt-other-project'],
        summary: 'Cross project local memory must not appear',
        content: {},
        updatedAt: 200,
      });
      writeProcessedProjection({
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'other-user' },
        class: 'recent_summary',
        sourceEventIds: ['evt-other-user'],
        summary: 'Cross user local memory must not appear',
        content: {},
        updatedAt: 100,
      });

      const result = await searchMcpMemoryRecall({
        query: 'local memory',
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        repo: 'repo-1',
        includeLegacyPersonalOwner: true,
        limit: 10,
      }, {
        credentials: null,
      });

      expect(result.items.map((item) => item.summary)).toContain('Scoped local memory for repo one and daemon local user');
      expect(result.items.map((item) => item.summary)).not.toContain('Cross project local memory must not appear');
      expect(result.items.map((item) => item.summary)).not.toContain('Cross user local memory must not appear');
    } finally {
      await cleanupIsolatedSharedContextDb(tempDir);
    }
  });

  // ── cache-side-effect (memory-source-server-routing) ──────────────────
  //
  // searchMcpMemoryRecall populates the process-local projectionOwnerCache
  // as a side effect of returning hits. This is what lets the
  // `get_memory_sources` orchestrator skip the cloud projection-owner round
  // trip for any projectionId the agent just received via search. If a
  // future refactor stops populating the cache, the orchestrator silently
  // falls back to its cloud lookup — no correctness bug, just a needless
  // round trip. Pin the behavior so a regression is loud.

  it('populates projectionOwnerCache for every hit that carries an originServerId', async () => {
    const tempDir = await createIsolatedSharedContextDb('memory-mcp-search-cache-side-effect');
    try {
      writeProcessedProjection({
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        class: 'recent_summary',
        sourceEventIds: ['evt-local'],
        summary: 'Local hit must seed cache with self serverId',
        content: {},
        updatedAt: 100,
      });

      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        results: [
          {
            id: 'cloud-from-srv-A',
            projectId: 'repo-1',
            class: 'recent_summary',
            summary: 'Cloud hit must seed cache with srv-A',
            updatedAt: 200,
            score: 0.91,
            source: 'personal',
            originServerId: 'srv-A',
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

      // Seed the cache with stale data so we can detect overwrites.
      projectionOwnerCache.delete('cloud-from-srv-A');
      projectionOwnerCache.delete(/* placeholder for the projection id we'll learn */ 'x');

      const result = await searchMcpMemoryRecall({
        query: 'cache side effect',
        namespace: { scope: 'personal', projectId: 'repo-1', userId: 'daemon-local' },
        repo: 'repo-1',
        includeLegacyPersonalOwner: true,
        limit: 5,
      }, {
        fetchImpl,
        credentials: {
          workerUrl: 'https://app.example.test',
          serverId: 'srv-self',
          token: 'server-token',
        },
      });

      const localHit = result.items.find((item) => item.source === 'local');
      const cloudHit = result.items.find((item) => item.projectionId === 'cloud-from-srv-A');
      expect(localHit).toBeDefined();
      expect(cloudHit).toBeDefined();

      // Cloud hit → cache entry under the server-supplied originServerId.
      expect(projectionOwnerCache.get('cloud-from-srv-A')).toBe('srv-A');
      // Local hit → cache entry under the local daemon's bound serverId.
      expect(projectionOwnerCache.get(localHit!.projectionId)).toBe('srv-self');
    } finally {
      await cleanupIsolatedSharedContextDb(tempDir);
    }
  });
});
