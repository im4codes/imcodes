/**
 * supervision_task_start's coordinator-role visibility gate.
 *
 * Reproduces a real gap hit live: an implementer self-initiates a task with
 * supervision_task_start (no coordinator assignment is ever created for
 * that), and the project's own Brain later tries to attach a coordinator
 * assignment to push it along -- identity_rejected, "task is not visible to
 * this caller", even though supervision_task_get works fine for the same
 * Brain (read access was never the problem; attach authority was). The
 * bare supervisionCallerParticipates check the gate used only recognizes
 * EXISTING assignees, and Brain was never assigned to this task in any role.
 *
 * The fix reuses send_tool's own task-continuation carve-out
 * (supervisionTaskCallerAuthority + isUniqueAuthoritativeProjectBrainCaller):
 * the project's own unique, live, authoritative Brain may always attach
 * coordinator to a task with zero coordinator rows, even one it never
 * participated in -- without loosening visibility for any other role or any
 * caller that is not genuinely that unique live Brain.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
} from '../../src/daemon/supervision-state-store.js';

function session(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    projectName: 'alpha',
    role: 'w1',
    agentType: 'codex-sdk',
    runtimeType: 'transport',
    projectDir: '/work/alpha',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SessionRecord;
}

const brain = session('deck_alpha_brain', { role: 'brain' });
const implementer = session('deck_sub_alpha_impl', { parentSession: 'deck_alpha_brain' });
const stranger = session('deck_sub_alpha_stranger', { parentSession: 'deck_alpha_brain' });

function handlersFor(caller: SessionRecord, allSessions: SessionRecord[]) {
  return createMemoryMcpToolHandlers(
    { userId: 'u', sessionName: caller.name, projectName: 'alpha', projectRoot: '/work/alpha' },
    { sendDeps: { listSessions: () => allSessions, isSessionAuthoritativelyActive: async () => true } },
  );
}

/** Implementer self-initiates a task the way tsk_v4n really was: no coordinator ever bound. */
async function selfInitiateImplementerTask(allSessions: SessionRecord[]) {
  const result = await handlersFor(implementer, allSessions)[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
    role: 'implementer', classification: 'independent_top_level',
    objective: 'fix the thing', scopeFiles: ['src/a.ts'], idempotencyKey: 'self-init',
  });
  expect(result).toMatchObject({ status: 'ok' });
  return (result as { taskId: string }).taskId;
}

