import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';
import { replicatePendingProcessedContext } from '../../src/context/processed-context-replication.js';
import {
  getReplicationState,
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
    setContextModelRuntimeConfig(null);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    setContextModelRuntimeConfig(null);
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

  it('skips personal replication unless personal cloud sync is enabled', async () => {
    const personalNamespace: ContextNamespace = { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-1' };
    const projection = writeProcessedProjection({
      namespace: personalNamespace,
      class: 'recent_summary',
      sourceEventIds: ['evt-1'],
      summary: 'personal summary',
      content: { note: 'only replicate when enabled' },
      createdAt: 300,
      updatedAt: 310,
    });
    setReplicationState(personalNamespace, {
      pendingProjectionIds: [projection.id],
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const skipped = await replicatePendingProcessedContext({
      workerUrl: 'http://localhost:3000',
      serverId: 'srv-1',
      token: 'daemon-token',
    });
    expect(skipped).toEqual({
      replicatedNamespaces: 0,
      replicatedProjections: 0,
      failures: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getReplicationState(personalNamespace)).toEqual({
      namespace: personalNamespace,
      pendingProjectionIds: [projection.id],
      lastError: undefined,
      lastReplicatedAt: undefined,
    });

    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      enablePersonalMemorySync: true,
    });

    const replicated = await replicatePendingProcessedContext({
      workerUrl: 'http://localhost:3000',
      serverId: 'srv-1',
      token: 'daemon-token',
    });
    expect(replicated).toEqual({
      replicatedNamespaces: 1,
      replicatedProjections: 1,
      failures: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getReplicationState(personalNamespace)).toEqual(expect.objectContaining({
      namespace: personalNamespace,
      pendingProjectionIds: [],
      lastError: undefined,
      lastReplicatedAt: expect.any(Number),
    }));
  });
});
