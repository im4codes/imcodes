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

  private buf = '';

  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    this.signalCode = signal ?? 'SIGTERM';
    this.exitCode = 0;
    queueMicrotask(() => {
      this.emit('exit', 0, signal ?? 'SIGTERM');
      this.emit('close', 0, signal ?? 'SIGTERM');
    });
    return true;
  });

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

const flush = async (ticks = 6): Promise<void> => {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

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
    handler: (req: FakeAcpRpcRequest, proc: FakeAcpServerProcess) => void,
    options: { spawnError?: Error } = {},
  ): void {
    spawnMock = vi.fn((_file: string, _args: string[]) => {
      const proc = new FakeAcpServerProcess(handler);
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
    execFileMock = vi.fn((_file: string, _args: string[], _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb?.(null, '2026.06.15-03-48-54-da23e37\n', '');
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
        return;
      }
      if (req.method === 'authenticate') {
        requiresAuth = false;
        proc.reply(req.id!, {});
        return;
      }
      if (req.method === 'session/new') {
        if (requiresAuth) {
          proc.replyError(req.id!, -32000, 'Authentication required', {
            message: "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.",
          });
          return;
        }
        proc.reply(req.id!, { sessionId: 'acp-sess-1' });
        return;
      }
      if (req.method === 'session/close') {
        proc.reply(req.id!, {});
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

    // When authenticate itself rejects, provider surfaces actionable AUTH_FAILED without hanging
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

  it('normalizes exact context token usage via onUsage (usage_update, PromptResponse.usage, cached model contextWindow) and finalizes on completion', async () => {
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
        proc.notifySessionUpdate('acp-usage-1', {
          sessionUpdate: 'usage_update',
          used: 45_000,
          size: 300_000,
          tokens: { inputTokens: 1_200, cachedInputTokens: 43_800, outputTokens: 120 },
        });
        proc.notifySessionUpdate('acp-usage-1', {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-usage-1',
          content: { type: 'text', text: 'Token check ok' },
        });
        setTimeout(() => {
          proc.reply(req.id!, {
            stopReason: 'end_turn',
            usage: { inputTokens: 1_250, outputTokens: 210, cachedReadTokens: 43_800, totalTokens: 45_260 },
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
      expect(usageEvents).toHaveLength(2);
    });

    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toMatchObject({
      finalized: false,
      model: 'composer-2.5',
      usage: {
        input_tokens: 1_200,
        cached_input_tokens: 43_800,
        cache_read_input_tokens: 43_800,
        output_tokens: 120,
        model_context_window: 300_000,
      },
    });
    expect(usageEvents[1]).toMatchObject({
      finalized: true,
      messageId: 'msg-usage-1',
      model: 'composer-2.5',
      usage: {
        input_tokens: 1_250,
        cached_input_tokens: 43_800,
        output_tokens: 210,
        model_context_window: 300_000,
      },
    });
    expect((completed[0]?.metadata as Record<string, unknown>)?.usage).toMatchObject({
      input_tokens: 1_250,
      cached_input_tokens: 43_800,
      output_tokens: 210,
      model_context_window: 300_000,
    });

    // Helper boundary check: `used` + `cachedInputTokens` without discrete `inputTokens`
    expect(normalizeCursorAcpUsage({ used: 45_000, size: 200_000, cachedInputTokens: 43_800 })).toMatchObject({
      input_tokens: 1_200,
      cached_input_tokens: 43_800,
      model_context_window: 200_000,
    });

    await provider.disconnect();
  });

  it('surfaces ACP compaction status (compacting -> null), resets injected system text post-compaction, passes /compact verbatim, and clears stuck compacting on error/cancel', async () => {
    let promptCount = 0;
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
          availableCommands: [{ name: 'compact', description: 'Compact conversation context' }],
        });
      } else if (req.method === 'session/prompt') {
        promptCount += 1;
        if (promptCount === 1) {
          proc.notifySessionUpdate('acp-compact-1', {
            sessionUpdate: 'compaction_update',
            compactionId: 'cmp-1',
            status: 'in_progress',
          });
          proc.notifySessionUpdate('acp-compact-1', {
            sessionUpdate: 'compaction_summary_chunk',
            compactionId: 'cmp-1',
            content: { type: 'text', text: 'Internal compacted summary' },
          });
          proc.notifySessionUpdate('acp-compact-1', {
            sessionUpdate: 'compaction_update',
            compactionId: 'cmp-1',
            status: 'completed',
          });
          proc.notifySessionUpdate('acp-compact-1', {
            sessionUpdate: 'usage_update',
            used: 4_000,
            size: 200_000,
          });
          proc.notifySessionUpdate('acp-compact-1', {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg-c1',
            content: { type: 'text', text: 'After compact' },
          });
          setTimeout(() => proc.reply(req.id!, { stopReason: 'end_turn' }), 10);
        } else if (promptCount === 2) {
          setTimeout(() => proc.reply(req.id!, { stopReason: 'end_turn' }), 10);
        } else if (promptCount === 3) {
          // Turn 3 stalls in compacting and gets cancelled
          proc.notifySessionUpdate('acp-compact-1', {
            sessionUpdate: 'compaction_update',
            compactionId: 'cmp-2',
            status: 'in_progress',
          });
        }
      } else if (req.method === 'session/cancel') {
        const activePrompt = proc.requests.filter((r) => r.method === 'session/prompt').at(-1);
        if (activePrompt?.id !== undefined) {
          proc.reply(activePrompt.id, { stopReason: 'cancelled' });
        }
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const sid = await provider.createSession({ sessionKey: 'route-compact', cwd: '/tmp/proj' });

    const statuses: Array<string | null> = [];
    const deltas: string[] = [];
    const completions: string[] = [];
    provider.onStatus((_sid, s) => statuses.push(s.status));
    provider.onDelta((_sid, d) => deltas.push(d.delta));
    provider.onComplete((_sid, m) => completions.push(m.content));

    await provider.send(sid, makePayload('first message', {
      sessionSystemText: 'IDENTITY CONTRACT',
      assembledMessage: 'first message',
    }));
    await vi.waitFor(() => {
      expect(completions).toHaveLength(1);
    });

    expect(statuses).toContain('compacting');
    expect(statuses.at(-1)).toBeNull();
    // Compaction summary chunks must NEVER bleed into assistant text deltas
    expect(deltas).toEqual(['After compact']);

    // Because compaction completed during turn 1, turn 2 MUST re-inject sessionSystemText!
    await provider.send(sid, makePayload('second message', {
      sessionSystemText: 'IDENTITY CONTRACT',
      assembledMessage: 'second message',
    }));
    await vi.waitFor(() => {
      expect(completions).toHaveLength(2);
    });
    const secondPrompt = spawnedProcesses[0]!.requests.filter((r) => r.method === 'session/prompt')[1]!;
    expect(JSON.stringify(secondPrompt.params?.prompt)).toContain('IDENTITY CONTRACT');

    // Turn 3 enters compacting then gets cancelled -> compacting status clears cleanly
    statuses.length = 0;
    await provider.send(sid, '/compact');
    const thirdPrompt = spawnedProcesses[0]!.requests.filter((r) => r.method === 'session/prompt')[2]!;
    expect((thirdPrompt.params?.prompt as Array<{ text: string }>)[0]?.text).toBe('/compact');
    await vi.waitFor(() => {
      expect(statuses).toContain('compacting');
    });
    await provider.cancelAndWait(sid);
    await vi.waitFor(() => {
      expect(statuses.at(-1)).toBeNull();
      expect(provider.getSessionDiagnostics(sid)?.compacting).toBe(false);
    });

    await provider.disconnect();
  });

  it('supports image attachments, HTTP/SSE + stdio MCP servers, approvals, session/load replay suppression, and multi-session isolation', async () => {
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
            sessionCapabilities: { list: {} },
          },
        });
      } else if (req.method === 'session/new') {
        newCount += 1;
        const acpId = `acp-multi-${newCount}`;
        proc.reply(req.id!, { sessionId: acpId });
      } else if (req.method === 'session/load') {
        // History replay chunks must be suppressed!
        proc.notifySessionUpdate(String(req.params?.sessionId), {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'STALE REPLAY' },
        });
        proc.reply(req.id!, {});
      } else if (req.method === 'session/list') {
        proc.reply(req.id!, {
          sessions: [
            { sessionId: 'acp-listed-1', cwd: dir, title: 'Listed Cursor Session', updatedAt: '2026-11-28T00:00:00Z' },
          ],
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
          setTimeout(() => proc.reply(req.id!, { stopReason: 'end_turn' }), 10);
          return;
        }
        if (sid === 'acp-multi-1') {
          proc.notifySessionUpdate('acp-multi-1', {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'secret thought' },
          });
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
    const sResumed = await provider.createSession({
      sessionKey: 'route-resumed',
      cwd: dir,
      resumeId: 'acp-resumed-existing',
    });

    const deltasBySession = new Map<string, string[]>();
    const toolsBySession = new Map<string, ToolCallEvent[]>();
    const approvals: Array<{ sid: string; id: string; tool?: string }> = [];
    provider.onDelta((sid, d) => {
      const list = deltasBySession.get(sid) ?? [];
      list.push(d.delta);
      deltasBySession.set(sid, list);
    });
    provider.onToolCall((sid, tc) => {
      const list = toolsBySession.get(sid) ?? [];
      list.push(tc);
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
      const promptReqs = proc.requests.filter((x) => x.method === 'session/prompt');
      expect(promptReqs).toHaveLength(3);
      expect(approvals).toHaveLength(1);
    });

    // Reply permission on turn 1/2 prompts
    for (const r of proc.requests.filter((x) => x.method === 'session/prompt' && x.params?.sessionId !== 'acp-resumed-existing')) {
      proc.reply(r.id!, { stopReason: 'end_turn' });
    }
    await vi.waitFor(() => {
      expect(deltasBySession.get(s1)).toEqual(['Answer S1']);
      expect(deltasBySession.get(s2)).toEqual(['Answer S2']);
      expect(deltasBySession.get(sResumed)).toEqual(['Fresh reply only']);
    });

    // Verify stdio + http + sse MCP passed on session/new
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
    expect(JSON.parse(memEnv[IMCODES_DAEMON_NAMESPACE_ENV]!)).toEqual({
      scope: 'user_private',
      userId: 'u1',
      projectId: 'p1',
    });
    expect(mcpServers.some((m) => m.type === 'http' && m.name === 'remote-http')).toBe(true);
    expect(mcpServers.some((m) => m.type === 'sse' && m.name === 'remote-sse')).toBe(true);

    // Verify image ContentBlock sent on prompt
    const prompt1 = proc.requests.find((r) => r.method === 'session/prompt' && r.params?.sessionId === 'acp-multi-1');
    const blocks = prompt1?.params?.prompt as Array<{ type: string; mimeType?: string; data?: string }>;
    expect(blocks.some((b) => b.type === 'image' && b.mimeType === 'image/png' && b.data === Buffer.from([137, 80, 78, 71]).toString('base64'))).toBe(true);

    // Verify isolation + replay suppression + approval response
    expect(deltasBySession.get(s1)).toEqual(['Answer S1']);
    expect(deltasBySession.get(s2)).toEqual(['Answer S2']);
    expect(deltasBySession.get(sResumed)).toEqual(['Fresh reply only']);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ sid: s1, tool: 'Run shell command' });
    expect(proc.responses.some((r) => r.id === 'perm-1' && (r.result as Record<string, any>)?.outcome?.optionId === 'allow_once')).toBe(true);
    expect(toolsBySession.get(s1)?.some((t) => t.name === 'shell' && t.status === 'complete' && t.output === 'file.ts')).toBe(true);
    expect(toolsBySession.get(s1)?.some((t) => t.name === 'plan')).toBe(true);

    // Verify session/list
    const listed = await provider.listSessions({ directory: dir });
    expect(listed).toEqual([
      {
        key: 'acp-listed-1',
        displayName: 'Listed Cursor Session',
        directory: dir,
        updatedAt: Date.parse('2026-11-28T00:00:00Z'),
      },
    ]);

    await provider.disconnect();
  });

  it('rejects human display labels in favor of canonical model ids, handles model switching, listModels, and recovers after child exit', async () => {
    installHarness((req, proc) => {
      if (req.method === 'initialize') {
        proc.reply(req.id!, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
        });
      } else if (req.method === 'session/new') {
        proc.reply(req.id!, {
          sessionId: 'acp-model-1',
          models: {
            currentModelId: 'composer-2.5',
            availableModels: [
              { modelId: 'composer-2.5', name: 'Composer 2.5', contextWindow: 256_000 },
              { modelId: 'gpt-5.3-codex', name: 'GPT 5.3 Codex', contextWindow: 400_000 },
            ],
          },
        });
      } else if (req.method === 'session/set_model') {
        proc.reply(req.id!, {});
      } else if (req.method === 'session/load') {
        proc.reply(req.id!, {});
      } else if (req.method === 'session/prompt') {
        if (spawnedProcesses.length === 1) {
          // Crash child mid-turn
          queueMicrotask(() => {
            proc.exitCode = 1;
            proc.emit('exit', 1, null);
          });
        } else {
          proc.notifySessionUpdate('acp-model-1', {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Recovered' },
          });
          setTimeout(() => proc.reply(req.id!, { stopReason: 'end_turn' }), 10);
        }
      }
    });

    const provider = new CursorAcpProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });
    const list = await provider.listModels(true);
    expect(list).toMatchObject({
      isAuthenticated: true,
      defaultModel: 'composer-2.5',
      models: [
        { id: 'composer-2.5', name: 'Composer 2.5' },
        { id: 'gpt-5.3-codex', name: 'GPT 5.3 Codex' },
      ],
    });
    expect(vi.mocked(getCursorRuntimeConfig)).not.toHaveBeenCalled();

    const sid = await provider.createSession({
      sessionKey: 'route-model',
      cwd: '/tmp/proj',
      agentId: 'Claude Sonnet 5 300K Medium No Thinking',
    });
    // Invalid label was ignored; model starts unset until session/new reports canonical currentModelId
    await expect(provider.applySessionModel(sid, 'Claude Sonnet 5 300K Medium No Thinking')).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });

    const errors: Array<Record<string, unknown>> = [];
    const completed: string[] = [];
    provider.onError((_sid, e) => errors.push(e as unknown as Record<string, unknown>));
    provider.onComplete((_sid, m) => completed.push(m.content));

    // Turn 1 crashes mid-turn -> emits CONNECTION_LOST
    await provider.send(sid, 'turn before crash');
    await vi.waitFor(() => {
      expect(errors.some((e) => e.code === 'CONNECTION_LOST')).toBe(true);
    });

    // Next turn respawns child cleanly and reloads session via session/load
    await provider.send(sid, 'turn after crash');
    await vi.waitFor(() => {
      expect(spawnedProcesses).toHaveLength(2);
      expect(spawnedProcesses[1]!.requests.some((r) => r.method === 'session/load' && r.params?.sessionId === 'acp-model-1')).toBe(true);
      expect(completed).toEqual(['Recovered']);
    });

    // Switch canonical model live
    await expect(provider.applySessionModel(sid, 'gpt-5.3-codex')).resolves.toBe('live');
    expect(spawnedProcesses[1]!.requests.some((r) => r.method === 'session/set_model' && r.params?.modelId === 'gpt-5.3-codex')).toBe(true);

    await provider.disconnect();
  });

  it('handles ENOENT spawn errors, filters unsupported HTTP/SSE MCPs, falls back listModels to CLI, and force-settles wedged cancel', { timeout: 12_000 }, async () => {
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
            loadSession: true,
            mcpCapabilities: { http: false, sse: false },
            promptCapabilities: { image: false },
          },
        });
      } else if (req.method === 'session/new') {
        // Deliberately omit models so listModels falls back to getCursorRuntimeConfig()
        proc.reply(req.id!, { sessionId: 'acp-boundary-1' });
      } else if (req.method === 'session/prompt') {
        proc.notifySessionUpdate('acp-boundary-1', {
          sessionUpdate: 'compaction_update',
          status: 'in_progress',
        });
        // Intentionally ignore session/cancel to test cancel grace teardown
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

    const sid = await provider.createSession({ sessionKey: 'route-boundary', cwd: '/tmp/proj' });
    const errors: Array<Record<string, unknown>> = [];
    const statuses: Array<string | null> = [];
    provider.onError((_sid, err) => errors.push(err as unknown as Record<string, unknown>));
    provider.onStatus((_sid, s) => statuses.push(s.status));

    await provider.send(sid, 'hang until cancelled');
    await vi.waitFor(() => {
      expect(statuses).toContain('compacting');
    });

    const sessionNewReq = spawnedProcesses[1]!.requests.find(
      (r) => r.method === 'session/new' && (r.params?.mcpServers as Array<Record<string, unknown>>).length > 0,
    );
    const mcpNames = (sessionNewReq?.params?.mcpServers as Array<{ name: string }>).map((m) => m.name);
    expect(mcpNames).toContain('imcodes-memory');
    expect(mcpNames).toContain('custom-stdio');
    expect(mcpNames).not.toContain('remote-http');
    expect(mcpNames).not.toContain('remote-sse');

    await provider.cancel(sid);
    await vi.waitFor(() => {
      expect(errors.some((e) => e.code === 'CANCELLED')).toBe(true);
      expect(statuses.at(-1)).toBeNull();
      expect(provider.getSessionDiagnostics(sid)).toMatchObject({
        promptInFlight: false,
        compacting: false,
      });
    }, { timeout: 7_000 });

    await provider.disconnect();
  });
});
