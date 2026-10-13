import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MUSE_MODELS,
  MUSE_CODE_SDK_PROVIDER_ID,
  MuseCodeSdkProvider,
  normalizeMuseModelId,
} from '../../src/agent/providers/muse-code-sdk.js';
import {
  BACKGROUND_SUBAGENT_WAKE_MODES,
  CONNECTION_MODES,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
  type ApprovalRequest,
  type ToolCallEvent,
} from '../../src/agent/transport-provider.js';
import { MUSE_SDK_EFFORT_LEVELS } from '../../shared/effort-levels.js';
import { NATIVE_AGENT_ADMISSION_MODES } from '../../shared/native-collaboration-policy.js';
import type { MessageDelta } from '../../shared/agent-message.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_STATUS,
} from '../../shared/sdk-subagent-status.js';

describe('MuseCodeSdkProvider contract', () => {
  it('declares the official Muse Code transport capabilities and configuration', () => {
    const provider = new MuseCodeSdkProvider();
    expect(provider.id).toBe(MUSE_CODE_SDK_PROVIDER_ID);
    expect(provider.connectionMode).toBe(CONNECTION_MODES.LOCAL_SDK);
    expect(provider.sessionOwnership).toBe(SESSION_OWNERSHIP.SHARED);
    expect(provider.capabilities).toMatchObject({
      streaming: true,
      toolCalling: true,
      approval: true,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
      reasoningEffort: true,
      supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
      contextSupport: 'full-normalized-context-injection',
      backgroundSubagentWake: BACKGROUND_SUBAGENT_WAKE_MODES.RUNTIME,
      nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.SESSION_FENCE,
    });
  });

  it('fails connect with clear error when binary path does not exist', async () => {
    const provider = new MuseCodeSdkProvider();
    await expect(
      provider.connect({ cliPath: '/non/existent/path/to/muse-binary-xyz' }),
    ).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
      message: expect.stringContaining('Muse Code CLI binary could not be found'),
      recoverable: false,
    });
    await provider.disconnect();
  });

  it('lists default models when offline or unconnected', async () => {
    const provider = new MuseCodeSdkProvider();
    const result = await provider.listModels();
    expect(result.models.length).toBeGreaterThanOrEqual(3);
    expect(result.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['muse-spark-1.3', 'muse-spark', 'muse-wonder', 'muse-fast']),
    );
    expect(result.defaultModel).toBe('muse-spark-1.3');
    for (const m of result.models) {
      expect(m.supportsReasoningEffort).toBe(true);
      expect(m.supportedEffortLevels).toEqual(MUSE_SDK_EFFORT_LEVELS);
    }
  });

  it('queries models from connection command when connected', async () => {
    const provider = new MuseCodeSdkProvider();
    const mockCommand = vi.fn().mockResolvedValue({
      models: [
        { id: 'muse-spark', name: 'Muse Spark' },
        { id: 'muse-custom-1', name: 'Muse Custom 1' },
      ],
    });
    (provider as any).spawned = {
      connection: {
        command: mockCommand,
      },
    };

    const result = await provider.listModels();
    expect(mockCommand).toHaveBeenCalledWith('model/list', {});
    expect(result.models).toEqual([
      {
        id: 'muse-spark',
        name: 'Muse Spark',
        supportsReasoningEffort: true,
        supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
      },
      {
        id: 'muse-custom-1',
        name: 'Muse Custom 1',
        supportsReasoningEffort: true,
        supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
      },
    ]);
  });

  it('queries models using real wire format with modelId and displayLabel', async () => {
    const provider = new MuseCodeSdkProvider();
    const mockCommand = vi.fn().mockResolvedValue({
      models: [
        { modelId: 'muse-spark-1.3', displayLabel: 'muse-spark-1.3', providerId: 'meta' },
      ],
      profileId: 'tbh',
      providerId: 'meta',
      source: 'bundledCatalog',
    });
    (provider as any).spawned = {
      connection: {
        command: mockCommand,
      },
    };

    const result = await provider.listModels();
    expect(result.models).toEqual([
      {
        id: 'muse-spark-1.3',
        name: 'muse-spark-1.3',
        supportsReasoningEffort: true,
        supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
      },
    ]);
    expect(result.defaultModel).toBe('muse-spark-1.3');
  });

  it('reports memory MCP status as ready when client is connected, degraded when registration failed', () => {
    const provider = new MuseCodeSdkProvider();
    expect(provider.getMemoryMcpStatus()).toMatchObject({
      status: 'unknown',
      connected: false,
    });

    (provider as any).client = {};
    expect(provider.getMemoryMcpStatus()).toMatchObject({
      status: 'ready',
      connected: true,
      degradedReasons: [],
    });

    (provider as any).mcpRegistration = { degraded: true, reason: 'test_reason' };
    expect(provider.getMemoryMcpStatus()).toMatchObject({
      status: 'degraded',
      connected: true,
      degradedReasons: ['test_reason'],
    });
  });
});

