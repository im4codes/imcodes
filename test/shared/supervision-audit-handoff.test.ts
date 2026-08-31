import { describe, expect, it } from 'vitest';
import {
  decideSupervisionAuditHandoff,
  findUnownedPassedTasks,
  SUPERVISION_AUDITABLE_STATUSES,
  type SupervisionAuditReceipt,
  type SupervisionHandoffContext,
} from '../../shared/supervision-audit-handoff.js';
import {
  canReleaseSupervisionTaskFinalization,
  canHandOffValidatedSupervisionManifestRow,
  SUPERVISION_TASK_LIFECYCLE_STATUSES,
  type SupervisionTaskFinalizationRecord,
  type SupervisionTaskFinalizationReleaseInput,
} from '../../shared/supervision-config.js';

const ATTEMPT = '140fa35f-126f-4175-884d-1a2464bb25e8';
const REVISION = '3eacaeca54522a05cb174831f19a2721d2e102c805b269437b3f9988064ac4ae';

function receipt(over: Partial<SupervisionAuditReceipt> = {}): SupervisionAuditReceipt {
  return {
    attemptId: ATTEMPT,
    taskId: 'tsk_live-task-console_01J',
    assignmentId: 'asg_live-task-console_01J',
    revision: REVISION,
    verdict: 'PASS',
    auditorSessionName: 'deck_sub_1g6w5672',
    receivedAt: 1000,
    ...over,
  };
}

function context(over: Partial<SupervisionHandoffContext> = {}): SupervisionHandoffContext {
  return {
    currentStatus: 'auditing',
    expectedAttemptId: ATTEMPT,
    currentRevision: REVISION,
    declaredIntegrationOwner: 'deck_cd_cc2',
    developmentOwner: 'deck_sub_4s48141x',
    appliedAttemptIds: [],
    ...over,
  };
}

describe('matching PASS', () => {
  it('promotes, resolves the owner, queues integration and states nextAction', () => {
    const decision = decideSupervisionAuditHandoff({ receipt: receipt(), context: context() });
    expect(decision.action).toBe('promote_to_integration');
    expect(decision.nextStatus).toBe('ready_for_integration');
    expect(decision.integrationOwner).toBe('deck_cd_cc2');
    expect(decision.recordAttestation).toBe(true);
    expect(decision.queueOp).toEqual({
      op: 'upsert', taskId: 'tsk_live-task-console_01J',
      integrationOwner: 'deck_cd_cc2', attemptId: ATTEMPT, revision: REVISION,
    });
    expect(decision.nextAction).toContain('deck_cd_cc2');
    expect(decision.nextAction).toContain(ATTEMPT);
    expect(decision.refusal).toBeUndefined();
  });

  it('falls back to the parent integration owner when the child declares none', () => {
    const decision = decideSupervisionAuditHandoff({
      receipt: receipt(),
      context: context({ declaredIntegrationOwner: undefined, parentIntegrationOwner: 'deck_cd_brain' }),
    });
    expect(decision.action).toBe('promote_to_integration');
    expect(decision.integrationOwner).toBe('deck_cd_brain');
  });

  it('NEVER advances a PASS with no resolvable owner, and gives a durable reason', () => {
    const decision = decideSupervisionAuditHandoff({
      receipt: receipt(),
      context: context({ declaredIntegrationOwner: '  ', parentIntegrationOwner: undefined }),
    });
    expect(decision.action).toBe('hold');
    expect(decision.nextStatus).toBeUndefined();
    expect(decision.refusal).toBe('unresolved_integration_owner');
    expect(decision.blockedReason).toBeTruthy();
    // The attestation is still recorded: the audit really happened.
    expect(decision.recordAttestation).toBe(true);
  });
});

