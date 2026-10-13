import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MUSE_MODELS,
  MUSE_CODE_SDK_PROVIDER_ID,
  MuseCodeSdkProvider,
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
      expect.arrayContaining(['muse-spark', 'muse-wonder', 'muse-fast']),
    );
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
      model: 'muse-spark',
    });
    expect(routeId).toBeDefined();
    expect(mockClient.startSession).toHaveBeenCalledWith({
      workspaceRoot: '/home/k/project',
      modelId: 'muse-spark',
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
});
