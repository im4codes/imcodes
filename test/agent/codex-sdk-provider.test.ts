import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

const childProcessMock = vi.hoisted(() => {
  type Request = { id?: number; method?: string; params?: Record<string, any> };
  type ChildRecord = {
    child: EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: Writable;
      killed: boolean;
      kill: (signal?: string) => boolean;
    };
    requests: Request[];
    emits: (msg: Record<string, any>) => void;
  };

  const children: ChildRecord[] = [];
  const heldThreadStarts: Array<{ childRecord: ChildRecord; msg: Request }> = [];
  const heldTurnStarts: Array<{ childRecord: ChildRecord; msg: Request }> = [];
  const heldTurnInterrupts: Array<{ childRecord: ChildRecord; msg: Request }> = [];
  const threadReadResults: Array<Record<string, any> | ((msg: Request) => Record<string, any> | undefined)> = [];
  let holdThreadStart = false;
  let holdTurnStart = false;
  let holdTurnInterrupt = false;

  const emitThreadStartResult = (childRecord: ChildRecord, msg: Request) => {
    childRecord.emits({
      id: msg.id,
      result: { thread: { id: 'thread-1' } },
    });
    childRecord.emits({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
  };
  const emitTurnStartResult = (childRecord: ChildRecord, msg: Request) => {
    childRecord.emits({
      id: msg.id,
      result: { turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } },
    });
  };
  const emitTurnInterruptResult = (childRecord: ChildRecord, msg: Request) => {
    childRecord.emits({ id: msg.id, result: {} });
  };

  const spawn = vi.fn(() => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let childRecord!: ChildRecord;
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line) as Request;
          childRecord.requests.push(msg);
          if (msg.method === 'initialize' && typeof msg.id === 'number') {
            childRecord.emits({ id: msg.id, result: { userAgent: 'test' } });
          }
          if (msg.method === 'thread/start' && typeof msg.id === 'number') {
            if (holdThreadStart) {
              heldThreadStarts.push({ childRecord, msg });
            } else {
              emitThreadStartResult(childRecord, msg);
            }
          }
          if (msg.method === 'thread/resume' && typeof msg.id === 'number') {
            if (msg.params?.threadId === 'thread-corrupt') {
              childRecord.emits({
                id: msg.id,
                error: {
                  message: 'failed to read thread: thread-store internal error: failed to load thread history: stream did not contain valid UTF-8',
                },
              });
            } else {
              childRecord.emits({
                id: msg.id,
                result: { thread: { id: msg.params?.threadId } },
              });
            }
          }
          if (msg.method === 'turn/start' && typeof msg.id === 'number') {
            if (holdTurnStart) {
              heldTurnStarts.push({ childRecord, msg });
            } else {
              emitTurnStartResult(childRecord, msg);
            }
          }
          if (msg.method === 'thread/compact/start' && typeof msg.id === 'number') {
            childRecord.emits({ id: msg.id, result: {} });
          }
          if (msg.method === 'thread/read' && typeof msg.id === 'number') {
            const next = threadReadResults.shift();
            if (next) {
              const result = typeof next === 'function' ? next(msg) : next;
              if (result !== undefined) childRecord.emits({ id: msg.id, result });
            }
          }
          if (msg.method === 'turn/interrupt' && typeof msg.id === 'number') {
            if (holdTurnInterrupt) {
              heldTurnInterrupts.push({ childRecord, msg });
            } else {
              emitTurnInterruptResult(childRecord, msg);
            }
          }
          if (msg.method === 'thread/unsubscribe' && typeof msg.id === 'number') {
            childRecord.emits({ id: msg.id, result: { status: 'unsubscribed' } });
          }
          if (msg.method === 'initialized') {
            // notification
          }
        }
        cb();
      },
    });
    const child = new EventEmitter() as ChildRecord['child'];
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.emit('exit', 0);
      return true;
    };
    childRecord = {
      child,
      requests: [],
      emits: (msg: Record<string, any>) => {
        stdout.write(`${JSON.stringify(msg)}\n`);
      },
    };
    children.push(childRecord);
    return child;
  });

  // Accept both (file, args, cb) and (file, args, opts, cb).
  const execFile = vi.fn((..._args: unknown[]) => {
    const cb = (typeof _args[2] === 'function' ? _args[2] : _args[3]) as
      | ((err: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    cb?.(null, 'ok\n', '');
    return {} as never;
  });

  return {
    spawn,
    execFile,
    children,
    setHoldThreadStart(value: boolean) {
      holdThreadStart = value;
    },
    setHoldTurnStart(value: boolean) {
      holdTurnStart = value;
    },
    setHoldTurnInterrupt(value: boolean) {
      holdTurnInterrupt = value;
    },
    releaseHeldTurnStarts() {
      const held = heldTurnStarts.splice(0);
      for (const entry of held) emitTurnStartResult(entry.childRecord, entry.msg);
    },
    releaseHeldThreadStarts() {
      const held = heldThreadStarts.splice(0);
      for (const entry of held) emitThreadStartResult(entry.childRecord, entry.msg);
    },
    releaseHeldTurnInterrupts() {
      const held = heldTurnInterrupts.splice(0);
      for (const entry of held) emitTurnInterruptResult(entry.childRecord, entry.msg);
    },
    enqueueThreadReadResult(result: Record<string, any> | ((msg: Request) => Record<string, any> | undefined)) {
      threadReadResults.push(result);
    },
    clearThreadReadResults() {
      threadReadResults.length = 0;
    },
  };
});

vi.mock('node:child_process', () => ({
  spawn: childProcessMock.spawn,
  execFile: childProcessMock.execFile,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock the codex runtime config so tests can pretend specific models are
// (or aren't) in codex's built-in catalog. The `prompts` map mirrors what
// would live in `~/.codex/models_cache.json` — keys are model slugs, values
// are the full per-model `base_instructions`. Tests can override with
// codexRuntimeConfigMock.set([...]) to simulate "this model isn't in the
// local cache" (which forces the FALLBACK_BASE_INSTRUCTIONS path).
const codexRuntimeConfigMock = vi.hoisted(() => {
  const buildPrompts = (catalog: string[]) =>
    new Map(catalog.map((id) => [id.toLowerCase(), `[catalog-prompt:${id}]`] as const));
  return {
    catalog: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'],
    prompts: buildPrompts(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2']),
    set(catalog: string[]) {
      this.catalog = catalog;
      this.prompts = buildPrompts(catalog);
    },
    reset() {
      this.catalog = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'];
      this.prompts = buildPrompts(this.catalog);
    },
  };
});
vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn(async () => ({
    availableModels: codexRuntimeConfigMock.catalog,
    models: codexRuntimeConfigMock.catalog.map((id) => ({ id })),
  })),
  getCodexBaseInstructions: vi.fn(async (model: string | undefined) => {
    if (!model) return undefined;
    return codexRuntimeConfigMock.prompts.get(model.trim().toLowerCase());
  }),
}));

import { CodexSdkProvider } from '../../src/agent/providers/codex-sdk.js';
import { PROVIDER_ERROR_CODES, type ProviderError, type ToolCallEvent } from '../../src/agent/transport-provider.js';
import type { ProviderContextPayload } from '../../shared/context-types.js';
import { SESSION_CONTROL_METADATA_COMMAND_FIELD } from '../../shared/session-control-commands.js';
import {
  IMCODES_DAEMON_NAMESPACE_ENV,
  IMCODES_DAEMON_PROJECT_NAME_ENV,
  IMCODES_DAEMON_PROJECT_ROOT_ENV,
  IMCODES_DAEMON_SERVER_ID_ENV,
  IMCODES_DAEMON_SESSION_NAME_ENV,
  IMCODES_DAEMON_USER_ID_ENV,
} from '../../shared/memory-mcp-env.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import { MEMORY_MCP_STATUS } from '../../shared/memory-ws.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_DIAGNOSTIC,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_STATUS,
  isSdkSubagentDetail,
  makeCodexSubagentCanonicalKey,
  type SdkSubagentDetail,
} from '../../shared/sdk-subagent-status.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitForCondition(
  check: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

async function writeCodexAuthFile(codexHome: string, version: number): Promise<void> {
  await writeFile(
    join(codexHome, 'auth.json'),
    JSON.stringify({ version, pad: 'x'.repeat(version) }),
  );
}

async function writeCodexRolloutFile(codexHome: string, threadId: string, lines: unknown[]): Promise<string> {
  const now = new Date();
  const dir = join(
    codexHome,
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  );
  await mkdir(dir, { recursive: true });
  const rolloutPath = join(dir, `rollout-test-${threadId}.jsonl`);
  await writeFile(rolloutPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return rolloutPath;
}

function emitCodexItem(
  child: { emits: (msg: Record<string, any>) => void },
  method: 'item/started' | 'item/completed',
  item: Record<string, any>,
): void {
  child.emits({
    method,
    params: { threadId: 'thread-1', turnId: 'turn-1', item },
  });
}

function collabItem(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'collab-1',
    type: 'collabAgentToolCall',
    status: 'inProgress',
    receiverThreadIds: ['agent-a'],
    agentsStates: { 'agent-a': { status: 'running' } },
    ...overrides,
  };
}

function expectCodexSubagentDetail(
  tool: ToolCallEvent,
  providerKind = SDK_SUBAGENT_PROVIDER_KINDS.CODEX_COLLAB_AGENT,
): SdkSubagentDetail {
  expect(isSdkSubagentDetail(tool.detail)).toBe(true);
  const detail = tool.detail as SdkSubagentDetail;
  expect(detail.kind).toBe(SDK_SUBAGENT_DETAIL_KIND);
  expect(detail.meta.provider).toBe(SDK_SUBAGENT_PROVIDERS.CODEX_SDK);
  expect(detail.meta.providerKind).toBe(providerKind);
  return detail;
}

