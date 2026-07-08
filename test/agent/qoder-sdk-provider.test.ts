import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { Options as QoderOptions } from '@qoder-ai/qoder-agent-sdk';

const sdkMock = vi.hoisted(() => {
  const state = {
    runtimePresent: true,
    workerPresent: false,
    scripts: [] as any[][],
    calls: [] as Array<{ prompt: string; options: QoderOptions }>,
    interrupted: 0,
    closed: 0,
    permissionResults: [] as any[],
    mcpStatus: [] as any[],
    models: [] as any[],
  };

  const reset = (): void => {
    state.runtimePresent = true;
    state.workerPresent = false;
    state.scripts = [];
    state.calls = [];
    state.interrupted = 0;
    state.closed = 0;
    state.permissionResults = [];
    state.mcpStatus = [];
    state.models = [];
    query.mockClear();
    accessTokenFromEnv.mockClear();
    qodercliAuth.mockClear();
    inspectQoderSdkPackage.mockClear();
    pathExistsExecutable.mockClear();
    hasResolvableQoderWorkerRuntime.mockClear();
    WorkerTransport.mockClear();
  };

  const query = vi.fn((call: { prompt: string; options: QoderOptions }) => {
    state.calls.push(call);
    const script = state.scripts.shift() ?? [];
    const queryObject: any = {};
    let releaseInterrupt: (() => void) | null = null;
    const iterator = (async function* () {
      for (const entry of script) {
        if (typeof entry === 'function') {
          const result = await entry({ call, state, query: queryObject });
          if (Array.isArray(result)) {
            for (const message of result) yield message;
          } else if (result) {
            yield result;
          }
          continue;
        }
        if (entry && typeof entry === 'object' && entry.waitForInterrupt === true) {
          await new Promise<void>((resolve) => { releaseInterrupt = resolve; });
          for (const late of entry.lateMessages ?? []) yield late;
          continue;
        }
        yield entry;
      }
    })();
    queryObject[Symbol.asyncIterator] = () => queryObject;
    queryObject.next = () => iterator.next();
    queryObject.return = (value?: void) => iterator.return?.(value) ?? Promise.resolve({ done: true, value: undefined });
    queryObject.throw = (err?: unknown) => iterator.throw?.(err) ?? Promise.reject(err);
    queryObject.interrupt = vi.fn(async () => {
      state.interrupted += 1;
      releaseInterrupt?.();
    });
    queryObject.close = vi.fn(async () => {
      state.closed += 1;
      releaseInterrupt?.();
      await queryObject.return();
    });
    queryObject.setPermissionMode = vi.fn();
    queryObject.setModel = vi.fn();
    queryObject.mcpServerStatus = vi.fn(async () => state.mcpStatus);
    queryObject.getAvailableModels = vi.fn(async () => state.models);
    return queryObject;
  });

  const accessTokenFromEnv = vi.fn((envVar = 'QODER_PERSONAL_ACCESS_TOKEN') => ({
    type: 'accessToken',
    accessToken: { envVar },
  }));
  const qodercliAuth = vi.fn(() => ({ type: 'qodercli' }));
  const hasResolvableQoderWorkerRuntime = vi.fn(() => state.workerPresent);
  const WorkerTransport = vi.fn(function WorkerTransport(this: any, options?: Record<string, unknown>) {
    this.options = options ?? {};
    this.create = vi.fn();
  });
  (WorkerTransport as any).default = { create: vi.fn() };
  const inspectQoderSdkPackage = vi.fn(async () => ({
    version: '1.0.11',
    qoderCliVersion: '1.0.33',
    license: 'SEE LICENSE IN LICENSE',
    hasInstallScript: true,
    bundledQoderCliPresent: state.runtimePresent,
    runtimeManifest: { defaultTransport: 'process', packaged: false },
  }));
  const pathExistsExecutable = vi.fn(async () => false);

  return {
    state,
    reset,
    query,
    accessTokenFromEnv,
    qodercliAuth,
    hasResolvableQoderWorkerRuntime,
    WorkerTransport,
    inspectQoderSdkPackage,
    pathExistsExecutable,
  };
});

