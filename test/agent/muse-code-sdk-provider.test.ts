import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_MUSE_MODELS,
  MUSE_CODE_SDK_PROVIDER_ID,
  MuseCodeSdkProvider,
  buildMuseServeArgs,
  buildMuseUsage,
  normalizeMuseModelId,
  resolveMusePermissionPosture,
} from '../../src/agent/providers/muse-code-sdk.js';
import { __testing__ as relayTesting } from '../../src/daemon/transport-relay.js';
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

const relayNormalizeUsageUpdatePayload = relayTesting.normalizeUsageUpdatePayload;

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
      expect.arrayContaining(['muse-wonder-full-1.0', 'muse-wonder-1.0', 'muse-spark-1.3', 'muse-spark-1.2']),
    );
    expect(result.defaultModel).toBe('muse-wonder-full-1.0');
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
      approvalMode: 'allowAll',
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
    await vi.waitFor(() => expect(completedMessage).not.toBeNull());

    // transport-relay contract: each frame carries the cumulative text so far.
    expect(receivedDeltas).toEqual(['Hello ', 'Hello world!']);
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

  it('canonicalizes a symlinked workspace root before starting Muse', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'muse-workspace-'));
    const realRoot = join(tempRoot, 'real-project');
    const nestedAlias = join(tempRoot, 'nested-alias');
    const symlinkRoot = join(tempRoot, 'project-alias');
    mkdirSync(realRoot);
    symlinkSync(realRoot, nestedAlias, 'dir');
    symlinkSync(nestedAlias, symlinkRoot, 'dir');

    try {
      const provider = new MuseCodeSdkProvider();
      const { sessionObj } = createMockSession();
      const startSession = vi.fn().mockResolvedValue(sessionObj);
      (provider as any).client = { startSession };

      await provider.createSession({ cwd: symlinkRoot, model: 'muse-spark-1.3' });

      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
        workspaceRoot: realpathSync.native(realRoot),
      }));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('canonicalizes the fallback start when a stale resume id is supplied through a symlink', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'muse-workspace-'));
    const realRoot = join(tempRoot, 'real-project');
    const symlinkRoot = join(tempRoot, 'project-alias');
    mkdirSync(realRoot);
    symlinkSync(realRoot, symlinkRoot, 'dir');

    try {
      const provider = new MuseCodeSdkProvider();
      const { sessionObj } = createMockSession();
      const resumeSession = vi.fn().mockRejectedValue(new Error('session stale-id not found'));
      const startSession = vi.fn().mockResolvedValue(sessionObj);
      (provider as any).client = { resumeSession, startSession };

      await provider.createSession({ cwd: symlinkRoot, resumeId: 'stale-id' });

      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
        workspaceRoot: realpathSync.native(realRoot),
      }));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps a normalized absolute workspace root when the directory does not exist', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'muse-workspace-'));
    const missingRoot = join(tempRoot, 'missing-project');

    try {
      const provider = new MuseCodeSdkProvider();
      const { sessionObj } = createMockSession();
      const startSession = vi.fn().mockResolvedValue(sessionObj);
      (provider as any).client = { startSession };

      await provider.createSession({ cwd: missingRoot, model: 'muse-spark-1.3' });

      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
        workspaceRoot: missingRoot,
      }));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects a refused native submission without leaving the session busy or marking system context sent', async () => {
    const provider = new MuseCodeSdkProvider();
    const { sessionObj } = createMockSession();
    sessionObj.sendUserTurn.mockRejectedValue(new Error('native submission refused'));
    (provider as any).client = { startSession: vi.fn().mockResolvedValue(sessionObj) };
    const routeId = await provider.createSession({ sessionKey: 'refused', cwd: process.cwd() });
    await expect(provider.send(routeId, 'hello')).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR, message: 'native submission refused', recoverable: true,
    });
    expect(provider.getActiveWorkSnapshot(routeId)?.activeWorkCount).toBe(0);
    expect((provider as any).sessions.get(routeId).sessionSystemTextSent).toBe(false);
  });

  it('is already idle inside onComplete so the runtime can flip the session idle (stuck "working" regression)', async () => {
    const provider = new MuseCodeSdkProvider();
    const { sessionObj } = createMockSession();
    (provider as any).client = { startSession: vi.fn().mockResolvedValue(sessionObj) };
    const routeId = await provider.createSession({ cwd: '/home/k/project', model: 'muse-spark-1.3' });

    const inFlightSeenInsideCallback: boolean[] = [];
    provider.onComplete((sessionId) => {
      inFlightSeenInsideCallback.push((provider as any).sessions.get(sessionId).inFlight);
    });

    await provider.send(routeId, 'Say hello');

    await vi.waitFor(() => expect(inFlightSeenInsideCallback).toEqual([false]));
    await provider.endSession(routeId);
  });

  it('is already idle inside onError when the turn fails', async () => {
    const provider = new MuseCodeSdkProvider();
    const { sessionObj, mockTurn } = createMockSession();
    (mockTurn as any).completed = Promise.resolve({
      kind: 'completed' as const,
      params: { turnId: 'turn-test-1', terminal: 'failed' as const, error: { message: 'boom', retryable: false } },
    });
    (provider as any).client = { startSession: vi.fn().mockResolvedValue(sessionObj) };
    const routeId = await provider.createSession({ cwd: '/home/k/project', model: 'muse-spark-1.3' });

    const inFlightSeenInsideCallback: boolean[] = [];
    provider.onError((sessionId) => {
      inFlightSeenInsideCallback.push((provider as any).sessions.get(sessionId).inFlight);
    });

    await provider.send(routeId, 'Say hello');

    await vi.waitFor(() => expect(inFlightSeenInsideCallback).toEqual([false]));
    await provider.endSession(routeId);
  });

  it('does not clobber a follow-up turn started from inside onComplete', async () => {
    const provider = new MuseCodeSdkProvider();
    const { sessionObj, mockTurn } = createMockSession();
    // The second turn never completes, so it must stay in flight after the first send() returns.
    let secondTurnStarted = false;
    sessionObj.sendUserTurn
      .mockResolvedValueOnce(mockTurn)
      .mockImplementationOnce(async () => {
        secondTurnStarted = true;
        return {
          turnId: 'turn-test-2',
          deltas: async function* () {},
          items: async function* () {},
          completed: new Promise(() => {}),
        };
      });
    (provider as any).client = { startSession: vi.fn().mockResolvedValue(sessionObj) };
    const routeId = await provider.createSession({ cwd: '/home/k/project', model: 'muse-spark-1.3' });

    provider.onComplete((sessionId) => {
      // What the runtime does when it drains a queued message on idle.
      void provider.send(sessionId, 'queued follow-up');
    });

    await provider.send(routeId, 'first');
    await new Promise((r) => setTimeout(r, 0));

    expect(secondTurnStarted).toBe(true);
    expect((provider as any).sessions.get(routeId).inFlight).toBe(true);
    expect((provider as any).sessions.get(routeId).activeTurnId).toBe('turn-test-2');
  });

  describe('first-activity watchdog (stalled upstream stream)', () => {
    const ENV = 'IMCODES_MUSE_FIRST_ACTIVITY_TIMEOUT_MS';
    let prevEnv: string | undefined;
    beforeEach(() => {
      prevEnv = process.env[ENV];
      process.env[ENV] = '40';
    });
    afterEach(() => {
      vi.useRealTimers();
      if (prevEnv === undefined) delete process.env[ENV]; else process.env[ENV] = prevEnv;
    });

    function stalledTurn(onInterrupt?: () => void) {
      let settle!: (v: unknown) => void;
      const completed = new Promise((resolve) => { settle = resolve; });
      const turn = {
        turnId: 'turn-stalled',
        // The user's own message is replayed immediately and must NOT count as agent activity.
        items: async function* () { yield { kind: 'userMessage', itemId: 'u1', text: 'hi' }; await completed; },
        deltas: async function* () { await completed; },
        completed,
      };
      const command = vi.fn().mockImplementation(async (method: string) => {
        if (method === 'turn/interrupt') {
          onInterrupt?.();
          settle({ kind: 'completed', params: { turnId: 'turn-stalled', terminal: 'cancelled' } });
        }
        return {};
      });
      return { turn, command, settle };
    }

    it('interrupts a turn with no agent activity and reports a recoverable error', async () => {
      const provider = new MuseCodeSdkProvider();
      const { sessionObj } = createMockSession();
      const { turn, command } = stalledTurn();
      sessionObj.sendUserTurn.mockResolvedValue(turn);
      (provider as any).client = { startSession: vi.fn().mockResolvedValue(sessionObj) };
      (provider as any).spawned = { connection: { command } };
      const routeId = await provider.createSession({ cwd: '/home/k/project', model: 'muse-wonder-full-1.0' });

      const errors: Array<{ message: string; recoverable: boolean }> = [];
      const inFlightInsideError: boolean[] = [];
      provider.onError((sessionId, err) => {
        errors.push(err as any);
        inFlightInsideError.push((provider as any).sessions.get(sessionId).inFlight);
      });
      const completes: unknown[] = [];
      provider.onComplete((_s, m) => completes.push(m));

      await provider.send(routeId, 'hi');

      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(command).toHaveBeenCalledWith('turn/interrupt', expect.objectContaining({ turnId: 'turn-stalled' }));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ recoverable: true });
      expect(errors[0].message).toMatch(/no response/i);
      expect(inFlightInsideError).toEqual([false]);
      expect(completes).toHaveLength(0);
      await provider.endSession(routeId);
    });

    it('gives up on a host that never answers the interrupt (bounded, not an infinite wait)', async () => {
      vi.useFakeTimers();
      const provider = new MuseCodeSdkProvider();
      const { sessionObj } = createMockSession();
      // A host that ignores turn/interrupt: `completed` never settles.
      const never = new Promise(() => {});
      sessionObj.sendUserTurn.mockResolvedValue({
        turnId: 'turn-deaf',
        items: async function* () { await never; },
        deltas: async function* () { await never; },
        completed: never,
      });
      (provider as any).client = { startSession: vi.fn().mockResolvedValue(sessionObj) };
      (provider as any).spawned = { connection: { command: vi.fn().mockResolvedValue({}) } };
      const routeId = await provider.createSession({ cwd: '/home/k/project', model: 'muse-wonder-full-1.0' });

      const errors: string[] = [];
      provider.onError((_s, err) => errors.push(err.message));

      const sending = provider.send(routeId, 'hi');
      await vi.advanceTimersByTimeAsync(40 + 10_000 + 50);
      await sending;

      expect(errors).toHaveLength(1);
      expect((provider as any).sessions.get(routeId).inFlight).toBe(false);
      await provider.endSession(routeId);
    });

    it('does not fire when the model produces output, even if the turn is slow overall', async () => {
      const provider = new MuseCodeSdkProvider();
      const { sessionObj } = createMockSession();
      let settle!: (v: unknown) => void;
      const completed = new Promise((resolve) => { settle = resolve; });
      sessionObj.sendUserTurn.mockResolvedValue({
        turnId: 'turn-slow',
        deltas: async function* () { yield { delta: 'ok', field: 'text' }; await completed; },
        items: async function* () { await completed; },
        completed,
      });
      const command = vi.fn().mockResolvedValue({});
      (provider as any).client = { startSession: vi.fn().mockResolvedValue(sessionObj) };
      (provider as any).spawned = { connection: { command } };
      const routeId = await provider.createSession({ cwd: '/home/k/project', model: 'muse-wonder-full-1.0' });

      const errors: string[] = [];
      provider.onError((_s, err) => errors.push(err.message));
      let message: any = null;
      provider.onComplete((_s, m) => { message = m; });

      const sending = provider.send(routeId, 'hi');
      // Well past the watchdog timeout, with output already seen (the post-reply reminder-check tail).
      await new Promise((r) => setTimeout(r, 120));
      expect(command).not.toHaveBeenCalledWith('turn/interrupt', expect.anything());
      settle({ kind: 'completed', params: { turnId: 'turn-slow', terminal: 'completed', durationMs: 1 } });
      await sending;

      expect(errors).toEqual([]);
      await vi.waitFor(() => expect(message).toMatchObject({ content: 'ok' }));
      await provider.endSession(routeId);
    });
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

    await vi.waitFor(() => expect(receivedTools.length).toBe(2));
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

    provider.setSessionAgentId(routeId, 'muse-wonder-full-1.0');

    expect(sessionInfoUpdates).toContainEqual({ model: 'muse-wonder-full-1.0' });
    expect(mockCommand).toHaveBeenCalledWith('session/setModel', expect.objectContaining({
      sessionId: 'muse-sess-model-1',
      model: { modelId: 'muse-wonder-full-1.0' },
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
      agentId: 'muse-spark-1.3',
    });

    expect(routeId).toBeDefined();
    expect(mockCommand).toHaveBeenCalledWith('session/setModel', expect.objectContaining({
      sessionId: 'muse-sess-resumed-1',
      model: { modelId: 'muse-spark-1.3' },
    }));
  });

  it('falls back once to a new session when a resume id is explicitly stale', async () => {
    const provider = new MuseCodeSdkProvider();
    const { sessionObj } = createMockSession();
    const resumedSession = {
      ...sessionObj,
      sessionId: 'muse-sess-fresh-after-stale-resume',
    };
    const resumeSession = vi.fn().mockRejectedValue(new Error('session old-resume-id not found'));
    const startSession = vi.fn().mockResolvedValue(resumedSession);
    (provider as any).client = { resumeSession, startSession };

    const routeId = await provider.createSession({
      cwd: '/home/k/project',
      resumeId: 'old-resume-id',
    });

    expect(resumeSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: '/home/k/project',
      providerId: 'meta',
    }));
    expect((provider as any).sessions.get(routeId).sessionSystemTextSent).toBe(false);
  });

  it('does not hide unknown resume failures behind a new session', async () => {
    const provider = new MuseCodeSdkProvider();
    const resumeSession = vi.fn().mockRejectedValue(new Error('upstream connection reset'));
    const startSession = vi.fn();
    (provider as any).client = { resumeSession, startSession };

    await expect(provider.createSession({
      cwd: '/home/k/project',
      resumeId: 'resume-id',
    })).rejects.toMatchObject({
      message: expect.stringContaining('upstream connection reset'),
    });
    expect(startSession).not.toHaveBeenCalled();
  });

  describe('maximum-permission posture (--dangerously-skip-permissions equivalent)', () => {
    it('is on by default: allowAll approval mode and a disabled host sandbox', () => {
      expect(resolveMusePermissionPosture({})).toEqual({ maxPermissions: true, approvalMode: 'allowAll' });
      expect(resolveMusePermissionPosture(null)).toEqual({ maxPermissions: true, approvalMode: 'allowAll' });

      const args = buildMuseServeArgs({}, 'muse-wonder-1.0');
      expect(args).toEqual(['serve', '--trust-workspace', '--disable-sandbox', '--provider', 'meta', '--model', 'muse-wonder-1.0']);
    });

    it('adds --disable-sandbox to caller-supplied args exactly once', () => {
      const withFlag = buildMuseServeArgs({ args: ['--trust-workspace', '--disable-sandbox'] }, 'm');
      expect(withFlag.filter((a) => a === '--disable-sandbox')).toHaveLength(1);
      const without = buildMuseServeArgs({ args: ['--trust-workspace'] }, 'm');
      expect(without).toContain('--disable-sandbox');
    });

    it('can be opted out of with dangerouslySkipPermissions: false', () => {
      expect(resolveMusePermissionPosture({ dangerouslySkipPermissions: false })).toEqual({ maxPermissions: false, approvalMode: undefined });
      const args = buildMuseServeArgs({ dangerouslySkipPermissions: false }, 'm');
      expect(args).not.toContain('--disable-sandbox');
    });

    it('honors an explicit valid approvalMode and ignores an invalid one', () => {
      expect(resolveMusePermissionPosture({ approvalMode: 'onRequest' }).approvalMode).toBe('onRequest');
      expect(resolveMusePermissionPosture({ approvalMode: 'onRequest', dangerouslySkipPermissions: false }))
        .toEqual({ maxPermissions: false, approvalMode: 'onRequest' });
      expect(resolveMusePermissionPosture({ approvalMode: 'nonsense' }).approvalMode).toBe('allowAll');
    });

    it('starts new sessions in allowAll, or without a mode when opted out', async () => {
      for (const [cfg, expected] of [[{}, 'allowAll'], [{ dangerouslySkipPermissions: false }, undefined], [{ approvalMode: 'onRequest' }, 'onRequest']] as const) {
        const provider = new MuseCodeSdkProvider();
        const { sessionObj } = createMockSession();
        const startSession = vi.fn().mockResolvedValue(sessionObj);
        (provider as any).client = { startSession };
        (provider as any).config = cfg;
        await provider.createSession({ cwd: '/home/k/project', model: 'muse-wonder-1.0' });
        const params = startSession.mock.calls[0][0];
        if (expected === undefined) expect(params).not.toHaveProperty('approvalMode');
        else expect(params.approvalMode).toBe(expected);
      }
    });

    it('selects allowAll on a resumed session via session/setApprovalMode (resume has no such member)', async () => {
      const provider = new MuseCodeSdkProvider();
      const mockCommand = vi.fn().mockResolvedValue({ status: 'ok' });
      (provider as any).spawned = { connection: { command: mockCommand } };
      (provider as any).client = {
        resumeSession: vi.fn().mockResolvedValue({ sessionId: 'muse-sess-resumed-2', onApproval: vi.fn() }),
      };
      (provider as any).config = {};

      await provider.createSession({ cwd: '/home/k/project', resumeId: 'muse-sess-resumed-2', agentId: 'muse-wonder-1.0' });

      expect(mockCommand).toHaveBeenCalledWith('session/setApprovalMode', expect.objectContaining({
        sessionId: 'muse-sess-resumed-2',
        mode: 'allowAll',
      }));
    });

    it('does not fail session resume when setting the approval mode errors', async () => {
      const provider = new MuseCodeSdkProvider();
      const mockCommand = vi.fn().mockImplementation(async (method: string) => {
        if (method === 'session/setApprovalMode') throw new Error('rejected');
        return {};
      });
      (provider as any).spawned = { connection: { command: mockCommand } };
      (provider as any).client = {
        resumeSession: vi.fn().mockResolvedValue({ sessionId: 'muse-sess-resumed-3', onApproval: vi.fn() }),
      };
      (provider as any).config = {};

      await expect(
        provider.createSession({ cwd: '/home/k/project', resumeId: 'muse-sess-resumed-3', agentId: 'muse-wonder-1.0' }),
      ).resolves.toBeDefined();
    });
  });

  describe('context window usage sync', () => {
    // Values captured from a live muse-wonder-1.0 run (second turn, with a tool call).
    const liveFold = (overrides: { context?: unknown; token?: unknown } = {}) => ({
      sessionState: {
        get: (family: string) => {
          if (family === 'session/contextUsage') {
            return 'context' in overrides
              ? overrides.context
              : { usedTokens: 33537, windowTokens: 1007997, pressure: 'normal' };
          }
          if (family === 'session/tokenUsage') {
            return 'token' in overrides
              ? overrides.token
              : {
                promptTokens: 33522,
                totalTokens: 33537,
                usage: { inputTokens: 33522, outputTokens: 15, cachedTokens: 33140, cacheReadTokens: 33140, cacheWriteTokens: 0, reasoningTokens: 4 },
                cumulative: { promptTokens: 99951, outputTokens: 205, totalTokens: 100156, cacheReadTokens: 66280 },
              };
          }
          return undefined;
        },
      },
    });

    it('reports the latest counted-once occupancy split into non-cached input and cache, with the real window', () => {
      const usage = buildMuseUsage({ fold: liveFold() });
      expect(usage).toEqual({
        input_tokens: 397,
        cache_read_input_tokens: 33140,
        output_tokens: 15,
        model_context_window: 1007997,
      });
      // The UI meter is input + cache and must equal the host's own occupancy.
      expect(usage!.input_tokens + (usage!.cache_read_input_tokens ?? 0)).toBe(33537);
    });

    it('uses the latest model call, never the summed cumulative counters', () => {
      const usage = buildMuseUsage({ fold: liveFold() })!;
      expect(usage.input_tokens + (usage.cache_read_input_tokens ?? 0)).toBeLessThan(99951);
    });

    it('omits the cache field when nothing was cached', () => {
      const usage = buildMuseUsage({
        fold: liveFold({
          context: { usedTokens: 33210, windowTokens: 1007997, pressure: 'normal' },
          token: { promptTokens: 33194, usage: { inputTokens: 33194, outputTokens: 16, cachedTokens: 0 } },
        }),
      });
      expect(usage).toEqual({ input_tokens: 33210, output_tokens: 16, model_context_window: 1007997 });
    });

    it('omits the window when the host reports none instead of inventing one', () => {
      const usage = buildMuseUsage({
        fold: liveFold({ context: { usedTokens: 1000, pressure: 'normal' } }),
      })!;
      expect(usage).not.toHaveProperty('model_context_window');
    });

    it('falls back to the token counters when the context snapshot is absent', () => {
      const usage = buildMuseUsage({ fold: liveFold({ context: null }) })!;
      // promptTokens 33522 + latest output 15
      expect(usage.input_tokens + (usage.cache_read_input_tokens ?? 0)).toBe(33537);
    });

    it('falls back to the turn counters when there is no session state', () => {
      expect(buildMuseUsage({}, { inputTokens: 1000, cachedTokens: 400, outputTokens: 50 })).toEqual({
        input_tokens: 650,
        cache_read_input_tokens: 400,
        output_tokens: 50,
      });
    });

    it('never clamps cache above the occupancy', () => {
      const usage = buildMuseUsage({
        fold: liveFold({
          context: { usedTokens: 100, pressure: 'normal' },
          token: { promptTokens: 90, usage: { inputTokens: 90, outputTokens: 10, cachedTokens: 5000 } },
        }),
      })!;
      expect(usage.input_tokens).toBe(0);
      expect(usage.cache_read_input_tokens).toBe(100);
    });

    it('returns undefined rather than inventing numbers when nothing is available', () => {
      expect(buildMuseUsage({})).toBeUndefined();
      expect(buildMuseUsage(null)).toBeUndefined();
      expect(buildMuseUsage({ fold: liveFold({ context: null, token: null }) })).toBeUndefined();
    });

    it('does not throw when the session state cannot be read', () => {
      const exploding = { fold: { sessionState: { get: () => { throw new Error('boom'); } } } };
      // Occupancy follows the host's own definition (prompt + output of the driving call): 10 + 2.
      expect(buildMuseUsage(exploding, { inputTokens: 10, outputTokens: 2 })).toEqual({ input_tokens: 12, output_tokens: 2 });
      expect(buildMuseUsage(exploding)).toBeUndefined();
    });

    it('attaches the normalized usage to the completion message, which the relay turns into the UI meter payload', async () => {
      const provider = new MuseCodeSdkProvider();
      const { sessionObj } = createMockSession();
      (sessionObj as any).fold = liveFold();
      (provider as any).client = { startSession: vi.fn().mockResolvedValue(sessionObj) };
      const routeId = await provider.createSession({ cwd: '/home/k/project', model: 'muse-wonder-1.0' });

      let message: any = null;
      provider.onComplete((_s, m) => { message = m; });
      await provider.send(routeId, 'hi');

      await vi.waitFor(() => expect(message).not.toBeNull());
      expect(message.metadata.usage).toEqual({
        input_tokens: 397,
        cache_read_input_tokens: 33140,
        output_tokens: 15,
        model_context_window: 1007997,
      });

      const payload = relayNormalizeUsageUpdatePayload('deck_muse_ctx', message.metadata.usage, message.metadata.model) as Record<string, number>;
      expect(payload.inputTokens + payload.cacheTokens).toBe(33537);
      expect(payload.contextWindow).toBe(1007997);
      await provider.endSession(routeId);
    });
  });

  it('normalizes legacy or misspelled model ids to supported muse models', () => {
    expect(normalizeMuseModelId('wonder')).toBe('muse-wonder-full-1.0');
    expect(normalizeMuseModelId('spark')).toBe('muse-spark-1.3');
    expect(normalizeMuseModelId('fast')).toBe('muse-wonder-full-1.0');
    expect(normalizeMuseModelId('muse-wonder')).toBe('muse-wonder-full-1.0');
    expect(normalizeMuseModelId('muse-spark')).toBe('muse-spark-1.3');
    expect(normalizeMuseModelId('muse-spark-1.3')).toBe('muse-spark-1.3');
    expect(normalizeMuseModelId('muse-fast')).toBe('muse-wonder-full-1.0');
    expect(normalizeMuseModelId('wander')).toBe('muse-wonder-full-1.0');
    expect(normalizeMuseModelId('wander-code')).toBe('muse-wonder-full-1.0');
    expect(normalizeMuseModelId('wander-fast')).toBe('muse-wonder-full-1.0');
    expect(normalizeMuseModelId('wander-pro')).toBe('muse-wonder-full-1.0');
    expect(normalizeMuseModelId('')).toBe('muse-wonder-full-1.0');
    expect(normalizeMuseModelId(undefined)).toBe('muse-wonder-full-1.0');
  });
});
