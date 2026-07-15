import { describe, expect, it, vi } from 'vitest';
import { GrokSdkProvider } from '../../src/agent/providers/grok-sdk.js';
import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';

function attachRoute(provider: GrokSdkProvider, routeId = 'grok-route') {
  const acpSessionId = `acp-${routeId}`;
  const state = {
    routeId,
    sessionName: routeId,
    projectName: 'project',
    serverId: 'server',
    cwd: '/tmp/project',
    acpSessionId,
    loaded: true,
    modeApplied: true,
    promptInFlight: true,
    turnGeneration: 1,
    settledGeneration: 0,
    replaying: false,
    cancelled: false,
    currentMessageId: null,
    currentText: '',
    toolCalls: new Map(),
    emittedToolSignatures: new Map(),
    lastStatusSignature: null,
    lastTurnUsage: undefined as Record<string, unknown> | undefined,
  };
  (provider as any).sessions.set(routeId, state);
  (provider as any).acpToRoute.set(acpSessionId, routeId);
  return { acpSessionId, state };
}

describe('GrokSdkProvider contract', () => {
  it('fails a missing executable at connect time with official repair guidance', async () => {
    const provider = new GrokSdkProvider();
    await expect(provider.connect({ binaryPath: '/definitely/missing/grok-cli' })).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
      message: expect.stringContaining('Install the official CLI'),
      recoverable: false,
    });
    await provider.disconnect();
  });

  it('declares the official Grok ACP transport capabilities', () => {
    const provider = new GrokSdkProvider();
    expect(provider.id).toBe('grok-sdk');
    expect(provider.connectionMode).toBe('local-sdk');
    expect(provider.sessionOwnership).toBe('shared');
    expect(provider.capabilities).toMatchObject({
      streaming: true,
      toolCalling: true,
      approval: true,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
      reasoningEffort: false,
      compact: {
        execution: 'slash-command',
        providerCommand: '/compact',
        verified: true,
      },
    });
    expect((provider as any).profile.args).toEqual(['--no-auto-update', 'agent', 'stdio']);
  });

  it('bridges permission options and applies a session-scoped response', async () => {
    const provider = new GrokSdkProvider();
    const { acpSessionId } = attachRoute(provider);
    const requests: Array<{ sessionId: string; id: string }> = [];
    provider.onApprovalRequest!((sessionId, request) => requests.push({ sessionId, id: request.id }));

    const client = (provider as any).createClientImpl();
    const pending = client.requestPermission({
      sessionId: acpSessionId,
      toolCall: { toolCallId: 'tool-1', title: 'Edit a file' },
      options: [
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      ],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.sessionId).toBe('grok-route');
    await provider.respondApproval!('grok-route', requests[0]!.id, true);
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it('fails permission requests closed when no approval consumer exists', async () => {
    const provider = new GrokSdkProvider();
    const { acpSessionId } = attachRoute(provider);
    const client = (provider as any).createClientImpl();
    await expect(client.requestPermission({
      sessionId: acpSessionId,
      toolCall: { toolCallId: 'tool-2', title: 'Run command' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('accepts the xAI MCP catalog extension without method-not-found errors', async () => {
    const provider = new GrokSdkProvider();
    const client = (provider as any).createClientImpl();
    await expect(client.extNotification('_x.ai/mcp/servers_updated', { mcpServers: [] })).resolves.toBeUndefined();
  });

  it('validates ACP protocol, load support, compact command, and auth with an MCP-free probe', async () => {
    const provider = new GrokSdkProvider();
    const connection = {
      newSession: vi.fn().mockResolvedValue({ sessionId: 'probe-session' }),
      closeSession: vi.fn().mockResolvedValue({}),
    };
    (provider as any).connection = connection;

    await (provider as any).validateConnectedAgent({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'grok.com' }],
      _meta: { availableCommands: [{ name: 'compact' }] },
    }, {});

    expect(connection.newSession).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: [] }));
    expect(connection.closeSession).toHaveBeenCalledWith({ sessionId: 'probe-session' });
  });

  it('returns a stable redacted auth error when the readiness probe fails', async () => {
    const provider = new GrokSdkProvider();
    (provider as any).connection = {
      newSession: vi.fn().mockRejectedValue(new Error('secret-token-value')),
    };

    await expect((provider as any).validateConnectedAgent({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'grok.com' }],
      _meta: { availableCommands: [{ name: 'compact' }] },
    }, {})).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.AUTH_FAILED,
      message: expect.not.stringContaining('secret-token-value'),
      recoverable: false,
    });
  });

  it('redacts arbitrary provider error payloads before transport emission', () => {
    const provider = new GrokSdkProvider();
    const sentinels = [
      'xai-api-key-sentinel',
      'oauth-device-code-sentinel',
      'authorization-bearer-sentinel',
      'environment-value-sentinel',
      'private-prompt-sentinel',
      'assistant-text-sentinel',
      'tool-input-sentinel',
      'tool-output-sentinel',
      '/private/repository/path',
      'raw-acp-payload-sentinel',
      'stderr-sentinel',
    ];
    const error = (provider as any).normalizeError(new Error(`provider failure ${sentinels.join(' ')}`));
    expect([PROVIDER_ERROR_CODES.PROVIDER_ERROR, PROVIDER_ERROR_CODES.AUTH_FAILED]).toContain(error.code);
    for (const sentinel of sentinels) expect(JSON.stringify(error)).not.toContain(sentinel);
  });

  it('rejects a configured authentication method that the CLI did not advertise', async () => {
    const provider = new GrokSdkProvider();
    (provider as any).connection = { newSession: vi.fn() };
    await expect((provider as any).validateConnectedAgent({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'grok.com' }],
      _meta: { availableCommands: [{ name: 'compact' }] },
    }, { authMethodId: 'xai.api_key' })).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.AUTH_FAILED,
      message: expect.stringContaining('not advertised'),
    });
  });

  it('uses API-key authentication only when advertised and supplied through env', async () => {
    const provider = new GrokSdkProvider();
    const connection = {
      authenticate: vi.fn().mockResolvedValue({}),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'probe' }),
      closeSession: vi.fn().mockResolvedValue({}),
    };
    (provider as any).connection = connection;
    await (provider as any).validateConnectedAgent({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'grok.com' }, { id: 'xai.api_key' }],
      _meta: { availableCommands: [{ name: 'compact' }] },
    }, { env: { XAI_API_KEY: 'sentinel-secret' } });
    expect(connection.authenticate).toHaveBeenCalledWith({ methodId: 'xai.api_key' });
    expect(connection.newSession).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: [] }));
  });

  it('downgrades compact when the effective CLI does not advertise it', async () => {
    const provider = new GrokSdkProvider();
    (provider as any).connection = {
      newSession: vi.fn().mockResolvedValue({ sessionId: 'probe' }),
      closeSession: vi.fn().mockResolvedValue({}),
    };
    await (provider as any).validateConnectedAgent({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
      _meta: { availableCommands: [] },
    }, {});
    expect(provider.capabilities.compact).toMatchObject({ execution: 'unsupported', verified: true });
  });

  it('keeps model discovery probes MCP-free', async () => {
    const provider = new GrokSdkProvider();
    const connection = {
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'model-probe',
        models: {
          currentModelId: 'grok-build',
          availableModels: [{ modelId: 'grok-build', name: 'Grok Build' }],
        },
      }),
      closeSession: vi.fn().mockResolvedValue({}),
    };
    (provider as any).connection = connection;
    (provider as any).initPromise = Promise.resolve();
    const result = await provider.listModels();
    expect(connection.newSession).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: [] }));
    expect(result).toMatchObject({ defaultModel: 'grok-build', isAuthenticated: true });
    expect(result.models).toEqual([{ id: 'grok-build', name: 'Grok Build' }]);
  });

  it('registers managed MCP identity only on a real user session', async () => {
    const provider = new GrokSdkProvider();
    const connection = {
      newSession: vi.fn().mockResolvedValue({ sessionId: 'real-session' }),
    };
    (provider as any).connection = connection;
    (provider as any).initPromise = Promise.resolve();
    await provider.createSession({
      sessionKey: 'route-real',
      sessionName: 'deck_sub_grok',
      projectName: 'alpha',
      serverId: 'server-1',
      cwd: '/tmp/project',
      contextNamespace: { scope: 'project_shared', userId: 'user-1', projectId: 'alpha' },
    });
    const state = (provider as any).sessions.get('route-real');
    await (provider as any).ensureSessionReady('route-real', state);

    const request = connection.newSession.mock.calls[0]?.[0];
    expect(request.mcpServers).toHaveLength(1);
    expect(request.mcpServers[0]).toMatchObject({ name: 'imcodes-memory' });
    const env = Object.fromEntries(request.mcpServers[0].env.map((entry: { name: string; value: string }) => [entry.name, entry.value]));
    expect(env).toMatchObject({
      IMCODES_DAEMON_SESSION_NAME: 'deck_sub_grok',
      IMCODES_DAEMON_PROJECT_NAME: 'alpha',
      IMCODES_DAEMON_SERVER_ID: 'server-1',
    });
    expect(JSON.stringify(request.mcpServers)).not.toContain('IMCODES_SERVER_TOKEN');
  });

  it('does not silently fork a fresh conversation when Grok resume fails', async () => {
    const provider = new GrokSdkProvider();
    const connection = {
      loadSession: vi.fn().mockRejectedValue(new Error('missing resume id')),
      newSession: vi.fn(),
    };
    (provider as any).connection = connection;
    (provider as any).initPromise = Promise.resolve();
    await provider.createSession({
      sessionKey: 'route-resume',
      cwd: '/tmp/project',
      resumeId: 'missing-provider-session',
    });
    const state = (provider as any).sessions.get('route-resume');
    await expect((provider as any).ensureSessionReady('route-resume', state)).rejects.toThrow('missing resume id');
    expect(connection.newSession).not.toHaveBeenCalled();
  });

  it('lists and restores only locally bound provider sessions', async () => {
    const provider = new GrokSdkProvider();
    attachRoute(provider, 'route-listed');
    await expect(provider.listSessions!()).resolves.toEqual([expect.objectContaining({
      key: 'acp-route-listed',
      displayName: 'route-listed',
    })]);
    await expect(provider.restoreSession!('acp-route-listed')).resolves.toBe(true);
    await expect(provider.restoreSession!('missing')).resolves.toBe(false);
  });

  it('routes streaming chunks and usage to the matching ACP session only', () => {
    const provider = new GrokSdkProvider();
    const first = attachRoute(provider, 'route-a');
    const second = attachRoute(provider, 'route-b');
    const deltas: Array<[string, string]> = [];
    provider.onDelta((sessionId, delta) => deltas.push([sessionId, delta.delta]));

    (provider as any).handleSessionUpdate({
      sessionId: first.acpSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'a', content: { type: 'text', text: 'alpha' } },
    });
    (provider as any).handleSessionUpdate({
      sessionId: second.acpSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'b', content: { type: 'text', text: 'beta' } },
    });
    (provider as any).handleSessionUpdate({
      sessionId: first.acpSessionId,
      update: { sessionUpdate: 'usage_update', tokens: { input_tokens: 4, output_tokens: 2 } },
    });

    expect(deltas).toEqual([['route-a', 'alpha'], ['route-b', 'beta']]);
    expect(first.state.lastTurnUsage).toEqual({ input_tokens: 4, output_tokens: 2 });
    expect(second.state.lastTurnUsage).toBeUndefined();
  });

  it('isolates concurrent approvals and cancellation across two Grok routes', async () => {
    const provider = new GrokSdkProvider();
    const first = attachRoute(provider, 'route-a');
    const second = attachRoute(provider, 'route-b');
    const requests = new Map<string, string>();
    provider.onApprovalRequest!((routeId, request) => requests.set(routeId, request.id));
    const client = (provider as any).createClientImpl();
    const options = [
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    ];
    const pendingA = client.requestPermission({ sessionId: first.acpSessionId, toolCall: { toolCallId: 'a', title: 'A' }, options });
    const pendingB = client.requestPermission({ sessionId: second.acpSessionId, toolCall: { toolCallId: 'b', title: 'B' }, options });
    await provider.respondApproval!('route-a', requests.get('route-b')!, true);
    expect((provider as any).pendingApprovals.size).toBe(2);
    await provider.respondApproval!('route-a', requests.get('route-a')!, true);
    await provider.respondApproval!('route-b', requests.get('route-b')!, false);
    await expect(pendingA).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    await expect(pendingB).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });

    const cancel = vi.fn().mockResolvedValue(undefined);
    (provider as any).connection = { cancel };
    await provider.cancel('route-a');
    expect(cancel).toHaveBeenCalledWith({ sessionId: first.acpSessionId });
    expect(first.state.cancelled).toBe(true);
    expect(second.state.cancelled).toBe(false);
  });

  it('suppresses history replay and reports truthful active work', () => {
    const provider = new GrokSdkProvider();
    const { acpSessionId, state } = attachRoute(provider);
    const deltas: string[] = [];
    provider.onDelta((_sessionId, delta) => deltas.push(delta.delta));
    state.replaying = true;
    (provider as any).handleSessionUpdate({
      sessionId: acpSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'old', content: { type: 'text', text: 'history' } },
    });
    expect(deltas).toEqual([]);
    expect(provider.getActiveWorkSnapshot('grok-route')).toMatchObject({
      status: 'current',
      activeWorkCount: 2,
      activeToolCount: 0,
      busyReasons: expect.arrayContaining(['provider_wait', 'provider_session_binding']),
    });
    state.replaying = false;
    state.promptInFlight = false;
    expect(provider.getActiveWorkSnapshot('grok-route')).toMatchObject({
      activeWorkCount: 0,
      busyReasons: [],
    });
  });

  it('drops turn-scoped events after cancellation and clears false-working state on failure', () => {
    const provider = new GrokSdkProvider();
    const { acpSessionId, state } = attachRoute(provider);
    const deltas: string[] = [];
    provider.onDelta((_sessionId, delta) => deltas.push(delta.delta));
    state.cancelled = true;
    (provider as any).handleSessionUpdate({
      sessionId: acpSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'late', content: { type: 'text', text: 'late text' } },
    });
    expect(deltas).toEqual([]);

    state.toolCalls.set('tool-late', {
      toolCallId: 'tool-late',
      title: 'Late tool',
      status: 'in_progress',
      content: [],
    });
    (provider as any).clearSessionWorkAfterFailure('grok-route');
    expect(provider.getActiveWorkSnapshot('grok-route')).toMatchObject({
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });
  });

  it('emits a turn terminal exactly once for a prompt generation', () => {
    const provider = new GrokSdkProvider();
    const { state } = attachRoute(provider);
    state.currentText = 'done';
    state.currentMessageId = 'message-1';
    const completions: string[] = [];
    provider.onComplete((_sessionId, message) => completions.push(message.id));
    (provider as any).settleTurn('grok-route', state, 1, 'end_turn');
    (provider as any).settleTurn('grok-route', state, 1, 'end_turn');
    expect(completions).toEqual(['message-1']);
  });
});
