/**
 * The PRODUCTION wiring of coordinator authority.
 *
 * The registry gate is only as good as the identity the port hands it. If the
 * port resolved anything other than the CALLER's own live identity -- the
 * assignment's stored identity, a name, a project -- the registry check would
 * be vacuous while still looking correct. These tests therefore drive
 * `createSupervisionRegistryPort()` itself, so a second Brain in the same
 * project cannot finish a task it never dispatched.
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
      assignmentId: auditorAssignmentId,
      callerSessionName: brainB.name,
      callerProjectName: PROJECT,
      projectBrain: true,
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
  });

  it('refuses the coordinator NAME on a replacement runtime', () => {
    // Same name, new instance/epoch: a replacement window inherits nothing.
    listSessionsMock.mockReturnValue([
      { ...brainA, sessionInstanceId: 'instance-new', runtimeEpoch: 'epoch-new' },
      brainB, worker,
    ]);
    const port = createSupervisionRegistryPort();
    expect(port.finishAssignment({
      assignmentId: auditorAssignmentId,
      callerSessionName: brainA.name,
      callerProjectName: PROJECT,
      projectBrain: true,
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
  });

  it('refuses a caller with no live session record at all', () => {
    listSessionsMock.mockReturnValue([]);
    const port = createSupervisionRegistryPort();
    expect(port.finishAssignment({
      assignmentId: auditorAssignmentId,
      callerSessionName: brainA.name,
      callerProjectName: PROJECT,
      projectBrain: true,
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
  });

  it('lets the task\'s own live coordinator finish', () => {
    const port = createSupervisionRegistryPort();
    const res = port.finishAssignment({
      assignmentId: auditorAssignmentId,
      callerSessionName: brainA.name,
      callerProjectName: PROJECT,
      projectBrain: true,
    }) as { ok: boolean; reason?: string };
    expect(res).toMatchObject({ ok: true, value: { status: 'finalized' } });
  });
});

// ── R2 P1-1: the NON-projectBrain owner path ────────────────────────────────
// The port compared only `assignment.identity.sessionName === callerSessionName`
// and then handed the registry the STORED identity, so the registry's own exact
// check compared the stored identity against itself and was vacuously true. A
// replacement runtime (same name, new instance/epoch) therefore finished another
// instance's assignment.
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

  it('refuses a replacement runtime that reuses the owner session NAME', () => {
    // Same name, new instance/epoch: this is a different identity.
    listSessionsMock.mockReturnValue([
      brainA,
      { ...workerLive, sessionInstanceId: 'instance-replacement', runtimeEpoch: 'epoch-replacement' },
    ]);
    const port = createSupervisionRegistryPort();
    expect(port.finishAssignment({
      assignmentId: implementerAssignmentId,
      callerSessionName: workerLive.name,
      callerProjectName: PROJECT,
      projectBrain: false,
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
  });

  it('refuses an owner-named caller with no live session record', () => {
    listSessionsMock.mockReturnValue([brainA]);
    const port = createSupervisionRegistryPort();
    expect(port.finishAssignment({
      assignmentId: implementerAssignmentId,
      callerSessionName: workerLive.name,
      callerProjectName: PROJECT,
      projectBrain: false,
    })).toMatchObject({ ok: false, reason: 'owner_mismatch' });
  });

  it('still lets the exact live owner finish', () => {
    const port = createSupervisionRegistryPort();
    expect(port.finishAssignment({
      assignmentId: implementerAssignmentId,
      callerSessionName: workerLive.name,
      callerProjectName: PROJECT,
      projectBrain: false,
    })).toMatchObject({ ok: true });
  });
});

// ── R2 P1-2: task read/continuation gates ──────────────────────────────────
// `supervisionCallerParticipates` mapped assignments to `identity.sessionName`
// and did a string `.includes()`. A stale instance, a clone, or a same-name /
// different-epoch runtime therefore passed every visibility and continuation
// gate, while the call site's own comment claimed exact-identity binding.
describe('task visibility is bound to exact persistent identity', () => {
  const brainA = brain('deck_alpha_brain');
  const workerLive = { ...brain('deck_alpha_reader'), role: 'w1' as const };
  const taskId = 'visibility-exact-identity';

  function handlersFor(caller: { name: string }, sessions: unknown[]) {
    listSessionsMock.mockReturnValue(sessions);
    return createSupervisionMcpToolHandlers(
      { sessionName: caller.name, projectName: PROJECT } as never,
      {
        registry: createSupervisionRegistryPort(),
        isProjectBrain: () => false,
        resolveSessionIdentity: (name: string) => {
          const s = (sessions as { name: string; sessionInstanceId: string; runtimeEpoch: string; agentType: string }[])
            .find((c) => c.name === name);
          if (!s) return undefined;
          return { ...identityOf(s as never), projectName: PROJECT };
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

  it('refuses task_get to a same-name replacement runtime', async () => {
    const handlers = handlersFor(workerLive, [brainA, replacement]);
    expect(await handlers[SUPERVISION_MCP_TOOLS.GET]({ taskId }))
      .toMatchObject({ status: 'error', reason: 'identity_rejected' });
  });

  it('omits the task from task_list for a same-name replacement runtime', async () => {
    const handlers = handlersFor(workerLive, [brainA, replacement]);
    const res = await handlers[SUPERVISION_MCP_TOOLS.LIST]({}) as { tasks?: unknown[] };
    expect(res.tasks ?? []).toHaveLength(0);
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
