import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXECUTION_CLONE_KIND,
  EXECUTION_CLONE_ERROR_CODES,
  EXECUTION_CLONE_CAPABILITY_V1,
  DEFAULT_MAX_PARALLEL_CLONES,
  defaultDedicatedExecutionRoutingPreference,
} from '../../shared/execution-clone.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { isDaemonCapabilityAdvertised } from '../../src/daemon/server-link.js';
import type { SessionRecord } from '../../src/store/session-store.js';

// ── Mock the daemon execution-clone module ───────────────────────────────────
//
// The send-tool clone branch + destroy tool lazily import `./execution-clone.js`.
// We mock that module so create/destroy are spy-able without touching tmux,
// the session store, or the live timeline. `ExecutionCloneError` carries a
// `.code` field that the send/destroy mapping inspects.

// Hoisted with the mocks: `send-tool.ts` now statically imports `isExecutionClone`
// from `./execution-clone.js` (item 15), so the mock factory is evaluated at
// module-load time. `FakeExecutionCloneError` must therefore be available during
// hoisting (a bare `class` below would be in the temporal dead zone), and
// `isExecutionClone` must be a real predicate (not a vi.fn) so the static
// sibling-exclusion + idempotency existence checks behave correctly.
const cloneMocks = vi.hoisted(() => {
  const KIND = 'execution_clone';
  class FakeExecutionCloneError extends Error {
    constructor(public readonly code: string, message?: string) {
      super(message ?? code);
      this.name = 'ExecutionCloneError';
    }
  }
  return {
    createExecutionClone: vi.fn(),
    destroyExecutionClone: vi.fn(),
    FakeExecutionCloneError,
    isExecutionClone: (record: { executionCloneMetadata?: { kind?: string } } | undefined) =>
      record?.executionCloneMetadata?.kind === KIND,
  };
});

const FakeExecutionCloneError = cloneMocks.FakeExecutionCloneError;

vi.mock('../../src/daemon/execution-clone.js', () => ({
  createExecutionClone: cloneMocks.createExecutionClone,
  destroyExecutionClone: cloneMocks.destroyExecutionClone,
  isExecutionClone: cloneMocks.isExecutionClone,
  ExecutionCloneError: cloneMocks.FakeExecutionCloneError,
}));

import {
  clearSendIdempotencyCacheForTests,
  dispatchDestroyExecutionClone,
  dispatchSendMessage,
  dispatchSendStop,
  listSendTargets,
} from '../../src/daemon/send-tool.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { validateMcpCronAction } from '../../src/daemon/cron-action-validator.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import type { ContextNamespace } from '../../shared/context-types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function session(overrides: Partial<SessionRecord> & Pick<SessionRecord, 'name' | 'projectName' | 'role'>): SessionRecord {
  return {
    agentType: 'codex',
    projectDir: `/work/${overrides.projectName}`,
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as SessionRecord;
}

const BRAIN = 'deck_alpha_brain';
const TEMPLATE = 'deck_alpha_w1';
const CLONE = 'deck_sub_clone01';

const brainCaller = {
  userId: 'user-1',
  sessionName: BRAIN,
  projectName: 'alpha',
  projectRoot: '/work/alpha',
};

function baseSessions(extra: SessionRecord[] = []): SessionRecord[] {
  return [
    session({ name: BRAIN, projectName: 'alpha', role: 'brain' }),
    session({ name: TEMPLATE, projectName: 'alpha', role: 'w1', label: 'Coder' }),
    ...extra,
  ];
}

const canonicalClone = {
  kind: EXECUTION_CLONE_KIND,
  ephemeral: true as const,
  parentRunId: 'run-1',
  parentStage: 'generic_execution' as const,
};

