import { describe, expect, it } from 'vitest';
import { normalizeOpenSpecAutoDeliverProjection } from '../src/openspec-auto-deliver-normalize.js';

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
    expect(projection?.auditResults?.[0]?.moduleScores).toHaveLength(5);
    expect(projection?.auditResults?.[0]?.requiredChanges).toEqual(['tighten validation']);
  });
});
