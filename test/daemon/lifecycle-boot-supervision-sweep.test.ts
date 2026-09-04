import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Isolate ALL daemon state (instance lock socket, sqlite stores, hooks) into a
// throwaway home BEFORE the module graph loads, so this never touches the
// developer's real ~/.imcodes or a running daemon. No tmux and no network are
// started: startup() reaches its supervision boot step on its own.
const isolatedHome = mkdtempSync(join(tmpdir(), 'imcodes-boot-harness-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

const R4 = 'supervision-lifecycle-forward-convergence-cc3-r4-e76694e7';
const COMMIT = 'c9aaab488f56dacc619602251705861b6ecc9f61';
const ATTEMPT = 'auto-audit-551450fdefffad26574b7aa6';

function identity(sessionName: string, agentType = 'claude-code-sdk', providerFamily = 'anthropic') {
  return {
    sessionName,
    sessionInstanceId: `${sessionName}-instance`,
    runtimeEpoch: `${sessionName}-epoch`,
    agentType,
    providerFamily,
  };
}

/**
 * Seeds the REAL registry the daemon will open at boot with a stuck aggregate
 * that deterministic convergence can repair: finalized at R4, the implementer
 * finalization consumed still parked, and a newly authorized successor live.
 */
async function seedStuckAggregate(taskId: string) {
  const { getSupervisionTaskRegistry } = await import('../../src/daemon/supervision-state-store.js');
  const r = getSupervisionTaskRegistry();
  const files = ['src/daemon/send-tool.ts'];
  expect(r.createOrGet({
    taskId, projectName: 'cd', classification: 'independent_top_level',
    objective: 'boot convergence', currentRevision: R4, auditPolicy: 'auto_strict_cross_vendor',
  } as never)).toMatchObject({ ok: true });
  const historical = r.createAssignment({
    taskId, role: 'implementer', identity: identity(`${taskId}_hist`),
    scopeFiles: files, auditAttemptId: ATTEMPT, auditRevision: R4,
  } as never);
  const owner = r.createAssignment({
    taskId, role: 'integration_owner', identity: identity(`${taskId}_brain`, 'codex-sdk', 'openai'),
    scopeFiles: files, auditAttemptId: ATTEMPT, auditRevision: R4,
  } as never);
  const auditor = r.createAssignment({
    taskId, role: 'auditor', identity: identity(`${taskId}_aud`, 'codex-sdk', 'openai'),
    required: false, auditAttemptId: ATTEMPT, auditRevision: R4,
  } as never);
  if (!historical.ok || !owner.ok || !auditor.ok) throw new Error('seed shape');
  for (const t of [historical.value, owner.value]) {
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(r.updateAssignment({
        assignmentId: t.assignmentId, identity: t.identity, status,
        revision: R4, auditAttemptId: ATTEMPT, auditRevision: R4,
        ...(status === 'passed' || status === 'ready_for_integration'
          ? { verdict: 'PASS', crossVendorAuditPassed: true } : {}),
        ...(t.role === 'integration_owner'
          ? { externalRunId: '33748331802', externalHeadSha: COMMIT, externalTaskId: 'CI' } : {}),
      } as never), `${t.role}:${status}`).toMatchObject({ ok: true });
    }
  }
  for (const status of ['auditing', 'passed'] as const) {
    expect(r.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, status,
      auditAttemptId: ATTEMPT, auditRevision: R4, ...(status === 'passed' ? { verdict: 'PASS' } : {}),
    } as never)).toMatchObject({ ok: true });
  }
  expect(r.finishAssignment({
    assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, revision: R4,
  } as never)).toMatchObject({ ok: true });
  expect(r.finalizeIntegration({
    assignmentId: owner.value.assignmentId, identity: owner.value.identity,
    revision: R4, auditAttemptId: ATTEMPT, auditRevision: R4, verdict: 'PASS',
    integrationOwner: identity(`${taskId}_brain`).sessionName, ownedFiles: files, integrationManifest: [],
    commitSha: COMMIT, pushResult: 'pushed', pushRemoteRef: 'refs/heads/dev', stagedPaths: files,
    externalRunId: '33748331802', externalHeadSha: COMMIT, externalTaskId: 'CI', ciResult: 'success',
  } as never)).toMatchObject({ ok: true });
  const successor = r.createAssignment({
    taskId, role: 'implementer', identity: identity(`${taskId}_next`), scopeFiles: files,
  } as never);
  if (!successor.ok) throw new Error('successor');
  expect(r.applyTaskIntent({
    taskId, assignmentId: successor.value.assignmentId, intent: 'start',
    toStatus: 'implementing', identity: identity(`${taskId}_next`),
  } as never)).toMatchObject({ ok: true });
  return { registry: r, historical: historical.value, successor: successor.value };
}

