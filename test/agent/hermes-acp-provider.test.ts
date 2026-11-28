import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
} from '../../shared/agent-delegation.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../shared/hermes-agent.js';
import { SESSION_MODEL_APPLIED } from '../../shared/session-model-control.js';
import { PROVIDER_ERROR_CODES, type ToolCallEvent } from '../../src/agent/transport-provider.js';
import {
  buildHermesPresetConfigYaml,
  HermesAcpProvider,
  resolveHermesBinaryPath,
  resolveHermesPresetProfileDir,
  resolveHermesPresetRouteHash,
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

  it('renders non-secret scoped config.yaml for both Anthropic and OpenAI presets', () => {
    const anthropicYaml = buildHermesPresetConfigYaml({
      presetSlug: 'glm5-3-abc123',
      presetName: 'glm5.3',
      authType: 'anthropic',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiKey: 'SUPER_SECRET_ANTHROPIC_KEY',
      model: 'glm-5.3-flash',
      availableModels: ['glm-5.3-flash', 'glm-5'],
      contextWindow: 1_000_000,
    });
    expect(anthropicYaml).toContain('provider: "custom:glm5-3-abc123"');
    expect(anthropicYaml).toContain('api_mode: "anthropic_messages"');
    expect(anthropicYaml).toContain('key_env: "IMCODES_HERMES_API_KEY"');
    expect(anthropicYaml).toContain('context_length: 1000000');
    expect(anthropicYaml).not.toContain('SUPER_SECRET_ANTHROPIC_KEY');

    const thirdPartyOpenAiYaml = buildHermesPresetConfigYaml({
      presetSlug: 'compat-112233',
      presetName: 'compat',
      authType: 'openai',
      baseUrl: 'https://proxy.example.com/v1',
      apiKey: 'SUPER_SECRET_OPENAI_KEY',
      model: 'gpt-compat',
    });
    expect(thirdPartyOpenAiYaml).toContain('api_mode: "chat_completions"');
    expect(thirdPartyOpenAiYaml).toContain('key_env: "IMCODES_HERMES_API_KEY"');
    expect(thirdPartyOpenAiYaml).not.toContain('SUPER_SECRET_OPENAI_KEY');

    const officialOpenAiYaml = buildHermesPresetConfigYaml({
      presetSlug: 'openai-off-445566',
      presetName: 'openai-official',
      authType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'SUPER_SECRET_OFFICIAL_KEY',
      model: 'gpt-5',
    });
    expect(officialOpenAiYaml).toContain('api_mode: "codex_responses"');
    expect(officialOpenAiYaml).not.toContain('SUPER_SECRET_OFFICIAL_KEY');
  });

  it('binds profile dirs persistently by route ownership, isolates active WAL SQLite sessions across model switches & restarts, and migrates by resumeId SQLite snapshot', async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const tmpImcodes = mkdtempSync(path.join(tmpdir(), 'hermes-unit-home-'));
    const genericHermesHome = mkdtempSync(path.join(tmpdir(), 'hermes-generic-sentinel-'));
    const sentinelConfigPath = path.join(genericHermesHome, 'config.yaml');
    writeFileSync(sentinelConfigPath, 'sentinel: preserve-user-config\n', 'utf8');

    const prevImcodesHome = process.env.IMCODES_HOME;
    process.env.IMCODES_HOME = tmpImcodes;
    const openDbs: Array<InstanceType<typeof DatabaseSync>> = [];
    const initRealHermesSqlite = (profileDir: string, sessionId: string, modelId: string, title: string) => {
      mkdirSync(profileDir, { recursive: true });
      const db = new DatabaseSync(path.join(profileDir, 'state.db'));
      openDbs.push(db);
      db.exec(
        'PRAGMA journal_mode=WAL;'
        + 'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, model TEXT, title TEXT);'
        + 'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, content TEXT);',
      );
      db.prepare('INSERT INTO sessions (id, model, title) VALUES (?, ?, ?)').run(sessionId, modelId, title);
      return db;
    };
    try {
      const presetModelA = {
        presetSlug: 'glm5-3-unit01',
        presetName: 'glm5.3',
        authType: 'anthropic' as const,
        baseUrl: 'https://endpoint-a.example/anthropic',
        apiKey: 'SECRET_ONLY_IN_CHILD_ENV',
        model: 'model-a',
        availableModels: ['model-a', 'model-b'],
        contextWindow: 1_000_000,
      };
      const presetModelB = {
        ...presetModelA,
        model: 'model-b',
      };
      const presetEndpointV2 = {
        ...presetModelB,
        baseUrl: 'https://endpoint-b.example/anthropic',
      };
      // Model switch preserves persistent route storage dir when bound to routeId; omitted ownerKey still uses config hash
      expect(resolveHermesPresetProfileDir(presetModelA, 'sess-a')).toBe(
        resolveHermesPresetProfileDir(presetModelB, 'sess-a'),
      );
      expect(resolveHermesPresetProfileDir(presetModelA, 'sess-a')).not.toBe(
        resolveHermesPresetProfileDir(presetModelB, 'sess-b'),
      );
      expect(resolveHermesPresetProfileDir(presetEndpointV2)).not.toBe(
        resolveHermesPresetProfileDir(presetModelA),
      );

      const dirSessA = resolveHermesPresetProfileDir(presetModelA, 'sess-a');
      const dirSessB = resolveHermesPresetProfileDir(presetModelB, 'sess-b');

      const connectSpy = vi.spyOn(KimiSdkProvider.prototype, 'connect').mockResolvedValue(undefined);
      const createSpy = vi.spyOn(KimiSdkProvider.prototype, 'createSession').mockImplementation(
        async (cfg) => cfg.bindExistingKey ?? cfg.sessionKey,
      );
      const endSpy = vi.spyOn(KimiSdkProvider.prototype, 'endSession').mockResolvedValue(undefined);
      const disconnectSpy = vi.spyOn(KimiSdkProvider.prototype, 'disconnect').mockResolvedValue(undefined);

      const provider = new HermesAcpProvider();
      await provider.connect({
        agent: HERMES_AGENT_PROVIDER_ID,
        binaryPath: '/fake/hermes',
        env: { HERMES_HOME: genericHermesHome },
      });

      // Launch Session A (model A) and Session B (model B) with generic HERMES_HOME + distinct credentials
      await provider.createSession({
        sessionKey: 'sess-a',
        cwd: '/tmp/work',
        hermesPreset: presetModelA,
        env: {
          HERMES_HOME: genericHermesHome,
          IMCODES_SESSION: 'sess-a',
          IMCODES_HOOK_CREDENTIAL: 'cred-a',
        },
      });
      expect(readFileSync(sentinelConfigPath, 'utf8')).toBe('sentinel: preserve-user-config\n');

      // Launch Session A2 (second session on SAME preset & model A, different credentials) -> isolated delegate (F2)
      await provider.createSession({
        sessionKey: 'sess-a2',
        cwd: '/tmp/work',
        hermesPreset: presetModelA,
        env: {
          IMCODES_SESSION: 'sess-a2',
          IMCODES_HOOK_CREDENTIAL: 'cred-a2',
        },
      });

      // Launch Session B (model B)
      await provider.createSession({
        sessionKey: 'sess-b',
        cwd: '/tmp/work',
        hermesPreset: presetModelB,
        env: {
          IMCODES_SESSION: 'sess-b',
          IMCODES_HOOK_CREDENTIAL: 'cred-b',
        },
      });

      expect(connectSpy).toHaveBeenCalledTimes(4); // 1 parent + 3 per-session delegates
      const delegateAEnv = (connectSpy.mock.calls[1]![0] as { env?: Record<string, string> }).env!;
      const delegateA2Env = (connectSpy.mock.calls[2]![0] as { env?: Record<string, string> }).env!;
      const delegateBEnv = (connectSpy.mock.calls[3]![0] as { env?: Record<string, string> }).env!;
      expect(delegateAEnv.HERMES_HOME).toBe(dirSessA);
      expect(delegateAEnv.IMCODES_SESSION).toBe('sess-a');
      expect(delegateAEnv.IMCODES_HOOK_CREDENTIAL).toBe('cred-a');
      expect(delegateAEnv.IMCODES_HERMES_API_KEY).toBe('SECRET_ONLY_IN_CHILD_ENV');
      expect(delegateA2Env.HERMES_HOME).toBe(resolveHermesPresetProfileDir(presetModelA, 'sess-a2'));
      expect(delegateA2Env.IMCODES_HOOK_CREDENTIAL).toBe('cred-a2');
      expect(delegateBEnv.HERMES_HOME).toBe(dirSessB);

      const yamlA = readFileSync(path.join(dirSessA, 'config.yaml'), 'utf8');
      expect(yamlA).toContain('default: "model-a"');
      expect(yamlA).not.toContain('SECRET_ONLY_IN_CHILD_ENV');
      expect(existsSync(path.join(dirSessA, '.env'))).toBe(false);

      // Materialize active WAL-mode SQLite databases in BOTH dirs (simulating live Hermes sessions with active WAL writes)
      const dbA = initRealHermesSqlite(dirSessA, 'acp-sess-a', 'model-a', 'History A');
      const dbB = initRealHermesSqlite(dirSessB, 'acp-sess-b', 'model-b', 'History B');
      // Add an uncheckpointed WAL write into Session A AND give Session B a newer mtime so mtime guessing would pick wrong!
      dbA.prepare('INSERT INTO messages (session_id, content) VALUES (?, ?)').run('acp-sess-a', 'WAL msg');
      const future = new Date(Date.now() + 60_000);
      utimesSync(path.join(dirSessB, 'state.db'), future, future);
      expect(existsSync(path.join(dirSessA, 'state.db-wal'))).toBe(true);

      // Close Session A2 only (Session A & B keep running)
      await provider.endSession('sess-a2');
      expect(endSpy).toHaveBeenCalledWith('sess-a2');
      expect(disconnectSpy).toHaveBeenCalledTimes(1);

      // Simulate online switch of Session A from model-a -> model-b, followed directly by daemon restart restore (bindExistingKey='sess-a')
      const restartedProvider = new HermesAcpProvider();
      await restartedProvider.connect({
        agent: HERMES_AGENT_PROVIDER_ID,
        binaryPath: '/fake/hermes',
      });
      await restartedProvider.createSession({
        sessionKey: 'ephemeral-restore-route-a',
        bindExistingKey: 'sess-a',
        cwd: '/tmp/work',
        hermesPreset: presetModelB,
        skipCreate: true,
        resumeId: 'acp-sess-a',
        env: { IMCODES_SESSION: 'sess-a', IMCODES_HOOK_CREDENTIAL: 'cred-a-restarted' },
      });
      // Session A opens ITS OWN persistent directory (NOT Session B's dir!) with updated config.yaml and intact SQLite history
      const lastConnectEnv = (connectSpy.mock.calls.at(-1)![0] as { env?: Record<string, string> }).env!;
      expect(lastConnectEnv.HERMES_HOME).toBe(dirSessA);
      expect(readFileSync(path.join(dirSessA, 'config.yaml'), 'utf8')).toContain('default: "model-b"');
      const verifyDirA = new DatabaseSync(path.join(dirSessA, 'state.db'), { readOnly: true });
      openDbs.push(verifyDirA);
      expect(verifyDirA.prepare('SELECT id FROM sessions WHERE id = ?').get('acp-sess-a')).toEqual({ id: 'acp-sess-a' });
      expect(verifyDirA.prepare('SELECT id FROM sessions WHERE id = ?').get('acp-sess-b')).toBeUndefined();

      // Also verify relaunch with a brand-new routeId (no bindExistingKey) finds authoritative source by resumeId + WAL snapshot
      mkdirSync(path.join(dirSessA, 'sessions'), { recursive: true });
      writeFileSync(path.join(dirSessA, 'sessions', 'acp-sess-a.jsonl'), '{"msg":"from-a"}\n', 'utf8');
      mkdirSync(path.join(dirSessB, 'sessions'), { recursive: true });
      writeFileSync(path.join(dirSessB, 'sessions', 'acp-sess-b.jsonl'), '{"msg":"from-b"}\n', 'utf8');
      const dirRelaunched = resolveHermesPresetProfileDir(presetEndpointV2, 'sess-a-relaunch');
      await restartedProvider.createSession({
        sessionKey: 'sess-a-relaunch',
        cwd: '/tmp/work',
        hermesPreset: presetEndpointV2,
        skipCreate: true,
        resumeId: 'acp-sess-a',
      });
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: 'sess-a-relaunch',
        resumeId: 'acp-sess-a',
      }));
      const snapshotVerifyDb = new DatabaseSync(path.join(dirRelaunched, 'state.db'), { readOnly: true });
      openDbs.push(snapshotVerifyDb);
      expect(snapshotVerifyDb.prepare('SELECT id, title FROM sessions WHERE id = ?').get('acp-sess-a')).toEqual({
        id: 'acp-sess-a',
        title: 'History A',
      });
      expect(snapshotVerifyDb.prepare('SELECT session_id, content FROM messages').all()).toEqual([
        { session_id: 'acp-sess-a', content: 'WAL msg' },
      ]);
      expect(snapshotVerifyDb.prepare('SELECT id FROM sessions WHERE id = ?').get('acp-sess-b')).toBeUndefined();
      expect(readFileSync(path.join(dirRelaunched, 'sessions', 'acp-sess-a.jsonl'), 'utf8')).toBe('{"msg":"from-a"}\n');
      expect(existsSync(path.join(dirRelaunched, 'sessions', 'acp-sess-b.jsonl'))).toBe(false);

      // Verify single-session extraction from a multi-session legacy DB excludes unrelated sessions & messages,
      // and duplicate legacy DBs claiming the same resumeId fail closed without mtime/first-path guessing.
      const legacySharedDir = resolveHermesPresetProfileDir(presetEndpointV2);
      mkdirSync(legacySharedDir, { recursive: true });
      const sharedLegacyDb = new DatabaseSync(path.join(legacySharedDir, 'state.db'));
      openDbs.push(sharedLegacyDb);
      sharedLegacyDb.exec(
        'PRAGMA journal_mode=WAL;'
        + 'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, model TEXT, title TEXT);'
        + 'CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, content TEXT);',
      );
      sharedLegacyDb.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('acp-legacy-only', 'model-a', 'Wanted');
      sharedLegacyDb.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('acp-foreign-secret', 'model-b', 'Foreign');
      sharedLegacyDb.prepare('INSERT INTO messages (session_id, content) VALUES (?, ?)').run('acp-legacy-only', 'wanted-msg');
      sharedLegacyDb.prepare('INSERT INTO messages (session_id, content) VALUES (?, ?)').run('acp-foreign-secret', 'foreign-secret-msg');

      const dirSingleExtracted = resolveHermesPresetProfileDir(presetEndpointV2, 'owner-single-extract');
      await restartedProvider.createSession({
        sessionKey: 'owner-single-extract',
        cwd: '/tmp/work',
        hermesPreset: { ...presetEndpointV2, profileOwnerKey: 'owner-single-extract' },
        skipCreate: true,
        resumeId: 'acp-legacy-only',
      });
      const extractedDb = new DatabaseSync(path.join(dirSingleExtracted, 'state.db'), { readOnly: true });
      openDbs.push(extractedDb);
      expect(extractedDb.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'acp-legacy-only' }]);
      expect(extractedDb.prepare('SELECT session_id, content FROM messages').all()).toEqual([
        { session_id: 'acp-legacy-only', content: 'wanted-msg' },
      ]);

      // Now two DBs contain 'acp-legacy-only' -> migrating to a third owner refuses guessing among duplicates
      const dirAmbiguousTarget = resolveHermesPresetProfileDir(presetEndpointV2, 'owner-ambiguous');
      await restartedProvider.createSession({
        sessionKey: 'owner-ambiguous',
        cwd: '/tmp/work',
        hermesPreset: { ...presetEndpointV2, profileOwnerKey: 'owner-ambiguous' },
        skipCreate: true,
        resumeId: 'acp-legacy-only',
      });
      expect(existsSync(path.join(dirAmbiguousTarget, 'state.db'))).toBe(false);
    } finally {
      for (const db of openDbs) {
        try { db.close(); } catch { /* ignore */ }
      }
      if (prevImcodesHome === undefined) delete process.env.IMCODES_HOME;
      else process.env.IMCODES_HOME = prevImcodesHome;
      rmSync(tmpImcodes, { recursive: true, force: true });
      rmSync(genericHermesHome, { recursive: true, force: true });
    }
  });

  it('rewrites /compact to /compress while preserving userMessage, awaits model switch before prompt, and captures PromptResponse.usage', async () => {
    const provider = new HermesAcpProvider();
    const usages: Array<{ input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; model_context_window?: number }> = [];
    const completes: Array<Record<string, unknown> | undefined> = [];
    provider.onUsage((_sid, payload) => {
      if (payload.usage) usages.push(payload.usage);
    });
    provider.onComplete((_sid, msg) => {
      completes.push(msg.metadata);
    });

    const callOrder: string[] = [];
    let resolveModelSwitch!: () => void;
    const rawConn = {
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'acp-wrapped-1',
        models: { currentModelId: 'custom:glm5-3-abc123:glm-5.3-flash' },
      }),
      unstable_setSessionModel: vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => {
          resolveModelSwitch = () => {
            callOrder.push('model_switched');
            resolve();
          };
        }),
      ),
      prompt: vi.fn().mockImplementation(async () => {
        callOrder.push('prompt_invoked');
        return {
          stopReason: 'end_turn',
          usage: {
            inputTokens: 1200,
            outputTokens: 45,
            cachedReadTokens: 300,
          },
        };
      }),
    };

    (provider as any).connection = rawConn;
    const wrapped = (provider as any).connection;
    (provider as any).sessionContextWindows.set('route-wrap', 1_000_000);
    (provider as any).sessionPresetSlugs.set('route-wrap', 'glm5-3-abc123');
    const sessionState = {
      routeId: 'route-wrap',
      cwd: '/tmp/project',
      acpSessionId: 'acp-wrapped-1',
      loaded: true,
      modeApplied: true,
      promptInFlight: false,
      promptSubmittedGeneration: 0,
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
      model: 'custom:glm5-3-abc123:glm-5.3-flash',
    };
    (provider as any).sessions.set('route-wrap', sessionState);
    (provider as any).registerAcpRoute('acp-wrapped-1', 'route-wrap');
    const seenInfos: Array<{ model?: string; resumeId?: string }> = [];
    provider.onSessionInfo((_sid, info) => seenInfos.push(info));
    (provider as any).emitSessionInfo('route-wrap', {
      model: 'custom:glm5-3-abc123:glm-5.3-flash',
      resumeId: 'acp-wrapped-1',
    });
    expect(seenInfos[0]).toMatchObject({
      model: 'glm-5.3-flash',
      resumeId: 'acp-wrapped-1',
    });

    // Trigger model switch via wrapped connection and verify send('/compact') waits for it
    const modelRpc = wrapped.unstable_setSessionModel({ sessionId: 'acp-wrapped-1', modelId: 'glm-5' });
    const superSendSpy = vi.spyOn(KimiSdkProvider.prototype, 'send').mockImplementation(async (_sid, payload) => {
      callOrder.push(`super_send:${typeof payload === 'string' ? payload : payload.assembledMessage}`);
    });
    const sendPromise = provider.send('route-wrap', '/compact');
    await Promise.resolve();
    expect(callOrder).toEqual([]);
    resolveModelSwitch();
    await modelRpc;
    await sendPromise;

    expect(callOrder).toEqual([
      'model_switched',
      'super_send:/compress',
    ]);
    expect(superSendSpy).toHaveBeenCalledWith('route-wrap', expect.objectContaining({
      userMessage: '/compact',
      assembledMessage: '/compress',
    }));

    // Verify PromptResponse.usage forwarding via wrapped connection + super.onComplete settlement
    await wrapped.prompt({ sessionId: 'acp-wrapped-1', prompt: [{ type: 'text', text: 'hi' }] });
    for (const cb of (provider as any).completeCallbacks) {
      cb('route-wrap', {
        id: 'msg-usage-1',
        role: 'assistant',
        content: 'ok',
        status: 'complete',
        timestamp: Date.now(),
        metadata: {
          model: 'custom:glm5-3-abc123:glm-5.3-flash',
          resumeId: 'acp-wrapped-1',
        },
      });
    }
    expect(usages).toEqual([
      {
        input_tokens: 1200,
        output_tokens: 45,
        cache_read_input_tokens: 300,
        model_context_window: 1_000_000,
      },
    ]);
    expect(completes[0]).toMatchObject({
      model: 'glm-5.3-flash',
      resumeId: 'acp-wrapped-1',
      usage: {
        input_tokens: 1200,
        output_tokens: 45,
        cache_read_input_tokens: 300,
        model_context_window: 1_000_000,
      },
    });
  });

  it('supports confirmed applySessionModel for Hermes presets (unloaded, rejected, live) and preserves default Hermes semantics', async () => {
    const provider = new HermesAcpProvider();
    const { acpSessionId, state } = attachActiveRoute(provider, 'hermes-preset-model');
    (provider as any).sessionPresetSlugs.set('hermes-preset-model', 'glm5-3-abc123');
    state.model = 'glm-5.3-flash';
    state.loaded = false;

    const unstableSetSessionModel = vi.fn();
    (provider as any).connection = { unstable_setSessionModel: unstableSetSessionModel };

    // 1. Uninitialized/unloaded session returns NEXT_START without RPC
    await expect(provider.applySessionModel('hermes-preset-model', 'glm-5')).resolves.toBe(
      SESSION_MODEL_APPLIED.NEXT_START,
    );
    expect(unstableSetSessionModel).not.toHaveBeenCalled();
    expect(state.model).toBe('glm-5');

    // 2. Loaded session rejection (e.g. busy) propagates without mutating state.model
    state.loaded = true;
    state.model = 'glm-5.3-flash';
    unstableSetSessionModel.mockRejectedValueOnce(new Error('Session is busy; switch models while the session is idle'));
    await expect(provider.applySessionModel('hermes-preset-model', 'glm-5')).rejects.toThrow('Session is busy');
    expect(state.model).toBe('glm-5.3-flash');

    // 3. Confirmed RPC resolves LIVE and updates state.model
    unstableSetSessionModel.mockResolvedValueOnce(undefined);
    await expect(provider.applySessionModel('hermes-preset-model', 'glm-5')).resolves.toBe(
      SESSION_MODEL_APPLIED.LIVE,
    );
    expect(unstableSetSessionModel).toHaveBeenLastCalledWith({ sessionId: acpSessionId, modelId: 'glm-5' });
    expect(state.model).toBe('glm-5');

    // 4. Default (non-preset) Hermes preserves setSessionAgentId best-effort semantics without rejecting
    const { state: defaultState } = attachActiveRoute(provider, 'hermes-default-model');
    defaultState.loaded = true;
    defaultState.model = 'default-1';
    unstableSetSessionModel.mockRejectedValueOnce(new Error('transient non-preset failure'));
    await expect(provider.applySessionModel('hermes-default-model', 'default-2')).resolves.toBe(
      SESSION_MODEL_APPLIED.NEXT_START,
    );
    expect(defaultState.model).toBe('default-2');
  });

  it('propagates default listSessions RPC failures so legacy restore retries instead of silently returning []', async () => {
    const provider = new HermesAcpProvider();
    const listSpy = vi.spyOn(KimiSdkProvider.prototype, 'listSessions')
      .mockRejectedValueOnce(new Error('transient session/list failure'))
      .mockResolvedValueOnce([
        { key: 'legacy-1', directory: '/tmp/proj', title: 'Restored thread' },
      ]);

    await expect(provider.listSessions({ directory: '/tmp/proj' })).rejects.toThrow('transient session/list failure');
    await expect(provider.listSessions({ directory: '/tmp/proj' })).resolves.toEqual([
      { key: 'legacy-1', directory: '/tmp/proj', title: 'Restored thread' },
    ]);
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('enforces first-turn ACP model confirmation/rejection after NEXT_START and lets default Hermes send() bypass delayed setSessionAgentId rejections', async () => {
    const makeTracker = () => ({
      writeQueue: Promise.resolve(),
      abortController: new AbortController(),
    });
    // 1. Default (non-preset) Hermes: delayed setSessionAgentId rejection + concurrent send() delivers prompt to provider
    const defaultProvider = new HermesAcpProvider();
    const { state: defState } = attachActiveRoute(defaultProvider, 'hermes-default-concurrent');
    defState.promptInFlight = false;
    defState.model = 'default-1';

    let rejectDefaultModelRpc!: (err: Error) => void;
    const defaultPrompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    const defaultConn = {
      connection: makeTracker(),
      unstable_setSessionModel: vi.fn().mockImplementation(
        () => new Promise<void>((_resolve, reject) => {
          rejectDefaultModelRpc = reject;
        }),
      ),
      prompt: defaultPrompt,
    };
    (defaultProvider as any).config = { agent: HERMES_AGENT_PROVIDER_ID };
    (defaultProvider as any).connection = defaultConn;
    (defaultProvider as any).initPromise = Promise.resolve();

    defaultProvider.setSessionAgentId('hermes-default-concurrent', 'bad-default-model');
    const defaultSendPromise = defaultProvider.send('hermes-default-concurrent', 'hello default mode');
    await Promise.resolve();
    rejectDefaultModelRpc(new Error('delayed unsupported default model rpc'));
    await expect(defaultSendPromise).resolves.toBeUndefined();
    expect(defaultPrompt).toHaveBeenCalledTimes(1);

    // 2. Preset NEXT_START followed by first ACP session REJECTION fails turn cleanly without confirming model
    const rejectProvider = new HermesAcpProvider();
    const rejectedSessionInfos: Array<{ model?: string }> = [];
    rejectProvider.onSessionInfo((_sid, info) => rejectedSessionInfos.push(info));
    const { state: rejState } = attachActiveRoute(rejectProvider, 'hermes-preset-reject');
    rejState.loaded = false;
    rejState.acpSessionId = undefined;
    rejState.promptInFlight = false;
    rejState.model = 'glm-5.3-flash';
    (rejectProvider as any).sessionPresetSlugs.set('hermes-preset-reject', 'glm5-3-abc123');
    (rejectProvider as any).config = { agent: HERMES_AGENT_PROVIDER_ID };
    (rejectProvider as any).initPromise = Promise.resolve();

    const rejPrompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    const rejConn = {
      connection: makeTracker(),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'acp-cold-reject',
        models: { currentModelId: 'custom:glm5-3-abc123:glm-5.3-flash' },
      }),
      unstable_setSessionModel: vi.fn().mockImplementation(async ({ modelId }: { modelId: string }) => {
        if (modelId === 'bad-preset-model') {
          throw new Error('Model bad-preset-model is unavailable');
        }
      }),
      prompt: rejPrompt,
    };
    (rejectProvider as any).connection = rejConn;

    await expect(rejectProvider.applySessionModel('hermes-preset-reject', 'bad-preset-model')).resolves.toBe(
      SESSION_MODEL_APPLIED.NEXT_START,
    );
    await expect(rejectProvider.send('hermes-preset-reject', 'hi')).rejects.toThrow('Model bad-preset-model is unavailable');
    expect(rejPrompt).not.toHaveBeenCalled();
    expect(rejectedSessionInfos.filter((i) => i.model)).toEqual([]);

    // Retrying with a still-rejected model also refuses; switching LIVE to valid 'glm-5' succeeds cleanly
    await expect(rejectProvider.send('hermes-preset-reject', 'hi again')).rejects.toThrow('Model bad-preset-model is unavailable');
    await expect(rejectProvider.applySessionModel('hermes-preset-reject', 'glm-5')).resolves.toBe(
      SESSION_MODEL_APPLIED.LIVE,
    );
    await expect(rejectProvider.send('hermes-preset-reject', 'now ok')).resolves.toBeUndefined();
    expect(rejPrompt).toHaveBeenCalledTimes(1);

    // 3. Preset NEXT_START followed by first ACP session CONFIRMATION emits normalized confirmed session.info
    const confirmProvider = new HermesAcpProvider();
    const confirmedInfos: Array<{ model?: string }> = [];
    confirmProvider.onSessionInfo((_sid, info) => confirmedInfos.push(info));
    const { state: okState } = attachActiveRoute(confirmProvider, 'hermes-preset-confirm');
    okState.loaded = false;
    okState.acpSessionId = undefined;
    okState.promptInFlight = false;
    okState.model = 'glm-5.3-flash';
    (confirmProvider as any).sessionPresetSlugs.set('hermes-preset-confirm', 'glm5-3-abc123');
    (confirmProvider as any).config = { agent: HERMES_AGENT_PROVIDER_ID };
    (confirmProvider as any).initPromise = Promise.resolve();

    const okPrompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    const okConn = {
      connection: makeTracker(),
      newSession: vi.fn().mockResolvedValue({
        sessionId: 'acp-cold-confirm',
        models: { currentModelId: 'custom:glm5-3-abc123:glm-5.3-flash' },
      }),
      unstable_setSessionModel: vi.fn().mockResolvedValue(undefined),
      prompt: okPrompt,
    };
    (confirmProvider as any).connection = okConn;

    await expect(confirmProvider.applySessionModel('hermes-preset-confirm', 'glm-5')).resolves.toBe(
      SESSION_MODEL_APPLIED.NEXT_START,
    );
    await expect(confirmProvider.send('hermes-preset-confirm', 'run turn')).resolves.toBeUndefined();
    expect(okPrompt).toHaveBeenCalledTimes(1);
    expect(confirmedInfos).toContainEqual({ model: 'glm-5' });
  });

  it('migrates legacy Hermes state.db using strict schema whitelist and ownership isolation without leaking system_prompts or resumable_subagents', async () => {
    const imcodesHome = mkdtempSync(path.join(tmpdir(), 'hermes-f1-r4-'));
    const prevHome = process.env.IMCODES_HOME;
    process.env.IMCODES_HOME = imcodesHome;

    const connectSpy = vi.spyOn(KimiSdkProvider.prototype, 'connect').mockResolvedValue(undefined);
    const createSpy = vi.spyOn(KimiSdkProvider.prototype, 'createSession').mockResolvedValue('acp-seed-target');
    const provider = new HermesAcpProvider();

    try {
      const legacyDir = path.join(imcodesHome, 'hermes-profiles', 'legacy-preset', 'hash-legacy-1');
      mkdirSync(path.join(legacyDir, 'sessions'), { recursive: true });
      writeFileSync(path.join(legacyDir, 'sessions', 'hermes-target-1.json'), '{"id":"hermes-target-1"}\n', 'utf8');
      writeFileSync(path.join(legacyDir, 'sessions', 'hermes-foreign-1.json'), '{"id":"hermes-foreign-1"}\n', 'utf8');

      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
      const legacyDb = new DatabaseSync(path.join(legacyDir, 'state.db'));
      legacyDb.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE system_prompts (
          hash TEXT PRIMARY KEY,
          prompt TEXT NOT NULL,
          created_at REAL NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          user_id TEXT,
          model TEXT,
          model_config TEXT,
          system_prompt_hash TEXT REFERENCES system_prompts(hash),
          parent_session_id TEXT REFERENCES sessions(id),
          started_at REAL NOT NULL,
          tool_names TEXT,
          session_key TEXT
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          role TEXT NOT NULL,
          content TEXT,
          tool_name TEXT,
          tool_calls TEXT,
          timestamp REAL NOT NULL
        );
        CREATE VIEW IF NOT EXISTS messages_fts_src AS
          SELECT id,
                 CASE WHEN role = 'tool' THEN substr(COALESCE(content, ''), 1, 512) ELSE content END AS content,
                 tool_name,
                 tool_calls
          FROM messages;
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content,
          tool_name,
          tool_calls,
          content='messages_fts_src',
          content_rowid='id'
        );
        CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
        WHEN (new.id > COALESCE((SELECT CAST(value AS INTEGER) FROM state_meta WHERE key = 'fts_rebuild_high_water'), -1)
           OR new.id <= COALESCE((SELECT CAST(value AS INTEGER) FROM state_meta WHERE key = 'fts_rebuild_progress'), -1))
        BEGIN
          INSERT INTO messages_fts(rowid, content, tool_name, tool_calls)
          VALUES (
            new.id,
            CASE WHEN new.role = 'tool' THEN substr(COALESCE(new.content, ''), 1, 512) ELSE new.content END,
            new.tool_name,
            new.tool_calls
          );
        END;
        CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
        WHEN (old.id > COALESCE((SELECT CAST(value AS INTEGER) FROM state_meta WHERE key = 'fts_rebuild_high_water'), -1)
           OR old.id <= COALESCE((SELECT CAST(value AS INTEGER) FROM state_meta WHERE key = 'fts_rebuild_progress'), -1))
        BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, tool_calls)
          VALUES (
            'delete',
            old.id,
            CASE WHEN old.role = 'tool' THEN substr(COALESCE(old.content, ''), 1, 512) ELSE old.content END,
            old.tool_name,
            old.tool_calls
          );
        END;
        CREATE VIEW IF NOT EXISTS messages_fts_trigram_src AS
          SELECT m.id, m.role, m.content, m.tool_name
          FROM messages AS m
          JOIN sessions AS s ON s.id = m.session_id
          WHERE m.role <> 'tool'
            AND s.source NOT IN ('cron', 'subagent')
            AND json_extract(s.model_config, '$._delegate_from') IS NULL;
        CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
          content,
          tool_name,
          content='messages_fts_trigram_src',
          content_rowid='id',
          tokenize='trigram'
        );
        CREATE TRIGGER messages_fts_trigram_insert AFTER INSERT ON messages
        WHEN new.role <> 'tool'
          AND EXISTS (
            SELECT 1 FROM sessions
            WHERE id = new.session_id
              AND source NOT IN ('cron', 'subagent')
              AND json_extract(model_config, '$._delegate_from') IS NULL
          )
          AND (new.id > COALESCE((SELECT CAST(value AS INTEGER) FROM state_meta WHERE key = 'fts_rebuild_high_water'), -1)
            OR new.id <= COALESCE((SELECT CAST(value AS INTEGER) FROM state_meta WHERE key = 'fts_rebuild_progress'), -1))
        BEGIN
          INSERT INTO messages_fts_trigram(rowid, content, tool_name)
          VALUES (new.id, new.content, new.tool_name);
        END;
        CREATE TABLE session_model_usage (
          session_id TEXT NOT NULL REFERENCES sessions(id),
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, model)
        );
        CREATE TABLE async_delegations (
          delegation_id TEXT PRIMARY KEY,
          origin_session TEXT,
          origin_ui_session_id TEXT,
          parent_session_id TEXT,
          origin_session_id TEXT,
          goal TEXT
        );
        CREATE TABLE resumable_subagents (
          subagent_id TEXT PRIMARY KEY,
          state TEXT NOT NULL DEFAULT 'paused',
          pinned INTEGER NOT NULL DEFAULT 0,
          stop_cause TEXT NOT NULL,
          owner_pid INTEGER NOT NULL,
          owner_started_at REAL NOT NULL,
          record_json TEXT NOT NULL,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          expires_at REAL
        );
        CREATE TABLE gateway_routing (channel TEXT PRIMARY KEY, session_id TEXT);
        CREATE TABLE gateway_hygiene_state (key TEXT PRIMARY KEY, value TEXT);
      `);
      legacyDb.exec(`
        INSERT INTO schema_version VALUES (30);
        INSERT INTO state_meta VALUES ('migrated', '1'), ('fts_rebuild_high_water', '99'), ('fts_rebuild_progress', '1');
        INSERT INTO system_prompts VALUES
          ('hash-shared', 'Shared base prompt', 1.0),
          ('hash-target-tools', 'Target tool pin prompt', 2.0),
          ('hash-foreign-sys', 'SECRET FOREIGN SYSTEM PROMPT', 3.0),
          ('hash-foreign-tools', 'SECRET FOREIGN TOOLS', 4.0);
        INSERT INTO sessions VALUES
          ('hermes-target-1', 'acp', NULL, 'glm-5', '{}', 'hash-shared', NULL, 10.0, 'hash-target-tools', 'shared-chan'),
          ('hermes-foreign-1', 'acp', NULL, 'glm-5', '{}', 'hash-foreign-sys', NULL, 20.0, 'hash-foreign-tools', 'shared-chan'),
          ('hermes-foreign-2', 'acp', NULL, 'glm-5', '{}', 'hash-shared', NULL, 30.0, NULL, NULL);
        INSERT INTO messages (session_id, role, content, tool_name, tool_calls, timestamp) VALUES
          ('hermes-target-1', 'user', 'target secret message 中文目标消息', NULL, NULL, 11.0),
          ('hermes-foreign-1', 'user', 'foreign leaked message 中文外部机密', NULL, NULL, 21.0);
        INSERT INTO session_model_usage VALUES
          ('hermes-target-1', 'glm-5', 42),
          ('hermes-foreign-1', 'glm-5', 999);
        INSERT INTO async_delegations VALUES
          ('del-target-1', 'shared-chan', NULL, 'hermes-target-1', NULL, 'target goal'),
          ('del-foreign-1', 'shared-chan', NULL, 'hermes-foreign-1', NULL, 'foreign goal'),
          ('del-ambiguous-chan', 'shared-chan', NULL, NULL, NULL, 'ambiguous shared chan goal');
        INSERT INTO resumable_subagents VALUES
          ('sub-target-unit', 'paused', 0, 'interrupt', 100, 1.0, '{"unit_id":"del-target-1","task":"keep unit"}', 1.0, 1.0, NULL),
          ('sub-target-sid', 'paused', 0, 'interrupt', 100, 1.0, '{"parent_session_id":"hermes-target-1","task":"keep sid"}', 1.0, 1.0, NULL),
          ('sub-foreign-unit', 'paused', 0, 'interrupt', 100, 1.0, '{"unit_id":"del-foreign-1","task":"drop foreign"}', 1.0, 1.0, NULL),
          ('sub-unprovable', 'paused', 0, 'interrupt', 100, 1.0, '{corrupt json', 1.0, 1.0, NULL);
        INSERT INTO gateway_routing VALUES ('telegram:1', 'hermes-foreign-1');
        INSERT INTO gateway_hygiene_state VALUES ('last_cleanup', '999');
      `);
      legacyDb.close();

      const preset = {
        presetSlug: 'glm5-preset',
        presetName: 'glm5.3',
        authType: 'anthropic' as const,
        baseUrl: 'https://open.bigmodel.cn/api/anthropic/',
        model: 'glm-5.3-flash',
        availableModels: ['glm-5.3-flash', 'glm-5'],
        profileOwnerKey: 'owner-isolation-1',
        apiKey: 'secret-live-key',
      };
      await provider.createSession({
        sessionKey: 'route-iso-1',
        fresh: false,
        resumeId: 'hermes-target-1',
        hermesPreset: preset,
      });

      const snapshot = provider.getRoutePresetSnapshot('route-iso-1');
      expect(snapshot).toEqual({
        presetSlug: 'glm5-preset',
        presetName: 'glm5.3',
        authType: 'anthropic',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      });
      expect(JSON.stringify(snapshot)).not.toContain('secret-live-key');

      const targetProfileDir = resolveHermesPresetProfileDir(preset, 'owner-isolation-1');
      const migratedDbPath = path.join(targetProfileDir, 'state.db');
      expect(existsSync(migratedDbPath)).toBe(true);
      const checkDb = new DatabaseSync(migratedDbPath, { readOnly: true });
      try {
        expect(checkDb.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        expect(checkDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(checkDb.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'hermes-target-1' }]);
        expect(checkDb.prepare('SELECT session_id, content FROM messages').all()).toEqual([
          { session_id: 'hermes-target-1', content: 'target secret message 中文目标消息' },
        ]);
        expect(checkDb.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'target'").all()).toHaveLength(1);
        expect(checkDb.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'foreign'").all()).toEqual([]);
        expect(checkDb.prepare("SELECT rowid FROM messages_fts_trigram WHERE messages_fts_trigram MATCH '中文目标'").all()).toHaveLength(1);
        expect(checkDb.prepare("SELECT rowid FROM messages_fts_trigram WHERE messages_fts_trigram MATCH '中文外部'").all()).toEqual([]);
        expect(checkDb.prepare('SELECT hash FROM system_prompts ORDER BY hash').all()).toEqual([
          { hash: 'hash-shared' },
          { hash: 'hash-target-tools' },
        ]);
        expect(checkDb.prepare('SELECT delegation_id FROM async_delegations').all()).toEqual([
          { delegation_id: 'del-target-1' },
        ]);
        expect(checkDb.prepare('SELECT subagent_id FROM resumable_subagents ORDER BY subagent_id').all()).toEqual([
          { subagent_id: 'sub-target-sid' },
          { subagent_id: 'sub-target-unit' },
        ]);
        expect(checkDb.prepare('SELECT * FROM gateway_routing').all()).toEqual([]);
        expect(checkDb.prepare('SELECT * FROM gateway_hygiene_state').all()).toEqual([]);
      } finally {
        checkDb.close();
      }
      // Verify live message insert still fires rebuilt FTS + trigram triggers on migrated state.db
      const migratedRw = new DatabaseSync(migratedDbPath);
      try {
        migratedRw.prepare(
          'INSERT INTO messages (session_id, role, content, tool_name, tool_calls, timestamp) VALUES (?, ?, ?, NULL, NULL, ?)',
        ).run('hermes-target-1', 'assistant', 'post-migration live followup 新增实时索引', 12.0);
        expect(migratedRw.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'followup'").all()).toHaveLength(1);
        expect(migratedRw.prepare("SELECT rowid FROM messages_fts_trigram WHERE messages_fts_trigram MATCH '新增实时'").all()).toHaveLength(1);
        migratedRw.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check');");
        migratedRw.exec("INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('integrity-check');");
      } finally {
        migratedRw.close();
      }
      const migratedSessionsDir = path.join(targetProfileDir, 'sessions');
      expect(existsSync(path.join(migratedSessionsDir, 'hermes-target-1.json'))).toBe(true);
      expect(existsSync(path.join(migratedSessionsDir, 'hermes-foreign-1.json'))).toBe(false);

      // Unknown schema table in source legacy DB must fail closed without creating target state.db
      const legRw = new DatabaseSync(path.join(legacyDir, 'state.db'));
      legRw.exec("CREATE TABLE unknown_future_table (id TEXT PRIMARY KEY); INSERT INTO unknown_future_table VALUES ('x');");
      legRw.close();
      const refusedPreset = { ...preset, profileOwnerKey: 'owner-isolation-unknown' };
      await provider.createSession({
        sessionKey: 'route-iso-unknown',
        fresh: false,
        resumeId: 'hermes-target-1',
        hermesPreset: refusedPreset,
      });
      const refusedDbPath = path.join(resolveHermesPresetProfileDir(refusedPreset, 'owner-isolation-unknown'), 'state.db');
      expect(existsSync(refusedDbPath)).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.IMCODES_HOME;
      else process.env.IMCODES_HOME = prevHome;
      await provider.disconnect().catch(() => {});
      connectSpy.mockRestore();
      createSpy.mockRestore();
      rmSync(imcodesHome, { recursive: true, force: true });
    }
  });
});
