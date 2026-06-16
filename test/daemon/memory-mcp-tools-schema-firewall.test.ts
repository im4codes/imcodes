import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextNamespace } from '../../shared/context-types.js';
import { MCP_FEATURE_FLAGS_BY_NAME } from '../../shared/memory-mcp-feature-flags.js';
import { MEMORY_FEATURE_FLAGS_BY_NAME, type MemoryFeatureFlag } from '../../shared/feature-flags.js';
import { MEMORY_MCP_DISABLED_FLAGS, MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { MEMORY_MCP_DEGRADED_REASON } from '../../shared/memory-ws.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { resetMemoryShortRefsForTests } from '../../src/context/memory-short-ref.js';
import type { SessionRecord } from '../../src/store/session-store.js';

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

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
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

describe('memory MCP tool schema firewall', () => {
  beforeEach(() => {
    resetMemoryShortRefsForTests();
  });

  it('strips forged memory authority fields before search and write helpers', async () => {
    const searchMemory = vi.fn(async () => ({
      items: [],
    }));
    const listMemorySummaries = vi.fn(async () => ({
      items: [],
    }));
    const saveObservation = vi.fn(async () => ({ status: 'ok', observationId: 'obs-1', fingerprint: 'fp', state: 'candidate' }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      searchMemory,
      listMemorySummaries,
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
    await handlers[MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES]({
      limit: 2,
      projectionClass: 'recent_summary',
      projectOnly: false,
      userId: 'mallory',
      namespace: { scope: 'org_shared' },
      projectId: 'evil-project',
      query: 'must not be forwarded',
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

    expect(searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      query: 'hello',
      limit: 3,
      namespace: expect.objectContaining({ userId: 'user-1' }),
      includeLegacyPersonalOwner: true,
    }));
    expect(searchMemory.mock.calls[0][0]).not.toHaveProperty('userId', 'mallory');
    expect(searchMemory.mock.calls[0][0]).not.toHaveProperty('embedding');
    expect(searchMemory.mock.calls[0][0]).not.toHaveProperty('vector');
    expect(listMemorySummaries).toHaveBeenCalledWith(expect.objectContaining({
      limit: 2,
      projectionClass: 'recent_summary',
      namespace: expect.objectContaining({ userId: 'user-1' }),
      userId: 'user-1',
    }));
    expect(listMemorySummaries.mock.calls[0][0]).not.toHaveProperty('query');
    expect(listMemorySummaries.mock.calls[0][0]).not.toHaveProperty('projectOnly');
    expect(listMemorySummaries.mock.calls[0][0]).not.toHaveProperty('projectId', 'evil-project');
    expect(saveObservation).toHaveBeenCalledWith({ content: 'remember this' }, expect.objectContaining({
      userId: 'user-1',
      sourceSessionName: 'deck_proj_brain',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-1',
    }));
  });

  it('short-circuits memory disabled gates before backend calls', async () => {
    const searchMemory = vi.fn();
    const savePreference = vi.fn(async () => ({ status: 'ok' }));
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

  it('surfaces the first local degraded reason instead of hardcoding context-store unavailable', async () => {
    const searchMemory = vi.fn(async () => ({
      items: [],
      localUnavailable: true,
      degradedReasons: [MEMORY_MCP_DEGRADED_REASON.SEMANTIC_EMBEDDING_UNAVAILABLE],
    }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      searchMemory,
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'semantic recall' })).resolves.toMatchObject({
      status: 'ok',
      reason: MEMORY_MCP_DEGRADED_REASON.SEMANTIC_EMBEDDING_UNAVAILABLE,
      degradedReasons: [MEMORY_MCP_DEGRADED_REASON.SEMANTIC_EMBEDDING_UNAVAILABLE],
      items: [],
    });
  });

  it('recovers the project namespace from the stored session before searching memory', async () => {
    const searchMemory = vi.fn(async () => ({ items: [] }));
    const handlers = createMemoryMcpToolHandlers(caller({
      namespace: { scope: 'user_private', userId: 'user-1' },
      sessionName: 'deck_proj_brain',
    }), {
      searchMemory,
      isMemoryFeatureEnabled: () => true,
      sendDeps: {
        listSessions: () => [sessionRecord({
          contextNamespace: { scope: 'personal', userId: 'user-1', projectId: 'github.com/im4codes/imcodes' },
          contextNamespaceDiagnostics: ['namespace:git-origin'],
        })],
      },
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'recent task', limit: 5 });

    expect(searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'github.com/im4codes/imcodes',
      namespace: expect.objectContaining({
        scope: 'personal',
        userId: 'user-1',
        projectId: 'github.com/im4codes/imcodes',
      }),
    }));
  });

  it('derives a local project id from the project path when no namespace project id is available', async () => {
    const searchMemory = vi.fn(async () => ({ items: [] }));
    const handlers = createMemoryMcpToolHandlers(caller({
      namespace: { scope: 'user_private', userId: 'user-1' },
      sessionName: 'deck_proj_brain',
      projectRoot: null,
    }), {
      searchMemory,
      isMemoryFeatureEnabled: () => true,
      sendDeps: {
        listSessions: () => [sessionRecord({
          projectDir: '/workspace/example-project',
          contextNamespace: undefined,
        })],
      },
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'recent task', limit: 5 });

    const forwarded = searchMemory.mock.calls[0]?.[0];
    expect(forwarded?.repo).toMatch(/^local\/[0-9a-f]{12}$/);
    expect(forwarded?.namespace).toMatchObject({
      scope: 'personal',
      userId: 'user-1',
      projectId: forwarded?.repo,
    });
  });

  it('does not invoke memory search when runtime scope has no project id', async () => {
    const searchMemory = vi.fn(async () => ({ items: [{ projectionId: 'p1', projectId: 'other', summary: 'hidden' }] }));
    const handlers = createMemoryMcpToolHandlers(caller({
      namespace: { scope: 'user_private', userId: 'user-1' },
      sessionName: null,
      projectName: null,
      projectRoot: null,
    }), {
      searchMemory,
      isMemoryFeatureEnabled: () => true,
      sendDeps: { listSessions: () => [] },
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'recent task', limit: 5 })).resolves.toEqual({
      status: 'ok',
      reason: 'project_scope_unavailable',
      items: [],
    });
    expect(searchMemory).not.toHaveBeenCalled();
  });

  it('does not invoke memory summary listing when runtime scope has no project id', async () => {
    const listMemorySummaries = vi.fn(async () => ({ items: [{ projectionId: 'p1', projectId: 'other', summary: 'hidden' }] }));
    const handlers = createMemoryMcpToolHandlers(caller({
      namespace: { scope: 'user_private', userId: 'user-1' },
      sessionName: null,
      projectName: null,
      projectRoot: null,
    }), {
      listMemorySummaries,
      isMemoryFeatureEnabled: () => true,
      sendDeps: { listSessions: () => [] },
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES]({ limit: 5 })).resolves.toEqual({
      status: 'ok',
      reason: 'project_scope_unavailable',
      items: [],
    });
    expect(listMemorySummaries).not.toHaveBeenCalled();
  });

  it('returns compact hits from the same recall search used by message memory recall', async () => {
    const projectionId = '1111111111222222222233333333334444444444555555555566666666667777';
    const searchMemory = vi.fn(async () => ({
      items: [
        {
          projectionId,
          recordKind: 'projection',
          projectId: 'repo-1',
          scope: 'user_private',
          projectionClass: 'recent_summary',
          matchKind: 'exact',
          summary: 'MCP provider readiness fixed for Gemini, Copilot, and Qwen.',
          createdAt: 100,
          updatedAt: 200,
          relevanceScore: 0.9,
          source: 'cloud',
        },
      ],
    }));
    const orchestrator = vi.fn(async (id: string) => ({
      status: 'ok' as const,
      projectionId: id,
      sourceEventCount: 1,
      sources: [{ eventId: 'evt-1', status: 'archived', content: 'expanded source' }],
    }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      searchMemory,
      getMemorySourcesOrchestrator: orchestrator,
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'provider readiness', limit: 5 })).resolves.toMatchObject({
      status: 'ok',
      items: [
        {
          projectionId,
          ref: 'proj:1111111111',
          recordKind: 'projection',
          sourceLookup: { tool: 'get_memory_sources', kind: 'projection', projectionId },
          summary: 'MCP provider readiness fixed for Gemini, Copilot, and Qwen.',
          projectionClass: 'recent_summary',
          matchKind: 'exact',
          projectId: 'repo-1',
          scope: 'user_private',
          createdAt: 100,
          updatedAt: 200,
          relevanceScore: 0.9,
          source: 'cloud',
        },
      ],
    });
    expect(searchMemory).toHaveBeenCalledWith(expect.objectContaining({
      query: 'provider readiness',
      namespace: expect.objectContaining({ scope: 'personal', userId: 'user-1', projectId: 'repo-1' }),
      repo: 'repo-1',
      limit: 5,
    }));
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({
      ref: 'proj:1111111111',
      kind: 'projection',
    })).resolves.toMatchObject({
      status: 'ok',
      projectionId,
      sourceEventCount: 1,
    });
    expect(orchestrator).toHaveBeenCalledWith(projectionId, expect.any(Object));
  });

  it('returns observation sourceLookup objects and expands them without the projection orchestrator', async () => {
    const observationId = 'aaaaaaaaaabbbbbbbbbbccccccccccddddddddddeeeeeeeeeeffffffff00000000';
    const searchMemory = vi.fn(async () => ({
      items: [
        {
          recordKind: 'observation' as const,
          projectionId: observationId,
          observationId,
          projectId: 'repo-1',
          scope: 'user_private',
          observationClass: 'note',
          observationState: 'candidate',
          matchKind: 'exact' as const,
          summary: 'Saved observation about alpha.test.im.codes.',
          createdAt: 100,
          updatedAt: 200,
          source: 'local' as const,
        },
      ],
    }));
    const orchestrator = vi.fn();
    const handlers = createMemoryMcpToolHandlers(caller({
      userId: 'daemon-local',
      namespace: { scope: 'user_private', userId: 'daemon-local', projectId: 'repo-1' },
    }), {
      searchMemory,
      getMemorySourcesOrchestrator: orchestrator,
      isMemoryFeatureEnabled: () => true,
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]({ query: 'alpha.test.im.codes' })).resolves.toMatchObject({
      status: 'ok',
      items: [
        {
          observationId,
          ref: 'obs:aaaaaaaaaa',
          recordKind: 'observation',
          sourceLookup: { tool: 'get_memory_sources', kind: 'observation', observationId },
          observationClass: 'note',
          observationState: 'candidate',
          matchKind: 'exact',
        },
      ],
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({
      observationId,
      kind: 'observation',
      serverId: 'attacker-srv',
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({
      ref: 'obs:aaaaaaaaaa',
      kind: 'observation',
    })).resolves.toMatchObject({
      status: 'ok',
      observationId,
      sourceEventCount: 0,
      sources: [],
    });
    expect(orchestrator).not.toHaveBeenCalled();
  });

  it('does not treat local send and cron MCP feature flags as auth gates', async () => {
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
      status: 'ok',
      items: [],
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({})).resolves.toMatchObject({
      status: 'ok',
      limit: 10,
    });
    expect(listSessions).toHaveBeenCalled();
    expect(cronList).toHaveBeenCalled();
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
      savePreference: vi.fn(async () => {
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

  it('strips forged serverId from get_memory_sources input — orchestrator never sees it', async () => {
    // Regression for memory-source-server-routing: serverId is in the
    // forbidden args list precisely so callers cannot influence routing by
    // forging an identity field. The orchestrator resolves originServerId
    // itself (cache or cloud), never from input. This test injects a
    // forged `serverId: 'attacker-srv'` and asserts the orchestrator was
    // called WITHOUT it (and projectionId was preserved).
    const orchestrator = vi.fn(async (projectionId: string) => ({
      status: 'ok' as const,
      projectionId,
      sourceEventCount: 0,
      sources: [],
    }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      getMemorySourcesOrchestrator: orchestrator,
      isMemoryFeatureEnabled: () => true,
    });

    await handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({
      projectionId: 'proj-1',
      serverId: 'attacker-srv',
      // throw the kitchen sink at it
      userId: 'mallory',
      namespace: { scope: 'org_shared' },
      sourceServerId: 'attacker-srv-2',
    });

    // The orchestrator wraps two positional args: (projectionId, caller).
    // Both must be free of attacker-controlled routing fields.
    expect(orchestrator).toHaveBeenCalledOnce();
    const [passedProjectionId, passedCaller] = orchestrator.mock.calls[0];
    expect(passedProjectionId).toBe('proj-1');
    expect(passedCaller.userId).toBe('user-1');
    // Caller is built from runtime, not args — verify no smuggled fields.
    expect((passedCaller as unknown as Record<string, unknown>).serverId).not.toBe('attacker-srv');
  });

  it('does not expand memory sources when runtime scope has no project id', async () => {
    const orchestrator = vi.fn(async () => ({
      status: 'ok' as const,
      projectionId: 'proj-1',
      sourceEventCount: 1,
      sources: [{ eventId: 'evt-1', status: 'archived', content: 'hidden source' }],
    }));
    const handlers = createMemoryMcpToolHandlers(caller({
      namespace: { scope: 'user_private', userId: 'user-1' },
      sessionName: null,
      projectName: null,
      projectRoot: null,
    }), {
      getMemorySourcesOrchestrator: orchestrator,
      isMemoryFeatureEnabled: () => true,
      sendDeps: { listSessions: () => [] },
    });

    await expect(handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({ projectionId: 'proj-1' })).resolves.toEqual({
      status: 'ok',
      reason: 'project_scope_unavailable',
      projectionId: 'proj-1',
      sourceEventCount: 0,
      sources: [],
    });
    expect(orchestrator).not.toHaveBeenCalled();
  });

  it('keeps get_memory_sources available when quick search is disabled but the MCP memory surface is enabled', async () => {
    // Production path: get_memory_sources flows through the orchestrator,
    // which resolves originServerId from cache/cloud and then dispatches to
    // the local SQLite or the pod-sticky remote. We bypass that machinery
    // here by injecting a stub orchestrator so the test stays focused on
    // the disabled-flag semantics.
    const orchestrator = vi.fn(async () => ({
      status: 'ok' as const,
      projectionId: 'p1',
      sourceEventCount: 0,
      sources: [],
    }));
    const handlers = createMemoryMcpToolHandlers(caller(), {
      getMemorySourcesOrchestrator: orchestrator,
      isMemoryFeatureEnabled: (flag) => flag !== MEMORY_FEATURE_FLAGS_BY_NAME.quickSearch,
    });

    expect(await handlers[MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]({ projectionId: 'p1' })).toMatchObject({
      status: 'ok',
      projectionId: 'p1',
      sources: [],
    });
    expect(orchestrator).toHaveBeenCalled();
  });

  it('allows cron calls without runtime server identity but rejects outside the caller project before the cron client', async () => {
    const cronList = vi.fn(async () => ({ status: 'ok', body: {}, limit: 10 }));
    const noServerHandlers = createMemoryMcpToolHandlers(caller({ serverId: null }), {
      cronList,
      isMemoryFeatureEnabled: () => true,
    });
    await expect(noServerHandlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({})).resolves.toMatchObject({
      status: 'ok',
      limit: 10,
    });

    const scopedHandlers = createMemoryMcpToolHandlers(caller(), {
      cronList,
      isMemoryFeatureEnabled: () => true,
    });
    await expect(scopedHandlers[MEMORY_MCP_TOOL_NAMES.CRON_LIST]({ projectName: 'other' })).resolves.toMatchObject({
      status: 'error',
      reason: 'scope_forbidden',
    });
    expect(cronList).toHaveBeenCalledTimes(1);
    expect(cronList.mock.calls[0][1]).not.toHaveProperty('runtimeServerId');
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
