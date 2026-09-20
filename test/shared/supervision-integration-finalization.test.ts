import { describe, expect, it } from 'vitest';
import {
  resolveSupervisionIntegrationPolicy,
  validateSupervisionIntegrationEvidence,
  type SupervisionIntegrationAuthoritySnapshot,
  type SupervisionIntegrationEvidenceInput,
} from '../../shared/supervision-integration-finalization.js';

const REVISION = 'integration-revision-r1';
const ATTEMPT = 'auto-audit-exact-r1';
const COMMIT = 'a'.repeat(40);
const MANIFEST = [{ path: 'src/exact.ts', sha256: 'b'.repeat(64) }];

function evidence(overrides: Partial<SupervisionIntegrationEvidenceInput> = {}): SupervisionIntegrationEvidenceInput {
  return {
    assignmentId: 'asg_owner', revision: REVISION, auditAttemptId: ATTEMPT,
    auditRevision: REVISION, verdict: 'PASS', ownedFiles: ['src/exact.ts'],
    integrationManifest: MANIFEST, integrationOwner: 'deck_cd_brain',
    pushRemoteRef: 'refs/remotes/origin/dev', stagedPaths: [],
    conflictedPaths: [], untrackedOtherOwnerPaths: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<SupervisionIntegrationAuthoritySnapshot> = {}): SupervisionIntegrationAuthoritySnapshot {
  return {
    taskId: 'tsk_exact', taskStatus: 'ready_for_integration', currentRevision: REVISION,
    integrationOwnerAssignmentId: 'asg_owner', ownerAssignmentId: 'asg_owner',
    ownerRole: 'integration_owner', ownerStatus: 'ready_for_integration',
    ownerSessionName: 'deck_cd_brain', callerSessionName: 'deck_cd_brain',
    ownerAuditRevision: REVISION, ownerAuditAttemptId: ATTEMPT, ownerVerdict: 'PASS',
    ownerCrossVendorAuditPassed: true, eligibleIntegrationOwnerCount: 1, exactPassReceiptCount: 1,
    exactPassAuditorCount: 1, exactPassAuditorFinalized: true, exactPassAuditorIndependent: true,
    eligibleRequiredLineageCount: 1, requiredLineageExactPass: true,
    bundle: {
      taskId: 'tsk_exact', revision: REVISION, headSha: COMMIT,
      manifestSha256: 'c'.repeat(64), files: MANIFEST,
    },
    inspectedHeadSha: COMMIT, expectedPushRemoteRef: 'refs/remotes/origin/dev',
    observedRemoteRef: 'refs/remotes/origin/dev', observedRemoteCommitSha: COMMIT,
    observedPushMatchesRequestedRemote: true,
    generation: 1, updatedAt: 10,
    ...overrides,
  };
}

describe('supervision integration finalization pure policy', () => {
  it.each([
    'assignmentId', 'revision', 'auditAttemptId', 'auditRevision',
    'integrationOwner', 'pushRemoteRef', 'commitSha', 'pushResult',
  ] as const)('returns a field-level refusal when required %s is absent', (field) => {
    const input = evidence({ commitSha: COMMIT, pushResult: 'pushed' });
    delete input[field];
    expect(validateSupervisionIntegrationEvidence({ operation: 'finalize', evidence: input }))
      .toMatchObject({
        ok: false,
        refusals: expect.arrayContaining([
          expect.objectContaining({ code: 'missing_field', field }),
        ]),
      });
  });

  it.each(['success', 'pending', 'failure'] as const)(
    'names every missing exact CI field for ciResult=%s',
    (ciResult) => {
      const result = validateSupervisionIntegrationEvidence({
        operation: 'finalize', evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed', ciResult }),
      });
      expect(result).toEqual({
        ok: false,
        refusals: [
          { code: 'missing_field', field: 'externalRunId', expected: `required when ciResult=${ciResult}` },
          { code: 'missing_field', field: 'externalHeadSha', expected: `required when ciResult=${ciResult}` },
          { code: 'missing_field', field: 'externalTaskId', expected: `required when ciResult=${ciResult}` },
        ],
      });
    },
  );

  it.each(['ci_not_configured', 'ci_unavailable'] as const)(
    'accepts %s without dummy external identifiers and rejects each supplied one',
    (ciResult) => {
      expect(validateSupervisionIntegrationEvidence({
        operation: 'finalize',
        evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed', ciResult }),
      })).toMatchObject({ ok: true });
      const rejected = validateSupervisionIntegrationEvidence({
        operation: 'finalize',
        evidence: evidence({
          commitSha: COMMIT, pushResult: 'pushed', ciResult,
          externalRunId: 'run', externalHeadSha: COMMIT, externalTaskId: 'job',
        }),
      });
      expect(rejected).toMatchObject({
        ok: false,
        refusals: [
          { code: 'incompatible_field', field: 'externalRunId' },
          { code: 'incompatible_field', field: 'externalHeadSha' },
          { code: 'incompatible_field', field: 'externalTaskId' },
        ],
      });
    },
  );

  it('models the tsk_hnh delegated -> start -> implementing sequence without a hidden task_finish', () => {
    for (const ownerStatus of ['delegated', 'implementing', 'ready_for_integration'] as const) {
      const result = resolveSupervisionIntegrationPolicy({
        operation: 'preflight', evidence: evidence(),
        snapshot: snapshot({
          ownerStatus,
          ownerVerdict: ownerStatus === 'ready_for_integration' ? 'PASS' : undefined,
          ownerCrossVendorAuditPassed: ownerStatus === 'ready_for_integration' ? true : undefined,
        }),
      });
      expect(result).toMatchObject({
        ok: true,
        ownerPreparation: ownerStatus === 'ready_for_integration' ? 'none' : 'bind_exact_pass',
      });
    }
  });

  it('returns exact CI fields during the real tsk_hnh sequence, then finalizes from implementing', () => {
    const afterStart = snapshot({
      ownerStatus: 'implementing', ownerVerdict: undefined, ownerCrossVendorAuditPassed: undefined,
    });
    expect(validateSupervisionIntegrationEvidence({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed', ciResult: 'pending' }),
    })).toMatchObject({
      ok: false,
      refusals: [
        { code: 'missing_field', field: 'externalRunId' },
        { code: 'missing_field', field: 'externalHeadSha' },
        { code: 'missing_field', field: 'externalTaskId' },
      ],
    });
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed', ciResult: 'ci_unavailable' }),
      snapshot: afterStart,
    })).toMatchObject({ ok: true, ownerPreparation: 'bind_exact_pass' });
  });

  it.each(['delegated', 'implementing'] as const)(
    'authorizes tokenless post-push preparation from an exact PASS lineage while owner is %s',
    (ownerStatus) => {
      const bundleBaseSha = 'e'.repeat(40);
      expect(bundleBaseSha).not.toBe(COMMIT);
      const result = resolveSupervisionIntegrationPolicy({
        operation: 'finalize',
        evidence: evidence({ commitSha: COMMIT, pushResult: 'already_present' }),
        snapshot: snapshot({
          ownerStatus,
          ownerVerdict: undefined,
          ownerCrossVendorAuditPassed: undefined,
          bundle: {
            taskId: 'tsk_exact', revision: REVISION, headSha: bundleBaseSha,
            manifestSha256: 'c'.repeat(64), files: MANIFEST,
          },
          inspectedHeadSha: bundleBaseSha,
          observedRemoteCommitSha: 'd'.repeat(40),
          observedPushMatchesRequestedRemote: false,
          observedPushContainsRequestedCommit: true,
        }),
      });
      expect(result).toMatchObject({
        ok: true,
        backfill: true,
        ownerPreparation: 'bind_exact_pass',
      });
    },
  );

  it('uses one authority token for preflight and finalize and rejects authority drift', () => {
    const before = resolveSupervisionIntegrationPolicy({
      operation: 'preflight', evidence: evidence(), snapshot: snapshot(),
    });
    expect(before).toMatchObject({ ok: true });
    if (!before.ok) throw new Error('preflight failed');

    const stable = resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed' }),
      snapshot: snapshot(), expectedPreflightToken: before.authorityToken,
    });
    expect(stable).toMatchObject({ ok: true });

    const drifted = resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed' }),
      snapshot: snapshot({ currentRevision: 'superseding-revision' }),
      expectedPreflightToken: before.authorityToken,
    });
    expect(drifted).toMatchObject({
      ok: false,
      refusals: expect.arrayContaining([{ code: 'stale_preflight', field: 'preflightToken', expected: before.authorityToken, actual: expect.any(String) }]),
    });
  });

  it('keeps the preflight token stable across daemon-owned owner preparation and runtime restart', () => {
    const delegated = resolveSupervisionIntegrationPolicy({
      operation: 'preflight', evidence: evidence(),
      snapshot: snapshot({
        ownerStatus: 'delegated', ownerVerdict: undefined, ownerCrossVendorAuditPassed: undefined,
        observedRemoteRef: undefined, observedRemoteCommitSha: undefined,
        observedPushMatchesRequestedRemote: undefined, generation: 1, updatedAt: 10,
      }),
    });
    expect(delegated).toMatchObject({ ok: true, ownerPreparation: 'bind_exact_pass' });
    if (!delegated.ok) throw new Error('delegated preflight failed');
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize', evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed' }),
      snapshot: snapshot({ generation: 9, updatedAt: 900 }),
      expectedPreflightToken: delegated.authorityToken,
    })).toMatchObject({ ok: true, ownerPreparation: 'none' });
  });

  it('derives the same authority token for concurrent preflights and lets only exact post-CAS replay converge', () => {
    const first = resolveSupervisionIntegrationPolicy({
      operation: 'preflight', evidence: evidence(), snapshot: snapshot(),
    });
    const concurrent = resolveSupervisionIntegrationPolicy({
      operation: 'preflight', evidence: evidence(), snapshot: snapshot(),
    });
    expect(first).toMatchObject({ ok: true });
    expect(concurrent).toMatchObject({ ok: true });
    if (!first.ok || !concurrent.ok) throw new Error('preflight failed');
    expect(concurrent.authorityToken).toBe(first.authorityToken);

    const finalized = resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed' }),
      snapshot: snapshot(), expectedPreflightToken: first.authorityToken,
    });
    expect(finalized).toMatchObject({ ok: true, replay: false });
    if (!finalized.ok) throw new Error('finalize failed');

    const afterCas = snapshot({
      taskStatus: 'finalized', ownerStatus: 'finalized',
      observedRemoteRef: undefined, observedRemoteCommitSha: undefined,
      observedPushMatchesRequestedRemote: undefined,
      persistedPreflightToken: first.authorityToken,
      persistedFinalizationFingerprint: finalized.finalizationFingerprint,
      generation: 40, updatedAt: 4_000,
    });
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed' }),
      snapshot: afterCas, expectedPreflightToken: concurrent.authorityToken,
    })).toMatchObject({ ok: true, replay: true });
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: 'd'.repeat(40), pushResult: 'pushed' }),
      snapshot: afterCas, expectedPreflightToken: concurrent.authorityToken,
    })).toMatchObject({
      ok: false,
      refusals: [expect.objectContaining({ code: 'conflicting_replay' })],
    });
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed' }),
      snapshot: afterCas,
      expectedPreflightToken: `sha256:${'f'.repeat(64)}`,
    })).toMatchObject({
      ok: false,
      refusals: [{ code: 'conflicting_replay', field: 'preflightToken' }],
    });
  });

  it('rejects remote drift after a successful preflight even when registry authority is unchanged', () => {
    const before = resolveSupervisionIntegrationPolicy({
      operation: 'preflight', evidence: evidence(), snapshot: snapshot(),
    });
    expect(before).toMatchObject({ ok: true });
    if (!before.ok) throw new Error('preflight failed');

    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'already_present' }),
      snapshot: snapshot({
        observedRemoteRef: 'refs/remotes/origin/dev',
        observedRemoteCommitSha: 'd'.repeat(40),
        observedPushMatchesRequestedRemote: false,
      }),
      expectedPreflightToken: before.authorityToken,
    })).toMatchObject({
      ok: false,
      refusals: expect.arrayContaining([
        expect.objectContaining({ code: 'remote_drift', field: 'remoteCommit' }),
      ]),
    });
  });

  it('keeps the preflight token stable while the daemon atomically repairs a missing owner pointer', () => {
    const before = resolveSupervisionIntegrationPolicy({
      operation: 'preflight', evidence: evidence(),
      snapshot: snapshot({ integrationOwnerAssignmentId: undefined }),
    });
    expect(before).toMatchObject({ ok: true, ownerPreparation: 'bind_owner_pointer' });
    if (!before.ok) throw new Error('pointer preflight failed');
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize', evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed' }),
      snapshot: snapshot(), expectedPreflightToken: before.authorityToken,
    })).toMatchObject({ ok: true, ownerPreparation: 'none' });
  });

  it.each([
    ['multiple owners', { eligibleIntegrationOwnerCount: 2 }, 'ambiguous_authority'],
    ['wrong owner pointer', { integrationOwnerAssignmentId: 'asg_other' }, 'ambiguous_authority'],
    ['missing exact receipt', { exactPassReceiptCount: 0 }, 'verdict_mismatch'],
    ['unfinished exact auditor', { exactPassAuditorFinalized: false }, 'verdict_mismatch'],
    ['self audit', { exactPassAuditorIndependent: false }, 'verdict_mismatch'],
    ['terminal task', { taskStatus: 'cancelled' }, 'task_status_mismatch'],
    ['terminal owner', { ownerStatus: 'cancelled' }, 'assignment_status_mismatch'],
    ['base drift', { inspectedHeadSha: 'd'.repeat(40) }, 'bundle_mismatch'],
    ['unproven push', { observedPushMatchesRequestedRemote: false }, 'remote_drift'],
  ] as const)('fails closed on %s', (_name, override, code) => {
    const result = resolveSupervisionIntegrationPolicy({
      operation: 'finalize', evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed' }),
      snapshot: snapshot(override),
    });
    expect(result).toMatchObject({
      ok: false,
      refusals: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  });

  it('backfills an exact already-pushed commit at or below the remote tip and rejects rewritten history', () => {
    const exact = resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'already_present' }),
      snapshot: snapshot({ observedRemoteRef: 'refs/remotes/origin/dev', observedRemoteCommitSha: COMMIT }),
    });
    expect(exact).toMatchObject({ ok: true, backfill: true });

    const advanced = resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'already_present' }),
      snapshot: snapshot({
        observedRemoteRef: 'refs/remotes/origin/dev',
        observedRemoteCommitSha: 'd'.repeat(40),
        observedPushMatchesRequestedRemote: false,
        observedPushContainsRequestedCommit: true,
      }),
    });
    expect(advanced).toMatchObject({ ok: true, backfill: true });

    const rewritten = resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'already_present' }),
      snapshot: snapshot({
        observedRemoteRef: 'refs/remotes/origin/dev', observedRemoteCommitSha: 'd'.repeat(40),
        observedPushMatchesRequestedRemote: false,
        observedPushContainsRequestedCommit: false,
      }),
    });
    expect(rewritten).toMatchObject({
      ok: false,
      refusals: expect.arrayContaining([
        expect.objectContaining({ code: 'remote_drift', field: 'remoteCommit' }),
      ]),
    });
  });

  it('backfills an exact partial Git ledger but rejects conflicting persisted provenance', () => {
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'already_present' }),
      snapshot: snapshot({
        persistedCommitSha: COMMIT,
        persistedPushRemoteRef: 'refs/remotes/origin/dev',
      }),
    })).toMatchObject({ ok: true, backfill: true });

    const wrongCommit = resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'already_present' }),
      snapshot: snapshot({ persistedCommitSha: 'd'.repeat(40) }),
    });
    expect(wrongCommit).toMatchObject({
      ok: false,
      refusals: expect.arrayContaining([
        expect.objectContaining({ code: 'conflicting_replay', field: 'commitSha' }),
      ]),
    });

    const wrongRef = resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'already_present' }),
      snapshot: snapshot({ persistedPushRemoteRef: 'refs/remotes/origin/release' }),
    });
    expect(wrongRef).toMatchObject({
      ok: false,
      refusals: expect.arrayContaining([
        expect.objectContaining({ code: 'conflicting_replay', field: 'pushRemoteRef' }),
      ]),
    });
  });

  it.each([
    [{ persistedCommitSha: COMMIT }, { commitSha: COMMIT, pushResult: 'already_present' }],
    [{ persistedPushRemoteRef: 'refs/remotes/origin/dev' }, { commitSha: COMMIT, pushResult: 'already_present' }],
  ] as const)('recovers a partial crash ledger without requiring a second Git side effect', (
    persisted, finalEvidence,
  ) => {
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize', evidence: evidence(finalEvidence),
      snapshot: snapshot(persisted),
    })).toMatchObject({ ok: true, backfill: true, replay: false });
  });

  it('keeps exact already-pushed backfill valid across daemon generation and timestamp rotation', () => {
    const original = resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'already_present' }),
      snapshot: snapshot({ generation: 1, updatedAt: 10 }),
    });
    const restarted = resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'already_present' }),
      snapshot: snapshot({ generation: 99, updatedAt: 99_000 }),
    });
    expect(original).toMatchObject({ ok: true, backfill: true });
    expect(restarted).toMatchObject({ ok: true, backfill: true });
    if (!original.ok || !restarted.ok) throw new Error('backfill failed');
    expect(restarted.authorityToken).toBe(original.authorityToken);
    expect(restarted.finalizationFingerprint).toBe(original.finalizationFingerprint);
  });

  it('invalidates preflight when partial Git ledger authority changes before finalize', () => {
    const before = resolveSupervisionIntegrationPolicy({
      operation: 'preflight', evidence: evidence(), snapshot: snapshot(),
    });
    expect(before).toMatchObject({ ok: true });
    if (!before.ok) throw new Error('preflight failed');

    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'already_present' }),
      snapshot: snapshot({
        persistedCommitSha: COMMIT,
        persistedPushRemoteRef: 'refs/remotes/origin/dev',
      }),
      expectedPreflightToken: before.authorityToken,
    })).toMatchObject({
      ok: false,
      refusals: expect.arrayContaining([
        expect.objectContaining({ code: 'stale_preflight', field: 'preflightToken' }),
      ]),
    });
  });

  it.each([
    ['wrong revision', { currentRevision: 'other' }, { revision: REVISION }, 'revision_mismatch'],
    ['wrong attempt', { ownerAuditAttemptId: 'other' }, {}, 'attempt_mismatch'],
    ['wrong owner', { callerSessionName: 'deck_other_brain' }, {}, 'identity_mismatch'],
    ['wrong manifest', { bundle: { taskId: 'tsk_exact', revision: REVISION, headSha: COMMIT, manifestSha256: 'c'.repeat(64), files: [] } }, {}, 'bundle_mismatch'],
  ] as const)('returns field-level refusal for %s', (_name, snapshotOverride, evidenceOverride, code) => {
    const result = resolveSupervisionIntegrationPolicy({
      operation: 'preflight', evidence: evidence(evidenceOverride), snapshot: snapshot(snapshotOverride),
    });
    expect(result).toMatchObject({
      ok: false,
      refusals: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  });

  it('supports an exact byte-identical no-op bundle row and partial staged attribution', () => {
    const noOp = snapshot({
      bundle: {
        taskId: 'tsk_exact', revision: REVISION, headSha: COMMIT,
        manifestSha256: 'c'.repeat(64), files: [],
      },
    });
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({
        ownedFiles: [], integrationManifest: [], stagedPaths: [],
        commitSha: COMMIT, pushResult: 'pushed',
      }),
      snapshot: noOp,
    })).toMatchObject({ ok: true });
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ stagedPaths: [], commitSha: COMMIT, pushResult: 'pushed' }),
      snapshot: snapshot(),
    })).toMatchObject({ ok: true });
  });

  it('refuses pre-existing staging and conflicts before Git while allowing clean partial attribution at finalize', () => {
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'preflight',
      evidence: evidence({ stagedPaths: ['src/a.ts'], conflictedPaths: ['src/b.ts'] }),
      snapshot: snapshot(),
    })).toMatchObject({
      ok: false,
      refusals: expect.arrayContaining([
        expect.objectContaining({ code: 'incompatible_field', field: 'stagedPaths' }),
        expect.objectContaining({ code: 'incompatible_field', field: 'conflictedPaths' }),
      ]),
    });
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ stagedPaths: ['src/a.ts'], commitSha: COMMIT, pushResult: 'pushed' }),
      snapshot: snapshot(),
    })).toMatchObject({ ok: true });
  });

  it.each([
    ['subset', []],
    ['superset', ['src/exact.ts', 'src/reported-only.ts']],
    ['omitted', undefined],
  ] as const)('treats %s ownedFiles as record-only provenance', (_label, ownedFiles) => {
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'preflight', evidence: evidence({ ownedFiles }), snapshot: snapshot(),
    })).toMatchObject({ ok: true, evidence: { ownedFiles: ownedFiles ?? [] } });
  });

  it('still rejects a wrong integrationManifest sha as bundle_mismatch', () => {
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'preflight',
      evidence: evidence({ integrationManifest: [{ path: 'src/exact.ts', sha256: 'd'.repeat(64) }] }),
      snapshot: snapshot(),
    })).toMatchObject({
      ok: false,
      refusals: expect.arrayContaining([
        expect.objectContaining({ code: 'bundle_mismatch', field: 'bundle' }),
      ]),
    });
  });

  it('makes exact repeats idempotent and conflicting repeats field-specific', () => {
    const first = resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed' }), snapshot: snapshot(),
    });
    expect(first).toMatchObject({ ok: true, replay: false });
    if (!first.ok) throw new Error('first finalization failed');
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: COMMIT, pushResult: 'pushed' }),
      snapshot: snapshot({
        taskStatus: 'finalized', ownerStatus: 'finalized',
        observedRemoteRef: undefined, observedRemoteCommitSha: undefined,
        observedPushMatchesRequestedRemote: undefined,
        persistedFinalizationFingerprint: first.finalizationFingerprint,
      }),
    })).toMatchObject({ ok: true, replay: true });
    expect(resolveSupervisionIntegrationPolicy({
      operation: 'finalize',
      evidence: evidence({ commitSha: 'd'.repeat(40), pushResult: 'pushed' }),
      snapshot: snapshot({ persistedFinalizationFingerprint: first.finalizationFingerprint }),
    })).toMatchObject({
      ok: false,
      refusals: expect.arrayContaining([
        expect.objectContaining({ code: 'conflicting_replay', field: 'preflightToken' }),
      ]),
    });
  });
});
