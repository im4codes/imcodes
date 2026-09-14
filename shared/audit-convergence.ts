/**
 * The audit convergence contract: what earns PASS and what earns REWORK.
 *
 * PASS/REWORK stays the only control of an audit loop. This contract decides
 * which findings block, what a first pass must cover, what a repair must fix and
 * which evidence a change type needs, so an audit converges in one or two rounds
 * instead of surfacing one small defect per round.
 *
 * Field evidence behind every clause: one supervised feature took 14 audit rounds
 * and 4 failed deployments. Severity was undefined, so P3/P4 items earned rounds
 * of their own; most REWORKs were a minimal point fix that introduced a sibling
 * defect of the same invariant; slices were audited one by one; and two PASSes
 * were issued on evidence that could not have caught what production then hit.
 *
 * Delivery: the body is registered once in the stable system prompt of every
 * managed session. Audit, re-audit and rework messages carry only the reference
 * (contract id plus the parameters that apply there), never the body.
 */

export const AUDIT_CONVERGENCE_CONTRACT_ID = 'audit_convergence_v1' as const;

export const AUDIT_SEVERITY_LEVELS = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
export type AuditSeverity = typeof AUDIT_SEVERITY_LEVELS[number];

/**
 * Blocking severities when nothing is configured (and for legacy snapshots that
 * predate the setting). Only P0 blocks by default; every other level is a
 * non-blocking follow-up unless the user explicitly selects it.
 */
export const AUDIT_DEFAULT_BLOCKING_SEVERITIES = ['P0'] as const satisfies readonly AuditSeverity[];

/** @deprecated Use the configured set; kept as the default-set alias for existing imports. */
export const AUDIT_BLOCKING_SEVERITIES = AUDIT_DEFAULT_BLOCKING_SEVERITIES;

export function isAuditSeverity(value: unknown): value is AuditSeverity {
  return typeof value === 'string' && (AUDIT_SEVERITY_LEVELS as readonly string[]).includes(value);
}

/**
 * Canonical blocking set: known levels only, deduplicated, in P0..P4 order.
 * Anything empty, missing or malformed falls back to the default (P0), so a
 * configuration can never silently block nothing.
 */
export function normalizeAuditBlockingSeverities(value: unknown): AuditSeverity[] {
  const selected = new Set(Array.isArray(value) ? value.filter(isAuditSeverity) : []);
  const levels = AUDIT_SEVERITY_LEVELS.filter((level) => selected.has(level));
  return levels.length > 0 ? levels : [...AUDIT_DEFAULT_BLOCKING_SEVERITIES];
}

export const AUDIT_SEVERITY_DEFINITIONS: Readonly<Record<AuditSeverity, string>> = {
  P0: 'data loss or corruption, security hole, production down or unrecoverable; fails an explicit, traceable user requirement or acceptance criterion; regression introduced by this change',
  P1: 'serious functional defect outside explicit acceptance; hang or permanent block; partial write',
  P2: 'edge-case, concurrency or error-path defect; changed behavior lacks a key test',
  P3: 'maintainability issue with no correctness impact',
  P4: 'style, naming, wording or optional improvement',
};

export const AUDIT_CONVERGENCE_ROLES = {
  ORCHESTRATOR: 'orchestrator',
  AUDITOR: 'auditor',
  IMPLEMENTER: 'implementer',
} as const;
export type AuditConvergenceRole = typeof AUDIT_CONVERGENCE_ROLES[keyof typeof AUDIT_CONVERGENCE_ROLES];

function nonBlockingSeverities(blocking: readonly AuditSeverity[]): AuditSeverity[] {
  return AUDIT_SEVERITY_LEVELS.filter((level) => !blocking.includes(level));
}

