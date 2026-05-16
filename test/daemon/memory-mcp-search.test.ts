import { describe, expect, it, vi } from 'vitest';
import { searchMcpMemoryRecall } from '../../src/daemon/memory-mcp-search.js';
import { writeProcessedProjection } from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

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
          body: JSON.stringify({ query: 'MCP recall memory', projectId: 'repo-1', limit: 5 }),
        }),
      );
      const requestBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
      expect(requestBody).not.toHaveProperty('userId');
      expect(requestBody).not.toHaveProperty('namespace');
      expect(result.items[0]).toMatchObject({
        projectionId: 'cloud-proj-1',
        summary: 'Cloud MCP recall memory',
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
});
