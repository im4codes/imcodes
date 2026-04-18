import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { RUNTIME_TYPES } from '../../src/agent/session-runtime.js';
import type { TransportProvider, ProviderError, SessionConfig } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { MemorySearchResult, MemorySearchResultItem } from '../../src/context/memory-search.js';

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
  const fireComplete = (sid: string) =>
    completeCb?.(sid, { id: 'msg-1', sessionId: sid, kind: 'text', role: 'assistant', content: 'done', timestamp: Date.now(), status: 'complete' });
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
    mock = makeMockProvider();
    runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
    await runtime.initialize(defaultConfig);
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
      systemText: undefined,
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

  it('send() merges description and runtime prompt into normalized systemText', async () => {
    const r = new TransportSessionRuntime(mock.provider, 'x');
    await r.initialize({ ...defaultConfig, description: 'expert', systemPrompt: 'runtime only' });
    r.send('help');
    await flushDispatch();
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: 'help',
      assembledMessage: 'help',
      systemText: 'expert\n\nruntime only',
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
      injectionSurface: 'system-text' as const,
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

    expect(timelineEmitterEmitMock).toHaveBeenCalledWith('deck_test_brain', 'memory.context', expect.objectContaining({
      reason: 'startup',
      injectedText: expect.stringContaining('transport recall parity visible'),
    }), expect.any(Object));

    timelineEmitterEmitMock.mockClear();

    r.send('Need a transport recall test');
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      startupMemory: expect.objectContaining({
        reason: 'startup',
        injectedText: expect.stringContaining('transport recall parity visible'),
        authoritySource: 'processed_local',
        sourceKind: 'local_processed',
        injectionSurface: 'normalized-payload',
      }),
    }));
    expect(timelineEmitterEmitMock).not.toHaveBeenCalledWith('deck_test_brain', 'memory.context', expect.objectContaining({
      reason: 'startup',
    }), expect.any(Object));
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

    r.send('Implement @openspec/changes/shared-agent-context and continue the template workflow', 'client-turn-template');
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
});
