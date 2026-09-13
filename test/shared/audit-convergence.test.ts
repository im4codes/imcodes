import { describe, expect, it } from 'vitest';
import {
  AUDIT_BLOCKING_SEVERITIES,
  AUDIT_CONVERGENCE_CONTRACT_ID,
  AUDIT_SEVERITY_DEFINITIONS,
  AUDIT_SEVERITY_LEVELS,
  AUDIT_CONVERGENCE_ROLES,
  buildAuditConvergenceContract,
  buildAuditConvergenceContractRef,
} from '../../shared/audit-convergence.js';

// Field evidence behind this contract: a supervised feature spent 14 audit
// rounds and 4 failed deployments. Most REWORKs were a point fix introducing a
// sibling defect of the same invariant, severities were undefined, P3/P4 items
// earned their own rounds, slices were audited one by one, and two PASSes missed
// what production then hit. PASS/REWORK stays the only control; this contract
// decides what earns each verdict.
describe('audit convergence contract', () => {
  it('defines exactly P0-P4 and treats P0-P2 as blocking', () => {
    expect(AUDIT_SEVERITY_LEVELS).toEqual(['P0', 'P1', 'P2', 'P3', 'P4']);
    expect(AUDIT_BLOCKING_SEVERITIES).toEqual(['P0', 'P1', 'P2']);
    for (const level of AUDIT_SEVERITY_LEVELS) {
      expect(AUDIT_SEVERITY_DEFINITIONS[level].trim().length, `${level} needs a definition`).toBeGreaterThan(0);
    }
  });

  it('derives the verdict boundary from the blocking severities, never restating it', () => {
    const contract = JSON.parse(buildAuditConvergenceContract());
    expect(contract.contractId).toBe(AUDIT_CONVERGENCE_CONTRACT_ID);
    expect(contract.severity).toEqual(AUDIT_SEVERITY_DEFINITIONS);
    for (const blocking of AUDIT_BLOCKING_SEVERITIES) {
      expect(contract.verdict.REWORK).toContain(blocking);
      expect(contract.verdict.PASS).not.toContain(blocking);
    }
    for (const level of AUDIT_SEVERITY_LEVELS.filter((item) => !(AUDIT_BLOCKING_SEVERITIES as readonly string[]).includes(item))) {
      expect(contract.verdict.REWORK).not.toContain(level);
      expect(contract.verdict.nonBlocking).toContain(level);
    }
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
      expect(ref).toEqual({ contractRef: AUDIT_CONVERGENCE_CONTRACT_ID, role, blocking: [...AUDIT_BLOCKING_SEVERITIES] });
      // Carrying and referencing stay mechanically distinct.
      expect(raw).not.toContain('"contractId"');
      expect(raw.length).toBeLessThan(buildAuditConvergenceContract().length / 5);
    }
  });
});
