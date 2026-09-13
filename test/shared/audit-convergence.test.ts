import { describe, expect, it } from 'vitest';
import {
  AUDIT_BLOCKING_SEVERITIES,
  AUDIT_DEFAULT_BLOCKING_SEVERITIES,
  AUDIT_CONVERGENCE_CONTRACT_ID,
  AUDIT_SEVERITY_DEFINITIONS,
  AUDIT_SEVERITY_LEVELS,
  AUDIT_CONVERGENCE_ROLES,
  buildAuditConvergenceContract,
  buildAuditConvergenceContractRef,
  buildAuditSeverityPolicyLines,
  formatAuditBlockingSeverities,
  normalizeAuditBlockingSeverities,
} from '../../shared/audit-convergence.js';

// Field evidence behind this contract: a supervised feature spent 14 audit
// rounds and 4 failed deployments. Most REWORKs were a point fix introducing a
// sibling defect of the same invariant, severities were undefined, P3/P4 items
// earned their own rounds, slices were audited one by one, and two PASSes missed
// what production then hit. PASS/REWORK stays the only control; this contract
// decides what earns each verdict.
describe('audit convergence contract', () => {
  it('defines exactly P0-P4 and blocks only P0 by default', () => {
    expect(AUDIT_SEVERITY_LEVELS).toEqual(['P0', 'P1', 'P2', 'P3', 'P4']);
    expect(AUDIT_DEFAULT_BLOCKING_SEVERITIES).toEqual(['P0']);
    expect(AUDIT_BLOCKING_SEVERITIES).toEqual(AUDIT_DEFAULT_BLOCKING_SEVERITIES);
    for (const level of AUDIT_SEVERITY_LEVELS) {
      expect(AUDIT_SEVERITY_DEFINITIONS[level].trim().length, `${level} needs a definition`).toBeGreaterThan(0);
    }
  });

  it('normalizes a configured blocking set and never lets it become empty', () => {
    expect(normalizeAuditBlockingSeverities(['P2', 'P0', 'P2'])).toEqual(['P0', 'P2']);
    expect(normalizeAuditBlockingSeverities(['P4', 'P1'])).toEqual(['P1', 'P4']);
    for (const legacyOrInvalid of [undefined, null, [], ['P9'], 'P1', [1, 'x'], {}]) {
      expect(normalizeAuditBlockingSeverities(legacyOrInvalid)).toEqual(['P0']);
    }
    expect(formatAuditBlockingSeverities()).toBe('P0');
    expect(formatAuditBlockingSeverities(['P0', 'P1', 'P2'])).toBe('P0, P1 or P2');
  });

  it('takes the verdict boundary from configuration instead of hardcoding blocking levels', () => {
    const contract = JSON.parse(buildAuditConvergenceContract());
    expect(contract.contractId).toBe(AUDIT_CONVERGENCE_CONTRACT_ID);
    expect(contract.severity).toEqual(AUDIT_SEVERITY_DEFINITIONS);
    expect(contract.verdict.blockingSource).toMatch(/current configuration/);
    expect(contract.verdict.blockingSource).toMatch(/contractRef\.blocking/);
    expect(contract.verdict.blockingSource).toMatch(/P0 when none is given/);
    expect(contract.verdict.REWORK).toMatch(/configured blocking severity/);
    expect(contract.verdict.PASS).toMatch(/no finding at a configured blocking severity/);
    for (const level of ['P1', 'P2', 'P3', 'P4']) {
      expect(contract.verdict.REWORK).not.toContain(level);
      expect(contract.verdict.PASS).not.toContain(level);
    }
  });

  it('explicitly forbids nitpicking or manufacturing findings', () => {
    const contract = JSON.parse(buildAuditConvergenceContract());
    expect(contract.antiNitpick.rule).toMatch(/never nitpick, manufacture, or inflate findings/);
    expect(contract.antiNitpick.severity).toMatch(/never upgrade a finding to reach a blocking level/);
    expect(contract.antiNitpick.noFinding).toMatch(/PASS/);
    expect(contract.antiNitpick.scope).toMatch(/do not expand acceptance/);
  });

  it('renders brief policy lines with the selected levels, the remainder and every definition', () => {
    const lines = buildAuditSeverityPolicyLines(['P1', 'P0']).join('\n');
    expect(lines).toContain('Blocking severities (current configuration): P0, P1.');
    expect(lines).toContain('Non-blocking severities: P2, P3, P4.');
    expect(lines).toMatch(/Do not nitpick or manufacture findings/);
    for (const level of AUDIT_SEVERITY_LEVELS) {
      expect(lines).toContain(`- ${level}: ${AUDIT_SEVERITY_DEFINITIONS[level]}`);
    }
    expect(buildAuditSeverityPolicyLines([]).join('\n')).toContain('Blocking severities (current configuration): P0.');
    expect(buildAuditSeverityPolicyLines([...AUDIT_SEVERITY_LEVELS]).join('\n')).toContain('Non-blocking severities: none.');
  });

  it('carries every convergence rule in one locale-invariant body', () => {
    const contract = JSON.parse(buildAuditConvergenceContract());
    expect(contract.verdict.nonBlocking).toMatch(/never REWORK/);
    expect(contract.verdict.nonBlocking).toMatch(/no separate re-audit/);
    expect(contract.verdict.briefMayNotRaiseBar).toBe(true);
    expect(contract.firstPass.findings).toMatch(/all at once/);
    expect(contract.firstPass.acceptance).toMatch(/every criterion/);
    expect(contract.firstPass.timeBox).toMatch(/not coverage/);
    expect(contract.rework.fix).toMatch(/whole invariant class/);
    expect(contract.rework.forbid).toMatch(/point patch/);
    expect(contract.evidence.structuredResults).toMatch(/implementer or teammate structured test results are valid evidence/);
    expect(contract.evidence.structuredResults).toMatch(/no duplicate run required/);
    expect(contract.evidence.rawArtifacts).toMatch(/raw logs, transcripts, hashes, and bundle attachments/);
    expect(contract.evidence.rawArtifacts).toMatch(/never PASS prerequisites/);
    expect(contract.evidence.rawArtifacts).toMatch(/absence never causes REWORK/);
    expect(contract.evidence.integrity).toMatch(/never fabricate/);
    expect(contract.evidence.integrity).toMatch(/concrete implementation risk/);
    expect(contract.evidence.dbMigration).toMatch(/production-shaped/);
    expect(contract.evidence.deployOrRollback).toMatch(/fault injection/);
    expect(contract.evidence.postDeployGate).toMatch(/secrets/);
    expect(contract.evidence).not.toHaveProperty('missing');
    expect(contract.slices).toMatch(/one combined audit/);
    expect(contract.commentOrDocOnly).toMatch(/binding check only/);
    // The body lives in the system prompt; briefs travel by reference only.
    expect(contract.roles.orchestrator).toMatch(/contractRef/);
    expect(contract.roles.orchestrator).toMatch(/never paste/);
  });

  it('references the contract by id with only the parameters a message needs', () => {
    for (const role of Object.values(AUDIT_CONVERGENCE_ROLES)) {
      const raw = buildAuditConvergenceContractRef(role);
      const ref = JSON.parse(raw);
      expect(ref).toEqual({ contractRef: AUDIT_CONVERGENCE_CONTRACT_ID, role, blocking: ['P0'] });
      expect(JSON.parse(buildAuditConvergenceContractRef(role, ['P2', 'P0'])).blocking).toEqual(['P0', 'P2']);
      // Carrying and referencing stay mechanically distinct.
      expect(raw).not.toContain('"contractId"');
      expect(raw.length).toBeLessThan(buildAuditConvergenceContract().length / 5);
    }
  });
});
