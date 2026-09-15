import { describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE } from '../../shared/mcp-tool-discovery.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const caller: McpRuntimeCaller = {
  userId: 'user-1',
  namespace: { scope: 'user_private', userId: 'user-1', projectId: 'project-1' },
  sessionName: 'deck_project_brain',
  projectName: 'project',
  projectRoot: '/tmp/project',
  serverId: 'server-1',
  providerId: 'codex-sdk',
  transport: 'in_process',
};

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_project_brain',
    projectName: 'project',
    role: 'brain',
    agentType: 'codex-sdk',
    projectDir: '/tmp/project',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('session_restart MCP tool', () => {
  it('is present in the initial non-lazy MCP catalog', () => {
    expect(MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE).toContain(MEMORY_MCP_TOOL_NAMES.SESSION_RESTART);
  });

  it('defaults to a continuity-preserving restart of the exact existing session', async () => {
    const self = session();
    const restartSession = vi.fn(async () => true);
    const handler = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => [self] },
      restartSession,
    })[MEMORY_MCP_TOOL_NAMES.SESSION_RESTART];

    await expect(handler({ target: self.name })).resolves.toEqual({
      status: 'ok', target: self.name, reset: false, scheduled: true,
    });
    expect(restartSession).toHaveBeenCalledWith(self, { reset: false });
  });

  it('maps reset=true to start-over while retaining the exact session identity', async () => {
    const self = session();
    const child = session({ name: 'deck_sub_worker', role: 'w1', parentSession: self.name, state: 'stopped' });
    const restartSession = vi.fn(async () => true);
    const handler = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => [self, child] },
      restartSession,
    })[MEMORY_MCP_TOOL_NAMES.SESSION_RESTART];

    await expect(handler({ target: child.name, reset: true })).resolves.toEqual({
      status: 'ok', target: child.name, reset: true, scheduled: true,
    });
    expect(restartSession).toHaveBeenCalledWith(child, { reset: true });
  });

  it('rejects labels, missing targets, and cross-project sessions without invoking restart', async () => {
    const self = session();
    const peer = session({ name: 'deck_project_worker', role: 'w1', label: 'Worker' });
    const foreign = session({ name: 'deck_other_brain', projectName: 'other', projectDir: '/tmp/other' });
    const restartSession = vi.fn(async () => true);
    const handler = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => [self, peer, foreign] },
      restartSession,
    })[MEMORY_MCP_TOOL_NAMES.SESSION_RESTART];

    await expect(handler({ target: 'Worker' })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    await expect(handler({ target: foreign.name })).resolves.toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    await expect(handler({ target: '*' })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    expect(restartSession).not.toHaveBeenCalled();
  });

  it('reports transient restart-control loss as explicit recoverable failure without emulation', async () => {
    const self = session();
    const restartSession = vi.fn(async () => {
      throw new Error('daemon session restart control is unavailable');
    });
    const handler = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => [self] },
      restartSession,
    })[MEMORY_MCP_TOOL_NAMES.SESSION_RESTART];

    await expect(handler({ target: self.name, reset: false })).resolves.toMatchObject({
      status: 'error',
      reason: 'control_plane_unavailable',
      recoverable: true,
    });
    expect(restartSession).toHaveBeenCalledTimes(1);
  });
});
