import { describe, expect, it, vi } from 'vitest';
import { USAGE_ANALYTICS_SCHEMA_VERSION } from '../../shared/usage-analytics.js';
import { createUsageSyncWorker } from '../../src/daemon/usage-sync-worker.js';
import type { ContextStoreWorkerClient } from '../../src/store/context-store-worker-client.js';
import type { TurnUsageSyncRecord } from '../../src/store/context-store.js';

const fact = {
  usageFactId: 'usage:authority:1',
  createdAtMs: 1_700_000_000_000,
  sessionName: 'deck_app_brain',
  sessionKind: 'main' as const,
  parentSessionName: null,
  metadataCompleteness: 'complete' as const,
  provider: 'openai',
  agentType: 'codex-sdk',
  model: 'gpt-5',
  inputTokens: 1,
  cacheTokens: 2,
  outputTokens: 3,
  totalTokens: 6,
  contextWindow: 200_000,
  costUsdMicros: null,
  sourceEventId: 'evt_1',
};

function syncRecord(id: string): TurnUsageSyncRecord {
  return {
    turnUsageRowid: Number(id.split(':').at(-1)),
    usageAuthorityId: 'authority',
    usageFactId: id,
    payloadHash: `hash-${id}`,
    syncStatus: 'pending',
    retryCount: 0,
    nextAttemptAtMs: null,
    lastAttemptAtMs: null,
    syncedAtMs: null,
    lastErrorReason: null,
    terminalReason: null,
    metadataCompleteness: 'complete',
    createdAtMs: fact.createdAtMs,
    updatedAtMs: fact.createdAtMs,
    fact: { ...fact, usageFactId: id },
  };
}

function storeClientFor(batch: TurnUsageSyncRecord[]) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const client = {
    async run(op: string, args: unknown[] = []) {
      calls.push({ op, args });
      if (op === 'selectTurnUsageSyncBatch') return batch;
      if (op === 'getTurnUsageSyncDiagnostics') return { pendingCount: 0 };
      return { updated: batch.length };
    },
  } as unknown as ContextStoreWorkerClient;
  return { client, calls };
}

