import { describe, expect, it } from 'vitest';
import {
  normalizeOpenSpecAutoDeliverListRow,
  normalizeOpenSpecAutoDeliverProjection,
  openSpecAutoDeliverRowFromProjection,
} from '../src/openspec-auto-deliver-normalize.js';

describe('normalizeOpenSpecAutoDeliverProjection', () => {
  it('preserves full-projection audit result history for details UI', () => {
    const projection = normalizeOpenSpecAutoDeliverProjection({
      visibility: 'full',
      projectionVersion: 3,
      generation: 2,
      runId: 'run-1',
      changeName: 'openspec-auto-delivery',
      status: 'passed',
      stage: 'passed',
      owningMainSessionName: 'deck_brain',
      auditResults: [{
        stage: 'implementation_audit_repair',
        roundIndex: 1,
        attemptId: 'attempt-1',
        generation: 1,
        discussionFilePath: '/repo/.imc/discussions/audit.md',
        verdict: 'REWORK',
        moduleScores: [
          { module: 'spec', score: 8, max_score: 10, summary: 'Spec is clear.' },
          { module: 'tasks', score: 8, max_score: 10, summary: 'Tasks are aligned.' },
          { module: 'implementation', score: 7, max_score: 10, summary: 'Implementation needs follow-up.' },
          { module: 'tests', score: 7, max_score: 10, summary: 'Tests need follow-up.' },
          { module: 'risk', score: 8, max_score: 10, summary: 'Risk is bounded.' },
        ],
        uncheckedTasks: [],
        requiredChanges: ['tighten validation'],
        repairSummaries: [{ files: ['src/demo.ts'], reason: 'Updated validation.' }],
        evidence: [{ source: 'audit_reported', summary: 'Audit completed.' }],
        completedAt: 123,
      }],
    });

    expect(projection?.visibility).toBe('full');
    expect(projection?.auditResults).toHaveLength(1);
    expect(projection?.auditResults?.[0]?.verdict).toBe('REWORK');
    expect(projection?.auditResults?.[0]?.discussionFilePath).toBe('/repo/.imc/discussions/audit.md');
    expect(projection?.auditResults?.[0]?.moduleScores).toHaveLength(5);
    expect(projection?.auditResults?.[0]?.requiredChanges).toEqual(['tighten validation']);
  });

  it('preserves lifecycle latest-message fields for recovery/list rows', () => {
    const projection = normalizeOpenSpecAutoDeliverProjection({
      visibility: 'full',
      projectionVersion: 4,
      generation: 2,
      runId: 'run-lifecycle',
      changeName: 'openspec-auto-delivery',
      status: 'spec_audit_repair',
      stage: 'spec_audit_repair',
      owningMainSessionName: 'deck_brain',
      lastMessage: 'spec_audit_repair_p2p_started',
    });

    expect(projection?.visibility).toBe('full');
    expect(projection?.recentFinding).toBe('spec_audit_repair_p2p_started');
    expect(projection ? openSpecAutoDeliverRowFromProjection(projection).recentFinding : undefined)
      .toBe('spec_audit_repair_p2p_started');

    const row = normalizeOpenSpecAutoDeliverListRow({
      visibility: 'full',
      projectionVersion: 5,
      runId: 'run-row',
      changeName: 'openspec-auto-delivery',
      status: 'implementation_audit_repair',
      stage: 'implementation_audit_repair',
      owningMainSessionName: 'deck_brain',
      lastMessage: 'implementation_audit_repair_p2p_started',
    });

    expect(row?.recentFinding).toBe('implementation_audit_repair_p2p_started');
  });

  it('preserves pre-repair and final score snapshots for details UI', () => {
    const projection = normalizeOpenSpecAutoDeliverProjection({
      visibility: 'full',
      projectionVersion: 6,
      generation: 3,
      runId: 'run-scores',
      changeName: 'openspec-auto-delivery',
      status: 'passed',
      stage: 'passed',
      owningMainSessionName: 'deck_brain',
      auditBeforeRepair: {
        phase: 'audit_before_repair',
        stage: 'implementation_audit_repair',
        roundIndex: 1,
        attemptId: 'attempt-before',
        generation: 2,
        verdict: 'REWORK',
        summary: 'implementation_audit_rework_requires_repair',
        completedAt: 123,
        moduleScores: [
          { module: 'implementation', score: 5, max_score: 10, summary: 'Needs repair.' },
        ],
      },
      finalAfterRepair: {
        phase: 'final_after_repair',
        stage: 'implementation_audit_repair',
        roundIndex: 2,
        attemptId: 'attempt-final',
        generation: 2,
        verdict: 'PASS',
        summary: 'final_audit_passed',
        completedAt: 456,
        moduleScores: [
          { module: 'implementation', score: 9, max_score: 10, summary: 'Repaired.' },
        ],
      },
    });

    expect(projection?.auditBeforeRepair).toMatchObject({
      phase: 'audit_before_repair',
      verdict: 'REWORK',
      roundIndex: 1,
    });
    expect(projection?.auditBeforeRepair?.moduleScores).toEqual([
      { module: 'implementation', score: 5, max_score: 10, summary: 'Needs repair.' },
    ]);
    expect(projection?.finalAfterRepair).toMatchObject({
      phase: 'final_after_repair',
      verdict: 'PASS',
      roundIndex: 2,
    });
    expect(projection?.finalAfterRepair?.moduleScores).toEqual([
      { module: 'implementation', score: 9, max_score: 10, summary: 'Repaired.' },
    ]);
  });
});
