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

/** Findings at these levels must be fixed: any of them means REWORK. */
export const AUDIT_BLOCKING_SEVERITIES = ['P0', 'P1', 'P2'] as const satisfies readonly AuditSeverity[];

export const AUDIT_SEVERITY_DEFINITIONS: Readonly<Record<AuditSeverity, string>> = {
  P0: 'data loss or corruption, security hole, production down or unrecoverable',
  P1: 'violates an explicit acceptance criterion, regression, hang or permanent block, partial write',
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

const nonBlockingSeverities = AUDIT_SEVERITY_LEVELS.filter(
  (level) => !(AUDIT_BLOCKING_SEVERITIES as readonly AuditSeverity[]).includes(level),
);

/** Full body, for the stable system prompt only. */
export function buildAuditConvergenceContract(): string {
  const blocking = AUDIT_BLOCKING_SEVERITIES.join('/');
  const nonBlocking = nonBlockingSeverities.join('/');
  return JSON.stringify({
    contractId: AUDIT_CONVERGENCE_CONTRACT_ID,
    v: 1,
    severity: AUDIT_SEVERITY_DEFINITIONS,
    verdict: {
      REWORK: `any ${blocking} finding`,
      PASS: `no finding above ${nonBlocking}`,
      nonBlocking: `${nonBlocking}: record as follow-ups; never REWORK, no separate re-audit`,
      briefMayNotRaiseBar: true,
    },
    firstPass: {
      findings: 'all at once, each with severity, violated invariant, location and evidence',
      acceptance: 'trace every criterion to evidence; an untraced criterion blocks PASS',
      timeBox: 'limits reruns, not coverage',
    },
    rework: {
      fix: 'the whole invariant class at every affected instance',
      forbid: 'minimal point patch',
      test: 'a counterexample covering the class',
      reaudit: `repair delta plus closure of every prior ${blocking} class`,
    },
    evidence: {
      dbMigration: 'production-shaped data: existing ids, soft-deleted rows, retry after partial DDL, concurrent writers',
      deployOrRollback: 'fault injection',
      postDeployGate: 'preflight required secrets and base URLs before running',
      missing: 'P1',
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
export function formatAuditBlockingSeverities(): string {
  const levels = [...AUDIT_BLOCKING_SEVERITIES];
  return levels.length > 1 ? `${levels.slice(0, -1).join(', ')} or ${levels[levels.length - 1]}` : levels.join('');
}

/** What an audit, re-audit or rework message carries instead of the body. */
export function buildAuditConvergenceContractRef(role: AuditConvergenceRole): string {
  return JSON.stringify({
    contractRef: AUDIT_CONVERGENCE_CONTRACT_ID,
    role,
    blocking: [...AUDIT_BLOCKING_SEVERITIES],
  });
}