function mcpCaller(overrides: Partial<McpRuntimeCaller> = {}): McpRuntimeCaller {
  const namespace: ContextNamespace = { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' };
  return {
    userId: 'user-1',
    namespace,
    sessionName: BRAIN,
    projectName: 'alpha',
    projectRoot: '/work/alpha',
    serverId: 'srv-1',
    transport: 'in_process',
    ...overrides,
  };
}

function createdResult(target = CLONE, hardTimeoutAt = 999) {
  return { sessionName: target, target, metadata: { hardTimeoutAt } };
}

/** A live execution-clone sub-session record (sibling of the template). */
function cloneSession(name = CLONE, parentRunId = 'run-1'): SessionRecord {
  return session({
    name,
    projectName: 'alpha',
    role: 'w1',
    label: 'Clone Worker',
    parentSession: BRAIN,
    executionCloneMetadata: {
      kind: EXECUTION_CLONE_KIND,
      ephemeral: true,
      cloneOfSessionName: TEMPLATE,
      parentRunId,
      parentStage: 'generic_execution',
      createdBySessionName: BRAIN,
      createdAt: 1,
      hardTimeoutAt: 2,
      retentionExpiresAt: null,
      cleanupState: 'active',
      autoDestroy: true,
    },
  });
}

beforeEach(() => {
  clearSendIdempotencyCacheForTests();
  cloneMocks.createExecutionClone.mockReset();
  cloneMocks.destroyExecutionClone.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── 4.1 strict clone schema ──────────────────────────────────────────────────

describe('send_message strict clone schema', () => {
  it('accepts the canonical clone shape and forwards it to createExecutionClone', async () => {
    const dispatchMessage = vi.fn(async () => {});
    cloneMocks.createExecutionClone.mockResolvedValue(createdResult());
    const handlers = createMemoryMcpToolHandlers(mcpCaller(), {
      sendDeps: { listSessions: () => baseSessions(), dispatchMessage },
      isMemoryFeatureEnabled: () => true,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]({
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    });

    expect(result).toMatchObject({ status: 'accepted', clone: { target: CLONE } });
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(1);
    expect(cloneMocks.createExecutionClone.mock.calls[0][0]).toMatchObject({
      templateSessionName: TEMPLATE,
      parentRunId: 'run-1',
      parentStage: 'generic_execution',
      ownerSessionName: BRAIN,
    });
  });

  it.each([
    ['ttlMs', { ...canonicalClone, ttlMs: 1000 }],
    ['extra forged key', { ...canonicalClone, forged: true }],
    ['forged kind', { ...canonicalClone, kind: 'session_group_clone' }],
    ['ephemeral false', { ...canonicalClone, ephemeral: false }],
    ['empty parentRunId', { ...canonicalClone, parentRunId: '' }],
    ['bad parentStage', { ...canonicalClone, parentStage: 'not_a_stage' }],
  ])('rejects clone with %s and never creates a clone', async (_label, clone) => {
    const dispatchMessage = vi.fn(async () => {});
    const handlers = createMemoryMcpToolHandlers(mcpCaller(), {
      sendDeps: { listSessions: () => baseSessions(), dispatchMessage },
      isMemoryFeatureEnabled: () => true,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]({
      target: TEMPLATE,
      message: 'do the work',
      clone,
    });

    expect(result).toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();
  });
});

// ── 4.2 dispatch branch + rollback + structural liveness ─────────────────────

describe('execution-clone send dispatch', () => {
  it('dispatches the worker message to the CLONE, not the template', async () => {
    const dispatchMessage = vi.fn(async () => {});
    cloneMocks.createExecutionClone.mockResolvedValue(createdResult(CLONE, 4242));
    const result = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      getSession: (name) => baseSessions().find((s) => s.name === name),
      dispatchMessage,
    });

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.clone).toEqual({ target: CLONE, sessionName: CLONE, hardTimeoutAt: 4242 });
    // Dispatched to the clone target, never the template.
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0][0].name).toBe(CLONE);
    expect(dispatchMessage.mock.calls[0][0].name).not.toBe(TEMPLATE);
  });

  it('forces reply:true so the worker message carries a reply instruction', async () => {
    const dispatchMessage = vi.fn(async () => {});
    cloneMocks.createExecutionClone.mockResolvedValue(createdResult());
    await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
    });

    const sentMessage = dispatchMessage.mock.calls[0][1] as string;
    expect(sentMessage).toContain('imcodes send');
    expect(sentMessage).toContain(BRAIN);
  });

  it('rolls back (destroys) the clone when dispatch fails after creation — no orphan', async () => {
    const dispatchMessage = vi.fn(async () => { throw new Error('pane gone'); });
    cloneMocks.createExecutionClone.mockResolvedValue(createdResult());
    cloneMocks.destroyExecutionClone.mockResolvedValue(undefined);

    const result = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
    });

    expect(result.status).toBe('error');
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(1);
    expect(cloneMocks.destroyExecutionClone).toHaveBeenCalledTimes(1);
    expect(cloneMocks.destroyExecutionClone.mock.calls[0][0]).toMatchObject({
      target: CLONE,
      reason: 'destroyed',
      bypassAuth: true,
    });
  });

  it('maps an ExecutionCloneError code onto the send result and surfaces the code', async () => {
    const dispatchMessage = vi.fn(async () => {});
    cloneMocks.createExecutionClone.mockRejectedValue(
      new FakeExecutionCloneError(EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL),
    );
    const result = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.reason).toBe('write_quota_exceeded');
    expect(result.error).toContain(EXECUTION_CLONE_ERROR_CODES.CAPACITY_FULL);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('STRUCTURAL LIVENESS: a non-clone send NEVER calls createExecutionClone', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'ordinary send',
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
    });

    expect(result.status).toBe('accepted');
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
    expect(cloneMocks.destroyExecutionClone).not.toHaveBeenCalled();
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0][0].name).toBe(TEMPLATE);
  });

  it('rejects broadcast + clone', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      broadcast: true,
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
    });

    expect(result).toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
  });

  it('rejects a clone request from a caller that is itself an execution clone (worker_clone_forbidden)', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const cloneCaller = {
      userId: 'user-1',
      sessionName: CLONE,
      projectName: 'alpha',
      projectRoot: '/work/alpha',
    };
    const sessions = baseSessions([
      session({
        name: CLONE,
        projectName: 'alpha',
        role: 'w1',
        parentSession: BRAIN,
        executionCloneMetadata: {
          kind: EXECUTION_CLONE_KIND,
          ephemeral: true,
          cloneOfSessionName: TEMPLATE,
          parentRunId: 'run-1',
          parentStage: 'generic_execution',
          createdBySessionName: BRAIN,
          createdAt: 1,
          hardTimeoutAt: 2,
          retentionExpiresAt: null,
          cleanupState: 'active',
          autoDestroy: true,
        },
      }),
    ]);

    const result = await dispatchSendMessage(cloneCaller, {
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => sessions,
      dispatchMessage,
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.reason).toBe('scope_forbidden');
    expect(result.error).toContain(EXECUTION_CLONE_ERROR_CODES.WORKER_CLONE_FORBIDDEN);
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
  });

  it('rejects a clone from a cron-issued send (userId === cron)', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage({ ...brainCaller, userId: 'cron' }, {
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.error).toContain(EXECUTION_CLONE_ERROR_CODES.CRON_CLONE_FORBIDDEN);
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
  });
});

