import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recordTurnUsage,
  summarizeTurnUsage,
  pruneTurnUsage,
  backfillTurnUsageSyncMetadata,
  DEFAULT_USAGE_SYNC_IN_FLIGHT_LEASE_MS,
  ensureTurnUsageSyncMetadata,
  getOrCreateUsageAuthorityId,
  getTurnUsageSyncDiagnostics,
  recoverStaleTurnUsageSyncInFlight,
  recordTurnUsageSyncRequestFailure,
  recordTurnUsageSyncResults,
  resetContextStoreForTests,
  selectTurnUsageSyncBatch,
} from '../../src/store/context-store.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

/**
 * Per-turn SDK usage telemetry — daemon mirrors every `usage.update` timeline
 * event into `context_turn_usage` so operators can answer "which sessions burn
 * the most tokens", "model mix per agent", "avg cost per turn", etc. without
 * parsing the JSONL timeline.
 *
 * This test pins the recording shape, the no-op skip for empty rows, the
 * aggregation query, and the retention sweeper.
 */

describe('per-turn SDK usage recording', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('turn-usage');
  });
  afterEach(async () => {
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('inserts a row with all token fields', () => {
    recordTurnUsage({
      sessionName: 'deck_my_brain',
      agentType: 'codex-sdk',
      model: 'gpt-5-codex',
      inputTokens: 1200,
      cacheTokens: 800,
      outputTokens: 450,
      contextWindow: 200_000,
      costUsd: 0.0123,
      createdAt: 1_700_000_000_000,
    });
    const summary = summarizeTurnUsage();
    expect(summary.total).toBe(1);
    expect(summary.byAgentModel).toHaveLength(1);
    expect(summary.byAgentModel[0]).toMatchObject({
      agentType: 'codex-sdk',
      model: 'gpt-5-codex',
      turns: 1,
      inputTokens: 1200,
      cacheTokens: 800,
      outputTokens: 450,
      costUsd: 0.0123,
    });
  });

  it('skips rows with no token info (model-switch usage.update)', () => {
    // The command-handler `/model` switch emits usage.update with only
    // `{ model, contextWindow }` — those would otherwise pollute analytics.
    recordTurnUsage({
      sessionName: 'deck_my_brain',
      agentType: 'codex-sdk',
      model: 'gpt-5-codex',
    });
    expect(summarizeTurnUsage().total).toBe(0);
  });

  it('keeps cost-only rows even when token counts are zero', () => {
    recordTurnUsage({
      sessionName: 'deck_my_brain',
      agentType: 'codex-sdk',
      model: 'o4-mini',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0.001,
    });
    expect(summarizeTurnUsage().total).toBe(1);
  });

  it('aggregates across multiple turns by agent+model', () => {
    for (let i = 0; i < 3; i++) {
      recordTurnUsage({
        sessionName: 'deck_my_brain',
        agentType: 'claude-code-sdk',
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 50,
      });
    }
    recordTurnUsage({
      sessionName: 'deck_other',
      agentType: 'codex-sdk',
      model: 'gpt-5-codex',
      inputTokens: 200,
      outputTokens: 80,
    });

    const summary = summarizeTurnUsage();
    expect(summary.total).toBe(4);
    expect(summary.byAgentModel).toHaveLength(2);
    const claude = summary.byAgentModel.find((r) => r.model === 'claude-sonnet-4-5')!;
    expect(claude).toMatchObject({ turns: 3, inputTokens: 300, outputTokens: 150 });
    const codex = summary.byAgentModel.find((r) => r.model === 'gpt-5-codex')!;
    expect(codex).toMatchObject({ turns: 1, inputTokens: 200, outputTokens: 80 });
  });

  it('filters by sessionName', () => {
    recordTurnUsage({ sessionName: 'A', model: 'm1', inputTokens: 1, outputTokens: 1 });
    recordTurnUsage({ sessionName: 'B', model: 'm2', inputTokens: 1, outputTokens: 1 });
    expect(summarizeTurnUsage({ sessionName: 'A' }).total).toBe(1);
    expect(summarizeTurnUsage({ sessionName: 'B' }).total).toBe(1);
    expect(summarizeTurnUsage().total).toBe(2);
  });

  it('filters by time window', () => {
    const t0 = 1_700_000_000_000;
    recordTurnUsage({ sessionName: 'A', createdAt: t0,                 inputTokens: 1, outputTokens: 1 });
    recordTurnUsage({ sessionName: 'A', createdAt: t0 + 86_400_000,    inputTokens: 1, outputTokens: 1 });
    recordTurnUsage({ sessionName: 'A', createdAt: t0 + 86_400_000 * 7, inputTokens: 1, outputTokens: 1 });
    const recent = summarizeTurnUsage({ since: t0 + 86_400_000 * 6 });
    expect(recent.total).toBe(1);
  });
});

