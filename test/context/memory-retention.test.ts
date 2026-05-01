import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_RETENTION_POLICIES,
  buildMemoryRetentionSweepPlan,
  runMemoryRetentionSweep,
} from '../../shared/memory-retention.js';

describe('memory retention sweeper policy', () => {
  it('defines bounded retention for persistent audit/idempotency tables', () => {
    const names = DEFAULT_MEMORY_RETENTION_POLICIES.map((policy) => policy.table);
    expect(names).toEqual(expect.arrayContaining([
      'shared_context_citations',
      'shared_context_projection_cite_counts',
      'observation_promotion_audit',
      'skill_review_jobs',
      'memory_telemetry_events',
    ]));
    expect(DEFAULT_MEMORY_RETENTION_POLICIES.every((policy) => policy.ttlMs > 0 && policy.batchSize > 0)).toBe(true);
  });

  it('builds restartable batch sweep plans from stable cutoffs', () => {
    expect(buildMemoryRetentionSweepPlan(1_000_000, [{ table: 'memory_telemetry_events', ttlMs: 1000, timestampColumn: 'created_at', batchSize: 10 }])).toEqual([
      { table: 'memory_telemetry_events', cutoff: 999_000, timestampColumn: 'created_at', batchSize: 10 },
    ]);
  });

  it('runs pruning best-effort without aborting later tables', async () => {
    const plan = buildMemoryRetentionSweepPlan(10_000, [
      { table: 'memory_telemetry_events', ttlMs: 1000, timestampColumn: 'created_at', batchSize: 10 },
      { table: 'skill_review_jobs', ttlMs: 2000, timestampColumn: 'updated_at', batchSize: 10 },
    ]);
    const results = await runMemoryRetentionSweep({
      deleteBefore: (item) => {
        if (item.table === 'memory_telemetry_events') throw new Error('locked');
        return 3;
      },
    }, plan);
    expect(results).toEqual([
      { table: 'memory_telemetry_events', cutoff: 9000, deleted: 0, ok: false, error: 'locked' },
      { table: 'skill_review_jobs', cutoff: 8000, deleted: 3, ok: true },
    ]);
  });
});
