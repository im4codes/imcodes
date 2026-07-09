import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  createServer,
  createSubSession,
  createUser,
  deleteDbSession,
  deleteServer,
  deleteSubSession,
  upsertDbSession,
} from '../src/db/queries.js';
import {
  deleteTokenUsageFactsForUser,
  getTokenUsageSummary,
  ingestServerTokenUsageFacts,
} from '../src/db/token-usage-queries.js';
import {
  recordTurnUsage,
  resetContextStoreForTests,
  selectTurnUsageSyncBatch,
} from '../../src/store/context-store.js';
import {
  cleanupIsolatedSharedContextDb,
  createIsolatedSharedContextDb,
} from '../../test/util/shared-context-db.js';
import type { UsageFact } from '../../shared/usage-analytics.js';

let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

function fact(overrides: Partial<UsageFact> = {}): UsageFact {
  const inputTokens = overrides.inputTokens ?? 10;
  const cacheTokens = overrides.cacheTokens ?? 2;
  const outputTokens = overrides.outputTokens ?? 8;
  return {
    usageFactId: unique('usage'),
    createdAtMs: Date.UTC(2026, 6, 9, 23, 30),
    sessionName: 'deck_alpha_brain',
    sessionKind: 'main',
    parentSessionName: null,
    metadataCompleteness: 'complete',
    provider: 'openai',
    agentType: 'codex-sdk',
    model: 'gpt-5',
    inputTokens,
    cacheTokens,
    outputTokens,
    totalTokens: inputTokens + cacheTokens + outputTokens,
    contextWindow: 200000,
    costUsdMicros: 1234,
    sourceEventId: 'evt-1',
    ...overrides,
  };
}

async function seedOwnerServer(prefix: string) {
  const userId = unique(`${prefix}-user`);
  const serverId = unique(`${prefix}-srv`);
  await createUser(db, userId);
  await createServer(db, serverId, userId, `${prefix} server`, unique('hash'));
  return { userId, serverId };
}