// ── 4.5 capability gate ──────────────────────────────────────────────────────

describe('execution-clone capability gate', () => {
  it('rejects the clone path when the capability is not advertised', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
      isExecutionCloneCapabilityEnabled: () => false,
    });

    expect(result).toMatchObject({ status: 'error', reason: 'feature_disabled' });
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
  });
});

// ── 4.3 destroy tool + idempotency ───────────────────────────────────────────

describe('destroy_execution_clone tool', () => {
  it('destroys a clone created by the caller', async () => {
    cloneMocks.destroyExecutionClone.mockResolvedValue(undefined);
    const result = await dispatchDestroyExecutionClone(brainCaller, { target: CLONE });

    expect(result).toEqual({ status: 'ok' });
    expect(cloneMocks.destroyExecutionClone).toHaveBeenCalledWith({
      target: CLONE,
      callerSessionName: BRAIN,
      reason: 'destroyed',
    });
  });

  it('returns destroy_forbidden when the caller is not the creator', async () => {
    cloneMocks.destroyExecutionClone.mockRejectedValue(
      new FakeExecutionCloneError(EXECUTION_CLONE_ERROR_CODES.DESTROY_FORBIDDEN),
    );
    const result = await dispatchDestroyExecutionClone(brainCaller, { target: CLONE });

    expect(result).toEqual({ status: 'error', reason: EXECUTION_CLONE_ERROR_CODES.DESTROY_FORBIDDEN });
  });

  it('idempotency replay after destroy returns target_not_found (no recreate)', async () => {
    // First call succeeds; a later real destroy of an already-gone clone throws
    // target_not_found. We assert the destroy path surfaces that code rather than
    // recreating anything (createExecutionClone is never touched by destroy).
    cloneMocks.destroyExecutionClone.mockRejectedValue(
      new FakeExecutionCloneError(EXECUTION_CLONE_ERROR_CODES.TARGET_NOT_FOUND),
    );
    const result = await dispatchDestroyExecutionClone(brainCaller, { target: CLONE });

    expect(result).toEqual({ status: 'error', reason: EXECUTION_CLONE_ERROR_CODES.TARGET_NOT_FOUND });
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
  });

  it('replays the cached ok result within the idempotency window without a second destroy', async () => {
    cloneMocks.destroyExecutionClone.mockResolvedValue(undefined);
    const first = await dispatchDestroyExecutionClone(brainCaller, { target: CLONE, idempotencyKey: 'k1' });
    const second = await dispatchDestroyExecutionClone(brainCaller, { target: CLONE, idempotencyKey: 'k1' });

    expect(first).toEqual({ status: 'ok' });
    expect(second).toEqual({ status: 'ok', idempotentReplay: true });
    expect(cloneMocks.destroyExecutionClone).toHaveBeenCalledTimes(1);
  });
});

