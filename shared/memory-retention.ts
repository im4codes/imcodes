export const MEMORY_RETENTION_TABLES = [
  'shared_context_citations',
  'shared_context_projection_cite_counts',
  'observation_promotion_audit',
  'skill_review_jobs',
  'memory_telemetry_events',
] as const;

export type MemoryRetentionTable = (typeof MEMORY_RETENTION_TABLES)[number];

export interface MemoryRetentionPolicy {
  table: MemoryRetentionTable;
  ttlMs: number;
  timestampColumn: string;
  batchSize: number;
}

export const DEFAULT_MEMORY_RETENTION_POLICIES: readonly MemoryRetentionPolicy[] = [
  { table: 'shared_context_citations', ttlMs: 180 * 24 * 60 * 60 * 1000, timestampColumn: 'created_at', batchSize: 500 },
  { table: 'shared_context_projection_cite_counts', ttlMs: 365 * 24 * 60 * 60 * 1000, timestampColumn: 'updated_at', batchSize: 500 },
  { table: 'observation_promotion_audit', ttlMs: 365 * 24 * 60 * 60 * 1000, timestampColumn: 'created_at', batchSize: 500 },
  { table: 'skill_review_jobs', ttlMs: 30 * 24 * 60 * 60 * 1000, timestampColumn: 'updated_at', batchSize: 500 },
  { table: 'memory_telemetry_events', ttlMs: 14 * 24 * 60 * 60 * 1000, timestampColumn: 'created_at', batchSize: 1000 },
];

export interface RetentionSweepPlanItem {
  table: MemoryRetentionTable;
  cutoff: number;
  timestampColumn: string;
  batchSize: number;
}

export function buildMemoryRetentionSweepPlan(now: number, policies: readonly MemoryRetentionPolicy[] = DEFAULT_MEMORY_RETENTION_POLICIES): RetentionSweepPlanItem[] {
  return policies.map((policy) => ({
    table: policy.table,
    cutoff: now - policy.ttlMs,
    timestampColumn: policy.timestampColumn,
    batchSize: policy.batchSize,
  }));
}


export interface MemoryRetentionSweepExecutor {
  deleteBefore(item: RetentionSweepPlanItem): Promise<number> | number;
}

export interface MemoryRetentionSweepResult {
  table: MemoryRetentionTable;
  cutoff: number;
  deleted: number;
  ok: boolean;
  error?: string;
}

/** Best-effort, bounded retention sweep. Individual table failures are reported
 * but do not abort the rest of the memory pipeline or shutdown path. */
export async function runMemoryRetentionSweep(
  executor: MemoryRetentionSweepExecutor,
  plan: readonly RetentionSweepPlanItem[],
): Promise<MemoryRetentionSweepResult[]> {
  const results: MemoryRetentionSweepResult[] = [];
  for (const item of plan) {
    try {
      const deleted = await executor.deleteBefore(item);
      results.push({ table: item.table, cutoff: item.cutoff, deleted, ok: true });
    } catch (error) {
      results.push({
        table: item.table,
        cutoff: item.cutoff,
        deleted: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