describe('matching REWORK', () => {
  it('returns to rework, binds the owner and revision, and clears the queue', () => {
    const decision = decideSupervisionAuditHandoff({
      receipt: receipt({ verdict: 'REWORK', findings: 'phase not validated' }),
      context: context(),
    });
    expect(decision.action).toBe('return_to_rework');
    expect(decision.nextStatus).toBe('rework');
    expect(decision.developmentOwner).toBe('deck_sub_4s48141x');
    expect(decision.queueOp?.op).toBe('remove');
    expect(decision.nextAction).toContain('deck_sub_4s48141x');
    expect(decision.nextAction).toContain(REVISION);
    expect(decision.recordAttestation).toBe(true);
  });

  it('flags a REWORK carrying no findings instead of silently accepting it', () => {
    const decision = decideSupervisionAuditHandoff({
      receipt: receipt({ verdict: 'REWORK' }), context: context(),
    });
    expect(decision.action).toBe('return_to_rework');
    expect(decision.blockedReason).toBeTruthy();
  });

  it('holds a REWORK with no development owner', () => {
    const decision = decideSupervisionAuditHandoff({
      receipt: receipt({ verdict: 'REWORK' }), context: context({ developmentOwner: '  ' }),
    });
    expect(decision.action).toBe('hold');
    expect(decision.refusal).toBe('unresolved_development_owner');
  });

  it('returns combined integration REWORK to the integration owner, not a slice owner', () => {
    const decision = decideSupervisionAuditHandoff({
      receipt: receipt({ verdict: 'REWORK', findings: 'combined conflict' }),
      context: context({
        classification: 'integration_task',
        declaredIntegrationOwner: 'deck_cd_brain',
        developmentOwner: 'deck_slice_owner',
      }),
    });
    expect(decision).toMatchObject({
      action: 'return_to_rework',
      developmentOwner: 'deck_cd_brain',
      nextStatus: 'rework',
    });
    expect(decision.nextAction).not.toContain('deck_slice_owner');
  });
});

describe('merge-before-audit finalization', () => {
  const combinedRevision = 'combined-r1';
  const attemptId = 'overall-attempt-r1';
  const slices: SupervisionTaskFinalizationRecord[] = [
    {
      taskId: 'slice-a', topLevelTaskId: 'top', classification: 'integration_slice',
      ownerSession: 'deck_slice_a', revision: 'slice-a-r1', state: 'validated',
      ownedFiles: ['src/a.ts'],
    },
    {
      taskId: 'slice-b', topLevelTaskId: 'top', classification: 'integration_slice',
      ownerSession: 'deck_slice_b', revision: 'slice-b-r2', state: 'ready_for_integration',
      ownedFiles: ['src/b.ts'],
    },
  ];
  const task: SupervisionTaskFinalizationRecord = {
    taskId: 'integration', topLevelTaskId: 'top', classification: 'integration_task',
    integrationOwnerSession: 'deck_cd_brain', integrationBoundary: 'one coherent feature',
    acceptance: ['combined behavior passes'], revision: combinedRevision,
    overallAuditAttemptId: attemptId, overallAuditRevision: combinedRevision,
    integrationManifest: slices, ownedFiles: ['src/a.ts', 'src/b.ts'],
  };
  const pass: SupervisionTaskFinalizationReleaseInput = {
    attemptId, revision: combinedRevision, verdict: 'PASS',
    pathspecs: ['src/a.ts', 'src/b.ts'], stagedPaths: ['src/a.ts', 'src/b.ts'],
    conflictedPaths: [], untrackedOtherOwnerPaths: [],
  };

  it('accepts validated slice rows with no per-slice audit attempt or verdict', () => {
    expect(slices.every((slice) => slice.auditAttemptId === undefined && slice.verdict === undefined)).toBe(true);
    expect(canReleaseSupervisionTaskFinalization(task, pass)).toBe(true);
  });

  it('does not let omitted, empty, or misleading ownedFiles veto a validated handoff', () => {
    for (const ownedFiles of [undefined, [], ['stale/metadata-only.ts']] as const) {
      expect(canHandOffValidatedSupervisionManifestRow({
        ...slices[0], ownedFiles,
      })).toBe(true);
    }
  });

  it('refuses stale/mismatched overall PASS and any non-exact staged set', () => {
    expect(canReleaseSupervisionTaskFinalization(task, { ...pass, attemptId: 'stale-attempt' })).toBe(false);
    expect(canReleaseSupervisionTaskFinalization(task, { ...pass, revision: 'stale-revision' })).toBe(false);
    expect(canReleaseSupervisionTaskFinalization(task, { ...pass, stagedPaths: ['src/a.ts'] })).toBe(false);
    expect(canReleaseSupervisionTaskFinalization(task, { ...pass, stagedPaths: [...pass.stagedPaths!, 'src/extra.ts'] })).toBe(false);
  });

  it('keeps historical per-slice PASS manifests compatible', () => {
    const historical = slices.map((slice, index) => ({
      ...slice,
      classification: undefined,
      auditAttemptId: `slice-attempt-${index}`,
      auditRevision: slice.revision,
      verdict: 'PASS' as const,
    }));
    expect(canReleaseSupervisionTaskFinalization({
      ...task,
      classification: undefined,
      integrationManifest: historical,
    }, pass)).toBe(true);
  });
});