// ── 4.6 cron block ───────────────────────────────────────────────────────────

describe('cron action validator blocks clone requests', () => {
  it('rejects a structured send action that carries a clone key', () => {
    const result = validateMcpCronAction({
      type: 'send',
      target: TEMPLATE,
      message: 'go',
      clone: { ...canonicalClone },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('validation_failed');
    expect(result.message).toContain(EXECUTION_CLONE_ERROR_CODES.CRON_CLONE_FORBIDDEN);
  });

  it('still accepts an ordinary send action with no clone key', () => {
    const result = validateMcpCronAction({ type: 'send', target: TEMPLATE, message: 'go' });
    expect(result.ok).toBe(true);
  });
});

// ── Item 13: clone-create idempotency ────────────────────────────────────────

describe('execution-clone send idempotency (item 13)', () => {
  it('duplicate clone send with the same idempotencyKey creates the clone ONCE and replays', async () => {
    const dispatchMessage = vi.fn(async () => {});
    cloneMocks.createExecutionClone.mockResolvedValue(createdResult());
    // After creation the clone exists as a live sub-session; the replay verifies
    // existence via getSession + isExecutionClone.
    const sessions = () => baseSessions([cloneSession()]);
    const deps = {
      listSessions: sessions,
      getSession: (name: string) => sessions().find((s) => s.name === name),
      dispatchMessage,
    };

    const first = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      idempotencyKey: 'clone-key-1',
      clone: { ...canonicalClone },
    }, deps);
    const second = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      idempotencyKey: 'clone-key-1',
      clone: { ...canonicalClone },
    }, deps);

    expect(first.status).toBe('accepted');
    expect(second).toMatchObject({ status: 'accepted', idempotentReplay: true, clone: { target: CLONE } });
    // The second send is a pure replay — no second create, no second dispatch.
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(1);
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('dedups identical clone requests even without an idempotencyKey (fingerprint match)', async () => {
    const dispatchMessage = vi.fn(async () => {});
    cloneMocks.createExecutionClone.mockResolvedValue(createdResult());
    const sessions = () => baseSessions([cloneSession()]);
    const deps = {
      listSessions: sessions,
      getSession: (name: string) => sessions().find((s) => s.name === name),
      dispatchMessage,
    };

    const first = await dispatchSendMessage(brainCaller, { target: TEMPLATE, message: 'do the work', clone: { ...canonicalClone } }, deps);
    const second = await dispatchSendMessage(brainCaller, { target: TEMPLATE, message: 'do the work', clone: { ...canonicalClone } }, deps);

    expect(first.status).toBe('accepted');
    expect(second).toMatchObject({ status: 'accepted', idempotentReplay: true });
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(1);
  });

  it('replay after the clone is destroyed returns target_not_found and does NOT recreate', async () => {
    const dispatchMessage = vi.fn(async () => {});
    cloneMocks.createExecutionClone.mockResolvedValue(createdResult());
    // First send: the clone exists. Second send (post-destroy): the clone is gone.
    let cloneAlive = true;
    const sessions = () => baseSessions(cloneAlive ? [cloneSession()] : []);
    const deps = {
      listSessions: sessions,
      getSession: (name: string) => sessions().find((s) => s.name === name),
      dispatchMessage,
    };

    const first = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      idempotencyKey: 'clone-key-2',
      clone: { ...canonicalClone },
    }, deps);
    expect(first.status).toBe('accepted');

    cloneAlive = false; // the clone was destroyed between the two requests
    const replay = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      idempotencyKey: 'clone-key-2',
      clone: { ...canonicalClone },
    }, deps);

    expect(replay.status).toBe('error');
    if (replay.status !== 'error') throw new Error('expected error');
    expect(replay.error).toContain(EXECUTION_CLONE_ERROR_CODES.TARGET_NOT_FOUND);
    // No recreate: createExecutionClone is still only the single original call.
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(1);
  });
});