vi.mock('@qoder-ai/qoder-agent-sdk', () => ({
  query: sdkMock.query,
  accessTokenFromEnv: sdkMock.accessTokenFromEnv,
  qodercliAuth: sdkMock.qodercliAuth,
  hasResolvableQoderWorkerRuntime: sdkMock.hasResolvableQoderWorkerRuntime,
  WorkerTransport: sdkMock.WorkerTransport,
  ProcessTransport: { default: { create: vi.fn() } },
  WIRE_PROTOCOL_VERSION: '0.1.0',
}));

vi.mock('../../src/agent/qoder-sdk-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/qoder-sdk-config.js')>();
  return {
    ...actual,
    inspectQoderSdkPackage: sdkMock.inspectQoderSdkPackage,
    pathExistsExecutable: sdkMock.pathExistsExecutable,
  };
});

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { QoderSdkProvider } from '../../src/agent/providers/qoder-sdk.js';
import {
  QODER_READINESS_REASON,
  normalizeQoderTransportConfig,
} from '../../src/agent/qoder-sdk-config.js';
import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';
import { MEMORY_MCP_STATUS } from '../../shared/memory-ws.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';

let provider: QoderSdkProvider | null = null;

beforeEach(() => {
  sdkMock.reset();
  delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
  delete process.env.IMCODES_QODER_TEST_TOKEN;
});

afterEach(async () => {
  vi.useRealTimers();
  await provider?.disconnect();
  provider = null;
});

async function makeProvider(config: Record<string, unknown> = {}): Promise<QoderSdkProvider> {
  provider = new QoderSdkProvider();
  await provider.connect(config);
  return provider;
}

async function createReadySession(p: QoderSdkProvider, settings?: Record<string, unknown>): Promise<string> {
  process.env.QODER_PERSONAL_ACCESS_TOKEN = 'pat_process_secret';
  return p.createSession({
    sessionKey: 'route-1',
    sessionName: 'deck_alpha_worker',
    projectName: 'alpha',
    serverId: 'srv-bound',
    cwd: '/tmp/project',
    env: {
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      QODER_PERSONAL_ACCESS_TOKEN: 'pat_test_secret',
      IMCODES_SERVER_TOKEN: 'daemon-secret',
      OPENAI_API_KEY: 'daemon-api-secret',
    },
    settings,
  });
}

function collect(p: QoderSdkProvider) {
  const deltas: any[] = [];
  const completions: any[] = [];
  const errors: any[] = [];
  const tools: any[] = [];
  const approvals: any[] = [];
  const statuses: any[] = [];
  const sessionInfos: any[] = [];
  p.onDelta((sessionId, delta) => deltas.push({ sessionId, delta }));
  p.onComplete((sessionId, message) => completions.push({ sessionId, message }));
  p.onError((sessionId, error) => errors.push({ sessionId, error }));
  p.onToolCall((sessionId, tool) => tools.push({ sessionId, tool }));
  p.onApprovalRequest((sessionId, request) => approvals.push({ sessionId, request }));
  p.onStatus((sessionId, status) => statuses.push({ sessionId, status }));
  p.onSessionInfo((sessionId, info) => sessionInfos.push({ sessionId, info }));
  return { deltas, completions, errors, tools, approvals, statuses, sessionInfos };
}