describe('daemon boot enters the same bounded supervision convergence', () => {
  /**
   * ONE real startup() per process: it acquires the daemon instance lock, which
   * is module-scoped and only released by shutdown(), so a second startup() in
   * the same worker would fail on the lock rather than tell us anything about
   * convergence. Both the repairable and the fail-closed aggregate are
   * therefore seeded before the single boot, and boot-step idempotency is
   * exercised by re-running the same boot entry afterwards.
   */
  it('repairs a stuck aggregate at boot, leaves unauthorized ones alone, and does not churn', async () => {
    const { registry, historical, successor } = await seedStuckAggregate('tsk_boot_1');
    expect(registry.getAssignment(historical.assignmentId)!.status).toBe('ready_for_integration');

    // Aggregate with NO finalization evidence: nothing authorizes a repair.
    const taskId2 = 'tsk_boot_3';
    expect(registry.createOrGet({
      taskId: taskId2, projectName: 'cd', classification: 'independent_top_level',
      objective: 'no evidence', currentRevision: R4,
    } as never)).toMatchObject({ ok: true });
    const only = registry.createAssignment({
      taskId: taskId2, role: 'implementer', identity: identity('tsk_boot_3_only'),
      scopeFiles: ['src/daemon/send-tool.ts'], auditAttemptId: ATTEMPT, auditRevision: R4,
    } as never);
    if (!only.ok) throw new Error('only: ' + only.reason);
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(registry.updateAssignment({
        assignmentId: only.value.assignmentId, identity: only.value.identity, status,
        revision: R4, auditAttemptId: ATTEMPT, auditRevision: R4,
        ...(status === 'passed' || status === 'ready_for_integration'
          ? { verdict: 'PASS', crossVendorAuditPassed: true } : {}),
      } as never), status).toMatchObject({ ok: true });
    }

    // R12 audit P1: resolveLiveParticipants was supplied only by tests, so the
    // production singleton had NO resolver and restart identity convergence
    // silently never ran -- a rotated instance/epoch was refused as
    // owner_mismatch on a live daemon while unit tests stayed green. Seeded
    // before the single startup() this file is allowed (the instance lock is
    // module-scoped and only released by shutdown()).
    const { upsertSession } = await import('../../src/store/session-store.js');
    upsertSession({
      name: 'deck_cd_rotator', type: 'claude-code-sdk', agentType: 'claude-code-sdk',
      state: 'running', projectName: 'cd', cwd: '/tmp',
      sessionInstanceId: 'instance-after', runtimeEpoch: 'epoch-after',
      runtimeType: 'transport', role: 'w1', createdAt: Date.now(),
    } as never);
    const storedIdentity = {
      sessionName: 'deck_cd_rotator', sessionInstanceId: 'instance-before',
      runtimeEpoch: 'epoch-before', agentType: 'claude-code-sdk', providerFamily: 'anthropic',
    };
    expect(registry.createOrGet({
      taskId: 'tsk_boot_rotate', projectName: 'cd', classification: 'independent_top_level',
      objective: 'restart identity convergence', currentRevision: R4,
    } as never)).toMatchObject({ ok: true });
    const rotator = registry.createAssignment({
      taskId: 'tsk_boot_rotate', role: 'implementer', identity: storedIdentity,
      scopeFiles: ['src/exact.ts'],
    } as never);
    if (!rotator.ok) throw new Error('rotator: ' + rotator.reason);

    const mod = await import('../../src/daemon/lifecycle.js');
    await mod.startup();
    // No fake clock advanced, no watchdog tick fired: boot itself must converge.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const repaired = registry.getAssignment(historical.assignmentId)!;
    expect(repaired.assignmentId).toBe(historical.assignmentId); // same object
    expect(repaired.status).toBe('finalized');
    expect(repaired.auditRevision).toBe(R4);
    expect(repaired.verdict?.toUpperCase()).toBe('PASS');
    expect(registry.getTaskRecord('tsk_boot_1')!.finalization?.revision).toBe(R4);
    const active = registry.listAssignments('tsk_boot_1').filter((a) => (
      a.role === 'implementer' && !['finalized', 'cancelled', 'recovered'].includes(a.status)
    ));
    expect(active.map((a) => a.assignmentId)).toEqual([successor.assignmentId]);

    // Fail-closed: no finalization evidence, so nothing was touched or minted.
    expect(registry.getAssignment(only.value.assignmentId)!.status).toBe('ready_for_integration');
    expect(registry.listAssignments(taskId2).filter((a) => a.role === 'auditor')).toHaveLength(0);

    // Re-running the SAME boot entry is idempotent: no churn, no replacement.
    const beforeRerun = registry.getAssignment(historical.assignmentId)!.updatedAt;
    const { dispatchReadyAuditSweep } = await import('../../src/daemon/send-tool.js');
    await dispatchReadyAuditSweep();
    await dispatchReadyAuditSweep();
    expect(registry.getAssignment(historical.assignmentId)!.updatedAt).toBe(beforeRerun);
    expect(registry.listAssignments('tsk_boot_1')).toHaveLength(4);

    // upsertSession mints its own instance/epoch, so the rotated identity must
    // be the one the daemon actually observes, not one the test invented.
    const { getSession } = await import('../../src/store/session-store.js');
    const liveRotator = getSession('deck_cd_rotator')!;
    // Production resolver is wired: the SAME logical participant converges after
    // a restart rotated its instance/epoch.
    expect(registry.updateAssignment({
      assignmentId: rotator.value.assignmentId,
      identity: {
        ...storedIdentity,
        sessionInstanceId: liveRotator.sessionInstanceId!,
        runtimeEpoch: liveRotator.runtimeEpoch!,
      },
      status: 'implementing',
    } as never)).toMatchObject({ ok: true });
    const reboundIdentity = registry.getAssignment(rotator.value.assignmentId)!;
    expect(reboundIdentity.assignmentId).toBe(rotator.value.assignmentId); // same object
    expect(reboundIdentity.identity.runtimeEpoch).toBe(liveRotator.runtimeEpoch);
    expect(reboundIdentity.identity.sessionInstanceId).toBe(liveRotator.sessionInstanceId);
    // Fail-closed holds: an identity the daemon does not observe is refused.
    expect(registry.updateAssignment({
      assignmentId: rotator.value.assignmentId,
      identity: { ...storedIdentity, sessionInstanceId: 'ghost', runtimeEpoch: 'ghost-epoch' },
      status: 'implementing',
    } as never)).toMatchObject({ ok: false, reason: 'owner_mismatch' });
  }, 60_000);

});
