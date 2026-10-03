import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SupervisionTaskRegistry,
  type PersistedSupervisionTaskAssignmentIdentity,
} from '../../src/daemon/supervision-state-store.js';

function identity(name: string): PersistedSupervisionTaskAssignmentIdentity {
  return {
    sessionName: name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    agentType: 'codex-sdk',
    providerFamily: 'openai',
  };
}

describe('authoritative supervision audit round', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('counts distinct final attempts per task without inflation from replay or cancelled rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-audit-round-'));
    roots.push(root);
    const registry = new SupervisionTaskRegistry({ dbPath: join(root, 'state.sqlite') });

    const createTask = (taskId: string) => {
      expect(registry.createOrGet({
        taskId,
        projectName: 'rounds',
        classification: 'independent_top_level',
        objective: `Count rounds for ${taskId}`,
        currentRevision: 'round-revision',
      })).toMatchObject({ ok: true });
    };
    const createAuditor = (taskId: string, assignmentId: string, attemptId: string) => {
      const auditorIdentity = identity(`deck_${assignmentId}`);
      expect(registry.createAssignment({
        taskId,
        assignmentId,
        role: 'auditor',
        identity: auditorIdentity,
        auditAttemptId: attemptId,
        auditRevision: 'round-revision',
      })).toMatchObject({ ok: true });
      return auditorIdentity;
    };
    const appendFinal = (
      taskId: string,
      assignmentId: string,
      attemptId: string,
      auditorIdentity: PersistedSupervisionTaskAssignmentIdentity,
      verdict: 'PASS' | 'REWORK',
      now: number,
      findings = `${verdict} ${attemptId}`,
    ) => registry.appendMatchingAuditReceipt({
      taskId,
      auditorAssignmentId: assignmentId,
      attemptId,
      revision: 'round-revision',
      receiptKind: 'final',
      verdict,
      auditorSessionName: auditorIdentity.sessionName,
      auditorIdentity,
      findings,
      validations: [],
      now,
    });

    createTask('tsk_rounds');
    const r1Identity = createAuditor('tsk_rounds', 'asg_round_r1', 'attempt-r1');
    const r1 = appendFinal('tsk_rounds', 'asg_round_r1', 'attempt-r1', r1Identity, 'REWORK', 100);
    expect(r1).toMatchObject({ ok: true });
    expect(registry.getAuditRound('tsk_rounds', 'attempt-r1')).toBe(1);
    expect(appendFinal('tsk_rounds', 'asg_round_r1', 'attempt-r1', r1Identity, 'REWORK', 101))
      .toMatchObject({ ok: true, replay: true });
    expect(appendFinal(
      'tsk_rounds', 'asg_round_r1', 'attempt-r1', r1Identity, 'REWORK', 102,
      'corrected R1 findings',
    )).toMatchObject({ ok: true, value: { sequence: 2, supersedesReceiptId: expect.any(String) } });
    expect(registry.listAuditReceipts('tsk_rounds').filter((receipt) => (
      receipt.receiptKind === 'final' && receipt.attemptId === 'attempt-r1'
    ))).toHaveLength(2);
    expect(registry.getAuditRound('tsk_rounds', 'attempt-r1')).toBe(1);
    expect(registry.updateAssignment({
      assignmentId: 'asg_round_r1', identity: r1Identity, status: 'cancelled',
    })).toMatchObject({ ok: true });

    const cancelledIdentity = createAuditor('tsk_rounds', 'asg_round_cancelled', 'attempt-cancelled');
    expect(registry.updateAssignment({
      assignmentId: 'asg_round_cancelled',
      identity: cancelledIdentity,
      status: 'cancelled',
    })).toMatchObject({ ok: true });
    expect(registry.getAuditRound('tsk_rounds', 'attempt-cancelled')).toBeUndefined();

    const replacedIdentity = createAuditor('tsk_rounds', 'asg_round_replaced', 'attempt-replaced');
    expect(registry.updateAssignment({
      assignmentId: 'asg_round_replaced',
      identity: replacedIdentity,
      status: 'cancelled',
    })).toMatchObject({ ok: true });
    expect(registry.getAuditRound('tsk_rounds', 'attempt-replaced')).toBeUndefined();

    const r2Identity = createAuditor('tsk_rounds', 'asg_round_r2', 'attempt-r2');
    expect(appendFinal('tsk_rounds', 'asg_round_r2', 'attempt-r2', r2Identity, 'PASS', 200))
      .toMatchObject({ ok: true });
    expect(registry.getAuditRound('tsk_rounds', 'attempt-r2')).toBe(2);
    expect(registry.updateAssignment({
      assignmentId: 'asg_round_r2', identity: r2Identity, status: 'cancelled',
    })).toMatchObject({ ok: true });

    const r3Identity = createAuditor('tsk_rounds', 'asg_round_r3', 'attempt-r3');
    expect(appendFinal('tsk_rounds', 'asg_round_r3', 'attempt-r3', r3Identity, 'PASS', 300))
      .toMatchObject({ ok: true });
    expect(registry.getAuditRound('tsk_rounds', 'attempt-r3')).toBe(3);

    createTask('tsk_other_rounds');
    const otherIdentity = createAuditor('tsk_other_rounds', 'asg_other_r1', 'attempt-other-r1');
    expect(appendFinal('tsk_other_rounds', 'asg_other_r1', 'attempt-other-r1', otherIdentity, 'PASS', 400))
      .toMatchObject({ ok: true });
    expect(registry.getAuditRound('tsk_other_rounds', 'attempt-other-r1')).toBe(1);
    expect(registry.getAuditRound('tsk_other_rounds', 'attempt-r3')).toBeUndefined();

    registry.close();
  });
});
