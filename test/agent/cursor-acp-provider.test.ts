import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CursorAcpProvider,
  cursorAcpRuntimeHooks,
  normalizeCursorAcpUsage,
} from '../../src/agent/providers/cursor-acp.js';
import { getCursorRuntimeConfig, __cursorRuntimeConfigInternals } from '../../src/agent/cursor-runtime-config.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import type { ProviderContextPayload } from '../../shared/context-types.js';
import {
  IMCODES_DAEMON_NAMESPACE_ENV,
  IMCODES_DAEMON_PROJECT_NAME_ENV,
  IMCODES_DAEMON_PROJECT_ROOT_ENV,
  IMCODES_DAEMON_SERVER_ID_ENV,
  IMCODES_DAEMON_SESSION_NAME_ENV,
  IMCODES_DAEMON_USER_ID_ENV,
} from '../../shared/memory-mcp-env.js';
import { MEMORY_MCP_STATUS } from '../../shared/memory-ws.js';

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) },
}));

vi.mock('../../src/agent/cursor-runtime-config.js', () => ({
  getCursorRuntimeConfig: vi.fn(async () => ({
    availableModels: ['auto', 'composer-2.5'],
    defaultModel: 'auto',
    isAuthenticated: true,
  })),
  __cursorRuntimeConfigInternals: {
    clearCache: vi.fn(),
  },
}));

interface FakeAcpRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

class FakeAcpServerProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: FakeAcpRpcRequest[] = [];
  readonly responses: FakeAcpRpcRequest[] = [];
  readonly stdin: Writable;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 424242;
  holdExit = false;

  private buf = '';

  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    this.signalCode = signal ?? 'SIGTERM';
    if (this.holdExit) {
      return true;
    }
    this.exitCode = 0;
    queueMicrotask(() => {
      this.emit('exit', 0, signal ?? 'SIGTERM');
      this.emit('close', 0, signal ?? 'SIGTERM');
    });
    return true;
  });

  releaseExit(code = 0, signal: NodeJS.Signals | null = 'SIGKILL'): void {
    this.holdExit = false;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  constructor(
    private readonly onRequest: (req: FakeAcpRpcRequest, proc: FakeAcpServerProcess) => void,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        this.buf += chunk.toString();
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) !== -1) {
          const rawLine = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!rawLine) continue;
          const parsed = JSON.parse(rawLine) as FakeAcpRpcRequest;
          if (parsed.method) {
            this.requests.push(parsed);
            this.onRequest(parsed, this);
          } else {
            this.responses.push(parsed);
          }
        }
        cb();
      },
    });
  }

  sendJson(payload: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
  }

  reply(id: string | number, result: unknown): void {
    this.sendJson({ id, result });
  }

  replyError(id: string | number, code: number, message: string, data?: Record<string, unknown>): void {
    this.sendJson({ id, error: { code, message, ...(data ? { data } : {}) } });
  }

  notifySessionUpdate(sessionId: string, update: Record<string, unknown>): void {
    this.sendJson({
      method: 'session/update',
      params: { sessionId, update },
    });
  }

  requestPermission(
    id: string | number,
    sessionId: string,
    toolCall: { toolCallId: string; title: string; rawInput?: unknown },
    options: Array<{ optionId: string; name: string; kind: string }> = [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
  ): void {
    this.sendJson({
      id,
      method: 'session/request_permission',
      params: { sessionId, toolCall, options },
    });
  }
}

function makePayload(userMessage: string, extra: Partial<ProviderContextPayload> = {}): ProviderContextPayload {
  return {
    userMessage,
    assembledMessage: extra.assembledMessage ?? userMessage,
    sessionSystemText: extra.sessionSystemText,
    turnSystemText: extra.turnSystemText,
    systemText: extra.systemText,
    messagePreamble: extra.messagePreamble,
    attachments: extra.attachments,
    context: extra.context ?? {
      requiredAuthoredContext: [],
      advisoryAuthoredContext: [],
      appliedDocumentVersionIds: [],
      diagnostics: [],
    },
    authority: extra.authority ?? {
      namespace: { scope: 'personal', projectId: 'proj-1' },
      authoritySource: 'none',
      freshness: 'missing',
      fallbackAllowed: true,
      retryScheduled: false,
      diagnostics: [],
    },
    supportClass: 'degraded-message-side-context-mapping',
    diagnostics: [],
  };
}