describe('server token usage storage', () => {
  it('creates storage table, uniqueness, and query-support indexes', async () => {
    const table = await db.queryOne<{ oid: string | null }>(
      'SELECT to_regclass($1) AS oid',
      ['public.server_token_usage_facts'],
    );
    expect(table?.oid).toBe('server_token_usage_facts');

    const indexes = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'server_token_usage_facts'",
      [],
    );
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      'server_token_usage_facts_server_id_usage_fact_id_key',
      'idx_token_usage_user_date',
      'idx_token_usage_user_server_date',
      'idx_token_usage_user_provider_model_date',
      'idx_token_usage_user_agent_date',
      'idx_token_usage_user_session_date',
      'idx_token_usage_user_parent_date',
      'idx_token_usage_user_session_model_date',
    ]));
  });

  it('ingests idempotently, classifies conflicts and clock windows, and summarizes committed rows', async () => {
    const { userId, serverId } = await seedOwnerServer('usage-summary-a');
    const otherServerId = unique('usage-summary-b-srv');
    await createServer(db, otherServerId, userId, 'second server', unique('hash'));
    const now = Date.UTC(2026, 6, 10, 0, 0);

    const main = fact({ usageFactId: 'fact-main', sessionName: 'deck_same_brain', sourceEventId: 'evt-main' });
    const sub = fact({
      usageFactId: 'fact-sub',
      sessionName: 'deck_sub_child',
      sessionKind: 'sub',
      parentSessionName: 'deck_same_brain',
      metadataCompleteness: 'partial',
      provider: null,
      model: null,
      costUsdMicros: null,
      sourceEventId: 'evt-sub',
    });
    const sameNameOtherServer = fact({
      usageFactId: 'fact-other-server',
      sessionName: 'deck_same_brain',
      sourceEventId: 'evt-other',
      outputTokens: 20,
      totalTokens: 32,
    });

    await expect(ingestServerTokenUsageFacts(db, { serverId, userId, facts: [main, sub], now })).resolves.toEqual([
      { usageFactId: 'fact-main', status: 'accepted' },
      { usageFactId: 'fact-sub', status: 'accepted' },
    ]);
    await expect(ingestServerTokenUsageFacts(db, { serverId: otherServerId, userId, facts: [sameNameOtherServer], now })).resolves.toEqual([
      { usageFactId: 'fact-other-server', status: 'accepted' },
    ]);
    await expect(ingestServerTokenUsageFacts(db, { serverId, userId, facts: [main], now })).resolves.toEqual([
      { usageFactId: 'fact-main', status: 'duplicate' },
    ]);
    await expect(ingestServerTokenUsageFacts(db, {
      serverId,
      userId,
      facts: [{ ...main, outputTokens: 9, totalTokens: 21 }],
      now,
    })).resolves.toEqual([{ usageFactId: 'fact-main', status: 'conflict' }]);
    await expect(ingestServerTokenUsageFacts(db, {
      serverId,
      userId,
      facts: [main],
      now: now + 181 * 86_400_000,
    })).resolves.toEqual([{ usageFactId: 'fact-main', status: 'duplicate' }]);
    await expect(ingestServerTokenUsageFacts(db, {
      serverId,
      userId,
      facts: [{ ...main, outputTokens: 11, totalTokens: 23 }],
      now: now + 181 * 86_400_000,
    })).resolves.toEqual([{ usageFactId: 'fact-main', status: 'conflict' }]);
    await expect(ingestServerTokenUsageFacts(db, {
      serverId,
      userId,
      facts: [
        fact({ usageFactId: 'too-old', createdAtMs: now - 181 * 86_400_000 }),
        fact({ usageFactId: 'clock-skew', createdAtMs: now + 11 * 60_000 }),
      ],
      now,
    })).resolves.toEqual([
      { usageFactId: 'too-old', status: 'too_old' },
      { usageFactId: 'clock-skew', status: 'clock_skew_too_far' },
    ]);

    const summary = await getTokenUsageSummary(db, userId, { order: 'desc' });
    expect(summary.accountTotal.factCount).toBe(3);
    expect(summary.accountTotal.totalTokens).toBe(72);
    expect(summary.accountTotal.costUsdMicros).toBe(2468);
    expect(summary.accountTotal.costCompleteness).toBe('partial');
    expect(summary.byDate).toEqual([expect.objectContaining({ date: '2026-07-09', totalTokens: 72 })]);
    expect(summary.byServer).toHaveLength(2);
    expect(summary.byServer.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(summary.accountTotal.totalTokens);
    expect(summary.byProviderModel).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai', model: 'gpt-5', factCount: 2 }),
      expect.objectContaining({ provider: null, model: null, factCount: 1, costCompleteness: 'unknown' }),
    ]));
    expect(summary.byMainSession).toEqual(expect.arrayContaining([
      expect.objectContaining({ serverId, sessionName: 'deck_same_brain', sessionKind: 'main', totalTokens: 20 }),
      expect.objectContaining({ serverId: otherServerId, sessionName: 'deck_same_brain', sessionKind: 'main', totalTokens: 32 }),
    ]));
    expect(summary.bySubSession).toEqual([
      expect.objectContaining({
        serverId,
        sessionName: 'deck_sub_child',
        sessionKind: 'sub',
        parentSessionName: 'deck_same_brain',
        metadataCompleteness: 'partial',
      }),
    ]);
    expect(summary.byParentSession).toEqual([
      expect.objectContaining({ parentSessionName: 'deck_same_brain', totalTokens: 20 }),
    ]);

    const serverFiltered = await getTokenUsageSummary(db, userId, { serverId });
    expect(serverFiltered.accountTotal.factCount).toBe(2);
    expect(serverFiltered.accountTotal.totalTokens).toBe(40);
  });

  it('classifies duplicate and conflicting rows within a single batch', async () => {
    const { userId, serverId } = await seedOwnerServer('usage-same-batch');
    const now = Date.UTC(2026, 6, 10, 0, 0);
    await expect(ingestServerTokenUsageFacts(db, {
      serverId,
      userId,
      facts: [
        fact({ usageFactId: 'same-batch-dupe', sourceEventId: 'evt-same-batch' }),
        fact({ usageFactId: 'same-batch-dupe', sourceEventId: 'evt-same-batch' }),
        fact({ usageFactId: 'same-batch-conflict', sourceEventId: 'evt-same-batch-conflict' }),
        fact({
          usageFactId: 'same-batch-conflict',
          sourceEventId: 'evt-same-batch-conflict',
          outputTokens: 30,
          totalTokens: 42,
        }),
      ],
      now,
    })).resolves.toEqual([
      { usageFactId: 'same-batch-dupe', status: 'accepted' },
      { usageFactId: 'same-batch-dupe', status: 'duplicate' },
      { usageFactId: 'same-batch-conflict', status: 'accepted' },
      { usageFactId: 'same-batch-conflict', status: 'conflict' },
    ]);

    const summary = await getTokenUsageSummary(db, userId, { serverId });
    expect(summary.accountTotal.factCount).toBe(2);
  });

  it('classifies concurrent duplicate and conflicting inserts without double counting', async () => {
    const { userId, serverId } = await seedOwnerServer('usage-concurrent');
    const now = Date.UTC(2026, 6, 10, 0, 0);
    const duplicate = fact({ usageFactId: 'concurrent-duplicate', sourceEventId: 'evt-concurrent-dupe' });
    const duplicateResults = await Promise.all([
      ingestServerTokenUsageFacts(db, { serverId, userId, facts: [duplicate], now }),
      ingestServerTokenUsageFacts(db, { serverId, userId, facts: [duplicate], now }),
    ]);
    expect(duplicateResults.flat()).toEqual(expect.arrayContaining([
      { usageFactId: 'concurrent-duplicate', status: 'accepted' },
      { usageFactId: 'concurrent-duplicate', status: 'duplicate' },
    ]));

    const conflict = fact({ usageFactId: 'concurrent-conflict', sourceEventId: 'evt-concurrent-conflict' });
    const conflictResults = await Promise.all([
      ingestServerTokenUsageFacts(db, { serverId, userId, facts: [conflict], now }),
      ingestServerTokenUsageFacts(db, {
        serverId,
        userId,
        facts: [{ ...conflict, outputTokens: 31, totalTokens: 43 }],
        now,
      }),
    ]);
    expect(conflictResults.flat().map((result) => result.status).sort()).toEqual(['accepted', 'conflict']);

    const summary = await getTokenUsageSummary(db, userId, { serverId });
    expect(summary.accountTotal.factCount).toBe(2);
  });

  it('isolates multiple owners with overlapping usage fact and session dimensions', async () => {
    const ownerA = await seedOwnerServer('usage-owner-a');
    const ownerB = await seedOwnerServer('usage-owner-b');
    const now = Date.UTC(2026, 6, 10, 0, 0);
    const overlapping = fact({
      usageFactId: 'same-usage-fact-id',
      sessionName: 'deck_overlap_brain',
      provider: 'openai',
      model: 'gpt-5',
    });

    await ingestServerTokenUsageFacts(db, {
      serverId: ownerA.serverId,
      userId: ownerA.userId,
      facts: [overlapping],
      now,
    });
    await ingestServerTokenUsageFacts(db, {
      serverId: ownerB.serverId,
      userId: ownerB.userId,
      facts: [{ ...overlapping, outputTokens: 20, totalTokens: 32 }],
      now,
    });

    const summaryA = await getTokenUsageSummary(db, ownerA.userId, { serverId: ownerA.serverId });
    const summaryB = await getTokenUsageSummary(db, ownerB.userId, { serverId: ownerB.serverId });
    const crossAccount = await getTokenUsageSummary(db, ownerB.userId, { serverId: ownerA.serverId });

    expect(summaryA.accountTotal.totalTokens).toBe(20);
    expect(summaryB.accountTotal.totalTokens).toBe(32);
    expect(crossAccount.accountTotal.factCount).toBe(0);
  });

  it('keeps summary bucket keys unique and derives hidden dimensions by aggregation', async () => {
    const { userId, serverId } = await seedOwnerServer('usage-bucket-identity');
    const now = Date.UTC(2026, 6, 10, 0, 0);

    await ingestServerTokenUsageFacts(db, {
      serverId,
      userId,
      facts: [
        fact({
          usageFactId: 'mixed-complete',
          sessionName: 'deck_mixed_brain',
          metadataCompleteness: 'complete',
          provider: 'openai',
          agentType: 'codex-sdk',
          model: 'gpt-5',
          sourceEventId: 'mixed-complete',
        }),
        fact({
          usageFactId: 'mixed-partial',
          sessionName: 'deck_mixed_brain',
          metadataCompleteness: 'partial',
          provider: 'anthropic',
          agentType: 'claude-code',
          model: 'gpt-5',
          sourceEventId: 'mixed-partial',
          outputTokens: 10,
          totalTokens: 22,
        }),
        fact({
          usageFactId: 'agent-provider-null-a',
          sessionName: 'deck_agent_a',
          provider: null,
          agentType: 'codex-sdk',
          model: 'shared-model',
          sourceEventId: 'agent-a',
        }),
        fact({
          usageFactId: 'agent-provider-null-b',
          sessionName: 'deck_agent_b',
          provider: null,
          agentType: 'qwen-sdk',
          model: 'shared-model',
          sourceEventId: 'agent-b',
        }),
      ],
      now,
    });

    const summary = await getTokenUsageSummary(db, userId);
    const mainRows = summary.byMainSession.filter((row) => row.sessionName === 'deck_mixed_brain');
    expect(mainRows).toEqual([
      expect.objectContaining({
        serverId,
        sessionName: 'deck_mixed_brain',
        metadataCompleteness: 'partial',
        factCount: 2,
        totalTokens: 42,
      }),
    ]);

    const sessionModelRows = summary.bySessionModelDate.filter((row) => row.sessionName === 'deck_mixed_brain');
    expect(sessionModelRows).toEqual([
      expect.objectContaining({
        key: `${serverId}:deck_mixed_brain:main:gpt-5:2026-07-09`,
        metadataCompleteness: 'partial',
        factCount: 2,
        totalTokens: 42,
      }),
    ]);

    const providerModelKeys = summary.byProviderModel.map((row) => row.key);
    expect(new Set(providerModelKeys).size).toBe(providerModelKeys.length);
    expect(summary.byProviderModel).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'codex-sdk:shared-model', provider: null, agentType: 'codex-sdk', model: 'shared-model' }),
      expect.objectContaining({ key: 'qwen-sdk:shared-model', provider: null, agentType: 'qwen-sdk', model: 'shared-model' }),
    ]));
  });

  it('normalizes summary dates as UTC and marks limited primary buckets as partial', async () => {
    const { userId, serverId } = await seedOwnerServer('usage-window-a');
    const secondServerId = unique('usage-window-b-srv');
    const thirdServerId = unique('usage-window-c-srv');
    await createServer(db, secondServerId, userId, 'second server', unique('hash'));
    await createServer(db, thirdServerId, userId, 'third server', unique('hash'));
    const now = Date.UTC(2026, 6, 10, 0, 0);

    await ingestServerTokenUsageFacts(db, {
      serverId,
      userId,
      facts: [fact({ usageFactId: 'window-a', createdAtMs: Date.UTC(2026, 6, 9, 0, 30), outputTokens: 1, totalTokens: 13 })],
      now,
    });
    await ingestServerTokenUsageFacts(db, {
      serverId: secondServerId,
      userId,
      facts: [fact({ usageFactId: 'window-b', outputTokens: 2, totalTokens: 14 })],
      now,
    });
    await ingestServerTokenUsageFacts(db, {
      serverId: thirdServerId,
      userId,
      facts: [fact({ usageFactId: 'window-c', outputTokens: 3, totalTokens: 15 })],
      now,
    });

    const originalTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const summary = await getTokenUsageSummary(db, userId, { limit: 1, order: 'desc' });
      expect(summary.byDate).toEqual([
        expect.objectContaining({ date: '2026-07-09', totalTokens: 42 }),
      ]);
      expect(summary.accountTotal.totalTokens).toBe(42);
      expect(summary.byServer).toHaveLength(1);
      expect(summary.byServer[0]?.totalTokens).toBeLessThan(summary.accountTotal.totalTokens);
      expect(summary.meta).toMatchObject({
        primaryBucket: 'byServer',
        partialBuckets: ['byServer'],
        appliedLimits: { byServer: 1 },
      });
    } finally {
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });

  it('does not default-cap explicit session-model-date summaries and sorts without a limit', async () => {
    const { userId, serverId } = await seedOwnerServer('usage-session-model-date-window');
    const now = Date.UTC(2026, 6, 10, 0, 0);
    await ingestServerTokenUsageFacts(db, {
      serverId,
      userId,
      facts: [
        fact({ usageFactId: 'session-model-date-a', model: 'model-a', outputTokens: 8, totalTokens: 20 }),
        fact({ usageFactId: 'session-model-date-b', model: 'model-b', outputTokens: 28, totalTokens: 40 }),
        fact({ usageFactId: 'session-model-date-c', model: 'model-c', outputTokens: 18, totalTokens: 30 }),
      ],
      now,
    });

    const summary = await getTokenUsageSummary(db, userId, { groupBy: 'sessionModelDate', order: 'desc' });

    expect(summary.meta).toMatchObject({
      primaryBucket: 'bySessionModelDate',
      partialBuckets: [],
      appliedLimits: {},
    });
    expect(summary.bySessionModelDate.map((row) => row.totalTokens)).toEqual([40, 30, 20]);
  });

  it('preserves usage after session deletion and deletes usage for server/user lifecycle deletion', async () => {
    const { userId, serverId } = await seedOwnerServer('usage-delete');
    const now = Date.UTC(2026, 6, 10, 0, 0);
    const main = fact({ usageFactId: 'delete-main', sessionName: 'deck_delete_brain' });
    const sub = fact({
      usageFactId: 'delete-sub',
      sessionName: 'deck_sub_delete',
      sessionKind: 'sub',
      parentSessionName: 'deck_delete_brain',
    });

    await upsertDbSession(
      db,
      'session-row',
      serverId,
      'deck_delete_brain',
      'Project',
      'brain',
      'codex-sdk',
      '/work',
      'running',
    );
    await createSubSession(db, 'sub-row', serverId, 'codex', null, '/work', 'Sub', null, null, 'deck_delete_brain');
    await ingestServerTokenUsageFacts(db, { serverId, userId, facts: [main, sub], now });
    await deleteDbSession(db, serverId, 'deck_delete_brain');
    await deleteSubSession(db, 'sub-row', serverId);
    expect((await getTokenUsageSummary(db, userId)).accountTotal.factCount).toBe(2);

    await deleteServer(db, serverId, userId);
    expect((await getTokenUsageSummary(db, userId)).accountTotal.factCount).toBe(0);

    const { userId: userForDelete, serverId: serverForDelete } = await seedOwnerServer('usage-user-delete');
    await ingestServerTokenUsageFacts(db, {
      serverId: serverForDelete,
      userId: userForDelete,
      facts: [fact({ usageFactId: 'user-delete-main' })],
      now,
    });
    expect((await getTokenUsageSummary(db, userForDelete)).accountTotal.factCount).toBe(1);
    await deleteTokenUsageFactsForUser(db, userForDelete);
    expect((await getTokenUsageSummary(db, userForDelete)).accountTotal.factCount).toBe(0);
  });

  it('summary reads do not see uncommitted ingest rows', async () => {
    const { userId, serverId } = await seedOwnerServer('usage-committed');
    const observer = createDatabase(process.env.TEST_DATABASE_URL!);
    try {
      await db.transaction(async (tx) => {
        await ingestServerTokenUsageFacts(tx as Database, {
          serverId,
          userId,
          facts: [fact({ usageFactId: 'uncommitted-fact' })],
          now: Date.UTC(2026, 6, 10, 0, 0),
        });
        const beforeCommit = await getTokenUsageSummary(observer, userId);
        expect(beforeCommit.accountTotal.factCount).toBe(0);
      });

      const afterCommit = await getTokenUsageSummary(observer, userId);
      expect(afterCommit.accountTotal.factCount).toBe(1);
    } finally {
      await observer.close();
    }
  });

  it('syncs a daemon-local usage row through server ingest into server summaries', async () => {
    const { userId, serverId } = await seedOwnerServer('usage-daemon-sync');
    const tempDir = await createIsolatedSharedContextDb('server-usage-daemon-sync');
    try {
      recordTurnUsage({
        sessionName: 'deck_daemon_brain',
        sessionKind: 'sub',
        parentSessionName: 'deck_parent_brain',
        metadataCompleteness: 'complete',
        agentType: 'codex-sdk',
        provider: 'openai',
        model: 'gpt-5',
        inputTokens: 11,
        cacheTokens: 3,
        outputTokens: 7,
        contextWindow: 200000,
        costUsd: 0.000123,
        eventId: 'daemon-event-1',
        createdAt: Date.UTC(2026, 6, 9, 10, 0),
      });

      const batch = selectTurnUsageSyncBatch({ limit: 10, now: Date.UTC(2026, 6, 10, 0, 0) });
      expect(batch).toHaveLength(1);
      await ingestServerTokenUsageFacts(db, {
        serverId,
        userId,
        facts: batch.map((item) => item.fact),
        now: Date.UTC(2026, 6, 10, 0, 0),
      });

      const summary = await getTokenUsageSummary(db, userId, { serverId });
      expect(summary.accountTotal).toMatchObject({
        factCount: 1,
        inputTokens: 11,
        cacheTokens: 3,
        outputTokens: 7,
        totalTokens: 21,
        costUsdMicros: 123,
      });
      expect(summary.bySubSession).toEqual([
        expect.objectContaining({
          sessionName: 'deck_daemon_brain',
          parentSessionName: 'deck_parent_brain',
        }),
      ]);
      expect(summary.byProviderModel).toEqual([
        expect.objectContaining({
          provider: 'openai',
          model: 'gpt-5',
          totalTokens: 21,
        }),
      ]);
    } finally {
      resetContextStoreForTests();
      await cleanupIsolatedSharedContextDb(tempDir);
    }
  });
});
