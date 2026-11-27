import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { Options as QoderOptions } from '@qoder-ai/qoder-agent-sdk';

const sdkMock = vi.hoisted(() => {
  const state = {
    runtimePresent: true,
    workerPresent: false,
    scripts: [] as any[][],
    calls: [] as Array<{ prompt: string | AsyncIterable<any>; options: QoderOptions }>,
    interrupted: 0,
    closed: 0,
    permissionResults: [] as any[],
    mcpStatus: [] as any[],
    models: [] as any[],
    queries: [] as any[],
    streamInputs: [] as any[],
    pauseInputAfterCount: null as number | null,
    resumeInput: null as Promise<void> | null,
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
    state.queries = [];
    state.streamInputs = [];
    state.pauseInputAfterCount = null;
    state.resumeInput = null;
    query.mockClear();
    accessTokenFromEnv.mockClear();
    qodercliAuth.mockClear();
    inspectQoderSdkPackage.mockClear();
    pathExistsExecutable.mockClear();
    hasResolvableQoderWorkerRuntime.mockClear();
    WorkerTransport.mockClear();
  };

  const query = vi.fn((call: { prompt: string | AsyncIterable<any>; options: QoderOptions }) => {
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
    queryObject.initializationResult = vi.fn(async () => ({ commands: [], agents: [] }));
    queryObject.streamInput = vi.fn(async (input: AsyncIterable<any>) => {
      for await (const message of input) state.streamInputs.push(message);
    });
    state.queries.push(queryObject);
    if (typeof call.prompt !== 'string') {
      void (async () => {
        const iterator = call.prompt[Symbol.asyncIterator]();
        let paused = false;
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          // Pull first, then optionally pause before recording the write. This
          // models QueryRunner having received/yielded the entry while its
          // transport.write admission is still pending. Calling next again is
          // what resolves QoderInputQueue's admission promise.
          if (!paused
            && state.pauseInputAfterCount !== null
            && state.streamInputs.length === state.pauseInputAfterCount) {
            paused = true;
            await state.resumeInput;
          }
          state.streamInputs.push(next.value);
        }
      })();
    }
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
import {
  IMCODES_MEMORY_MCP_LAUNCH_ARGS,
  IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
} from '../../src/agent/providers/getDefaultMcpServers.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
} from '../../shared/agent-delegation.js';
import { PROVIDER_ACTIVE_TURN_DELIVERY_KINDS } from '../../src/agent/transport-provider.js';

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
  const usages: any[] = [];
  p.onDelta((sessionId, delta) => deltas.push({ sessionId, delta }));
  p.onComplete((sessionId, message) => completions.push({ sessionId, message }));
  p.onError((sessionId, error) => errors.push({ sessionId, error }));
  p.onToolCall((sessionId, tool) => tools.push({ sessionId, tool }));
  p.onApprovalRequest((sessionId, request) => approvals.push({ sessionId, request }));
  p.onStatus((sessionId, status) => statuses.push({ sessionId, status }));
  p.onSessionInfo((sessionId, info) => sessionInfos.push({ sessionId, info }));
  p.onUsage((sessionId, usage) => usages.push({ sessionId, usage }));
  return { deltas, completions, errors, tools, approvals, statuses, sessionInfos, usages };
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
      activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
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
  it('does not resolve provider send-start until the SDK has admitted the original prompt', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    let admitInitial!: () => void;
    sdkMock.state.pauseInputAfterCount = 0;
    sdkMock.state.resumeInput = new Promise<void>((resolve) => { admitInitial = resolve; });
    let releaseTurn!: () => void;
    const holdTurn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    sdkMock.state.scripts.push([async () => {
      await holdTurn;
      return { type: 'result', subtype: 'success', result: 'done', uuid: 'qoder-initial-admitted' };
    }]);

    let sendSettled = false;
    const send = p.send(route, 'A').then(() => { sendSettled = true; });
    await vi.waitFor(() => expect(sdkMock.state.queries).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendSettled).toBe(false);
    expect(sdkMock.state.streamInputs).toHaveLength(0);

    admitInitial();
    await send;
    expect(sdkMock.state.streamInputs[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'A' }] },
    });
    releaseTurn();
  });

  it('streams active-turn input with next priority, stable UUID dedupe, and correct human provenance', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    let releaseTurn!: () => void;
    const holdTurn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    sdkMock.state.scripts.push([
      async () => {
        await holdTurn;
        return { type: 'result', subtype: 'success', result: 'done', uuid: 'qoder-done' };
      },
    ]);
    await p.send(route, 'foreground');
    await vi.waitFor(() => expect(sdkMock.state.queries).toHaveLength(1));
    const notification = {
      notificationId: 'qoder-append-stable-id',
      delegationId: 'composer-append',
      sourceSessionName: route,
      text: 'follow up now',
      deliveryKind: PROVIDER_ACTIVE_TURN_DELIVERY_KINDS.MCP_MESSAGE,
    } as const;

    await expect(p.notifyActiveDelegation(route, notification))
      .resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await expect(p.notifyActiveDelegation(route, notification))
      .resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);

    await vi.waitFor(() => expect(sdkMock.state.streamInputs).toHaveLength(2));
    expect(sdkMock.state.queries[0].streamInput).not.toHaveBeenCalled();
    expect(sdkMock.state.calls[0].prompt).toEqual(expect.objectContaining({
      [Symbol.asyncIterator]: expect.any(Function),
    }));
    expect(sdkMock.state.streamInputs[1]).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'follow up now' }] },
      parent_tool_use_id: null,
      uuid: 'qoder-append-stable-id',
      priority: 'next',
    });
    releaseTurn();
  });

  it('marks peer notifications synthetic while preserving Qoder next scheduling', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    let releaseTurn!: () => void;
    const holdTurn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    sdkMock.state.scripts.push([async () => {
      await holdTurn;
      return { type: 'result', subtype: 'success', result: 'done', uuid: 'qoder-done' };
    }]);
    await p.send(route, 'foreground');

    await expect(p.notifyActiveDelegation(route, {
      notificationId: 'qoder-peer-id',
      delegationId: 'delegation-1',
      sourceSessionName: 'deck_source_worker',
      text: 'audit result',
    })).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    await vi.waitFor(() => expect(sdkMock.state.streamInputs).toHaveLength(2));
    expect(sdkMock.state.streamInputs[1]).toMatchObject({
      uuid: 'qoder-peer-id',
      priority: 'next',
      isSynthetic: true,
    });
    releaseTurn();
  });

  it('does not replay an append already pulled by Qoder when the turn settles', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    let consumeInput!: () => void;
    sdkMock.state.pauseInputAfterCount = 1;
    sdkMock.state.resumeInput = new Promise<void>((resolve) => { consumeInput = resolve; });
    let releaseTurn!: () => void;
    const holdTurn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    sdkMock.state.scripts.push([async () => {
      await holdTurn;
      return { type: 'result', subtype: 'success', result: 'done', uuid: 'qoder-done' };
    }]);
    await p.send(route, 'foreground');
    await vi.waitFor(() => expect(sdkMock.state.streamInputs).toHaveLength(1));
    const admission = p.notifyActiveDelegation(route, {
      notificationId: 'qoder-raced-idle',
      delegationId: 'composer-append',
      sourceSessionName: route,
      text: 'must not start another turn',
    });
    releaseTurn();
    let settled = false;
    void admission.finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    consumeInput();
    await expect(admission).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    expect(sdkMock.state.streamInputs).toHaveLength(2);
  });

  it('does not replay an append already pulled by Qoder when the output stream fails', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    let consumeInput!: () => void;
    sdkMock.state.pauseInputAfterCount = 1;
    sdkMock.state.resumeInput = new Promise<void>((resolve) => { consumeInput = resolve; });
    let failTurn!: () => void;
    const failureGate = new Promise<void>((resolve) => { failTurn = resolve; });
    sdkMock.state.scripts.push([async () => {
      await failureGate;
      throw new Error('Qoder transport write failed');
    }]);
    await p.send(route, 'foreground');
    await vi.waitFor(() => expect(sdkMock.state.streamInputs).toHaveLength(1));
    const admission = p.notifyActiveDelegation(route, {
      notificationId: 'qoder-retry-id',
      delegationId: 'composer-append',
      sourceSessionName: route,
      text: 'retry me',
    });
    failTurn();
    let settled = false;
    void admission.finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    consumeInput();
    await expect(admission).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    expect(sdkMock.state.streamInputs).toHaveLength(2);
  });

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
    await vi.waitFor(() => expect(sdkMock.state.streamInputs).toHaveLength(1));
    expect(sdkMock.state.streamInputs[0]).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(call.options).toMatchObject({
      includePartialMessages: true,
      strictMcpConfig: true,
      allowedMcpServerNames: [IMCODES_MEMORY_MCP_SERVER_NAME],
      permissionMode: 'default',
    });
    expect(call.options.maxTurns).toBeUndefined();
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
      command: IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
      args: [...IMCODES_MEMORY_MCP_LAUNCH_ARGS],
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

  it('treats compact_boundary as compacting status, clears on completion, and emits one terminal result', async () => {
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

    expect(events.statuses.some((event) => event.status.status === 'compacting')).toBe(true);
    expect(events.statuses.at(-1)?.status).toEqual({ status: null, label: null });
    expect(events.completions[0].message.kind).toBe('text');
    expect(events.completions[0].message.content).toBe('after compact');
    expect(events.errors).toHaveLength(0);
  });

  it('emits live and finalized exact context token usage via onUsage and modelUsage contextWindow', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'init', session_id: 'qoder-usage-1', model: 'performance' },
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            id: 'msg-usage-1',
            model: 'performance',
            usage: { input_tokens: 12000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 1 },
          },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { output_tokens: 45 },
        },
      },
      {
        type: 'assistant',
        uuid: 'asst-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Working' }],
          usage: { input_tokens: 14500, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, output_tokens: 80 },
        },
      },
      { type: 'stream_event', event: { type: 'message_stop' } },
      {
        type: 'result',
        subtype: 'success',
        result: 'Done',
        uuid: 'res-usage-1',
        usage: { input_tokens: 26500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500, output_tokens: 125 },
        modelUsage: {
          performance: {
            inputTokens: 26500,
            outputTokens: 125,
            cacheReadInputTokens: 8000,
            cacheCreationInputTokens: 500,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 256000,
            maxOutputTokens: 16384,
          },
        },
      },
    ]);

    await p.send(route, 'check usage');
    await vi.waitFor(() => expect(events.completions).toHaveLength(1));

    // message_start, message_delta (preserving input/cache), assistant, finalized result
    expect(events.usages).toHaveLength(4);
    expect(events.usages[0].usage).toMatchObject({
      messageId: 'msg-usage-1',
      model: 'performance',
      usage: { input_tokens: 12000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 1 },
    });
    expect(events.usages[0].usage.finalized).toBeUndefined();
    expect(events.usages[1].usage.usage).toMatchObject({
      input_tokens: 12000,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 500,
      output_tokens: 45,
    });
    expect(events.usages[3].usage).toEqual({
      messageId: 'res-usage-1',
      finalized: true,
      model: 'performance',
      usage: {
        input_tokens: 14500,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 0,
        output_tokens: 80,
        model_context_window: 256000,
      },
    });
    expect(events.completions[0].message.metadata.usage).toEqual({
      input_tokens: 14500,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 0,
      output_tokens: 80,
      model_context_window: 256000,
    });
    expect(events.completions[0].message.metadata.totalUsage).toMatchObject({
      input_tokens: 26500,
      output_tokens: 125,
    });
    expect(p.getSessionDiagnostics(route)).toMatchObject({ unknownMessageCount: 0 });
  });

  it('isolates subagent usage/models from main session and does not guess mismatched modelUsage contextWindow', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);

    // 1. Main stream 12000/256000 -> subagent stream/assistant 75/8000 -> main result preserves parent model & usage
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'init', session_id: 'qoder-sub-1', model: 'performance' },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: {
            id: 'main-msg-1',
            model: 'performance',
            usage: { input_tokens: 12000, cache_read_input_tokens: 0, output_tokens: 5 },
          },
        },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_sub_1',
        event: {
          type: 'message_start',
          message: {
            id: 'sub-msg-1',
            model: 'qoder-fast-sub',
            usage: { input_tokens: 75, cache_read_input_tokens: 0, output_tokens: 2 },
          },
        },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_sub_1',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'sub-delta' },
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_sub_1',
        uuid: 'sub-asst-1',
        message: {
          id: 'sub-msg-1',
          role: 'assistant',
          model: 'qoder-fast-sub',
          content: [{ type: 'text', text: 'sub-full' }],
          usage: { input_tokens: 75, output_tokens: 9 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Main complete',
        uuid: 'res-sub-1',
        num_turns: 1,
        usage: { input_tokens: 12075, cache_read_input_tokens: 0, output_tokens: 14 },
        modelUsage: {
          'qoder-fast-sub': {
            inputTokens: 75,
            outputTokens: 9,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.001,
            contextWindow: 8000,
            maxOutputTokens: 4096,
          },
          performance: {
            inputTokens: 12000,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 256000,
            maxOutputTokens: 16384,
          },
        },
      },
    ]);

    await p.send(route, 'subagent test');
    await vi.waitFor(() => expect(events.completions).toHaveLength(1));

    expect(events.sessionInfos.some((e) => e.info.model === 'qoder-fast-sub')).toBe(false);
    expect(events.deltas.some((e) => e.delta.delta === 'sub-delta')).toBe(true);
    expect(events.usages).toHaveLength(2);
    expect(events.usages.every((e) => e.usage.model === 'performance')).toBe(true);
    expect(events.usages[1].usage).toEqual({
      messageId: 'res-sub-1',
      finalized: true,
      model: 'performance',
      usage: {
        input_tokens: 12000,
        cache_read_input_tokens: 0,
        output_tokens: 5,
        model_context_window: 256000,
      },
    });
    expect(events.completions[0].message.metadata.model).toBe('performance');
    expect(events.completions[0].message.metadata.usage).toEqual(events.usages[1].usage.usage);

    // 2. When active model key is absent from modelUsage, never pick an unrelated model's contextWindow
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'init', session_id: 'qoder-sub-1', model: 'performance' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: 'main-asst-2',
        message: {
          id: 'main-msg-2',
          role: 'assistant',
          model: 'performance',
          content: [{ type: 'text', text: 'Done' }],
          usage: { input_tokens: 9000, output_tokens: 15 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Done',
        uuid: 'res-sub-2',
        num_turns: 1,
        usage: { input_tokens: 9000, output_tokens: 15 },
        modelUsage: {
          'unrelated-subagent': {
            inputTokens: 75,
            outputTokens: 9,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.001,
            contextWindow: 8000,
            maxOutputTokens: 4096,
          },
        },
      },
    ]);

    await p.send(route, 'missing key test');
    await vi.waitFor(() => expect(events.completions).toHaveLength(2));

    expect(events.completions[1].message.metadata.usage).toEqual({
      input_tokens: 9000,
      output_tokens: 15,
    });
    expect(events.usages.at(-1)?.usage.usage.model_context_window).toBeUndefined();
  });

  it('scopes usage snapshots per request, honors explicit zero resets, and avoids multi-turn cumulative spoofing', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);

    // Request 1 sets cache_read_input_tokens=4000 then explicit 0 in delta;
    // Request 2 has new id and output-only usage (must not inherit Request 1 input_tokens);
    // Multi-turn result shares identical finalized snapshot between onUsage & metadata.usage,
    // leaving cumulative result.usage in metadata.totalUsage.
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'init', session_id: 'qoder-req-1', model: 'performance' },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: {
            id: 'req-msg-1',
            model: 'performance',
            usage: { request_id: 'req-1', input_tokens: 12000, cache_read_input_tokens: 4000, output_tokens: 1 },
          },
        },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_delta',
          usage: { request_id: 'req-1', cache_read_input_tokens: 0, output_tokens: 20 },
        },
      },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: 'asst-req-2',
        message: {
          id: 'req-msg-2',
          role: 'assistant',
          model: 'performance',
          content: [{ type: 'text', text: 'Step 2' }],
          usage: { request_id: 'req-2', output_tokens: 30 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Step 2',
        uuid: 'res-multi-1',
        num_turns: 2,
        usage: {
          input_tokens: 26500,
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 500,
          cached_input_tokens: 8000,
          output_tokens: 50,
        },
        modelUsage: {
          performance: {
            inputTokens: 26500,
            outputTokens: 50,
            cacheReadInputTokens: 8000,
            cacheCreationInputTokens: 500,
            webSearchRequests: 0,
            costUSD: 0.02,
            contextWindow: 256000,
            maxOutputTokens: 16384,
          },
        },
      },
    ]);

    await p.send(route, 'multi request');
    await vi.waitFor(() => expect(events.completions).toHaveLength(1));

    // Zero reset on Request 1 delta
    expect(events.usages[1].usage.usage).toEqual({
      input_tokens: 12000,
      cache_read_input_tokens: 0,
      output_tokens: 20,
    });
    // Request 2 must not inherit Request 1's input_tokens
    expect(events.usages[2].usage.usage).toEqual({
      output_tokens: 30,
    });
    // Finalized usage & metadata.usage share exact Request 2 snapshot + model window; totalUsage kept separate
    expect(events.usages[3].usage).toEqual({
      messageId: 'res-multi-1',
      finalized: true,
      model: 'performance',
      usage: {
        output_tokens: 30,
        model_context_window: 256000,
      },
    });
    expect(events.completions[0].message.metadata.usage).toEqual(events.usages[3].usage.usage);
    expect(events.completions[0].message.metadata.usage).not.toHaveProperty('cached_input_tokens');
    expect(events.completions[0].message.metadata.totalUsage).toMatchObject({
      input_tokens: 26500,
      cache_read_input_tokens: 8000,
      cached_input_tokens: 8000,
      output_tokens: 50,
    });

    // Multi-request turn with NO main-thread request snapshot must leave metadata.usage unknown
    const usagesBefore = events.usages.length;
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'init', session_id: 'qoder-req-1', model: 'performance' },
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_only_sub',
        uuid: 'sub-only',
        message: {
          id: 'sub-only-1',
          role: 'assistant',
          model: 'sub-small',
          content: [{ type: 'text', text: 'sub' }],
          usage: { input_tokens: 75, output_tokens: 4 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Done without main usage',
        uuid: 'res-multi-no-main',
        num_turns: 3,
        usage: { input_tokens: 50000, output_tokens: 500 },
      },
    ]);

    await p.send(route, 'multi request no main snapshot');
    await vi.waitFor(() => expect(events.completions).toHaveLength(2));

    expect(events.usages).toHaveLength(usagesBefore);
    expect(events.completions[1].message.metadata.usage).toBeUndefined();
    expect(events.completions[1].message.metadata.totalUsage).toMatchObject({
      input_tokens: 50000,
      output_tokens: 500,
    });

    // F1 causal counterexample: num_turns=1 WITH subagent + missing/input-only main usage must NOT leak cumulative result counts
    const usagesBeforeF1 = events.usages.length;
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'init', session_id: 'qoder-req-1', model: 'performance' },
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_sub_single',
        uuid: 'sub-single-1',
        message: {
          id: 'sub-single-msg-1',
          role: 'assistant',
          model: 'sub-small',
          content: [{ type: 'text', text: 'sub' }],
          usage: { input_tokens: 75, output_tokens: 4 },
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: 'main-no-usage',
        message: {
          id: 'main-single-no-usage',
          role: 'assistant',
          model: 'performance',
          content: [{ type: 'text', text: 'Done' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Done',
        uuid: 'res-single-with-sub',
        num_turns: 1,
        usage: { input_tokens: 12075, output_tokens: 14 },
      },
    ]);

    await p.send(route, 'single turn with subagent and missing main usage');
    await vi.waitFor(() => expect(events.completions).toHaveLength(3));

    expect(events.usages).toHaveLength(usagesBeforeF1);
    expect(events.completions[2].message.metadata.usage).toBeUndefined();
    expect(events.completions[2].message.metadata.totalUsage).toMatchObject({
      input_tokens: 12075,
      output_tokens: 14,
    });

    // F1 causal counterexample 2: main has input-only + subagent + num_turns=1 -> cumulative output must NOT backfill
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'init', session_id: 'qoder-req-1', model: 'performance' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: 'main-input-only',
        message: {
          id: 'main-input-only-1',
          role: 'assistant',
          model: 'performance',
          content: [{ type: 'text', text: 'Working' }],
          usage: { input_tokens: 12000 },
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_sub_partial',
        uuid: 'sub-partial',
        message: {
          id: 'sub-partial-1',
          role: 'assistant',
          model: 'sub-small',
          content: [{ type: 'text', text: 'sub' }],
          usage: { input_tokens: 75, output_tokens: 9 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Done partial',
        uuid: 'res-single-sub-partial',
        num_turns: 1,
        usage: { input_tokens: 12075, output_tokens: 19 },
        modelUsage: {
          performance: {
            inputTokens: 12000,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 256000,
            maxOutputTokens: 16384,
          },
          'sub-small': {
            inputTokens: 75,
            outputTokens: 9,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.001,
            contextWindow: 8000,
            maxOutputTokens: 4096,
          },
        },
      },
    ]);

    await p.send(route, 'single turn with subagent and input-only main');
    await vi.waitFor(() => expect(events.completions).toHaveLength(4));

    expect(events.usages.at(-1)?.usage).toEqual({
      messageId: 'res-single-sub-partial',
      finalized: true,
      model: 'performance',
      usage: {
        input_tokens: 12000,
        model_context_window: 256000,
      },
    });
    expect(events.completions[3].message.metadata.usage).toEqual({
      input_tokens: 12000,
      model_context_window: 256000,
    });

    // F2 causal counterexamples:
    // (a) assistant A has usage, assistant B omits usage (new message.id), plus explicit empty usage request transition
    // (b) anonymous message_delta after message_stop must not mutate closed snapshot
    // (c) explicit result.usage.model_context_window must be preserved even when assistant omits modelUsage
    const usagesBeforeAtoB = events.usages.length;
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'init', session_id: 'qoder-req-1', model: 'performance' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: 'asst-a',
        message: {
          id: 'req-A',
          role: 'assistant',
          model: 'performance',
          content: [{ type: 'text', text: 'A' }],
          usage: { input_tokens: 12000, cache_read_input_tokens: 4000, output_tokens: 5 },
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: 'asst-b',
        message: {
          id: 'req-B',
          role: 'assistant',
          model: 'performance',
          content: [{ type: 'text', text: 'B' }],
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        uuid: 'asst-c',
        message: {
          id: 'req-C',
          role: 'assistant',
          model: 'performance',
          content: [{ type: 'text', text: 'C' }],
          usage: {},
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'C',
        uuid: 'res-a-to-b',
        num_turns: 2,
        usage: { input_tokens: 20000, output_tokens: 50 },
        modelUsage: {
          performance: {
            inputTokens: 20000,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.02,
            contextWindow: 256000,
            maxOutputTokens: 16384,
          },
        },
      },
    ]);

    await p.send(route, 'request B without usage clears A');
    await vi.waitFor(() => expect(events.completions).toHaveLength(5));

    // Request A emitted live + finalized carries ONLY matched model_context_window (no A or cumulative counts)
    expect(events.usages).toHaveLength(usagesBeforeAtoB + 2);
    expect(events.usages.at(-1)?.usage).toEqual({
      messageId: 'res-a-to-b',
      finalized: true,
      model: 'performance',
      usage: { model_context_window: 256000 },
    });
    expect(events.completions[4].message.metadata.usage).toEqual({ model_context_window: 256000 });
    expect(events.completions[4].message.metadata.totalUsage).toMatchObject({
      input_tokens: 20000,
      output_tokens: 50,
    });

    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'init', session_id: 'qoder-req-1', model: 'performance' },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: {
            id: 'req-win-1',
            model: 'performance',
            usage: { input_tokens: 12000, output_tokens: 10 },
          },
        },
      },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_delta',
          usage: { output_tokens: 99 },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        result: 'Window ok',
        uuid: 'res-explicit-window',
        num_turns: 2,
        usage: { input_tokens: 25000, output_tokens: 40, model_context_window: 256000 },
      },
    ]);

    await p.send(route, 'closed delta ignored and result explicit window preserved');
    await vi.waitFor(() => expect(events.completions).toHaveLength(6));

    // Anonymous post-message_stop delta must not overwrite output_tokens=10 with 99; explicit result window=256000 preserved
    expect(events.usages.at(-1)?.usage).toEqual({
      messageId: 'res-explicit-window',
      finalized: true,
      model: 'performance',
      usage: {
        input_tokens: 12000,
        output_tokens: 10,
        model_context_window: 256000,
      },
    });
    expect(events.completions[5].message.metadata.usage).toEqual({
      input_tokens: 12000,
      output_tokens: 10,
      model_context_window: 256000,
    });
  });

  it('drops post-terminal compact_boundary, status, and stream frames emitted after completion in the same generation', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);

    sdkMock.state.scripts.push([
      { type: 'result', subtype: 'success', result: 'terminal', uuid: 'res-terminal-1' },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'system', subtype: 'status', status: 'compacting' },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: { id: 'late-msg', model: 'late-model', usage: { input_tokens: 999 } },
        },
      },
    ]);

    await p.send(route, 'done early');
    await vi.waitFor(() => expect(events.completions).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));

    expect(events.statuses.filter((e) => e.status.status === 'compacting')).toHaveLength(0);
    expect(events.statuses.at(-1)?.status).toEqual({ status: null, label: null });
    expect(events.usages).toHaveLength(0);
    expect(events.sessionInfos.some((e) => e.info.model === 'late-model')).toBe(false);
  });

  it('handles SDK status compacting/null transitions, clears on cancel/error/endSession, and ignores transcript-only replays', async () => {
    const p = await makeProvider();
    const route = await createReadySession(p);
    const events = collect(p);

    // 1. status: 'compacting' -> null -> transcript-only assistant replay ignored -> error clears status
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'system', subtype: 'status', status: null },
      {
        type: 'assistant',
        isVisibleInTranscriptOnly: true,
        uuid: 'replay-only-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'replayed history' }] },
      },
      { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'result', subtype: 'error_during_execution', errors: ['failed mid compact'], uuid: 'err-compact' },
    ]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(events.errors).toHaveLength(1));
    expect(events.statuses.filter((e) => e.status.status === 'compacting')).toHaveLength(2);
    expect(events.statuses.some((e) => e.status.status === null)).toBe(true);
    expect(events.statuses.at(-1)?.status).toEqual({ status: null, label: null });
    expect(events.deltas).toHaveLength(0);

    // 2. endSession mid-compaction clears status cleanly
    sdkMock.state.scripts.push([
      { type: 'system', subtype: 'compact_boundary' },
      { waitForInterrupt: true, lateMessages: [] },
    ]);
    await p.send(route, 'compact then end');
    await vi.waitFor(() => expect(events.statuses.filter((e) => e.status.status === 'compacting')).toHaveLength(3));
    await p.endSession(route);
    expect(events.statuses.at(-1)?.status).toEqual({ status: null, label: null });
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

  it('confirms query termination for Stop and suppresses late events after generation rotation', async () => {
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
    await p.cancelAndWait(route);
    await vi.waitFor(() => expect(events.errors).toHaveLength(1));

    expect(sdkMock.state.interrupted).toBe(1);
    expect(events.errors[0].error.code).toBe(PROVIDER_ERROR_CODES.CANCELLED);
    expect(events.completions).toHaveLength(0);
    expect(events.deltas).toHaveLength(0);
  });

  it('enforces toolExecutionGuard in canUseTool BEFORE approval emission and preserves subsequent owner calls', async () => {
    const p = await makeProvider();
    let participantActive = true;
    p.setToolExecutionGuard(async (_sid, req) => {
      if (!participantActive) return { allow: true };
      const text = JSON.stringify(req.input ?? '');
      if (text.includes('.ssh') || text.includes('leak-key')) {
        return { allow: false, reason: 'Sensitive path policy: denied' };
      }
      return { allow: true };
    });
    const route = await createReadySession(p);
    const events = collect(p);
    sdkMock.state.scripts.push([
      async ({ call, state }: any) => {
        // 1) Blocked before onApprovalRequest fires
        state.permissionResults.push(await call.options.canUseTool?.(
          'Read',
          { file_path: '/home/k/.ssh/id_ed25519' },
          { toolUseID: 'tool-blocked', signal: new AbortController().signal, title: 'Read key' },
        ));
        // 2) Flip to owner turn on same session: now allowed through to approval
        participantActive = false;
        const allowedPromise = call.options.canUseTool?.(
          'Read',
          { file_path: '/home/k/.ssh/id_ed25519' },
          { toolUseID: 'tool-owner-allowed', signal: new AbortController().signal, title: 'Read key' },
        );
        await vi.waitFor(() => expect(events.approvals).toHaveLength(1));
        await p.respondApproval(route, events.approvals[0].request.id, true);
        state.permissionResults.push(await allowedPromise);
      },
      { type: 'result', subtype: 'success', result: 'done', uuid: 'qoder-guard-done' },
    ]);

    await p.send(route, 'hello');
    await vi.waitFor(() => expect(events.completions).toHaveLength(1));
    expect(sdkMock.state.permissionResults[0]).toEqual({
      behavior: 'deny',
      message: 'Sensitive path policy: denied',
      interrupt: false,
    });
    expect(sdkMock.state.permissionResults[1]).toEqual({ behavior: 'allow' });
  });
});