describe('CodexSdkProvider', () => {
  beforeEach(() => {
    vi.useRealTimers();
    childProcessMock.spawn.mockClear();
    childProcessMock.execFile.mockClear();
    childProcessMock.children.length = 0;
    childProcessMock.setHoldThreadStart(false);
    childProcessMock.setHoldTurnStart(false);
    childProcessMock.setHoldTurnInterrupt(false);
    childProcessMock.clearThreadReadResults();
    childProcessMock.releaseHeldThreadStarts();
    childProcessMock.releaseHeldTurnStarts();
    childProcessMock.releaseHeldTurnInterrupts();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('reports Memory MCP ready after app-server connect', async () => {
    const provider = new CodexSdkProvider();
    expect(provider.getMemoryMcpStatus()).toMatchObject({
      providerId: 'codex-sdk',
      status: MEMORY_MCP_STATUS.UNKNOWN,
      connected: false,
      degradedReasons: [],
    });

    await provider.connect({ binaryPath: 'codex' });

    expect(provider.getMemoryMcpStatus()).toMatchObject({
      providerId: 'codex-sdk',
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
      degradedReasons: [],
    });
  });

  it('restarts the app-server before creating a session when Codex auth changes', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-auth-'));
    const provider = new CodexSdkProvider();
    try {
      vi.stubEnv('CODEX_HOME', codexHome);
      await writeCodexAuthFile(codexHome, 1);

      await provider.connect({ binaryPath: 'codex' });
      expect(childProcessMock.children).toHaveLength(1);

      await writeCodexAuthFile(codexHome, 2);
      await provider.createSession({ sessionKey: 'route-1', cwd: '/tmp/project' });

      expect(childProcessMock.children).toHaveLength(2);
      expect(childProcessMock.children[0]!.child.killed).toBe(true);
      expect(childProcessMock.children[1]!.requests.some((req) => req.method === 'initialize')).toBe(true);
    } finally {
      await provider.disconnect().catch(() => {});
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('preserves Codex thread ids across auth-change app-server restarts', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-auth-'));
    const provider = new CodexSdkProvider();
    try {
      vi.stubEnv('CODEX_HOME', codexHome);
      await writeCodexAuthFile(codexHome, 1);

      await provider.connect({ binaryPath: 'codex' });
      await provider.createSession({ sessionKey: 'route-1', cwd: '/tmp/project', resumeId: 'thread-keep' });
      await provider.send('route-1', 'first');
      const firstChild = childProcessMock.children[0]!;
      expect(firstChild.requests.some((req) => req.method === 'thread/resume' && req.params?.threadId === 'thread-keep')).toBe(true);
      firstChild.emits({ method: 'turn/completed', params: { threadId: 'thread-keep', turn: { id: 'turn-1', status: 'completed', error: null } } });
      await flush();

      await writeCodexAuthFile(codexHome, 3);
      await provider.send('route-1', 'second');

      expect(childProcessMock.children).toHaveLength(2);
      const secondChild = childProcessMock.children[1]!;
      expect(secondChild.requests.some((req) => req.method === 'thread/resume' && req.params?.threadId === 'thread-keep')).toBe(true);
      expect(secondChild.requests.some((req) => req.method === 'turn/start')).toBe(true);
    } finally {
      await provider.disconnect().catch(() => {});
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('restarts the app-server when Codex reports a bearer auth failure', async () => {
    const provider = new CodexSdkProvider();
    const errors: Array<{ code: string; recoverable: boolean; message: string }> = [];
    const tools: ToolCallEvent[] = [];
    provider.onError((_sid, error) => errors.push({
      code: error.code,
      recoverable: error.recoverable,
      message: error.message,
    }));
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-1', cwd: '/tmp/project' });
    await provider.send('route-1', 'hello');
    const firstChild = childProcessMock.children[0]!;
    firstChild.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-auth', type: 'webSearch', action: { type: 'other' } } },
    });
    await waitForCondition(() => tools.some((tool) => tool.id === 'ws-auth' && tool.status === 'running'));

    firstChild.emits({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: {
            message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
          },
        },
      },
    });
    await waitForCondition(() => errors.length === 1 && childProcessMock.children.length === 2);

    expect(errors).toMatchObject([{
      code: PROVIDER_ERROR_CODES.AUTH_FAILED,
      recoverable: false,
    }]);
    expect(tools).toContainEqual(expect.objectContaining({
      id: 'ws-auth',
      status: 'error',
      terminalStatus: 'errored',
      terminalReason: 'app_server_failed',
      terminalSynthetic: true,
      terminalSource: 'app_server_jsonrpc',
      lifecycleItemKind: 'web_search',
    }));
    expect(childProcessMock.children).toHaveLength(2);
    expect(firstChild.child.killed).toBe(true);
    await provider.disconnect();
  });

  it('defers auth-change app-server restart while any session has active current work', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-auth-active-'));
    const provider = new CodexSdkProvider();
    try {
      vi.stubEnv('CODEX_HOME', codexHome);
      await writeCodexAuthFile(codexHome, 1);

      await provider.connect({ binaryPath: 'codex' });
      await provider.createSession({ sessionKey: 'route-auth-active', cwd: '/tmp/project' });
      await provider.send('route-auth-active', 'search');
      await waitForCondition(
        () => provider.getSessionDiagnostics('route-auth-active')?.runningTurnId === 'turn-1',
      );
      const firstChild = childProcessMock.children[0]!;
      firstChild.emits({
        method: 'item/started',
        params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-auth-active', type: 'webSearch', action: { type: 'other' } } },
      });
      await waitForCondition(
        () => provider.getActiveWorkSnapshot('route-auth-active')?.activeToolCount === 1,
      );

      await writeCodexAuthFile(codexHome, 2);
      await expect(provider.createSession({ sessionKey: 'route-after-auth-change', cwd: '/tmp/project' }))
        .rejects.toMatchObject({
          code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
          recoverable: true,
          details: {
            disconnectClass: 'auth_refresh_restart',
            activeSessionCount: 1,
            activeSessionIds: ['route-auth-active'],
          },
        });
      expect(childProcessMock.children).toHaveLength(1);
      expect(firstChild.child.killed).toBe(false);
      expect(provider.getActiveWorkSnapshot('route-auth-active')).toMatchObject({
        activeWorkCount: 1,
        activeToolCount: 1,
      });

      firstChild.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
      await waitForCondition(
        () => provider.getActiveWorkSnapshot('route-auth-active')?.activeWorkCount === 0,
      );

      await provider.createSession({ sessionKey: 'route-after-auth-change', cwd: '/tmp/project' });
      expect(childProcessMock.children).toHaveLength(2);
      expect(firstChild.child.killed).toBe(true);
      expect(childProcessMock.children[1]!.requests.some((req) => req.method === 'initialize')).toBe(true);
    } finally {
      await provider.disconnect().catch(() => {});
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('does not emit a connection error when the app-server exits with no current work', async () => {
    const provider = new CodexSdkProvider();
    const errors: ProviderError[] = [];
    provider.onError((_sid, error) => errors.push(error));

    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-no-work-disconnect', cwd: '/tmp/project' });
    childProcessMock.children[0]!.child.emit('exit', 1);
    await flush();

    expect(errors).toEqual([]);
    expect(provider.getSessionDiagnostics('route-no-work-disconnect')).toMatchObject({
      active: false,
      runningTurnId: null,
      turnStartInFlight: false,
    });
  });

  it('terminalizes active current work before reporting app-server crash exit', async () => {
    const provider = new CodexSdkProvider();
    const errors: ProviderError[] = [];
    const tools: ToolCallEvent[] = [];
    provider.onError((_sid, error) => errors.push(error));
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-active-crash', cwd: '/tmp/project' });
    await provider.send('route-active-crash', 'search');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-active-crash')?.runningTurnId === 'turn-1',
    );
    const child = childProcessMock.children[0]!;
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-crash', type: 'webSearch', action: { type: 'other' } } },
    });
    await waitForCondition(() => tools.some((tool) => tool.id === 'ws-crash' && tool.status === 'running'));

    child.child.emit('exit', 2);

    await waitForCondition(() => errors.length === 1 && tools.some((tool) => tool.id === 'ws-crash' && tool.status === 'error'));
    expect(errors[0]).toMatchObject({
      code: PROVIDER_ERROR_CODES.CONNECTION_LOST,
      recoverable: false,
    });
    expect(tools).toContainEqual(expect.objectContaining({
      id: 'ws-crash',
      status: 'error',
      terminalStatus: 'errored',
      terminalReason: 'app_server_disconnect',
      terminalSynthetic: true,
      terminalSource: 'app_server_jsonrpc',
      terminalDecisionReason: 'app_server_disconnect',
      lifecycleItemKind: 'web_search',
    }));
    expect(provider.getActiveWorkSnapshot('route-active-crash')).toMatchObject({
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });
  });

  it('terminalizes active current work before reporting app-server stdout EOF', async () => {
    const provider = new CodexSdkProvider();
    const errors: ProviderError[] = [];
    const tools: ToolCallEvent[] = [];
    provider.onError((_sid, error) => errors.push(error));
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-active-eof', cwd: '/tmp/project' });
    await provider.send('route-active-eof', 'search');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-active-eof')?.runningTurnId === 'turn-1',
    );
    const child = childProcessMock.children[0]!;
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-eof', type: 'webSearch', action: { type: 'other' } } },
    });
    await waitForCondition(() => tools.some((tool) => tool.id === 'ws-eof' && tool.status === 'running'));

    child.child.stdout.end();

    await waitForCondition(() => errors.length === 1 && tools.some((tool) => tool.id === 'ws-eof' && tool.status === 'error'));
    expect(errors[0]).toMatchObject({
      code: PROVIDER_ERROR_CODES.CONNECTION_LOST,
      recoverable: false,
    });
    expect(tools).toContainEqual(expect.objectContaining({
      id: 'ws-eof',
      status: 'error',
      terminalStatus: 'errored',
      terminalReason: 'unexpected_eof',
      terminalSynthetic: true,
      terminalSource: 'app_server_jsonrpc',
      terminalDecisionReason: 'unexpected_eof',
      lifecycleItemKind: 'web_search',
    }));
    expect(provider.getActiveWorkSnapshot('route-active-eof')).toMatchObject({
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });
  });

  it('terminalizes open provider tools during intentional app-server shutdown without connection error', async () => {
    const provider = new CodexSdkProvider();
    const errors: ProviderError[] = [];
    const tools: ToolCallEvent[] = [];
    provider.onError((_sid, error) => errors.push(error));
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-intentional-shutdown', cwd: '/tmp/project' });
    await provider.send('route-intentional-shutdown', 'search');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-intentional-shutdown')?.runningTurnId === 'turn-1',
    );
    const child = childProcessMock.children[0]!;
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-shutdown', type: 'webSearch', action: { type: 'other' } } },
    });
    await waitForCondition(() => tools.some((tool) => tool.id === 'ws-shutdown' && tool.status === 'running'));

    await provider.disconnect();

    expect(errors).toEqual([]);
    expect(tools).toContainEqual(expect.objectContaining({
      id: 'ws-shutdown',
      status: 'error',
      terminalStatus: 'cancelled',
      terminalReason: 'provider_cancelled',
      terminalSynthetic: true,
      terminalSource: 'app_server_jsonrpc',
      terminalDecisionReason: 'provider_cancelled',
      lifecycleItemKind: 'web_search',
    }));
  });

  it('emits SDK sub-agent snapshots for Codex collaboration start, completion, and failure', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-collab', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-collab', 'coordinate work');
    const child = childProcessMock.children[0];
    emitCodexItem(child, 'item/started', collabItem({
      model: 'haiku',
      receiverThreadIds: ['agent-a', 'agent-b'],
      agentsStates: {
        'agent-a': { status: 'pendingInit' },
        'agent-b': { status: 'running' },
      },
    }));
    emitCodexItem(child, 'item/completed', collabItem({
      status: 'completed',
      receiverThreadIds: ['agent-a', 'agent-b'],
      agentsStates: {
        'agent-a': { status: 'completed' },
        'agent-b': { status: 'completed' },
      },
    }));
    emitCodexItem(child, 'item/completed', collabItem({
      id: 'collab-failed',
      status: 'failed',
      receiverThreadIds: ['agent-c'],
      agentsStates: { 'agent-c': { status: 'errored' } },
    }));
    await flush();

    expect(tools).toHaveLength(3);
    expect(tools[0]).toMatchObject({
      id: 'collab-1',
      name: 'Codex Collaboration',
      status: 'running',
      input: {
        action: 'codex-collaboration',
        receiverCount: 2,
      },
    });
    const startedDetail = expectCodexSubagentDetail(tools[0]!);
    expect(startedDetail.meta).toMatchObject({
      canonicalKey: makeCodexSubagentCanonicalKey('route-collab', 'collab-1'),
      parentItemId: 'collab-1',
      receiverCount: 2,
      runningChildCount: 2,
      childStatusSummary: 'pendingInit:1, running:1',
      model: 'haiku',
      rawStatus: 'inProgress',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    });
    expect(startedDetail.meta.diagnosticCode).toBeUndefined();

    expect(tools[1]!.status).toBe('complete');
    const completedDetail = expectCodexSubagentDetail(tools[1]!);
    expect(completedDetail.meta).toMatchObject({
      canonicalKey: makeCodexSubagentCanonicalKey('route-collab', 'collab-1'),
      parentItemId: 'collab-1',
      receiverCount: 2,
      runningChildCount: 0,
      childStatusSummary: 'completed:2',
      rawStatus: 'completed',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
    });
    expect(completedDetail.meta.diagnosticCode).toBeUndefined();

    expect(tools[2]!.status).toBe('error');
    const failedDetail = expectCodexSubagentDetail(tools[2]!);
    expect(failedDetail.meta).toMatchObject({
      canonicalKey: makeCodexSubagentCanonicalKey('route-collab', 'collab-failed'),
      parentItemId: 'collab-failed',
      receiverCount: 1,
      runningChildCount: 0,
      childStatusSummary: 'errored:1',
      rawStatus: 'failed',
      normalizedStatus: SDK_SUBAGENT_STATUS.ERROR,
      active: false,
      terminal: true,
    });
  });

  it('terminalizes open SDK sub-agent details when closing provider tool calls', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-collab-close-open', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-collab-close-open', 'spawn a helper that reports only wrapper running');
    const child = childProcessMock.children[0];
    emitCodexItem(child, 'item/started', collabItem({
      id: 'collab-open-wrapper',
      status: 'inProgress',
      receiverThreadIds: ['agent-a'],
      agentsStates: { 'agent-a': { status: 'pendingInit' } },
    }));
    emitCodexItem(child, 'item/completed', collabItem({
      id: 'collab-open-wrapper',
      status: 'inProgress',
      receiverThreadIds: ['agent-a'],
      agentsStates: { 'agent-a': { status: 'pendingInit' } },
    }));
    child.emits({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        turn: { id: 'turn-1', status: 'completed' },
      },
    });
    await waitForCondition(() => tools.length === 3);

    expect(tools[2]).toMatchObject({
      id: 'collab-open-wrapper',
      name: 'Codex Collaboration',
      status: 'complete',
      output: 'completed',
    });
    const detail = expectCodexSubagentDetail(tools[2]!);
    expect(detail.meta).toMatchObject({
      canonicalKey: makeCodexSubagentCanonicalKey('route-collab-close-open', 'collab-open-wrapper'),
      rawStatus: 'completed',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      runningChildCount: 0,
    });
  });

  it('closes prior Codex collaboration wrapper rows when terminal evidence uses a different call id', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-collab-different-terminal-id', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-collab-different-terminal-id', 'spawn then wait for a helper');
    const child = childProcessMock.children[0];
    emitCodexItem(child, 'item/started', collabItem({
      id: 'spawn-call-id',
      status: 'inProgress',
      receiverThreadIds: ['agent-a'],
      agentsStates: { 'agent-a': { status: 'pendingInit' } },
    }));
    emitCodexItem(child, 'item/completed', collabItem({
      id: 'wait-call-id',
      status: 'completed',
      receiverThreadIds: ['agent-a'],
      agentsStates: { 'agent-a': { status: 'completed' } },
    }));
    await waitForCondition(() => tools.length === 3);

    const closedSpawn = tools.find((tool) => tool.id === 'spawn-call-id' && tool.status === 'complete');
    expect(closedSpawn).toBeTruthy();
    const closedDetail = expectCodexSubagentDetail(closedSpawn!);
    expect(closedDetail.meta).toMatchObject({
      canonicalKey: makeCodexSubagentCanonicalKey('route-collab-different-terminal-id', 'spawn-call-id'),
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      rawStatus: 'completed',
      active: false,
      terminal: true,
      runningChildCount: 0,
    });
  });

  it('handles empty Codex collaboration receiver lists without inventing child work', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-collab-empty', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-collab-empty', 'coordinate work');
    const child = childProcessMock.children[0];
    emitCodexItem(child, 'item/started', collabItem({
      id: 'collab-empty',
      receiverThreadIds: [],
      agentsStates: {},
    }));
    await flush();

    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe('running');
    const detail = expectCodexSubagentDetail(tools[0]!);
    expect(detail.meta).toMatchObject({
      canonicalKey: makeCodexSubagentCanonicalKey('route-collab-empty', 'collab-empty'),
      parentItemId: 'collab-empty',
      receiverCount: 0,
      runningChildCount: 0,
      childStatusSummary: 'receivers:0',
      rawStatus: 'inProgress',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    });
    expect(detail.meta.diagnosticCode).toBeUndefined();
  });

  it('diagnoses mismatched and extra Codex collaboration child state without counting it as running', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-collab-mismatch', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-collab-mismatch', 'coordinate work');
    const child = childProcessMock.children[0];
    emitCodexItem(child, 'item/started', collabItem({
      id: 'collab-missing-state',
      receiverThreadIds: ['agent-a', 'agent-b'],
      agentsStates: { 'agent-a': { status: 'running' } },
    }));
    emitCodexItem(child, 'item/started', collabItem({
      id: 'collab-extra-state',
      receiverThreadIds: ['agent-a'],
      agentsStates: {
        'agent-a': { status: 'running' },
        'agent-extra': { status: 'running' },
      },
    }));
    await flush();

    expect(tools).toHaveLength(2);
    const missingDetail = expectCodexSubagentDetail(tools[0]!);
    expect(tools[0]!.status).toBe('error');
    expect(missingDetail.meta).toMatchObject({
      parentItemId: 'collab-missing-state',
      receiverCount: 2,
      runningChildCount: 0,
      childStatusSummary: 'running:1, missing:1',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.MALFORMED_PAYLOAD,
    });

    const extraDetail = expectCodexSubagentDetail(tools[1]!);
    expect(tools[1]!.status).toBe('error');
    expect(extraDetail.meta).toMatchObject({
      parentItemId: 'collab-extra-state',
      receiverCount: 1,
      runningChildCount: 0,
      childStatusSummary: 'running:1, extra:1',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.MALFORMED_PAYLOAD,
    });
  });

  it('diagnoses unknown Codex child states without counting them as running', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-collab-unknown-child', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-collab-unknown-child', 'coordinate work');
    const child = childProcessMock.children[0];
    emitCodexItem(child, 'item/started', collabItem({
      id: 'collab-unknown-child',
      receiverThreadIds: ['agent-a'],
      agentsStates: { 'agent-a': { status: 'paused' } },
    }));
    await flush();

    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe('error');
    const detail = expectCodexSubagentDetail(tools[0]!);
    expect(detail.meta).toMatchObject({
      parentItemId: 'collab-unknown-child',
      runningChildCount: 0,
      childStatusSummary: 'paused:1',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
    });
  });

  it('keeps Codex completed lifecycle snapshots running when child state is still running', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-collab-completed-stale-status', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-collab-completed-stale-status', 'coordinate work');
    const child = childProcessMock.children[0];
    emitCodexItem(child, 'item/completed', collabItem({
      id: 'collab-stale-status',
      status: 'inProgress',
      receiverThreadIds: ['agent-a'],
      agentsStates: { 'agent-a': { status: 'running' } },
    }));
    await flush();

    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe('running');
    const detail = expectCodexSubagentDetail(tools[0]!);
    expect(detail.meta).toMatchObject({
      parentItemId: 'collab-stale-status',
      rawStatus: 'inProgress',
      runningChildCount: 1,
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    });
    expect(detail.meta.diagnosticCode).toBeUndefined();
  });

  it('keeps Codex completed collaboration actions running while child agents are still running', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-collab-completed-running-child', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-collab-completed-running-child', 'coordinate work');
    const child = childProcessMock.children[0];
    emitCodexItem(child, 'item/completed', collabItem({
      id: 'collab-running-after-dispatch',
      tool: 'spawnAgent',
      status: 'completed',
      receiverThreadIds: ['agent-a'],
      agentsStates: { 'agent-a': { status: 'running' } },
    }));
    await flush();

    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe('running');
    expect(tools[0]!.output).toBeUndefined();
    const detail = expectCodexSubagentDetail(tools[0]!);
    expect(detail.meta).toMatchObject({
      parentItemId: 'collab-running-after-dispatch',
      receiverCount: 1,
      runningChildCount: 1,
      childStatusSummary: 'running:1',
      rawStatus: 'inProgress',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    });
    expect(detail.output).toBeUndefined();
    expect(detail.meta.diagnosticCode).toBeUndefined();
  });

  it('diagnoses malformed Codex collaboration item ids without throwing or counting running work', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-collab-malformed', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-collab-malformed', 'coordinate work');
    const child = childProcessMock.children[0];
    expect(() => emitCodexItem(child, 'item/started', collabItem({ id: { bad: true } }))).not.toThrow();
    await flush();

    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe('error');
    const detail = expectCodexSubagentDetail(tools[0]!);
    expect(detail.meta).toMatchObject({
      canonicalKey: makeCodexSubagentCanonicalKey('route-collab-malformed', 'malformed-started'),
      parentItemId: 'malformed-started',
      receiverCount: 1,
      runningChildCount: 0,
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.MISSING_ID,
    });
  });

  it('surfaces bounded Codex child prompts for collaboration rows without raw payloads', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-collab-prompt-safe', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    const sensitivePrompt = 'SECRET CHILD PROMPT: clone the private repo and paste the token';
    await provider.send('route-collab-prompt-safe', 'coordinate work');
    const child = childProcessMock.children[0];
    emitCodexItem(child, 'item/started', collabItem({
      id: 'collab-prompt',
      prompt: sensitivePrompt,
      childPrompt: sensitivePrompt,
      prompts: [sensitivePrompt],
      agentsStates: {
        'agent-a': {
          status: 'running',
          prompt: sensitivePrompt,
        },
      },
    }));
    await flush();

    expect(tools).toHaveLength(1);
    const detail = expectCodexSubagentDetail(tools[0]!);
    expect(tools[0]!.input).toMatchObject({
      action: 'codex-collaboration',
      receiverCount: 1,
      description: sensitivePrompt,
    });
    expect(detail).toMatchObject({
      input: {
        action: 'codex-collaboration',
        receiverCount: 1,
        description: sensitivePrompt,
      },
    });
    expect(detail.raw).toBeUndefined();
  });

  it('emits SDK sub-agent snapshots for Codex runtime subagent notifications', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-runtime-subagent', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-runtime-subagent', 'spawn a helper');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'subagent_notification',
      params: {
        threadId: 'thread-1',
        agent_path: '019e7f1c-4e8c-7180-ae0d-577b994c9473',
        status: 'running',
        name: 'Jason',
        prompt: 'Coordinate the worker handoff',
      },
    });
    child.emits({
      method: 'subagent/status',
      params: {
        threadId: 'thread-1',
        subagent: {
          agentPath: '019e7f1c-4e8c-7180-ae0d-577b994c9473',
          status: { completed: 'Completed the worker handoff.' },
          nickname: 'Jason',
        },
      },
    });
    await flush();

    const expectedKey = makeCodexSubagentCanonicalKey(
      'route-runtime-subagent',
      'runtime:019e7f1c-4e8c-7180-ae0d-577b994c9473',
    );

    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      id: expectedKey,
      name: 'Codex Sub-agent',
      status: 'running',
      input: { action: 'codex-runtime-subagent', description: 'Coordinate the worker handoff' },
    });
    const runningDetail = expectCodexSubagentDetail(tools[0]!, SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT);
    expect(runningDetail.summary).toBe('Codex sub-agent Jason');
    expect(runningDetail.input).toMatchObject({
      action: 'codex-runtime-subagent',
      description: 'Coordinate the worker handoff',
    });
    expect(runningDetail.meta).toMatchObject({
      canonicalKey: expectedKey,
      parentItemId: expectedKey,
      agentPath: '019e7f1c-4e8c-7180-ae0d-577b994c9473',
      agentName: 'Jason',
      rawStatus: 'running',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    });
    expect(runningDetail.meta.diagnosticCode).toBeUndefined();

    expect(tools[1]).toMatchObject({
      id: expectedKey,
      name: 'Codex Sub-agent',
      status: 'complete',
      output: 'Completed the worker handoff.',
    });
    const shutdownDetail = expectCodexSubagentDetail(tools[1]!, SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT);
    expect(shutdownDetail.output).toBe('Completed the worker handoff.');
    expect(shutdownDetail.meta).toMatchObject({
      canonicalKey: expectedKey,
      rawStatus: 'completed',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
    });
  });

  it('emits SDK sub-agent snapshots for raw Codex runtime subagent notification tags', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-runtime-subagent-tag', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-runtime-subagent-tag', 'spawn a helper');
    const child = childProcessMock.children[0];
    child.child.stdout.write(
      '<subagent_notification>{"agent_path":"019e7f1c-raw","status":"running"}</subagent_notification>\n',
    );
    await flush();

    const expectedKey = makeCodexSubagentCanonicalKey('route-runtime-subagent-tag', 'runtime:019e7f1c-raw');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: expectedKey,
      name: 'Codex Sub-agent',
      status: 'running',
    });
    const detail = expectCodexSubagentDetail(tools[0]!, SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT);
    expect(detail.summary).toBe('Codex sub-agent 019e7f1c-raw');
    expect(detail.meta).toMatchObject({
      canonicalKey: expectedKey,
      agentPath: '019e7f1c-raw',
      rawStatus: 'running',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    });
  });

  it('surfaces raw update_plan function calls as checklist tool events', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-raw-update-plan', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-raw-update-plan', 'make a checklist');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'function_call',
          name: 'update_plan',
          call_id: 'call-plan-1',
          arguments: JSON.stringify({
            explanation: 'probe',
            plan: [
              { step: '梳理登录需求', status: 'completed' },
              { step: '实现登录表单', status: 'in_progress' },
              { step: '补充测试', status: 'pending' },
            ],
          }),
        },
      },
    });
    await flush();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: 'call-plan-1',
      name: 'update_plan',
      status: 'complete',
      input: {
        plan: [
          { content: '梳理登录需求', status: 'completed' },
          { content: '实现登录表单', status: 'in_progress' },
          { content: '补充测试', status: 'pending' },
        ],
      },
      detail: {
        kind: 'plan',
        summary: 'Plan',
      },
    });
  });

  it('surfaces codex>=0.139 native turn/plan/updated events as checklist tool events (new+old compatible)', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-native-plan', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-native-plan', 'make a plan');
    const child = childProcessMock.children[0];
    // 0.139 payload: { plan: [{ step, status }] } with camelCase `inProgress`.
    child.emits({
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        explanation: null,
        plan: [
          { step: 'Read notes.txt', status: 'completed' },
          { step: 'Append a line', status: 'inProgress' },
          { step: 'Summarize', status: 'pending' },
        ],
      },
    });
    await flush();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: 'codex-plan-turn-1',
      name: 'update_plan',
      status: 'running',
      input: {
        plan: [
          { content: 'Read notes.txt', status: 'completed' },
          { content: 'Append a line', status: 'in_progress' },
          { content: 'Summarize', status: 'pending' },
        ],
      },
      detail: { kind: 'plan', summary: 'Plan' },
    });

    // A follow-up update with all steps done reuses the SAME id (in-place
    // update) and flips status to complete.
    child.emits({
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        plan: [
          { step: 'Read notes.txt', status: 'completed' },
          { step: 'Append a line', status: 'completed' },
          { step: 'Summarize', status: 'completed' },
        ],
      },
    });
    await flush();

    expect(tools).toHaveLength(2);
    expect(tools[1]).toMatchObject({ id: 'codex-plan-turn-1', name: 'update_plan', status: 'complete' });
  });

  it('surfaces raw update_plan calls from the Codex rollout when app-server omits the item', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-rollout-plan-'));
    try {
      vi.stubEnv('CODEX_HOME', codexHome);
      const provider = new CodexSdkProvider();
      await provider.connect({ binaryPath: 'codex' });
      await provider.createSession({ sessionKey: 'route-rollout-update-plan', cwd: '/tmp/project' });

      const tools: ToolCallEvent[] = [];
      provider.onToolCall((_, tool) => tools.push(tool));

      await provider.send('route-rollout-update-plan', 'make a checklist');
      const child = childProcessMock.children[0];
      const nowIso = new Date().toISOString();
      const oldIso = new Date(Date.now() - 60_000).toISOString();
      await writeCodexRolloutFile(codexHome, 'thread-1', [
        {
          timestamp: oldIso,
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            call_id: 'call-old-plan',
            arguments: JSON.stringify({ plan: [{ step: 'old stale plan', status: 'in_progress' }] }),
          },
        },
        {
          timestamp: nowIso,
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            call_id: 'call-rollout-plan',
            arguments: JSON.stringify({
              plan: [
                { step: '生成任务清单', status: 'completed' },
                { step: '检查 timeline 落盘', status: 'in_progress' },
                { step: '验证前端可渲染', status: 'pending' },
              ],
            }),
          },
        },
      ]);

      child.emits({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 } },
        },
      });
      await waitForCondition(() => tools.length === 1, 5000);

      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        id: 'call-rollout-plan',
        name: 'update_plan',
        status: 'complete',
        input: {
          plan: [
            { content: '生成任务清单', status: 'completed' },
            { content: '检查 timeline 落盘', status: 'in_progress' },
            { content: '验证前端可渲染', status: 'pending' },
          ],
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('polls the Codex rollout briefly for raw update_plan calls without waiting for token usage', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-rollout-plan-poll-'));
    try {
      vi.stubEnv('CODEX_HOME', codexHome);
      const provider = new CodexSdkProvider();
      await provider.connect({ binaryPath: 'codex' });
      await provider.createSession({ sessionKey: 'route-rollout-update-plan-poll', cwd: '/tmp/project' });

      const tools: ToolCallEvent[] = [];
      provider.onToolCall((_, tool) => tools.push(tool));

      await provider.send('route-rollout-update-plan-poll', 'make a checklist');
      await writeCodexRolloutFile(codexHome, 'thread-1', [
        {
          timestamp: new Date().toISOString(),
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'UpdatePlan',
            call_id: 'call-rollout-plan-polled',
            arguments: JSON.stringify({
              plan: [
                { step: '创建轮询测试清单', status: 'completed' },
                { step: '等待 rollout 扫描', status: 'in_progress' },
                { step: '确认前端可消费', status: 'pending' },
              ],
            }),
          },
        },
      ]);

      await waitForCondition(() => tools.length === 1, 15_000);

      expect(tools[0]).toMatchObject({
        id: 'call-rollout-plan-polled',
        name: 'UpdatePlan',
        status: 'complete',
        input: {
          plan: [
            { content: '创建轮询测试清单', status: 'completed' },
            { content: '等待 rollout 扫描', status: 'in_progress' },
            { content: '确认前端可消费', status: 'pending' },
          ],
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('does not discard the first complete rollout line after advancing the scan offset', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-rollout-plan-offset-'));
    try {
      vi.stubEnv('CODEX_HOME', codexHome);
      const provider = new CodexSdkProvider();
      await provider.connect({ binaryPath: 'codex' });
      await provider.createSession({ sessionKey: 'route-rollout-update-plan-offset', cwd: '/tmp/project' });

      const tools: ToolCallEvent[] = [];
      provider.onToolCall((_, tool) => tools.push(tool));

      await provider.send('route-rollout-update-plan-offset', 'make a checklist');
      const child = childProcessMock.children[0];
      const rolloutPath = await writeCodexRolloutFile(codexHome, 'thread-1', [
        {
          timestamp: new Date().toISOString(),
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'not a checklist' }],
          },
        },
      ]);

      child.emits({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 } },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(tools).toHaveLength(0);

      await appendFile(rolloutPath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          call_id: 'call-rollout-plan-after-offset',
          arguments: JSON.stringify({
            plan: [
              { step: '启动清单创建', status: 'in_progress' },
              { step: '更新清单推进', status: 'pending' },
            ],
          }),
        },
      })}\n`);

      child.emits({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: { last: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 4 } },
        },
      });
      await waitForCondition(() => tools.length === 1);

      expect(tools[0]).toMatchObject({
        id: 'call-rollout-plan-after-offset',
        name: 'update_plan',
        status: 'complete',
        input: {
          plan: [
            { content: '启动清单创建', status: 'in_progress' },
            { content: '更新清单推进', status: 'pending' },
          ],
        },
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('emits backgrounded SDK sub-agent snapshots for raw spawn_agent response items', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-raw-spawn-agent', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-raw-spawn-agent', 'spawn a helper');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'function_call',
          name: 'spawn_agent',
          call_id: 'call-spawn-1',
          arguments: JSON.stringify({
            agent_type: 'worker',
            message: 'Wait for 100 seconds',
            model: 'gpt-5.5',
          }),
        },
      },
    });
    child.emits({
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'function_call_output',
          call_id: 'call-spawn-1',
          output: JSON.stringify({
            agent_id: '019e8422-0fed-7c12-ad2a-34da47e4e788',
            nickname: 'Huygens',
          }),
        },
      },
    });
    await flush();

    const expectedKey = makeCodexSubagentCanonicalKey(
      'route-raw-spawn-agent',
      'runtime:019e8422-0fed-7c12-ad2a-34da47e4e788',
    );
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: expectedKey,
      name: 'Codex Sub-agent',
      status: 'running',
      input: { action: 'codex-runtime-subagent', description: 'Wait for 100 seconds' },
    });
    const runningDetail = expectCodexSubagentDetail(tools[0]!, SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT);
    expect(runningDetail.meta).toMatchObject({
      canonicalKey: expectedKey,
      agentPath: '019e8422-0fed-7c12-ad2a-34da47e4e788',
      agentName: 'Huygens',
      model: 'gpt-5.5',
      rawStatus: 'running',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
      backgrounded: true,
    });
    expect(typeof runningDetail.meta.startedAtMs).toBe('number');

    child.emits({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null },
      },
    });
    await flush();
    expect(provider.getActiveWorkSnapshot('route-raw-spawn-agent')).toMatchObject({
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });

    child.emits({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: '019e8422-0fed-7c12-ad2a-34da47e4e788',
        turnId: 'turn-subagent-1',
        tokenUsage: {
          last: { inputTokens: 13, cachedInputTokens: 3, outputTokens: 5 },
          total: { inputTokens: 123, cachedInputTokens: 20, outputTokens: 45, totalTokens: 168 },
          modelContextWindow: 258400,
        },
      },
    });
    await flush();

    expect(tools).toHaveLength(2);
    expect(tools[1]).toMatchObject({
      id: expectedKey,
      name: 'Codex Sub-agent',
      status: 'running',
    });
    const usageDetail = expectCodexSubagentDetail(tools[1]!, SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT);
    expect(usageDetail.meta).toMatchObject({
      canonicalKey: expectedKey,
      usageTotalTokens: 168,
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
      backgrounded: true,
    });
    expect(usageDetail.meta.startedAtMs).toBe(runningDetail.meta.startedAtMs);
    expect(provider.getActiveWorkSnapshot('route-raw-spawn-agent')).toMatchObject({
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });

    child.emits({
      method: 'thread/status/changed',
      params: {
        threadId: '019e8422-0fed-7c12-ad2a-34da47e4e788',
        status: 'idle',
      },
    });
    await flush();

    expect(tools).toHaveLength(3);
    expect(tools[2]).toMatchObject({
      id: expectedKey,
      name: 'Codex Sub-agent',
      status: 'complete',
      output: 'idle',
    });
    const completeDetail = expectCodexSubagentDetail(tools[2]!, SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT);
    expect(completeDetail.meta).toMatchObject({
      canonicalKey: expectedKey,
      usageTotalTokens: 168,
      rawStatus: 'completed',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      backgrounded: true,
    });
    expect(completeDetail.meta.startedAtMs).toBe(runningDetail.meta.startedAtMs);

    child.emits({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: '019e8422-0fed-7c12-ad2a-34da47e4e788',
        turnId: 'turn-subagent-late',
        tokenUsage: {
          total: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        },
      },
    });
    await flush();
    expect(tools).toHaveLength(3);
  });

  it('emits backgrounded SDK sub-agent snapshots from Codex child rollout metadata', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-child-rollout-'));
    const provider = new CodexSdkProvider();
    try {
      await provider.connect({ binaryPath: 'codex', env: { CODEX_HOME: codexHome } });
      await provider.createSession({ sessionKey: 'route-child-rollout-subagent', cwd: '/tmp/project' });

      const tools: ToolCallEvent[] = [];
      provider.onToolCall((_, tool) => tools.push(tool));

      const rolloutStartedAt = new Date('2026-06-01T00:00:00.000Z');
      const rolloutPath = await writeCodexRolloutFile(codexHome, 'child-rollout-only', [
        {
          timestamp: rolloutStartedAt.toISOString(),
          type: 'session_meta',
          payload: {
            id: '019f-child-rollout-only',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: 'thread-1',
                  agent_nickname: 'Rawls',
                  agent_role: 'default',
                },
              },
            },
            agent_nickname: 'Rawls',
            agent_role: 'default',
          },
        },
        {
          timestamp: new Date().toISOString(),
          type: 'turn_context',
          payload: { model: 'gpt-5.5' },
        },
        {
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'Wait for 200 seconds',
          },
        },
      ]);

      await provider.send('route-child-rollout-subagent', 'spawn a child helper');
      await waitForCondition(() => tools.length === 1);

      const expectedKey = makeCodexSubagentCanonicalKey(
        'route-child-rollout-subagent',
        'runtime:019f-child-rollout-only',
      );
      expect(tools[0]).toMatchObject({
        id: expectedKey,
        name: 'Codex Sub-agent',
        status: 'running',
        input: { action: 'codex-runtime-subagent', description: 'Wait for 200 seconds' },
      });
      const runningDetail = expectCodexSubagentDetail(tools[0]!, SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT);
      expect(runningDetail.meta).toMatchObject({
        canonicalKey: expectedKey,
        agentPath: '019f-child-rollout-only',
        agentName: 'Rawls',
        model: 'gpt-5.5',
        rawStatus: 'running',
        normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
        active: true,
        terminal: false,
        backgrounded: true,
        startedAtMs: rolloutStartedAt.getTime(),
      });

      await appendFile(rolloutPath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          last_agent_message: '子代理 200 秒计时完成。',
          duration_ms: 200_000,
        },
      })}\n`);

      await waitForCondition(() => tools.length === 2, 15_000);
      expect(tools[1]).toMatchObject({
        id: expectedKey,
        name: 'Codex Sub-agent',
        status: 'complete',
        output: '子代理 200 秒计时完成。',
      });
      const completeDetail = expectCodexSubagentDetail(tools[1]!, SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT);
      expect(completeDetail.meta).toMatchObject({
        canonicalKey: expectedKey,
        rawStatus: 'completed',
        normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
        active: false,
        terminal: true,
        backgrounded: true,
        startedAtMs: rolloutStartedAt.getTime(),
      });
    } finally {
      await provider.disconnect().catch(() => {});
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('completes raw spawn_agent sub-agents from child rollout even when rollout parent id differs', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-child-rollout-agent-id-'));
    const provider = new CodexSdkProvider();
    try {
      await provider.connect({ binaryPath: 'codex', env: { CODEX_HOME: codexHome } });
      await provider.createSession({ sessionKey: 'route-child-rollout-agent-id', cwd: '/tmp/project' });

      const tools: ToolCallEvent[] = [];
      provider.onToolCall((_, tool) => tools.push(tool));

      await provider.send('route-child-rollout-agent-id', 'spawn a helper');
      const child = childProcessMock.children[0];
      child.emits({
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'function_call',
            name: 'spawn_agent',
            call_id: 'call-spawn-rollout-agent-id',
            arguments: JSON.stringify({ message: 'Wait for 60 seconds' }),
          },
        },
      });
      child.emits({
        method: 'rawResponseItem/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'function_call_output',
            call_id: 'call-spawn-rollout-agent-id',
            output: JSON.stringify({
              agent_id: '019f09e7-6e21-7493-a591-d55acec21e85',
              nickname: 'Chandrasekhar',
            }),
          },
        },
      });
      await waitForCondition(() => tools.length === 1);

      await writeCodexRolloutFile(codexHome, '019f09e7-6e21-7493-a591-d55acec21e85', [
        {
          timestamp: new Date().toISOString(),
          type: 'session_meta',
          payload: {
            id: '019f09e7-6e21-7493-a591-d55acec21e85',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: 'codex-cli-parent-rollout-id-not-thread-1',
                  agent_nickname: 'Chandrasekhar',
                },
              },
            },
            agent_nickname: 'Chandrasekhar',
          },
        },
        {
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            last_agent_message: 'Codex 子代理状态测试完成。',
          },
        },
      ]);

      await waitForCondition(() => tools.some((tool) => tool.status === 'complete'), 10000);
      const completedTool = tools.find((tool) => tool.status === 'complete')!;
      expect(completedTool).toMatchObject({
        id: makeCodexSubagentCanonicalKey(
          'route-child-rollout-agent-id',
          'runtime:019f09e7-6e21-7493-a591-d55acec21e85',
        ),
        name: 'Codex Sub-agent',
        status: 'complete',
        output: 'Codex 子代理状态测试完成。',
      });
    } finally {
      await provider.disconnect().catch(() => {});
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('discovers child rollout sub-agents by IM.codes session identity when Codex parent id differs', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-child-rollout-session-'));
    const provider = new CodexSdkProvider();
    try {
      await provider.connect({ binaryPath: 'codex', env: { CODEX_HOME: codexHome } });
      await provider.createSession({
        sessionKey: '89545d81-5ea0-4cf1-8eb3-8d0e9ff188a9',
        sessionName: 'route-child-rollout-session',
        cwd: '/tmp/project',
      });

      const tools: ToolCallEvent[] = [];
      provider.onToolCall((_, tool) => tools.push(tool));

      await provider.send('89545d81-5ea0-4cf1-8eb3-8d0e9ff188a9', 'spawn a helper through the SDK wrapper');
      const child = childProcessMock.children[0];
      emitCodexItem(child, 'item/started', collabItem({
        id: 'call-wrapper-spawn',
        status: 'inProgress',
        receiverThreadIds: ['unknown-pending-child'],
        agentsStates: { 'unknown-pending-child': { status: 'pendingInit' } },
        prompt: 'Wait for 45 seconds',
      }));

      await writeCodexRolloutFile(codexHome, '019f09f3-10d1-7832-91ae-666517d65455', [
        {
          timestamp: new Date().toISOString(),
          type: 'session_meta',
          payload: {
            id: '019f09f3-10d1-7832-91ae-666517d65455',
            cwd: '/tmp/project',
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: 'codex-cli-parent-rollout-id-not-thread-1',
                  agent_nickname: 'Linnaeus',
                  agent_role: 'default',
                },
              },
            },
            agent_nickname: 'Linnaeus',
            agent_role: 'default',
            base_instructions: {
              text: [
                'You are Codex.',
                '',
                '# IM.codes runtime instructions',
                '',
                '- Exact session name: route-child-rollout-session',
                '- Display label: route-child-rollout-session',
              ].join('\n'),
            },
          },
        },
        {
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'Wait for 45 seconds',
          },
        },
        {
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            last_agent_message: 'Codex SDK 子代理 UI 状态测试完成。',
          },
        },
      ]);

      await waitForCondition(
        () => tools.some((tool) => (
          tool.name === 'Codex Sub-agent'
          && tool.status === 'complete'
        )),
        10000,
      );
      const runtimeTool = tools.find((tool) => tool.name === 'Codex Sub-agent' && tool.status === 'complete')!;
      const expectedKey = makeCodexSubagentCanonicalKey(
        '89545d81-5ea0-4cf1-8eb3-8d0e9ff188a9',
        'runtime:019f09f3-10d1-7832-91ae-666517d65455',
      );
      expect(runtimeTool).toMatchObject({
        id: expectedKey,
        name: 'Codex Sub-agent',
        status: 'complete',
        input: { action: 'codex-runtime-subagent', description: 'Wait for 45 seconds' },
        output: 'Codex SDK 子代理 UI 状态测试完成。',
      });
      const detail = expectCodexSubagentDetail(runtimeTool, SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT);
      expect(detail.meta).toMatchObject({
        canonicalKey: expectedKey,
        agentPath: '019f09f3-10d1-7832-91ae-666517d65455',
        agentName: 'Linnaeus',
        rawStatus: 'completed',
        normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
        active: false,
        terminal: true,
        backgrounded: true,
      });
    } finally {
      await provider.disconnect().catch(() => {});
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('marks raw spawn_agent sub-agent rows complete from child turn completion', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-raw-spawn-agent-turn-complete', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-raw-spawn-agent-turn-complete', 'spawn a helper');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'function_call',
          name: 'spawn_agent',
          call_id: 'call-spawn-turn-complete',
          arguments: JSON.stringify({ message: 'Do one quick task' }),
        },
      },
    });
    child.emits({
      method: 'rawResponseItem/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'function_call_output',
          call_id: 'call-spawn-turn-complete',
          output: JSON.stringify({ agent_id: '019e8422-turn-complete', nickname: 'Huygens' }),
        },
      },
    });
    await flush();

    const expectedKey = makeCodexSubagentCanonicalKey(
      'route-raw-spawn-agent-turn-complete',
      'runtime:019e8422-turn-complete',
    );
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: expectedKey,
      status: 'running',
    });

    child.emits({
      method: 'turn/completed',
      params: {
        threadId: '019e8422-turn-complete',
        turn: { id: 'turn-child', status: 'completed', error: null },
      },
    });
    await flush();

    expect(tools).toHaveLength(2);
    expect(tools[1]).toMatchObject({
      id: expectedKey,
      status: 'complete',
      output: 'completed',
    });
    const completeDetail = expectCodexSubagentDetail(tools[1]!, SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT);
    expect(completeDetail.meta).toMatchObject({
      canonicalKey: expectedKey,
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
      backgrounded: true,
    });
  });

  it('diagnoses Codex runtime subagent notifications without an agent id', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-runtime-subagent-missing-id', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-runtime-subagent-missing-id', 'spawn a helper');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'subagent_notification',
      params: {
        threadId: 'thread-1',
        status: 'running',
      },
    });
    await flush();

    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe('error');
    const detail = expectCodexSubagentDetail(tools[0]!, SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT);
    expect(detail.meta).toMatchObject({
      canonicalKey: makeCodexSubagentCanonicalKey('route-runtime-subagent-missing-id', 'runtime:notification-missing-id'),
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.MISSING_ID,
    });
  });

  it('starts a thread, captures resume id, emits tool calls, streams message deltas, and completes', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-1', cwd: '/tmp/project' });

    const tools: Array<{ name: string; status: string; detail?: unknown }> = [];
    const deltas: string[] = [];
    const completed: string[] = [];
    const completedMessages: any[] = [];
    const sessionInfo: Array<Record<string, unknown>> = [];
    const usageUpdates: Array<Record<string, unknown>> = [];
    provider.onToolCall((_, tool) => tools.push({ name: tool.name, status: tool.status, detail: tool.detail }));
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));
    provider.onComplete((_sid, msg) => {
      completed.push(msg.content);
      completedMessages.push(msg);
    });
    provider.onSessionInfo?.((_sid, info) => sessionInfo.push(info as Record<string, unknown>));
    provider.onUsage?.((_sid, usage) => usageUpdates.push(usage as Record<string, unknown>));

    await provider.send('route-1', 'hello');
    const child = childProcessMock.children[0];
    const threadStartReq = child.requests.find((req) => req.method === 'thread/start');
    const turnStartReq = child.requests.find((req) => req.method === 'turn/start');
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'ls', aggregatedOutput: '', status: 'inProgress' } },
    });
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a\n', status: 'completed' } },
    });
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: '' } },
    });
    child.emits({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'O' } });
    child.emits({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'K' } });
    child.emits({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 },
          total: { inputTokens: 30, cachedInputTokens: 20, outputTokens: 5, totalTokens: 55, reasoningOutputTokens: 4 },
          modelContextWindow: 258400,
        },
      },
    });
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'OK' } },
    });
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await waitForCondition(
      () =>
        tools.length === 2 &&
        deltas.length === 2 &&
        usageUpdates.length === 1 &&
        completed.length === 1 &&
        sessionInfo.some((info) => info.resumeId === 'thread-1'),
    );

    expect(tools).toEqual([
      {
        name: 'Bash',
        status: 'running',
        detail: {
          kind: 'commandExecution',
          summary: 'ls',
          input: { command: 'ls', cwd: undefined, actions: undefined },
          output: '',
          meta: { status: 'inProgress', exitCode: undefined, durationMs: undefined, processId: undefined },
          raw: { id: 'cmd-1', type: 'commandExecution', command: 'ls', aggregatedOutput: '', status: 'inProgress' },
        },
      },
      {
        name: 'Bash',
        status: 'complete',
        detail: {
          kind: 'commandExecution',
          summary: 'ls',
          input: { command: 'ls', cwd: undefined, actions: undefined },
          output: 'a\n',
          meta: { status: 'completed', exitCode: undefined, durationMs: undefined, processId: undefined },
          raw: { id: 'cmd-1', type: 'commandExecution', command: 'ls', aggregatedOutput: 'a\n', status: 'completed' },
        },
      },
    ]);
    expect(threadStartReq?.params?.sandbox).toBe('danger-full-access');
    expect(threadStartReq?.params?.approvalPolicy).toBe('never');
    // No model selected → no per-model prompt available in
    // `~/.codex/models_cache.json` lookup → we send the short
    // provider-neutral FALLBACK so codex CLI's `session_startup_prewarm`
    // doesn't hand the OpenAI Responses API an empty `instructions` field
    // (which it now rejects with 400). Per-model override behavior is
    // exercised by the dedicated baseInstructions tests below.
    expect(typeof threadStartReq?.params?.baseInstructions).toBe('string');
    expect((threadStartReq?.params?.baseInstructions as string).length).toBeGreaterThan(20);
    expect(turnStartReq?.params?.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
    expect(turnStartReq?.params?.approvalPolicy).toBe('never');
    expect(deltas).toEqual(['O', 'OK']);
    expect(completed).toEqual(['OK']);
    expect(completedMessages[0]?.metadata?.usage).toMatchObject({
      input_tokens: 2,
      cache_read_input_tokens: 1,
      cached_input_tokens: 1,
      output_tokens: 2,
      total_tokens: 55,
      reasoning_output_tokens: 4,
      model_context_window: 258400,
      codex_total_input_tokens: 30,
      codex_total_cached_input_tokens: 20,
      codex_total_output_tokens: 5,
      codex_last_input_tokens: 3,
      codex_last_cached_input_tokens: 1,
      codex_last_output_tokens: 2,
    });
    expect(usageUpdates).toEqual([
      expect.objectContaining({
        usage: expect.objectContaining({
          input_tokens: 2,
          cache_read_input_tokens: 1,
          cached_input_tokens: 1,
        }),
      }),
    ]);
    expect(sessionInfo).toContainEqual({ resumeId: 'thread-1' });
  });

  it('uses final agentMessage from turn/completed items when item/completed was not observed', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-turn-items-final', cwd: '/tmp/project' });

    const deltas: string[] = [];
    const completedMessages: any[] = [];
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));
    provider.onComplete((_sid, msg) => completedMessages.push(msg));

    await provider.send('route-turn-items-final', 'hello');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [
            { id: 'cmd-1', type: 'commandExecution', command: 'echo ignored', status: 'completed' },
            { id: 'msg-final', type: 'agentMessage', text: 'Final answer from completed turn.' },
          ],
          error: null,
        },
      },
    });

    await waitForCondition(() => completedMessages.length === 1);

    expect(deltas).toEqual([]);
    expect(completedMessages[0]).toMatchObject({
      id: 'msg-final',
      content: 'Final answer from completed turn.',
      status: 'complete',
    });
    expect(provider.getSessionDiagnostics('route-turn-items-final')).toMatchObject({
      runningTurnId: null,
      currentTextLength: 'Final answer from completed turn.'.length,
      activeItemCount: 0,
    });

    await provider.send('route-turn-items-final', 'next');
    expect(child.requests.filter((req) => req.method === 'turn/start')).toHaveLength(2);
  });

  it('resets the streaming accumulator across agentMessages so a second message is not prefixed with the first', async () => {
    // A turn with a tool round produces TWO agentMessage items. The second
    // message's deltas must start fresh, not carry the first message's text.
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-multi', cwd: '/tmp/project' });

    const deltas: Array<{ id: string; text: string }> = [];
    provider.onDelta((_sid, delta) => deltas.push({ id: delta.messageId, text: delta.delta }));

    await provider.send('route-multi', 'hello');
    const child = childProcessMock.children[0];

    child.emits({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: '' } } });
    child.emits({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'First.' } });
    child.emits({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'First.' } } });
    // ── tool round, then the model continues in a NEW agentMessage ──
    child.emits({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-2', type: 'agentMessage', text: '' } } });
    child.emits({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-2', delta: 'Second' } });
    child.emits({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-2', delta: ' part.' } });
    child.emits({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-2', type: 'agentMessage', text: 'Second part.' } } });
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });

    await waitForCondition(() => deltas.filter((d) => d.id === 'msg-2').length >= 2);

    const msg2Deltas = deltas.filter((d) => d.id === 'msg-2').map((d) => d.text);
    expect(msg2Deltas).toEqual(['Second', 'Second part.']);
    expect(deltas.every((d) => !d.text.includes('First.Second'))).toBe(true);
  });

  it('never drops an agentMessage delta whose turnId differs from runningTurnId (provider field-shape drift)', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-mismatch-delta', cwd: '/tmp/project' });

    const deltas: string[] = [];
    provider.onDelta((_sid, d) => deltas.push(d.delta));

    await provider.send('route-mismatch-delta', 'hello');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-mismatch-delta')?.runningTurnId === 'turn-1',
    );

    const child = childProcessMock.children[0];
    // turnId 'turn-XYZ' differs from the tracked 'turn-1' (e.g. codex shifted the
    // turn-id field shape). Live text MUST still render, not be silently dropped.
    child.emits({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-XYZ', itemId: 'm1', delta: 'Mismatch text' },
    });
    await waitForCondition(() => deltas.some((d) => d.includes('Mismatch text')));
    expect(deltas.at(-1)).toBe('Mismatch text');
  });

  it('never drops an agentMessage delta when runningTurnId is unset (turn/start result had no turn id) and backfills it', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-unset-turnid', cwd: '/tmp/project' });

    const deltas: string[] = [];
    provider.onDelta((_sid, d) => deltas.push(d.delta));

    await provider.send('route-unset-turnid', 'hello');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-unset-turnid')?.runningTurnId === 'turn-1',
    );

    // Simulate turn/start having returned no usable turn id (provider field-shape
    // drift): clear runningTurnId + turnStartInFlight, mimicking result?.turn?.id === undefined.
    const state = (provider as unknown as {
      sessions: Map<string, { runningTurnId?: string; turnStartInFlight: boolean }>;
    }).sessions.get('route-unset-turnid')!;
    state.runningTurnId = undefined;
    state.turnStartInFlight = false;

    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'm1', delta: 'Live text' },
    });
    await waitForCondition(() => deltas.some((d) => d.includes('Live text')));
    expect(deltas.at(-1)).toBe('Live text');
    // The delta's turnId was adopted so the rest of the turn lifecycle still works.
    expect(provider.getSessionDiagnostics('route-unset-turnid')).toMatchObject({ runningTurnId: 'turn-1' });
  });

  it('exposes only safe allowlisted Codex session diagnostics', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({
      binaryPath: 'codex',
      env: { SHOULD_NOT_LEAK: 'secret-env-value' },
    });
    await provider.createSession({
      sessionKey: 'route-safe-diagnostics',
      cwd: '/tmp/project',
      env: { ALSO_SHOULD_NOT_LEAK: 'secret-session-env' },
    });

    await provider.send('route-safe-diagnostics', 'secret user prompt');
    const diagnostics = provider.getSessionDiagnostics('route-safe-diagnostics');

    expect(Object.keys(diagnostics ?? {}).sort()).toEqual([
      'active',
      'activeItemCount',
      'activeItemIds',
      'activeToolItemCount',
      'activeToolItemIds',
      'activeCompactionItemCount',
      'activeReason',
      'cancelTimerArmed',
      'cancelled',
      'compactHardTimeoutArmed',
      'compactObserved',
      'compactSettleArmed',
      'currentMessageId',
      'currentTextLength',
      'deferredIdleSettleTurnId',
      'deferredCompactSettleTurnId',
      'heartbeatFailureCount',
      'heartbeatInFlight',
      'heartbeatLeaseActive',
      'heartbeatLeaseTurnId',
      'lastAliveHeartbeatAtMs',
      'lastHeartbeatAttemptAtMs',
      'lastHeartbeatResponseAtMs',
      'loaded',
      'provider',
      'rawChecklistPollArmed',
      'routeId',
      'runningCompact',
      'runningTurnId',
      'threadId',
      'turnStartInFlight',
    ].sort());
    expect(JSON.stringify(diagnostics)).not.toContain('secret');
    expect(JSON.stringify(diagnostics)).not.toContain('/tmp/project');
  });

  it('clears provider compaction active-work evidence when compact is cancelled locally', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-compact-cancel-snapshot', cwd: '/tmp/project' });

    const errors: string[] = [];
    provider.onError((_sid, error) => errors.push(error.message));

    await provider.send('route-compact-cancel-snapshot', '/compact');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-compact-cancel-snapshot')?.runningCompact === true,
    );

    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-compact-1',
        item: { id: 'compact-item-1', type: 'contextCompaction' },
      },
    });
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-compact-cancel-snapshot')?.activeCompactionItemCount === 1,
    );

    expect(provider.getActiveWorkSnapshot('route-compact-cancel-snapshot')).toMatchObject({
      activeWorkCount: 1,
      activeToolCount: 0,
      busyReasons: ['provider_compaction'],
    });

    await provider.cancel('route-compact-cancel-snapshot');

    expect(errors).toContain('Codex compact cancelled');
    expect(provider.getSessionDiagnostics('route-compact-cancel-snapshot')).toMatchObject({
      runningCompact: false,
      activeItemCount: 0,
      activeToolItemCount: 0,
      activeCompactionItemCount: 0,
    });
    expect(provider.getActiveWorkSnapshot('route-compact-cancel-snapshot')).toMatchObject({
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });
  });

  it('completes a normal turn only from turn/completed; idle thread status mid-turn does not end it', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-idle-not-completion', cwd: '/tmp/project' });

    const completed: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg.content));

    await provider.send('route-idle-not-completion', 'hello');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-idle-not-completion')?.runningTurnId === 'turn-1',
    );

    const child = childProcessMock.children[0];
    // A thread that momentarily reports idle is NOT a turn-completion signal and
    // must not end the turn (no idle timers, no guessing when the turn ends).
    // Emit idle BEFORE the agent message: if idle wrongly completed the turn,
    // the later turn/completed would be de-duped and 'Done' would never surface.
    childProcessMock.enqueueThreadReadResult({
      thread: { id: 'thread-1', status: 'active' },
      turns: [{ id: 'turn-1', status: 'inProgress', current: true }],
    });
    child.emits({ method: 'thread/status/changed', params: { threadId: 'thread-1', turnId: 'turn-1', status: 'idle' } });
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'Done' } },
    });
    // Once the stream-ordered agent message is processed (currentText='Done'),
    // the idle event before it has also been processed — yet the turn is still
    // running and nothing has completed.
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-idle-not-completion')?.currentTextLength === 4,
    );
    expect(completed).toEqual([]);
    expect(provider.getSessionDiagnostics('route-idle-not-completion')).toMatchObject({ runningTurnId: 'turn-1' });

    // The explicit turn/completed event is the sole completion signal.
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await waitForCondition(() => completed.length === 1);
    expect(completed).toEqual(['Done']);
    expect(provider.getSessionDiagnostics('route-idle-not-completion')).toMatchObject({ runningTurnId: null });
  });

  it('settles a turn from thread-idle when the app-server sends no turn/completed (debounced)', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-idle-settles', cwd: '/tmp/project' });

    const completed: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg.content));

    await provider.send('route-idle-settles', 'hello');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-idle-settles')?.runningTurnId === 'turn-1',
    );

    const child = childProcessMock.children[0];
    // The agent produces its message, then the thread goes idle — but the current
    // Codex app-server emits NO `turn/completed`. With NOTHING following the idle,
    // the debounced idle-settle must complete the turn so it can never get stuck
    // "working" with the queue blocked (the phantom-active-turn regression).
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'Done' } },
    });
    childProcessMock.enqueueThreadReadResult({
      thread: { id: 'thread-1', status: 'idle' },
      turns: [{ id: 'turn-1', status: 'completed', current: false }],
    });
    child.emits({ method: 'thread/status/changed', params: { threadId: 'thread-1', turnId: 'turn-1', status: 'idle' } });

    await waitForCondition(() => completed.length === 1);
    expect(completed).toEqual(['Done']);
    expect(provider.getSessionDiagnostics('route-idle-settles')).toMatchObject({ runningTurnId: null });
  });

  it('defers thread-idle fallback while a Codex commandExecution item is active', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-idle-active-command', cwd: '/tmp/project' });

    const completed: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg.content));

    await provider.send('route-idle-active-command', 'run a long command');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-idle-active-command')?.runningTurnId === 'turn-1',
    );

    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'sleep 120',
          status: 'inProgress',
          processId: 45580,
        },
      },
    });
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-idle-active-command')?.activeItemCount === 1,
    );

    child.emits({ method: 'thread/status/changed', params: { threadId: 'thread-1', turnId: 'turn-1', status: 'idle' } });
    await new Promise((resolve) => setTimeout(resolve, 1700));

    expect(completed).toEqual([]);
    expect(provider.getSessionDiagnostics('route-idle-active-command')).toMatchObject({
      runningTurnId: 'turn-1',
      activeItemCount: 1,
      deferredIdleSettleTurnId: 'turn-1',
    });

    child.emits({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'sleep 120',
          status: 'completed',
          processId: 45580,
          exitCode: 0,
          durationMs: 120000,
        },
      },
    });

    await waitForCondition(() => completed.length === 1);
    expect(provider.getSessionDiagnostics('route-idle-active-command')).toMatchObject({
      runningTurnId: null,
      activeItemCount: 0,
      deferredIdleSettleTurnId: null,
    });
  });

  it('terminalizes active Codex commandExecution items on turn/completed', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-turn-completed-active-command', cwd: '/tmp/project' });

    const completed: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg.content));

    await provider.send('route-turn-completed-active-command', 'run a long command');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-turn-completed-active-command')?.runningTurnId === 'turn-1',
    );

    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'cmd-1', type: 'commandExecution', command: 'sleep 120', status: 'inProgress' },
      },
    });
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-turn-completed-active-command')?.activeToolItemCount === 1,
    );

    child.emits({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [{ id: 'msg-1', type: 'agentMessage', text: 'Done after command' }],
        },
      },
    });

    await waitForCondition(() => completed.length === 1);
    expect(completed[0]).toContain('Done after command');
    expect(provider.getSessionDiagnostics('route-turn-completed-active-command')).toMatchObject({
      runningTurnId: null,
      activeToolItemCount: 0,
      deferredIdleSettleTurnId: null,
    });
  });

  it('resumes with stored thread id on existing session', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-2', cwd: '/tmp/project', resumeId: 'thread-existing' });

    await provider.send('route-2', 'hello');
    const child = childProcessMock.children[0];
    const resumeReq = child.requests.find((req) => req.method === 'thread/resume');
    expect(resumeReq?.params?.threadId).toBe('thread-existing');
  });

  it('starts a replacement thread when stored Codex history is unreadable', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-corrupt', cwd: '/tmp/project', resumeId: 'thread-corrupt' });

    const errors: string[] = [];
    const sessionInfo: Array<Record<string, unknown>> = [];
    provider.onError((_sid, error) => errors.push(error.message));
    provider.onSessionInfo?.((_sid, info) => sessionInfo.push(info as Record<string, unknown>));

    await provider.send('route-corrupt', 'hello after corrupt history');

    const child = childProcessMock.children[0];
    const resumeReq = child.requests.find((req) => req.method === 'thread/resume');
    const startReq = child.requests.find((req) => req.method === 'thread/start');
    const turnReq = child.requests.find((req) => req.method === 'turn/start');
    expect(resumeReq?.params?.threadId).toBe('thread-corrupt');
    expect(startReq?.params?.cwd).toBe('/tmp/project');
    expect(turnReq?.params?.threadId).toBe('thread-1');
    expect(errors).toEqual([]);
    expect(sessionInfo).toContainEqual({ resumeId: 'thread-1' });
  });

  // ── baseInstructions sourcing ──────────────────────────────────────────
  // We always send a non-empty `baseInstructions` (codex CLI 0.125's
  // session_startup_prewarm otherwise hands the Responses API an empty
  // `instructions`, which it rejects with `Instructions are required`).
  //
  // Source priority:
  //   1. `~/.codex/models_cache.json` per-model `base_instructions` (full
  //      12–22 KB codex prompt — no quality regression for catalog models)
  //   2. Short provider-neutral FALLBACK_BASE_INSTRUCTIONS (for unknown /
  //      third-party models like minimax via `wire_api = "responses"`)

  it('forwards codex-cached base_instructions on thread/start for catalog model (gpt-5.4)', async () => {
    codexRuntimeConfigMock.set(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-cat', cwd: '/tmp/project', agentId: 'gpt-5.4' });
    await provider.send('route-cat', 'hello');
    const child = childProcessMock.children[0];
    const threadStartReq = child.requests.find((req) => req.method === 'thread/start');
    expect(threadStartReq?.params?.model).toBe('gpt-5.4');
    // Catalog hit → mock returns sentinel `[catalog-prompt:gpt-5.4]`. In
    // production this would be the real 14 KB codex base_instructions.
    // baseInstructions also has the IM.codes runtime tail (Generated
    // Image Reporting block) appended for every Codex thread, so use
    // toContain instead of toBe.
    const tStart = threadStartReq?.params?.baseInstructions as string;
    expect(tStart).toContain('[catalog-prompt:gpt-5.4]');
    expect(tStart).toContain('# IM.codes runtime instructions');
    expect(tStart).toContain('Generated images:');
    codexRuntimeConfigMock.reset();
  });

  it('sends fallback baseInstructions on thread/start when model is NOT in codex catalog (custom provider)', async () => {
    codexRuntimeConfigMock.set(['gpt-5.5', 'gpt-5.4']);
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-mini', cwd: '/tmp/project', agentId: 'codex-MiniMax-M2.5' });
    await provider.send('route-mini', 'hello');
    const child = childProcessMock.children[0];
    const threadStartReq = child.requests.find((req) => req.method === 'thread/start');
    expect(threadStartReq?.params?.model).toBe('codex-MiniMax-M2.5');
    const sent = threadStartReq?.params?.baseInstructions as string;
    expect(typeof sent).toBe('string');
    expect(sent.length).toBeGreaterThan(20);
    // Not the catalog sentinel — fallback path was taken.
    expect(sent).not.toMatch(/^\[catalog-prompt:/);
    codexRuntimeConfigMock.reset();
  });

  it('sends fallback baseInstructions on thread/resume for non-catalog model (heals previously-broken threads)', async () => {
    codexRuntimeConfigMock.set(['gpt-5.5']);
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({
      sessionKey: 'route-resume-mini',
      cwd: '/tmp/project',
      resumeId: 'thread-stored',
      agentId: 'codex-MiniMax-M2.5',
    });
    await provider.send('route-resume-mini', 'hello');
    const child = childProcessMock.children[0];
    const resumeReq = child.requests.find((req) => req.method === 'thread/resume');
    expect(resumeReq?.params?.threadId).toBe('thread-stored');
    const sent = resumeReq?.params?.baseInstructions as string;
    expect(typeof sent).toBe('string');
    expect(sent.length).toBeGreaterThan(20);
    expect(sent).not.toMatch(/^\[catalog-prompt:/);
    codexRuntimeConfigMock.reset();
  });

  it('forwards codex-cached base_instructions on thread/resume for catalog model', async () => {
    codexRuntimeConfigMock.set(['gpt-5.5', 'gpt-5.4']);
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({
      sessionKey: 'route-resume-cat',
      cwd: '/tmp/project',
      resumeId: 'thread-cat',
      agentId: 'gpt-5.4',
    });
    await provider.send('route-resume-cat', 'hello');
    const child = childProcessMock.children[0];
    const resumeReq = child.requests.find((req) => req.method === 'thread/resume');
    // Resume also gets the IM.codes runtime tail (image-reporting block).
    const tResume = resumeReq?.params?.baseInstructions as string;
    expect(tResume).toContain('[catalog-prompt:gpt-5.4]');
    expect(tResume).toContain('# IM.codes runtime instructions');
    expect(tResume).toContain('Generated images:');
    codexRuntimeConfigMock.reset();
  });

  it('lists codex models across paginated model/list responses', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });

    const resultPromise = provider.readModelList();
    const modelListRequests = () => childProcessMock.children.flatMap((child) =>
      child.requests
        .filter((req) => req.method === 'model/list')
        .map((req) => ({ child, req })),
    );
    await waitForCondition(() => modelListRequests().length >= 1);
    const { child: firstChild, req: firstRequest } = modelListRequests()[0]!;
    expect(firstRequest?.params).toMatchObject({ includeHidden: false, limit: 100 });

    firstChild.emits({
      id: firstRequest?.id,
      result: {
        data: [
          {
            id: 'mod-1',
            model: 'gpt-5.5',
            displayName: 'GPT-5.5',
            supportedReasoningEfforts: ['low', 'high'],
            isDefault: true,
          },
        ],
        nextCursor: 'cursor-2',
      },
    });
    await waitForCondition(() => modelListRequests().length >= 2);

    const { child: secondChild, req: secondRequest } = modelListRequests()[1]!;
    expect(secondRequest?.params).toMatchObject({ cursor: 'cursor-2', includeHidden: false, limit: 100 });
    secondChild.emits({
      id: secondRequest?.id,
      result: {
        data: [
          {
            id: 'mod-2',
            model: 'gpt-5.4-mini',
            displayName: 'GPT-5.4 Mini',
            supportedReasoningEfforts: [],
            isDefault: false,
          },
        ],
        nextCursor: null,
      },
    });

    await expect(resultPromise).resolves.toEqual([
      { id: 'gpt-5.5', name: 'GPT-5.5', supportsReasoningEffort: true, isDefault: true },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    ]);
  });

  it('maps normalized payloads into a message-side codex context block', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-payload', cwd: '/tmp/project' });

    const payload: ProviderContextPayload = {
      userMessage: 'ship it',
      assembledMessage: 'Relevant context\n\nship it',
      systemText: 'Normalized system text',
      messagePreamble: 'Relevant context',
      attachments: [],
      context: {
        systemText: 'Normalized system text',
        messagePreamble: 'Relevant context',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'route-payload' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    };

    await provider.send('route-payload', payload);
    const child = childProcessMock.children[0];
    const turnStartReq = child.requests.find((req) => req.method === 'turn/start');
    expect(turnStartReq?.params?.input?.[0]?.text).toBe(
      'Context instructions:\nNormalized system text\n\nRelevant context\n\nship it',
    );
  });

  it('moves split stable IM.codes context into codex baseInstructions and keeps only turn context in turn/start', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-split-context', cwd: '/tmp/project', agentId: 'gpt-5.4' });

    const payload: ProviderContextPayload = {
      userMessage: 'ship it',
      assembledMessage: 'Relevant context\n\nship it',
      sessionSystemText: 'Stable IM.codes runtime rules',
      turnSystemText: 'Required shared context:\n- Current file rule',
      systemText: 'Stable IM.codes runtime rules\n\nRequired shared context:\n- Current file rule',
      messagePreamble: 'Relevant context',
      attachments: [],
      context: {
        sessionSystemText: 'Stable IM.codes runtime rules',
        turnSystemText: 'Required shared context:\n- Current file rule',
        systemText: 'Stable IM.codes runtime rules\n\nRequired shared context:\n- Current file rule',
        messagePreamble: 'Relevant context',
        requiredAuthoredContext: ['Current file rule'],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: ['doc-v1'],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'route-split-context' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        providerPolicyOutcome: 'allowed',
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    };

    await provider.send('route-split-context', payload);
    const child = childProcessMock.children[0];
    const threadStartReq = child.requests.find((req) => req.method === 'thread/start');
    const turnStartReq = child.requests.find((req) => req.method === 'turn/start');

    expect(threadStartReq?.params?.baseInstructions).toContain('[catalog-prompt:gpt-5.4]');
    expect(threadStartReq?.params?.baseInstructions).toContain('# IM.codes runtime instructions');
    expect(threadStartReq?.params?.baseInstructions).toContain('Stable IM.codes runtime rules');
    expect(threadStartReq?.params?.baseInstructions).not.toContain('Current file rule');
    expect(turnStartReq?.params?.input?.[0]?.text).toBe(
      'Context instructions:\nRequired shared context:\n- Current file rule\n\nRelevant context\n\nship it',
    );
  });

  it('appends Generated Image Reporting protocol into codex baseInstructions tail (Codex is the only image-capable transport agent)', async () => {
    // p2p audit 37bfbb85-430 N-A follow-up: image-reporting belongs in
    // Codex's baseInstructions tail because (a) Codex is the only
    // transport agent with native image generation today, (b) sending it
    // once per thread/start beats sending it every turn, (c) it joins
    // Codex's prefix cache, (d) zero token cost for non-Codex providers.
    codexRuntimeConfigMock.set(['gpt-5.4']);
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-image', cwd: '/tmp/project', agentId: 'gpt-5.4' });

    const payload: ProviderContextPayload = {
      userMessage: 'draw something',
      assembledMessage: 'draw something',
      sessionSystemText: 'Stable IM.codes runtime rules',
      systemText: 'Stable IM.codes runtime rules',
      attachments: [],
      context: {
        sessionSystemText: 'Stable IM.codes runtime rules',
        systemText: 'Stable IM.codes runtime rules',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'route-image' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        providerPolicyOutcome: 'allowed',
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    };

    await provider.send('route-image', payload);
    const child = childProcessMock.children[0];
    const threadStartReq = child.requests.find((req) => req.method === 'thread/start');
    const base = threadStartReq?.params?.baseInstructions as string;
    expect(typeof base).toBe('string');
    // Codex's own per-model prompt is preserved at the head.
    expect(base).toContain('[catalog-prompt:gpt-5.4]');
    // IM.codes marker sits between codex's prompt and the daemon tail.
    expect(base).toContain('# IM.codes runtime instructions');
    // sessionSystemText still flows through.
    expect(base).toContain('Stable IM.codes runtime rules');
    // Compressed Generated Image Reporting block lives here now — every
    // semantic point present.
    expect(base).toContain('Generated images:');
    expect(base).toContain('file path of every image you create/edit/save');
    expect(base).toContain('repo-relative inside workspace, else absolute');
    expect(base).toContain('If no path returned, say so');
    expect(base).toContain('app/site/docs');
    codexRuntimeConfigMock.reset();
  });

  it('still appends image-reporting when sessionSystemText is absent (image-reporting is Codex-static, not gated on identity)', async () => {
    codexRuntimeConfigMock.set(['gpt-5.4']);
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-image-only', cwd: '/tmp/project', agentId: 'gpt-5.4' });

    const payload: ProviderContextPayload = {
      userMessage: 'draw something',
      assembledMessage: 'draw something',
      attachments: [],
      context: {
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'route-image-only' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        providerPolicyOutcome: 'allowed',
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    };

    await provider.send('route-image-only', payload);
    const child = childProcessMock.children[0];
    const threadStartReq = child.requests.find((req) => req.method === 'thread/start');
    const base = threadStartReq?.params?.baseInstructions as string;
    expect(base).toContain('[catalog-prompt:gpt-5.4]');
    expect(base).toContain('# IM.codes runtime instructions');
    expect(base).toContain('Generated images:');
    codexRuntimeConfigMock.reset();
  });

  it('appends exact Codex generated image file paths to the completed assistant message', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-images-'));
    const provider = new CodexSdkProvider();
    try {
      vi.stubEnv('CODEX_HOME', codexHome);
      await provider.connect({ binaryPath: 'codex' });
      await provider.createSession({ sessionKey: 'route-image-path', cwd: '/tmp/project' });

      const completed: string[] = [];
      provider.onComplete((_sid, msg) => completed.push(msg.content));
      const imageDir = join(codexHome, 'generated_images', 'thread-1');
      await mkdir(imageDir, { recursive: true });
      const staleImagePath = join(imageDir, 'ig_previous.png');
      await writeFile(staleImagePath, 'old-png');

      await provider.send('route-image-path', 'draw a cat');
      const child = childProcessMock.children[0]!;
      const imagePath = join(imageDir, 'ig_07d4759a673646ae016a1650951d848198b675e585a0b7b1e4.png');
      await writeFile(imagePath, 'fake-png');

      child.emits({
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'msg-1',
            type: 'agentMessage',
            text: '生成好了，但工具没有返回本地文件路径。',
          },
        },
      });
      child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });

      await waitForCondition(() => completed.length === 1);
      expect(completed[0]).toContain('生成好了，但工具没有返回本地文件路径。');
      expect(completed[0]).toContain('Generated image path detected by IM.codes:');
      expect(completed[0]).toContain(imagePath);
      expect(completed[0]).not.toContain(staleImagePath);
    } finally {
      await provider.disconnect().catch(() => {});
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('delivers changed split stable IM.codes context once after a Codex thread is loaded', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-stable-change', cwd: '/tmp/project', agentId: 'gpt-5.4' });

    const makePayload = (stable: string, turn: string): ProviderContextPayload => ({
      userMessage: 'ship it',
      assembledMessage: 'Relevant context\n\nship it',
      sessionSystemText: stable,
      turnSystemText: turn,
      systemText: `${stable}\n\n${turn}`,
      messagePreamble: 'Relevant context',
      attachments: [],
      context: {
        sessionSystemText: stable,
        turnSystemText: turn,
        systemText: `${stable}\n\n${turn}`,
        messagePreamble: 'Relevant context',
        requiredAuthoredContext: [turn],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: ['doc-v1'],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'route-stable-change' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        providerPolicyOutcome: 'allowed',
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    });

    await provider.send('route-stable-change', makePayload('Stable runtime v1', 'Required shared context:\n- First rule'));
    const child = childProcessMock.children[0];
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await flush();

    await provider.send('route-stable-change', makePayload('Stable runtime v2', 'Required shared context:\n- Second rule'));
    const secondTurnStart = child.requests.filter((req) => req.method === 'turn/start').at(-1);
    expect(secondTurnStart?.params?.input?.[0]?.text).toContain('# IM.codes runtime instructions updated:\nStable runtime v2');
    expect(secondTurnStart?.params?.input?.[0]?.text).toContain('Required shared context:\n- Second rule');
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await flush();

    await provider.send('route-stable-change', makePayload('Stable runtime v2', 'Required shared context:\n- Third rule'));
    const thirdTurnStart = child.requests.filter((req) => req.method === 'turn/start').at(-1);
    expect(thirdTurnStart?.params?.input?.[0]?.text).not.toContain('# IM.codes runtime instructions updated');
    expect(thirdTurnStart?.params?.input?.[0]?.text).not.toContain('Stable runtime v2');
    expect(thirdTurnStart?.params?.input?.[0]?.text).toContain('Required shared context:\n- Third rule');
  });

  it('re-sends a changed split stable context when the Codex update turn fails before completion', async () => {
    const provider = new CodexSdkProvider();
    const errors: string[] = [];
    provider.onError((_sid, error) => errors.push(error.message));
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-stable-failed-update', cwd: '/tmp/project', agentId: 'gpt-5.4' });

    const makePayload = (stable: string, turn: string): ProviderContextPayload => ({
      userMessage: 'ship it',
      assembledMessage: 'Relevant context\n\nship it',
      sessionSystemText: stable,
      turnSystemText: turn,
      systemText: `${stable}\n\n${turn}`,
      messagePreamble: 'Relevant context',
      attachments: [],
      context: {
        sessionSystemText: stable,
        turnSystemText: turn,
        systemText: `${stable}\n\n${turn}`,
        messagePreamble: 'Relevant context',
        requiredAuthoredContext: [turn],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: ['doc-v1'],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'route-stable-failed-update' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        providerPolicyOutcome: 'allowed',
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    });

    await provider.send('route-stable-failed-update', makePayload('Stable runtime v1', 'Required shared context:\n- First rule'));
    const child = childProcessMock.children[0];
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await flush();

    await provider.send('route-stable-failed-update', makePayload('Stable runtime v2', 'Required shared context:\n- Second rule'));
    const failedTurnStart = child.requests.filter((req) => req.method === 'turn/start').at(-1);
    expect(failedTurnStart?.params?.input?.[0]?.text).toContain('# IM.codes runtime instructions updated:\nStable runtime v2');
    child.emits({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: { message: 'synthetic failure' },
        },
      },
    });
    await flush();
    expect(errors).toContain('synthetic failure');

    await provider.send('route-stable-failed-update', makePayload('Stable runtime v2', 'Required shared context:\n- Retry rule'));
    const retryTurnStart = child.requests.filter((req) => req.method === 'turn/start').at(-1);
    expect(retryTurnStart?.params?.input?.[0]?.text).toContain('# IM.codes runtime instructions updated:\nStable runtime v2');
    expect(retryTurnStart?.params?.input?.[0]?.text).toContain('Required shared context:\n- Retry rule');
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await flush();

    await provider.send('route-stable-failed-update', makePayload('Stable runtime v2', 'Required shared context:\n- Later rule'));
    const finalTurnStart = child.requests.filter((req) => req.method === 'turn/start').at(-1);
    expect(finalTurnStart?.params?.input?.[0]?.text).not.toContain('# IM.codes runtime instructions updated');
    expect(finalTurnStart?.params?.input?.[0]?.text).toContain('Required shared context:\n- Later rule');
  });

  it('caps Codex SDK injected context while preserving the user turn text', async () => {
    vi.stubEnv('IMCODES_CODEX_SDK_CONTEXT_MAX_CHARS', '4000');
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-context-cap', cwd: '/tmp/project' });
    const userMessage = 'Please preserve this exact user request after context trimming';
    const systemText = `Enterprise standard ${'s'.repeat(3000)}`;
    const messagePreamble = `Historical memory ${'m'.repeat(3000)}`;

    await provider.send('route-context-cap', {
      userMessage,
      assembledMessage: `${messagePreamble}\n\n${userMessage}`,
      systemText,
      messagePreamble,
      attachments: undefined,
      context: {
        systemText,
        messagePreamble,
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'repo' },
        authoritySource: 'processed_local',
        freshness: 'fresh',
        fallbackAllowed: true,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    });

    const child = childProcessMock.children[0];
    const turnStartReq = child.requests.find((req) => req.method === 'turn/start');
    const inputText = String(turnStartReq?.params?.input?.[0]?.text ?? '');
    const separator = `\n\n${userMessage}`;
    const contextText = inputText.slice(0, inputText.indexOf(separator));
    expect(inputText).toContain(userMessage);
    expect(contextText.length).toBeLessThanOrEqual(4000);
    expect(contextText).toContain('injected context truncated');
  });

  it('maps normalized system context into the turn input text', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-context', cwd: '/tmp/project' });

    await provider.send('route-context', {
      userMessage: 'hello',
      assembledMessage: 'History block\n\nhello',
      systemText: 'Enterprise standard',
      messagePreamble: 'History block',
      attachments: undefined,
      context: {
        systemText: 'Enterprise standard',
        messagePreamble: 'History block',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'project_shared', projectId: 'repo' },
        authoritySource: 'processed_remote',
        freshness: 'fresh',
        fallbackAllowed: false,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    });

    const child = childProcessMock.children[0];
    const turnStartReq = child.requests.find((req) => req.method === 'turn/start');
    expect(turnStartReq?.params?.input).toEqual([
      {
        type: 'text',
        text: 'Context instructions:\nEnterprise standard\n\nHistory block\n\nhello',
      },
    ]);
  });

  it('maps raw /compact to Codex app-server native compaction instead of a model turn', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-compact', cwd: '/tmp/project' });

    const completed: Array<{ role: string; kind: string; content: string; metadata?: Record<string, unknown> }> = [];
    provider.onComplete((_sid, msg) => completed.push({
      role: msg.role,
      kind: msg.kind,
      content: msg.content,
      metadata: msg.metadata,
    }));

    await provider.send('route-compact', '/compact');

    const child = childProcessMock.children[0];
    expect(child.requests.some((req) => req.method === 'thread/compact/start')).toBe(true);
    expect(child.requests.some((req) => req.method === 'turn/start')).toBe(false);

    child.emits({ method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 'compact-turn-1' } });
    await flush();

    expect(completed).toEqual([
      expect.objectContaining({
        role: 'system',
        kind: 'system',
        content: 'Codex context compacted.',
        metadata: expect.objectContaining({
          provider: 'codex-sdk',
          event: 'thread/compacted',
          [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact',
          turnId: 'compact-turn-1',
        }),
      }),
    ]);
  });

  it('recognizes snake_case thread compact notifications and clears compact busy state', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-compact-snake', cwd: '/tmp/project' });

    const completed: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(String(msg.metadata?.turnId ?? '')));

    await provider.send('route-compact-snake', '/compact');

    const child = childProcessMock.children[0];
    child.emits({ method: 'thread/compacted', params: { thread_id: 'thread-1', turn_id: 'compact-turn-snake' } });
    await flush();

    expect(completed).toEqual(['compact-turn-snake']);
    await provider.send('route-compact-snake', 'after compact');
    expect(child.requests.filter((req) => req.method === 'turn/start')).toHaveLength(1);
  });

  it('completes compact on contextCompaction item completion even without turn/completed', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-compact-item', cwd: '/tmp/project' });

    const statuses: Array<{ status: string | null; label?: string | null }> = [];
    const completed: string[] = [];
    provider.onStatus?.((_sid, status) => statuses.push(status));
    provider.onComplete((_sid, msg) => completed.push(msg.content));

    await provider.send('route-compact-item', '/compact');

    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'compact-turn-item', item: { id: 'compact-item', type: 'contextCompaction' } },
    });
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'compact-turn-item', item: { id: 'compact-item', type: 'contextCompaction' } },
    });
    await flush();

    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting context...' },
      { status: null, label: null },
    ]);
    expect(completed).toEqual(['Codex context compacted.']);
    await provider.send('route-compact-item', 'after item compact');
    expect(child.requests.filter((req) => req.method === 'turn/start')).toHaveLength(1);
  });

  it('ignores duplicate compact turn completion without scanning stale generated images', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'imcodes-codex-compact-images-'));
    const provider = new CodexSdkProvider();
    try {
      vi.stubEnv('CODEX_HOME', codexHome);
      await provider.connect({ binaryPath: 'codex' });
      await provider.createSession({ sessionKey: 'route-compact-image-scan', cwd: '/tmp/project' });

      const imageDir = join(codexHome, 'generated_images', 'thread-1');
      await mkdir(imageDir, { recursive: true });
      const staleImagePath = join(imageDir, 'ig_previous.png');
      await writeFile(staleImagePath, 'old-png');

      const completed: string[] = [];
      provider.onComplete((_sid, msg) => completed.push(msg.content));

      await provider.send('route-compact-image-scan', '/compact');

      const child = childProcessMock.children[0];
      child.emits({
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'compact-turn-item',
          item: { id: 'compact-item', type: 'contextCompaction' },
        },
      });
      child.emits({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'compact-turn-item', status: 'completed', error: null },
        },
      });
      await flush();

      expect(completed).toEqual(['Codex context compacted.']);
      expect(completed.join('\n')).not.toContain('Generated image path detected by IM.codes');
      expect(completed.join('\n')).not.toContain(staleImagePath);
    } finally {
      await provider.disconnect().catch(() => {});
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('settles accepted compact requests that emit no native completion signal', async () => {
    vi.useFakeTimers();
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-compact-no-signal', cwd: '/tmp/project' });

    const completed: string[] = [];
    const errors: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg.content));
    provider.onError((_sid, err) => errors.push(err.code));

    await provider.send('route-compact-no-signal', '/compact');
    const child = childProcessMock.children[0];
    expect(child.requests.some((req) => req.method === 'thread/compact/start')).toBe(true);
    expect(completed).toEqual([]);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(errors).toEqual([]);
    expect(completed).toEqual(['Codex context compacted.']);
    await provider.send('route-compact-no-signal', 'after silent compact');
    expect(child.requests.filter((req) => req.method === 'turn/start')).toHaveLength(1);
  });

  it('does not settle compact by fallback after an active compact signal arrives', async () => {
    vi.useFakeTimers();
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-compact-active', cwd: '/tmp/project' });

    const completed: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg.content));

    await provider.send('route-compact-active', '/compact');
    const child = childProcessMock.children[0];
    child.emits({ method: 'thread/status/changed', params: { thread_id: 'thread-1', status: { type: 'active' } } });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(completed).toEqual([]);

    child.emits({ method: 'thread/status/changed', params: { thread_id: 'thread-1', status: 'idle' } });
    await Promise.resolve();
    expect(completed).toEqual(['Codex context compacted.']);
  });

  it('uses the raw userMessage when detecting /compact in normalized payloads', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-compact-context', cwd: '/tmp/project' });

    const payload: ProviderContextPayload = {
      userMessage: '  /compact  ',
      assembledMessage: 'Related history\n\n/compact',
      systemText: 'Injected runtime context',
      messagePreamble: 'Related history',
      attachments: undefined,
      context: {
        systemText: 'Injected runtime context',
        messagePreamble: 'Related history',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'repo' },
        authoritySource: 'processed_local',
        freshness: 'fresh',
        fallbackAllowed: true,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    };

    await provider.send('route-compact-context', payload);

    const child = childProcessMock.children[0];
    expect(child.requests.some((req) => req.method === 'thread/compact/start')).toBe(true);
    expect(child.requests.some((req) => req.method === 'turn/start')).toBe(false);
  });

  it('cancels an in-flight compact locally so the session can continue', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-compact-cancel', cwd: '/tmp/project' });

    const statuses: Array<{ status: string | null; label?: string | null }> = [];
    const completed: string[] = [];
    const errors: string[] = [];
    provider.onStatus?.((_sid, status) => statuses.push(status));
    provider.onComplete((_sid, msg) => completed.push(msg.content));
    provider.onError((_sid, err) => errors.push(`${err.code}:${err.message}`));

    await provider.send('route-compact-cancel', '/compact');
    await provider.cancel('route-compact-cancel');

    expect(errors).toEqual(['CANCELLED:Codex compact cancelled']);
    expect(statuses).toEqual([
      { status: 'compacting', label: 'Compacting context...' },
      { status: null, label: null },
    ]);

    const child = childProcessMock.children[0];
    child.emits({ method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 'late-compact' } });
    await flush();
    expect(completed).toEqual([]);

    await provider.send('route-compact-cancel', 'after compact cancel');
    expect(child.requests.filter((req) => req.method === 'turn/start')).toHaveLength(1);
  });

  it('rejects normalized payloads combined with legacy extraSystemPrompt', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-context', cwd: '/tmp/project' });

    await expect(provider.send('route-context', {
      userMessage: 'hello',
      assembledMessage: 'History block\n\nhello',
      systemText: 'Enterprise standard',
      messagePreamble: 'History block',
      attachments: undefined,
      context: {
        systemText: 'Enterprise standard',
        messagePreamble: 'History block',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'project_shared', projectId: 'repo' },
        authoritySource: 'processed_remote',
        freshness: 'fresh',
        fallbackAllowed: false,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    }, undefined, 'legacy raw context')).rejects.toThrow(/legacy extraSystemPrompt/i);
  });

  it('normalizes Windows cwd before sending app-server thread requests', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      const provider = new CodexSdkProvider();
      await provider.connect({ binaryPath: 'codex' });
      await provider.createSession({ sessionKey: 'route-win', cwd: 'C:\\Users\\admin\\project' });

      await provider.send('route-win', 'hello');
      const child = childProcessMock.children[0];
      const threadStartReq = child.requests.find((req) => req.method === 'thread/start');
      const turnStartReq = child.requests.find((req) => req.method === 'turn/start');

      expect(threadStartReq?.params?.cwd).toBe('C:/Users/admin/project');
      expect(turnStartReq?.params?.cwd).toBe('C:/Users/admin/project');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('fresh createSession ignores previous stored thread state for the same route', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-fresh', cwd: '/tmp/project', resumeId: 'thread-old' });
    await provider.createSession({ sessionKey: 'route-fresh', cwd: '/tmp/project', fresh: true });

    await provider.send('route-fresh', 'hello');
    const child = childProcessMock.children[0];
    expect(child.requests.some((req) => req.method === 'thread/resume' && req.params?.threadId === 'thread-old')).toBe(false);
    expect(child.requests.some((req) => req.method === 'thread/start')).toBe(true);
  });

  it('cancels an in-flight turn through turn/interrupt', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-cancel', cwd: '/tmp/project' });

    await provider.send('route-cancel', 'hello');
    const child = childProcessMock.children[0];
    await provider.cancel('route-cancel');
    expect(child.requests.some((req) => req.method === 'turn/interrupt')).toBe(true);
  });

  it('interrupts a Codex turn when cancel arrives before turn/start returns a turn id', async () => {
    childProcessMock.setHoldTurnStart(true);
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-cancel-pending-start', cwd: '/tmp/project' });

    const sendPromise = provider.send('route-cancel-pending-start', 'hello');
    const child = childProcessMock.children[0];
    await waitForCondition(() => child.requests.some((req) => req.method === 'turn/start'));

    await provider.cancel('route-cancel-pending-start');
    expect(child.requests.some((req) => req.method === 'turn/interrupt')).toBe(false);

    childProcessMock.releaseHeldTurnStarts();
    await sendPromise;
    await waitForCondition(() => child.requests.some((req) => req.method === 'turn/interrupt'));

    const interrupt = child.requests.find((req) => req.method === 'turn/interrupt');
    expect(interrupt?.params).toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' });
  });

  it('remembers Codex cancel when it arrives before thread/start returns a thread id', async () => {
    childProcessMock.setHoldThreadStart(true);
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-cancel-pending-thread', cwd: '/tmp/project' });

    const sendPromise = provider.send('route-cancel-pending-thread', 'hello');
    const child = childProcessMock.children[0];
    await waitForCondition(() => child.requests.some((req) => req.method === 'thread/start'));

    await provider.cancel('route-cancel-pending-thread');
    expect(child.requests.some((req) => req.method === 'turn/interrupt')).toBe(false);

    childProcessMock.releaseHeldThreadStarts();
    await sendPromise;
    await waitForCondition(() => child.requests.some((req) => req.method === 'turn/interrupt'));

    const interrupt = child.requests.find((req) => req.method === 'turn/interrupt');
    expect(interrupt?.params).toMatchObject({ threadId: 'thread-1', turnId: 'turn-1' });
  });

  it('ignores late Codex deltas and completed output after cancel', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-cancel-late-output', cwd: '/tmp/project' });

    const deltas: string[] = [];
    const completes: string[] = [];
    const errors: string[] = [];
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));
    provider.onComplete((_sid, message) => completes.push(message.content));
    provider.onError((_sid, err) => errors.push(err.code));

    await provider.send('route-cancel-late-output', 'hello');
    const child = childProcessMock.children[0];
    await provider.cancel('route-cancel-late-output');
    child.emits({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', itemId: 'msg-late', delta: 'late text' },
    });
    child.emits({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } },
    });
    await flush();

    expect(deltas).toEqual([]);
    expect(completes).toEqual([]);
    expect(errors).toContain(PROVIDER_ERROR_CODES.CANCELLED);
  });

  it('starts the Codex cancel watchdog even when turn/interrupt never acknowledges', async () => {
    vi.useFakeTimers();
    childProcessMock.setHoldTurnInterrupt(true);
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-cancel-interrupt-hangs', cwd: '/tmp/project' });

    const errors: string[] = [];
    provider.onError((_sid, err) => errors.push(err.code));

    await provider.send('route-cancel-interrupt-hangs', 'hello');
    const child = childProcessMock.children[0];
    await provider.cancel('route-cancel-interrupt-hangs');

    expect(child.requests.some((req) => req.method === 'turn/interrupt')).toBe(true);
    await vi.advanceTimersByTimeAsync(1_600);
    expect(errors).toContain(PROVIDER_ERROR_CODES.CANCELLED);
  });

  it('recovers the session when turn/interrupt never produces an interrupted completion', async () => {
    vi.useFakeTimers();
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-cancel-timeout', cwd: '/tmp/project' });

    const errors: string[] = [];
    provider.onError((_sid, err) => errors.push(err.code));

    await provider.send('route-cancel-timeout', 'hello');
    const child = childProcessMock.children[0];

    await provider.cancel('route-cancel-timeout');
    await vi.advanceTimersByTimeAsync(1_600);

    expect(child.requests.some((req) => req.method === 'turn/interrupt')).toBe(true);
    expect(errors).toContain('CANCELLED');

    await provider.send('route-cancel-timeout', 'after-cancel');
    expect(child.requests.filter((req) => req.method === 'turn/start')).toHaveLength(2);
  });

  it('does not let late Codex item events re-adopt a cancelled turn after the cancel watchdog', async () => {
    vi.useFakeTimers();
    childProcessMock.setHoldTurnInterrupt(true);
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-cancel-late-item-turnid', cwd: '/tmp/project' });

    await provider.send('route-cancel-late-item-turnid', 'hello');
    const child = childProcessMock.children[0];
    await provider.cancel('route-cancel-late-item-turnid');
    await vi.advanceTimersByTimeAsync(1_600);

    child.emits({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'late-reasoning', type: 'reasoning', text: 'late' },
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(provider.getSessionDiagnostics('route-cancel-late-item-turnid')).toMatchObject({
      runningTurnId: null,
      runningCompact: false,
    });
    await provider.send('route-cancel-late-item-turnid', 'after-cancel');
    expect(child.requests.filter((req) => req.method === 'turn/start')).toHaveLength(2);
  });

  it('does not let late contextCompaction items re-enter compacting after cancel', async () => {
    vi.useFakeTimers();
    childProcessMock.setHoldTurnInterrupt(true);
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-cancel-late-compact-item', cwd: '/tmp/project' });

    await provider.send('route-cancel-late-compact-item', 'hello');
    const child = childProcessMock.children[0];
    await provider.cancel('route-cancel-late-compact-item');
    await vi.advanceTimersByTimeAsync(1_600);

    child.emits({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'late-compact', type: 'contextCompaction' },
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(provider.getSessionDiagnostics('route-cancel-late-compact-item')).toMatchObject({
      runningTurnId: null,
      runningCompact: false,
    });
    await provider.send('route-cancel-late-compact-item', 'after-cancel');
    expect(child.requests.filter((req) => req.method === 'turn/start')).toHaveLength(2);
  });

  it('does not let late Codex item events re-adopt a failed turn', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-failed-late-item-turnid', cwd: '/tmp/project' });

    const deltas: string[] = [];
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));

    await provider.send('route-failed-late-item-turnid', 'hello');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'failed', error: { message: 'boom' } },
      },
    });
    await flush();

    child.emits({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'late-msg', type: 'agentMessage', text: 'late text' },
      },
    });
    await flush();

    expect(provider.getSessionDiagnostics('route-failed-late-item-turnid')).toMatchObject({
      runningTurnId: null,
      runningCompact: false,
    });
    expect(deltas).toContain('late text');
    await provider.send('route-failed-late-item-turnid', 'after-failure');
    expect(child.requests.filter((req) => req.method === 'turn/start')).toHaveLength(2);
  });

  it('does not render late plan updates for a failed turn', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-failed-late-plan', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_sid, tool) => tools.push(tool));

    await provider.send('route-failed-late-plan', 'hello');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'failed', error: { message: 'boom' } },
      },
    });
    await flush();

    child.emits({
      method: 'turn/plan/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        plan: { steps: [{ text: 'late plan', status: 'in_progress' }] },
      },
    });
    await flush();

    expect(tools).toEqual([]);
  });

  it('emits WebSearch tool events for webSearch items (legacy top-level query)', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-websearch', cwd: '/tmp/project' });

    const tools: Array<{ name: string; status: string; input: unknown; detail?: unknown }> = [];
    provider.onToolCall((_, tool) => tools.push({ name: tool.name, status: tool.status, input: tool.input, detail: tool.detail }));

    await provider.send('route-websearch', 'search');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-1', type: 'webSearch', query: 'nyc weather' } },
    });
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-1', type: 'webSearch', query: 'nyc weather', action: { type: 'search', query: 'nyc weather' } } },
    });
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await flush();

    expect(tools[0].name).toBe('WebSearch');
    expect((tools[0].input as { query: string }).query).toBe('nyc weather');
    expect(tools[1].name).toBe('WebSearch');
    expect((tools[1].input as { query: string }).query).toBe('nyc weather');
    const detail = tools[1].detail as { kind: string; summary: string; meta: { actionType?: string } };
    expect(detail.kind).toBe('webSearch');
    expect(detail.summary).toBe('nyc weather');
    expect(detail.meta.actionType).toBe('search');
  });

  it('extracts WebSearch query from action.query when item.query is absent (current Codex CLI shape)', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-websearch-action', cwd: '/tmp/project' });

    const tools: Array<{ name: string; status: string; input: unknown; detail?: unknown }> = [];
    provider.onToolCall((_, tool) => tools.push({ name: tool.name, status: tool.status, input: tool.input, detail: tool.detail }));

    await provider.send('route-websearch-action', 'search');
    const child = childProcessMock.children[0];
    // Modern Codex CLI: top-level `query` absent, query lives under `action.query`.
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-2', type: 'webSearch', action: { type: 'search', query: 'minimax glm pricing' } } },
    });
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-2', type: 'webSearch', action: { type: 'search', query: 'minimax glm pricing' } } },
    });
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await flush();

    expect((tools[0].input as { query: string }).query).toBe('minimax glm pricing');
    expect((tools[1].input as { query: string }).query).toBe('minimax glm pricing');
    const detail = tools[1].detail as { summary: string; meta: { actionType?: string } };
    expect(detail.summary).toBe('minimax glm pricing');
    expect(detail.meta.actionType).toBe('search');
  });

  it('falls back to action url/pattern/type for non-search WebSearch actions', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-websearch-other', cwd: '/tmp/project' });

    const tools: Array<{ name: string; status: string; input: unknown; detail?: unknown }> = [];
    provider.onToolCall((_, tool) => tools.push({ name: tool.name, status: tool.status, input: tool.input, detail: tool.detail }));

    await provider.send('route-websearch-other', 'search');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-3', type: 'webSearch', action: { type: 'open_page', url: 'https://example.com/article' } } },
    });
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-4', type: 'webSearch', action: { type: 'find_in_page', pattern: 'pricing' } } },
    });
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-5', type: 'webSearch', action: { type: 'other' } } },
    });
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await flush();

    const summaries = tools.map((t) => (t.detail as { summary?: string }).summary);
    expect(summaries[0]).toBe('https://example.com/article');
    expect(summaries[1]).toBe('pricing');
    expect(summaries[2]).toBe('(other)');

    // Regression (chat-row rendering): `input` must surface a non-empty
    // `query` with the same label as `summary`, and must NOT carry the raw
    // `action` object. Previously `input = { query: '', action: { type: ... } }`
    // — the web UI's `summarizeToolInput` treats an empty `query` as
    // not-useful, walks past it, sees two keys, and falls back to
    // `JSON.stringify(input)`. That produced `{"query":"","action":{"type":"other"}}`
    // stamped into the chat row instead of a readable label.
    const inputs = tools.map((t) => t.input as Record<string, unknown>);
    expect(inputs[0]).toEqual({ query: 'https://example.com/article' });
    expect(inputs[1]).toEqual({ query: 'pricing' });
    expect(inputs[2]).toEqual({ query: '(other)' });
    for (const inp of inputs) {
      expect(inp.action).toBeUndefined();
      expect(inp.query).not.toBe('');
    }
  });

  it('WebSearch started lifecycle with no action surfaces a readable label (not empty query)', async () => {
    // Covers the screen artifact from the 2026-04-20 production report:
    // codex emits `item/started` before the search has a query. Without
    // this fallback the UI rendered `WebSearch {"query":"","action":...}`.
    // The started-state label must be a non-empty string so
    // `summarizeToolInput` short-circuits on `query` instead of
    // JSON-stringifying the whole input object.
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-websearch-start', cwd: '/tmp/project' });

    const tools: Array<{ input: unknown; status: string }> = [];
    provider.onToolCall((_, tool) => tools.push({ input: tool.input, status: tool.status }));

    await provider.send('route-websearch-start', 'search');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-start', type: 'webSearch', action: { type: 'other' } } },
    });
    await flush();

    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe('running');
    const input = tools[0].input as Record<string, unknown>;
    expect(input.query).toBe('(other)');
    expect(input.action).toBeUndefined();
  });

  it('ignores empty-string WebSearch query fields and still falls back to action type', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-websearch-empty-query', cwd: '/tmp/project' });

    const tools: Array<{ input: unknown; detail?: unknown }> = [];
    provider.onToolCall((_, tool) => tools.push({ input: tool.input, detail: tool.detail }));

    await provider.send('route-websearch-empty-query', 'search');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'ws-empty',
          type: 'webSearch',
          query: '',
          action: { type: 'other', query: '' },
        },
      },
    });
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await flush();

    expect(tools).toHaveLength(1);
    expect(tools[0].input).toEqual({ query: '(other)' });
    const detail = tools[0].detail as { summary?: string; input?: Record<string, unknown>; meta?: { actionType?: string } };
    expect(detail.summary).toBe('(other)');
    expect(detail.input).toEqual({ query: '(other)', action: { type: 'other', query: '' } });
    expect(detail.meta?.actionType).toBe('other');
  });

  it('surfaces the final WebSearch query on completion even if started emitted only a generic fallback', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-websearch-late-query', cwd: '/tmp/project' });

    const tools: Array<{ status: string; input: unknown; detail?: unknown }> = [];
    provider.onToolCall((_, tool) => tools.push({ status: tool.status, input: tool.input, detail: tool.detail }));

    await provider.send('route-websearch-late-query', 'search');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-late', type: 'webSearch', action: { type: 'other' } } },
    });
    child.emits({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'ws-late',
          type: 'webSearch',
          query: 'apple stock today',
          action: { type: 'search', query: 'apple stock today' },
        },
      },
    });
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await flush();

    expect(tools).toHaveLength(2);
    expect(tools[0].status).toBe('running');
    expect(tools[0].input).toEqual({ query: '(other)' });
    expect(tools[1].status).toBe('complete');
    expect(tools[1].input).toEqual({ query: 'apple stock today' });
    const detail = tools[1].detail as { summary?: string; input?: Record<string, unknown> };
    expect(detail.summary).toBe('apple stock today');
    expect(detail.input).toEqual({ query: 'apple stock today', action: { type: 'search', query: 'apple stock today' } });
  });

  it('terminalizes a WebSearch started event when the turn completes without item/completed', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-websearch-start-only-turn-complete', cwd: '/tmp/project' });

    const tools: Array<Pick<ToolCallEvent, 'id' | 'name' | 'status' | 'input' | 'terminalStatus' | 'terminalReason' | 'terminalSynthetic' | 'terminalSource' | 'terminalDecisionReason' | 'terminalIdempotencyKey' | 'turnId' | 'lifecycleItemKind'>> = [];
    provider.onToolCall((_, tool) => tools.push({
      id: tool.id,
      name: tool.name,
      status: tool.status,
      input: tool.input,
      terminalStatus: tool.terminalStatus,
      terminalReason: tool.terminalReason,
      terminalSynthetic: tool.terminalSynthetic,
      terminalSource: tool.terminalSource,
      terminalDecisionReason: tool.terminalDecisionReason,
      terminalIdempotencyKey: tool.terminalIdempotencyKey,
      turnId: tool.turnId,
      lifecycleItemKind: tool.lifecycleItemKind,
    }));

    await provider.send('route-websearch-start-only-turn-complete', 'search');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-websearch-start-only-turn-complete')?.runningTurnId === 'turn-1',
    );
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-start-only', type: 'webSearch', action: { type: 'other' } } },
    });
    await waitForCondition(() => tools.length === 1);
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'Done.' } },
    });
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });

    await waitForCondition(() => tools.length === 2);
    expect(tools).toEqual([
      expect.objectContaining({ id: 'ws-start-only', name: 'WebSearch', status: 'running', input: { query: '(other)' } }),
      expect.objectContaining({
        id: 'ws-start-only',
        name: 'WebSearch',
        status: 'complete',
        input: { query: '(other)' },
        terminalStatus: 'succeeded',
        terminalReason: 'app_server_completed',
        terminalSynthetic: true,
        terminalSource: 'app_server_jsonrpc',
        terminalDecisionReason: 'app_server_completed',
        turnId: 'turn-1',
        lifecycleItemKind: 'web_search',
      }),
    ]);
    expect(tools[1]?.terminalIdempotencyKey).toContain('ws-start-only:succeeded:app_server_completed');
  });

  it('reports turn-start in-flight as provider active work until Codex returns a turn id', async () => {
    childProcessMock.setHoldTurnStart(true);
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-turn-start-snapshot', cwd: '/tmp/project' });

    const sendPromise = provider.send('route-turn-start-snapshot', 'hello');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-turn-start-snapshot')?.turnStartInFlight === true,
    );

    expect(provider.getActiveWorkSnapshot('route-turn-start-snapshot')).toMatchObject({
      activeWorkCount: 1,
      activeToolCount: 0,
      busyReasons: ['provider_wait'],
    });

    childProcessMock.releaseHeldTurnStarts();
    await sendPromise;
  });

  it('reports started-only WebSearch provider tools in the active-work snapshot', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-websearch-snapshot', cwd: '/tmp/project' });

    await provider.send('route-websearch-snapshot', 'search');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-websearch-snapshot')?.runningTurnId === 'turn-1',
    );
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-snapshot', type: 'webSearch', action: { type: 'other' } } },
    });
    await waitForCondition(
      () => provider.getActiveWorkSnapshot('route-websearch-snapshot')?.activeToolCount === 1,
    );

    expect(provider.getActiveWorkSnapshot('route-websearch-snapshot')).toMatchObject({
      activeWorkCount: 1,
      activeToolCount: 1,
      busyReasons: ['provider_tool_item'],
    });
  });

  it('terminalizes orphan provider tools on cancel when app-server no longer has a running turn id', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-websearch-orphan-cancel', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    const errors: string[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));
    provider.onError((_, error) => errors.push(error.code));

    await provider.send('route-websearch-orphan-cancel', 'search');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-websearch-orphan-cancel')?.runningTurnId === 'turn-1',
    );
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-orphan-cancel', type: 'webSearch', action: { type: 'other' } } },
    });
    await waitForCondition(
      () => provider.getActiveWorkSnapshot('route-websearch-orphan-cancel')?.activeToolCount === 1,
    );

    const state = (provider as unknown as {
      sessions: Map<string, { runningTurnId?: string; turnStartInFlight: boolean }>;
    }).sessions.get('route-websearch-orphan-cancel')!;
    state.runningTurnId = undefined;
    state.turnStartInFlight = false;

    await provider.cancel('route-websearch-orphan-cancel');

    expect(child.requests.some((req) => req.method === 'turn/interrupt')).toBe(false);
    expect(errors).toContain(PROVIDER_ERROR_CODES.CANCELLED);
    expect(tools).toContainEqual(expect.objectContaining({
      id: 'ws-orphan-cancel',
      status: 'error',
      terminalStatus: 'cancelled',
      terminalReason: 'user_cancelled',
      terminalSynthetic: true,
      terminalSource: 'daemon_synthetic',
      terminalDecisionReason: 'user_cancelled',
      lifecycleItemKind: 'web_search',
    }));
    expect(provider.getActiveWorkSnapshot('route-websearch-orphan-cancel')).toMatchObject({
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
    });
  });

  it('abandons stale open provider tools at the next send boundary before starting a new turn', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-websearch-rollover', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_, tool) => tools.push(tool));

    await provider.send('route-websearch-rollover', 'search');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-websearch-rollover')?.runningTurnId === 'turn-1',
    );
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-rollover', type: 'webSearch', action: { type: 'other' } } },
    });
    await waitForCondition(() => tools.some((tool) => tool.id === 'ws-rollover' && tool.status === 'running'));

    const state = (provider as unknown as {
      sessions: Map<string, { runningTurnId?: string; turnStartInFlight: boolean }>;
    }).sessions.get('route-websearch-rollover')!;
    state.runningTurnId = undefined;
    state.turnStartInFlight = false;

    await provider.send('route-websearch-rollover', 'next');

    expect(tools).toContainEqual(expect.objectContaining({
      id: 'ws-rollover',
      status: 'error',
      terminalStatus: 'abandoned',
      terminalReason: 'generation_rollover',
      terminalSynthetic: true,
      terminalSource: 'daemon_synthetic',
      terminalDecisionReason: 'generation_rollover',
      lifecycleItemKind: 'web_search',
    }));
  });

  it('terminalizes a WebSearch started event when thread-idle settles a turn without turn/completed', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-websearch-start-only-idle-settle', cwd: '/tmp/project' });

    const tools: Array<Pick<ToolCallEvent, 'id' | 'name' | 'status' | 'input' | 'terminalStatus' | 'terminalReason' | 'terminalSynthetic' | 'terminalSource' | 'terminalDecisionReason' | 'terminalIdempotencyKey' | 'turnId' | 'lifecycleItemKind'>> = [];
    const completed: string[] = [];
    provider.onToolCall((_, tool) => tools.push({
      id: tool.id,
      name: tool.name,
      status: tool.status,
      input: tool.input,
      terminalStatus: tool.terminalStatus,
      terminalReason: tool.terminalReason,
      terminalSynthetic: tool.terminalSynthetic,
      terminalSource: tool.terminalSource,
      terminalDecisionReason: tool.terminalDecisionReason,
      terminalIdempotencyKey: tool.terminalIdempotencyKey,
      turnId: tool.turnId,
      lifecycleItemKind: tool.lifecycleItemKind,
    }));
    provider.onComplete((_, message) => completed.push(message.content));

    await provider.send('route-websearch-start-only-idle-settle', 'search');
    await waitForCondition(
      () => provider.getSessionDiagnostics('route-websearch-start-only-idle-settle')?.runningTurnId === 'turn-1',
    );
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'ws-idle-only', type: 'webSearch', action: { type: 'other' } } },
    });
    await waitForCondition(() => tools.length === 1);
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'Done.' } },
    });
    childProcessMock.enqueueThreadReadResult({
      thread: { id: 'thread-1', status: 'idle' },
      turns: [{ id: 'turn-1', status: 'completed', current: false }],
    });
    child.emits({ method: 'thread/status/changed', params: { threadId: 'thread-1', turnId: 'turn-1', status: 'idle' } });

    await waitForCondition(() => completed.length === 1 && tools.length === 2);
    expect(completed).toEqual(['Done.']);
    expect(tools).toEqual([
      expect.objectContaining({ id: 'ws-idle-only', name: 'WebSearch', status: 'running', input: { query: '(other)' } }),
      expect.objectContaining({
        id: 'ws-idle-only',
        name: 'WebSearch',
        status: 'complete',
        input: { query: '(other)' },
        terminalStatus: 'succeeded',
        terminalReason: 'thread_idle_settle',
        terminalSynthetic: true,
        terminalSource: 'daemon_synthetic',
        terminalDecisionReason: 'thread_idle_settle',
        turnId: 'turn-1',
        lifecycleItemKind: 'web_search',
      }),
    ]);
    expect(tools[1]?.terminalIdempotencyKey).toContain('ws-idle-only:succeeded:thread_idle_settle');
  });

  it('surfaces Codex todo_list completed items as update_plan tool calls', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-todo-list', cwd: '/tmp/project' });

    const tools: Array<{ name: string; status: string; input: unknown; detail?: unknown }> = [];
    provider.onToolCall((_, tool) => tools.push({ name: tool.name, status: tool.status, input: tool.input, detail: tool.detail }));

    await provider.send('route-todo-list', 'make a plan');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'todo-1',
          type: 'todo_list',
          items: [
            { text: '梳理登录需求', completed: true },
            { text: '实现登录表单', completed: false },
          ],
        },
      },
    });
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await flush();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'update_plan',
      status: 'complete',
      input: {
        plan: [
          { content: '梳理登录需求', status: 'completed' },
          { content: '实现登录表单', status: 'pending' },
        ],
      },
    });
    expect(tools[0].detail).toMatchObject({
      kind: 'plan',
      summary: 'Plan',
    });
  });

  it('applies thinking level to subsequent Codex SDK turns', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-think', cwd: '/tmp/project', effort: 'medium' });
    provider.setSessionEffort('route-think', 'high');

    await provider.send('route-think', 'hello');
    const child = childProcessMock.children[0];
    const turnStartReq = child.requests.find((req) => req.method === 'turn/start');
    expect(turnStartReq?.params?.effort).toBe('high');
  });

  it('propagates per-session IM.codes sender identity env through Codex app-server requests', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({
      sessionKey: 'route-env',
      cwd: '/tmp/project',
      env: {
        IMCODES_SESSION: 'deck_repo_w1',
        IMCODES_SESSION_LABEL: 'Cx1',
      },
    });

    await provider.send('route-env', 'hello');
    const child = childProcessMock.children[0];
    const threadStartReq = child.requests.find((req) => req.method === 'thread/start');
    const turnStartReq = child.requests.find((req) => req.method === 'turn/start');

    expect(threadStartReq?.params?.env).toMatchObject({
      IMCODES_SESSION: 'deck_repo_w1',
      IMCODES_SESSION_LABEL: 'Cx1',
    });
    expect(turnStartReq?.params?.env).toMatchObject({
      IMCODES_SESSION: 'deck_repo_w1',
      IMCODES_SESSION_LABEL: 'Cx1',
    });
  });

  it('injects Memory MCP identity through per-thread config instead of app-server argv', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({
      sessionKey: 'route-mcp',
      sessionName: 'deck_repo_w1',
      projectName: 'repo',
      serverId: 'srv-bound',
      cwd: '/tmp/project',
      contextNamespace: {
        scope: 'user_private',
        userId: 'user-secret-ish',
        projectId: 'github.com/acme/project',
      },
    });

    await provider.send('route-mcp', 'hello');
    const child = childProcessMock.children[0];
    const spawnArgs = childProcessMock.spawn.mock.calls[0]?.[1] as string[];
    const threadStartReq = child.requests.find((req) => req.method === 'thread/start');
    const config = threadStartReq?.params?.config as Record<string, any> | undefined;
    const mcpServer = config?.mcp_servers?.[IMCODES_MEMORY_MCP_SERVER_NAME];

    expect(JSON.stringify(spawnArgs)).toContain(IMCODES_MEMORY_MCP_SERVER_NAME);
    expect(JSON.stringify(spawnArgs)).not.toContain('user-secret-ish');
    expect(JSON.stringify(spawnArgs)).not.toContain('github.com/acme/project');
    expect(mcpServer).toMatchObject({
      command: 'imcodes',
      args: ['memory', 'mcp'],
      env: {
        [IMCODES_DAEMON_USER_ID_ENV]: 'user-secret-ish',
        [IMCODES_DAEMON_SESSION_NAME_ENV]: 'deck_repo_w1',
        [IMCODES_DAEMON_PROJECT_NAME_ENV]: 'repo',
        [IMCODES_DAEMON_PROJECT_ROOT_ENV]: '/tmp/project',
        [IMCODES_DAEMON_SERVER_ID_ENV]: 'srv-bound',
      },
    });
    expect(JSON.parse(mcpServer.env[IMCODES_DAEMON_NAMESPACE_ENV])).toEqual({
      scope: 'user_private',
      userId: 'user-secret-ish',
      projectId: 'github.com/acme/project',
    });
  });

  it('re-sends Memory MCP identity config when resuming an existing Codex thread', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({
      sessionKey: 'route-mcp-resume',
      resumeId: 'thread-existing',
      sessionName: 'deck_repo_w2',
      projectName: 'repo',
      serverId: 'srv-bound',
      cwd: '/tmp/project',
      contextNamespace: {
        scope: 'user_private',
        userId: 'user-secret-ish',
        projectId: 'github.com/acme/project',
      },
    });

    await provider.send('route-mcp-resume', 'hello');
    const child = childProcessMock.children[0];
    const threadResumeReq = child.requests.find((req) => req.method === 'thread/resume');
    const config = threadResumeReq?.params?.config as Record<string, any> | undefined;
    const mcpServer = config?.mcp_servers?.[IMCODES_MEMORY_MCP_SERVER_NAME];

    expect(mcpServer?.env).toMatchObject({
      [IMCODES_DAEMON_USER_ID_ENV]: 'user-secret-ish',
      [IMCODES_DAEMON_SESSION_NAME_ENV]: 'deck_repo_w2',
      [IMCODES_DAEMON_PROJECT_NAME_ENV]: 'repo',
      [IMCODES_DAEMON_SERVER_ID_ENV]: 'srv-bound',
    });
  });

  it('emits thinking status from reasoning items and clears it on streamed assistant text', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-status', cwd: '/tmp/project' });

    const statuses: Array<{ status: string | null; label?: string | null }> = [];
    provider.onStatus?.((_sid, status) => statuses.push(status));

    await provider.send('route-status', 'hello');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'reason-1', type: 'reasoning', text: 'Planning next step' } },
    });
    child.emits({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'O' } });
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await flush();

    expect(statuses).toEqual([
      { status: 'thinking', label: 'Thinking...' },
      { status: null, label: null },
    ]);
  });

  it('heartbeats active turns with thread/read, classifies active/degraded without using turn/interrupt, and never polls idle sessions', async () => {
    vi.useFakeTimers();
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-heartbeat-active', cwd: '/tmp/project' });
    await provider.createSession({ sessionKey: 'route-heartbeat-idle', cwd: '/tmp/project' });

    const errors: Array<{ code: string; details?: unknown }> = [];
    provider.onError((_sid, error) => errors.push({ code: error.code, details: error.details }));

    await provider.send('route-heartbeat-active', 'hello');
    const child = childProcessMock.children[0];
    childProcessMock.enqueueThreadReadResult({
      thread: { id: 'thread-1', status: { type: 'active' } },
      turns: [{ id: 'turn-1', status: 'inProgress', current: true }],
    });

    await vi.advanceTimersByTimeAsync(55_100);
    await vi.advanceTimersByTimeAsync(0);

    expect(child.requests.filter((req) => req.method === 'thread/read')).toHaveLength(1);
    expect(child.requests.some((req) => req.method === 'turn/interrupt')).toBe(false);
    expect(errors).toEqual([]);
    const activeDiagnostics = provider.getSessionDiagnostics('route-heartbeat-active')!;
    expect(activeDiagnostics.lastHeartbeatAttemptAtMs).toEqual(expect.any(Number));
    expect(activeDiagnostics.lastHeartbeatResponseAtMs).toEqual(expect.any(Number));
    expect(activeDiagnostics.lastAliveHeartbeatAtMs).toBe(activeDiagnostics.lastHeartbeatResponseAtMs);

    // Timeout-only/degraded evidence is never sdk_turn_lost and still does not
    // use the destructive interrupt RPC as a liveness probe.
    await vi.advanceTimersByTimeAsync(30_500);
    await vi.advanceTimersByTimeAsync(0);
    expect(child.requests.filter((req) => req.method === 'thread/read').length).toBeGreaterThanOrEqual(2);
    expect(child.requests.some((req) => req.method === 'turn/interrupt')).toBe(false);
    expect(errors.some((entry) => (entry.details as any)?.reason === 'sdk_turn_lost')).toBe(false);
    const timeoutDiagnostics = provider.getSessionDiagnostics('route-heartbeat-active')!;
    expect(timeoutDiagnostics.lastHeartbeatAttemptAtMs as number).toBeGreaterThan(activeDiagnostics.lastHeartbeatAttemptAtMs as number);
    expect(timeoutDiagnostics.lastHeartbeatResponseAtMs).toBe(activeDiagnostics.lastHeartbeatResponseAtMs);
    expect(timeoutDiagnostics.lastAliveHeartbeatAtMs).toBe(activeDiagnostics.lastAliveHeartbeatAtMs);
    await provider.disconnect();
  }, 60_000);

  it('enforces provider-wide heartbeat cap and releases capacity exactly once when an in-flight lease is cleared', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    let provider: CodexSdkProvider | undefined;
    try {
      provider = new CodexSdkProvider();
      await provider.connect({ binaryPath: 'codex' });
      for (const sessionKey of ['route-heartbeat-cap-1', 'route-heartbeat-cap-2', 'route-heartbeat-cap-3']) {
        await provider.createSession({ sessionKey, cwd: '/tmp/project' });
        await provider.send(sessionKey, `hello ${sessionKey}`);
      }
      const child = childProcessMock.children[0];

      await vi.advanceTimersByTimeAsync(50_100);
      await vi.advanceTimersByTimeAsync(0);

      let reads = child.requests.filter((req) => req.method === 'thread/read');
      expect(reads).toHaveLength(2);
      expect(provider.getSessionDiagnostics('route-heartbeat-cap-1')).toMatchObject({ heartbeatInFlight: true });
      expect(provider.getSessionDiagnostics('route-heartbeat-cap-2')).toMatchObject({ heartbeatInFlight: true });
      expect(provider.getSessionDiagnostics('route-heartbeat-cap-3')).toMatchObject({ heartbeatInFlight: false });

      await provider.cancel('route-heartbeat-cap-1');
      child.emits({
        id: reads[0]!.id,
        result: {
          thread: { id: 'thread-1', status: { type: 'active' } },
          turns: [{ id: 'turn-1', status: 'inProgress', current: true }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      // The capped third lease was rescheduled instead of spinning at 0ms.
      // Once in-flight requests settle, exactly one new heartbeat can enter.
      await vi.advanceTimersByTimeAsync(20_100);
      await vi.advanceTimersByTimeAsync(0);
      reads = child.requests.filter((req) => req.method === 'thread/read');
      expect(reads).toHaveLength(3);
      expect(provider.getSessionDiagnostics('route-heartbeat-cap-2')).toMatchObject({ heartbeatInFlight: false });
      expect(provider.getSessionDiagnostics('route-heartbeat-cap-3')).toMatchObject({ heartbeatInFlight: true });

      child.emits({
        id: reads[2]!.id,
        result: {
          thread: { id: 'thread-1', status: { type: 'active' } },
          turns: [{ id: 'turn-1', status: 'inProgress', current: true }],
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.getSessionDiagnostics('route-heartbeat-cap-2')).toMatchObject({ heartbeatInFlight: false });
      expect(provider.getSessionDiagnostics('route-heartbeat-cap-3')).toMatchObject({ heartbeatInFlight: false });
    } finally {
      await provider?.disconnect().catch(() => {});
      randomSpy.mockRestore();
    }
  }, 60_000);

  it('normalizes heartbeat status aliases and treats malformed/ambiguous/unknown summaries as inconclusive', async () => {
    vi.useFakeTimers();
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-heartbeat-aliases', cwd: '/tmp/project' });

    const errors: Array<{ message: string; details?: unknown }> = [];
    provider.onError((_sid, error) => errors.push({ message: error.message, details: error.details }));

    await provider.send('route-heartbeat-aliases', 'hello');
    const child = childProcessMock.children[0];
    childProcessMock.enqueueThreadReadResult({
      thread_status: { state: 'running' },
      turns: [{ id: 'turn-1', status: 'in_progress', current: true }],
    });
    await vi.advanceTimersByTimeAsync(55_100);
    await vi.advanceTimersByTimeAsync(0);
    const aliveAfterActive = provider.getSessionDiagnostics('route-heartbeat-aliases')?.lastAliveHeartbeatAtMs;
    const responseAfterActive = provider.getSessionDiagnostics('route-heartbeat-aliases')?.lastHeartbeatResponseAtMs;
    expect(aliveAfterActive).toEqual(expect.any(Number));
    expect(responseAfterActive).toBe(aliveAfterActive);

    childProcessMock.enqueueThreadReadResult(() => {
      vi.setSystemTime(Date.now() + 1);
      return { thread: { status: 'idle' } };
    });
    await vi.advanceTimersByTimeAsync(25_100);
    await vi.advanceTimersByTimeAsync(0);
    const afterMalformed = provider.getSessionDiagnostics('route-heartbeat-aliases')!;
    expect(afterMalformed.lastHeartbeatResponseAtMs as number).toBeGreaterThan(responseAfterActive as number);
    expect(afterMalformed.lastAliveHeartbeatAtMs).toBe(aliveAfterActive);

    childProcessMock.enqueueThreadReadResult(() => {
      vi.setSystemTime(Date.now() + 1);
      return {
        status: 'idle',
        turns: [
          { id: 'turn-a', status: 'inProgress', current: true },
          { id: 'turn-b', status: 'inProgress', current: true },
        ],
      };
    });
    await vi.advanceTimersByTimeAsync(25_100);
    await vi.advanceTimersByTimeAsync(0);
    const afterAmbiguous = provider.getSessionDiagnostics('route-heartbeat-aliases')!;
    expect(afterAmbiguous.lastHeartbeatResponseAtMs as number).toBeGreaterThan(afterMalformed.lastHeartbeatResponseAtMs as number);
    expect(afterAmbiguous.lastAliveHeartbeatAtMs).toBe(aliveAfterActive);

    childProcessMock.enqueueThreadReadResult(() => {
      vi.setSystemTime(Date.now() + 1);
      return { status: 'mystery', turns: [{ id: 'turn-1', status: 'weird' }] };
    });
    await vi.advanceTimersByTimeAsync(25_100);
    await vi.advanceTimersByTimeAsync(0);
    const afterUnknown = provider.getSessionDiagnostics('route-heartbeat-aliases')!;
    expect(afterUnknown.lastHeartbeatResponseAtMs as number).toBeGreaterThan(afterAmbiguous.lastHeartbeatResponseAtMs as number);
    expect(afterUnknown.lastAliveHeartbeatAtMs).toBe(aliveAfterActive);

    expect(child.requests.filter((req) => req.method === 'thread/read').length).toBeGreaterThanOrEqual(4);
    expect(errors.some((entry) => (entry.details as any)?.reason === 'sdk_turn_lost')).toBe(false);
    await provider.disconnect();
  });

  it('emits privacy-bounded sdk_turn_lost for deterministic idle-missing-turn and notLoaded summaries', async () => {
    vi.useFakeTimers();
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });

    const errors: Array<{ sid: string; details?: any; message: string; recoverable: boolean }> = [];
    provider.onError((sid, error) => errors.push({
      sid,
      details: error.details,
      message: error.message,
      recoverable: error.recoverable,
    }));

    await provider.createSession({ sessionKey: 'route-heartbeat-lost', sessionName: 'deck_repo_w1', cwd: '/tmp/project' });
    await provider.send('route-heartbeat-lost', 'secret user prompt');
    const child = childProcessMock.children[0];
    childProcessMock.enqueueThreadReadResult({
      thread: { id: 'thread-1', status: 'idle' },
      turns: [{ id: 'other-turn', status: 'completed' }],
      prompt: 'must-not-leak',
    });
    await vi.advanceTimersByTimeAsync(55_100);
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ sid: 'route-heartbeat-lost', recoverable: true });
    expect(errors[0]!.details).toMatchObject({
      reason: 'sdk_turn_lost',
      localSessionKey: 'route-heartbeat-lost',
      sessionName: 'deck_repo_w1',
      providerId: 'codex-sdk',
      codexThreadId: 'thread-1',
      codexTurnId: 'turn-1',
      classifier: 'idle_missing_turn',
      replayDecision: 'pending',
    });
    expect(JSON.stringify(errors[0]!.details)).not.toContain('secret user prompt');
    expect(JSON.stringify(errors[0]!.details)).not.toContain('must-not-leak');
    expect(provider.getSessionDiagnostics('route-heartbeat-lost')).toMatchObject({
      heartbeatLeaseActive: false,
      lastAliveHeartbeatAtMs: null,
    });

    await provider.disconnect();

    const provider2 = new CodexSdkProvider();
    provider2.onError((sid, error) => errors.push({
      sid,
      details: error.details,
      message: error.message,
      recoverable: error.recoverable,
    }));
    await provider2.connect({ binaryPath: 'codex' });
    await provider2.createSession({ sessionKey: 'route-heartbeat-notloaded', cwd: '/tmp/project' });
    await provider2.send('route-heartbeat-notloaded', 'hello again');
    childProcessMock.enqueueThreadReadResult({
      thread: { id: 'thread-1', status: 'notLoaded' },
      turns: [{ id: 'turn-1', status: 'inProgress', current: true }],
    });
    await vi.advanceTimersByTimeAsync(55_100);
    await vi.advanceTimersByTimeAsync(0);

    expect(errors.at(-1)?.details).toMatchObject({
      reason: 'sdk_turn_lost',
      classifier: 'not_loaded_with_active_lease',
    });
    await provider2.disconnect();
  });

  it('makes completed/failed/interrupted local truth deactivate the lease and ignores late strong-looking events', async () => {
    vi.useFakeTimers();
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-heartbeat-terminal', cwd: '/tmp/project' });

    const errors: string[] = [];
    provider.onError((_sid, error) => errors.push(error.message));

    await provider.send('route-heartbeat-terminal', 'hello');
    const child = childProcessMock.children[0];
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await vi.advanceTimersByTimeAsync(0);

    child.emits({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'late-msg', delta: 'late' } });
    child.emits({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'late-reason', type: 'reasoning' } } });
    child.emits({ method: 'turn/plan/updated', params: { threadId: 'thread-1', turnId: 'turn-1', plan: [{ step: 'late', status: 'pending' }] } });
    child.emits({ method: 'thread/status/changed', params: { threadId: 'thread-1', turnId: 'turn-1', status: 'active' } });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(child.requests.some((req) => req.method === 'thread/read')).toBe(false);
    expect(errors.some((message) => message.includes('lost'))).toBe(false);
    expect(provider.getSessionDiagnostics('route-heartbeat-terminal')).toMatchObject({
      runningTurnId: null,
      heartbeatLeaseActive: false,
      lastAliveHeartbeatAtMs: null,
    });
  });

  it('does not let weak token-usage activity reset strong heartbeat grace indefinitely', async () => {
    vi.useFakeTimers();
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-heartbeat-weak', cwd: '/tmp/project' });

    await provider.send('route-heartbeat-weak', 'hello');
    const child = childProcessMock.children[0];
    await vi.advanceTimersByTimeAsync(40_000);
    child.emits({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0 } },
      },
    });
    childProcessMock.enqueueThreadReadResult({
      thread: { id: 'thread-1', status: 'active' },
      turns: [{ id: 'turn-1', status: 'inProgress', current: true }],
    });

    await vi.advanceTimersByTimeAsync(15_100);
    await vi.advanceTimersByTimeAsync(0);

    expect(child.requests.some((req) => req.method === 'thread/read')).toBe(true);
  });

  it('uses heartbeat before idle-settle so idle missing-current-turn is not masked as normal completion', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-heartbeat-idle-lost', cwd: '/tmp/project' });

    const completes: string[] = [];
    const errors: any[] = [];
    provider.onComplete((_sid, message) => completes.push(message.content));
    provider.onError((_sid, error) => errors.push(error));

    await provider.send('route-heartbeat-idle-lost', 'hello');
    const child = childProcessMock.children[0];
    childProcessMock.enqueueThreadReadResult({
      thread: { id: 'thread-1', status: 'idle' },
      turns: [{ id: 'different-turn', status: 'completed' }],
    });
    child.emits({ method: 'thread/status/changed', params: { threadId: 'thread-1', status: 'idle' } });
    await flush();

    expect(completes).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].details).toMatchObject({
      reason: 'sdk_turn_lost',
      classifier: 'idle_missing_turn',
    });
  });

  it('cleans heartbeat/tool/compact evidence on disconnect and keeps child/compact scopes isolated from ordinary lost-turn recovery', async () => {
    vi.useFakeTimers();
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-heartbeat-disconnect', cwd: '/tmp/project' });

    const errors: any[] = [];
    provider.onError((_sid, error) => errors.push(error));

    await provider.send('route-heartbeat-disconnect', 'run a tool');
    const child = childProcessMock.children[0];
    child.emits({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'cmd-1', type: 'commandExecution', command: 'sleep 10' } },
    });
    expect(provider.getActiveWorkSnapshot('route-heartbeat-disconnect')?.busyReasons).toContain('provider_tool_item');

    await provider.disconnect();
    expect(provider.getActiveWorkSnapshot('route-heartbeat-disconnect')).toBeNull();

    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-heartbeat-compact', cwd: '/tmp/project' });
    await provider.send('route-heartbeat-compact', '/compact');
    child.emits({ method: 'thread/status/changed', params: { threadId: 'unowned-child-thread', status: 'notLoaded' } });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(errors.some((error) => error.details?.reason === 'sdk_turn_lost')).toBe(false);
  });
});
