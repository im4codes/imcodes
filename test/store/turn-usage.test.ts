import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
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

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

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

  it('selects the NEWEST unsynced turns first so recent data never starves behind a backlog', () => {
    const t = 1_700_000_000_000;
    recordTurnUsage({ sessionName: 'old', createdAt: t, inputTokens: 1, outputTokens: 1, eventId: 'old' });
    recordTurnUsage({ sessionName: 'mid', createdAt: t + 86_400_000, inputTokens: 1, outputTokens: 1, eventId: 'mid' });
    recordTurnUsage({ sessionName: 'new', createdAt: t + 2 * 86_400_000, inputTokens: 1, outputTokens: 1, eventId: 'new' });
    // A batch smaller than the backlog must pick the two most recent, not the oldest.
    const batch = selectTurnUsageSyncBatch({ limit: 2, now: t + 10 * 86_400_000 });
    expect(batch.map((row) => row.fact.sessionName)).toEqual(['new', 'mid']);
  });

  it('never re-selects an already-accepted turn (idempotent — no duplicate re-sync)', () => {
    recordTurnUsage({ sessionName: 'a', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'a' });
    recordTurnUsage({ sessionName: 'b', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'b' });
    const first = selectTurnUsageSyncBatch({ limit: 10, now: 100 });
    expect(first).toHaveLength(2);
    recordTurnUsageSyncResults({
      now: 200,
      results: first.map((row) => ({ usageFactId: row.usageFactId, status: 'accepted' })),
    });
    // 'accepted' is terminal: neither a fresh select nor a re-backfill re-sends it.
    expect(backfillTurnUsageSyncMetadata()).toEqual({ backfilled: 0 });
    expect(selectTurnUsageSyncBatch({ limit: 10, now: 300 })).toHaveLength(0);
  });

  it('re-opens sync when a turn is revised (same eventId, new value) but not on identical replay', () => {
    recordTurnUsage({ sessionName: 'a', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'e', createdAt: 100 });
    const first = selectTurnUsageSyncBatch({ limit: 10, now: 200 });
    expect(first).toHaveLength(1);
    const factId = first[0].usageFactId;
    recordTurnUsageSyncResults({ now: 300, results: [{ usageFactId: factId, status: 'accepted' }] });
    expect(selectTurnUsageSyncBatch({ limit: 10, now: 400 })).toHaveLength(0);

    // Same turn re-emitted with grown output → row updated, sync re-opened.
    recordTurnUsage({ sessionName: 'a', model: 'm', inputTokens: 1, outputTokens: 9, eventId: 'e', createdAt: 100 });
    const reopened = selectTurnUsageSyncBatch({ limit: 10, now: 500 });
    expect(reopened).toHaveLength(1);
    expect(reopened[0].usageFactId).toBe(factId); // stable id → server updates in place
    expect(reopened[0].fact.outputTokens).toBe(9); // carries the revised value

    // Identical replay (same value) must NOT re-open (idempotent).
    recordTurnUsageSyncResults({ now: 600, results: [{ usageFactId: factId, status: 'accepted' }] });
    recordTurnUsage({ sessionName: 'a', model: 'm', inputTokens: 1, outputTokens: 9, eventId: 'e', createdAt: 100 });
    expect(selectTurnUsageSyncBatch({ limit: 10, now: 700 })).toHaveLength(0);
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

  it('skips full-table COUNT(*) on steady-state selectTurnUsageSyncBatch after backfill alignment', () => {
    const dbPath = join(tempDir, 'context.sqlite');
    // Seed a single row to ensure schema exists, then bulk insert 2,500 synced usage rows externally.
    recordTurnUsage({ sessionName: 'seed', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'seed-0', createdAt: 100 });
    const seedBatch = selectTurnUsageSyncBatch({ limit: 10, now: 100 });
    recordTurnUsageSyncResults({
      now: 100,
      results: [{ usageFactId: seedBatch[0].usageFactId, status: 'accepted' }],
    });

    const ext = new DatabaseSync(dbPath);
    const authorityId = getOrCreateUsageAuthorityId();
    const insertUsage = ext.prepare(`
      INSERT INTO context_turn_usage (
        created_at, session_name, agent_type, model,
        input_tokens, cache_tokens, output_tokens, context_window, cost_usd, event_id,
        provider, session_kind, parent_session_name, metadata_completeness, cost_usd_micros
      ) VALUES (?, ?, 'codex-sdk', 'gpt-5', 10, 0, 5, 200000, NULL, ?, 'openai', 'main', NULL, 'complete', NULL)
    `);
    const insertSync = ext.prepare(`
      INSERT INTO context_turn_usage_sync (
        turn_usage_rowid, usage_authority_id, usage_fact_id, payload_hash,
        sync_status, retry_count, metadata_completeness, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 'accepted', 0, 'complete', ?, ?)
    `);
    ext.exec('BEGIN');
    for (let i = 1; i <= 2500; i += 1) {
      const info = insertUsage.run(1_000 + i, 'bulk', `bulk-${i}`) as { lastInsertRowid: number | bigint };
      const rowid = Number(info.lastInsertRowid);
      insertSync.run(rowid, authorityId, `usage:${authorityId}:evt:bulk:${i}`, `hash-${i}`, 1_000 + i, 1_000 + i);
    }
    ext.exec('COMMIT');
    ext.close();

    const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare');
    try {
      // Cold check after external commit verifies gap once via LEFT JOIN (zero COUNT(*) scans) and warms the cache.
      expect(selectTurnUsageSyncBatch({ limit: 50, now: 10_000 })).toEqual([]);
      expect(prepareSpy.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('SELECT COUNT(*)'))).toHaveLength(0);
      expect(prepareSpy.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('LEFT JOIN context_turn_usage_sync'))).toHaveLength(1);

      prepareSpy.mockClear();
      // Subsequent steady-state polls and same-connection atomic writes skip both COUNT(*) and LEFT JOIN scans completely.
      recordTurnUsage({
        sessionName: 'steady',
        model: 'gpt-5',
        inputTokens: 42,
        outputTokens: 8,
        eventId: 'steady-live-1',
        createdAt: 20_000,
      });
      const liveBatch = selectTurnUsageSyncBatch({ limit: 50, now: 20_000 });
      expect(liveBatch).toHaveLength(1);
      expect(liveBatch[0].fact.sourceEventId).toBe('steady-live-1');
      recordTurnUsageSyncResults({
        now: 20_000,
        results: [{ usageFactId: liveBatch[0].usageFactId, status: 'accepted' }],
      });
      expect(selectTurnUsageSyncBatch({ limit: 50, now: 20_100 })).toEqual([]);

      expect(prepareSpy.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('SELECT COUNT(*)'))).toHaveLength(0);
      expect(prepareSpy.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('LEFT JOIN context_turn_usage_sync'))).toHaveLength(0);
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('recovers missing usage rows when an external connection leaves orphan sync rows with foreign_keys=OFF (warm cache and after reopen)', () => {
    const dbPath = join(tempDir, 'context.sqlite');
    for (const evt of ['id-1', 'id-2', 'id-3', 'id-4']) {
      recordTurnUsage({ sessionName: 's', model: 'm', inputTokens: 1, outputTokens: 1, eventId: evt, createdAt: 100 });
    }
    const seedBatch = selectTurnUsageSyncBatch({ limit: 10, now: 100 });
    recordTurnUsageSyncResults({
      now: 100,
      results: seedBatch.map((row) => ({ usageFactId: row.usageFactId, status: 'accepted' })),
    });
    // Warm the steady-state cache: usage [1,2,3,4], sync [1,2,3,4].
    expect(selectTurnUsageSyncBatch({ limit: 10, now: 200 })).toEqual([]);

    // External connection with foreign_keys=OFF creates usage=[2,3,4], sync=[1,3,4]:
    // row 1 in sync is an orphan, row 2 in usage lacks sync, counts are equal (3 === 3), newest row 4 has sync.
    const ext = new DatabaseSync(dbPath);
    ext.exec('PRAGMA foreign_keys = OFF; BEGIN;');
    ext.exec('DELETE FROM context_turn_usage WHERE id = 1;');
    ext.exec('DELETE FROM context_turn_usage_sync WHERE turn_usage_rowid = 2;');
    ext.exec('COMMIT;');
    ext.close();

    // 1) Warm cache invalidated via PRAGMA data_version -> direct LEFT JOIN probe finds and restores id=2.
    const warmRecovered = selectTurnUsageSyncBatch({ limit: 10, now: 300 });
    expect(warmRecovered.map((r) => r.turnUsageRowid)).toEqual([2]);
    expect(warmRecovered[0].fact.sourceEventId).toBe('id-2');

    // 2) Reproduce the exact same [2,3,4] vs [1,3,4] skewed state across DB close/reopen (cold start).
    const extReopen = new DatabaseSync(dbPath);
    extReopen.exec('PRAGMA foreign_keys = OFF; DELETE FROM context_turn_usage_sync WHERE turn_usage_rowid = 2;');
    extReopen.close();
    resetContextStoreForTests();

    const reopenRecovered = selectTurnUsageSyncBatch({ limit: 10, now: 400 });
    expect(reopenRecovered.map((r) => r.turnUsageRowid)).toEqual([2]);
    expect(reopenRecovered[0].fact.sourceEventId).toBe('id-2');
  });

  it('invalidates warm cache via PRAGMA data_version when an external connection inserts an orphan before a higher synced row', () => {
    const dbPath = join(tempDir, 'context.sqlite');
    recordTurnUsage({ sessionName: 'init', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 'init-1', createdAt: 100 });
    const initBatch = selectTurnUsageSyncBatch({ limit: 10, now: 100 });
    recordTurnUsageSyncResults({
      now: 100,
      results: [{ usageFactId: initBatch[0].usageFactId, status: 'accepted' }],
    });
    // Establish warm cache.
    expect(selectTurnUsageSyncBatch({ limit: 10, now: 200 })).toEqual([]);

    // External connection inserts orphan row (N+1) without sync, then inserts a synced row (N+2).
    const ext = new DatabaseSync(dbPath);
    const authorityId = getOrCreateUsageAuthorityId();
    ext.exec('BEGIN');
    const orphanRes = ext.prepare(`
      INSERT INTO context_turn_usage (
        created_at, session_name, agent_type, model,
        input_tokens, cache_tokens, output_tokens, context_window, cost_usd, event_id,
        provider, session_kind, parent_session_name, metadata_completeness, cost_usd_micros
      ) VALUES (300, 'orphan-session', 'codex-sdk', 'gpt-5', 7, 0, 3, 200000, NULL, 'orphan-evt', 'openai', 'main', NULL, 'complete', NULL)
    `).run() as { lastInsertRowid: number | bigint };
    const newerRes = ext.prepare(`
      INSERT INTO context_turn_usage (
        created_at, session_name, agent_type, model,
        input_tokens, cache_tokens, output_tokens, context_window, cost_usd, event_id,
        provider, session_kind, parent_session_name, metadata_completeness, cost_usd_micros
      ) VALUES (400, 'newer-synced', 'codex-sdk', 'gpt-5', 9, 0, 1, 200000, NULL, 'newer-evt', 'openai', 'main', NULL, 'complete', NULL)
    `).run() as { lastInsertRowid: number | bigint };
    const newerId = Number(newerRes.lastInsertRowid);
    ext.prepare(`
      INSERT INTO context_turn_usage_sync (
        turn_usage_rowid, usage_authority_id, usage_fact_id, payload_hash,
        sync_status, retry_count, metadata_completeness, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 'hash-newer', 'accepted', 0, 'complete', 400, 400)
    `).run(newerId, authorityId, `usage:${authorityId}:evt:newer:${newerId}`);
    ext.exec('COMMIT');
    ext.close();

    // Must not mask orphan-evt behind newer-evt!
    const recovered = selectTurnUsageSyncBatch({ limit: 10, now: 500 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0].turnUsageRowid).toBe(Number(orphanRes.lastInsertRowid));
    expect(recovered[0].fact.sourceEventId).toBe('orphan-evt');
  });

  it('re-verifies backfill after DB close/reset and rolls back context_turn_usage atomically if sync write fails', () => {
    const dbPath = join(tempDir, 'context.sqlite');
    recordTurnUsage({ sessionName: 's1', model: 'm', inputTokens: 1, outputTokens: 1, eventId: 's1-1', createdAt: 100 });
    const first = selectTurnUsageSyncBatch({ limit: 10, now: 100 });
    recordTurnUsageSyncResults({
      now: 100,
      results: [{ usageFactId: first[0].usageFactId, status: 'accepted' }],
    });
    expect(selectTurnUsageSyncBatch({ limit: 10, now: 200 })).toEqual([]);

    // Inject sync table failure via trigger and confirm recordTurnUsage rolls back context_turn_usage atomically.
    const ext = new DatabaseSync(dbPath);
    ext.exec(`
      CREATE TRIGGER fail_sync_insert BEFORE INSERT ON context_turn_usage_sync
      BEGIN
        SELECT RAISE(ABORT, 'injected_sync_failure');
      END;
    `);
    ext.close();

    recordTurnUsage({ sessionName: 'rolled-back', model: 'm', inputTokens: 5, outputTokens: 5, eventId: 'rb-1', createdAt: 300 });
    expect(summarizeTurnUsage().total).toBe(1);

    // Drop trigger, insert external raw row, and reopen DB via resetContextStoreForTests.
    const cleanupExt = new DatabaseSync(dbPath);
    cleanupExt.exec('DROP TRIGGER fail_sync_insert;');
    cleanupExt.prepare(`
      INSERT INTO context_turn_usage (
        created_at, session_name, agent_type, model,
        input_tokens, cache_tokens, output_tokens, context_window, cost_usd, event_id,
        provider, session_kind, parent_session_name, metadata_completeness, cost_usd_micros
      ) VALUES (400, 'post-reset-orphan', 'codex-sdk', 'gpt-5', 2, 0, 2, 200000, NULL, 'post-reset-evt', 'openai', 'main', NULL, 'complete', NULL)
    `).run();
    cleanupExt.close();

    resetContextStoreForTests();
    const afterReopen = selectTurnUsageSyncBatch({ limit: 10, now: 500 });
    expect(afterReopen).toHaveLength(1);
    expect(afterReopen[0].fact.sourceEventId).toBe('post-reset-evt');
  });
});