describe('MuseCodeSdkProvider session and turn lifecycle', () => {
  function createMockSession() {
    let approvalHandler: any = null;
    const mockTurn = {
      turnId: 'turn-test-1',
      deltas: async function* () {
        yield { delta: 'Hello ', field: 'text' };
        yield { delta: 'world!', field: 'text' };
      },
      items: async function* () {
        yield {
          kind: 'toolCall',
          callId: 'call-1',
          tool: 'bash',
          args: { command: 'ls -l' },
          status: 'complete',
        };
        yield {
          kind: 'agentMessage',
          text: 'Hello world!',
        };
      },
      completed: Promise.resolve({
        kind: 'completed' as const,
        params: {
          turnId: 'turn-test-1',
          terminal: 'succeeded' as const,
          durationMs: 120,
        },
      }),
    };

    const sessionObj = {
      sessionId: 'muse-remote-session-42',
      onApproval: vi.fn().mockImplementation((handler) => {
        approvalHandler = handler;
      }),
      sendUserTurn: vi.fn().mockResolvedValue(mockTurn),
      getApprovalHandler: () => approvalHandler,
    };
    return { sessionObj, mockTurn };
  }

  it('starts session and streams turn response with deltas and tool calls', async () => {
    const provider = new MuseCodeSdkProvider();
    const { sessionObj } = createMockSession();
    const mockClient = {
      startSession: vi.fn().mockResolvedValue(sessionObj),
    };
    (provider as any).client = mockClient;

    const routeId = await provider.createSession({
      cwd: '/home/k/project',
      model: 'muse-spark-1.3',
    });
    expect(routeId).toBeDefined();
    expect(mockClient.startSession).toHaveBeenCalledWith({
      workspaceRoot: '/home/k/project',
      modelId: 'muse-spark-1.3',
      providerId: 'meta',
    });

    const receivedDeltas: string[] = [];
    provider.onDelta((_sessionId, delta: MessageDelta) => {
      receivedDeltas.push(delta.delta);
    });

    const receivedTools: ToolCallEvent[] = [];
    provider.onToolCall((_sessionId, tool) => {
      receivedTools.push(tool);
    });

    let completedMessage: any = null;
    provider.onComplete((_sessionId, msg) => {
      completedMessage = msg;
    });

    await provider.send(routeId, 'Say hello');

    expect(receivedDeltas).toEqual(['Hello ', 'world!']);
    expect(receivedTools.length).toBeGreaterThanOrEqual(1);
    expect(receivedTools[0]).toMatchObject({
      id: 'call-1',
      name: 'bash',
    });
    expect(completedMessage).toMatchObject({
      content: 'Hello world!',
    });

    await provider.endSession(routeId);
  });

  it('handles approvals correctly via session.onApproval and respondApproval', async () => {
    const provider = new MuseCodeSdkProvider();
    const { sessionObj } = createMockSession();
    (provider as any).client = {
      startSession: vi.fn().mockResolvedValue(sessionObj),
    };

    const routeId = await provider.createSession({
      cwd: '/home/k/project',
    });

    let pendingApproval: ApprovalRequest | null = null;
    provider.onApprovalRequest((_sessionId, req) => {
      pendingApproval = req;
    });

    // Simulate Muse emitting an approval request
    const approvalHandler = sessionObj.getApprovalHandler();
    expect(approvalHandler).toBeTypeOf('function');

    let resolvedDecision: any = null;
    const approvalPromise = approvalHandler({
      approvalId: 'appr-99',
      toolName: 'bash',
      rawArgs: 'rm -rf /tmp/foo',
      availableChoices: [
        { choiceId: 'choice-yes', decision: 'approved', label: 'Allow' },
        { choiceId: 'choice-no', decision: 'denied', label: 'Deny' },
      ],
    }).then((res: any) => {
      resolvedDecision = res;
    });

    expect(pendingApproval).not.toBeNull();
    expect(pendingApproval!.tool).toBe('bash');
    expect(pendingApproval!.inputPreview).toBe('rm -rf /tmp/foo');

    // Respond approval
    await provider.respondApproval(routeId, pendingApproval!.id, true);

    await approvalPromise;
    expect(resolvedDecision).toEqual({ choiceId: 'choice-yes' });

    await provider.endSession(routeId);
  });

  it('cancels active turn using connection turn/interrupt command', async () => {
    const provider = new MuseCodeSdkProvider();
    const mockCommand = vi.fn().mockResolvedValue({});
    (provider as any).spawned = {
      connection: {
        command: mockCommand,
      },
    };

    const state = {
      routeId: 'route-cancel-test',
      cwd: '/tmp',
      museSessionId: 'muse-sess-1',
      activeTurnId: 'turn-999',
      inFlight: true,
      cancelled: false,
      pendingApprovals: new Map(),
    };
    (provider as any).sessions.set('route-cancel-test', state);

    await provider.cancel('route-cancel-test');

    expect(mockCommand).toHaveBeenCalledWith('turn/interrupt', {
      sessionId: 'muse-sess-1',
      turnId: 'turn-999',
    });
    expect(state.cancelled).toBe(true);
  });

  it('steers/appends to active turn using connection turn/steer command', async () => {
    const provider = new MuseCodeSdkProvider();
    const mockCommand = vi.fn().mockResolvedValue({});
    (provider as any).spawned = {
      connection: {
        command: mockCommand,
      },
    };

    const state = {
      routeId: 'route-steer-test',
      cwd: '/tmp',
      museSessionId: 'muse-sess-steer',
      activeTurnId: 'turn-123',
      inFlight: true,
      cancelled: false,
      pendingApprovals: new Map(),
    };
    (provider as any).sessions.set('route-steer-test', state);

    const result = await provider.notifyActiveDelegation('route-steer-test', {
      notificationId: 'notif-1',
      delegationId: 'deleg-1',
      sourceSessionName: 'source',
      text: 'Please also fix the typo',
    });

    expect(result).toBe('delivered');
    expect(mockCommand).toHaveBeenCalledWith('turn/steer', {
      commandId: expect.any(String),
      sessionId: 'muse-sess-steer',
      expectedTurnId: 'turn-123',
      input: [{ type: 'text', text: 'Please also fix the typo' }],
    });
  });

  it('returns stale when steering an idle or non-in-flight session', async () => {
    const provider = new MuseCodeSdkProvider();
    (provider as any).spawned = {
      connection: {
        command: vi.fn(),
      },
    };
    const state = {
      routeId: 'route-idle',
      cwd: '/tmp',
      museSessionId: 'muse-sess-idle',
      activeTurnId: null,
      inFlight: false,
      cancelled: false,
    };
    (provider as any).sessions.set('route-idle', state);

    const result = await provider.notifyActiveDelegation('route-idle', {
      notificationId: 'notif-2',
      delegationId: 'deleg-2',
      sourceSessionName: 'source',
      text: 'hello',
    });

    expect(result).toBe('stale');
  });

  it('streams subagent items and emits ToolCallEvent with SdkSubagentDetail', async () => {
    const provider = new MuseCodeSdkProvider();
    const mockTurn = {
      turnId: 'turn-subagent-1',
      deltas: async function* () {},
      items: async function* () {
        yield {
          kind: 'subagent',
          itemId: 'item-sub-1',
          subagentId: 'sub-agent-uuid-42',
          role: 'Researcher',
          agentPath: 'agents/research',
          objective: 'Analyze project codebase',
          status: 'inProgress',
          controlStatus: 'running',
        };
        yield {
          kind: 'subagent',
          itemId: 'item-sub-1',
          subagentId: 'sub-agent-uuid-42',
          role: 'Researcher',
          agentPath: 'agents/research',
          objective: 'Analyze project codebase',
          status: 'completed',
          controlStatus: 'closed',
          result: { text: 'Analysis finished successfully.' },
          durationMs: 450,
          usage: { totalTokens: 1500 },
        };
      },
      completed: Promise.resolve({
        kind: 'completed' as const,
        params: {
          turnId: 'turn-subagent-1',
          terminal: 'succeeded' as const,
          durationMs: 500,
        },
      }),
    };

    const sessionObj = {
      sessionId: 'muse-sess-subagent',
      onApproval: vi.fn(),
      sendUserTurn: vi.fn().mockResolvedValue(mockTurn),
    };
    (provider as any).client = {
      startSession: vi.fn().mockResolvedValue(sessionObj),
    };

    const routeId = await provider.createSession({ cwd: '/home/k/project' });
    const receivedTools: ToolCallEvent[] = [];
    provider.onToolCall((_sessionId, tool) => {
      receivedTools.push(tool);
    });

    await provider.send(routeId, 'Run research subagent');

    expect(receivedTools.length).toBe(2);
    expect(receivedTools[0].detail).toMatchObject({
      kind: SDK_SUBAGENT_DETAIL_KIND,
      summary: 'Muse sub-agent Researcher',
      meta: {
        isSdkSubagent: true,
        provider: SDK_SUBAGENT_PROVIDERS.MUSE_CODE_SDK,
        providerKind: SDK_SUBAGENT_PROVIDER_KINDS.MUSE_RUNTIME_AGENT,
        normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
        active: true,
        terminal: false,
        backgrounded: true,
      },
    });
    expect(receivedTools[1].detail).toMatchObject({
      kind: SDK_SUBAGENT_DETAIL_KIND,
      summary: 'Muse sub-agent Researcher',
      output: 'Analysis finished successfully.',
      meta: {
        isSdkSubagent: true,
        provider: SDK_SUBAGENT_PROVIDERS.MUSE_CODE_SDK,
        providerKind: SDK_SUBAGENT_PROVIDER_KINDS.MUSE_RUNTIME_AGENT,
        normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
        active: false,
        terminal: true,
        backgrounded: true,
        usageTotalTokens: 1500,
        usageDurationMs: 450,
      },
    });
  });

  it('propagates setSessionAgentId to connection via session/setModel', async () => {
    const provider = new MuseCodeSdkProvider();
    const mockCommand = vi.fn().mockResolvedValue({ status: 'ok' });
    (provider as any).spawned = {
      connection: {
        command: mockCommand,
      },
    };
    const sessionObj = {
      sessionId: 'muse-sess-model-1',
      onApproval: vi.fn(),
    };
    (provider as any).client = {
      startSession: vi.fn().mockResolvedValue(sessionObj),
    };

    const routeId = await provider.createSession({ cwd: '/home/k/project' });
    const sessionInfoUpdates: any[] = [];
    provider.onSessionInfo((_sessId, info) => {
      sessionInfoUpdates.push(info);
    });

    provider.setSessionAgentId(routeId, 'wander');

    expect(sessionInfoUpdates).toContainEqual({ model: 'wander' });
    expect(mockCommand).toHaveBeenCalledWith('session/setModel', expect.objectContaining({
      sessionId: 'muse-sess-model-1',
      model: { modelId: 'wander' },
    }));
  });

  it('propagates setSessionEffort to connection via session/setReasoningEffort', async () => {
    const provider = new MuseCodeSdkProvider();
    const mockCommand = vi.fn().mockResolvedValue({ status: 'ok' });
    (provider as any).spawned = {
      connection: {
        command: mockCommand,
      },
    };
    const sessionObj = {
      sessionId: 'muse-sess-effort-1',
      onApproval: vi.fn(),
    };
    (provider as any).client = {
      startSession: vi.fn().mockResolvedValue(sessionObj),
    };

    const routeId = await provider.createSession({ cwd: '/home/k/project' });
    const sessionInfoUpdates: any[] = [];
    provider.onSessionInfo((_sessId, info) => {
      sessionInfoUpdates.push(info);
    });

    provider.setSessionEffort(routeId, 'high');

    expect(sessionInfoUpdates).toContainEqual({ effort: 'high' });
    expect(mockCommand).toHaveBeenCalledWith('session/setReasoningEffort', expect.objectContaining({
      sessionId: 'muse-sess-effort-1',
      reasoningEffort: 'high',
    }));
  });

  it('propagates requestedModel on resume to connection via session/setModel', async () => {
    const provider = new MuseCodeSdkProvider();
    const mockCommand = vi.fn().mockResolvedValue({ status: 'ok' });
    (provider as any).spawned = {
      connection: {
        command: mockCommand,
      },
    };
    const sessionObj = {
      sessionId: 'muse-sess-resumed-1',
      onApproval: vi.fn(),
    };
    (provider as any).client = {
      resumeSession: vi.fn().mockResolvedValue(sessionObj),
    };

    const routeId = await provider.createSession({
      cwd: '/home/k/project',
      resumeId: 'muse-sess-resumed-1',
      agentId: 'wander',
    });

    expect(routeId).toBeDefined();
    expect(mockCommand).toHaveBeenCalledWith('session/setModel', expect.objectContaining({
      sessionId: 'muse-sess-resumed-1',
      model: { modelId: 'wander' },
    }));
  });

  it('normalizes legacy or misspelled model ids to supported muse models', () => {
    expect(normalizeMuseModelId('wonder')).toBe('muse-wonder');
    expect(normalizeMuseModelId('spark')).toBe('muse-spark');
    expect(normalizeMuseModelId('fast')).toBe('muse-fast');
    expect(normalizeMuseModelId('muse-wonder')).toBe('muse-wonder');
    expect(normalizeMuseModelId('muse-spark')).toBe('muse-spark');
    expect(normalizeMuseModelId('muse-spark-1.3')).toBe('muse-spark-1.3');
    expect(normalizeMuseModelId('muse-fast')).toBe('muse-fast');
    expect(normalizeMuseModelId('wander')).toBe('wander');
    expect(normalizeMuseModelId('wander-code')).toBe('muse-spark-1.3');
    expect(normalizeMuseModelId('wander-fast')).toBe('muse-fast');
    expect(normalizeMuseModelId('wander-pro')).toBe('muse-wonder');
    expect(normalizeMuseModelId('')).toBe('muse-spark-1.3');
    expect(normalizeMuseModelId(undefined)).toBe('muse-spark-1.3');
  });
});
