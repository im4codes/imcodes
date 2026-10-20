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
const worker = session('deck_sub_alpha_worker', { parentSession: 'deck_alpha_brain' });
const nestedBrainRole = session('deck_sub_alpha_nested', { role: 'brain', parentSession: 'deck_alpha_brain' });

function handlersFor(caller: SessionRecord) {
  return createMemoryMcpToolHandlers(
    { userId: 'u', sessionName: caller.name, projectName: 'alpha', projectRoot: '/work/alpha' },
    { sendDeps: { listSessions: () => [brain, worker, nestedBrainRole], isSessionAuthoritativelyActive: async () => true } },
  );
}

describe('supervision_task_start never lets a project Brain assign itself task work', () => {
  beforeEach(() => resetSupervisionTaskRegistryForTests());
  afterEach(() => resetSupervisionTaskRegistryForTests());

  it.each([
    ['the default implementer role', {}],
    ['an explicit implementer role', { role: 'implementer' }],
    ['an auditor role', { role: 'auditor' }],
  ])('refuses %s for a top-level Brain before any task is created', async (_label, roleArgs) => {
    const result = await handlersFor(brain)[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
      ...roleArgs,
      classification: 'independent_top_level',
      objective: 'implement the retry queue',
      idempotencyKey: `self-${JSON.stringify(roleArgs)}`,
    });
    expect(result).toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    expect(String((result as { error?: string }).error ?? JSON.stringify(result))).toMatch(/non-self IM\.codes sub-session/);
    expect(getSupervisionTaskRegistry().list({})).toEqual([]);
  });

  it('still lets a Brain coordinate', async () => {
    const result = await handlersFor(brain)[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
      role: 'coordinator', classification: 'independent_top_level', objective: 'coordinate', idempotencyKey: 'coordinate',
    });
    expect(result).toMatchObject({ status: 'ok' });
  });

  it.each([
    ['a worker sub-session', worker],
    ['a brain-role nested sub-session', nestedBrainRole],
  ])('does not affect %s', async (_label, caller) => {
    const result = await handlersFor(caller)[MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]({
      role: 'implementer', objective: 'implement', scopeFiles: ['src/a.ts'], idempotencyKey: `worker-${caller.name}`,
    });
    expect(result).toMatchObject({ status: 'ok' });
  });
});
