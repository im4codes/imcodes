import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import { replicatePendingProcessedContext } from '../../src/context/processed-context-replication.js';
import {
  getReplicationState,
  resetContextStoreForTests,
  setReplicationState,
  writeProcessedProjection,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

describe('processed-context replication', () => {
  let tempDir: string;
  let namespace: ContextNamespace;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('processed-context-replication');
    namespace = { scope: 'project_shared', projectId: 'github.com/acme/repo', enterpriseId: 'ent-1' };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('replicates pending local projections and clears replication backlog on success', async () => {
    const projection = writeProcessedProjection({
      namespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'summary',
      content: { trigger: 'idle' },
      createdAt: 100,
      updatedAt: 110,
    });
    setReplicationState(namespace, {
      pendingProjectionIds: [projection.id],
      lastError: 'stale-error',
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const result = await replicatePendingProcessedContext({
      workerUrl: 'http://localhost:3000',
      serverId: 'srv-1',
      token: 'daemon-token',
    });

    expect(result).toEqual({
      replicatedNamespaces: 1,
      replicatedProjections: 1,
      failures: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/server/srv-1/shared-context/processed',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer daemon-token',
        }),
      }),
    );
    expect(getReplicationState(namespace)).toEqual(expect.objectContaining({
      namespace,
      pendingProjectionIds: [],
      lastError: undefined,
      lastReplicatedAt: expect.any(Number),
    }));
  });

  it('preserves pending projections and records lastError when replication fails', async () => {
    const projection = writeProcessedProjection({
      namespace,
      class: 'durable_memory_candidate',
      sourceEventIds: ['evt-2'],
      summary: 'decision',
      content: { kind: 'decision' },
      createdAt: 200,
      updatedAt: 210,
    });
    setReplicationState(namespace, {
      pendingProjectionIds: [projection.id],
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const result = await replicatePendingProcessedContext({
      workerUrl: 'http://localhost:3000',
      serverId: 'srv-1',
      token: 'daemon-token',
    });

    expect(result.replicatedNamespaces).toBe(0);
    expect(result.failures).toEqual([
      {
        namespace,
        error: 'processed_remote_replication_failed:503',
      },
    ]);
    expect(getReplicationState(namespace)).toEqual({
      namespace,
      pendingProjectionIds: [projection.id],
      lastError: 'processed_remote_replication_failed:503',
      lastReplicatedAt: undefined,
    });
  });
});
