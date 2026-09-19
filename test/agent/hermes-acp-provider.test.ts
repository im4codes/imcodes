import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
} from '../../shared/agent-delegation.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../shared/hermes-agent.js';
import { PROVIDER_ERROR_CODES, type ToolCallEvent } from '../../src/agent/transport-provider.js';
import {
  HermesAcpProvider,
  resolveHermesBinaryPath,
} from '../../src/agent/providers/hermes-acp.js';
import { KimiSdkProvider } from '../../src/agent/providers/kimi-sdk.js';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/util/logger.js', () => ({ default: loggerMock }));

beforeEach(() => {
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
  loggerMock.debug.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function attachActiveRoute(provider: HermesAcpProvider, routeId = 'hermes-route') {
  const acpSessionId = `acp-${routeId}`;
  const state = {
    routeId,
    cwd: '/tmp/project',
    acpSessionId,
    loaded: true,
    modeApplied: true,
    promptInFlight: true,
    promptSubmittedGeneration: 4,
    activePromptAdmissions: new Map(),
    turnGeneration: 4,
    settledGeneration: 3,
    replaying: false,
    cancelled: false,
    currentMessageId: null,
    currentText: '',
    toolCalls: new Map(),
    emittedToolSignatures: new Map(),
    lastStatusSignature: null,
  };
  (provider as any).sessions.set(routeId, state);
  (provider as any).registerAcpRoute(acpSessionId, routeId);
  return { acpSessionId, state };
}

function serializedHermesLoggerCalls(): string {
  return JSON.stringify([
    ...loggerMock.info.mock.calls,
    ...loggerMock.warn.mock.calls,
    ...loggerMock.error.mock.calls,
    ...loggerMock.debug.mock.calls,
  ]);
}

describe('HermesAcpProvider', () => {
  it('declares the official Hermes ACP streaming, restore, approval, and native steer contract', () => {
    const provider = new HermesAcpProvider();
    expect(provider.id).toBe(HERMES_AGENT_PROVIDER_ID);
    expect(provider.capabilities).toMatchObject({
      streaming: true,
      toolCalling: true,
      approval: true,
      sessionRestore: true,
      multiTurn: true,
      attachments: true,
      activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
      compact: {
        execution: 'slash-command',
        providerCommand: '/compress',
        verified: true,
      },
    });
    expect((provider as any).profile.args).toEqual(['acp']);
  });

  it('forwards local files and images through Hermes-supported ACP resource links', () => {
    const provider = new HermesAcpProvider();
    const blocks = (provider as any).buildPromptContent({
      assembledMessage: 'inspect attachments',
      attachments: [
        {
          id: 'image-1',
          daemonPath: '/tmp/hermes image.png',
          originalName: 'capture.png',
          mime: 'image/png',
          size: 123,
          type: 'image',
        },
        {
          id: 'relative-file',
          daemonPath: 'unsafe-relative.txt',
          type: 'file',
        },
      ],
      context: {},
    }, false);

    expect(blocks).toEqual([
      { type: 'text', text: 'inspect attachments' },
      {
        type: 'resource_link',
        name: 'capture.png',
        title: 'capture.png',
        uri: 'file:///tmp/hermes%20image.png',
        mimeType: 'image/png',
        size: 123,
      },
    ]);
  });

  it('surfaces a setup action when Hermes has no configured model catalog', async () => {
    const provider = new HermesAcpProvider();
    vi.spyOn(KimiSdkProvider.prototype, 'listModels').mockResolvedValue({ models: [] });

    await expect(provider.listModels(true)).resolves.toEqual({
      models: [],
      isAuthenticated: false,
      error: expect.stringContaining('hermes model'),
    });
  });

  it('never creates durable ACP probe sessions while refreshing the model picker', async () => {
    const provider = new HermesAcpProvider();
    const newSession = vi.fn();
    (provider as any).connection = { newSession };
    (provider as any).initPromise = Promise.resolve();

    await expect(provider.listModels(true)).resolves.toMatchObject({
      models: [],
      isAuthenticated: false,
      error: expect.stringContaining('hermes model'),
    });
    await expect(provider.listModels(true)).resolves.toMatchObject({ models: [] });

    expect(newSession).not.toHaveBeenCalled();

    (provider as any).cachedModels = [{ id: 'nous-free', name: 'Nous Free' }];
    (provider as any).cachedDefaultModel = 'nous-free';
    await expect(provider.listModels(true)).resolves.toMatchObject({
      models: [{ id: 'nous-free', name: 'Nous Free' }],
      defaultModel: 'nous-free',
      isAuthenticated: true,
    });
    expect(newSession).not.toHaveBeenCalled();
  });

  it('updates and clears the metadata-only model catalog from real ACP session responses', async () => {
    const provider = new HermesAcpProvider();
    const newSession = vi.fn().mockResolvedValue({
      sessionId: 'acp-catalog-new',
      models: {
        currentModelId: 'hermes-free-v1',
        availableModels: [{ modelId: 'hermes-free-v1', name: 'Hermes Free v1' }],
      },
    });
    const loadSession = vi.fn()
      .mockResolvedValueOnce({
        models: {
          currentModelId: 'hermes-free-v2',
          availableModels: [{ modelId: 'hermes-free-v2', name: 'Hermes Free v2' }],
        },
      })
      .mockResolvedValueOnce({
        models: { availableModels: [] },
      });
    (provider as any).connection = { newSession, loadSession };
    (provider as any).initPromise = Promise.resolve();

    const freshRoute = await provider.createSession({
      sessionKey: 'hermes-catalog-new',
      cwd: '/tmp/hermes-catalog',
    });
    await (provider as any).ensureSessionReady(
      freshRoute,
      (provider as any).sessions.get(freshRoute),
    );
    await expect(provider.listModels(true)).resolves.toEqual({
      models: [{ id: 'hermes-free-v1', name: 'Hermes Free v1' }],
      defaultModel: 'hermes-free-v1',
      isAuthenticated: true,
    });

    const updatedRoute = await provider.createSession({
      sessionKey: 'hermes-catalog-load-updated',
      cwd: '/tmp/hermes-catalog',
      resumeId: 'acp-catalog-existing-updated',
    });
    await (provider as any).ensureSessionReady(
      updatedRoute,
      (provider as any).sessions.get(updatedRoute),
    );
    await expect(provider.listModels(true)).resolves.toEqual({
      models: [{ id: 'hermes-free-v2', name: 'Hermes Free v2' }],
      defaultModel: 'hermes-free-v2',
      isAuthenticated: true,
    });

    const clearedRoute = await provider.createSession({
      sessionKey: 'hermes-catalog-load-empty',
      cwd: '/tmp/hermes-catalog',
      resumeId: 'acp-catalog-existing-empty',
    });
    await (provider as any).ensureSessionReady(
      clearedRoute,
      (provider as any).sessions.get(clearedRoute),
    );
    await expect(provider.listModels(true)).resolves.toMatchObject({
      models: [],
      isAuthenticated: false,
      error: expect.stringContaining('hermes model'),
    });
    expect(newSession).toHaveBeenCalledOnce();
    expect(loadSession).toHaveBeenCalledTimes(2);
  });

  it('honors an explicit binary path before probing official installer layouts', () => {
    expect(resolveHermesBinaryPath({ binaryPath: '/opt/hermes/bin/hermes' })).toBe('/opt/hermes/bin/hermes');
  });

  it('passes the resolved executable into the shared ACP connection', async () => {
    const connect = vi.spyOn(KimiSdkProvider.prototype, 'connect').mockResolvedValue();
    const provider = new HermesAcpProvider();
    await provider.connect({ binaryPath: '/opt/hermes/bin/hermes', env: { TEST_ONLY: 'kept' } });
    expect(connect).toHaveBeenCalledWith({
      binaryPath: '/opt/hermes/bin/hermes',
      env: { TEST_ONLY: 'kept' },
    });
  });

  it('accepts only the official Hermes server with durable ACP session capabilities', async () => {
    const provider = new HermesAcpProvider();
    await expect((provider as any).validateConnectedAgent({
      protocolVersion: 1,
      agentInfo: { name: 'hermes-agent', version: '0.20.5' },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, fork: {} },
      },
    }, {})).resolves.toBeUndefined();

    await expect((provider as any).validateConnectedAgent({
      protocolVersion: 1,
      agentInfo: { name: 'not-hermes' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } },
    }, {})).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR });
  });

  it.each([
    [{ list: null, resume: {} }, 'null list'],
    [{ list: {}, resume: null }, 'null resume'],
    [{ list: 'yes', resume: {} }, 'non-object list'],
    [{ list: {}, resume: true }, 'non-object resume'],
    [{ list: {}, fork: {} }, 'missing resume'],
  ])('rejects incompatible durable ACP capabilities: %s (%s)', async (sessionCapabilities) => {
    const provider = new HermesAcpProvider();
    await expect((provider as any).validateConnectedAgent({
      protocolVersion: 1,
      agentInfo: { name: 'hermes-agent' },
      agentCapabilities: { loadSession: true, sessionCapabilities },
    }, {})).rejects.toMatchObject({ code: PROVIDER_ERROR_CODES.CONFIG_ERROR });
  });

  it('maps IM.codes append to Hermes /steer exactly once after the active prompt is admitted', async () => {
    const provider = new HermesAcpProvider();
    attachActiveRoute(provider);
    const tracker = {
      writeQueue: Promise.resolve(),
      abortController: new AbortController(),
    };
    const prompt = vi.fn(async () => ({ stopReason: 'end_turn' as const }));
    (provider as any).connection = { prompt, connection: tracker };
    const notification = {
      notificationId: 'hermes-append-1',
      delegationId: 'queue-append:hermes-append-1',
      sourceSessionName: 'deck_hermes_brain',
      text: 'incorporate this correction',
      deliveryKind: 'mcp_message' as const,
    };

    await expect(provider.notifyActiveDelegation('hermes-route', notification))
      .resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await expect(provider.notifyActiveDelegation('hermes-route', notification))
      .resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);

    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'acp-hermes-route',
      prompt: [{ type: 'text', text: '/steer incorporate this correction' }],
      messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }));
  });

  it('logs a post-admission Hermes /steer rejection without provider secrets or paths', async () => {
    const provider = new HermesAcpProvider();
    attachActiveRoute(provider);
    const plantedError = {
      code: 'PROVIDER_ERROR',
      message: 'token=PLANTED_HERMES_SECRET /Users/private/key',
      stack: 'stack /Users/private/key token=PLANTED_HERMES_SECRET',
      recoverable: false,
    };
    const tracker = {
      writeQueue: Promise.resolve(),
      abortController: new AbortController(),
    };
    const prompt = vi.fn(() => Promise.reject(plantedError));
    (provider as any).connection = { prompt, connection: tracker };

    await expect(provider.notifyActiveDelegation('hermes-route', {
      notificationId: 'hermes-private-log-steer',
      delegationId: 'delegation-private-log-steer',
      sourceSessionName: 'deck_private_source',
      text: 'append safely',
      deliveryKind: 'delegation_reply',
    })).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await vi.waitFor(() => {
      expect(loggerMock.warn).toHaveBeenCalledWith({
        provider: HERMES_AGENT_PROVIDER_ID,
        sessionId: 'hermes-route',
        errorCode: 'PROVIDER_ERROR',
      }, 'ACP active-turn queued prompt failed after submission');
    });

    expect(serializedHermesLoggerCalls()).not.toContain('PLANTED_HERMES_SECRET');
    expect(serializedHermesLoggerCalls()).not.toContain('/Users/private/key');
    expect(serializedHermesLoggerCalls()).not.toContain('stack');
  });

  it('sanitizes Hermes cancel, model-setting, and active-prompt write failures', async () => {
    const provider = new HermesAcpProvider();
    attachActiveRoute(provider);
    const plantedError = {
      code: 'token=PLANTED_HERMES_SECRET',
      message: 'api_key=PLANTED_HERMES_SECRET /Users/private/model-config',
      details: { credential: 'PLANTED_HERMES_SECRET' },
    };
    const cancel = vi.fn().mockRejectedValue(plantedError);
    const unstableSetSessionModel = vi.fn().mockRejectedValue(plantedError);
    (provider as any).connection = {
      cancel,
      unstable_setSessionModel: unstableSetSessionModel,
    };

    await provider.cancel('hermes-route');
    provider.setSessionAgentId('hermes-route', 'safe-model-id');
    await vi.waitFor(() => {
      expect(loggerMock.debug).toHaveBeenCalledWith({
        provider: HERMES_AGENT_PROVIDER_ID,
        sessionId: 'hermes-route',
        errorCode: 'unknown',
      }, 'ACP cancel notification failed (non-fatal)');
      expect(loggerMock.debug).toHaveBeenCalledWith({
        provider: HERMES_AGENT_PROVIDER_ID,
        agentId: 'safe-model-id',
        errorCode: 'unknown',
      }, 'unstable_setSessionModel failed (non-fatal)');
    });

    const writeFailureProvider = new HermesAcpProvider();
    attachActiveRoute(writeFailureProvider, 'hermes-write-failure');
    const prompt = vi.fn(() => new Promise(() => {}));
    (writeFailureProvider as any).connection = {
      prompt,
      connection: {
        writeQueue: Promise.reject(plantedError),
        abortController: new AbortController(),
      },
    };
    await expect(writeFailureProvider.notifyActiveDelegation('hermes-write-failure', {
      notificationId: 'hermes-private-log-write',
      delegationId: 'delegation-private-log-write',
      sourceSessionName: 'deck_private_source',
      text: 'append safely',
      deliveryKind: 'delegation_reply',
    })).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE);
    expect(loggerMock.debug).toHaveBeenCalledWith({
      provider: HERMES_AGENT_PROVIDER_ID,
      sessionId: 'hermes-write-failure',
      errorCode: 'unknown',
    }, 'ACP active-turn prompt write failed');

    expect(serializedHermesLoggerCalls()).not.toContain('PLANTED_HERMES_SECRET');
    expect(serializedHermesLoggerCalls()).not.toContain('/Users/private/model-config');
    expect(serializedHermesLoggerCalls()).not.toContain('credential');
  });

  it('bridges Hermes tool permissions and preserves provider cancellation', async () => {
    const provider = new HermesAcpProvider();
    const { acpSessionId } = attachActiveRoute(provider);
    const requests: Array<{ sessionId: string; id: string }> = [];
    provider.onApprovalRequest!((sessionId, request) => requests.push({ sessionId, id: request.id }));
    const cancel = vi.fn().mockResolvedValue(undefined);
    (provider as any).connection = { cancel };

    const client = (provider as any).createClientImpl();
    const pending = client.requestPermission({
      sessionId: acpSessionId,
      toolCall: { toolCallId: 'tool-approval', title: 'Run command' },
      options: [
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      ],
    });

    expect(requests).toHaveLength(1);
    await provider.respondApproval!('hermes-route', requests[0]!.id, true);
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });

    await provider.cancel('hermes-route');
    expect(cancel).toHaveBeenCalledWith({ sessionId: acpSessionId });
  });

  it('streams text and projects Hermes ACP tools and plan updates', () => {
    const provider = new HermesAcpProvider();
    const { acpSessionId } = attachActiveRoute(provider, 'hermes-events');
    const deltas: string[] = [];
    const tools: ToolCallEvent[] = [];
    provider.onDelta((_sessionId, delta) => deltas.push(delta.delta));
    provider.onToolCall((_, tool) => tools.push(tool));

    (provider as any).handleSessionUpdate({
      sessionId: acpSessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'assistant-1',
        content: { type: 'text', text: 'Hel' },
      },
    });
    (provider as any).handleSessionUpdate({
      sessionId: acpSessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'assistant-1',
        content: { type: 'text', text: 'lo' },
      },
    });
    (provider as any).handleSessionUpdate({
      sessionId: acpSessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read file',
        kind: 'read',
        status: 'in_progress',
        rawInput: { path: 'README.md' },
        content: [],
      },
    });
    (provider as any).handleSessionUpdate({
      sessionId: acpSessionId,
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Inspect', status: 'completed' },
          { content: 'Implement', status: 'in_progress' },
        ],
      },
    });

    expect(deltas).toEqual(['Hel', 'Hello']);
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-1', name: 'Read file', status: 'running' }),
      expect.objectContaining({
        id: `${HERMES_AGENT_PROVIDER_ID}-plan:hermes-events`,
        name: 'plan',
        status: 'running',
        input: {
          plan: [
            { content: 'Inspect', status: 'completed' },
            { content: 'Implement', status: 'in_progress' },
          ],
        },
      }),
    ]));
  });
});
