/**
 * The PRODUCTION wiring of coordinator authority.
 *
 * Durable authority is project + session name. The port must still prove that
 * the named caller is a live session in that project, while runtime metadata
 * may rotate without stranding the assignment. These tests drive the real
 * `createSupervisionRegistryPort()` boundary.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

const listSessionsMock = vi.hoisted(() => vi.fn(() => [] as unknown[]));
vi.mock('../../src/store/session-store.js', () => ({
  listSessions: listSessionsMock,
  getSession: (name: string) => (listSessionsMock() as { name: string }[]).find((s) => s.name === name),
  upsertSession: vi.fn(),
}));

import { createSupervisionRegistryPort } from '../../src/daemon/supervision-registry-port.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
} from '../../src/daemon/supervision-state-store.js';
import { resolvePeerAuditProviderFamily } from '../../src/daemon/peer-audit-candidates.js';
import { createSupervisionMcpToolHandlers } from '../../src/daemon/supervision-mcp-tools.js';
import { SUPERVISION_MCP_TOOLS } from '../../shared/supervision-mcp-tools.js';

const PROJECT = 'alpha';

/** A live unparented Brain record. */
function brain(name: string) {
  return {
    name,
    role: 'brain' as const,
    projectName: PROJECT,
    agentType: 'codex-sdk',
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    state: 'idle',
    projectDir: `/work/${PROJECT}`,
  };
}

/** The identity the registry stores for a session, exactly as the port derives it. */
function identityOf(record: ReturnType<typeof brain>) {
  return {
    sessionName: record.name,
    sessionInstanceId: record.sessionInstanceId,
    runtimeEpoch: record.runtimeEpoch,
    agentType: record.agentType,
    providerFamily: resolvePeerAuditProviderFamily(record as never),
  };
}