describe('pruneTurnUsage', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('turn-usage-prune');
  });
  afterEach(async () => {
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('deletes rows older than retention cutoff', () => {
    const t0 = 1_700_000_000_000;
    // 30, 60, 5, 1, 0 days old (relative to "now" = t0)
    recordTurnUsage({ sessionName: 'A', createdAt: t0 - 30 * 86_400_000, inputTokens: 1, outputTokens: 1, eventId: 'old-30' });
    recordTurnUsage({ sessionName: 'A', createdAt: t0 - 60 * 86_400_000, inputTokens: 1, outputTokens: 1, eventId: 'old-60' });
    recordTurnUsage({ sessionName: 'A', createdAt: t0 -  5 * 86_400_000, inputTokens: 1, outputTokens: 1, eventId: 'new-5' });
    recordTurnUsage({ sessionName: 'A', createdAt: t0 -  1 * 86_400_000, inputTokens: 1, outputTokens: 1, eventId: 'new-1' });
    recordTurnUsage({ sessionName: 'A', createdAt: t0,                   inputTokens: 1, outputTokens: 1, eventId: 'new-0' });
    expect(summarizeTurnUsage().total).toBe(5);

    const oldRows = selectTurnUsageSyncBatch({ limit: 5, now: t0 })
      .filter((row) => row.createdAtMs < t0 - 7 * 86_400_000);
    recordTurnUsageSyncResults({
      now: t0,
      results: oldRows.map((row) => ({ usageFactId: row.usageFactId, status: 'accepted' })),
    });

    const result = pruneTurnUsage(7, t0);
    expect(result.deleted).toBe(2);
    expect(summarizeTurnUsage().total).toBe(3);
  });

  it('-1 retention disables pruning', () => {
    recordTurnUsage({ sessionName: 'A', createdAt: 1, inputTokens: 1, outputTokens: 1 });
    expect(pruneTurnUsage(-1).deleted).toBe(0);
    expect(summarizeTurnUsage().total).toBe(1);
  });

  it('rejects out-of-domain retention values', () => {
    recordTurnUsage({ sessionName: 'A', createdAt: 1, inputTokens: 1, outputTokens: 1 });
    expect(pruneTurnUsage(0).deleted).toBe(0);
    expect(pruneTurnUsage(-5).deleted).toBe(0);
    expect(pruneTurnUsage(NaN).deleted).toBe(0);
    expect(summarizeTurnUsage().total).toBe(1);
  });
});