// ── Item 15: clone excluded from send_list_targets + broadcast ────────────────

describe('execution clones are excluded as send targets (item 15)', () => {
  it('send_list_targets never lists an execution clone', () => {
    const result = listSendTargets(brainCaller, {}, { listSessions: () => baseSessions([cloneSession()]) });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    const names = result.items.map((item) => item.sessionName);
    expect(names).toContain(TEMPLATE);
    expect(names).not.toContain(CLONE);
  });

  it('broadcast send never dispatches to an execution clone', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(brainCaller, {
      message: 'broadcast body',
      broadcast: true,
    }, {
      listSessions: () => baseSessions([cloneSession()]),
      dispatchMessage,
    });

    expect(result.status).toBe('accepted');
    const dispatchedTo = dispatchMessage.mock.calls.map((call) => (call[0] as SessionRecord).name);
    expect(dispatchedTo).toContain(TEMPLATE);
    expect(dispatchedTo).not.toContain(CLONE);
  });
});

// ── N1: exact clone.target is addressable (creator-only) for send/stop ────────

describe('N1: execution clone exact follow-up addressing (creator-only)', () => {
  // The creator of `cloneSession()` is BRAIN (createdBySessionName: BRAIN), so
  // `brainCaller` is the clone's creator. A same-project non-creator is modeled
  // by a sibling worker session.
  const NON_CREATOR = 'deck_alpha_w2';
  const nonCreatorCaller = {
    userId: 'user-1',
    sessionName: NON_CREATOR,
    projectName: 'alpha',
    projectRoot: '/work/alpha',
  };

  function sessionsWithClone(): SessionRecord[] {
    return baseSessions([
      session({ name: NON_CREATOR, projectName: 'alpha', role: 'w1', label: 'Other Worker' }),
      cloneSession(),
    ]);
  }

  it('creator can exact send_message to the clone.target and it dispatches to the clone', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(brainCaller, {
      target: CLONE,
      message: 'follow-up to the worker',
    }, {
      listSessions: sessionsWithClone,
      dispatchMessage,
      exactTargetOnly: true,
    });

    expect(result.status).toBe('accepted');
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0][0].name).toBe(CLONE);
    // The non-clone ordinary path is used — no clone is created.
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
  });

  it('creator can exact send_stop the clone.target', async () => {
    const cancelSession = vi.fn(async () => true);
    const result = await dispatchSendStop(brainCaller, {
      target: CLONE,
    }, {
      listSessions: sessionsWithClone,
      cancelSession,
      exactTargetOnly: true,
    });

    expect(result.status).toBe('accepted');
    expect(cancelSession).toHaveBeenCalledTimes(1);
    expect(cancelSession.mock.calls[0][0].name).toBe(CLONE);
  });

  it('a non-creator same-project session is REJECTED for exact send_message to the clone', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(nonCreatorCaller, {
      target: CLONE,
      message: 'try to drive someone else\'s worker',
    }, {
      listSessions: sessionsWithClone,
      dispatchMessage,
      exactTargetOnly: true,
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.reason).toBe('scope_forbidden');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('a non-creator same-project session is REJECTED for exact send_stop on the clone', async () => {
    const cancelSession = vi.fn(async () => true);
    const result = await dispatchSendStop(nonCreatorCaller, {
      target: CLONE,
    }, {
      listSessions: sessionsWithClone,
      cancelSession,
      exactTargetOnly: true,
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.reason).toBe('scope_forbidden');
    expect(cancelSession).not.toHaveBeenCalled();
  });

  it('a clone is NOT matched by label (fuzzy match must never resolve a clone)', async () => {
    const dispatchMessage = vi.fn(async () => {});
    // The clone's label is "Clone Worker"; with exactTargetOnly=false a label
    // match would normally be attempted, but clones must never match by label.
    const result = await dispatchSendMessage(brainCaller, {
      target: 'Clone Worker',
      message: 'address by label',
    }, {
      listSessions: sessionsWithClone,
      dispatchMessage,
      exactTargetOnly: false,
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.reason).toBe('validation_failed');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('a clone is NOT matched by agentType (fuzzy match must never resolve a clone)', async () => {
    const dispatchMessage = vi.fn(async () => {});
    // The clone is the ONLY session carrying agentType "gemini"; no non-clone
    // sibling shares it. With exactTargetOnly=false, an agentType fuzzy match
    // would normally resolve — but a clone must never be matched by agentType,
    // so this must fail to resolve (validation_failed), not dispatch to the clone.
    const cloneWithUniqueAgentType = { ...cloneSession(), agentType: 'gemini' } as SessionRecord;
    const result = await dispatchSendMessage(brainCaller, {
      target: 'gemini',
      message: 'address by agentType',
    }, {
      listSessions: () => baseSessions([cloneWithUniqueAgentType]),
      dispatchMessage,
      exactTargetOnly: false,
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.reason).toBe('validation_failed');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('send_list_targets and broadcast still never include the clone (regression guard)', async () => {
    const listResult = listSendTargets(brainCaller, {}, { listSessions: sessionsWithClone });
    expect(listResult.status).toBe('ok');
    if (listResult.status !== 'ok') throw new Error('expected ok');
    expect(listResult.items.map((i) => i.sessionName)).not.toContain(CLONE);

    const dispatchMessage = vi.fn(async () => {});
    const bcast = await dispatchSendMessage(brainCaller, {
      message: 'broadcast',
      broadcast: true,
    }, {
      listSessions: sessionsWithClone,
      dispatchMessage,
    });
    expect(bcast.status).toBe('accepted');
    const dispatchedTo = dispatchMessage.mock.calls.map((c) => (c[0] as SessionRecord).name);
    expect(dispatchedTo).not.toContain(CLONE);
  });
});

// ── N1: a clone used as a clone-create TEMPLATE surfaces clone_of_clone_forbidden

describe('N1: clone-as-template resolves through to clone_of_clone_forbidden', () => {
  it('using an exact clone name as the clone template surfaces clone_of_clone_forbidden (not generic not-found)', async () => {
    const dispatchMessage = vi.fn(async () => {});
    // The real createExecutionClone → validateExecutionTemplateCandidate returns
    // clone_of_clone_forbidden when the resolved template is itself a clone. Here
    // createExecutionClone is mocked, so we simulate that rejection — the point of
    // this test is that resolution REACHES create (no pre-filter generic
    // not-found), passing the clone name as the template.
    cloneMocks.createExecutionClone.mockRejectedValue(
      new FakeExecutionCloneError(EXECUTION_CLONE_ERROR_CODES.CLONE_OF_CLONE_FORBIDDEN),
    );

    const result = await dispatchSendMessage(brainCaller, {
      target: CLONE, // the template is itself an execution clone
      message: 'clone the clone',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions([cloneSession()]),
      getSession: (name) => baseSessions([cloneSession()]).find((s) => s.name === name),
      dispatchMessage,
    });

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.error).toContain(EXECUTION_CLONE_ERROR_CODES.CLONE_OF_CLONE_FORBIDDEN);
    // Resolution reached create with the clone as the template (not a generic
    // pre-filter "target not found").
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(1);
    expect(cloneMocks.createExecutionClone.mock.calls[0][0].templateSessionName).toBe(CLONE);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });
});

// ── reply:false rejection for clone (design "Reject clone + reply:false") ──────

describe('clone + reply:false rejection', () => {
  it('rejects clone + reply:false with validation_failed, never creates a clone, never dispatches', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      reply: false,
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
    });

    expect(result).toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('accepts clone + reply:true (force reply path) and creates + dispatches', async () => {
    const dispatchMessage = vi.fn(async () => {});
    cloneMocks.createExecutionClone.mockResolvedValue(createdResult());
    const result = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      reply: true,
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
    });

    expect(result.status).toBe('accepted');
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(1);
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('accepts clone with omitted reply (force reply path) and creates + dispatches', async () => {
    const dispatchMessage = vi.fn(async () => {});
    cloneMocks.createExecutionClone.mockResolvedValue(createdResult());
    const result = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
    });

    expect(result.status).toBe('accepted');
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(1);
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });
});

// ── Item 16: capability gate consults the daemon advertisement ────────────────

describe('execution-clone capability advertisement wiring (item 16)', () => {
  it('execution-clone:v1 IS part of the daemon static advertisement (production default = enabled)', () => {
    expect(isDaemonCapabilityAdvertised(EXECUTION_CLONE_CAPABILITY_V1)).toBe(true);
  });

  it('an un-advertised capability is reported as not advertised', () => {
    expect(isDaemonCapabilityAdvertised('definitely-not-a-real-capability:v9')).toBe(false);
  });

  it('the clone path is rejected when the advertisement resolver reports the cap missing', async () => {
    // Mirrors mergeDefaultToolDeps wiring: the gate is computed from
    // isDaemonCapabilityAdvertised. With an un-advertised cap → feature_disabled.
    const dispatchMessage = vi.fn(async () => {});
    const result = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
      isExecutionCloneCapabilityEnabled: () => isDaemonCapabilityAdvertised('definitely-not-a-real-capability:v9'),
    });

    expect(result).toMatchObject({ status: 'error', reason: 'feature_disabled' });
    expect(cloneMocks.createExecutionClone).not.toHaveBeenCalled();
  });

  it('the clone path is allowed when the advertisement resolver reports the real cap', async () => {
    const dispatchMessage = vi.fn(async () => {});
    cloneMocks.createExecutionClone.mockResolvedValue(createdResult());
    const result = await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
      isExecutionCloneCapabilityEnabled: () => isDaemonCapabilityAdvertised(EXECUTION_CLONE_CAPABILITY_V1),
    });

    expect(result.status).toBe('accepted');
    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(1);
  });
});

