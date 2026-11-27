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
import { __testing__ as transportRelayTesting } from '../../src/daemon/transport-relay.js';
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
    if (this.holdExit) {
      return true;
    }
    this.exitCode = 0;
    this.signalCode = signal ?? 'SIGTERM';
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

  it('handles active-turn child exit, endSession, and detachSession without TypeError or forged stop proof (P0-A)', async () => {
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/new') {
        const n = proc.requests.filter((r) => r.method === 'session/new').length;
        proc.reply(req.id!, { sessionId: `acp-p0a-${n}` });
      } else if (req.method === 'session/prompt') {
        // Leave pending to simulate in-flight turns when exit/end/detach occurs.
      }
    }, { holdExit: true });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const errors: Array<{ sid: string; code: string }> = [];
    const completions: string[] = [];
    provider.onError((sid, err) => errors.push({ sid, code: err.code }));
    provider.onComplete((sid) => completions.push(sid));

    const s1 = await provider.createSession({ sessionKey: 'route-p0a-1', cwd: '/tmp/proj' });
    const s2 = await provider.createSession({ sessionKey: 'route-p0a-2', cwd: '/tmp/proj' });
    const s3 = await provider.createSession({ sessionKey: 'route-p0a-3', cwd: '/tmp/proj' });

    await provider.send(s1, 'turn 1');
    await provider.send(s2, 'turn 2');
    await provider.send(s3, 'turn 3');

    const proc1 = spawnedProcesses[0]!;
    await vi.waitFor(() => {
      expect(proc1.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(3);
    });

    // endSession + detachSession while turns are active and child is alive (`holdExit=true`):
    // must NOT throw TypeError (`state.pendingTurn.resolvePhysicalTerminal()`), must send cancel,
    // must NOT forge physicalTerminal before real child exit, and must leave s3 intact!
    await expect(provider.endSession(s1)).resolves.toBeUndefined();
    await expect(provider.detachSession(s2)).resolves.toBeUndefined();
    expect(errors.filter((e) => e.sid === s1)).toHaveLength(1);
    expect(errors.filter((e) => e.sid === s2)).toHaveLength(1);
    await vi.waitFor(() => {
      expect(proc1.requests.some((r) => r.method === 'session/cancel' && r.params?.sessionId === 'acp-p0a-1')).toBe(true);
      expect(proc1.requests.some((r) => r.method === 'session/cancel' && r.params?.sessionId === 'acp-p0a-2')).toBe(true);
    });

    const s3PromptReq = proc1.requests.find((r) => r.method === 'session/prompt' && r.params?.sessionId === 'acp-p0a-3')!;
    proc1.reply(s3PromptReq.id!, { stopReason: 'end_turn' });
    await vi.waitFor(() => expect(completions).toEqual([s3]));

    // Now start two concurrent active turns and crash child via `exit`: must fail BOTH without TypeError!
    const s4 = await provider.createSession({ sessionKey: 'route-p0a-4', cwd: '/tmp/proj' });
    await provider.send(s3, 'concurrent 1');
    await provider.send(s4, 'concurrent 2');
    await vi.waitFor(() => {
      expect(proc1.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(5);
    });
    proc1.releaseExit(1, null);
    await vi.waitFor(() => {
      expect(errors.filter((e) => (e.sid === s3 || e.sid === s4) && e.code === 'CONNECTION_LOST')).toHaveLength(2);
    });

    // Verify endSession while child refuses to exit does NOT resolve cancelAndWait early until releaseExit
    const s5 = await provider.createSession({ sessionKey: 'route-p0a-5', cwd: '/tmp/proj' });
    await provider.send(s5, 'wedged before detach');
    const proc2 = spawnedProcesses[1]!;
    await vi.waitFor(() => expect(proc2.requests.some((r) => r.method === 'session/prompt')).toBe(true));

    await provider.endSession(s5);
    // Recreating isn't needed: test direct `cancelAndWait` with live child after detach isn't called because endSession deletes route,
    // verify `disconnect()` while child is alive with `holdExit=true` also never throws TypeError:
    const s6 = await provider.createSession({ sessionKey: 'route-p0a-6', cwd: '/tmp/proj' });
    await provider.send(s6, 'active during disconnect');
    await vi.waitFor(() => expect(proc2.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(2));
    const disconnectPromise = provider.disconnect();
    await new Promise((r) => setTimeout(r, 25));
    proc2.releaseExit(0, 'SIGTERM');
    await expect(disconnectPromise).resolves.toBeUndefined();
  });

  it('scopes reclaim and cancel child ownership strictly per connection generation (P0-B)', async () => {
    let acpCounter = 0;
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/new') {
        acpCounter += 1;
        proc.reply(req.id!, { sessionId: `acp-p0b-${acpCounter}` });
      } else if (req.method === 'session/load') {
        proc.reply(req.id!, {});
      }
    }, { holdExit: true });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const approvals: Array<{ sid: string; id: string }> = [];
    const errors: Array<{ sid: string; code: string }> = [];
    const completions: string[] = [];
    provider.onApprovalRequest((sid, req) => approvals.push({ sid, id: req.id }));
    provider.onError((sid, err) => errors.push({ sid, code: err.code }));
    provider.onComplete((sid) => completions.push(sid));

    const s1 = await provider.createSession({ sessionKey: 'route-p0b-1', cwd: '/tmp/proj' });
    const s2 = await provider.createSession({ sessionKey: 'route-p0b-2', cwd: '/tmp/proj' });
    await provider.send(s1, 'gen1 slow prompt');
    await provider.send(s2, 'gen1 sibling prompt');

    const proc1 = spawnedProcesses[0]!;
    await vi.waitFor(() => {
      expect(proc1.requests.filter((r) => r.method === 'session/prompt')).toHaveLength(2);
    });

    // Clear `this.child` / `this.connection` on timeout/reclaim path:
    // First, verify `cancel(s1)` checks `turn.capturedChild` (`proc1` alive) rather than cleared `this.child`:
    // Close stdin/emit error while proc1 holds exit so gen1 is reclaimed cleanly without resolving physical stop early.
    proc1.emit('error', new Error('epipe write broken'));
    await vi.waitFor(() => {
      expect(errors.filter((e) => e.sid === s2 && e.code === 'CONNECTION_LOST')).toHaveLength(1);
    });

    // Spawn gen2 on same sessions BEFORE proc1 exits (`holdExit=true` keeps proc1 alive!)
    await provider.send(s2, 'gen2 active prompt');
    const proc2 = spawnedProcesses[1]!;
    await vi.waitFor(() => {
      expect(proc2.requests.some((r) => r.method === 'session/prompt' && r.params?.sessionId === 'acp-p0b-2')).toBe(true);
    });

    // Open a pending approval on gen2 (`s2`) and an active turn on gen2 (`s2`):
    proc2.requestPermission(901, 'acp-p0b-2', { toolCallId: 'tc-gen2', title: 'bash' });
    await vi.waitFor(() => expect(approvals.some((a) => a.sid === s2)).toBe(true));

    // Delayed rejection on proc1's prompt MUST trigger gen1 reclaim ONLY and NOT cancel gen2's approval or fail gen2's turn!
    const proc1Prompt1 = proc1.requests.find((r) => r.method === 'session/prompt' && r.params?.sessionId === 'acp-p0b-1')!;
    proc1.replyError(proc1Prompt1.id!, -32001, 'late gen1 close');
    await new Promise((r) => setTimeout(r, 40));

    // Gen2 approval + turn are completely intact:
    const gen2Approval = approvals.find((a) => a.sid === s2)!;
    await provider.respondApproval(s2, gen2Approval.id, true);
    await vi.waitFor(() => {
      expect(proc2.responses.some((r) => r.id === 901 && (r.result as { outcome?: { outcome?: string } })?.outcome?.outcome === 'selected')).toBe(true);
    });
    const proc2Prompt = proc2.requests.find((r) => r.method === 'session/prompt' && r.params?.sessionId === 'acp-p0b-2')!;
    proc2.reply(proc2Prompt.id!, { stopReason: 'end_turn' });
    await vi.waitFor(() => expect(completions).toEqual([s2]));

    // Now test cancel() checking turn.capturedChild: start gen2 turn on s1, null out connection via error while holdExit=true,
    // then cancelAndWait(s1) MUST wait until proc2 exits instead of returning early!
    await provider.send(s1, 'turn awaiting real proc2 exit');
    await vi.waitFor(() => {
      expect(proc2.requests.filter((r) => r.method === 'session/prompt' && r.params?.sessionId === 'acp-p0b-1')).toHaveLength(1);
    });
    proc2.emit('error', new Error('gen2 pipe broke before exit'));
    let stopResolved = false;
    const stopPromise = provider.cancelAndWait(s1).then(() => { stopResolved = true; });
    await new Promise((r) => setTimeout(r, 40));
    expect(stopResolved).toBe(false);
    proc1.releaseExit(0, 'SIGKILL');
    proc2.releaseExit(0, 'SIGKILL');
    await stopPromise;
    expect(stopResolved).toBe(true);

    await provider.disconnect();
  });

  it('requires explicit session-not-found errors before resetting resumeId on loadSession (P0-C / R3-P0-2)', async () => {
    let mode:
      | 'generic-32602'
      | 'missing-cwd'
      | 'does-not-exist'
      | 'wrong-id'
      | 'structured-32002-other'
      | 'structured-32002-uri'
      | 'structured-32002-match'
      | 'exact-cursor-not-found' = 'generic-32602';
    let newCount = 0;
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/load') {
        if (mode === 'generic-32602') {
          proc.replyError(req.id!, -32602, 'Invalid params');
        } else if (mode === 'missing-cwd') {
          proc.replyError(req.id!, -32602, 'Invalid params', { message: 'Missing required parameter: cwd' });
        } else if (mode === 'does-not-exist') {
          proc.replyError(req.id!, -32602, 'Invalid params', { message: 'Resource does not exist' });
        } else if (mode === 'wrong-id') {
          proc.replyError(req.id!, -32602, 'Invalid params', { message: 'Session "other-unrelated-id" not found' });
        } else if (mode === 'structured-32002-other') {
          proc.replyError(req.id!, -32002, 'Resource not found', { sessionId: 'other-id' });
        } else if (mode === 'structured-32002-uri') {
          proc.replyError(req.id!, -32002, 'Resource not found', { uri: 'file:///missing' });
        } else if (mode === 'structured-32002-match') {
          proc.replyError(req.id!, -32002, 'Resource not found', { sessionId: 'acp-keep-me' });
        } else {
          proc.replyError(req.id!, -32602, 'Invalid params', { message: 'Session "acp-keep-fresh" not found' });
        }
      } else if (req.method === 'session/new') {
        newCount += 1;
        proc.reply(req.id!, { sessionId: `acp-fresh-${newCount}` });
      } else if (req.method === 'session/prompt') {
        proc.reply(req.id!, { stopReason: 'end_turn' });
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sid = await provider.createSession({ sessionKey: 'route-p0c', cwd: '/tmp/proj', resumeId: 'acp-keep-me' });

    for (const badMode of [
      'generic-32602',
      'missing-cwd',
      'does-not-exist',
      'wrong-id',
      'structured-32002-other',
      'structured-32002-uri',
    ] as const) {
      mode = badMode;
      await expect(provider.send(sid, 'attempt')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(newCount).toBe(0);
      expect(provider.getSessionDiagnostics(sid)?.acpSessionId).toBe('acp-keep-me');
    }

    // Structured ACP SDK RequestError.sessionNotFound(candidateId) (-32002 + matching data.sessionId) clears old ID
    mode = 'structured-32002-match';
    await provider.send(sid, 'structured match fallback');
    expect(newCount).toBe(1);
    expect(provider.getSessionDiagnostics(sid)?.acpSessionId).toBe('acp-fresh-1');

    // Exact Cursor CLI SessionNotFoundError (-32602 + quoted Session "<id>" not found) also clears old ID
    const sid2 = await provider.createSession({ sessionKey: 'route-p0c-2', cwd: '/tmp/proj', resumeId: 'acp-keep-fresh' });
    mode = 'exact-cursor-not-found';
    await provider.send(sid2, 'cursor quoted not found');
    expect(newCount).toBe(2);
    expect(provider.getSessionDiagnostics(sid2)?.acpSessionId).toBe('acp-fresh-2');

    await provider.disconnect();
  });

  it('invalidates prior model live context window when switching to an unannounced-window model (P0-D)', async () => {
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/new') {
        proc.reply(req.id!, {
          sessionId: 'acp-p0d',
          models: {
            currentModelId: 'model-a',
            availableModels: [
              { modelId: 'model-a', name: 'Model A' },
              { modelId: 'model-b', name: 'Model B' },
              { modelId: 'model-fail', name: 'Model Fail' },
            ],
          },
        });
      } else if (req.method === 'session/set_model') {
        if (req.params?.modelId === 'model-fail') {
          proc.replyError(req.id!, -32603, 'model unavailable');
        } else {
          proc.reply(req.id!, {});
        }
      } else if (req.method === 'session/prompt') {
        const text = (req.params?.prompt as Array<{ text?: string }>)[0]?.text ?? '';
        if (text.includes('turn-1-a')) {
          proc.notifySessionUpdate('acp-p0d', { sessionUpdate: 'usage_update', used: 20_000, size: 200_000 });
        } else if (text.includes('turn-2-b')) {
          proc.notifySessionUpdate('acp-p0d', { sessionUpdate: 'usage_update', used: 30_000 });
        } else if (text.includes('turn-3-back-a')) {
          proc.notifySessionUpdate('acp-p0d', { sessionUpdate: 'usage_update', used: 22_000 });
        }
        proc.reply(req.id!, { stopReason: 'end_turn' });
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const usages: Array<{ finalized: boolean; model?: string; usage: Record<string, unknown> }> = [];
    const completed: Array<{ model?: unknown; usage?: unknown }> = [];
    provider.onUsage((_sid, u) => usages.push({ finalized: u.finalized, model: u.model, usage: u.usage }));
    provider.onComplete((_sid, msg) => completed.push({ model: msg.metadata?.model, usage: msg.metadata?.usage }));

    const sid = await provider.createSession({ sessionKey: 'route-p0d', cwd: '/tmp/proj' });
    await provider.send(sid, 'turn-1-a');
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    expect(completed[0]?.usage).toMatchObject({ input_tokens: 20_000, model_context_window: 200_000 });

    // Failed switch A -> model-fail must keep model-a and its 200k live window intact:
    await expect(provider.applySessionModel(sid, 'model-fail')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(provider.getSessionDiagnostics(sid)?.model).toBe('model-a');
    expect(provider.getSessionDiagnostics(sid)?.lastContextWindow).toBe(200_000);

    // Switch A -> B (unknown static window): must NOT carry A's 200k window onto B!
    await provider.applySessionModel(sid, 'model-b');
    expect(provider.getSessionDiagnostics(sid)?.model).toBe('model-b');
    expect(provider.getSessionDiagnostics(sid)?.lastContextWindow).toBeNull();

    await provider.send(sid, 'turn-2-b');
    await vi.waitFor(() => expect(completed).toHaveLength(2));
    expect(completed[1]?.usage).toEqual({ input_tokens: 30_000 });
    expect(usages.at(-1)?.usage.model_context_window).toBeUndefined();

    // Switch B -> A again: remembers model-a's own 200k scoped live window!
    await provider.applySessionModel(sid, 'model-a');
    await provider.send(sid, 'turn-3-back-a');
    await vi.waitFor(() => expect(completed).toHaveLength(3));
    expect(completed[2]?.usage).toMatchObject({ input_tokens: 22_000, model_context_window: 200_000 });

    await provider.disconnect();
  });

  it('prevents cache_write double counting on mixed used + _meta.inputTokens and preserves occupancy on window-only _meta (P0-E / R3-P0-4)', async () => {
    // Direct unit checks for normalizeCursorAcpUsage cache read + write math:
    expect(normalizeCursorAcpUsage({
      used: 45_000,
      cachedInputTokens: 10_000,
      cachedWriteTokens: 5_000,
    })).toEqual({
      input_tokens: 30_000,
      cached_input_tokens: 10_000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 5_000,
    });

    // Mixed `used` AND `_meta.inputTokens` with same-frame cache read/write:
    // `used` MUST remain authoritative so transport-relay reports 45k total, never 60k!
    const mixed = normalizeCursorAcpUsage({
      used: 45_000,
      _meta: { inputTokens: 45_000 },
      cachedInputTokens: 10_000,
      cachedWriteTokens: 5_000,
    });
    expect(mixed).toEqual({
      input_tokens: 30_000,
      cached_input_tokens: 10_000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 5_000,
    });
    const relayMixed = transportRelayTesting.normalizeUsageUpdatePayload('deck_p0e_mixed', mixed, 'model-x');
    expect(relayMixed?.inputTokens).toBe(35_000);
    expect(relayMixed?.cacheTokens).toBe(10_000);
    expect((relayMixed?.inputTokens as number) + (relayMixed?.cacheTokens as number)).toBe(45_000);

    // Inconsistent split (read + write > used): keep total `used`, omit unreliable cache splits
    expect(normalizeCursorAcpUsage({
      used: 10_000,
      _meta: { inputTokens: 10_000 },
      cachedInputTokens: 8_000,
      cachedWriteTokens: 5_000,
    })).toEqual({
      input_tokens: 10_000,
    });

    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/new') {
        proc.reply(req.id!, { sessionId: 'acp-p0e' });
      } else if (req.method === 'session/prompt') {
        proc.notifySessionUpdate('acp-p0e', {
          sessionUpdate: 'usage_update',
          used: 45_000,
          _meta: { inputTokens: 45_000 },
          cachedInputTokens: 10_000,
          cachedWriteTokens: 5_000,
        });
        // Follow with window-only PromptResponse `_meta: { size: 200_000 }` and huge cumulative `usage`
        proc.reply(req.id!, {
          stopReason: 'end_turn',
          usage: { totalTokens: 95_000, inputTokens: 85_000, outputTokens: 10_000 },
          _meta: { size: 200_000 },
        });
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const finalizedUsages: Array<Record<string, unknown>> = [];
    const completedMsgs: Array<Record<string, unknown> | undefined> = [];
    provider.onUsage((_sid, u) => { if (u.finalized) finalizedUsages.push(u.usage); });
    provider.onComplete((_sid, msg) => completedMsgs.push(msg.metadata?.usage as Record<string, unknown> | undefined));

    const sid = await provider.createSession({ sessionKey: 'route-p0e', cwd: '/tmp/proj' });
    await provider.send(sid, 'prompt with cache write + window-only _meta');
    await vi.waitFor(() => expect(completedMsgs).toHaveLength(1));

    const expected = {
      input_tokens: 30_000,
      cached_input_tokens: 10_000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 5_000,
      model_context_window: 200_000,
    };
    expect(finalizedUsages[0]).toEqual(expected);
    expect(completedMsgs[0]).toEqual(expected);
    // Verify transport-relay additive invariant: (input_tokens + cache_creation_input_tokens) + cache_read_input_tokens === 45_000
    const relayInput = (expected.input_tokens) + (expected.cache_creation_input_tokens);
    expect(relayInput + expected.cache_read_input_tokens).toBe(45_000);

    await provider.disconnect();
  });

  it('isolates advertised /compact commands per session across concurrent TransportSessionRuntimes (P0-F)', async () => {
    let sessionSeq = 0;
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/new') {
        sessionSeq += 1;
        const sid = `acp-p0f-${sessionSeq}`;
        proc.reply(req.id!, { sessionId: sid });
      } else if (req.method === 'session/prompt') {
        const acpSid = String(req.params?.sessionId ?? '');
        const text = (req.params?.prompt as Array<{ text?: string }>)[0]?.text ?? '';
        if (text.includes('init-a')) {
          proc.notifySessionUpdate(acpSid, {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'compress' }],
          });
        } else if (text.includes('init-b-empty')) {
          proc.notifySessionUpdate(acpSid, {
            sessionUpdate: 'available_commands_update',
            availableCommands: [],
          });
        } else if (text.includes('enable-b-summarize')) {
          proc.notifySessionUpdate(acpSid, {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'summarize' }],
          });
        } else if (text.includes('disable-b')) {
          proc.notifySessionUpdate(acpSid, {
            sessionUpdate: 'available_commands_update',
            availableCommands: [],
          });
        }
        proc.reply(req.id!, { stopReason: 'end_turn' });
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const doneBySession = new Map<string, number>();
    provider.onComplete((sid) => doneBySession.set(sid, (doneBySession.get(sid) ?? 0) + 1));

    const rtA = new TransportSessionRuntime(provider, 'deck_p0f_a');
    const rtB = new TransportSessionRuntime(provider, 'deck_p0f_b');
    await rtA.initialize({ sessionKey: 'route-p0f-a', cwd: '/tmp/proj' });
    await rtB.initialize({ sessionKey: 'route-p0f-b', cwd: '/tmp/proj' });

    expect(rtA.send('init-a')).toBe('sent');
    await vi.waitFor(() => expect(doneBySession.get('route-p0f-a')).toBe(1));
    expect(rtB.send('init-b-empty')).toBe('sent');
    await vi.waitFor(() => expect(doneBySession.get('route-p0f-b')).toBe(1));

    // A advertised `/compress`, B advertised empty -> A accepts `/compact`, B rejects!
    expect(() => rtB.send('/compact')).toThrow(/not advertised|support \/compact/i);
    expect(rtA.send('/compact')).toBe('sent');
    await vi.waitFor(() => expect(doneBySession.get('route-p0f-a')).toBe(2));

    // B switches to `/summarize` -> A MUST STILL send `/compress`, B MUST send `/summarize`!
    expect(rtB.send('enable-b-summarize')).toBe('sent');
    await vi.waitFor(() => expect(doneBySession.get('route-p0f-b')).toBe(2));
    expect(rtB.send('/compact')).toBe('sent');
    await vi.waitFor(() => expect(doneBySession.get('route-p0f-b')).toBe(3));
    expect(rtA.send('/compact')).toBe('sent');
    await vi.waitFor(() => expect(doneBySession.get('route-p0f-a')).toBe(3));

    const proc = spawnedProcesses[0]!;
    const promptsA = proc.requests.filter((r) => r.method === 'session/prompt' && r.params?.sessionId === 'acp-p0f-1');
    const promptsB = proc.requests.filter((r) => r.method === 'session/prompt' && r.params?.sessionId === 'acp-p0f-2');
    expect((promptsA.at(-1)?.params?.prompt as Array<{ text: string }>)[0]?.text).toBe('/compress');
    expect((promptsB.at(-1)?.params?.prompt as Array<{ text: string }>)[0]?.text).toBe('/summarize');

    // B clears commands -> B rejects again while A keeps `/compress`!
    expect(rtB.send('disable-b')).toBe('sent');
    await vi.waitFor(() => expect(doneBySession.get('route-p0f-b')).toBe(4));
    expect(() => rtB.send('/compact')).toThrow(/not advertised|support \/compact/i);
    expect(provider.getSessionCapabilities('route-p0f-a')?.compact?.providerCommand).toBe('/compress');
    expect(provider.getSessionCapabilities('route-p0f-b')?.compact?.execution).toBe('unsupported');

    await provider.disconnect();
  });

  it('refuses Stop confirmation while child only received kill signal without exitCode/signalCode (R3-P0-1)', async () => {
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/new') {
        proc.reply(req.id!, { sessionId: 'acp-r3-p1' });
      }
    }, { holdExit: true });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sid = await provider.createSession({ sessionKey: 'route-r3-p1', cwd: '/tmp/proj' });
    await provider.send(sid, 'hold before signal');

    const proc = spawnedProcesses[0]!;
    await vi.waitFor(() => expect(proc.requests.some((r) => r.method === 'session/prompt')).toBe(true));

    // Signal sent (`killed = true`), process NOT exited (`exitCode === null`, `signalCode === null`),
    // and transport connection failed: Stop MUST NOT resolve physical proof prematurely!
    proc.kill('SIGTERM');
    expect(proc.killed).toBe(true);
    expect(proc.exitCode).toBeNull();
    expect(proc.signalCode).toBeNull();

    proc.emit('error', new Error('broken pipe after SIGTERM sent'));
    let stopResolved = false;
    const stopPromise = provider.cancelAndWait(sid).then(() => { stopResolved = true; });
    await new Promise((r) => setTimeout(r, 40));
    expect(stopResolved).toBe(false);

    proc.releaseExit(0, 'SIGTERM');
    await stopPromise;
    expect(stopResolved).toBe(true);
    await provider.disconnect();
  });

  it('prevents stale setSessionConfigOption response from overwriting replacement connection model or context window (R3-P0-3)', async () => {
    let pendingOldConfigReq: { id: string | number; proc: FakeAcpServerProcess } | null = null;
    installHarness((req, proc, index) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/new') {
        proc.reply(req.id!, {
          sessionId: `acp-r3-p3-${index}`,
          configOptions: [{
            id: 'model',
            category: 'model',
            currentValue: index === 0 ? 'model-init-old' : 'model-new',
            options: index === 0
              ? [{ value: 'model-init-old', contextWindow: 100_000 }]
              : [{ value: 'model-new', contextWindow: 256_000 }],
          }],
        });
      } else if (req.method === 'session/load') {
        proc.reply(req.id!, {
          configOptions: [{
            id: 'model',
            category: 'model',
            currentValue: 'model-new',
            options: [{ value: 'model-new', contextWindow: 256_000 }],
          }],
        });
      } else if (req.method === 'session/set_model') {
        proc.replyError(req.id!, -32601, 'Method not found');
      } else if (req.method === 'session/set_config_option') {
        if (index === 0) {
          pendingOldConfigReq = { id: req.id!, proc };
        } else {
          proc.reply(req.id!, {});
        }
      } else if (req.method === 'session/prompt') {
        proc.reply(req.id!, { stopReason: 'end_turn' });
      }
    }, { holdExit: true });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sessionInfos: Array<{ model?: string }> = [];
    provider.onSessionInfo((_sid, info) => sessionInfos.push({ model: info.model }));

    const sid = await provider.createSession({ sessionKey: 'route-r3-p3', cwd: '/tmp/proj' });
    await provider.send(sid, 'bind old connection');

    // Start fallback config-option switch on proc1; it hangs before returning stale catalog/currentValue
    const oldSwitchPromise = provider.applySessionModel(sid, 'model-stale-target');
    await vi.waitFor(() => expect(pendingOldConfigReq).not.toBeNull());

    // Break proc1 so proc2 spawns and binds the SAME route confirming `model-new` (256_000)
    const proc1 = spawnedProcesses[0]!;
    proc1.emit('error', new Error('proc1 died before config option reply'));
    provider.setSessionAgentId(sid, 'model-new');
    await provider.send(sid, 'bind replacement connection');
    expect(provider.getSessionDiagnostics(sid)?.model).toBe('model-new');
    expect(provider.getSessionDiagnostics(sid)?.lastContextWindow).toBe(256_000);
    const infoCountBeforeStaleReply = sessionInfos.length;

    // Now resolve the hung old setSessionConfigOption RPC carrying stale `model-old` (64_000)!
    pendingOldConfigReq!.proc.reply(pendingOldConfigReq!.id, {
      configOptions: [{
        id: 'model',
        category: 'model',
        currentValue: 'model-old',
        options: [{ value: 'model-old', contextWindow: 64_000 }],
      }],
    });
    await expect(oldSwitchPromise).rejects.toMatchObject({ code: 'CONNECTION_LOST' });

    // Replacement connection's model, window, cached catalog, and sessionInfo events MUST stay intact:
    expect(provider.getSessionDiagnostics(sid)?.model).toBe('model-new');
    expect(provider.getSessionDiagnostics(sid)?.lastContextWindow).toBe(256_000);
    expect(provider.getCachedModels()?.models.some((m) => m.id === 'model-old')).toBe(false);
    expect(sessionInfos).toHaveLength(infoCountBeforeStaleReply);

    proc1.releaseExit(0, 'SIGKILL');
    spawnedProcesses[1]?.releaseExit(0, 'SIGTERM');
    await provider.disconnect();
  });

  it('rejects queued /compact after capability revocation without sending raw prompt or setting compacted (R3-P0-5)', async () => {
    let pendingTurn1: { id: string | number; proc: FakeAcpServerProcess } | null = null;
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
      } else if (req.method === 'session/new') {
        proc.reply(req.id!, { sessionId: `acp-r3-p5-${proc.requests.filter((r) => r.method === 'session/new').length}` });
      } else if (req.method === 'session/prompt') {
        const text = (req.params?.prompt as Array<{ text?: string }>)[0]?.text ?? '';
        if (text.includes('warm-with-compress')) {
          proc.notifySessionUpdate(String(req.params?.sessionId), {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'compress' }],
          });
          proc.reply(req.id!, { stopReason: 'end_turn' });
        } else if (text.includes('turn-1-hold')) {
          pendingTurn1 = { id: req.id!, proc };
        } else {
          proc.reply(req.id!, { stopReason: 'end_turn' });
        }
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const completedMsgs: Array<{ compacted?: boolean }> = [];
    const providerErrors: Array<{ sid: string; message: string }> = [];
    provider.onComplete((_sid, msg) => completedMsgs.push({ compacted: msg.metadata?.compacted as boolean | undefined }));
    provider.onError((sid, err) => providerErrors.push({ sid, message: err.message }));

    // 1) Revoked while `/compact` was queued:
    const rtA = new TransportSessionRuntime(provider, 'deck_r3_p5_a');
    await rtA.initialize({ sessionKey: 'route-r3-p5-a', cwd: '/tmp/proj' });
    expect(rtA.send('warm-with-compress')).toBe('sent');
    await vi.waitFor(() => expect(completedMsgs).toHaveLength(1));

    expect(rtA.send('turn-1-hold')).toBe('sent');
    await vi.waitFor(() => expect(pendingTurn1).not.toBeNull());

    // While turn-1-hold is active, /compact is accepted by enqueue check:
    expect(rtA.send('/compact')).toBe('queued');

    // Before turn-1-hold settles, Cursor revokes `/compress` via available_commands_update:
    pendingTurn1!.proc.notifySessionUpdate('acp-r3-p5-1', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    });
    pendingTurn1!.proc.reply(pendingTurn1!.id, { stopReason: 'end_turn' });

    await vi.waitFor(() => expect(completedMsgs).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 40));

    // Runtime drain MUST NOT send raw `/compact` or mark any completion `compacted: true`!
    const promptsA = spawnedProcesses[0]!.requests.filter(
      (r) => r.method === 'session/prompt' && r.params?.sessionId === 'acp-r3-p5-1',
    );
    expect(promptsA).toHaveLength(2);
    expect(promptsA.some((r) => JSON.stringify(r.params?.prompt).includes('/compact'))).toBe(false);
    expect(completedMsgs.some((m) => m.compacted === true)).toBe(false);
    expect(rtA.lastProviderError?.message).toMatch(/not advertised|support \/compact/i);
    expect(providerErrors.length + (rtA.lastProviderError ? 1 : 0)).toBeGreaterThan(0);

    // 2) Command switched (`/compress` -> `/summarize`) while `/compact` was queued: translates to `/summarize`!
    pendingTurn1 = null;
    const rtB = new TransportSessionRuntime(provider, 'deck_r3_p5_b');
    await rtB.initialize({ sessionKey: 'route-r3-p5-b', cwd: '/tmp/proj' });
    expect(rtB.send('warm-with-compress')).toBe('sent');
    await vi.waitFor(() => expect(completedMsgs).toHaveLength(3));

    expect(rtB.send('turn-1-hold')).toBe('sent');
    await vi.waitFor(() => expect(pendingTurn1).not.toBeNull());
    expect(rtB.send('/compact')).toBe('queued');

    pendingTurn1!.proc.notifySessionUpdate('acp-r3-p5-2', {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'summarize' }],
    });
    pendingTurn1!.proc.reply(pendingTurn1!.id, { stopReason: 'end_turn' });

    await vi.waitFor(() => expect(completedMsgs).toHaveLength(5));
    const promptsB = spawnedProcesses[0]!.requests.filter(
      (r) => r.method === 'session/prompt' && r.params?.sessionId === 'acp-r3-p5-2',
    );
    expect((promptsB.at(-1)?.params?.prompt as Array<{ text: string }>)[0]?.text).toBe('/summarize');
    expect(completedMsgs.at(-1)?.compacted).toBe(true);

    await provider.disconnect();
  });

  it('reports canListSessions()=true when disconnected or session/list supported, and false only when connected without list capability', async () => {
    let advertiseList = true;
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: advertiseList ? { list: {} } : {},
          },
          authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }],
        });
      } else if (req.method === 'authenticate') {
        proc.reply(req.id!, {});
      }
    });

    const provider = new CursorAcpProvider();
    expect(provider.canListSessions()).toBe(true);

    advertiseList = true;
    await provider.connect({ binaryPath: 'cursor-agent' });
    expect(provider.canListSessions()).toBe(true);

    await provider.disconnect();
    expect(provider.canListSessions()).toBe(true);

    advertiseList = false;
    await provider.connect({ binaryPath: 'cursor-agent' });
    expect(provider.canListSessions()).toBe(false);

    await provider.disconnect();
    expect(provider.canListSessions()).toBe(true);
  });
});