describe('turn usage server sync metadata', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('turn-usage-sync');
  });
  afterEach(async () => {
    resetContextStoreForTests();
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('creates stable daemon-local authority and usage fact ids across restart', () => {
    recordTurnUsage({
      sessionName: 'deck_my_brain',
      agentType: 'codex-sdk',
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 5,
      eventId: 'evt-sync-1',
      createdAt: 1_700_000_000_000,
    });
    const first = ensureTurnUsageSyncMetadata(1);
    expect(first?.usageAuthorityId).toBe(getOrCreateUsageAuthorityId());
    expect(first?.usageFactId).toMatch(/^usage:usage-authority-/);

    resetContextStoreForTests();
    const afterRestart = ensureTurnUsageSyncMetadata(1);
    expect(afterRestart?.usageAuthorityId).toBe(first?.usageAuthorityId);
    expect(afterRestart?.usageFactId).toBe(first?.usageFactId);
    expect(afterRestart?.payloadHash).toBe(first?.payloadHash);
  });

  it('backfills legacy null event rows and keeps duplicate event metadata singular', () => {
    recordTurnUsage({ sessionName: 'legacy', model: 'm', inputTokens: 1, outputTokens: 1 });
    recordTurnUsage({ sessionName: 'legacy', model: 'm', inputTokens: 2, outputTokens: 2 });
    recordTurnUsage({ sessionName: 'dedupe', model: 'm', inputTokens: 3, outputTokens: 3, eventId: 'evt-dup' });
    recordTurnUsage({ sessionName: 'dedupe', model: 'm', inputTokens: 3, outputTokens: 3, eventId: 'evt-dup' });

    expect(backfillTurnUsageSyncMetadata()).toEqual({ backfilled: 0 });
    const batch = selectTurnUsageSyncBatch({ limit: 10, now: 1_700_000_001_000 });
    expect(batch).toHaveLength(3);
    expect(new Set(batch.map((row) => row.usageFactId)).size).toBe(3);
    expect(batch.filter((row) => row.fact.sourceEventId === 'evt-dup')).toHaveLength(1);
  });

  it('does not create sync metadata for model-only usage updates', () => {
    recordTurnUsage({
      sessionName: 'deck_my_brain',
      agentType: 'codex-sdk',
      model: 'gpt-5',
      contextWindow: 200_000,
    });
    expect(selectTurnUsageSyncBatch()).toHaveLength(0);
  });

  it('freezes metadata and cost micros at record time', () => {
    recordTurnUsage({
      sessionName: 'deck_sub_1',
      sessionKind: 'sub',
      parentSessionName: 'deck_main',
      metadataCompleteness: 'complete',
      agentType: 'codex-sdk',
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 4,
      cacheTokens: 1,
      outputTokens: 6,
      contextWindow: 200_000,
      costUsd: 0.0000015,
      eventId: 'evt-freeze',
      createdAt: 1_700_000_000_000,
    });

    const [row] = selectTurnUsageSyncBatch();
    expect(row.fact).toMatchObject({
      sessionName: 'deck_sub_1',
      sessionKind: 'sub',
      parentSessionName: 'deck_main',
      metadataCompleteness: 'complete',
      provider: 'openai',
      agentType: 'codex-sdk',
      model: 'gpt-5',
      inputTokens: 4,
      cacheTokens: 1,
      outputTokens: 6,
      totalTokens: 11,
      contextWindow: 200_000,
      costUsdMicros: 2,
      sourceEventId: 'evt-freeze',
    });
  });

  it('maps per-fact results and request failures to privacy-safe diagnostics', () => {
    recordTurnUsage({ sessionName: 'a', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'a' });
    recordTurnUsage({ sessionName: 'b', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'b' });
    const batch = selectTurnUsageSyncBatch({ limit: 2, now: 100 });

    recordTurnUsageSyncResults({
      now: 200,
      results: [{ usageFactId: batch[0].usageFactId, status: 'accepted' }],
    });
    recordTurnUsageSyncRequestFailure({
      now: 300,
      retryable: true,
      reason: 'server_unavailable',
      usageFactIds: [batch[1].usageFactId],
      nextAttemptAtMs: 1_000,
    });

    const diagnostics = getTurnUsageSyncDiagnostics(400);
    expect(diagnostics.acceptedCount).toBe(1);
    expect(diagnostics.retryCount).toBe(1);
    expect(diagnostics.lastSuccessAtMs).toBe(200);
    expect(diagnostics.lastErrorReason).toBe('server_unavailable');
    expect(JSON.stringify(diagnostics)).not.toContain('prompt');
  });

  it('protects pending and retryable facts from prune while pruning accepted rows', () => {
    const now = 1_700_000_000_000;
    recordTurnUsage({
      sessionName: 'pending',
      createdAt: now - 60 * 86_400_000,
      inputTokens: 1,
      outputTokens: 1,
      eventId: 'pending',
    });
    recordTurnUsage({
      sessionName: 'accepted',
      createdAt: now - 60 * 86_400_000,
      inputTokens: 1,
      outputTokens: 1,
      eventId: 'accepted',
    });
    const batch = selectTurnUsageSyncBatch({ limit: 2, now });
    const accepted = batch.find((row) => row.fact.sessionName === 'accepted')!;
    const pending = batch.find((row) => row.fact.sessionName === 'pending')!;
    recordTurnUsageSyncResults({
      now,
      results: [{ usageFactId: accepted.usageFactId, status: 'accepted' }],
    });
    recordTurnUsageSyncRequestFailure({
      now,
      retryable: true,
      reason: 'server_unavailable',
      usageFactIds: [pending.usageFactId],
      nextAttemptAtMs: now + 60_000,
    });

    expect(pruneTurnUsage(7, now).deleted).toBe(1);
    expect(summarizeTurnUsage().total).toBe(1);
  });

  it('recovers stale in-flight sync rows to retryable without touching active leases', () => {
    const now = 1_700_000_000_000;
    recordTurnUsage({ sessionName: 'stale', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'stale' });
    recordTurnUsage({ sessionName: 'active', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'active' });

    const selected = selectTurnUsageSyncBatch({ limit: 2, now });
    expect(selected.map((row) => row.syncStatus)).toEqual(['in_flight', 'in_flight']);

    const beforeLease = recoverStaleTurnUsageSyncInFlight({
      now: now + DEFAULT_USAGE_SYNC_IN_FLIGHT_LEASE_MS - 1,
    });
    expect(beforeLease).toEqual({ recovered: 0 });

    const afterLease = recoverStaleTurnUsageSyncInFlight({
      now: now + DEFAULT_USAGE_SYNC_IN_FLIGHT_LEASE_MS + 1,
    });
    expect(afterLease).toEqual({ recovered: 2 });

    const retryBatch = selectTurnUsageSyncBatch({
      limit: 2,
      now: now + DEFAULT_USAGE_SYNC_IN_FLIGHT_LEASE_MS + 2,
    });
    expect(retryBatch).toHaveLength(2);
    expect(retryBatch.every((row) => row.lastErrorReason === 'in_flight_stale')).toBe(true);
  });
});
