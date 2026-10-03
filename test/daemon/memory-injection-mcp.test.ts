import { describe, expect, it, vi } from 'vitest';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const caller: McpRuntimeCaller = {
  userId: 'user-1',
  namespace: { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' },
  sessionName: 'deck_proj_brain',
  projectName: 'proj',
  projectRoot: '/tmp/proj',
  serverId: 'srv-1',
  providerId: 'codex-sdk',
  transport: 'in_process',
};

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_proj_brain',
    projectName: 'proj',
    role: 'brain',
    agentType: 'codex-sdk',
    projectDir: '/tmp/proj',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('memory_injection_get / memory_injection_set MCP tools', () => {
  it('reads the current toggle for the caller\'s own project namespace', async () => {
    const getMemoryInjectionEnabled = vi.fn(async () => false);
    const handlers = createMemoryMcpToolHandlers(caller, { getMemoryInjectionEnabled });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.MEMORY_INJECTION_GET]({}))
      .resolves.toEqual({ status: 'ok', enabled: false });
    expect(getMemoryInjectionEnabled).toHaveBeenCalledWith(caller.namespace);
  });

  it('lets the project Brain disable the toggle', async () => {
    const setMemoryInjectionEnabled = vi.fn(async () => undefined);
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => [session()] },
      setMemoryInjectionEnabled,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.MEMORY_INJECTION_SET]({ enabled: false }))
      .resolves.toEqual({ status: 'ok', enabled: false });
    expect(setMemoryInjectionEnabled).toHaveBeenCalledWith(caller.namespace, false);
  });

  it('rejects a non-brain caller trying to change the project-wide toggle', async () => {
    const setMemoryInjectionEnabled = vi.fn(async () => undefined);
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => [session({ role: 'w1' })] },
      setMemoryInjectionEnabled,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.MEMORY_INJECTION_SET]({ enabled: false }) as { status: string; reason: string };
    expect(result.status).toBe('error');
    expect(result.reason).toBe(MCP_ERROR_REASONS.SCOPE_FORBIDDEN);
    expect(setMemoryInjectionEnabled).not.toHaveBeenCalled();
  });

  it('requires an explicit enabled value', async () => {
    const setMemoryInjectionEnabled = vi.fn(async () => undefined);
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => [session()] },
      setMemoryInjectionEnabled,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.MEMORY_INJECTION_SET]({}) as { status: string; reason: string };
    expect(result.status).toBe('error');
    expect(result.reason).toBe(MCP_ERROR_REASONS.VALIDATION_FAILED);
    expect(setMemoryInjectionEnabled).not.toHaveBeenCalled();
  });
});