describe('Qoder SDK import surface and config gates', () => {
  it('smoke-checks the real SDK exports required by the provider', async () => {
    const actual = await vi.importActual<typeof import('@qoder-ai/qoder-agent-sdk')>('@qoder-ai/qoder-agent-sdk');

    expect(actual.query).toEqual(expect.any(Function));
    expect(actual.accessTokenFromEnv).toEqual(expect.any(Function));
    expect(actual.qodercliAuth).toEqual(expect.any(Function));
    expect(actual.hasResolvableQoderWorkerRuntime).toEqual(expect.any(Function));
  });

  it('reports local-sdk/shared metadata and proof-gated capabilities', async () => {
    const p = await makeProvider();

    expect(p.id).toBe('qoder-sdk');
    expect(p.connectionMode).toBe('local-sdk');
    expect(p.sessionOwnership).toBe('shared');
    expect(p.capabilities).toMatchObject({
      streaming: true,
      toolCalling: true,
      approval: true,
      sessionRestore: false,
      attachments: false,
      reasoningEffort: false,
    });
    await expect(p.listModels()).resolves.toMatchObject({
      models: [],
      isAuthenticated: false,
    });
  });

  it('rejects unsupported or dangerous transport config fields', () => {
    expect(normalizeQoderTransportConfig({ transportConfig: { mcpServers: {} } }).ok).toBe(false);
    expect(normalizeQoderTransportConfig({ transportConfig: { skills: ['x'] } }).ok).toBe(false);
    expect(normalizeQoderTransportConfig({ transportConfig: { plugins: [] } }).ok).toBe(false);
    expect(normalizeQoderTransportConfig({ transportConfig: { settings: {} } }).ok).toBe(false);
    expect(normalizeQoderTransportConfig({ transportConfig: { token: 'Bearer secret123456' } }).ok).toBe(false);
    expect(normalizeQoderTransportConfig({ transportConfig: { permissionMode: 'yolo' } }).ok).toBe(false);
    expect(normalizeQoderTransportConfig({ transportConfig: { accessTokenEnvVar: 'PATH' } }).ok).toBe(false);
    expect(normalizeQoderTransportConfig({ transportConfig: { accessTokenEnvVar: 'NODE_OPTIONS' } }).ok).toBe(false);
    expect(normalizeQoderTransportConfig({ transportConfig: { accessTokenEnvVar: 'IMCODES_QODER_TEST_TOKEN' } }).ok).toBe(true);

    const secretLikePath = { transportConfig: { pathToQoderCLIExecutable: 'qdr_1234567890123456' } };
    expect(normalizeQoderTransportConfig(secretLikePath).ok).toBe(false);
    expect(normalizeQoderTransportConfig(secretLikePath).ok).toBe(false);

    const allowed = normalizeQoderTransportConfig({
      transportConfig: { permissionMode: 'yolo', allowDangerousPermissionBypass: true },
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.config.allowDangerousPermissionBypass).toBe(true);
  });
});

describe('Qoder SDK readiness and streaming fixtures', () => {
  it('keeps provider connected but send-degraded when the local runtime is unavailable', async () => {
    sdkMock.state.runtimePresent = false;
    const p = await makeProvider();
    const route = await createReadySession(p);

    expect(p.getSessionDiagnostics(route)).toMatchObject({
      readiness: {
        runtimeReady: 'degraded',
        sendReady: 'degraded',
      },
    });
    await expect(p.send(route, 'hello')).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
      details: { reason: QODER_READINESS_REASON.RUNTIME_MISSING },
    });
    expect(sdkMock.state.calls).toHaveLength(0);
  });

  it('uses daemon-owned PAT env only and supports allowlisted custom PAT env vars', async () => {
    process.env.IMCODES_QODER_TEST_TOKEN = 'pat_custom_process_secret';
    const p = await makeProvider();
    const route = await p.createSession({
      sessionKey: 'route-custom-auth',
      sessionName: 'deck_alpha_worker',
      projectName: 'alpha',
      serverId: 'srv-bound',
      cwd: '/tmp/project',
      env: {
        IMCODES_QODER_TEST_TOKEN: 'spoofed_session_secret',
        QODER_PERSONAL_ACCESS_TOKEN: 'spoofed_default_secret',
      },
      settings: { accessTokenEnvVar: 'IMCODES_QODER_TEST_TOKEN' },
    });
    sdkMock.state.scripts.push([{ type: 'result', subtype: 'success', result: 'ok', uuid: 'custom-auth' }]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(sdkMock.state.calls).toHaveLength(1));

    expect(sdkMock.state.calls[0].options.auth).toEqual({
      type: 'accessToken',
      accessToken: { envVar: 'IMCODES_QODER_TEST_TOKEN' },
    });
    expect(sdkMock.state.calls[0].options.env?.IMCODES_QODER_TEST_TOKEN).toBe('pat_custom_process_secret');
    expect(sdkMock.state.calls[0].options.env?.QODER_PERSONAL_ACCESS_TOKEN).toBeUndefined();
  });

  it('treats qodercli auth reuse as proof-gated and does not start a query', async () => {
    const p = await makeProvider();
    const route = await p.createSession({
      sessionKey: 'route-qodercli-auth',
      sessionName: 'deck_alpha_worker',
      projectName: 'alpha',
      serverId: 'srv-bound',
      cwd: '/tmp/project',
      env: { QODER_PERSONAL_ACCESS_TOKEN: 'spoofed_session_secret' },
      settings: { authMode: 'qodercli' },
    });

    await expect(p.send(route, 'hello')).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
      details: { reason: QODER_READINESS_REASON.UNPROVEN_CAPABILITY },
    });
    expect(sdkMock.qodercliAuth).not.toHaveBeenCalled();
    expect(sdkMock.state.calls).toHaveLength(0);
  });

  it('wires WorkerTransport and preflights explicit worker runtime paths', async () => {
    sdkMock.state.runtimePresent = false;
    sdkMock.state.workerPresent = true;
    const p = await makeProvider();
    const route = await createReadySession(p, {
      useWorkerRuntime: true,
      pathToQoderWorkerRuntime: '/opt/qoder-worker-runtime.obf.mjs',
    });
    sdkMock.state.scripts.push([{ type: 'result', subtype: 'success', result: 'worker ok', uuid: 'worker-ok' }]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(sdkMock.state.calls).toHaveLength(1));

    expect(sdkMock.hasResolvableQoderWorkerRuntime).toHaveBeenCalledWith('/opt/qoder-worker-runtime.obf.mjs');
    expect(sdkMock.WorkerTransport).toHaveBeenCalledWith({
      pathToQoderWorkerRuntime: '/opt/qoder-worker-runtime.obf.mjs',
      closeGraceMs: 2000,
    });
    expect(sdkMock.state.calls[0].options.transport).toBeInstanceOf(sdkMock.WorkerTransport as any);
    expect(sdkMock.state.calls[0].options.pathToQoderCLIExecutable).toBeUndefined();
  });

  it('rejects missing worker runtime before query when worker mode is configured', async () => {
    sdkMock.state.runtimePresent = false;
    sdkMock.state.workerPresent = false;
    const p = await makeProvider();
    const route = await createReadySession(p, { useWorkerRuntime: true });

    await expect(p.send(route, 'hello')).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
      details: { reason: QODER_READINESS_REASON.RUNTIME_MISSING },
    });
    expect(sdkMock.state.calls).toHaveLength(0);
  });

  it('rejects send when PAT auth is missing and does not treat connect as send-ready', async () => {
    const p = await makeProvider();
    const route = await p.createSession({
      sessionKey: 'route-auth',
      sessionName: 'deck_alpha_worker',
      projectName: 'alpha',
      serverId: 'srv-bound',
      cwd: '/tmp/project',
      env: { PATH: '/usr/bin', HOME: '/tmp/home' },
    });

    expect(p.getSessionDiagnostics(route)).toMatchObject({
      readiness: {
        sendReady: 'degraded',
        reasons: expect.arrayContaining([QODER_READINESS_REASON.AUTH_MISSING]),
      },
    });
    await expect(p.send(route, 'hello')).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.AUTH_FAILED,
      details: { reason: QODER_READINESS_REASON.AUTH_MISSING },
    });
    expect(sdkMock.state.calls).toHaveLength(0);
  });

  it('builds strict managed MCP options and minimizes Qoder process/MCP env', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([
      {
        type: 'system',
        subtype: 'init',
        session_id: 'qoder-session-1',
        model: 'performance',
        mcp_servers: [{ name: IMCODES_MEMORY_MCP_SERVER_NAME, status: 'connected' }],
      },
      { type: 'result', subtype: 'success', result: 'ok', uuid: 'result-1', usage: { input_tokens: 1, output_tokens: 2 } },
    ]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(events.completions).toHaveLength(1));

    const call = sdkMock.state.calls[0];
    expect(call.prompt).toBe('hello');
    expect(call.options).toMatchObject({
      includePartialMessages: true,
      strictMcpConfig: true,
      allowedMcpServerNames: [IMCODES_MEMORY_MCP_SERVER_NAME],
      maxTurns: 1,
      permissionMode: 'default',
    });
    expect(call.options.auth).toEqual({
      type: 'accessToken',
      accessToken: { envVar: 'QODER_PERSONAL_ACCESS_TOKEN' },
    });
    expect(call.options.env).toMatchObject({
      QODER_PERSONAL_ACCESS_TOKEN: 'pat_process_secret',
    });
    expect(call.options.env?.PATH).toBe(process.env.PATH);
    expect(call.options.env?.HOME).toBe(process.env.HOME);
    expect(call.options.env?.IMCODES_SERVER_TOKEN).toBeUndefined();
    expect(call.options.env?.OPENAI_API_KEY).toBeUndefined();
    const memoryServer = call.options.mcpServers?.[IMCODES_MEMORY_MCP_SERVER_NAME] as any;
    expect(memoryServer).toMatchObject({
      type: 'stdio',
      command: 'imcodes',
      args: ['memory', 'mcp'],
    });
    expect(memoryServer.env.IMCODES_SERVER_TOKEN).toBeUndefined();
    expect(memoryServer.env.OPENAI_API_KEY).toBeUndefined();
    expect(p.getMemoryMcpStatus()).toMatchObject({
      providerId: 'qoder-sdk',
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
    });
    expect(events.completions[0].message.metadata).toMatchObject({
      provider: 'qoder-sdk',
      model: 'performance',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(events.sessionInfos.every((event) => typeof event.info.resumeId !== 'string')).toBe(true);
  });

  it('degrades managed MCP when runtime identity is incomplete', async () => {
    const p = await makeProvider();
    process.env.QODER_PERSONAL_ACCESS_TOKEN = 'pat_process_secret';
    const route = await p.createSession({
      sessionKey: 'route-no-identity',
      cwd: '/tmp/project',
      env: { QODER_PERSONAL_ACCESS_TOKEN: 'pat_test_secret' },
    });
    sdkMock.state.scripts.push([{ type: 'result', subtype: 'success', result: 'ok', uuid: 'result-2' }]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(sdkMock.state.calls).toHaveLength(1));

    expect(sdkMock.state.calls[0].options.mcpServers).toBeUndefined();
    expect(p.getMemoryMcpStatus()).toMatchObject({
      status: MEMORY_MCP_STATUS.DEGRADED,
      degradedReasons: expect.arrayContaining([QODER_READINESS_REASON.MCP_IDENTITY_MISSING]),
    });
  });

  it('uses learned Qoder session_id only for in-process continuation, not durable resume', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'init', session_id: 'qoder-live-session', model: 'performance' },
      { type: 'result', subtype: 'success', result: 'first', uuid: 'first-result' },
    ]);
    sdkMock.state.scripts.push([
      { type: 'result', subtype: 'success', result: 'second', uuid: 'second-result' },
    ]);

    await p.send(route, 'first');
    await vi.waitFor(() => expect(events.completions).toHaveLength(1));
    await p.send(route, 'second');
    await vi.waitFor(() => expect(events.completions).toHaveLength(2));

    expect(sdkMock.state.calls[0].options.sessionId).toBeUndefined();
    expect(sdkMock.state.calls[0].options.continue).toBeUndefined();
    expect(sdkMock.state.calls[0].options.resume).toBeUndefined();
    expect(sdkMock.state.calls[1].options.sessionId).toBe('qoder-live-session');
    expect(sdkMock.state.calls[1].options.continue).toBe(true);
    expect(sdkMock.state.calls[1].options.resume).toBeUndefined();
    expect(events.sessionInfos.every((event) => typeof event.info.resumeId !== 'string')).toBe(true);
  });

  it('assembles provider system prompt from split context once without legacy duplication', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    sdkMock.state.scripts.push([{ type: 'result', subtype: 'success', result: 'ok', uuid: 'system-prompt' }]);

    await p.send(route, {
      userMessage: 'hello',
      assembledMessage: 'hello',
      sessionSystemText: 'SESSION_SENTINEL',
      turnSystemText: 'TURN_SENTINEL',
      systemText: 'SESSION_SENTINEL\n\nTURN_SENTINEL',
      context: {
        sessionSystemText: 'SESSION_SENTINEL',
        turnSystemText: 'TURN_SENTINEL',
        systemText: 'SESSION_SENTINEL\n\nTURN_SENTINEL',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'test' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        providerPolicyOutcome: 'allowed',
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    } as any);
    await vi.waitFor(() => expect(sdkMock.state.calls).toHaveLength(1));

    const systemPrompt = String(sdkMock.state.calls[0].options.systemPrompt ?? '');
    expect(systemPrompt.match(/SESSION_SENTINEL/g)).toHaveLength(1);
    expect(systemPrompt.match(/TURN_SENTINEL/g)).toHaveLength(1);
  });

  it('maps text, thinking, tool input deltas, tool-use blocks, unknown messages, and one success completion', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'init', session_id: 'qoder-session-2', model: 'performance' },
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'pwd"}' } } },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'future_event' } },
      { type: 'result', subtype: 'success', result: 'Hello', uuid: 'result-3', usage: { input_tokens: 3 } },
      { type: 'result', subtype: 'success', result: 'late duplicate', uuid: 'result-4' },
    ]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(events.completions).toHaveLength(1));

    expect(events.deltas.filter((event) => event.delta.type === 'text').map((event) => event.delta.delta)).toEqual(['Hel', 'lo']);
    expect(events.statuses.some((event) => event.status.status === 'thinking')).toBe(true);
    expect(events.tools).toEqual([
      expect.objectContaining({ tool: expect.objectContaining({ id: 'tool-1', status: 'running' }) }),
      expect.objectContaining({ tool: expect.objectContaining({ id: 'tool-1', status: 'complete' }) }),
    ]);
    expect(events.deltas.some((event) => event.delta.toolUse?.input?.command === 'pwd')).toBe(true);
    expect(events.completions[0].message.content).toBe('Hello');
    expect(events.completions[0].message.metadata.usage).toEqual({ input_tokens: 3 });
    expect(p.getSessionDiagnostics(route)).toMatchObject({
      unknownMessageCount: 1,
      qoderSessionIdKnown: true,
    });
  });

  it('maps result errors to one provider error', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([
      { type: 'result', subtype: 'error_during_execution', errors: ['boom secret qdr_1234567890123456'], uuid: 'err-1' },
      { type: 'result', subtype: 'error_during_execution', errors: ['late'] },
    ]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(events.errors).toHaveLength(1));

    expect(events.completions).toHaveLength(0);
    expect(events.errors[0].error.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_ERROR);
    expect(events.errors[0].error.message).not.toContain('qdr_1234567890123456');
  });

  it('maps SDK protocol mismatch and rejected auth failures to structured errors', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([
      async () => {
        throw Object.assign(new Error('protocol mismatch'), { name: 'ProtocolVersionMismatchError' });
      },
    ]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(events.errors).toHaveLength(1));
    expect(events.errors[0].error).toMatchObject({
      code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
      details: { reason: QODER_READINESS_REASON.RUNTIME_INCOMPATIBLE },
    });

    sdkMock.state.scripts.push([
      async () => {
        throw Object.assign(new Error('authentication failed'), { code: 'auth_failed' });
      },
    ]);
    await p.send(route, 'hello again');
    await vi.waitFor(() => expect(events.errors).toHaveLength(2));
    expect(events.errors[1].error).toMatchObject({
      code: PROVIDER_ERROR_CODES.AUTH_FAILED,
      details: { reason: QODER_READINESS_REASON.AUTH_FAILED },
    });
  });

  it('rejects overlapping ordinary sends while leaving cancel as a priority path', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([{ waitForInterrupt: true, lateMessages: [] }]);

    await p.send(route, 'first');
    await expect(p.send(route, 'second')).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      recoverable: true,
    });
    await p.cancel(route);
    await vi.waitFor(() => expect(events.errors).toHaveLength(1));
    expect(events.errors[0].error.code).toBe(PROVIDER_ERROR_CODES.CANCELLED);
  });

  it('bridges approval requests and rejects stale or cross-session approval responses', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([
      async ({ call, state }: any) => {
        const result = await call.options.canUseTool?.(
          'Bash',
          { command: 'pwd', token: 'qdr_1234567890123456' },
          { toolUseID: 'tool-approve', signal: new AbortController().signal, title: 'Run pwd' },
        );
        state.permissionResults.push(result);
      },
      { type: 'result', subtype: 'success', result: 'approved', uuid: 'approval-result' },
    ]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(events.approvals).toHaveLength(1));

    await expect(p.respondApproval('other-session', events.approvals[0].request.id, true)).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND,
    });
    await expect(p.respondApproval(route, 'malformed', true)).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
    });
    await expect(p.respondApproval(route, events.approvals[0].request.id.replace('tool-approve', 'tool-tampered'), true)).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
    });
    expect(events.approvals[0].request).toMatchObject({
      id: 'qoder:route-1:1:tool-approve',
      provider: 'qoder-sdk',
      providerGeneration: 1,
      providerToolUseId: 'tool-approve',
      description: 'Run pwd',
      tool: 'Bash',
    });
    expect(events.approvals[0].request.inputPreview).toContain('"command":"pwd"');
    expect(events.approvals[0].request.inputPreview).toContain('"token":"[REDACTED]"');
    expect(events.approvals[0].request.inputPreview).not.toContain('qdr_1234567890123456');
    await p.respondApproval(route, events.approvals[0].request.id, true);
    await vi.waitFor(() => expect(events.completions).toHaveLength(1));
    expect(sdkMock.state.permissionResults[0]).toEqual({ behavior: 'allow' });
  });

  it('denies pending approval callbacks during provider disconnect', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([
      async ({ call, state }: any) => {
        const result = await call.options.canUseTool?.(
          'Bash',
          { command: 'pwd' },
          { toolUseID: 'tool-disconnect', signal: new AbortController().signal, title: 'Run pwd' },
        );
        state.permissionResults.push(result);
      },
      { type: 'result', subtype: 'success', result: 'should-not-complete', uuid: 'disconnect-result' },
    ]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(events.approvals).toHaveLength(1));
    await p.disconnect();
    await vi.waitFor(() => expect(sdkMock.state.permissionResults).toHaveLength(1));

    expect(sdkMock.state.permissionResults[0]).toMatchObject({ behavior: 'deny' });
    expect(events.completions).toHaveLength(0);
  });

  it('denies approval callbacks on timeout', async () => {
    vi.useFakeTimers();
    const p = await makeProvider();
    const route = await createReadySession(p, { approvalBridgeTimeoutMs: 1200 });
    const events = collect(p);
    sdkMock.state.scripts.push([
      async ({ call, state }: any) => {
        const result = await call.options.canUseTool?.(
          'Bash',
          { command: 'pwd' },
          { toolUseID: 'tool-timeout', signal: new AbortController().signal, title: 'Run pwd' },
        );
        state.permissionResults.push(result);
      },
      { type: 'result', subtype: 'success', result: 'denied', uuid: 'timeout-result' },
    ]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(events.approvals).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1200);
    await vi.waitFor(() => expect(sdkMock.state.permissionResults).toHaveLength(1));

    expect(sdkMock.state.permissionResults[0]).toMatchObject({ behavior: 'deny' });
    vi.useRealTimers();
  });

  it('treats compact_boundary as status-only and emits one terminal result', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'result', subtype: 'success', result: 'after compact', uuid: 'compact-result' },
      { type: 'result', subtype: 'success', result: 'late compact duplicate', uuid: 'compact-result-2' },
    ]);

    await p.send(route, '/compact');
    await vi.waitFor(() => expect(events.completions).toHaveLength(1));

    expect(events.statuses.some((event) => event.status.status === 'qoder_compact_boundary')).toBe(true);
    expect(events.completions[0].message.kind).toBe('text');
    expect(events.completions[0].message.content).toBe('after compact');
    expect(events.errors).toHaveLength(0);
  });

  it('fails closed and unlocks the session when the SDK stream ends without result or error', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'compact_boundary' },
    ]);

    await p.send(route, 'no terminal');
    await vi.waitFor(() => expect(events.errors).toHaveLength(1));
    expect(events.errors[0].error.message).toContain('ended without a terminal result');
    expect(p.getSessionDiagnostics(route)).toMatchObject({ active: false });

    sdkMock.state.scripts.push([{ type: 'result', subtype: 'success', result: 'next ok', uuid: 'next-ok' }]);
    await p.send(route, 'next');
    await vi.waitFor(() => expect(events.completions).toHaveLength(1));
    expect(events.completions[0].message.content).toBe('next ok');
  });

  it('uses local-abandon cancel and suppresses late events after generation rotation', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([
      {
        waitForInterrupt: true,
        lateMessages: [
          { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'late' } } },
          { type: 'result', subtype: 'success', result: 'late', uuid: 'late-result' },
        ],
      },
    ]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(sdkMock.state.calls).toHaveLength(1));
    await p.cancel(route);
    await vi.waitFor(() => expect(events.errors).toHaveLength(1));

    expect(sdkMock.state.interrupted).toBe(1);
    expect(events.errors[0].error.code).toBe(PROVIDER_ERROR_CODES.CANCELLED);
    expect(events.completions).toHaveLength(0);
    expect(events.deltas).toHaveLength(0);
  });
});