describe('non-advancing receipts', () => {
  it('does not advance on BLOCKED', () => {
    const decision = decideSupervisionAuditHandoff({
      receipt: receipt({ blocked: true, blockedReason: 'no toolchain', verdict: undefined }),
      context: context(),
    });
    expect(decision.action).toBe('hold');
    expect(decision.nextStatus).toBeUndefined();
    expect(decision.refusal).toBe('audit_blocked');
    expect(decision.blockedReason).toBe('no toolchain');
    expect(decision.recordAttestation).toBe(false);
  });

  it('supplies a reason even when a blocked auditor gives none', () => {
    const decision = decideSupervisionAuditHandoff({
      receipt: receipt({ blocked: true, verdict: undefined }), context: context(),
    });
    expect(decision.blockedReason).toContain('deck_sub_1g6w5672');
  });

  it('does not advance with no verdict, and never treats absence as PASS', () => {
    for (const verdict of [undefined, '' as never, 'LGTM' as never, 'pass' as never]) {
      const decision = decideSupervisionAuditHandoff({
        receipt: receipt({ verdict }), context: context(),
      });
      expect(decision.action, String(verdict)).toBe('hold');
      expect(decision.refusal, String(verdict)).toBe('no_verdict');
      expect(decision.nextStatus, String(verdict)).toBeUndefined();
    }
  });

  it('blocked outranks a PASS verdict on the same receipt', () => {
    const decision = decideSupervisionAuditHandoff({
      receipt: receipt({ blocked: true, verdict: 'PASS' }), context: context(),
    });
    expect(decision.action).toBe('hold');
    expect(decision.refusal).toBe('audit_blocked');
  });
});

describe('idempotency and staleness', () => {
  it('is inert on a replayed receipt', () => {
    const ctx = context({ appliedAttemptIds: [ATTEMPT] });
    const first = decideSupervisionAuditHandoff({ receipt: receipt(), context: ctx });
    const second = decideSupervisionAuditHandoff({ receipt: receipt(), context: ctx });
    expect(first).toEqual(second);
    expect(first.action).toBe('hold');
    expect(first.refusal).toBe('duplicate_receipt');
    expect(first.recordAttestation).toBe(false);
    expect(first.queueOp).toBeUndefined();
  });

  it('checks duplicate BEFORE phase, so a replay after promotion stays a replay', () => {
    // Load-bearing ordering: if phase were checked first, this replay would be
    // misreported as not_awaiting_audit and could re-run side effects.
    const decision = decideSupervisionAuditHandoff({
      receipt: receipt(),
      context: context({ currentStatus: 'ready_for_integration', appliedAttemptIds: [ATTEMPT] }),
    });
    expect(decision.refusal).toBe('duplicate_receipt');
  });

  it('refuses a stale attempt id', () => {
    const decision = decideSupervisionAuditHandoff({
      receipt: receipt({ attemptId: 'old-attempt' }), context: context(),
    });
    expect(decision.action).toBe('hold');
    expect(decision.refusal).toBe('stale_attempt');
    expect(decision.nextStatus).toBeUndefined();
  });

  it('refuses a stale PASS bound to superseded bytes', () => {
    const decision = decideSupervisionAuditHandoff({
      receipt: receipt({ revision: 'deadbeef' }), context: context(),
    });
    expect(decision.action).toBe('hold');
    expect(decision.refusal).toBe('stale_revision');
    expect(decision.nextStatus).toBeUndefined();
  });

  it('advances only from a status that is actually awaiting audit', () => {
    for (const status of SUPERVISION_TASK_LIFECYCLE_STATUSES) {
      const decision = decideSupervisionAuditHandoff({
        receipt: receipt(), context: context({ currentStatus: status }),
      });
      if (SUPERVISION_AUDITABLE_STATUSES.includes(status)) {
        expect(decision.action, status).toBe('promote_to_integration');
      } else {
        expect(decision.action, status).toBe('hold');
        expect(decision.refusal, status).toBe('not_awaiting_audit');
      }
    }
  });
});

describe('no orphaned PASS invariant', () => {
  it('finds passed rows with neither an owner nor a reason', () => {
    expect(findUnownedPassedTasks([
      { taskId: 'tsk_a', status: 'ready_for_integration' },
      { taskId: 'tsk_b', status: 'ready_for_integration', integrationOwner: 'deck_cd_cc2' },
      { taskId: 'tsk_c', status: 'passed', blockedReason: 'owner on leave' },
      { taskId: 'tsk_d', status: 'implementing' },
      { taskId: 'tsk_e', status: 'passed', integrationOwner: '   ' },
    ])).toEqual(['tsk_a', 'tsk_e']);
  });

  it('ignores rows carrying an unknown status rather than guessing', () => {
    expect(findUnownedPassedTasks([{ taskId: 'tsk_x', status: 'file_event' }])).toEqual([]);
  });
});
