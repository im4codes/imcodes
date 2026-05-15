import { describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import { MCP_FEATURE_FLAGS_BY_NAME } from '../../shared/memory-mcp-feature-flags.js';
import { MEMORY_FEATURE_FLAGS_BY_NAME, type MemoryFeatureFlag } from '../../shared/feature-flags.js';
import { MEMORY_MCP_DISABLED_FLAGS, MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';

function caller(overrides: Partial<McpRuntimeCaller> = {}): McpRuntimeCaller {
  const namespace: ContextNamespace = { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' };
  return {
    userId: 'user-1',
    namespace,
    sessionName: 'deck_proj_brain',
    projectName: 'proj',
    projectRoot: '/tmp/proj',
    serverId: 'srv-1',
    transport: 'in_process',
    ...overrides,
  };
}

describe('memory MCP tool schema firewall', () => {
  it('strips forged memory authority fields before search and write helpers', async () => {
    const searchMemory = vi.fn(() => []);
    const saveObservation = vi.fn(() => ({ status: 'ok', observationId: 'obs-1', fingerprint: 'fp', state: 'candidate' }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      searchMemory,
      saveObservation,
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({
      query: 'hello',
      limit: 3,
      userId: 'mallory',
      namespace: { scope: 'org_shared' },
      embedding: [1, 2, 3],
      vector: [4, 5, 6],
    });
    await handlers[MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION]({
      content: 'remember this',
      userId: 'mallory',
      namespace: { scope: 'org_shared' },
      fingerprint: 'forged',
      state: 'active',
      sourceSessionName: 'deck_sub_forged',
      sourceProjectName: 'other',
      sourceServerId: 'srv-forged',
    });

    expect(searchMemory).toHaveBeenCalledWith('hello', 3, expect.objectContaining({ userId: 'user-1' }));
    expect(saveObservation).toHaveBeenCalledWith({ content: 'remember this' }, expect.objectContaining({
      userId: 'user-1',
      sourceSessionName: 'deck_proj_brain',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-1',
    }));
  });

  it('short-circuits memory disabled gates before backend calls', async () => {
    const searchMemory = vi.fn(() => []);
    const savePreference = vi.fn(() => ({ status: 'ok' }));
    const enabled = (flag: MemoryFeatureFlag) => flag !== MEMORY_FEATURE_FLAGS_BY_NAME.quickSearch && flag !== MEMORY_FEATURE_FLAGS_BY_NAME.preferences;
    const handlers = createMemoryMcpToolHandlers(caller(), {
      searchMemory,
      savePreference,
      isMemoryFeatureEnabled: enabled,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'test' })).resolves.toMatchObject({
      status: 'disabled',
      disabledFlag: MEMORY_MCP_DISABLED_FLAGS.QUICK_SEARCH,
    });
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE]({ text: 'prefer this' })).toMatchObject({
      status: 'disabled',
      disabledFlag: MEMORY_MCP_DISABLED_FLAGS.PREFERENCES,
    });
    expect(searchMemory).not.toHaveBeenCalled();
    expect(savePreference).not.toHaveBeenCalled();
  });

  it('short-circuits optional MCP kill switches before send and cron backends', async () => {
    const listSessions = vi.fn(() => []);
    const cronList = vi.fn(async () => ({ status: 'ok', body: {}, limit: 10 }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      featureFlags: {
        [MCP_FEATURE_FLAGS_BY_NAME.sendDispatch]: false,
        [MCP_FEATURE_FLAGS_BY_NAME.cronRead]: false,
      },
      sendDeps: { listSessions },
      cronList,
      isMemoryFeatureEnabled: () => true,
    });

    expect(await handlers[MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]({})).toMatchObject({
      status: 'disabled',
      disabledFlag: MCP_FEATURE_FLAGS_BY_NAME.sendDispatch,
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({})).resolves.toMatchObject({
      status: 'disabled',
      disabledFlag: MCP_FEATURE_FLAGS_BY_NAME.cronRead,
    });
    expect(listSessions).not.toHaveBeenCalled();
    expect(cronList).not.toHaveBeenCalled();
  });

  it('does not forward forged cron identity fields to the cron client', async () => {
    const cronCreate = vi.fn(async () => ({ status: 'ok', body: { id: 'job-1' } }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      cronCreate,
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.CRON_CREATE]({
      name: 'daily',
      cronExpr: '0 9 * * *',
      action: { type: 'send', target: 'w1', message: 'go' },
      userId: 'mallory',
      serverId: 'srv-forged',
      token: 'secret',
      actorId: 'actor',
      sourceSessionName: 'deck_sub_forged',
    });

    expect(cronCreate).toHaveBeenCalledWith(expect.not.objectContaining({
      userId: expect.anything(),
      serverId: expect.anything(),
      token: expect.anything(),
      actorId: expect.anything(),
    }), expect.any(Object));
    expect(cronCreate.mock.calls[0][0]).toMatchObject({
      projectName: 'proj',
      sourceSessionName: 'deck_proj_brain',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-1',
    });
    expect(cronCreate.mock.calls[0][1]).toMatchObject({ runtimeServerId: 'srv-1' });
  });

  it('resolves cron project scope from the caller session store for sub-sessions', async () => {
    const cronCreate = vi.fn(async () => ({ status: 'ok', body: { id: 'job-1' } }));
    const handlers = createMemoryMcpToolHandlers(caller({
      sessionName: 'deck_sub_worker',
      projectName: 'deck_sub_worker',
      projectRoot: '/work/alpha',
    }), {
      cronCreate,
      sendDeps: {
        listSessions: () => [
          {
            name: 'deck_alpha_brain',
            projectName: 'alpha',
            projectDir: '/work/alpha',
            role: 'brain',
            agentType: 'codex',
            state: 'idle',
            restarts: 0,
            restartTimestamps: [],
            createdAt: 1,
            updatedAt: 1,
          } as never,
          {
            name: 'deck_sub_worker',
            projectName: 'deck_sub_worker',
            projectDir: '/work/alpha',
            parentSession: 'deck_alpha_brain',
            role: 'w1',
            agentType: 'codex',
            state: 'idle',
            restarts: 0,
            restartTimestamps: [],
            createdAt: 1,
            updatedAt: 1,
          } as never,
        ],
      },
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.CRON_CREATE]({
      name: 'daily',
      cronExpr: '0 9 * * *',
      action: { type: 'send', target: 'deck_alpha_w1', message: 'go' },
    });

    expect(cronCreate.mock.calls[0][0]).toMatchObject({
      projectName: 'alpha',
      sourceSessionName: 'deck_sub_worker',
      sourceProjectName: 'alpha',
    });
  });

  it('wraps unexpected tool exceptions as sanitized structured MCP errors', async () => {
    const handlers = createMemoryMcpToolHandlers(caller(), {
      savePreference: vi.fn(() => {
        throw new Error('failed with token=secret-token and https://example.test/api/server/srv-1/cron');
      }),
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE]({ text: 'prefer this' })).resolves.toMatchObject({
      status: 'error',
      reason: 'internal_error',
      message: 'failed with token=[redacted] and [redacted-url]',
    });
  });

  it('requires MCP send_message to use the exact target field rather than display labels', async () => {
    const dispatchMessage = vi.fn(async () => {});
    const handlers = createMemoryMcpToolHandlers(caller(), {
      sendDeps: {
        listSessions: () => [
          {
            name: 'deck_proj_brain',
            projectName: 'proj',
            projectDir: '/tmp/proj',
            role: 'brain',
            agentType: 'codex',
            state: 'idle',
            restarts: 0,
            restartTimestamps: [],
            createdAt: 1,
            updatedAt: 1,
          } as never,
          {
            name: 'deck_proj_w1',
            projectName: 'proj',
            projectDir: '/tmp/proj',
            role: 'w1',
            label: 'Friendly',
            agentType: 'codex',
            state: 'idle',
            restarts: 0,
            restartTimestamps: [],
            createdAt: 1,
            updatedAt: 1,
          } as never,
        ],
        dispatchMessage,
      },
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]({ target: 'Friendly', message: 'hello' })).resolves.toMatchObject({
      status: 'error',
      reason: 'validation_failed',
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]({ target: 'deck_proj_w1', message: 'hello' })).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps get_memory_sources available when quick search is disabled but the MCP memory surface is enabled', async () => {
    const getMemorySources = vi.fn(() => ({ projectionId: 'p1', sources: [] }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      getMemorySources,
      isMemoryFeatureEnabled: (flag) => flag !== MEMORY_FEATURE_FLAGS_BY_NAME.quickSearch,
    });

    expect(await handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({ projectionId: 'p1' })).toMatchObject({
      status: 'ok',
      projectionId: 'p1',
      sources: [],
    });
    expect(getMemorySources).toHaveBeenCalled();
  });

  it('rejects cron calls without runtime server identity or outside the caller project before the cron client', async () => {
    const cronList = vi.fn(async () => ({ status: 'ok', body: {}, limit: 10 }));
    const noServerHandlers = createMemoryMcpToolHandlers(caller({ serverId: null }), {
      cronList,
      isMemoryFeatureEnabled: () => true,
    });
    await expect(noServerHandlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({})).resolves.toMatchObject({
      status: 'error',
      reason: 'identity_rejected',
    });

    const scopedHandlers = createMemoryMcpToolHandlers(caller(), {
      cronList,
      isMemoryFeatureEnabled: () => true,
    });
    await expect(scopedHandlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({ projectName: 'other' })).resolves.toMatchObject({
      status: 'error',
      reason: 'scope_forbidden',
    });
    expect(cronList).not.toHaveBeenCalled();
  });

  it('does not accept legacy cron schedule wrappers or unused cursor arguments', async () => {
    const cronCreate = vi.fn(async () => ({ status: 'ok', body: { id: 'job-1' } }));
    const cronList = vi.fn(async () => ({ status: 'ok', body: {}, limit: 10 }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      cronCreate,
      cronList,
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.CRON_CREATE]({
      schedule: { name: 'wrapped', cronExpr: '0 9 * * *' },
      action: { type: 'send', target: 'w1', message: 'go' },
    });
    await handlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({ cursor: 'unused', limit: 5 });

    expect(cronCreate.mock.calls[0][0]).toMatchObject({ name: '', cronExpr: '' });
    expect(cronList.mock.calls[0][0]).toEqual({ projectName: 'proj', limit: 5 });
  });
});
