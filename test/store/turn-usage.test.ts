import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recordTurnUsage,
  summarizeTurnUsage,
  pruneTurnUsage,
  resetContextStoreForTests,
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
    recordTurnUsage({ sessionName: 'A', createdAt: t0 - 30 * 86_400_000, inputTokens: 1, outputTokens: 1 });
    recordTurnUsage({ sessionName: 'A', createdAt: t0 - 60 * 86_400_000, inputTokens: 1, outputTokens: 1 });
    recordTurnUsage({ sessionName: 'A', createdAt: t0 -  5 * 86_400_000, inputTokens: 1, outputTokens: 1 });
    recordTurnUsage({ sessionName: 'A', createdAt: t0 -  1 * 86_400_000, inputTokens: 1, outputTokens: 1 });
    recordTurnUsage({ sessionName: 'A', createdAt: t0,                   inputTokens: 1, outputTokens: 1 });
    expect(summarizeTurnUsage().total).toBe(5);

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
