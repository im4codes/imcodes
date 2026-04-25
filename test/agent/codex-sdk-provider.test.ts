import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
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
            childRecord.emits({
              id: msg.id,
              result: { thread: { id: 'thread-1' } },
            });
            childRecord.emits({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
          }
          if (msg.method === 'thread/resume' && typeof msg.id === 'number') {
            childRecord.emits({
              id: msg.id,
              result: { thread: { id: msg.params?.threadId } },
            });
          }
          if (msg.method === 'turn/start' && typeof msg.id === 'number') {
            childRecord.emits({
              id: msg.id,
              result: { turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } },
            });
          }
          if (msg.method === 'turn/interrupt' && typeof msg.id === 'number') {
            childRecord.emits({ id: msg.id, result: {} });
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

  return { spawn, execFile, children };
});

vi.mock('node:child_process', () => ({
  spawn: childProcessMock.spawn,
  execFile: childProcessMock.execFile,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { CodexSdkProvider } from '../../src/agent/providers/codex-sdk.js';
import type { ProviderContextPayload } from '../../shared/context-types.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('CodexSdkProvider', () => {
  beforeEach(() => {
    vi.useRealTimers();
    childProcessMock.spawn.mockClear();
    childProcessMock.execFile.mockClear();
    childProcessMock.children.length = 0;
  });

  it('starts a thread, captures resume id, emits tool calls, streams message deltas, and completes', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    await provider.createSession({ sessionKey: 'route-1', cwd: '/tmp/project' });

    const tools: Array<{ name: string; status: string; detail?: unknown }> = [];
    const deltas: string[] = [];
    const completed: string[] = [];
    const sessionInfo: Array<Record<string, unknown>> = [];
    provider.onToolCall((_, tool) => tools.push({ name: tool.name, status: tool.status, detail: tool.detail }));
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));
    provider.onComplete((_sid, msg) => completed.push(msg.content));
    provider.onSessionInfo?.((_sid, info) => sessionInfo.push(info as Record<string, unknown>));

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
      params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 }, total: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, totalTokens: 6, reasoningOutputTokens: 0 }, modelContextWindow: 258400 } },
    });
    child.emits({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'msg-1', type: 'agentMessage', text: 'OK' } },
    });
    child.emits({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
    await flush();

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
    // baseInstructions MUST be sent on thread/start: codex-cli forwards it to
    // the upstream Responses API as `instructions`, which third-party
    // providers (minimax, openrouter) reject with 400 "Instructions are
    // required" when missing. Don't drop this field.
    expect(typeof threadStartReq?.params?.baseInstructions).toBe('string');
    expect((threadStartReq?.params?.baseInstructions as string).length).toBeGreaterThan(0);
    expect(turnStartReq?.params?.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
    expect(turnStartReq?.params?.approvalPolicy).toBe('never');
    expect(deltas).toEqual(['O', 'OK']);
    expect(completed).toEqual(['OK']);
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

  it('lists codex models across paginated model/list responses', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });

    const resultPromise = provider.readModelList();
    const child = childProcessMock.children[0];
    const firstRequest = child.requests.find((req) => req.method === 'model/list');
    expect(firstRequest?.params).toMatchObject({ includeHidden: false, limit: 100 });

    child.emits({
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
    await flush();

    const secondRequest = child.requests.filter((req) => req.method === 'model/list')[1];
    expect(secondRequest?.params).toMatchObject({ cursor: 'cursor-2', includeHidden: false, limit: 100 });
    child.emits({
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
