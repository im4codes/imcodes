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