describe('production coordinator authority wiring', () => {
  const brainA = brain('deck_alpha_brain');
  const brainB = brain('deck_alpha_clone_brain');
  const worker = brain('deck_alpha_worker');
  const taskId = 'port-coordinator-authority';
  const revision = `${taskId}-r1`;
  const attemptId = `${taskId}-attempt`;
  let auditorAssignmentId = '';

  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    listSessionsMock.mockReturnValue([brainA, brainB, worker]);
    const registry = getSupervisionTaskRegistry();
    expect(registry.createOrGet({
      taskId, projectName: PROJECT, classification: 'independent_top_level',
      objective: 'production coordinator authority', currentRevision: revision,
    })).toMatchObject({ ok: true });
    // Brain A dispatched this task, so A is its coordinator.
    expect(registry.createAssignment({
      assignmentId: `${taskId}-coordinator`, taskId, role: 'coordinator',
      identity: identityOf(brainA), required: false,
    })).toMatchObject({ ok: true });
    const implementer = registry.createAssignment({
      assignmentId: `${taskId}-implementer`, taskId, role: 'implementer',
      identity: identityOf(brainB), auditRevision: revision,
    });
    if (!implementer.ok) throw new Error('implementer fixture failed');
    for (const status of ['implementing', 'validated', 'ready_for_audit'] as const) {
      expect(registry.updateAssignment({
        assignmentId: implementer.value.assignmentId, identity: identityOf(brainB), status,
      })).toMatchObject({ ok: true });
    }
    const auditor = registry.createAssignment({
      assignmentId: `${taskId}-auditor`, taskId, role: 'auditor',
      identity: identityOf(worker), auditAttemptId: attemptId, auditRevision: revision,
    });
    if (!auditor.ok) throw new Error('fixture failed');
    auditorAssignmentId = auditor.value.assignmentId;
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId, attemptId, revision,
      receiptKind: 'final', verdict: 'PASS',
      auditorSessionName: worker.name, auditorIdentity: identityOf(worker),
      findings: 'accepted receipt',
      validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: 'passed' }],
    })).toMatchObject({ ok: true });
  });

  it('refuses a second live Brain in the same project', () => {
    const port = createSupervisionRegistryPort();
    expect(port.finishAssignment({
      expectedRevision: revision,
      assignmentId: auditorAssignmentId,
      callerSessionName: brainB.name,
      callerProjectName: PROJECT,
      projectBrain: true,
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
  });

  it('accepts the durable coordinator after runtime replacement', () => {
    listSessionsMock.mockReturnValue([
      { ...brainA, sessionInstanceId: 'instance-new', runtimeEpoch: 'epoch-new' },
      brainB, worker,
    ]);
    const port = createSupervisionRegistryPort();
    expect(port.finishAssignment({
      expectedRevision: revision,
      assignmentId: auditorAssignmentId,
      callerSessionName: brainA.name,
      callerProjectName: PROJECT,
      projectBrain: true,
    })).toMatchObject({ ok: true, value: { status: 'finalized' } });
  });

  it('refuses a caller with no live session record at all', () => {
    listSessionsMock.mockReturnValue([]);
    const port = createSupervisionRegistryPort();
    expect(port.finishAssignment({
      expectedRevision: revision,
      assignmentId: auditorAssignmentId,
      callerSessionName: brainA.name,
      callerProjectName: PROJECT,
      projectBrain: true,
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
  });

  it('lets the task\'s own live coordinator finish', () => {
    const port = createSupervisionRegistryPort();
    const res = port.finishAssignment({
      expectedRevision: revision,
      assignmentId: auditorAssignmentId,
      callerSessionName: brainA.name,
      callerProjectName: PROJECT,
      projectBrain: true,
    }) as { ok: boolean; reason?: string };
    expect(res).toMatchObject({ ok: true, value: { status: 'finalized' } });
  });
});

// ── R2 P1-1: the NON-projectBrain owner path ────────────────────────────────
// The non-Brain owner path resolves a live caller first, then authorizes the
// durable project/session identity. A restart must rotate metadata in place;
// an absent live caller remains forbidden.
describe('owner finish authority resolves the LIVE caller identity', () => {
  const brainA = brain('deck_alpha_brain');
  const workerLive = { ...brain('deck_alpha_impl'), role: 'w1' as const };
  const taskId = 'owner-path-live-identity';
  const revision = `${taskId}-r1`;
  let implementerAssignmentId = '';

  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    listSessionsMock.mockReturnValue([brainA, workerLive]);
    const registry = getSupervisionTaskRegistry();
    expect(registry.createOrGet({
      taskId, projectName: PROJECT, classification: 'independent_top_level',
      objective: 'owner path live identity', currentRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      assignmentId: `${taskId}-coordinator`, taskId, role: 'coordinator',
      identity: identityOf(brainA), required: false,
    })).toMatchObject({ ok: true });
    const impl = registry.createAssignment({
      assignmentId: `${taskId}-implementer`, taskId, role: 'implementer',
      identity: identityOf(workerLive), auditRevision: revision, required: true,
    });
    if (!impl.ok) throw new Error('fixture failed');
    implementerAssignmentId = impl.value.assignmentId;
    for (const status of ['implementing', 'validated'] as const) {
      expect(registry.updateAssignment({
        assignmentId: implementerAssignmentId, identity: identityOf(workerLive), status,
      })).toMatchObject({ ok: true });
    }
  });

  it('accepts the durable owner after runtime replacement', () => {
    listSessionsMock.mockReturnValue([
      brainA,
      { ...workerLive, sessionInstanceId: 'instance-replacement', runtimeEpoch: 'epoch-replacement' },
    ]);
    const port = createSupervisionRegistryPort();
    expect(port.finishAssignment({
      expectedRevision: revision,
      assignmentId: implementerAssignmentId,
      callerSessionName: workerLive.name,
      callerProjectName: PROJECT,
      projectBrain: false,
    })).toMatchObject({ ok: true });
  });

  it('refuses an owner-named caller with no live session record', () => {
    listSessionsMock.mockReturnValue([brainA]);
    const port = createSupervisionRegistryPort();
    expect(port.finishAssignment({
      expectedRevision: revision,
      assignmentId: implementerAssignmentId,
      callerSessionName: workerLive.name,
      callerProjectName: PROJECT,
      projectBrain: false,
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
  });

  it('still lets the exact live owner finish', () => {
    const port = createSupervisionRegistryPort();
    expect(port.finishAssignment({
      expectedRevision: revision,
      assignmentId: implementerAssignmentId,
      callerSessionName: workerLive.name,
      callerProjectName: PROJECT,
      projectBrain: false,
    })).toMatchObject({ ok: true });
  });
});

// ── R2 P1-2: task read/continuation gates ──────────────────────────────────
// Visibility is bound to the caller's project + durable session. Runtime
// instance/epoch changes must not make a restarted participant invisible.
describe('task visibility is bound to durable project/session identity', () => {
  const brainA = brain('deck_alpha_brain');
  const workerLive = { ...brain('deck_alpha_reader'), role: 'w1' as const };
  const taskId = 'visibility-exact-identity';

  function handlersFor(caller: { name: string }, sessions: unknown[], callerProjectName = PROJECT) {
    listSessionsMock.mockReturnValue(sessions);
    return createSupervisionMcpToolHandlers(
      { sessionName: caller.name, projectName: callerProjectName } as never,
      {
        registry: createSupervisionRegistryPort(),
        isProjectBrain: () => false,
        resolveSessionIdentity: (name: string) => {
          const s = (sessions as { name: string; sessionInstanceId: string; runtimeEpoch: string; agentType: string }[])
            .find((c) => c.name === name);
          if (!s) return undefined;
          return { ...identityOf(s as never), projectName: callerProjectName };
        },
      } as never,
    );
  }

  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    listSessionsMock.mockReturnValue([brainA, workerLive]);
    const registry = getSupervisionTaskRegistry();
    expect(registry.createOrGet({
      taskId, projectName: PROJECT, classification: 'independent_top_level',
      objective: 'visibility bound to identity',
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      assignmentId: `${taskId}-coordinator`, taskId, role: 'coordinator',
      identity: identityOf(brainA), required: false,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      assignmentId: `${taskId}-implementer`, taskId, role: 'implementer',
      identity: identityOf(workerLive), required: true,
    })).toMatchObject({ ok: true });
  });

  const replacement = { ...workerLive, sessionInstanceId: 'instance-new', runtimeEpoch: 'epoch-new' };

  it('allows task_get to the same durable session after runtime replacement', async () => {
    const handlers = handlersFor(workerLive, [brainA, replacement]);
    expect(await handlers[SUPERVISION_MCP_TOOLS.GET]({ taskId }))
      .toMatchObject({ status: 'ok', task: { taskId } });
  });

  it('keeps the task in task_list after runtime replacement', async () => {
    const handlers = handlersFor(workerLive, [brainA, replacement]);
    const res = await handlers[SUPERVISION_MCP_TOOLS.LIST]({}) as { tasks?: unknown[] };
    expect(res.tasks ?? []).toEqual(expect.arrayContaining([expect.objectContaining({ taskId })]));
  });

  it('still refuses the same session name from a different project', async () => {
    const handlers = handlersFor(workerLive, [brainA, replacement], 'other-project');
    expect(await handlers[SUPERVISION_MCP_TOOLS.GET]({ taskId }))
      .toMatchObject({ status: 'error', reason: 'identity_rejected' });
    const listed = await handlers[SUPERVISION_MCP_TOOLS.LIST]({}) as { tasks?: unknown[] };
    expect(listed.tasks ?? []).toHaveLength(0);
  });

  it('still lets the exact live participant read', async () => {
    const handlers = handlersFor(workerLive, [brainA, workerLive]);
    expect(await handlers[SUPERVISION_MCP_TOOLS.GET]({ taskId }))
      .toMatchObject({ status: 'ok' });
  });

  it('still lets the exact live coordinator read', async () => {
    const handlers = handlersFor(brainA, [brainA, workerLive]);
    expect(await handlers[SUPERVISION_MCP_TOOLS.GET]({ taskId }))
      .toMatchObject({ status: 'ok' });
  });
});

// ── R4 audit P1-1/P1-2: caller revision authority on the PUBLIC paths ─────
// record_validation and FINISHED attest exact revision bytes. A call prepared
// for R1 that is delayed or retried until after the SAME task/assignment was
// rebound to R2 must be refused (old_revision) with zero durable change, never
// reinterpreted as R2. Drives the real MCP handlers over the real registry port.
describe('public record_validation / FINISHED require exact caller revision authority', () => {
  const brainA = brain('deck_alpha_brain');
  const workerLive = { ...brain('deck_alpha_rev_worker'), role: 'w1' as const };
  const taskId = 'caller-revision-authority';
  const R1 = `${taskId}-r1`;
  const R2 = `${taskId}-r2`;
  let assignmentId = '';

  function handlersFor(record: ReturnType<typeof brain>) {
    return createSupervisionMcpToolHandlers(
      { sessionName: record.name, projectName: PROJECT } as never,
      {
        registry: createSupervisionRegistryPort(),
        isProjectBrain: () => record.name === brainA.name,
        resolveSessionIdentity: (name: string) => {
          const found = [brainA, workerLive].find((candidate) => candidate.name === name);
          return found ? { ...identityOf(found), projectName: PROJECT } : undefined;
        },
      } as never,
    );
  }
  const durable = () => {
    const registry = getSupervisionTaskRegistry();
    return JSON.stringify({ task: registry.get(taskId), events: registry.listEvents(taskId).length });
  };
  const rebindToR2 = () => {
    const rebound = getSupervisionTaskRegistry().rebindTaskAssignmentRevision({
      taskId, assignmentId, fromRevision: R1, toRevision: R2,
      worktreeSnapshot: {
        worktreePath: `/tmp/${taskId}/repo`, headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: 'b'.repeat(64) }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      },
      leaseAction: 'renew', idempotencyKey: `${taskId}-bind-r2`,
      reason: 'Brain binds the successor revision in place',
    });
    expect(rebound, JSON.stringify(rebound)).toMatchObject({ ok: true });
  };

  beforeEach(async () => {
    resetSupervisionTaskRegistryForTests();
    listSessionsMock.mockReturnValue([brainA, workerLive]);
    const registry = getSupervisionTaskRegistry();
    expect(registry.createOrGet({
      taskId, projectName: PROJECT, classification: 'independent_top_level',
      objective: 'caller revision authority', currentRevision: R1,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      assignmentId: `${taskId}-coordinator`, taskId, role: 'coordinator',
      identity: identityOf(brainA), required: false,
    })).toMatchObject({ ok: true });
    const implementer = registry.createAssignment({
      assignmentId: `${taskId}-implementer`, taskId, role: 'implementer',
      identity: identityOf(workerLive), auditRevision: R1, required: true, scopeFiles: ['src/exact.ts'],
    });
    if (!implementer.ok) throw new Error('fixture failed');
    assignmentId = implementer.value.assignmentId;
    expect(await handlersFor(workerLive)[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'start', taskId, assignmentId,
    })).toMatchObject({ status: 'ok', toStatus: 'implementing' });
  });

  it.each(['record_validation', 'finish'] as const)('refuses %s without expectedRevision and changes nothing', async (intent) => {
    const before = durable();
    expect(await handlersFor(workerLive)[SUPERVISION_MCP_TOOLS.INTENT]({
      intent, taskId, assignmentId, ...(intent === 'record_validation' ? { validationState: 'passed' } : {}),
    })).toMatchObject({ status: 'error', reason: 'expected_revision_required' });
    expect(durable()).toBe(before);
    // The port boundary refuses a revisionless FINISHED on its own as well.
    expect(createSupervisionRegistryPort().finishAssignment!({
      assignmentId, callerSessionName: workerLive.name, callerProjectName: PROJECT,
    } as never)).toEqual({ ok: false, reason: 'expected_revision_required' });
    expect(durable()).toBe(before);
  });

  it('refuses a DELAYED R1 record_validation delivered after the R2 rebind', async () => {
    // Prepared while R1 was current, delivered only after the successor bind.
    const delayed = { intent: 'record_validation', validationState: 'passed', taskId, assignmentId, expectedRevision: R1 };
    rebindToR2();
    const afterRebind = durable();
    expect(await handlersFor(workerLive)[SUPERVISION_MCP_TOOLS.INTENT](delayed))
      .toMatchObject({ status: 'error', reason: 'old_revision' });
    expect(durable()).toBe(afterRebind);
    const assignment = getSupervisionTaskRegistry().getAssignment(assignmentId)!;
    expect(assignment).toMatchObject({ status: 'implementing', auditRevision: R2 });
    expect(assignment.validationState).toBeUndefined();

    // R2's own validation is accepted and stamps R2.
    expect(getSupervisionTaskRegistry().applyTaskIntent({
      taskId, assignmentId, intent: 'record_validation', toStatus: 'validated', validationState: 'passed',
      expectedRevision: R2,
    })).toMatchObject({ ok: true });
    expect(getSupervisionTaskRegistry().getAssignment(assignmentId)).toMatchObject({
      validationState: 'passed', validatedRevision: R2,
    });
  });

  it('refuses a RETRIED R1 record_validation after R1 was validated and the object rebound to R2', async () => {
    const registry = getSupervisionTaskRegistry();
    const first = { taskId, assignmentId, intent: 'record_validation', toStatus: 'validated' as const, validationState: 'passed', expectedRevision: R1 };
    expect(registry.applyTaskIntent(first)).toMatchObject({ ok: true });
    rebindToR2();
    const afterRebind = durable();
    // The retry of the SAME R1 call (e.g. a transport redelivery) must not land on R2.
    expect(registry.applyTaskIntent(first)).toEqual({ ok: false, reason: 'old_revision' });
    expect(await handlersFor(workerLive)[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'record_validation', validationState: 'passed', taskId, assignmentId, expectedRevision: R1,
    })).toMatchObject({ status: 'error', reason: 'old_revision' });
    expect(durable()).toBe(afterRebind);
  });

  it('refuses a DELAYED/RETRIED R1 FINISHED against a validated R2 (owner path)', async () => {
    const registry = getSupervisionTaskRegistry();
    rebindToR2();
    expect(registry.applyTaskIntent({
      taskId, assignmentId, intent: 'record_validation', toStatus: 'validated', validationState: 'passed',
      expectedRevision: R2,
    })).toMatchObject({ ok: true });
    const validatedR2 = durable();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await handlersFor(workerLive)[SUPERVISION_MCP_TOOLS.INTENT]({
        intent: 'finish', taskId, assignmentId, expectedRevision: R1,
      }), `attempt ${attempt}`).toMatchObject({ status: 'error', reason: 'old_revision' });
      expect(createSupervisionRegistryPort().finishAssignment!({
        assignmentId, callerSessionName: workerLive.name, callerProjectName: PROJECT, expectedRevision: R1,
      })).toEqual({ ok: false, reason: 'old_revision' });
      expect(durable()).toBe(validatedR2);
    }
    expect(registry.getAssignment(assignmentId)).toMatchObject({ status: 'validated', auditRevision: R2 });

    // The exact R2 FINISHED is accepted once and then replays quietly.
    expect(createSupervisionRegistryPort().finishAssignment!({
      assignmentId, callerSessionName: workerLive.name, callerProjectName: PROJECT, expectedRevision: R2,
    })).toMatchObject({ ok: true });
    expect(registry.getAssignment(assignmentId)).toMatchObject({ status: 'ready_for_audit', auditRevision: R2 });
    expect(createSupervisionRegistryPort().finishAssignment!({
      assignmentId, callerSessionName: workerLive.name, callerProjectName: PROJECT, expectedRevision: R2,
    })).toMatchObject({ ok: true, replay: true });
  });

  it('refuses a DELAYED R1 FINISHED on the project-Brain rebind variant', async () => {
    const registry = getSupervisionTaskRegistry();
    rebindToR2();
    expect(registry.applyTaskIntent({
      taskId, assignmentId, intent: 'record_validation', toStatus: 'validated', validationState: 'passed',
      expectedRevision: R2,
    })).toMatchObject({ ok: true });
    const validatedR2 = durable();
    expect(await handlersFor(brainA)[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'finish', taskId, assignmentId, rebindSessionName: workerLive.name, expectedRevision: R1,
    })).toMatchObject({ status: 'error', reason: 'old_revision' });
    expect(registry.finishAssignmentAsProjectBrain({
      assignmentId, callerProjectName: PROJECT, callerIdentity: identityOf(brainA),
      rebindIdentity: identityOf(workerLive), rebindProjectName: PROJECT, expectedRevision: R1,
    })).toEqual({ ok: false, reason: 'old_revision' });
    expect(durable()).toBe(validatedR2);
    expect(await handlersFor(brainA)[SUPERVISION_MCP_TOOLS.INTENT]({
      intent: 'finish', taskId, assignmentId, rebindSessionName: workerLive.name, expectedRevision: R2,
    })).toMatchObject({ status: 'ok', toStatus: 'ready_for_audit' });
  });
});
