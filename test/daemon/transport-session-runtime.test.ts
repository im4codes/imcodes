import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TransportSessionRuntime, type PendingTransportMessage } from '../../src/agent/transport-session-runtime.js';
import { RUNTIME_TYPES } from '../../src/agent/session-runtime.js';
import type { TransportProvider, ProviderError, SessionConfig } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { MemorySearchResult, MemorySearchResultItem } from '../../src/context/memory-search.js';
import { PREFERENCE_CONTEXT_END, PREFERENCE_CONTEXT_START } from '../../shared/preference-ingest.js';
import { SESSION_CONTROL_METADATA_COMMAND_FIELD } from '../../shared/session-control-commands.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';

const timelineEmitterEmitMock = vi.hoisted(() => vi.fn());
const searchLocalMemoryMock = vi.hoisted(() => vi.fn());
const searchLocalMemorySemanticMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: timelineEmitterEmitMock,
  },
}));

vi.mock('../../src/context/memory-search.js', () => ({
  searchLocalMemory: searchLocalMemoryMock,
  searchLocalMemorySemantic: searchLocalMemorySemanticMock,
}));

// ── Mock provider factory ──────────────────────────────────────────────────────

function makeMockProvider() {
  let deltaCb: ((sid: string, d: MessageDelta) => void) | null = null;
  let completeCb: ((sid: string, m: AgentMessage) => void) | null = null;
  let errorCb: ((sid: string, e: ProviderError) => void) | null = null;
  let approvalCb: ((sid: string, req: { id: string; description: string; tool?: string }) => void) | null = null;

  const fireDelta = (sid: string) =>
    deltaCb?.(sid, { messageId: 'msg', type: 'text', delta: 'x', role: 'assistant' });
  const fireComplete = (sid: string, overrides: Partial<AgentMessage> = {}) =>
    completeCb?.(sid, {
      id: 'msg-1',
      sessionId: sid,
      kind: 'text',
      role: 'assistant',
      content: 'done',
      timestamp: Date.now(),
      status: 'complete',
      ...overrides,
    } as AgentMessage);
  const fireError = (sid: string, err?: ProviderError) =>
    errorCb?.(sid, err ?? { code: 'PROVIDER_ERROR', message: 'err', recoverable: false });
  const fireApproval = (sid: string, req: { id: string; description: string; tool?: string }) =>
    approvalCb?.(sid, req);

  return {
    provider: {
      id: 'mock', connectionMode: 'persistent', sessionOwnership: 'provider',
      capabilities: { streaming: true, toolCalling: false, approval: false, sessionRestore: false, multiTurn: true, attachments: false, contextSupport: 'full-normalized-context-injection' },
      connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), cancel: vi.fn(),
      createSession: vi.fn().mockResolvedValue('sess-1'), endSession: vi.fn(),
      onDelta: (cb: (sid: string, d: MessageDelta) => void) => { deltaCb = cb; return () => { deltaCb = null; }; },
      onComplete: (cb: (sid: string, m: AgentMessage) => void) => { completeCb = cb; return () => { completeCb = null; }; },
      onError: (cb: (sid: string, e: ProviderError) => void) => { errorCb = cb; return () => { errorCb = null; }; },
      onApprovalRequest: (cb: (sid: string, req: { id: string; description: string; tool?: string }) => void) => { approvalCb = cb; },
      respondApproval: vi.fn().mockResolvedValue(undefined),
    } as unknown as TransportProvider,
    fireDelta, fireComplete, fireError, fireApproval,
  };
}

function makeSearchItem(overrides: Partial<MemorySearchResultItem> = {}): MemorySearchResultItem {
  return {
    type: 'processed',
    id: `mem-${Math.random().toString(16).slice(2, 8)}`,
    projectId: 'my-project',
    scope: 'personal',
    summary: 'Fixed a race condition in the WebSocket reconnect logic',
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now() - 1_000,
    ...overrides,
  };
}

function makeSearchResult(items: MemorySearchResultItem[]): MemorySearchResult {
  return {
    items,
    stats: {
      totalRecords: items.length,
      matchedRecords: items.length,
      recentSummaryCount: items.filter((i) => i.projectionClass === 'recent_summary').length,
      durableCandidateCount: items.filter((i) => i.projectionClass === 'durable_memory_candidate').length,
      projectCount: new Set(items.map((i) => i.projectId)).size,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
      pendingJobCount: 0,
    },
  };
}

