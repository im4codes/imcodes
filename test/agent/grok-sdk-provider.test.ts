import { describe, expect, it, vi } from 'vitest';
import { withMemoryMcpSessionEnv } from '../../src/agent/providers/getDefaultMcpServers.js';
import { MEMORY_MCP_ENV_KEYS as E } from '../../shared/memory-mcp-env.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
} from '../../shared/agent-delegation.js';
import {
  GrokSdkProvider,
  buildGrokAcpArgs,
  resolveGrokBinaryPath,
  resolveGrokPermissionMode,
  GROK_CLI_PATH_ENV,
  GROK_CLI_BINARY,
} from '../../src/agent/providers/grok-sdk.js';
import { BACKGROUND_SUBAGENT_WAKE_MODES, PROVIDER_ERROR_CODES, type ToolCallEvent } from '../../src/agent/transport-provider.js';
import {
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_STATUS,
} from '../../shared/sdk-subagent-status.js';

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
    promptSubmittedGeneration: 1,
    activePromptAdmissions: new Map(),
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

  it('resolves Grok binary path honoring config override and GROK_CLI_PATH', () => {
    expect(resolveGrokBinaryPath({ binaryPath: '/custom/path/grok' })).toBe('/custom/path/grok');

    const origEnv = process.env[GROK_CLI_PATH_ENV];
    try {
      process.env[GROK_CLI_PATH_ENV] = '/env/path/grok';
      expect(resolveGrokBinaryPath()).toBe('/env/path/grok');
      // Explicit config overrides env
      expect(resolveGrokBinaryPath({ binaryPath: '/override/grok' })).toBe('/override/grok');
    } finally {
      if (origEnv === undefined) {
        delete process.env[GROK_CLI_PATH_ENV];
      } else {
        process.env[GROK_CLI_PATH_ENV] = origEnv;
      }
    }
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
      backgroundSubagentWake: BACKGROUND_SUBAGENT_WAKE_MODES.RUNTIME,
      compact: {
        execution: 'slash-command',
        providerCommand: '/compact',
        verified: true,
      },
    });
    expect((provider as any).profile.args).toEqual(['--no-auto-update', 'agent', 'stdio']);
  });

  describe('maximum-permission launch posture (--dangerously-skip-permissions equivalent)', () => {
    it('launches `grok agent stdio` with --permission-mode bypassPermissions by default, ahead of the subcommand', () => {
      const provider = new GrokSdkProvider();
      expect((provider as any).buildAcpArgs({})).toEqual([
        '--no-auto-update', '--permission-mode', 'bypassPermissions', 'agent', 'stdio',
      ]);
      // The static profile argv is untouched; the posture is applied per connect().
      expect((provider as any).profile.args).toEqual(['--no-auto-update', 'agent', 'stdio']);
    });

    it('can be opted out of with dangerouslySkipPermissions: false', () => {
      expect(resolveGrokPermissionMode({ dangerouslySkipPermissions: false })).toBeUndefined();
      const provider = new GrokSdkProvider();
      expect((provider as any).buildAcpArgs({ dangerouslySkipPermissions: false })).toEqual(['--no-auto-update', 'agent', 'stdio']);
    });

    it('honors an explicit permissionMode, treats "default" as no flag, and ignores invalid values', () => {
      expect(resolveGrokPermissionMode({ permissionMode: 'acceptEdits' })).toBe('acceptEdits');
      expect(resolveGrokPermissionMode({ permissionMode: 'plan', dangerouslySkipPermissions: false })).toBe('plan');
      expect(resolveGrokPermissionMode({ permissionMode: 'default' })).toBeUndefined();
      expect(resolveGrokPermissionMode({ permissionMode: 'nonsense' })).toBe('bypassPermissions');
      expect(resolveGrokPermissionMode(null)).toBe('bypassPermissions');
    });

    it('never duplicates or overrides a caller-provided --permission-mode', () => {
      const args = buildGrokAcpArgs(['--no-auto-update', '--permission-mode', 'plan', 'agent', 'stdio'], {});
      expect(args).toEqual(['--no-auto-update', '--permission-mode', 'plan', 'agent', 'stdio']);
    });

    it('keeps bridging approval requests so an opted-out or non-bypass mode still prompts the user', () => {
      expect(new GrokSdkProvider().capabilities.approval).toBe(true);
    });
  });

  it('normalizes Grok background-subagent lifecycle events for parent wake', () => {
    const provider = new GrokSdkProvider();
    const { acpSessionId } = attachRoute(provider, 'grok-subagent-wake');
    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_sessionId, tool) => tools.push(tool));

    (provider as any).handleSessionUpdate({
      sessionId: acpSessionId,
      update: {
        sessionUpdate: 'subagent_notification',
        subagent: {
          agent_path: 'grok-child-1',
          status: 'running',
          is_backgrounded: true,
        },
      },
    });
    (provider as any).handleSessionUpdate({
      sessionId: acpSessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'grok-child-terminal',
        content: {
          type: 'text',
          text: '<subagent_notification>{"agent_path":"grok-child-1","status":{"completed":"done"},"is_backgrounded":true}</subagent_notification>',
        },
      },
    });

    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      status: 'running',
      detail: {
        meta: {
          provider: SDK_SUBAGENT_PROVIDERS.GROK_SDK,
          providerKind: SDK_SUBAGENT_PROVIDER_KINDS.GROK_RUNTIME_AGENT,
          normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
          active: true,
          terminal: false,
          backgrounded: true,
        },
      },
    });
    expect(tools[1]).toMatchObject({
      id: tools[0]?.id,
      status: 'complete',
      output: 'done',
      detail: {
        meta: {
          normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
          active: false,
          terminal: true,
          backgrounded: true,
        },
      },
    });
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

  it.each([undefined, 'native-resume'])('registers the complete managed MCP binding on a real Grok session (resume=%s)', async (resumeId) => {
    const provider = new GrokSdkProvider();
    const connection = {
      newSession: vi.fn().mockResolvedValue({ sessionId: 'real-session' }),
      loadSession: vi.fn().mockResolvedValue({}),
    };
    (provider as any).connection = connection;
    (provider as any).initPromise = Promise.resolve();
    await provider.createSession(withMemoryMcpSessionEnv({
      sessionKey: 'route-real',
      sessionInstanceId: 'instance-grok', runtimeEpoch: 'epoch-grok', providerId: provider.id, resumeId,
      sessionName: 'deck_sub_grok',
      projectName: 'alpha',
      serverId: 'server-1',
      cwd: '/tmp/project',
      contextNamespace: { scope: 'project_shared', userId: 'user-1', projectId: 'alpha' },
    }));
    const state = (provider as any).sessions.get('route-real');
    await (provider as any).ensureSessionReady('route-real', state);

    const request = (resumeId ? connection.loadSession : connection.newSession).mock.calls[0]?.[0];
    expect(request.mcpServers).toHaveLength(1);
    expect(request.mcpServers[0]).toMatchObject({ name: 'imcodes-memory' });
    const env = Object.fromEntries(request.mcpServers[0].env.map((entry: { name: string; value: string }) => [entry.name, entry.value]));
    expect(env).toMatchObject({
      IMCODES_DAEMON_SESSION_NAME: 'deck_sub_grok',
      IMCODES_DAEMON_PROJECT_NAME: 'alpha',
      IMCODES_DAEMON_SERVER_ID: 'server-1',
      [E.SESSION_INSTANCE_ID]: 'instance-grok', [E.RUNTIME_EPOCH]: 'epoch-grok', [E.PROVIDER_ID]: provider.id,
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

  it('lists remote provider sessions and restores locally bound sessions', async () => {
    const provider = new GrokSdkProvider();
    attachRoute(provider, 'route-listed');
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [{
        sessionId: 'acp-route-listed',
        title: 'route-listed',
        cwd: '/tmp/project',
      }],
      nextCursor: null,
    });
    (provider as any).connection = { listSessions };
    (provider as any).sessionListSupported = true;

    await expect(provider.listSessions!({ directory: '/tmp/project' })).resolves.toEqual([expect.objectContaining({
      key: 'acp-route-listed',
      displayName: 'route-listed',
      directory: '/tmp/project',
    })]);
    expect(listSessions).toHaveBeenCalledWith({ cwd: '/tmp/project' });
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

  it('declares native active delegation capability for direct in-flight append', () => {
    const provider = new GrokSdkProvider();
    expect(provider.capabilities.activeDelegationNotification).toBe(
      AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
    );
  });

  it('supports native in-flight append via notifyActiveDelegation and sequential multi-turn settlement', async () => {
    const provider = new GrokSdkProvider();
    const { acpSessionId, state } = attachRoute(provider);
    const tracker = {
      writeQueue: Promise.resolve(),
      abortController: new AbortController(),
    };
    let resolveTurn2: (res: { stopReason: 'end_turn' }) => void;
    const queuedTurnPromise = new Promise<{ stopReason: 'end_turn' }>((resolve) => {
      resolveTurn2 = resolve;
    });
    const prompt = vi.fn().mockReturnValue(queuedTurnPromise);
    (provider as any).connection = { prompt, connection: tracker };

    const deltas: string[] = [];
    const completions: { id: string; content: string }[] = [];
    provider.onDelta((_sessionId, delta) => deltas.push(delta.delta));
    provider.onComplete((_sessionId, msg) => completions.push({ id: msg.id, content: msg.content }));

    const notification = {
      notificationId: 'grok-append-1',
      delegationId: 'queue-append:grok-append-1',
      sourceSessionName: 'grok-source',
      text: 'Say BANANA now.',
      deliveryKind: 'mcp_message' as const,
    };

    const admissionResult = await provider.notifyActiveDelegation('grok-route', notification);
    expect(admissionResult).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: acpSessionId,
      prompt: [{ type: 'text', text: 'Say BANANA now.' }],
    }));

    // Turn 1 stream arrives
    (provider as any).handleSessionUpdate({
      sessionId: acpSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'turn-1-msg', content: { type: 'text', text: 'Counting 1 to 5' } },
    });
    expect(deltas).toEqual(['Counting 1 to 5']);

    // Settle Turn 1
    (provider as any).settleTurn('grok-route', state, 1, 'end_turn');
    expect(completions).toEqual([{ id: 'turn-1-msg', content: 'Counting 1 to 5' }]);
    expect(state.promptInFlight).toBe(true);

    // Turn 2 stream arrives (not dropped because promptInFlight is preserved)
    (provider as any).handleSessionUpdate({
      sessionId: acpSessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'turn-2-msg', content: { type: 'text', text: 'BANANA' } },
    });
    expect(deltas).toEqual(['Counting 1 to 5', 'BANANA']);

    // Settle Turn 2
    resolveTurn2!({ stopReason: 'end_turn' });
    await queuedTurnPromise;
    await new Promise((r) => setTimeout(r, 10));

    expect(completions).toEqual([
      { id: 'turn-1-msg', content: 'Counting 1 to 5' },
      { id: 'turn-2-msg', content: 'BANANA' },
    ]);
    expect(state.promptInFlight).toBe(false);
  });

  it('captures dynamic model catalog update from _x.ai/models/update notification', async () => {
    const provider = new GrokSdkProvider();
    attachRoute(provider);
    const client = (provider as any).createClientImpl();

    await client.extNotification('_x.ai/models/update', {
      availableModels: [
        { modelId: 'grok-4.7', name: 'Grok 4.7' },
        { modelId: 'grok-4.7-mini', name: 'Grok 4.7 Mini' },
      ],
      currentModelId: 'grok-4.7',
    });

    const models = await provider.listModels();
    expect(models).toEqual({
      models: [
        { id: 'grok-4.7', name: 'Grok 4.7' },
        { id: 'grok-4.7-mini', name: 'Grok 4.7 Mini' },
      ],
      defaultModel: 'grok-4.7',
      isAuthenticated: true,
    });
  });

  it('maps connection drops to recoverable CONNECTION_LOST without leaking details', () => {
    const provider = new GrokSdkProvider();
    const error = (provider as any).normalizeError(new Error('Connection closed prematurely'));
    expect(error).toMatchObject({
      code: PROVIDER_ERROR_CODES.CONNECTION_LOST,
      message: 'Grok connection was lost.',
      recoverable: true,
    });
    expect(JSON.stringify(error)).not.toContain('prematurely');
  });

  it('suppresses error emissions during intentional disconnect', async () => {
    const provider = new GrokSdkProvider();
    const { state } = attachRoute(provider, 'disconnect-test');
    const errors: any[] = [];
    provider.onError((_sessionId, err) => errors.push(err));

    (provider as any).isDisconnecting = true;
    (provider as any).failTurn('disconnect-test', state, 1, new Error('Child process killed'));
    expect(errors).toHaveLength(0);
  });
});

