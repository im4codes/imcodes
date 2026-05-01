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

export const FINGERPRINT_KINDS = ['summary', 'preference', 'skill', 'decision', 'note'] as const;
export type FingerprintKind = (typeof FINGERPRINT_KINDS)[number];

export const MEMORY_FINGERPRINT_VERSIONS = ['v1'] as const;
export type MemoryFingerprintVersion = (typeof MEMORY_FINGERPRINT_VERSIONS)[number];

export interface ComputeMemoryFingerprintArgs {
  kind: FingerprintKind;
  content: string;
  scopeKey?: string;
  version?: MemoryFingerprintVersion;
}

const MEMORY_FINGERPRINT_DOMAIN = 'imcodes:memory-fingerprint';
const FRONT_MATTER_PATTERN = /^\uFEFF?---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/;

function normalizeUnicodeAndLineEndings(content: string): string {
  return content.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\u0000/g, '\uFFFD');
}

function collapseWhitespace(content: string): string {
  return content.replace(/\s+/gu, ' ').trim();
}

function normalizeCaseFoldedText(content: string): string {
  return collapseWhitespace(normalizeUnicodeAndLineEndings(content)).toLocaleLowerCase('en-US');
}

function stripPreferencePrefixes(content: string): string {
  return normalizeUnicodeAndLineEndings(content)
    .split('\n')
    .map((line) => line.replace(/^\s*@pref:\s*/iu, ''))
    .join('\n');
}

function stripSkillFrontMatter(content: string): string {
  return normalizeUnicodeAndLineEndings(content).replace(FRONT_MATTER_PATTERN, '');
}

function normalizeSkillContent(content: string): string {
  return stripSkillFrontMatter(content)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeNoteContent(content: string): string {
  return collapseWhitespace(normalizeUnicodeAndLineEndings(content));
}

/** Normalize a summary for equality-based dedup.
 *  - lowercase (case-insensitive)
 *  - collapse all whitespace runs to a single space
 *  - strip leading/trailing whitespace
 *  Does NOT strip punctuation — two summaries that differ only by a trailing
 *  "." or "!" are rare and, if they do differ, safer to keep separate than to
 *  collapse by accident.
 */
export function normalizeSummaryForFingerprint(summary: string): string {
  return normalizeCaseFoldedText(summary);
}

export function normalizeContentForFingerprint(kind: FingerprintKind, content: string): string {
  switch (kind) {
    case 'summary':
      return normalizeSummaryForFingerprint(content);
    case 'preference':
      return normalizeCaseFoldedText(stripPreferencePrefixes(content));
    case 'skill':
      return normalizeSkillContent(content);
    case 'decision':
      return normalizeCaseFoldedText(content);
    case 'note':
      return normalizeNoteContent(content);
  }
}

/**
 * Canonical post-1.1 memory fingerprint API.
 *
 * The hash preimage includes version, kind, scope/namespace key, and normalized
 * content. Including `scopeKey` prevents otherwise-identical memories from
 * being deduplicated across authorization or namespace boundaries.
 */
export function computeMemoryFingerprint(args: ComputeMemoryFingerprintArgs): string {
  const version = args.version ?? 'v1';
  const normalized = normalizeContentForFingerprint(args.kind, args.content);
  const normalizedScope = normalizeUnicodeAndLineEndings(args.scopeKey ?? '').trim();
  const preimage = [MEMORY_FINGERPRINT_DOMAIN, version, args.kind, normalizedScope, normalized].join('\u0000');
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

/** Deterministic content key for a processed projection.
 *  Same (namespaceKey, class, normalized summary) always produces the same
 *  string. Opaque by design — callers should treat it as a fingerprint, not
 *  a parsable structure.
 *
 * @deprecated Internal legacy projection helper. New memory call sites should
 * use `computeMemoryFingerprint({ kind, content, scopeKey, version: 'v1' })`.
 */
export function fingerprintProjection(args: {
  namespaceKey: string;
  projectionClass: string;
  summary: string;
}): string {
  const normalized = normalizeSummaryForFingerprint(args.summary);
  // Keep the historical un-hashed key shape for existing local callers.
  return `${args.namespaceKey}\u0000${args.projectionClass}\u0000${normalized}`;
}

/**
 * Return a stable SHA-256 hex fingerprint for already-normalized memory text.
 *
 * @deprecated Internal summary-only helper. New memory call sites should use
 * `computeMemoryFingerprint()` so the kind, version, and scope are in the
 * fingerprint preimage.
 */
export function computeFingerprint(normalizedSummary: string): string {
  return createHash('sha256').update(normalizedSummary, 'utf8').digest('hex');
}
