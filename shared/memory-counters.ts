export const MEMORY_COUNTERS = [
  'mem.startup.silent_failure',
  'mem.startup.budget_exceeded',
  'mem.startup.stage_dropped',
  'mem.master_compaction.skipped',
  'mem.shutdown.master_drain.contract_violation',
  'mem.shutdown.master_drain.timed_out',
  'mem.archive_fts.unavailable',
  'mem.archive_fts.match_failure',
  'mem.config.invalid_value',
  'mem.config.invalid_redact_pattern',
  'mem.write.retry_exhausted',
  'mem.search.empty_results',
  'mem.search.scope_filter_hit',
  'mem.search.unauthorized_lookup',
  'mem.search.disabled',
  'mem.citation.created',
  'mem.citation.drift_observed',
  'mem.citation.count_incremented',
  'mem.citation.count_deduped',
  'mem.citation.count_rejected',
  'mem.citation.count_rate_limited',
  'mem.ingest.skipped_unsafe',
  'mem.ingest.scope_clamped',
  'mem.ingest.scope_dropped',
  'mem.ingest.size_capped',
  'mem.ingest.section_count_capped',
  'mem.skill.sanitize_rejected',
  'mem.skill.resolver_miss',
  'mem.skill.registry_oversize',
  'mem.skill.evidence_filtered',
  'mem.skill.evidence_evicted',
  'mem.skill.evidence_reset_on_restart',
  'mem.skill.collision_escaped',
  'mem.skill.layer_conflict_resolved',
  'mem.skill.review_throttled',
  'mem.skill.review_not_eligible',
  'mem.skill.review_deduped',
  'mem.skill.review_failed',
  'mem.classify.failed',
  'mem.classify.dedup_merge',
  'mem.preferences.untrusted_origin',
  'mem.preferences.persisted',
  'mem.preferences.persistence_failed',
  'mem.preferences.duplicate_ignored',
  'mem.preferences.rejected_untrusted',
  'mem.preferences.unauthorized_delete',
  'mem.observation.duplicate_ignored',
  'mem.observation.unauthorized_promotion_attempt',
  'mem.observation.unauthorized_query',
  'mem.observation.cross_scope_promotion_blocked',
  'mem.observation.backfill_repaired',
  'mem.bridge.unrouted_response',
  'mem.management.unauthorized',
  'mem.cache.invalidate_published',
  'mem.materialization.repair_triggered',
  'mem.materialization.compression_admission_closed',
  'mem.materialization.retry_exhausted_archived',
  'mem.materialization.archive_failed',
  'mem.materialization.durable_projection_failed',
  'mem.compression.queue_prior_failure',
  'mem.compression.admission_closed',
  'mem.pinned_notes_overflow',
  'mem.telemetry.buffer_overflow',
] as const;

export type MemoryCounter = (typeof MEMORY_COUNTERS)[number];

export const MEMORY_SOFT_FAIL_PATH_COUNTERS = {
  startup_memory: 'mem.startup.silent_failure',
  search: 'mem.search.empty_results',
  citation: 'mem.citation.count_rejected',
  cite_count: 'mem.citation.count_rejected',
  md_ingest: 'mem.ingest.skipped_unsafe',
  skills: 'mem.skill.sanitize_rejected',
  skill_review: 'mem.skill.review_failed',
  preferences: 'mem.preferences.rejected_untrusted',
  materialization: 'mem.materialization.repair_triggered',
  observations: 'mem.observation.backfill_repaired',
  classification: 'mem.classify.failed',
} as const satisfies Record<string, MemoryCounter>;

export type MemorySoftFailPath = keyof typeof MEMORY_SOFT_FAIL_PATH_COUNTERS;

export const MEMORY_COUNTER_LABEL_ENUMS = [
  'MemoryOrigin',
  'SendOrigin',
  'MemoryFeatureFlag',
  'FingerprintKind',
  'ObservationClass',
  'SkillReviewTrigger',
] as const;

export type MemoryCounterLabelEnum = (typeof MEMORY_COUNTER_LABEL_ENUMS)[number];

const MEMORY_COUNTER_SET: ReadonlySet<string> = new Set(MEMORY_COUNTERS);

export function isMemoryCounter(value: unknown): value is MemoryCounter {
  return typeof value === 'string' && MEMORY_COUNTER_SET.has(value);
}
