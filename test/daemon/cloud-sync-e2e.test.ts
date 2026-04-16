/**
 * End-to-end tests for personal memory cloud sync.
 *
 * Covers the full lifecycle: config toggle → materialization queue →
 * replication POST → ACK verification → re-queue on missing data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace, ProcessedContextReplicationBody } from '../../shared/context-types.js';
import { setContextModelRuntimeConfig, getContextModelConfig } from '../../src/context/context-model-config.js';
import {
  replicatePendingProcessedContext,
  requeueAllForReplication,
} from '../../src/context/processed-context-replication.js';
import {
  getReplicationState,
  setReplicationState,
  writeProcessedProjection,
  listReplicationStates,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';
import { normalizeSharedContextRuntimeConfig } from '../../shared/shared-context-runtime-config.js';

const CREDS = { workerUrl: 'https://test.im.codes', serverId: 'srv-test', token: 'tok-test' };

function personalNs(projectId = 'github.com/user/repo'): ContextNamespace {
  return { scope: 'personal', projectId };
}

function sharedNs(projectId = 'github.com/user/repo'): ContextNamespace {
  return { scope: 'project_shared', projectId, enterpriseId: 'ent-1' };
}

function writeSummary(namespace: ContextNamespace, summary = 'test summary') {
  return writeProcessedProjection({
    namespace,
    class: 'recent_summary',
    sourceEventIds: [`evt-${Date.now()}`],
    summary,
    content: { trigger: 'idle' },
  });
}

function writeDurable(namespace: ContextNamespace, summary = 'test decision') {
  return writeProcessedProjection({
    namespace,
    class: 'durable_memory_candidate',
    sourceEventIds: [`evt-${Date.now()}`],
    summary,
    content: { kind: 'decision' },
  });
}

/** Build a mock fetch that returns a proper ACK with projectionCount. */
function mockFetchWithAck() {
  const calls: Array<{ url: string; body: ProcessedContextReplicationBody }> = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as ProcessedContextReplicationBody;
    calls.push({ url, body });
    return {
      ok: true,
      json: async () => ({ ok: true, projectionCount: body.projections.length, replicatedAt: Date.now() }),
      text: async () => '',
    };
  });
  vi.stubGlobal('fetch', fetchFn);
  return { fetchFn, calls };
}

