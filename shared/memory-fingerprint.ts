import { createHash } from 'node:crypto';
/**
 * Content fingerprinting for processed memory projections.
 *
 * Motivation: every call to `writeProcessedProjection()` used to insert a new
 * row with a fresh UUID even when the summary text was byte-for-byte identical
 * to an existing row. Replication carried each fresh UUID to the server's
 * shared_context_projections table (ON CONFLICT(id) DO UPDATE — but the IDs
 * differed) so the server accumulated N duplicate rows. Recall then returned
 * all N at the same similarity score, producing the "three identical cards"
 * symptom in the Related-history panel.
 *
 * Fingerprinting gives us:
 *   - a cheap primary key for "same memory, different turn" so the writer can
 *     reuse the existing row instead of producing a new UUID, and
 *   - a dedup key for recall-time cleanup so stored duplicates from before
 *     the store-time fix still collapse to a single card.
 *
 * The fingerprint intentionally excludes sourceEventIds, createdAt, and any
 * content-field noise so a second summary with "same decisions, different
 * turn" collapses with the first. It includes namespace + class so two
 * different projects or projection classes (recent_summary vs.
 * durable_memory_candidate) are never cross-matched.
 */

/** Normalize a summary for equality-based dedup.
 *  - lowercase (case-insensitive)
 *  - collapse all whitespace runs to a single space
 *  - strip leading/trailing whitespace
 *  Does NOT strip punctuation — two summaries that differ only by a trailing
 *  "." or "!" are rare and, if they do differ, safer to keep separate than to
 *  collapse by accident.
 */
export function normalizeSummaryForFingerprint(summary: string): string {
  return summary.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Deterministic content key for a processed projection.
 *  Same (namespaceKey, class, normalized summary) always produces the same
 *  string. Opaque by design — callers should treat it as a fingerprint, not
 *  a parsable structure.
 */
export function fingerprintProjection(args: {
  namespaceKey: string;
  projectionClass: string;
  summary: string;
}): string {
  const normalized = normalizeSummaryForFingerprint(args.summary);
  // Use a simple null-separated join. The individual components never contain
  // U+0000 by contract (namespaceKey is a slash-separated path, class is a
  // fixed enum, summary is user-facing text), so this is unambiguous without
  // needing a real hash function that would pull in crypto on hot paths.
  return `${args.namespaceKey}\u0000${args.projectionClass}\u0000${normalized}`;
}


/** Return a stable SHA-256 hex fingerprint for already-normalized memory text. */
export function computeFingerprint(normalizedSummary: string): string {
  return createHash('sha256').update(normalizedSummary, 'utf8').digest('hex');
}