/** Full body, for the stable system prompt only. */
export function buildAuditConvergenceContract(): string {
  const defaults = AUDIT_DEFAULT_BLOCKING_SEVERITIES.join('/');
  return JSON.stringify({
    contractId: AUDIT_CONVERGENCE_CONTRACT_ID,
    v: 1,
    severity: AUDIT_SEVERITY_DEFINITIONS,
    verdict: {
      blockingSource: `the current configuration: the blocking list carried by contractRef.blocking and the audit brief; ${defaults} when none is given`,
      REWORK: 'at least one finding at a configured blocking severity',
      PASS: 'no finding at a configured blocking severity',
      nonBlocking: 'every other severity: record as follow-ups; never REWORK, no separate re-audit',
      briefMayNotRaiseBar: true,
    },
    antiNitpick: {
      rule: 'never nitpick, manufacture, or inflate findings to justify REWORK; do not hunt for problems for their own sake',
      severity: 'assign the level that the definition actually matches, backed by concrete evidence; never upgrade a finding merely to reach a blocking level',
      p0Boundary: 'acceptance-based P0 must cite the exact explicit requirement or criterion and show it is unmet; regression-based P0 must identify supported prior behavior and causally tie the break to this change',
      noFinding: 'when no finding reaches a configured blocking severity, PASS',
      scope: 'judge against the stated acceptance and scope only; never invent requirements, expand acceptance, use out-of-scope extreme hypotheses, or reopen accepted non-blocking items',
    },
    firstPass: {
      findings: 'all at once, each with severity, violated invariant, location and evidence',
      acceptance: 'trace every criterion to evidence; an unmet explicit criterion is P0 and an untraced criterion blocks PASS',
      timeBox: 'limits reruns, not coverage',
    },
    rework: {
      fix: 'the whole invariant class at every affected instance',
      forbid: 'minimal point patch',
      test: 'a counterexample covering the class',
      reaudit: 'repair delta plus closure of every prior blocking class',
    },
    evidence: {
      structuredResults: 'exact-bound implementer or teammate structured test results are valid evidence after coherence review; no duplicate run required',
      rawArtifacts: 'raw logs, transcripts, hashes, and bundle attachments are never PASS prerequisites; their absence never causes REWORK',
      integrity: 'never fabricate results; a conflicting result or concrete implementation risk may justify a minimal targeted counterexample',
      dbMigration: 'production-shaped data: existing ids, soft-deleted rows, retry after partial DDL, concurrent writers',
      deployOrRollback: 'fault injection',
      postDeployGate: 'preflight required secrets and base URLs before running',
    },
    slices: 'one combined audit of the integrated result; never audit slices one by one',
    commentOrDocOnly: 'binding check only, no re-audit',
    roles: {
      orchestrator: 'forward only the contractRef and its params in every audit, re-audit and rework brief; never paste this body',
      auditor: 'report every finding in one pass; PASS only when no blocking finding remains',
      implementer: 'fix every blocking finding for its whole class before requesting re-audit',
    },
  });
}

/** "P0, P1 or P2" -- derived, so prose can never drift from the blocking set. */
export function formatAuditBlockingSeverities(
  levels: readonly AuditSeverity[] = AUDIT_DEFAULT_BLOCKING_SEVERITIES,
): string {
  const normalized = normalizeAuditBlockingSeverities(levels);
  return normalized.length > 1
    ? `${normalized.slice(0, -1).join(', ')} or ${normalized[normalized.length - 1]}`
    : normalized.join('');
}

/** What an audit, re-audit or rework message carries instead of the body. */
export function buildAuditConvergenceContractRef(
  role: AuditConvergenceRole,
  blocking: readonly AuditSeverity[] = AUDIT_DEFAULT_BLOCKING_SEVERITIES,
): string {
  return JSON.stringify({
    contractRef: AUDIT_CONVERGENCE_CONTRACT_ID,
    role,
    blocking: normalizeAuditBlockingSeverities(blocking),
  });
}

/**
 * Brief lines that make the configured gate explicit for one audit: the exact
 * blocking levels, the non-blocking remainder and every level definition.
 */
export function buildAuditSeverityPolicyLines(blocking: readonly AuditSeverity[]): string[] {
  const levels = normalizeAuditBlockingSeverities(blocking);
  const nonBlocking = nonBlockingSeverities(levels);
  return [
    `Blocking severities (current configuration): ${levels.join(', ')}. Only findings at these levels justify REWORK.`,
    `Non-blocking severities: ${nonBlocking.length > 0 ? nonBlocking.join(', ') : 'none'}. Record them as follow-ups; they never justify REWORK.`,
    'Do not nitpick or manufacture findings; assign the level the definition matches, with concrete evidence.',
    'Severity definitions:',
    ...AUDIT_SEVERITY_LEVELS.map((level) => `- ${level}: ${AUDIT_SEVERITY_DEFINITIONS[level]}`),
  ];
}