describe('usage sync worker', () => {
  it('uploads selected facts to path-scoped ingest and records per-fact statuses', async () => {
    const batch = [syncRecord('usage:authority:1')];
    const { client, calls } = storeClientFor(batch);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
      results: [{ usageFactId: batch[0].usageFactId, status: 'accepted' }],
    }), { status: 200 }));
    const worker = createUsageSyncWorker({
      workerUrl: 'https://example.test/',
      serverId: 'server_1',
      token: 'secret-token',
      storeClient: client,
      fetchImpl,
    });

    const outcome = await worker.syncOnce('test');

    expect(outcome).toEqual({ ok: true, uploaded: 1 });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/api/server/server_1/token-usage/ingest',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
          'x-server-id': 'server_1',
        }),
      }),
    );
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.facts[0]).toMatchObject({ usageFactId: batch[0].usageFactId, inputTokens: 1 });
    expect(calls.some((call) => call.op === 'recordTurnUsageSyncResults')).toBe(true);
  });

  it('maps request-level transient failures to retryable local failures', async () => {
    const batch = [syncRecord('usage:authority:1')];
    const { client, calls } = storeClientFor(batch);
    const worker = createUsageSyncWorker({
      workerUrl: 'https://example.test',
      serverId: 'server_1',
      token: 'secret-token',
      storeClient: client,
      fetchImpl: vi.fn(async () => new Response('rate limited', { status: 429 })),
    });

    const outcome = await worker.syncOnce('test');

    expect(outcome.ok).toBe(false);
    expect(outcome.retryable).toBe(true);
    const failureCall = calls.find((call) => call.op === 'recordTurnUsageSyncRequestFailure');
    expect(failureCall?.args[0]).toMatchObject({
      retryable: true,
      reason: 'rate_limited',
      usageFactIds: [batch[0].usageFactId],
    });
  });

  it.each([
    [401, 'auth_failed'],
    [500, 'server_unavailable'],
  ])('keeps facts retryable for request status %s', async (status, reason) => {
    const batch = [syncRecord('usage:authority:1')];
    const { client, calls } = storeClientFor(batch);
    const worker = createUsageSyncWorker({
      workerUrl: 'https://example.test',
      serverId: 'server_1',
      token: 'old-or-transient-token',
      storeClient: client,
      fetchImpl: vi.fn(async () => new Response('retry later', { status })),
    });

    const outcome = await worker.syncOnce('test');

    expect(outcome).toMatchObject({ ok: false, retryable: true, reason });
    const failureCall = calls.find((call) => call.op === 'recordTurnUsageSyncRequestFailure');
    expect(failureCall?.args[0]).toMatchObject({
      retryable: true,
      reason,
      usageFactIds: [batch[0].usageFactId],
    });
  });

  it('uses refreshed credentials after auth failure without terminalizing rows', async () => {
    const batch = [syncRecord('usage:authority:1')];
    const { client, calls } = storeClientFor(batch);
    let token = 'old-token';
    const fetchImpl = vi.fn(async () => {
      if (token === 'old-token') {
        return new Response('old token rejected', { status: 401 });
      }
      return new Response(JSON.stringify({
        schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
        results: [{ usageFactId: batch[0].usageFactId, status: 'accepted' }],
      }), { status: 200 });
    });
    const worker = createUsageSyncWorker({
      workerUrl: 'https://example.test',
      serverId: 'server_1',
      token: 'old-token',
      credentialsProvider: () => ({
        workerUrl: 'https://example.test',
        serverId: 'server_1',
        token,
      }),
      storeClient: client,
      fetchImpl,
    });

    const first = await worker.syncOnce('auth-failed');
    token = 'new-token';
    const second = await worker.syncOnce('refreshed');

    expect(first).toMatchObject({ ok: false, retryable: true, reason: 'auth_failed' });
    expect(second).toEqual({ ok: true, uploaded: 1 });
    expect(fetchImpl.mock.calls[0][1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer old-token' }),
    }));
    expect(fetchImpl.mock.calls[1][1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer new-token' }),
    }));
    expect(calls.find((call) => call.op === 'recordTurnUsageSyncRequestFailure')?.args[0]).toMatchObject({
      retryable: true,
      reason: 'auth_failed',
    });
    expect(calls.some((call) => call.op === 'recordTurnUsageSyncResults')).toBe(true);
  });

  it.each([
    ['wrong schemaVersion', { schemaVersion: 999, results: [] }],
    ['missing results', { schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION }],
    ['non-object response', []],
  ])('treats 200 %s as request-level retryable schema_invalid', async (_label, body) => {
    const batch = [syncRecord('usage:authority:1')];
    const { client, calls } = storeClientFor(batch);
    const worker = createUsageSyncWorker({
      workerUrl: 'https://example.test',
      serverId: 'server_1',
      token: 'secret-token',
      storeClient: client,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    });

    const outcome = await worker.syncOnce('schema-invalid');

    expect(outcome).toMatchObject({ ok: false, retryable: true, reason: 'schema_invalid' });
    expect(calls.some((call) => call.op === 'recordTurnUsageSyncResults')).toBe(false);
    const failureCall = calls.find((call) => call.op === 'recordTurnUsageSyncRequestFailure');
    expect(failureCall?.args[0]).toMatchObject({
      retryable: true,
      reason: 'schema_invalid',
      usageFactIds: [batch[0].usageFactId],
    });
  });

  it('terminalizes missing per-fact results while allowing later rows to progress', async () => {
    const batch = [syncRecord('usage:authority:1'), syncRecord('usage:authority:2')];
    const { client, calls } = storeClientFor(batch);
    const worker = createUsageSyncWorker({
      workerUrl: 'https://example.test',
      serverId: 'server_1',
      token: 'secret-token',
      storeClient: client,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
        results: [{ usageFactId: batch[1].usageFactId, status: 'duplicate' }],
      }), { status: 200 })),
    });

    await worker.syncOnce('test');

    const resultCall = calls.find((call) => call.op === 'recordTurnUsageSyncResults');
    expect(resultCall?.args[0]).toMatchObject({
      results: [
        { usageFactId: batch[0].usageFactId, status: 'invalid', reason: 'missing_per_fact_result' },
        { usageFactId: batch[1].usageFactId, status: 'duplicate' },
      ],
    });
  });

  it('does not block daemon hot-path operations while HTTP upload is delayed', async () => {
    const batch = [syncRecord('usage:authority:1')];
    let releaseFetch!: () => void;
    let fetchStartedResolve!: () => void;
    let activeStoreWrite = false;
    const observedFetchStarted = new Promise<void>((resolve) => { fetchStartedResolve = resolve; });
    const hotPathDuringUpload = (label: string) => {
      expect(activeStoreWrite, `${label} should run after the sync worker releases local store work`).toBe(false);
      return Promise.resolve({ label, completed: true });
    };
    const worker = createUsageSyncWorker({
      workerUrl: 'https://example.test',
      serverId: 'server_1',
      token: 'secret-token',
      storeClient: {
        async run(op: string) {
          activeStoreWrite = true;
          try {
            if (op === 'selectTurnUsageSyncBatch') return batch;
            if (op === 'getTurnUsageSyncDiagnostics') return { pendingCount: 0 };
            return { updated: 1 };
          } finally {
            activeStoreWrite = false;
          }
        },
      } as unknown as ContextStoreWorkerClient,
      fetchImpl: vi.fn(async () => {
        fetchStartedResolve();
        await new Promise<void>((done) => { releaseFetch = done; });
        return new Response(JSON.stringify({
          schemaVersion: USAGE_ANALYTICS_SCHEMA_VERSION,
          results: [{ usageFactId: batch[0].usageFactId, status: 'accepted' }],
        }), { status: 200 });
      }),
    });

    const syncPromise = worker.syncOnce('test');
    await observedFetchStarted;

    await expect(Promise.all([
      hotPathDuringUpload('recordTurnUsage'),
      hotPathDuringUpload('session.send'),
      hotPathDuringUpload('command.ack'),
      hotPathDuringUpload('session.state'),
    ])).resolves.toEqual([
      { label: 'recordTurnUsage', completed: true },
      { label: 'session.send', completed: true },
      { label: 'command.ack', completed: true },
      { label: 'session.state', completed: true },
    ]);

    releaseFetch();
    await expect(syncPromise).resolves.toEqual({ ok: true, uploaded: 1 });
  });
});