describe('personal memory cloud sync e2e', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('cloud-sync-e2e');
    setContextModelRuntimeConfig(null);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    setContextModelRuntimeConfig(null);
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  // ── Config toggle gate ────────────────────────────────────────────────

  it('blocks personal replication when enablePersonalMemorySync is false (default)', async () => {
    const ns = personalNs();
    const p = writeSummary(ns);
    setReplicationState(ns, { pendingProjectionIds: [p.id] });

    const { fetchFn } = mockFetchWithAck();

    const result = await replicatePendingProcessedContext(CREDS);

    expect(result.replicatedProjections).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
    // Pending IDs must be preserved so they replicate once enabled
    expect(getReplicationState(ns)?.pendingProjectionIds).toEqual([p.id]);
  });

  it('allows personal replication when enablePersonalMemorySync is true', async () => {
    const ns = personalNs();
    const p = writeSummary(ns);
    setReplicationState(ns, { pendingProjectionIds: [p.id] });

    setContextModelRuntimeConfig({ enablePersonalMemorySync: true });
    const { fetchFn, calls } = mockFetchWithAck();

    const result = await replicatePendingProcessedContext(CREDS);

    expect(result.replicatedProjections).toBe(1);
    expect(result.replicatedNamespaces).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(calls[0].body.namespace.scope).toBe('personal');
    expect(calls[0].body.projections).toHaveLength(1);
    expect(calls[0].body.projections[0].id).toBe(p.id);
    // Pending cleared after success
    expect(getReplicationState(ns)?.pendingProjectionIds).toEqual([]);
  });

  it('always allows shared (non-personal) replication regardless of sync flag', async () => {
    const ns = sharedNs();
    const p = writeSummary(ns);
    setReplicationState(ns, { pendingProjectionIds: [p.id] });

    // enablePersonalMemorySync is false (default)
    const { fetchFn } = mockFetchWithAck();

    const result = await replicatePendingProcessedContext(CREDS);

    expect(result.replicatedProjections).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // ── Config apply handler (the bug that was fixed) ─────────────────────

  it('handleSharedContextRuntimeConfigApply preserves enablePersonalMemorySync', async () => {
    // Simulate what the daemon handler does with the WS config message
    const normalized = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5',
      enablePersonalMemorySync: true,
    });
    setContextModelRuntimeConfig(normalized);

    const config = getContextModelConfig();
    expect(config.enablePersonalMemorySync).toBe(true);
  });

  it('normalizeSharedContextRuntimeConfig defaults enablePersonalMemorySync to false', () => {
    const normalized = normalizeSharedContextRuntimeConfig({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5',
      // enablePersonalMemorySync omitted
    });
    expect(normalized.enablePersonalMemorySync).toBe(false);
  });

  // ── ACK verification ──────────────────────────────────────────────────

  it('verifies server ACK projectionCount matches sent count', async () => {
    const ns = personalNs();
    const p1 = writeSummary(ns, 'summary 1');
    const p2 = writeDurable(ns, 'decision 1');
    setReplicationState(ns, { pendingProjectionIds: [p1.id, p2.id] });
    setContextModelRuntimeConfig({ enablePersonalMemorySync: true });

    const { calls } = mockFetchWithAck();

    const result = await replicatePendingProcessedContext(CREDS);

    expect(result.replicatedProjections).toBe(2);
    expect(calls[0].body.projections).toHaveLength(2);
    // Pending fully cleared
    expect(getReplicationState(ns)?.pendingProjectionIds).toEqual([]);
  });

  it('records error in replication state when server returns non-OK with response body', async () => {
    const ns = personalNs();
    const p = writeSummary(ns);
    setReplicationState(ns, { pendingProjectionIds: [p.id] });
    setContextModelRuntimeConfig({ enablePersonalMemorySync: true });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '{"error":"db_unavailable"}',
    }));

    const result = await replicatePendingProcessedContext(CREDS);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain('500');
    expect(result.failures[0].error).toContain('db_unavailable');
    // Pending preserved for retry
    expect(getReplicationState(ns)?.pendingProjectionIds).toEqual([p.id]);
    expect(getReplicationState(ns)?.lastError).toContain('500');
  });

  // ── Re-queue all ──────────────────────────────────────────────────────

  it('requeueAllForReplication re-populates pending IDs from all local projections', async () => {
    const ns1 = personalNs('repo-a');
    const ns2 = personalNs('repo-b');
    const p1 = writeSummary(ns1, 'a');
    const p2 = writeSummary(ns2, 'b');
    const p3 = writeDurable(ns2, 'c');

    // Mark as already replicated (empty pending)
    setReplicationState(ns1, { pendingProjectionIds: [], lastReplicatedAt: 1000 });
    setReplicationState(ns2, { pendingProjectionIds: [], lastReplicatedAt: 2000 });

    const requeued = requeueAllForReplication();

    expect(requeued).toBe(3);
    expect(getReplicationState(ns1)?.pendingProjectionIds).toEqual([p1.id]);
    expect(getReplicationState(ns2)?.pendingProjectionIds).toContain(p2.id);
    expect(getReplicationState(ns2)?.pendingProjectionIds).toContain(p3.id);
    // Preserves lastReplicatedAt
    expect(getReplicationState(ns1)?.lastReplicatedAt).toBe(1000);
  });

  it('requeueAllForReplication + replicatePending sends all projections to server', async () => {
    const ns = personalNs();
    const p1 = writeSummary(ns, 'old summary');
    const p2 = writeDurable(ns, 'old decision');
    // Already "replicated" (pending empty)
    setReplicationState(ns, { pendingProjectionIds: [], lastReplicatedAt: 500 });

    setContextModelRuntimeConfig({ enablePersonalMemorySync: true });
    const { calls } = mockFetchWithAck();

    // First: nothing to replicate
    const before = await replicatePendingProcessedContext(CREDS);
    expect(before.replicatedProjections).toBe(0);

    // Re-queue
    requeueAllForReplication();

    // Now: both projections get sent
    const after = await replicatePendingProcessedContext(CREDS);
    expect(after.replicatedProjections).toBe(2);
    expect(calls).toHaveLength(1);
    const sentIds = calls[0].body.projections.map((p) => p.id).sort();
    expect(sentIds).toEqual([p1.id, p2.id].sort());
  });

  // ── Multi-namespace replication ───────────────────────────────────────

  it('replicates multiple namespaces in a single poller cycle', async () => {
    const ns1 = personalNs('repo-1');
    const ns2 = personalNs('repo-2');
    const ns3 = sharedNs('repo-3');
    const p1 = writeSummary(ns1);
    const p2 = writeSummary(ns2);
    const p3 = writeDurable(ns3);
    setReplicationState(ns1, { pendingProjectionIds: [p1.id] });
    setReplicationState(ns2, { pendingProjectionIds: [p2.id] });
    setReplicationState(ns3, { pendingProjectionIds: [p3.id] });

    setContextModelRuntimeConfig({ enablePersonalMemorySync: true });
    const { calls } = mockFetchWithAck();

    const result = await replicatePendingProcessedContext(CREDS);

    expect(result.replicatedNamespaces).toBe(3);
    expect(result.replicatedProjections).toBe(3);
    expect(calls).toHaveLength(3);

    // All pending cleared
    for (const ns of [ns1, ns2, ns3]) {
      expect(getReplicationState(ns)?.pendingProjectionIds).toEqual([]);
    }
  });

  it('partial failure: one namespace fails, others succeed', async () => {
    const nsOk = personalNs('repo-ok');
    const nsFail = personalNs('repo-fail');
    const p1 = writeSummary(nsOk);
    const p2 = writeSummary(nsFail);
    setReplicationState(nsOk, { pendingProjectionIds: [p1.id] });
    setReplicationState(nsFail, { pendingProjectionIds: [p2.id] });

    setContextModelRuntimeConfig({ enablePersonalMemorySync: true });

    let callIdx = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      callIdx++;
      const body = JSON.parse(String(init?.body)) as ProcessedContextReplicationBody;
      if (body.namespace.projectId === 'repo-fail') {
        return { ok: false, status: 503, text: async () => 'service unavailable' };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, projectionCount: body.projections.length }),
        text: async () => '',
      };
    }));

    const result = await replicatePendingProcessedContext(CREDS);

    expect(result.replicatedNamespaces).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].namespace.projectId).toBe('repo-fail');
    // OK namespace cleared
    expect(getReplicationState(nsOk)?.pendingProjectionIds).toEqual([]);
    // Failed namespace preserved
    expect(getReplicationState(nsFail)?.pendingProjectionIds).toEqual([p2.id]);
    expect(getReplicationState(nsFail)?.lastError).toContain('503');
  });

  // ── Toggle ON triggers requeue (the fix in command-handler) ───────────

  it('enabling personal sync re-queues all personal projections', async () => {
    const ns = personalNs();
    const p1 = writeSummary(ns);
    const p2 = writeDurable(ns);
    // Previously "replicated" while sync was off (bug scenario)
    setReplicationState(ns, { pendingProjectionIds: [], lastReplicatedAt: 100 });

    // Simulate the daemon handler: was off, now on
    setContextModelRuntimeConfig({ enablePersonalMemorySync: false });
    expect(getContextModelConfig().enablePersonalMemorySync).toBe(false);

    // Toggle on + requeue (what command-handler does now)
    setContextModelRuntimeConfig({ enablePersonalMemorySync: true });
    const requeued = requeueAllForReplication();

    expect(requeued).toBe(2);
    expect(getReplicationState(ns)?.pendingProjectionIds).toContain(p1.id);
    expect(getReplicationState(ns)?.pendingProjectionIds).toContain(p2.id);

    // Now replication sends them
    const { calls } = mockFetchWithAck();
    const result = await replicatePendingProcessedContext(CREDS);
    expect(result.replicatedProjections).toBe(2);
    expect(calls).toHaveLength(1);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('handles missing local projections gracefully', async () => {
    const ns = personalNs();
    // Pending ID references a projection that was deleted locally
    setReplicationState(ns, { pendingProjectionIds: ['nonexistent-id'] });
    setContextModelRuntimeConfig({ enablePersonalMemorySync: true });

    const { fetchFn } = mockFetchWithAck();

    const result = await replicatePendingProcessedContext(CREDS);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toBe('pending_projection_missing_locally');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('no-ops when there are no pending projections', async () => {
    setContextModelRuntimeConfig({ enablePersonalMemorySync: true });
    const { fetchFn } = mockFetchWithAck();

    const result = await replicatePendingProcessedContext(CREDS);

    expect(result.replicatedProjections).toBe(0);
    expect(result.failures).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('requeueAllForReplication returns 0 when no local projections exist', () => {
    const requeued = requeueAllForReplication();
    expect(requeued).toBe(0);
    expect(listReplicationStates()).toEqual([]);
  });
});
