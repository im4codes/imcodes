/**
 * Bounded recent-context hand-off for dedicated-execution clone workers.
 *
 * When dedicated execution routing is enabled and the orchestrator already has
 * a recent-memory summary for the run/session, it may attach a SHORT,
 * character-bounded slice of that summary to the worker hand-off prompt so the
 * ephemeral clone starts with continuity — WITHOUT copying raw provider
 * history (full transcripts / tool dumps). The bound is the same
 * `RECENT_SUMMARY_MAX_CHARS` ceiling used by recent-memory storage, applied via
 * {@link compactRecentSummaryForStorage}, which already strips back to the
 * compact recent-summary section set and caps total length.
 *
 * This module owns NO routing/task semantics: it is purely the
 * recent-summary → hand-off-block transform. The appendix builder
 * (`execution-routing-appendix.ts`) owns the delegation contract; the entry
 * point owns the task body; this owns only the bounded context slice.
 */

import {
  RECENT_SUMMARY_MAX_CHARS,
  compactRecentSummaryForStorage,
} from '../context/summary-compressor.js';

/** Stable heading that delimits the attached recent-context block. */
export const EXECUTION_ROUTING_RECENT_CONTEXT_HEADING =
  'Recent context (bounded — not full history):' as const;

/**
 * Compact a raw recent-summary string into a bounded hand-off slice.
 *
 * Returns `''` when:
 *  - the input is empty/whitespace, or
 *  - compaction yields nothing usable.
 *
 * Otherwise returns the compacted summary, hard-capped to
 * {@link RECENT_SUMMARY_MAX_CHARS}. The cap is enforced here too (not only
 * inside {@link compactRecentSummaryForStorage}) so the contract holds even if
 * the compactor's internal ceiling ever changes: a hand-off slice is NEVER
 * longer than `RECENT_SUMMARY_MAX_CHARS`.
 *
 * The input MUST already be a summary (e.g. a stored `recent_summary`
 * projection), never raw provider history — this function intentionally has no
 * access to and never serializes transcript/tool events.
 */
export function compactRecentSummaryForHandoff(
  recentSummary: string | null | undefined,
): string {
  if (typeof recentSummary !== 'string') return '';
  const trimmed = recentSummary.trim();
  if (trimmed.length === 0) return '';
  const compact = compactRecentSummaryForStorage(trimmed).trim();
  if (compact.length === 0) return '';
  // Defence-in-depth bound: never exceed the recent-summary ceiling regardless
  // of the compactor's own internal cap.
  return compact.length <= RECENT_SUMMARY_MAX_CHARS
    ? compact
    : compact.slice(0, RECENT_SUMMARY_MAX_CHARS);
}

/**
 * Build the recent-context hand-off block appended to a worker prompt.
 *
 * Returns `''` when there is no usable bounded summary (so the caller can
 * concatenate unconditionally and the prompt is unchanged when no context
 * exists). Otherwise returns the stable heading followed by the bounded
 * summary. The whole block (heading + summary) is itself within a small
 * constant of `RECENT_SUMMARY_MAX_CHARS` because the summary slice is bounded.
 */
export function buildExecutionRoutingRecentContextBlock(
  recentSummary: string | null | undefined,
): string {
  const bounded = compactRecentSummaryForHandoff(recentSummary);
  if (bounded.length === 0) return '';
  return `${EXECUTION_ROUTING_RECENT_CONTEXT_HEADING}\n${bounded}`;
}
