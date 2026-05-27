import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';
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

describe('CodexSdkProvider', () => {
  beforeEach(() => {
    vi.useRealTimers();
    childProcessMock.spawn.mockClear();
    childProcessMock.execFile.mockClear();
    childProcessMock.children.length = 0;
    childProcessMock.setHoldThreadStart(false);
    childProcessMock.setHoldTurnStart(false);
    childProcessMock.setHoldTurnInterrupt(false);
    childProcessMock.releaseHeldThreadStarts();
    childProcessMock.releaseHeldTurnStarts();
    childProcessMock.releaseHeldTurnInterrupts();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
    provider.onError((_sid, error) => errors.push({
      code: error.code,
      recoverable: error.recoverable,
      message: error.message,
    }));

    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-1', cwd: '/tmp/project' });
    await provider.send('route-1', 'hello');
    const firstChild = childProcessMock.children[0]!;

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
    expect(childProcessMock.children).toHaveLength(2);
    expect(firstChild.child.killed).toBe(true);
    await provider.disconnect();
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
});