const defaultConfig: SessionConfig = { sessionKey: 'deck_test_brain' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flushDispatch = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TransportSessionRuntime', () => {
  let mock: ReturnType<typeof makeMockProvider>;
  let runtime: TransportSessionRuntime;

  beforeEach(async () => {
    timelineEmitterEmitMock.mockReset();
    searchLocalMemoryMock.mockReset();
    searchLocalMemorySemanticMock.mockReset();
    setContextModelRuntimeConfig(null);
    mock = makeMockProvider();
    runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
    await runtime.initialize(defaultConfig);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('type is transport', () => {
    expect(runtime.type).toBe(RUNTIME_TYPES.TRANSPORT);
  });

  it('initialize() calls provider.createSession', async () => {
    expect(runtime.providerSessionId).toBe('sess-1');
    expect(mock.provider.createSession).toHaveBeenCalledWith(defaultConfig);
  });

  it('send() throws if not initialized', () => {
    const fresh = new TransportSessionRuntime(mock.provider, 'x');
    expect(() => fresh.send('hi')).toThrow(/not initialized/i);
  });

  it('send() returns "sent" when idle', async () => {
    expect(runtime.send('hi')).toBe('sent');
    await flushDispatch();
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: 'hi',
      assembledMessage: 'hi',
      systemText: expect.stringContaining('Use memory MCP search'),
    }));
  });

  it('send() returns "queued" when busy', async () => {
    runtime.send('first');
    await flushDispatch();
    expect(runtime.send('second', 'msg-queued-2')).toBe('queued');
    expect(runtime.pendingCount).toBe(1);
    expect(runtime.pendingMessages).toEqual(['second']);
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-queued-2', text: 'second' },
    ]);
    // provider.send called only once (for first message)
    expect(mock.provider.send).toHaveBeenCalledTimes(1);
  });

  it('injects stable preference context only once per provider conversation', async () => {
    const preferencePreamble = `${PREFERENCE_CONTEXT_START}\n- Use pnpm\n${PREFERENCE_CONTEXT_END}`;

    runtime.send('first preference-aware turn', 'pref-once-1', undefined, preferencePreamble);
    await flushDispatch();
    mock.fireComplete('sess-1');
    await flushDispatch();

    runtime.send('second preference-aware turn', 'pref-once-2', undefined, preferencePreamble);
    await flushDispatch();

    const firstPayload = mock.provider.send.mock.calls[0]?.[1] as Record<string, unknown>;
    const secondPayload = mock.provider.send.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(firstPayload.messagePreamble).toContain('Use pnpm');
    expect(String(firstPayload.assembledMessage)).toContain('Use pnpm');
    expect(secondPayload.messagePreamble).toBeUndefined();
    expect(secondPayload.assembledMessage).toBe('second preference-aware turn');
  });

  it('does not attach preference context to control messages and re-injects it after compaction', async () => {
    const preferencePreamble = `${PREFERENCE_CONTEXT_START}\n- Use pnpm\n${PREFERENCE_CONTEXT_END}`;

    runtime.send('first preference-aware turn', 'pref-compact-1', undefined, preferencePreamble);
    await flushDispatch();
    mock.fireComplete('sess-1');
    await flushDispatch();

    runtime.send('/compact', 'pref-compact-control', undefined, preferencePreamble);
    await flushDispatch();
    const compactPayload = mock.provider.send.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(compactPayload.userMessage).toBe('/compact');
    expect(compactPayload.messagePreamble).toBeUndefined();
    expect(compactPayload.assembledMessage).toBe('/compact');

    mock.fireComplete('sess-1', {
      kind: 'system',
      role: 'system',
      content: 'Codex context compacted.',
      metadata: { provider: 'codex-sdk', [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact' },
    });
    await flushDispatch();

    runtime.send('after compact', 'pref-compact-2', undefined, preferencePreamble);
    await flushDispatch();
    const afterCompactPayload = mock.provider.send.mock.calls[2]?.[1] as Record<string, unknown>;
    expect(afterCompactPayload.messagePreamble).toContain('Use pnpm');
    expect(String(afterCompactPayload.assembledMessage)).toContain('Use pnpm');
  });

  it('rejects /compact before dispatch when provider compact capability is unsupported', () => {
    (mock.provider.capabilities as Record<string, unknown>).compact = {
      execution: 'unsupported',
      verified: false,
      completion: 'none',
      cancellation: 'none',
      reason: 'mock provider does not support compact',
    };

    expect(() => runtime.send('/compact')).toThrow('mock provider does not support compact');
    expect(mock.provider.send).not.toHaveBeenCalled();
  });

  it('keeps slash controls raw for every transport by suppressing startup, recall, authored, and preference context', async () => {
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
      startupMemory: {
        reason: 'startup',
        runtimeFamily: 'transport',
        authoritySource: 'processed_local',
        sourceKind: 'local_processed',
        injectionSurface: 'normalized-payload',
        items: [makeSearchItem({ id: 'startup-memory', summary: 'Startup memory must not ride with slash controls' })],
        injectedText: 'Historical context that must not be attached to /compact',
      } as any,
    }));
    await r.initialize({
      ...defaultConfig,
      description: 'Session description must not be attached to /compact',
      systemPrompt: 'Runtime system prompt must not be attached to /compact',
      contextNamespace: { scope: 'personal', projectId: 'repo-1' },
      contextLocalProcessedFreshness: 'fresh',
    });
    timelineEmitterEmitMock.mockClear();
    searchLocalMemorySemanticMock.mockClear();

    const preferencePreamble = `${PREFERENCE_CONTEXT_START}\n- Prefer pnpm\n${PREFERENCE_CONTEXT_END}`;
    r.send('/compact', 'raw-compact-control', undefined, preferencePreamble);
    await flushDispatch();

    expect(searchLocalMemorySemanticMock).not.toHaveBeenCalled();
    const compactPayload = localMock.provider.send.mock.calls[0]?.[1] as Record<string, any>;
    expect(compactPayload.userMessage).toBe('/compact');
    expect(compactPayload.assembledMessage).toBe('/compact');
    expect(compactPayload.systemText).toBeUndefined();
    expect(compactPayload.messagePreamble).toBeUndefined();
    expect(compactPayload.startupMemory).toBeUndefined();
    expect(compactPayload.memoryRecall).toBeUndefined();
    expect(compactPayload.context?.systemText).toBeUndefined();
    expect(compactPayload.context?.messagePreamble).toBeUndefined();
    expect(compactPayload.context?.requiredAuthoredContext).toEqual([]);
    expect(compactPayload.context?.advisoryAuthoredContext).toEqual([]);
  });

  it('keeps queued preference context in messagePreamble without changing user-visible text', async () => {
    runtime.send('first');
    await flushDispatch();
    const preferencePreamble = `${PREFERENCE_CONTEXT_START}\n- Use pnpm\n${PREFERENCE_CONTEXT_END}`;
    expect(runtime.send('second', 'msg-queued-2', undefined, preferencePreamble)).toBe('queued');

    expect(runtime.pendingMessages).toEqual(['second']);
    expect(runtime.pendingEntries).toEqual([
      {
        clientMessageId: 'msg-queued-2',
        text: 'second',
        messagePreamble: preferencePreamble,
      },
    ]);

    mock.fireComplete('sess-1');
    await flushDispatch();

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'second',
      assembledMessage: expect.stringContaining('Use pnpm'),
      messagePreamble: expect.stringContaining('Use pnpm'),
    }));
  });

  it('tracks the active dispatch payload for restart-based replay', async () => {
    runtime.send('retry me', 'msg-retry');
    await flushDispatch();

    expect(runtime.activeDispatchEntries).toEqual([
      { clientMessageId: 'msg-retry', text: 'retry me' },
    ]);

    mock.fireError('sess-1');
    expect(runtime.activeDispatchEntries).toEqual([
      { clientMessageId: 'msg-retry', text: 'retry me' },
    ]);
  });

  it('send() merges description and runtime prompt into normalized systemText', async () => {
    const r = new TransportSessionRuntime(mock.provider, 'x');
    await r.initialize({ ...defaultConfig, description: 'expert', systemPrompt: 'runtime only' });
    r.send('help');
    await flushDispatch();
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: 'help',
      assembledMessage: 'help',
      systemText: expect.stringContaining('expert\n\nruntime only'),
    }));
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      systemText: expect.stringContaining('Use memory MCP search'),
    }));
  });

  it('send() uses the resolved context namespace from session config instead of hardcoded sessionKey namespace', async () => {
    const r = new TransportSessionRuntime(mock.provider, 'x');
    await r.initialize({
      ...defaultConfig,
      cwd: '/tmp/project',
      contextNamespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      contextNamespaceDiagnostics: ['namespace:explicit'],
    });

    r.send('help');
    await flushDispatch();

    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      authority: expect.objectContaining({
        namespace: {
          scope: 'personal',
          projectId: 'github.com/acme/repo',
        },
      }),
      diagnostics: expect.arrayContaining(['namespace:explicit']),
    }));
  });

  it('send() uses bootstrap-provided local processed freshness for personal continuity authority', async () => {
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'x');
    await r.initialize({
      ...defaultConfig,
      contextNamespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      contextLocalProcessedFreshness: 'fresh',
    });

    r.send('help');
    await flushDispatch();
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      authority: expect.objectContaining({
        authoritySource: 'processed_local',
        freshness: 'fresh',
      }),
      diagnostics: expect.arrayContaining(['authority:processed_local']),
    }));
  });

  it('shared-scope sends fail before provider dispatch when no authoritative shared context exists', async () => {
    const r = new TransportSessionRuntime(mock.provider, 'x');
    await r.initialize({
      ...defaultConfig,
      contextNamespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
      },
    });

    r.send('help');
    await flushDispatch();

    expect(mock.provider.send).not.toHaveBeenCalled();
    expect(r.getStatus()).toBe('error');
  });


  it('surfaces refreshed context bootstrap metadata through onSessionInfoChange for live inspection', async () => {
    const infoUpdates: Array<Record<string, unknown>> = [];
    const r = new TransportSessionRuntime(mock.provider, 'x');
    r.onSessionInfoChange = (info) => { infoUpdates.push(info as Record<string, unknown>); };
    await r.initialize({
      ...defaultConfig,
      contextNamespace: {
        scope: 'personal',
        projectId: 'launch-snapshot',
      },
      contextNamespaceDiagnostics: ['namespace:launch'],
      contextLocalProcessedFreshness: 'stale',
    });
    r.setContextBootstrapResolver(async () => ({
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
      },
      diagnostics: ['namespace:server-control-plane'],
      remoteProcessedFreshness: 'fresh',
      localProcessedFreshness: 'fresh',
      retryExhausted: true,
      sharedPolicyOverride: { allowDegraded: false, allowLocalFallback: true },
    }));

    r.send('refresh bootstrap metadata please');
    await flushDispatch();

    expect(infoUpdates.at(0)).toMatchObject({
      contextNamespace: { scope: 'personal', projectId: 'launch-snapshot' },
      contextNamespaceDiagnostics: ['namespace:launch'],
      contextLocalProcessedFreshness: 'stale',
      contextRetryExhausted: false,
    });
    expect(infoUpdates.at(-1)).toMatchObject({
      contextNamespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
      },
      contextNamespaceDiagnostics: ['namespace:server-control-plane'],
      contextRemoteProcessedFreshness: 'fresh',
      contextLocalProcessedFreshness: 'fresh',
      contextRetryExhausted: true,
      contextSharedPolicyOverride: { allowDegraded: false, allowLocalFallback: true },
    });
  });

  it('forwards approval requests through runtime callbacks', async () => {
    const approvalMock = makeMockProvider();
    const runtimeWithApproval = new TransportSessionRuntime(approvalMock.provider, 'deck_test_brain');
    const approvalEvents: Array<Record<string, unknown>> = [];
    runtimeWithApproval.onApprovalRequest = (request) => approvalEvents.push(request as Record<string, unknown>);
    await runtimeWithApproval.initialize(defaultConfig);

    approvalMock.fireApproval('sess-1', {
      id: 'approval-1',
      description: 'Allow file write',
      tool: 'shell',
    });

    expect(approvalEvents).toEqual([
      { id: 'approval-1', description: 'Allow file write', tool: 'shell' },
    ]);
  });

  it('forwards approval responses to the provider', async () => {
    const approvalMock = makeMockProvider();
    const runtimeWithApproval = new TransportSessionRuntime(approvalMock.provider, 'deck_test_brain');
    await runtimeWithApproval.initialize(defaultConfig);

    await runtimeWithApproval.respondApproval('approval-2', true);

    expect((approvalMock.provider as any).respondApproval).toHaveBeenCalledWith('sess-1', 'approval-2', true);
  });

  it('refreshes shared-context bootstrap on each dispatch turn instead of freezing launch-time namespace state', async () => {
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'x');
    const refreshBootstrap = vi.fn()
      .mockResolvedValueOnce({
        namespace: {
          scope: 'project_shared',
          projectId: 'github.com/acme/repo',
          enterpriseId: 'ent-1',
        },
        diagnostics: ['namespace:server-control-plane'],
        remoteProcessedFreshness: 'fresh',
      })
      .mockResolvedValueOnce({
        namespace: {
          scope: 'personal',
          projectId: 'github.com/acme/repo',
        },
        diagnostics: ['namespace:server-personal-fallback'],
        localProcessedFreshness: 'fresh',
      });
    await r.initialize({
      ...defaultConfig,
      contextNamespace: {
        scope: 'personal',
        projectId: 'launch-snapshot',
      },
      contextNamespaceDiagnostics: ['namespace:launch'],
    });
    r.setContextBootstrapResolver(refreshBootstrap);

    r.send('first');
    await flushDispatch();
    await flushDispatch();
    expect(localMock.provider.send).toHaveBeenNthCalledWith(1, 'sess-1', expect.objectContaining({
      authority: expect.objectContaining({
        namespace: {
          scope: 'project_shared',
          projectId: 'github.com/acme/repo',
          enterpriseId: 'ent-1',
        },
        authoritySource: 'processed_remote',
      }),
      diagnostics: expect.arrayContaining(['namespace:server-control-plane']),
    }));

    localMock.fireComplete('sess-1');
    r.send('second');
    await flushDispatch();
    await flushDispatch();
    expect(localMock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      authority: expect.objectContaining({
        namespace: {
          scope: 'personal',
          projectId: 'github.com/acme/repo',
        },
        authoritySource: 'processed_local',
      }),
      diagnostics: expect.arrayContaining(['namespace:server-personal-fallback']),
    }));
    expect(refreshBootstrap).toHaveBeenCalledTimes(2);
  });

  it('skips startup memory injection when startupMemoryAlreadyInjected is true (session.restart / restore)', async () => {
    // Regression: restarting an existing session (or daemon restart that
    // restores persisted sessions) must NOT replay "related past work" into
    // the provider context. The conversation already has that preamble; a
    // second injection would pollute history with duplicate context.
    const startupItem = makeSearchItem({
      projectId: 'repo-1',
      summary: 'Should not be re-injected on restart',
    });
    const startupMemory = {
      reason: 'startup' as const,
      runtimeFamily: 'transport' as const,
      authoritySource: 'processed_local' as const,
      sourceKind: 'local_processed' as const,
      injectionSurface: 'message-preamble' as const,
      injectedText: '# Recent project memory\n\n- Should not be re-injected on restart',
      items: [startupItem],
    };
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
      startupMemory,
    }));

    // Simulate the restore path where the prior run already injected startup
    // memory and we persisted startupMemoryInjected=true to SessionRecord.
    await r.initialize({ ...defaultConfig, startupMemoryAlreadyInjected: true });

    // No memory.context timeline card — the UI must not re-show the startup
    // banner for a resumed conversation.
    expect(timelineEmitterEmitMock).not.toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({ reason: 'startup' }),
      expect.any(Object),
    );

    timelineEmitterEmitMock.mockClear();
    r.send('Follow-up message after restart');
    await flushDispatch();

    // The provider payload on the first post-restart turn must NOT contain
    // any `startupMemory` field — the runtime keeps `_startupMemory = null`.
    expect(localMock.provider.send).toHaveBeenCalledTimes(1);
    const call = localMock.provider.send.mock.calls[0];
    expect(call[1]).not.toHaveProperty('startupMemory');
  });

  it('fires onStartupMemoryInjected exactly once when startup memory first reaches the provider', async () => {
    const startupItem = makeSearchItem({
      projectId: 'repo-1',
      summary: 'Persist that we injected startup memory',
    });
    const startupMemory = {
      reason: 'startup' as const,
      runtimeFamily: 'transport' as const,
      authoritySource: 'processed_local' as const,
      sourceKind: 'local_processed' as const,
      injectionSurface: 'message-preamble' as const,
      injectedText: '# Recent project memory\n\n- Persist that we injected startup memory',
      items: [startupItem],
    };
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
      startupMemory,
    }));

    const onInjected = vi.fn();
    r.onStartupMemoryInjected = onInjected;

    await r.initialize(defaultConfig);
    await flushDispatch();

    // Callback fires only after the first turn that actually carried it.
    expect(onInjected).not.toHaveBeenCalled();

    r.send('first turn');
    await flushDispatch();
    expect(onInjected).toHaveBeenCalledTimes(1);

    // Subsequent turns don't refire the callback.
    r.send('second turn');
    await flushDispatch();
    expect(onInjected).toHaveBeenCalledTimes(1);
  });

  it('carries startup memory into the first transport payload', async () => {
    const startupItem = makeSearchItem({
      projectId: 'repo-1',
      summary: 'Remember to keep transport recall parity visible',
    });
    const startupMemory = {
      reason: 'startup' as const,
      runtimeFamily: 'transport' as const,
      authoritySource: 'processed_local' as const,
      sourceKind: 'local_processed' as const,
      injectionSurface: 'message-preamble' as const,
      injectedText: '# Recent project memory\n\n- Remember to keep transport recall parity visible',
      items: [startupItem],
    };
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
      startupMemory,
    }));

    await r.initialize(defaultConfig);
    await flushDispatch();

    // The "Historical context · injected" card MUST NOT fire at initialize
    // time — that would leak a fresh card on every restart-before-first-
    // message. The card is bound to the same commit boundary as the
    // persisted `startupMemoryInjected` flag; see the send assertion below.
    expect(timelineEmitterEmitMock).not.toHaveBeenCalledWith('deck_test_brain', 'memory.context', expect.objectContaining({
      reason: 'startup',
    }), expect.any(Object));

    const preferencePreamble = `${PREFERENCE_CONTEXT_START}
User-authored preferences for this and future turns.
- Use pnpm for project commands
${PREFERENCE_CONTEXT_END}`;
    r.send('Need a transport recall test', 'startup-pref-turn', undefined, preferencePreamble);
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      startupMemory: expect.objectContaining({
        reason: 'startup',
        injectedText: expect.stringContaining('transport recall parity visible'),
        authoritySource: 'processed_local',
        sourceKind: 'local_processed',
        injectionSurface: 'normalized-payload',
      }),
      messagePreamble: expect.stringContaining('transport recall parity visible'),
      assembledMessage: expect.stringContaining('transport recall parity visible'),
    }));
    const firstPayload = localMock.provider.send.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(String(firstPayload.messagePreamble)).toContain('Use pnpm for project commands');
    const sentPayload = localMock.provider.send.mock.calls[0]?.[1] as { systemText?: string } | undefined;
    expect(sentPayload?.systemText ?? '').not.toContain('transport recall parity visible');
    // Exactly ONE startup card — fired when the provider payload actually
    // carried the preamble, same boundary as the persisted flag.
    const startupCardsAfterSend = timelineEmitterEmitMock.mock.calls.filter(
      (call) => call[1] === 'memory.context' && (call[2] as Record<string, unknown>)?.reason === 'startup',
    );
    expect(startupCardsAfterSend).toHaveLength(1);
    expect(startupCardsAfterSend[0][2]).toEqual(expect.objectContaining({
      reason: 'startup',
      injectedText: expect.stringContaining('transport recall parity visible'),
      preferenceItems: [
        { id: 'preference-1', text: 'Use pnpm for project commands' },
      ],
    }));

    timelineEmitterEmitMock.mockClear();
    r.send('second turn');
    await flushDispatch();
    expect(timelineEmitterEmitMock).not.toHaveBeenCalledWith('deck_test_brain', 'memory.context', expect.objectContaining({
      reason: 'startup',
    }), expect.any(Object));
  });

  it('carries personal local startup memory when remote context is authoritative but has no startup hits', async () => {
    const startupItem = makeSearchItem({
      projectId: 'repo-1',
      summary: 'Local personal startup memory should still be visible',
    });
    const startupMemory = {
      reason: 'startup' as const,
      runtimeFamily: 'transport' as const,
      authoritySource: 'processed_local' as const,
      sourceKind: 'local_processed' as const,
      injectionSurface: 'message-preamble' as const,
      injectedText: '# Recent project memory\n\n- Local personal startup memory should still be visible',
      items: [startupItem],
    };
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:server-personal-fallback', 'remote-processed:fresh'],
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      startupMemory,
    }));

    await r.initialize(defaultConfig);
    timelineEmitterEmitMock.mockClear();

    r.send('first remote-authoritative personal turn');
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      startupMemory: expect.objectContaining({
        reason: 'startup',
        authoritySource: 'processed_local',
        sourceKind: 'local_processed',
        injectedText: expect.stringContaining('Local personal startup memory'),
      }),
      messagePreamble: expect.stringContaining('Local personal startup memory'),
      diagnostics: expect.arrayContaining(['memory:start:local-auxiliary']),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'startup',
        injectedText: expect.stringContaining('Local personal startup memory'),
      }),
      expect.objectContaining({ source: 'daemon', confidence: 'high' }),
    );
  });

  it('does not stack duplicate startup cards across restart-before-first-message cycles', async () => {
    // Regression for the timeline showing multiple "Historical context ·
    // injected" cards on a session that had been restarted repeatedly
    // before the first user turn ever landed. Each initialize used to emit
    // one card, but `startupMemoryInjected` only persists AFTER the first
    // successful dispatch — so the flag never caught up and cards stacked.
    const startupItem = makeSearchItem({
      projectId: 'repo-1',
      summary: 'Do not emit card until provider accepts preamble',
    });
    const startupMemory = {
      reason: 'startup' as const,
      runtimeFamily: 'transport' as const,
      authoritySource: 'processed_local' as const,
      sourceKind: 'local_processed' as const,
      injectionSurface: 'message-preamble' as const,
      injectedText: '# Recent project memory\n\n- Do not emit card until provider accepts preamble',
      items: [startupItem],
    };
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
      startupMemory,
    }));

    // Simulate three restarts before the first real message — flag never
    // persists, so `alreadyInjected` stays false across all three.
    await r.initialize(defaultConfig);
    await r.initialize(defaultConfig);
    await r.initialize(defaultConfig);
    await flushDispatch();
    expect(timelineEmitterEmitMock).not.toHaveBeenCalledWith('deck_test_brain', 'memory.context', expect.objectContaining({
      reason: 'startup',
    }), expect.any(Object));

    // First real turn — now exactly one card fires.
    r.send('first real turn after restarts');
    await flushDispatch();
    const startupCards = timelineEmitterEmitMock.mock.calls.filter(
      (call) => call[1] === 'memory.context' && (call[2] as Record<string, unknown>)?.reason === 'startup',
    );
    expect(startupCards).toHaveLength(1);
  });

  it('send() adds transport recall to the payload and emits linked memory.context evidence', async () => {
    const memoryItem = makeSearchItem({
      projectId: 'repo-1',
      summary: 'Fixed transport recall latency by emitting explicit memory.context cards',
      relevanceScore: 0.92,
    });
    searchLocalMemorySemanticMock.mockResolvedValue(makeSearchResult([memoryItem]));
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
    }));
    await r.initialize(defaultConfig);
    timelineEmitterEmitMock.mockClear();

    r.send('Please recall recent transport memory around recall runtime', 'client-turn-1');
    await flushDispatch();
    await flushDispatch();

    expect(searchLocalMemorySemanticMock).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining('Please recall recent transport memory'),
      namespace: { scope: 'personal', projectId: 'repo-1' },
      repo: 'repo-1',
      currentEnterpriseId: undefined,
      limit: 10,
    }));
    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      memoryRecall: expect.objectContaining({
        reason: 'message',
        runtimeFamily: 'transport',
        authoritySource: 'processed_local',
        sourceKind: 'local_processed',
        injectionSurface: 'normalized-payload',
        query: expect.stringContaining('Please recall recent transport memory'),
      }),
      messagePreamble: expect.stringContaining('[Related past work]'),
      assembledMessage: expect.stringContaining('[Related past work]'),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'message',
        relatedToEventId: 'transport-user:client-turn-1',
        runtimeFamily: 'transport',
        authoritySource: 'processed_local',
        sourceKind: 'local_processed',
      }),
      expect.objectContaining({ source: 'daemon', confidence: 'high' }),
    );
  });

  it('still injects per-message local recall when authority resolves to processed_remote for shared scope', async () => {
    const memoryItem = makeSearchItem({
      projectId: 'repo-1',
      scope: 'project_shared',
      enterpriseId: 'ent-1',
      workspaceId: 'ws-1',
      summary: 'Should not be injected while remote authority is active',
      relevanceScore: 0.92,
    });
    searchLocalMemorySemanticMock.mockResolvedValue(makeSearchResult([memoryItem]));
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'project_shared', projectId: 'repo-1', enterpriseId: 'ent-1', workspaceId: 'ws-1' },
      diagnostics: ['namespace:server-control-plane'],
      remoteProcessedFreshness: 'fresh',
      localProcessedFreshness: 'fresh',
      retryExhausted: true,
    }));
    await r.initialize(defaultConfig);
    timelineEmitterEmitMock.mockClear();

    r.send('Please recall recent transport memory around recall runtime', 'client-turn-remote');
    await flushDispatch();

    expect(searchLocalMemorySemanticMock).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining('Please recall recent transport memory'),
      namespace: { scope: 'project_shared', projectId: 'repo-1', enterpriseId: 'ent-1', workspaceId: 'ws-1' },
      currentEnterpriseId: 'ent-1',
      repo: 'repo-1',
      limit: 10,
    }));
    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      memoryRecall: expect.objectContaining({
        reason: 'message',
        authoritySource: 'processed_remote',
        sourceKind: 'local_processed',
      }),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'message',
        relatedToEventId: 'transport-user:client-turn-remote',
        authoritySource: 'processed_remote',
        sourceKind: 'local_processed',
      }),
      expect.anything(),
    );
  });

  it('applies the configured recall threshold for transport message recall', async () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      memoryRecallMinScore: 0.4,
    });
    const memoryItem = makeSearchItem({
      summary: 'Mid-threshold multilingual semantic match',
      relevanceScore: 0.4446,
    });
    searchLocalMemorySemanticMock.mockResolvedValue(makeSearchResult([memoryItem]));
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
    }));
    await r.initialize(defaultConfig);

    r.send('我感觉现在发的消息都没有相关历史recall了, 就像这句话 你自己测试下 不可能没有!', 'client-turn-threshold');
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      memoryRecall: expect.objectContaining({
        reason: 'message',
        query: expect.stringContaining('我感觉现在发的消息都没有相关历史recall了'),
      }),
    }));
  });

  it('emits explicit skipped-recall statuses for control and short transport messages', async () => {
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
    }));
    await r.initialize(defaultConfig);
    timelineEmitterEmitMock.mockClear();

    r.send('/status', 'client-turn-control');
    await flushDispatch();
    localMock.fireComplete('sess-1');
    r.send('hi', 'client-turn-short');
    await flushDispatch();

    expect(searchLocalMemorySemanticMock).not.toHaveBeenCalled();
    expect(localMock.provider.send).toHaveBeenNthCalledWith(1, 'sess-1', expect.not.objectContaining({
      memoryRecall: expect.anything(),
    }));
    expect(localMock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.not.objectContaining({
      memoryRecall: expect.anything(),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'message',
        relatedToEventId: 'transport-user:client-turn-control',
        status: 'skipped_control_message',
        items: [],
      }),
      expect.anything(),
    );
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'message',
        relatedToEventId: 'transport-user:client-turn-short',
        status: 'skipped_short_prompt',
        items: [],
      }),
      expect.anything(),
    );
  });

  it('transport memory recall fails open when lookup fails', async () => {
    searchLocalMemorySemanticMock.mockRejectedValue(new Error('lookup failed'));
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
    }));
    await r.initialize(defaultConfig);
    timelineEmitterEmitMock.mockClear();

    r.send('Please recall recent transport memory around recall runtime', 'client-turn-2');
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.not.objectContaining({
      memoryRecall: expect.anything(),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'message',
        relatedToEventId: 'transport-user:client-turn-2',
        status: 'failed',
        items: [],
      }),
      expect.anything(),
    );
  });

  it('bounds live context bootstrap so a hung resolver cannot block transport dispatch', async () => {
    vi.stubEnv('IMCODES_TRANSPORT_CONTEXT_BUDGET_MS', '50');
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    await r.initialize({
      ...defaultConfig,
      contextNamespace: { scope: 'personal', projectId: 'repo-1' },
      contextLocalProcessedFreshness: 'fresh',
    });
    r.setContextBootstrapResolver(() => new Promise(() => {}));
    timelineEmitterEmitMock.mockClear();

    r.send('/status', 'client-bootstrap-hang');
    await sleep(80);
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: '/status',
      authority: expect.objectContaining({
        namespace: { scope: 'personal', projectId: 'repo-1' },
      }),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'transport-user:client-bootstrap-hang',
        status: 'skipped_control_message',
      }),
      expect.anything(),
    );
  });

  it('bounds semantic memory recall so a hung embedding/search path still sends the turn', async () => {
    vi.stubEnv('IMCODES_TRANSPORT_CONTEXT_BUDGET_MS', '50');
    searchLocalMemorySemanticMock.mockReturnValue(new Promise(() => {}));
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    await r.initialize({
      ...defaultConfig,
      contextNamespace: { scope: 'personal', projectId: 'repo-1' },
      contextLocalProcessedFreshness: 'fresh',
    });
    timelineEmitterEmitMock.mockClear();

    r.send('Please recall recent transport memory around recall timeout handling', 'client-recall-hang');
    await sleep(80);
    await flushDispatch();

    expect(searchLocalMemorySemanticMock).toHaveBeenCalled();
    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.not.objectContaining({
      memoryRecall: expect.anything(),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'transport-user:client-recall-hang',
        status: 'failed',
        items: [],
      }),
      expect.anything(),
    );
  });

  it('clears sending and marks the runtime errored when provider send-start never settles', async () => {
    vi.stubEnv('IMCODES_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS', '50');
    const localMock = makeMockProvider();
    (localMock.provider.send as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    await r.initialize({
      ...defaultConfig,
      contextNamespace: { scope: 'personal', projectId: 'repo-1' },
      contextLocalProcessedFreshness: 'fresh',
    });

    r.send('/status', 'client-provider-hang');
    await sleep(80);
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledTimes(1);
    expect(r.getStatus()).toBe('error');
    expect(r.sending).toBe(false);
    expect(r.activeDispatchEntries).toEqual([
      { clientMessageId: 'client-provider-hang', text: '/status' },
    ]);
  });

  it('emits a template-prompt skip status before transport recall lookup', async () => {
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
    }));
    await r.initialize(defaultConfig);
    timelineEmitterEmitMock.mockClear();

    // Use a real template-prompt marker (workflow phrase). Bare
    // @openspec/changes/... references by themselves are now allowed —
    // they're common in user debugging prompts and must still trigger recall.
    r.send('Drive the implementation of @openspec/changes/shared-agent-context aggressively.', 'client-turn-template');
    await flushDispatch();

    expect(searchLocalMemorySemanticMock).not.toHaveBeenCalled();
    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.not.objectContaining({
      memoryRecall: expect.anything(),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'message',
        relatedToEventId: 'transport-user:client-turn-template',
        status: 'skipped_template_prompt',
        items: [],
      }),
      expect.anything(),
    );
  });

  it('onComplete sets status to idle and appends to history', () => {
    runtime.send('go');
    mock.fireComplete('sess-1');

    expect(runtime.getStatus()).toBe('idle');
    const h = runtime.getHistory();
    expect(h).toHaveLength(2);
    expect(h[0].role).toBe('user');
    expect(h[1].role).toBe('assistant');
  });

  it('onError sets status to error', () => {
    runtime.send('go');
    mock.fireError('sess-1');
    expect(runtime.getStatus()).toBe('error');
    expect(runtime.sending).toBe(false);
  });

  it('cancel() delegates to provider.cancel and preserves pending', () => {
    runtime.send('first');
    runtime.send('queued1', 'msg-q1');
    runtime.send('queued2', 'msg-q2');
    expect(runtime.pendingCount).toBe(2);
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-q1', text: 'queued1' },
      { clientMessageId: 'msg-q2', text: 'queued2' },
    ]);

    runtime.cancel();
    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');
    expect(runtime.pendingCount).toBe(2);
  });

  it('can edit and remove queued messages by clientMessageId', async () => {
    runtime.send('first');
    await flushDispatch();
    runtime.send('queued1', 'msg-q1');
    runtime.send('queued2', 'msg-q2');

    expect(runtime.editPendingMessage('msg-q1', 'edited queued1')).toBe(true);
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-q1', text: 'edited queued1' },
      { clientMessageId: 'msg-q2', text: 'queued2' },
    ]);

    expect(runtime.removePendingMessage('msg-q2')).toEqual({
      clientMessageId: 'msg-q2',
      text: 'queued2',
    });
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-q1', text: 'edited queued1' },
    ]);
  });

  it('drains the edited queued text into the next turn', async () => {
    runtime.send('first');
    await flushDispatch();
    runtime.send('queued1', 'msg-q1');

    expect(runtime.editPendingMessage('msg-q1', 'edited queued1')).toBe(true);

    mock.fireComplete('sess-1');
    await flushDispatch();

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'edited queued1',
      assembledMessage: 'edited queued1',
    }));
    expect(runtime.pendingEntries).toEqual([]);
  });

  it('cancelled turns drain pending messages into the next turn', async () => {
    runtime.send('first');
    await flushDispatch();
    runtime.send('queued1', 'msg-q1');
    runtime.send('queued2', 'msg-q2');

    runtime.cancel();
    mock.fireError('sess-1', { code: 'CANCELLED', message: 'cancelled', recoverable: true });
    await flushDispatch();

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued1\n\nqueued2',
      assembledMessage: 'queued1\n\nqueued2',
    }));
    expect(runtime.pendingCount).toBe(0);
  });

  it('recoverable provider errors drain pending messages into the next turn', async () => {
    runtime.send('first');
    await flushDispatch();
    runtime.send('queued after empty response', 'msg-q1');

    mock.fireError('sess-1', {
      code: 'PROVIDER_ERROR',
      message: 'Qwen exited without producing a response',
      recoverable: true,
    });
    await flushDispatch();

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued after empty response',
      assembledMessage: 'queued after empty response',
    }));
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.sending).toBe(true);
  });

  it('CANCELLED error → idle (not error)', () => {
    runtime.send('go');
    mock.fireError('sess-1', { code: 'CANCELLED', message: 'cancelled', recoverable: true });
    expect(runtime.getStatus()).toBe('idle');
  });

  it('events from wrong session are ignored', () => {
    runtime.send('go');
    mock.fireDelta('other-session');
    mock.fireComplete('other-session');
    expect(runtime.getStatus()).toBe('thinking');
    expect(runtime.getHistory()).toHaveLength(1); // only user msg
  });

  it('kill() clears everything', async () => {
    runtime.send('go');
    runtime.send('queued', 'msg-kill');
    await runtime.kill();

    expect(runtime.providerSessionId).toBeNull();
    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.sending).toBe(false);
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.pendingEntries).toEqual([]);
    expect(runtime.activeDispatchEntries).toEqual([]);
  });

  it('getHistory() returns a copy', () => {
    runtime.send('test');
    mock.fireComplete('sess-1');
    const h = runtime.getHistory();
    h.push({} as AgentMessage);
    expect(runtime.getHistory()).toHaveLength(2);
  });

  it('sending flag tracks turn', () => {
    expect(runtime.sending).toBe(false);
    runtime.send('go');
    expect(runtime.sending).toBe(true);
    mock.fireComplete('sess-1');
    expect(runtime.sending).toBe(false);
  });

  // ── N1 + G1 regression suite (audit f395d49c-78c) ─────────────────────────
  //
  // T5 — `_drainPending` MUST set `_sending=true` BEFORE invoking `_onDrain`.
  //      Pre-fix the order was splice → onDrain (with _sending still false) →
  //      _dispatchTurn (sets _sending=true). Any synchronous re-entrant
  //      `runtime.send` from an onDrain listener would have seen _sending=false
  //      and started a parallel dispatch, racing the merged turn. Node's
  //      EventEmitter doesn't currently yield, so the race wasn't triggerable,
  //      but the contract is now hardened for future refactors.
  //
  // T6 — `runtime.onDrain` MUST receive the full PendingTransportMessage[]
  //      array (one entry per original user message) so that the
  //      session-manager-registered callback in `wireTransportCallbacks` can
  //      emit one `user.message` timeline event per entry. Three audit rounds
  //      misread this contract before confirming it; the test locks it down
  //      so future refactors cannot silently merge entries before timeline
  //      emission and reintroduce the G1 "merged turn drops user messages"
  //      bug 3 candidate.

  it('T5 (N1 contract): _drainPending sets `_sending=true` before invoking the onDrain callback', async () => {
    // Establish active turn so subsequent sends queue.
    runtime.send('first', 'cmd-first');
    await flushDispatch();
    runtime.send('queued-a', 'cmd-a');
    runtime.send('queued-b', 'cmd-b');
    expect(runtime.pendingCount).toBe(2);

    // Register onDrain to capture `runtime.sending` at the moment the
    // callback fires. Pre-fix this would be `false` (race window).
    let sendingDuringDrain: boolean | null = null;
    runtime.onDrain = (messages) => {
      sendingDuringDrain = runtime.sending;
      // sanity — drain payload still matches the contract used by T6 below
      expect(messages).toHaveLength(2);
    };

    // Complete the active turn — onComplete → _drainPending → onDrain.
    mock.fireComplete('sess-1');

    expect(sendingDuringDrain).toBe(true);
  });

  it('T6 (G1 contract): onDrain receives per-entry PendingTransportMessage[] with original clientMessageIds intact', async () => {
    runtime.send('first', 'cmd-first');
    await flushDispatch();
    runtime.send('queued-a', 'cmd-a');
    runtime.send('queued-b', 'cmd-b');
    runtime.send('queued-c', 'cmd-c');
    expect(runtime.pendingCount).toBe(3);

    let received: { messages: PendingTransportMessage[]; merged: string; count: number } | null = null;
    runtime.onDrain = (messages, merged, count) => {
      // Snapshot so test assertions can run after fireComplete returns.
      received = { messages: messages.map((entry) => ({ ...entry })), merged, count };
    };

    mock.fireComplete('sess-1');

    expect(received).not.toBeNull();
    const captured = received!;
    expect(captured.count).toBe(3);
    expect(captured.messages.map((entry) => entry.clientMessageId)).toEqual(['cmd-a', 'cmd-b', 'cmd-c']);
    expect(captured.messages.map((entry) => entry.text)).toEqual(['queued-a', 'queued-b', 'queued-c']);
    // The merged string also matches the join used by _drainPending.
    expect(captured.merged).toBe('queued-a\n\nqueued-b\n\nqueued-c');
  });

  it('T5b (N1 contract): synchronous re-entrant runtime.send from onDrain listener queues into pending, never starts a parallel turn', async () => {
    runtime.send('first', 'cmd-first');
    await flushDispatch();
    runtime.send('queued', 'cmd-queued');

    const earlierProviderSendCalls = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;
    let reentrantResult: 'sent' | 'queued' | null = null;
    runtime.onDrain = () => {
      // A listener that synchronously re-enters runtime.send must NOT start
      // a parallel dispatch — `_sending` is already true (T5 contract).
      reentrantResult = runtime.send('re-entrant', 'cmd-reentrant');
    };

    mock.fireComplete('sess-1');
    await flushDispatch();

    expect(reentrantResult).toBe('queued');
    // The re-entrant entry now sits in _pendingMessages, separate from the
    // merged drain turn that fired.
    expect(runtime.pendingEntries.map((entry) => entry.clientMessageId)).toContain('cmd-reentrant');
    // provider.send called once more (the merged drain turn), NOT twice.
    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(earlierProviderSendCalls + 1);
  });
});