// ── Item 14 (TE-C): configured non-default limits change the enforced cap ─────

describe('resolved clone limits are consumed on the create path (item 14 / TE-C)', () => {
  it('a configured maxParallelClones=1 is threaded to createExecutionClone (tighter than the default)', async () => {
    const dispatchMessage = vi.fn(async () => {});
    cloneMocks.createExecutionClone.mockResolvedValue(createdResult());
    const tightLimits = { ...defaultDedicatedExecutionRoutingPreference(), maxParallelClones: 1 };

    await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
      resolveExecutionCloneLimits: (parentRunId) => {
        expect(parentRunId).toBe('run-1');
        return tightLimits;
      },
    });

    expect(cloneMocks.createExecutionClone).toHaveBeenCalledTimes(1);
    const passedPref = cloneMocks.createExecutionClone.mock.calls[0][0].pref;
    // The configured cap (1) is enforced — NOT the canonical default (3). The
    // real createExecutionClone rejects with capacity_full once
    // countActiveExecutionClones(parentRunId) >= pref.maxParallelClones, so this
    // value provably tightens the cap (P0 metadata-preserve makes the count real).
    expect(passedPref.maxParallelClones).toBe(1);
    expect(passedPref.maxParallelClones).not.toBe(DEFAULT_MAX_PARALLEL_CLONES);
  });

  it('falls back to the canonical default cap when no limits resolver is injected', async () => {
    const dispatchMessage = vi.fn(async () => {});
    cloneMocks.createExecutionClone.mockResolvedValue(createdResult());

    await dispatchSendMessage(brainCaller, {
      target: TEMPLATE,
      message: 'do the work',
      clone: { ...canonicalClone },
    }, {
      listSessions: () => baseSessions(),
      dispatchMessage,
    });

    const passedPref = cloneMocks.createExecutionClone.mock.calls[0][0].pref;
    expect(passedPref.maxParallelClones).toBe(DEFAULT_MAX_PARALLEL_CLONES);
  });
});
