/**
 * Authenticated assignment ACK through the PRODUCTION MCP boundaries: the
 * supervision intent tool over the real registry port, and the controlled file
 * event tool. A recipient naming its own delegated implementer assignment
 * starts it atomically and idempotently; an unstartable assignment fails closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listSessionsMock = vi.hoisted(() => vi.fn(() => [] as unknown[]));
vi.mock('../../src/store/session-store.js', () => ({
  listSessions: listSessionsMock,
  getSession: (name: string) => (listSessionsMock() as { name: string }[]).find((s) => s.name === name),
  upsertSession: vi.fn(),
  loadStore: vi.fn(),
}));

import type { SessionRecord } from '../../src/store/session-store.js';
import { createSupervisionMcpToolDeps } from '../../src/daemon/supervision-registry-port.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
  type PersistedSupervisionTaskAssignmentIdentity,
} from '../../src/daemon/supervision-state-store.js';
import { resetDelegationReplyStoreForTests } from '../../src/daemon/delegation-reply-store.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { resolvePeerAuditProviderFamily } from '../../src/daemon/peer-audit-candidates.js';
import { createSupervisionMcpToolHandlers } from '../../src/daemon/supervision-mcp-tools.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { clearAssignmentAutoStartStateForTests, readAssignmentStartRefusalError } from '../../src/daemon/assignment-auto-start.js';
import { SUPERVISION_MCP_TOOLS } from '../../shared/supervision-mcp-tools.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import {
  SUPERVISION_ASSIGNMENT_AUTO_START_SOURCE,
  SUPERVISION_ASSIGNMENT_START_EVIDENCE,
  SUPERVISION_ASSIGNMENT_START_REFUSALS,
} from '../../shared/supervision-assignment-start.js';

const PROJECT = 'alpha';
const REVISION = 'rev-1';

function record(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    role: name.endsWith('_brain') ? 'brain' : 'w1',
    projectName: PROJECT,
    agentType: 'codex-sdk',
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    state: 'idle',
    projectDir: `/work/${PROJECT}`,
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SessionRecord;
}

const identityOf = (session: SessionRecord): PersistedSupervisionTaskAssignmentIdentity => ({
  sessionName: session.name,
  sessionInstanceId: session.sessionInstanceId!,
  runtimeEpoch: session.runtimeEpoch!,
  agentType: session.agentType,
  providerFamily: resolvePeerAuditProviderFamily(session),
});

const brain = record('deck_alpha_brain');
const worker = record('deck_sub_alpha_worker');
const taskId = 'tsk_ack_auto_start';
const assignmentId = 'asg_ack_auto_start';

function seed(boundIdentity = identityOf(worker)) {
  const registry = getSupervisionTaskRegistry();
  expect(registry.createOrGet({
    taskId, projectName: PROJECT, classification: 'independent_top_level', objective: 'ack starts work', currentRevision: REVISION,
  })).toMatchObject({ ok: true });
  expect(registry.createAssignment({
    assignmentId: `${assignmentId}_coord`, taskId, role: 'coordinator', required: false, identity: identityOf(brain),
  })).toMatchObject({ ok: true });
  expect(registry.createAssignment({
    assignmentId, taskId, role: 'implementer', identity: boundIdentity, auditRevision: REVISION, scopeFiles: ['src/a.ts'],
  })).toMatchObject({ ok: true });
}

function intentHandlers(caller: SessionRecord) {
  return createSupervisionMcpToolHandlers(
    { userId: 'u', sessionName: caller.name, projectName: PROJECT } as never,
    createSupervisionMcpToolDeps(),
  );
}

const intent = (caller: SessionRecord, args: Record<string, unknown>) => (
  intentHandlers(caller)[SUPERVISION_MCP_TOOLS.INTENT]({ taskId, ...args })
);

const autoStartEvents = () => getSupervisionTaskRegistry().listEvents(taskId)
  .filter((event) => event.payload?.source === SUPERVISION_ASSIGNMENT_AUTO_START_SOURCE);
const taskIntentEvents = () => getSupervisionTaskRegistry().listEvents(taskId)
  .filter((event) => String(event.payload?.source ?? '').startsWith('task_intent'));

describe('authenticated ACK starts a delegated assignment', () => {
  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
    listSessionsMock.mockReturnValue([brain, worker]);
  });
  afterEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
  });

  it('starts on the recipient\'s first lifecycle intent and makes start/claim idempotent', async () => {
    seed();
    await expect(intent(worker, { intent: 'heartbeat', assignmentId })).resolves.toMatchObject({ status: 'ok' });
    const registry = getSupervisionTaskRegistry();
    expect(registry.getAssignment(assignmentId)?.status).toBe('implementing');
    expect(registry.get(taskId)?.status).toBe('implementing');
    expect(autoStartEvents()).toHaveLength(2);
    expect(autoStartEvents()[0]!.payload).toMatchObject({ evidence: SUPERVISION_ASSIGNMENT_START_EVIDENCE.ASSIGNMENT_ACK });

    // A model that still calls start/claim afterwards gets the same state, not
    // an illegal transition, and no second lifecycle edge is written.
    for (const repeated of ['start', 'claim', 'start']) {
      await expect(intent(worker, { intent: repeated, assignmentId })).resolves.toMatchObject({
        status: 'ok', intent: repeated, fromStatus: 'implementing', toStatus: 'implementing', idempotentReplay: true,
      });
    }
    expect(autoStartEvents()).toHaveLength(2);
    expect(taskIntentEvents().filter((event) => event.eventType === 'implementing')).toHaveLength(0);
  });

  it('routes an explicit start through the same atomic edge', async () => {
    seed();
    await expect(intent(worker, { intent: 'start', assignmentId })).resolves.toMatchObject({
      status: 'ok', intent: 'start', fromStatus: 'delegated', toStatus: 'implementing', idempotentReplay: false,
    });
    expect(autoStartEvents().map((event) => event.eventType)).toEqual(['implementing', 'implementing']);
    expect(taskIntentEvents()).toHaveLength(0);
  });

  it('lets the first intent be real work: a passed validation from delegated starts then validates', async () => {
    seed();
    await expect(intent(worker, { intent: 'record_validation', assignmentId, validationState: 'passed', expectedRevision: REVISION }))
      .resolves.toMatchObject({ status: 'ok', intent: 'record_validation', fromStatus: 'implementing' });
    expect(getSupervisionTaskRegistry().getAssignment(assignmentId)?.status).toBe('validated');
  });

  it('never starts on a revision-authoritative intent the registry refuses: a stale revision leaves everything untouched', async () => {
    seed();
    const registry = getSupervisionTaskRegistry();
    const durable = () => JSON.stringify({
      assignment: registry.getAssignment(assignmentId),
      task: registry.getTaskRecord(taskId),
      events: registry.listEvents(taskId),
    });
    const before = durable();
    await expect(intent(worker, {
      intent: 'record_validation', assignmentId, validationState: 'passed', expectedRevision: 'rev-predecessor',
    })).resolves.toMatchObject({ status: 'error', reason: 'old_revision' });
    // Refused exactly as the registry refuses the intent itself, and nothing
    // started first: no lifecycle edge, no hold, no event.
    expect(durable()).toBe(before);
    expect(registry.getAssignment(assignmentId)).toMatchObject({ status: 'delegated' });
    expect(registry.getAssignment(assignmentId)?.blocker).toBeUndefined();
    expect(autoStartEvents()).toHaveLength(0);
  });

  it('stamps no validation authority when an ACK starts the delegated assignment', async () => {
    seed();
    await expect(intent(worker, { intent: 'heartbeat', assignmentId })).resolves.toMatchObject({ status: 'ok' });
    const registry = getSupervisionTaskRegistry();
    expect(registry.getAssignment(assignmentId)).toMatchObject({ status: 'implementing', auditRevision: REVISION });
    expect(registry.getAssignment(assignmentId)?.validationState).toBeUndefined();
    expect(registry.getAssignment(assignmentId)?.validatedRevision).toBeUndefined();
    expect(registry.getTaskRecord(taskId)).toMatchObject({ currentRevision: REVISION });
    expect(registry.getTaskRecord(taskId)?.validationState).toBeUndefined();
    expect(registry.getTaskRecord(taskId)?.validatedRevision).toBeUndefined();
  });

  it('converges a recipient whose runtime rotated since dispatch', async () => {
    seed({ ...identityOf(worker), runtimeEpoch: 'epoch-at-dispatch' });
    await expect(intent(worker, { intent: 'checkpoint', assignmentId })).resolves.toMatchObject({ status: 'ok' });
    expect(getSupervisionTaskRegistry().getAssignment(assignmentId)).toMatchObject({
      status: 'implementing', identity: identityOf(worker),
    });
  });

  it('rejects task-only revision supersession and starts the still-consistent assignment', async () => {
    seed();
    expect(getSupervisionTaskRegistry().updateTask({ taskId, currentRevision: 'rev-2' }))
      .toMatchObject({ ok: false, reason: 'old_revision' });
    await expect(intent(worker, { intent: 'heartbeat', assignmentId })).resolves.toMatchObject({ status: 'ok' });
    expect(getSupervisionTaskRegistry().getTaskRecord(taskId)?.currentRevision).toBe(REVISION);
    expect(getSupervisionTaskRegistry().getAssignment(assignmentId)).toMatchObject({
      status: 'implementing', auditRevision: REVISION,
    });
    expect(autoStartEvents().some((event) => event.assignmentId === assignmentId)).toBe(true);
  });

  it('never starts on the coordinator\'s behalf', async () => {
    seed();
    await intent(brain, { intent: 'heartbeat', assignmentId });
    expect(getSupervisionTaskRegistry().getAssignment(assignmentId)?.status).toBe('delegated');
    expect(autoStartEvents()).toHaveLength(0);
  });
});

describe('controlled file event starts a delegated assignment', () => {
  const fileEvent = (caller: SessionRecord, filePath: string) => createMemoryMcpToolHandlers(
    { userId: 'u', sessionName: caller.name, projectName: PROJECT, projectRoot: `/work/${PROJECT}` },
    { sendDeps: { listSessions: () => [brain, worker], isSessionAuthoritativelyActive: async () => true } },
  )[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT]({ assignmentId, filePath, operation: 'modify' });

  beforeEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
    listSessionsMock.mockReturnValue([brain, worker]);
  });
  afterEach(() => {
    resetSupervisionTaskRegistryForTests();
    resetDelegationReplyStoreForTests();
    resetTransportQueueStoreForTests();
    clearAssignmentAutoStartStateForTests();
  });

  it('starts the assignment, then records the file event', async () => {
    seed();
    await expect(fileEvent(worker, 'src/a.ts')).resolves.toMatchObject({ status: 'ok', item: { status: 'implementing' } });
    expect(autoStartEvents()[0]!.payload).toMatchObject({ evidence: SUPERVISION_ASSIGNMENT_START_EVIDENCE.FILE_EVENT });
    expect(getSupervisionTaskRegistry().listFileEvents(taskId).map((event) => event.path)).toEqual(['src/a.ts']);
  });

  it('records work after refusing a task-only revision split', async () => {
    seed();
    expect(getSupervisionTaskRegistry().updateTask({ taskId, currentRevision: 'rev-2' }))
      .toMatchObject({ ok: false, reason: 'old_revision' });
    await expect(fileEvent(worker, 'src/a.ts')).resolves.toMatchObject({ status: 'ok' });
    expect(getSupervisionTaskRegistry().listFileEvents(taskId).map((event) => event.path)).toEqual(['src/a.ts']);
    expect(getSupervisionTaskRegistry().getAssignment(assignmentId)?.status).toBe('implementing');
  });
});