describe('CursorAcpProvider', () => {
  const originalLoadChildProcess = cursorAcpRuntimeHooks.loadChildProcess;
  let tempDirs: string[] = [];
  let spawnedProcesses: FakeAcpServerProcess[] = [];
  let spawnMock: ReturnType<typeof vi.fn>;
  let execFileMock: ReturnType<typeof vi.fn>;

  function installHarness(
    handler: (req: FakeAcpRpcRequest, proc: FakeAcpServerProcess, index: number) => void,
    options: {
      spawnError?: Error;
      holdExit?: boolean;
      onExecFile?: (exec: string, args: string[], cb?: (err: Error | null, stdout: string, stderr: string) => void) => void;
    } = {},
  ): void {
    spawnMock = vi.fn((_file: string, _args: string[]) => {
      const idx = spawnedProcesses.length;
      const proc = new FakeAcpServerProcess((req, p) => handler(req, p, idx));
      if (options.holdExit) proc.holdExit = true;
      spawnedProcesses.push(proc);
      queueMicrotask(() => {
        if (options.spawnError) {
          proc.emit('error', options.spawnError);
        } else {
          proc.emit('spawn');
        }
      });
      return proc as unknown as ReturnType<typeof import('node:child_process').spawn>;
    });
    execFileMock = vi.fn((file: string, args: string[], _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (options.onExecFile) {
        options.onExecFile(file, args, cb);
      } else {
        cb?.(null, '2026.06.15-03-48-54-da23e37\n', '');
      }
      return { stdin: { end: vi.fn() } } as never;
    });
    cursorAcpRuntimeHooks.loadChildProcess = async () => ({
      spawn: spawnMock,
      execFile: execFileMock,
    } as unknown as typeof import('node:child_process'));
  }

  beforeEach(() => {
    spawnedProcesses = [];
    vi.clearAllMocks();
    (__cursorRuntimeConfigInternals.clearCache as ReturnType<typeof vi.fn>)();
    resetTransportQueueStoreForTests();
  });

  afterEach(() => {
    cursorAcpRuntimeHooks.loadChildProcess = originalLoadChildProcess;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it('handshakes initialize capabilities matching live agent acp, writes custom mcp config, and handles cursor_login auth errors cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-acp-mcp-'));
    tempDirs.push(dir);
    const mcpPath = join(dir, 'mcp.json');

    let requiresAuth = true;
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: true, sse: true },
            promptCapabilities: { audio: false, embeddedContext: false, image: true },
            sessionCapabilities: { list: {} },
          },
          authMethods: [{
            id: 'cursor_login',
            name: 'Cursor Login',
            description: "Authenticate using existing Cursor login credentials. Run 'agent login' first if not logged in.",
          }],
        });
      } else if (req.method === 'authenticate') {
        requiresAuth = false;
        proc.reply(req.id!, {});
      } else if (req.method === 'session/new') {
        if (requiresAuth) {
          proc.replyError(req.id!, -32000, 'Authentication required', {
            message: "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.",
          });
          return;
        }
        proc.reply(req.id!, { sessionId: 'acp-sess-1' });
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent', cursorMcpConfigPath: mcpPath });

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['acp']);
    expect(JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers['imcodes-memory']).toBeTruthy();
    expect(provider.getMemoryMcpStatus()).toMatchObject({
      providerId: 'cursor-headless',
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
      degradedReasons: [],
    });

    const sid = await provider.createSession({ sessionKey: 'route-auth', cwd: dir });
    await expect(provider.send(sid, 'hello')).resolves.toBeUndefined();
    const authReq = spawnedProcesses[0]!.requests.find((r) => r.method === 'authenticate');
    expect(authReq?.params).toEqual({ methodId: 'cursor_login' });

    // Rejecting authenticate surfaces actionable AUTH_FAILED without hanging
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
          authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }],
        });
      } else if (req.method === 'authenticate') {
        proc.replyError(req.id!, -32000, 'Login required');
      } else if (req.method === 'session/new') {
        proc.replyError(req.id!, -32000, 'Authentication required');
      }
    });
    const unauthProvider = new CursorAcpProvider();
    await unauthProvider.connect({ binaryPath: 'cursor-agent' });
    const badSid = await unauthProvider.createSession({ sessionKey: 'route-unauth', cwd: dir });
    await expect(unauthProvider.send(badSid, 'hello')).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      message: expect.stringMatching(/agent login|CURSOR_API_KEY/i),
    });

    await provider.disconnect();
    await unauthProvider.disconnect();
  });

  it('keeps atomic context snapshots separate from cumulative PromptResponse.usage and clears stale cache across frames (P0-6)', async () => {
    let promptNum = 0;
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {} } },
        });
      } else if (req.method === 'session/new') {
        proc.reply(req.id!, {
          sessionId: 'acp-usage-1',
          models: {
            currentModelId: 'composer-2.5',
            availableModels: [
              { modelId: 'composer-2.5', name: 'Composer 2.5', limit: { context: 300_000 } },
            ],
          },
        });
      } else if (req.method === 'session/prompt') {
        promptNum += 1;
        // 1) Snapshot 1: used=45000, cached=43800, window=300000
        proc.notifySessionUpdate('acp-usage-1', {
          sessionUpdate: 'usage_update',
          used: 45_000,
          size: 300_000,
          tokens: { cachedInputTokens: 43_800, outputTokens: 50 },
        });
        // 2) Snapshot 2: used=47000 WITHOUT cache fields -> must NOT retain 43800 cache!
        proc.notifySessionUpdate('acp-usage-1', {
          sessionUpdate: 'usage_update',
          used: 47_000,
          size: 300_000,
        });
        // 3) Snapshot 3: window changes to 200000 and partial omit on 4th update keeps 200000
        proc.notifySessionUpdate('acp-usage-1', {
          sessionUpdate: 'usage_update',
          used: 48_000,
          size: 200_000,
        });
        proc.notifySessionUpdate('acp-usage-1', {
          sessionUpdate: 'usage_update',
          used: 49_000,
        });
        proc.notifySessionUpdate('acp-usage-1', {
          sessionUpdate: 'agent_message_chunk',
          messageId: `msg-usage-${promptNum}`,
          content: { type: 'text', text: 'Token check ok' },
        });
        setTimeout(() => {
          // 4) Terminal ACP PromptResponse.usage is CUMULATIVE across session turns (inputTokens=125000).
          //    It must NEVER overwrite current-context 49000 on onUsage OR metadata.usage!
          proc.reply(req.id!, {
            stopReason: 'end_turn',
            usage: { inputTokens: 125_000, outputTokens: 210, cachedReadTokens: 43_800, totalTokens: 125_210 },
          });
        }, 10);
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sid = await provider.createSession({ sessionKey: 'route-usage', cwd: '/tmp/proj', agentId: 'composer-2.5' });

    const usageEvents: Array<{ finalized?: boolean; model?: string; messageId?: string; usage?: Record<string, unknown> }> = [];
    const completed: Array<Record<string, unknown>> = [];
    provider.onUsage((_sid, u) => usageEvents.push({ finalized: u.finalized, model: u.model, messageId: u.messageId, usage: u.usage }));
    provider.onComplete((_sid, m) => completed.push(m as unknown as Record<string, unknown>));

    await provider.send(sid, 'check tokens');
    await vi.waitFor(() => {
      expect(completed).toHaveLength(1);
      expect(usageEvents).toHaveLength(5);
    });

    // Live event 0: 45k total (1200 + 43800 cached) in 300k window
    expect(usageEvents[0]?.usage).toEqual({
      input_tokens: 1_200,
      cached_input_tokens: 43_800,
      cache_read_input_tokens: 43_800,
      output_tokens: 50,
      model_context_window: 300_000,
    });
    // Live event 1: cache NOT supplied -> cache cleared completely (no 43800 + 47000 = 90800!)
    expect(usageEvents[1]?.usage).toEqual({
      input_tokens: 47_000,
      model_context_window: 300_000,
    });
    // Live event 2: window change reflected immediately (200k)
    expect(usageEvents[2]?.usage).toEqual({
      input_tokens: 48_000,
      model_context_window: 200_000,
    });
    // Live event 3: partial update omitting `size` retains latest verified 200k window
    expect(usageEvents[3]?.usage).toEqual({
      input_tokens: 49_000,
      model_context_window: 200_000,
    });
    // Finalized event & completed message metadata keep current occupancy 49000 (NEVER 125000 or 168800!)
    expect(usageEvents[4]).toMatchObject({
      finalized: true,
      messageId: 'msg-usage-1',
      model: 'composer-2.5',
      usage: {
        input_tokens: 49_000,
        model_context_window: 200_000,
      },
    });
    const metadata = completed[0]?.metadata as Record<string, unknown>;
    expect(metadata.usage).toEqual({
      input_tokens: 49_000,
      model_context_window: 200_000,
    });
    expect(metadata.cumulativeUsage).toEqual({
      inputTokens: 125_000,
      outputTokens: 210,
      cachedReadTokens: 43_800,
      totalTokens: 125_210,
    });

    expect(normalizeCursorAcpUsage({ used: 45_000, size: 200_000, cachedInputTokens: 43_800 })).toMatchObject({
      input_tokens: 1_200,
      cached_input_tokens: 43_800,
      model_context_window: 200_000,
    });

    await provider.disconnect();
  });

  it('enforces runtime /compact advertisement gate, translates advertised command, drives compaction end-to-end, and ignores late frames after finish/cancel (P0-7)', async () => {
    let advertiseCompact = false;
    let promptNum = 0;
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
        });
      } else if (req.method === 'session/new') {
        proc.reply(req.id!, { sessionId: 'acp-compact-1' });
        proc.notifySessionUpdate('acp-compact-1', {
          sessionUpdate: 'available_commands_update',
          availableCommands: advertiseCompact
            ? [{ name: 'compress', description: 'Compress conversation' }]
            : [{ name: 'copy-request-id', description: 'Copy last request ID' }],
        });
      } else if (req.method === 'session/prompt') {
        promptNum += 1;
        const idx = promptNum;
        if (idx === 1) {
          proc.notifySessionUpdate('acp-compact-1', {
            sessionUpdate: 'compaction_update',
            status: 'in_progress',
          });
          proc.notifySessionUpdate('acp-compact-1', {
            sessionUpdate: 'compaction_summary_chunk',
            content: { type: 'text', text: 'Internal summary' },
          });
          proc.notifySessionUpdate('acp-compact-1', {
            sessionUpdate: 'compaction_update',
            status: 'completed',
          });
          proc.notifySessionUpdate('acp-compact-1', {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg-c1',
            content: { type: 'text', text: 'Compacted cleanly' },
          });
          setTimeout(() => {
            proc.reply(req.id!, { stopReason: 'end_turn' });
            // Late compaction update arriving AFTER completion must be ignored!
            setTimeout(() => {
              proc.notifySessionUpdate('acp-compact-1', {
                sessionUpdate: 'compaction_update',
                status: 'in_progress',
              });
            }, 5);
          }, 10);
        } else {
          proc.notifySessionUpdate('acp-compact-1', {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Reply ${idx}` },
          });
          setTimeout(() => proc.reply(req.id!, { stopReason: 'end_turn' }), 10);
        }
      }
    });

    // 1) Unadvertised (matching real Cursor 2026.06.15): runtime.send('/compact') MUST reject cleanly
    const negProvider = new CursorAcpProvider();
    await negProvider.connect({ binaryPath: 'cursor-agent' });
    const negRuntime = new TransportSessionRuntime(negProvider, 'deck_neg_compact');
    await negRuntime.initialize({
      sessionKey: 'route-neg-compact',
      cwd: '/tmp/proj',
      identityPrompt: 'CONTRACT ALPHA',
    });
    // Trigger initial turn so available_commands_update from session/new settles
    const completionsNeg: number[] = [];
    negProvider.onComplete(() => completionsNeg.push(1));
    negRuntime.send('init turn');
    await vi.waitFor(() => expect(completionsNeg).toHaveLength(1));
    expect(() => negRuntime.send('/compact')).toThrow(/not advertised|support \/compact/i);
    await negProvider.disconnect();

    // 2) Advertised `/compress`: runtime.send('/compact') reaches Cursor as `/compress` & reinjects contract post-compaction
    advertiseCompact = true;
    const posProvider = new CursorAcpProvider();
    await posProvider.connect({ binaryPath: 'cursor-agent' });
    const statuses: Array<string | null> = [];
    const completionsPos: number[] = [];
    posProvider.onStatus((_sid, s) => statuses.push(s.status));
    posProvider.onComplete(() => completionsPos.push(1));

    const posRuntime = new TransportSessionRuntime(posProvider, 'deck_pos_compact');
    await posRuntime.initialize({
      sessionKey: 'route-pos-compact',
      cwd: '/tmp/proj',
      identityPrompt: 'IDENTITY CONTRACT',
    });
    promptNum = 0;

    // Warm turn 1 so session/new runs and available_commands_update advertises /compress cleanly
    expect(posRuntime.send('warm turn')).toBe('sent');
    await vi.waitFor(() => expect(completionsPos).toHaveLength(1));

    // Turn 2 sends /compact through real TransportSessionRuntime -> translated to advertised /compress!
    expect(posRuntime.send('/compact')).toBe('sent');
    await vi.waitFor(() => {
      expect(completionsPos).toHaveLength(2);
    });
    await new Promise((r) => setTimeout(r, 30)); // allow late compaction_update to arrive & be rejected

    const proc = spawnedProcesses[1]!;
    const compactPrompt = proc.requests.filter((r) => r.method === 'session/prompt')[1]!;
    expect((compactPrompt.params?.prompt as Array<{ text: string }>)[0]?.text).toBe('/compress');
    expect(statuses).toContain('compacting');
    expect(statuses.at(-1)).toBeNull();
    expect(posProvider.getSessionDiagnostics('route-pos-compact')?.compacting).toBe(false);

    // Because turn 2 compacted, turn 3 through TransportSessionRuntime MUST re-inject identityPrompt!
    expect(posRuntime.send('after compact')).toBe('sent');
    await vi.waitFor(() => expect(completionsPos).toHaveLength(3));
    const postCompactPrompt = proc.requests.filter((r) => r.method === 'session/prompt')[2]!;
    expect(JSON.stringify(postCompactPrompt.params?.prompt)).toContain('IDENTITY CONTRACT');

    await posProvider.disconnect();
  });

  it('refuses fake stop proof before physical child exit on TransportSessionRuntime Stop-and-send, and reclaims dead-pipe siblings (P0-1)', async () => {
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/new') {
        proc.reply(req.id!, { sessionId: `acp-p1-${proc.requests.filter((r) => r.method === 'session/new').length}` });
      } else if (req.method === 'session/cancel') {
        // Deliberately ignore session/cancel!
      }
    }, { holdExit: true });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const runtime = new TransportSessionRuntime(provider, 'deck_stop_proof');
    await runtime.initialize({ sessionKey: 'route-stop-proof', cwd: '/tmp/proj' });

    expect(runtime.send('turn 1 will wedge')).toBe('sent');
    await vi.waitFor(() => {
      expect(spawnedProcesses[0]!.requests.some((r) => r.method === 'session/prompt')).toBe(true);
    });

    // Queue turn 2 while turn 1 is wedged
    expect(runtime.send('turn 2 queued', 'msg-2')).toBe('queued');

    // Stop-and-send triggers cancelAndWait -> child ignores cancel AND refuses to exit (`holdExit=true`).
    // TransportSessionRuntime MUST reject with timeout instead of releasing turn 2 onto a live wedged child!
    await expect(runtime.stopAndSendPendingMessages(['msg-2'], 'notif-1')).rejects.toThrow(/timed out/i);
    expect(spawnedProcesses[0]!.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(1);
    expect(spawnedProcesses[0]!.kill).toHaveBeenCalled();

    // Also test sibling CONNECTION_LOST reclaim when ACP write/stream breaks while child is alive
    spawnedProcesses[0]!.releaseExit(0, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 30));

    let secondNewCount = 0;
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/new') {
        secondNewCount += 1;
        proc.reply(req.id!, { sessionId: `acp-pipe-${secondNewCount}` });
      }
    });

    const pipeProvider = new CursorAcpProvider();
    await pipeProvider.connect({ binaryPath: 'cursor-agent' });
    const a = await pipeProvider.createSession({ sessionKey: 'pipe-a', cwd: '/tmp/proj' });
    const b = await pipeProvider.createSession({ sessionKey: 'pipe-b', cwd: '/tmp/proj' });
    const errsA: Array<{ code: string }> = [];
    const errsB: Array<{ code: string }> = [];
    pipeProvider.onError((sid, err) => {
      if (sid === a) errsA.push({ code: err.code });
      if (sid === b) errsB.push({ code: err.code });
    });

    await pipeProvider.send(a, 'start a');
    await pipeProvider.send(b, 'start b');
    const pipeProc = spawnedProcesses.at(-1)!;
    await vi.waitFor(() => {
      expect(pipeProc.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(2);
    });
    // Break the ACP stream while both sibling turns are active on the same live child
    pipeProc.stdout.destroy(new Error('Broken pipe'));

    await vi.waitFor(() => {
      expect(errsA.some((e) => e.code === 'CONNECTION_LOST')).toBe(true);
      expect(errsB.some((e) => e.code === 'CONNECTION_LOST')).toBe(true);
      expect(pipeProc.kill).toHaveBeenCalled();
    });

    await pipeProvider.disconnect();
  }, 15_000);

  it('fences handshake publication across concurrent reconnects, disconnect during init, and stale old-child updates (P0-2)', async () => {
    // 1) Concurrent sends after child crash must spawn ONLY ONE replacement child
    let holdSecondInit = true;
    let releaseInit!: () => void;
    let initReq2: FakeAcpRpcRequest | undefined;
    let newCounter = 0;

    installHarness((req, proc, index) => {
      if (req.method === 'initialize') {
        if (index === 1 && holdSecondInit) {
          initReq2 = req;
          releaseInit = () => {
            holdSecondInit = false;
            proc.reply(initReq2!.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
          };
          return;
        }
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/new') {
        newCounter += 1;
        proc.reply(req.id!, { sessionId: `acp-fence-${newCounter}` });
      } else if (req.method === 'session/load') {
        proc.reply(req.id!, {});
      } else if (req.method === 'session/prompt') {
        const sid = String(req.params?.sessionId);
        proc.notifySessionUpdate(sid, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `OK:${sid}` },
        });
        setTimeout(() => proc.reply(req.id!, { stopReason: 'end_turn' }), 5);
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const s1 = await provider.createSession({ sessionKey: 'fence-1', cwd: '/tmp/proj' });
    const s2 = await provider.createSession({ sessionKey: 'fence-2', cwd: '/tmp/proj' });

    const deltas: Array<{ sid: string; text: string }> = [];
    provider.onDelta((sid, d) => deltas.push({ sid, text: d.delta }));

    await provider.send(s1, 'warm 1');
    await vi.waitFor(() => expect(deltas.some((d) => d.sid === s1)).toBe(true));

    // Crash old child 0, then issue concurrent send(s1) + send(s2) while init on child 1 is delayed
    const oldProc = spawnedProcesses[0]!;
    oldProc.exitCode = 1;
    oldProc.emit('exit', 1, null);

    deltas.length = 0;
    const p1 = provider.send(s1, 'concurrent 1');
    const p2 = provider.send(s2, 'concurrent 2');

    await vi.waitFor(() => expect(initReq2).toBeDefined());
    // Old child emitting late update BEFORE/AFTER reconnect must be completely ignored!
    oldProc.notifySessionUpdate('acp-fence-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'STALE FROM DEAD CHILD' },
    });
    expect(spawnedProcesses).toHaveLength(2); // single respawn transaction!

    releaseInit();
    await Promise.all([p1, p2]);
    await vi.waitFor(() => {
      expect(deltas.some((d) => d.sid === s1 && d.text.startsWith('OK:'))).toBe(true);
      expect(deltas.some((d) => d.sid === s2 && d.text.startsWith('OK:'))).toBe(true);
    });
    expect(deltas.some((d) => d.text.includes('STALE FROM DEAD CHILD'))).toBe(false);

    // 2) disconnect() while delayed initialize is pending aborts handshake and kills spawned child
    let pendingDelayedInitReq: FakeAcpRpcRequest | undefined;
    installHarness((req) => {
      if (req.method === 'initialize') pendingDelayedInitReq = req;
    });
    const dcProvider = new CursorAcpProvider();
    const connectPromise = dcProvider.connect({ binaryPath: 'cursor-agent' });
    await vi.waitFor(() => expect(pendingDelayedInitReq).toBeDefined());
    await dcProvider.disconnect();
    await expect(connectPromise).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    expect(spawnedProcesses.at(-1)!.kill).toHaveBeenCalled();

    await provider.disconnect();
  });

  it('isolates model switch failures without overwriting confirmed model or contextWindow, and consumes config_option_update catalogs (P0-5)', async () => {
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/new') {
        proc.reply(req.id!, {
          sessionId: 'acp-model-iso',
          models: {
            currentModelId: 'composer-2.5',
            availableModels: [
              { modelId: 'composer-2.5', name: 'Composer 2.5', contextWindow: 256_000 },
              { modelId: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', contextWindow: 400_000 },
            ],
          },
        });
      } else if (req.method === 'session/set_model') {
        if (req.params?.modelId === 'bad-remote-model') {
          proc.replyError(req.id!, -32602, 'Model unavailable');
          return;
        }
        proc.reply(req.id!, {});
      } else if (req.method === 'session/prompt') {
        proc.notifySessionUpdate('acp-model-iso', {
          sessionUpdate: 'usage_update',
          used: 1_000,
        });
        setTimeout(() => proc.reply(req.id!, { stopReason: 'end_turn' }), 5);
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sid = await provider.createSession({ sessionKey: 'route-model-iso', cwd: '/tmp/proj' });

    const usages: Array<{ finalized?: boolean; model?: string; window?: number }> = [];
    provider.onUsage((_sid, u) => usages.push({ finalized: u.finalized, model: u.model, window: u.usage.model_context_window }));

    await provider.send(sid, 'turn 1');
    await vi.waitFor(() => expect(usages.filter((u) => u.finalized)).toHaveLength(1));
    expect(usages.filter((u) => u.finalized)[0]).toEqual({ finalized: true, model: 'composer-2.5', window: 256_000 });

    // Rejected switch MUST preserve confirmed composer-2.5 and 256_000 window
    await expect(provider.applySessionModel(sid, 'bad-remote-model')).rejects.toBeTruthy();
    expect(provider.getSessionDiagnostics(sid)?.model).toBe('composer-2.5');
    expect(provider.getSessionDiagnostics(sid)?.pendingModel).toBeNull();

    await provider.send(sid, 'turn 2 after failed switch');
    await vi.waitFor(() => expect(usages.filter((u) => u.finalized)).toHaveLength(2));
    expect(usages.filter((u) => u.finalized)[1]).toEqual({ finalized: true, model: 'composer-2.5', window: 256_000 });

    // config_option_update must populate new model catalog, window, and confirmed model
    spawnedProcesses[0]!.notifySessionUpdate('acp-model-iso', {
      sessionUpdate: 'config_option_update',
      configOptions: [{
        id: 'model',
        category: 'model',
        currentValue: 'sonnet-5',
        options: [
          { value: 'sonnet-5', name: 'Sonnet 5', contextWindow: 500_000 },
        ],
      }],
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(provider.getCachedModels()?.models).toEqual([{ id: 'sonnet-5', name: 'Sonnet 5' }]);

    await provider.send(sid, 'turn 3 on updated catalog model');
    await vi.waitFor(() => expect(usages.filter((u) => u.finalized)).toHaveLength(3));
    expect(usages.filter((u) => u.finalized)[2]).toEqual({ finalized: true, model: 'sonnet-5', window: 500_000 });

    await provider.disconnect();
  });

  it('preserves shared ACP child when ending one session during no-ACK session/close, respects close capability, and supports approvals/images/listSessions/crash recovery (P0-3/P0-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-acp-img-'));
    tempDirs.push(dir);
    const imgPath = join(dir, 'shot.png');
    writeFileSync(imgPath, Buffer.from([137, 80, 78, 71]));

    let newCount = 0;
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: true, sse: true },
            promptCapabilities: { image: true },
            sessionCapabilities: { list: {}, close: {} },
          },
        });
      } else if (req.method === 'session/new') {
        newCount += 1;
        proc.reply(req.id!, { sessionId: `acp-multi-${newCount}` });
      } else if (req.method === 'session/load') {
        if (req.params?.sessionId === 'acp-transient-fail') {
          proc.replyError(req.id!, -32603, 'Temporary disk read glitch');
          return;
        }
        if (req.params?.sessionId === 'acp-missing-id') {
          proc.replyError(req.id!, -32602, 'Conversation not found');
          return;
        }
        proc.notifySessionUpdate(String(req.params?.sessionId), {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'STALE REPLAY' },
        });
        proc.reply(req.id!, {});
      } else if (req.method === 'session/close') {
        // Deliberately NEVER reply to verify CLOSE_SESSION_TIMEOUT_MS bounded detach!
      } else if (req.method === 'session/list') {
        proc.reply(req.id!, {
          sessions: [{ sessionId: 'acp-listed-1', cwd: dir, title: 'Listed Cursor Session', updatedAt: '2026-11-28T00:00:00Z' }],
          nextCursor: null,
        });
      } else if (req.method === 'session/prompt') {
        const sid = String(req.params?.sessionId);
        if (sid === 'acp-resumed-existing') {
          proc.notifySessionUpdate(sid, {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg-r',
            content: { type: 'text', text: 'Fresh reply only' },
          });
          setTimeout(() => proc.reply(req.id!, { stopReason: 'end_turn' }), 5);
          return;
        }
        if (sid === 'acp-multi-1') {
          proc.requestPermission('perm-1', 'acp-multi-1', {
            toolCallId: 'tc-1',
            title: 'Run shell command',
            rawInput: { command: 'ls -la' },
          });
          proc.notifySessionUpdate('acp-multi-1', {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: 'shell',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { command: 'ls -la' },
          });
          proc.notifySessionUpdate('acp-multi-1', {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'file.ts' } }],
          });
          proc.notifySessionUpdate('acp-multi-1', {
            sessionUpdate: 'plan_update',
            plan: { type: 'items', entries: [{ content: 'Check tests', status: 'in_progress' }] },
          });
          proc.notifySessionUpdate('acp-multi-1', {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            content: { type: 'text', text: 'Answer S1' },
          });
        } else {
          proc.notifySessionUpdate(sid, {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm2',
            content: { type: 'text', text: 'Answer S2' },
          });
        }
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({
      binaryPath: 'cursor-agent',
      mcpServers: [
        { type: 'http', name: 'remote-http', url: 'https://mcp.example/http', headers: { Authorization: 'Bearer x' } },
        { type: 'sse', name: 'remote-sse', url: 'https://mcp.example/sse' },
      ],
    });

    const s1 = await provider.createSession({
      sessionKey: 'route-s1',
      sessionName: 'deck_proj_w1',
      projectName: 'proj',
      serverId: 'srv-1',
      cwd: dir,
      contextNamespace: { scope: 'user_private', userId: 'u1', projectId: 'p1' },
    });
    const s2 = await provider.createSession({ sessionKey: 'route-s2', cwd: dir });
    const sResumed = await provider.createSession({ sessionKey: 'route-resumed', cwd: dir, resumeId: 'acp-resumed-existing' });
    const sTransient = await provider.createSession({ sessionKey: 'route-transient', cwd: dir, resumeId: 'acp-transient-fail' });
    const sMissing = await provider.createSession({ sessionKey: 'route-missing', cwd: dir, resumeId: 'acp-missing-id' });

    // restoreSession distinguishes transient (-32603 throws, keeps ID) vs missing (-32602 returns false, keeps ID)
    await expect(provider.restoreSession(sTransient)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(provider.getSessionDiagnostics(sTransient)?.acpSessionId).toBe('acp-transient-fail');
    await expect(provider.restoreSession(sMissing)).resolves.toBe(false);
    expect(provider.getSessionDiagnostics(sMissing)?.acpSessionId).toBe('acp-missing-id');

    const deltasBySession = new Map<string, string[]>();
    const toolsBySession = new Map<string, Array<{ name: string; status: string; output?: string }>>();
    const approvals: Array<{ sid: string; id: string; tool?: string }> = [];
    provider.onDelta((sid, d) => {
      const list = deltasBySession.get(sid) ?? [];
      list.push(d.delta);
      deltasBySession.set(sid, list);
    });
    provider.onToolCall((sid, tc) => {
      const list = toolsBySession.get(sid) ?? [];
      list.push({ name: tc.name, status: tc.status, output: tc.output });
      toolsBySession.set(sid, list);
    });
    provider.onApprovalRequest((sid, req) => {
      approvals.push({ sid, id: req.id, tool: req.tool });
      void provider.respondApproval(sid, req.id, true);
    });

    await provider.send(s1, makePayload('inspect screenshot', {
      attachments: [{ id: 'a1', daemonPath: imgPath, originalName: 'shot.png', mime: 'image/png' }],
    }));
    await provider.send(s2, 'turn 2');
    await provider.send(sResumed, 'after resume');

    const proc = spawnedProcesses[0]!;
    await vi.waitFor(() => {
      expect(proc.requests.filter((x) => x.method === 'session/prompt')).toHaveLength(3);
      expect(approvals).toHaveLength(1);
    });
    for (const r of proc.requests.filter((x) => x.method === 'session/prompt' && x.params?.sessionId !== 'acp-resumed-existing')) {
      proc.reply(r.id!, { stopReason: 'end_turn' });
    }
    await vi.waitFor(() => {
      expect(deltasBySession.get(s1)).toEqual(['Answer S1']);
      expect(deltasBySession.get(s2)).toEqual(['Answer S2']);
      expect(deltasBySession.get(sResumed)).toEqual(['Fresh reply only']);
    });

    // Verify stdio + http + sse MCP passed on session/new & image sent
    const firstNew = proc.requests.find((r) => r.method === 'session/new');
    const mcpServers = firstNew?.params?.mcpServers as Array<Record<string, unknown>>;
    const memEntry = mcpServers.find((m) => m.name === 'imcodes-memory');
    const memEnv = Object.fromEntries((memEntry?.env as Array<{ name: string; value: string }>).map((e) => [e.name, e.value]));
    expect(memEnv).toMatchObject({
      [IMCODES_DAEMON_USER_ID_ENV]: 'u1',
      [IMCODES_DAEMON_SESSION_NAME_ENV]: 'deck_proj_w1',
      [IMCODES_DAEMON_PROJECT_NAME_ENV]: 'proj',
      [IMCODES_DAEMON_PROJECT_ROOT_ENV]: dir,
      [IMCODES_DAEMON_SERVER_ID_ENV]: 'srv-1',
    });
    expect(JSON.parse(memEnv[IMCODES_DAEMON_NAMESPACE_ENV]!)).toEqual({ scope: 'user_private', userId: 'u1', projectId: 'p1' });
    expect(mcpServers.some((m) => m.type === 'http' && m.name === 'remote-http')).toBe(true);
    expect(mcpServers.some((m) => m.type === 'sse' && m.name === 'remote-sse')).toBe(true);
    expect(toolsBySession.get(s1)?.some((t) => t.name === 'shell' && t.status === 'complete' && t.output === 'file.ts')).toBe(true);
    expect(toolsBySession.get(s1)?.some((t) => t.name === 'plan')).toBe(true);

    // Bounded no-ACK endSession(s1): completes in ~2s without killing shared child; s2 stays healthy!
    await provider.endSession(s1);
    expect(proc.requests.some((r) => r.method === 'session/close' && r.params?.sessionId === 'acp-multi-1')).toBe(true);
    expect(proc.kill).not.toHaveBeenCalled();

    const s2Done: number[] = [];
    provider.onComplete((sid) => { if (sid === s2) s2Done.push(1); });
    await provider.send(s2, 'turn after sibling ended');
    await vi.waitFor(() => {
      const reqs = proc.requests.filter((r) => r.method === 'session/prompt' && r.params?.sessionId === 'acp-multi-2');
      expect(reqs.length).toBeGreaterThanOrEqual(2);
    });
    proc.reply(proc.requests.filter((r) => r.method === 'session/prompt' && r.params?.sessionId === 'acp-multi-2').at(-1)!.id!, { stopReason: 'end_turn' });
    await vi.waitFor(() => expect(s2Done).toHaveLength(1));

    const listed = await provider.listSessions({ directory: dir });
    expect(listed).toEqual([{
      key: 'acp-listed-1',
      displayName: 'Listed Cursor Session',
      directory: dir,
      updatedAt: Date.parse('2026-11-28T00:00:00Z'),
    }]);

    await provider.disconnect();
  }, 10_000);

  it('handles ENOENT binary errors, filters unsupported HTTP/SSE/close capabilities, rejects display labels, and falls back listModels to CLI', async () => {
    const enoentErr = Object.assign(new Error('spawn /missing/agent ENOENT'), { code: 'ENOENT' });
    installHarness(() => {}, { spawnError: enoentErr });
    const missingProvider = new CursorAcpProvider();
    await expect(missingProvider.connect({ binaryPath: '/missing/agent' })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    });

    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            mcpCapabilities: { http: false, sse: false },
            promptCapabilities: { image: false },
          },
        });
      } else if (req.method === 'session/new') {
        proc.reply(req.id!, { sessionId: 'acp-boundary-1' });
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({
      binaryPath: 'cursor-agent',
      mcpServers: [
        { type: 'http', name: 'remote-http', url: 'https://mcp.example/http' },
        { type: 'sse', name: 'remote-sse', url: 'https://mcp.example/sse' },
        { type: 'stdio', name: 'custom-stdio', command: 'node', args: ['server.mjs'] },
      ],
    });
    expect(provider.capabilities.attachments).toBe(false);

    const fallbackModels = await provider.listModels(true);
    expect(vi.mocked(getCursorRuntimeConfig)).toHaveBeenCalledWith(true);
    expect(fallbackModels).toMatchObject({
      models: [{ id: 'auto' }, { id: 'composer-2.5' }],
      defaultModel: 'auto',
      isAuthenticated: true,
    });

    const sid = await provider.createSession({
      sessionKey: 'route-boundary',
      cwd: '/tmp/proj',
      agentId: 'Claude Sonnet 5 300K Medium No Thinking',
    });
    await expect(provider.applySessionModel(sid, 'Claude Sonnet 5 300K Medium No Thinking')).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
    await provider.send(sid, 'hello');
    const proc = spawnedProcesses[1]!;
    proc.reply(proc.requests.find((r) => r.method === 'session/prompt')!.id!, { stopReason: 'end_turn' });
    await new Promise((r) => setTimeout(r, 15));

    const sessionNewReq = proc.requests.find((r) => r.method === 'session/new' && (r.params?.mcpServers as Array<Record<string, unknown>>).length > 0);
    const mcpNames = (sessionNewReq?.params?.mcpServers as Array<{ name: string }>).map((m) => m.name);
    expect(mcpNames).toContain('imcodes-memory');
    expect(mcpNames).toContain('custom-stdio');
    expect(mcpNames).not.toContain('remote-http');
    expect(mcpNames).not.toContain('remote-sse');

    await provider.endSession(sid);
    // closeSession MUST NOT be sent when agentCapabilities.sessionCapabilities.close is absent
    expect(proc.requests.some((r) => r.method === 'session/close')).toBe(false);

    await provider.disconnect();
  });
});