describe('supervision_task_start lets the project Brain attach coordinator to a coordinator-less task', () => {
  beforeEach(() => resetSupervisionTaskRegistryForTests());
  afterEach(() => resetSupervisionTaskRegistryForTests());

  it('(a) succeeds for the unique live Brain on a task it never participated in', async () => {
    const sessions = [brain, implementer];
    const taskId = await selfInitiateImplementerTask(sessions);
    expect(getSupervisionTaskRegistry().get(taskId)?.assignments.some((a) => a.role === 'coordinator')).toBe(false);

    const result = await handlersFor(brain, sessions)[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
      taskId, role: 'coordinator', idempotencyKey: 'brain-attach',
    });
    expect(result).toMatchObject({ status: 'ok', taskId });

    const persisted = getSupervisionTaskRegistry().get(taskId);
    expect(persisted?.assignments.some((a) => a.role === 'coordinator' && a.identity?.sessionName === brain.name)).toBe(true);
  });

  it('(b) still refuses a non-Brain, non-participant caller for any role', async () => {
    const sessions = [brain, implementer, stranger];
    const taskId = await selfInitiateImplementerTask(sessions);

    const asImplementer = await handlersFor(stranger, sessions)[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
      taskId, role: 'implementer', idempotencyKey: 'stranger-impl',
    });
    expect(asImplementer).toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(String((asImplementer as { message?: string }).message)).toMatch(/not visible/);

    const asCoordinator = await handlersFor(stranger, sessions)[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
      taskId, role: 'coordinator', idempotencyKey: 'stranger-coord',
    });
    expect(asCoordinator).toMatchObject({ status: 'error', reason: 'identity_rejected' });
  });

  it('(c) does not let Brain hijack a task whose coordinator row already belongs to someone else', async () => {
    const sessions = [brain, implementer];
    const taskId = await selfInitiateImplementerTask(sessions);
    // A coordinator row already exists, bound to an identity that is no
    // longer a live session at all (e.g. a Brain that has since rotated
    // away) -- exactly the "stale but still real" case a hijack must not
    // walk through.
    const bound = getSupervisionTaskRegistry().createAssignment({
      taskId, role: 'coordinator',
      identity: {
        sessionName: 'deck_alpha_old_brain', sessionInstanceId: 'instance-old', runtimeEpoch: 'epoch-old',
        agentType: 'codex-sdk', providerFamily: 'openai',
      },
      required: false,
    });
    expect(bound).toMatchObject({ ok: true });

    const result = await handlersFor(brain, sessions)[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
      taskId, role: 'coordinator', idempotencyKey: 'brain-hijack-attempt',
    });
    expect(result).toMatchObject({ status: 'error', reason: 'identity_rejected' });

    const persisted = getSupervisionTaskRegistry().get(taskId);
    expect(persisted?.assignments.filter((a) => a.role === 'coordinator')).toHaveLength(1);
    expect(persisted?.assignments.find((a) => a.role === 'coordinator')?.identity?.sessionName).toBe('deck_alpha_old_brain');
  });

  it('(d1) refuses a role=brain caller when a second live brain-role session exists in the same project', async () => {
    const secondBrain = session('deck_alpha_clone_brain', { role: 'brain' });
    const sessions = [brain, secondBrain, implementer];
    const taskId = await selfInitiateImplementerTask(sessions);

    const result = await handlersFor(brain, sessions)[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
      taskId, role: 'coordinator', idempotencyKey: 'ambiguous-brain',
    });
    expect(result).toMatchObject({ status: 'error', reason: 'identity_rejected' });
  });

  it('(d2) refuses a role=brain caller whose only matching session is stopped', async () => {
    const stoppedBrain = session('deck_alpha_brain', { role: 'brain', state: 'stopped' });
    const sessions = [stoppedBrain, implementer];
    const taskId = await selfInitiateImplementerTask(sessions);

    const result = await handlersFor(stoppedBrain, sessions)[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
      taskId, role: 'coordinator', idempotencyKey: 'stopped-brain',
    });
    expect(result).toMatchObject({ status: 'error', reason: 'identity_rejected' });
  });

  it('(d3) refuses a nested brain-role sub-session (not top-level, so never the project Brain)', async () => {
    const nestedBrainRole = session('deck_sub_alpha_nested', { role: 'brain', parentSession: 'deck_alpha_brain' });
    const sessions = [brain, nestedBrainRole, implementer];
    const taskId = await selfInitiateImplementerTask(sessions);

    const result = await handlersFor(nestedBrainRole, sessions)[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
      taskId, role: 'coordinator', idempotencyKey: 'nested-brain',
    });
    expect(result).toMatchObject({ status: 'error', reason: 'identity_rejected' });
  });

  it('does not open a cross-project attach: a same-named Brain in a different project is still refused', async () => {
    const sessions = [brain, implementer];
    const taskId = await selfInitiateImplementerTask(sessions);
    const otherProjectBrain = session('deck_beta_brain', { role: 'brain', projectName: 'beta', projectDir: '/work/beta' });

    const result = await createMemoryMcpToolHandlers(
      { userId: 'u', sessionName: otherProjectBrain.name, projectName: 'beta', projectRoot: '/work/beta' },
      { sendDeps: { listSessions: () => [...sessions, otherProjectBrain], isSessionAuthoritativelyActive: async () => true } },
    )[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({ taskId, role: 'coordinator', idempotencyKey: 'cross-project' });
    expect(result).toMatchObject({ status: 'error', reason: 'identity_rejected' });
  });
});
