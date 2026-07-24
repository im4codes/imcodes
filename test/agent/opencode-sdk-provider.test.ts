import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenCodeSdkProvider,
  openCodeSdkRuntimeHooks,
} from '../../src/agent/providers/opencode-sdk.js';
import { MEMORY_MCP_STATUS } from '../../shared/memory-ws.js';

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createAsyncQueue<T>() {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;
  return {
    push(value: T) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else values.push(value);
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()?.({ value: undefined, done: true });
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            const value = values.shift();
            if (value !== undefined) return Promise.resolve({ value, done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    } as AsyncIterable<T>,
  };
}

function result<T>(data: T) {
  return Promise.resolve({ data, response: { status: 200 } });
}

function createHarness() {
  const queue = createAsyncQueue<Record<string, unknown>>();
  const prompt = deferred<{ data: Record<string, unknown> }>();
  const sessions = new Map<string, Record<string, any>>();
  const startOptions: Array<Record<string, unknown>> = [];
  let nextSession = 1;
  const client = {
    session: {
      create: vi.fn((options: any) => {
        const id = `oc-session-${nextSession++}`;
        const session = { id, title: options.body?.title ?? id, time: { created: 1, updated: 2 } };
        sessions.set(id, session);
        return result(session);
      }),
      get: vi.fn((options: any) => {
        const session = sessions.get(options.path.id);
        if (!session) return Promise.reject(new Error('404 session not found'));
        return result(session);
      }),
      list: vi.fn(() => result([...sessions.values()])),
      prompt: vi.fn(() => prompt.promise),
      abort: vi.fn(() => result(true)),
    },
    provider: {
      list: vi.fn(() => result({
        connected: ['anthropic'],
        default: { anthropic: 'claude-sonnet-4-5' },
        all: [{
          id: 'anthropic',
          name: 'Anthropic',
          models: {
            'claude-sonnet-4-5': {
              id: 'claude-sonnet-4-5',
              name: 'Claude Sonnet 4.5',
              reasoning: true,
              limit: { context: 1_000_000, output: 128_000 },
            },
          },
        }],
      })),
    },
    event: { subscribe: vi.fn(() => Promise.resolve({ stream: queue.stream })) },
    postSessionIdPermissionsPermissionId: vi.fn(() => result(true)),
  };
  const server = { url: 'http://127.0.0.1:45678', close: vi.fn() };
  return { queue, prompt, sessions, client, server, startOptions };
}

describe('OpenCodeSdkProvider', () => {
  const originalStart = openCodeSdkRuntimeHooks.start;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    openCodeSdkRuntimeHooks.start = originalStart;
  });

  it('starts the official server on loopback and exposes connected status', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      harness.startOptions.push(options as unknown as Record<string, unknown>);
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    expect(provider.getMemoryMcpStatus().status).toBe(MEMORY_MCP_STATUS.UNKNOWN);

    await provider.connect({});

    expect(harness.startOptions[0]).toMatchObject({ hostname: '127.0.0.1' });
    expect(Number(harness.startOptions[0]?.port)).toBeGreaterThan(0);
    expect(provider.getMemoryMcpStatus()).toMatchObject({
      providerId: 'opencode-sdk',
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
    });
    await provider.disconnect();
    expect(harness.server.close).toHaveBeenCalledOnce();
  });

  it('maps streaming text, tools, permissions, usage and duplicate terminals exactly once', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      harness.startOptions.push(options as unknown as Record<string, unknown>);
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const deltas: any[] = [];
    const tools: any[] = [];
    const approvals: any[] = [];
    const usage: any[] = [];
    const completions: any[] = [];
    provider.onDelta((sessionId, delta) => deltas.push({ sessionId, ...delta }));
    provider.onToolCall((sessionId, tool) => tools.push({ sessionId, ...tool }));
    provider.onApprovalRequest((sessionId, approval) => approvals.push({ sessionId, ...approval }));
    provider.onUsage((sessionId, update) => usage.push({ sessionId, ...update }));
    provider.onComplete((sessionId, message) => completions.push({ sessionId, ...message }));
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-1',
      sessionName: 'deck_proj_brain',
      cwd: '/tmp/project',
      agentId: 'anthropic/claude-sonnet-4-5',
    });
    expect(harness.startOptions[1]).toEqual(expect.objectContaining({
      hostname: '127.0.0.1',
      config: expect.objectContaining({
        share: 'disabled',
        mcp: expect.objectContaining({
          'imcodes-memory': expect.objectContaining({
            type: 'local',
            command: ['imcodes', 'memory', 'mcp'],
            environment: expect.objectContaining({ IMCODES_DAEMON_SESSION_NAME: 'deck_proj_brain' }),
          }),
        }),
      }),
    }));

    await provider.send(routeId, {
      userMessage: 'hello',
      assembledMessage: 'hello',
      sessionSystemText: 'system context',
      turnSystemText: undefined,
      systemText: undefined,
      messagePreamble: undefined,
      attachments: [{ id: 'a', daemonPath: '/tmp/image.png', type: 'image', mime: 'image/png' }],
      context: {
        sessionSystemText: 'system context', turnSystemText: undefined, systemText: undefined,
        messagePreamble: undefined, requiredAuthoredContext: [], advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [], diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'p' }, authoritySource: 'none', freshness: 'fresh',
        fallbackAllowed: true, retryScheduled: false, providerPolicyOutcome: 'allowed', diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    });
    expect(harness.client.session.prompt).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: 'oc-session-1' },
      query: { directory: '/tmp/project' },
      body: expect.objectContaining({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
        system: 'system context',
        parts: [
          { type: 'text', text: 'hello' },
          expect.objectContaining({ type: 'file', mime: 'image/png', url: 'file:///tmp/image.png' }),
        ],
      }),
    }));
    expect(harness.client.event.subscribe).toHaveBeenCalledWith(expect.objectContaining({
      query: { directory: '/tmp/project' },
      signal: expect.any(AbortSignal),
    }));

    harness.queue.push({
      type: 'message.part.updated',
      properties: { part: { id: 'part-1', sessionID: 'oc-session-1', messageID: 'msg-1', type: 'text', text: 'Hello' } },
    });
    harness.queue.push({
      type: 'message.part.updated',
      properties: { part: { id: 'tool-1', callID: 'call-1', sessionID: 'oc-session-1', messageID: 'msg-1', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'pwd' } } } },
    });
    harness.queue.push({
      type: 'message.part.updated',
      properties: { part: { id: 'tool-1', callID: 'call-1', sessionID: 'oc-session-1', messageID: 'msg-1', type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' }, output: '/tmp/project' } } },
    });
    harness.queue.push({
      type: 'permission.updated',
      properties: { id: 'perm-1', sessionID: 'oc-session-1', messageID: 'msg-1', type: 'bash', title: 'Run pwd', pattern: 'pwd', metadata: {} },
    });
    harness.queue.push({
      type: 'message.updated',
      properties: { info: { id: 'msg-1', sessionID: 'oc-session-1', role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4-5', cost: 0.02, tokens: { input: 10, output: 5, cache: { read: 3, write: 2 } } } },
    });
    harness.queue.push({ type: 'session.idle', properties: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(completions).toHaveLength(1));

    expect(deltas.at(-1)).toMatchObject({ sessionId: 'route-1', messageId: 'msg-1', delta: 'Hello' });
    expect(tools).toEqual([
      expect.objectContaining({ sessionId: 'route-1', id: 'call-1', name: 'bash', status: 'running' }),
      expect.objectContaining({ sessionId: 'route-1', id: 'call-1', name: 'bash', status: 'complete', output: '/tmp/project' }),
    ]);
    expect(approvals).toEqual([expect.objectContaining({ sessionId: 'route-1', id: 'perm-1', tool: 'bash' })]);
    expect(usage).toEqual([expect.objectContaining({
      sessionId: 'route-1', messageId: 'msg-1', finalized: true,
      usage: expect.objectContaining({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
        model_context_window: 1_000_000,
      }),
    })]);
    expect(completions[0]).toMatchObject({ sessionId: 'route-1', id: 'msg-1', content: 'Hello', status: 'complete' });

    await provider.respondApproval(routeId, 'perm-1', true);
    expect(harness.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: 'oc-session-1', permissionID: 'perm-1' }, body: { response: 'once' },
    }));

    harness.prompt.resolve({
      data: {
        info: { id: 'msg-1', sessionID: 'oc-session-1', role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4-5', cost: 0.02, tokens: { input: 10, output: 5, cache: { read: 3, write: 2 } } },
        parts: [{ id: 'part-1', sessionID: 'oc-session-1', messageID: 'msg-1', type: 'text', text: 'Hello' }],
      },
    });
    await Promise.resolve();
    expect(completions).toHaveLength(1);
    await provider.disconnect();
  });

  it('self-heals the model context window when the first catalog snapshot lacked limits', async () => {
    const harness = createHarness();
    let serveWarm = false;
    const catalog = (withLimit: boolean) => ({
      connected: ['anthropic'],
      default: { anthropic: 'claude-sonnet-4-5' },
      all: [{
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-sonnet-4-5': {
            id: 'claude-sonnet-4-5',
            name: 'Claude Sonnet 4.5',
            reasoning: true,
            // Cold models.dev snapshot: no `limit` yet. Warms up on refetch.
            ...(withLimit ? { limit: { context: 200_000, output: 128_000 } } : {}),
          },
        },
      }],
    });
    harness.client.provider.list = vi.fn(() => result(catalog(serveWarm)));
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      harness.startOptions.push(options as unknown as Record<string, unknown>);
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const usage: any[] = [];
    provider.onUsage((sessionId, update) => usage.push({ sessionId, ...update }));
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'route-heal',
      sessionName: 'deck_proj_brain',
      cwd: '/tmp/project',
      agentId: 'anthropic/claude-sonnet-4-5',
    });

    // The cold prime cached a catalog without limits; catalog now warms up.
    const primeListCalls = harness.client.provider.list.mock.calls.length;
    serveWarm = true;

    // First usage frame can't resolve the window → ships without one (the relay
    // would then fall back to a 1M guess) and must trigger a catalog refetch.
    harness.queue.push({
      type: 'message.updated',
      properties: { info: { id: 'msg-1', sessionID: 'oc-session-1', role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4-5', tokens: { input: 10, output: 5, cache: { read: 3, write: 2 } } } },
    });
    await vi.waitFor(() => expect(usage).toHaveLength(1));
    expect(usage[0].usage).not.toHaveProperty('model_context_window');

    // The miss forces exactly one refetch, which now carries the real limit.
    await vi.waitFor(() => expect(harness.client.provider.list.mock.calls.length).toBeGreaterThan(primeListCalls));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Next usage frame self-heals to the authoritative 200k window, not 1M.
    harness.queue.push({
      type: 'message.updated',
      properties: { info: { id: 'msg-2', sessionID: 'oc-session-1', role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4-5', tokens: { input: 12, output: 6, cache: { read: 4, write: 2 } } } },
    });
    await vi.waitFor(() => expect(usage.at(-1)?.usage?.model_context_window).toBe(200_000));

    await provider.disconnect();
  });

  it('ignores a stale busy status frame that arrives after the turn completed', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      harness.startOptions.push(options as unknown as Record<string, unknown>);
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const statuses: Array<{ status: string | null; label?: string | null }> = [];
    const completions: any[] = [];
    provider.onStatus((_sid, s) => statuses.push(s));
    provider.onComplete((_sid, m) => completions.push(m));
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-status',
      cwd: '/tmp/project',
      agentId: 'anthropic/claude-sonnet-4-5',
    });

    await provider.send(routeId, 'go');
    expect(statuses.at(-1)).toMatchObject({ status: 'working' });

    // A busy frame is honored while the turn is live (proves the event loop routes it).
    harness.queue.push({ type: 'session.status', properties: { sessionID: 'oc-session-1', status: { type: 'busy' } } });
    await vi.waitFor(() => expect(statuses.filter((s) => s.status === 'working').length).toBeGreaterThanOrEqual(2));

    // Turn completes → status cleared + completion emitted.
    harness.queue.push({ type: 'session.idle', properties: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(statuses.at(-1)).toMatchObject({ status: null, label: null });
    const countAfterComplete = statuses.length;

    // A STALE busy frame (a delayed SSE flush after the tool restarted the
    // network) must NOT re-show "working" — regression: the footer got stranded
    // on "OpenCode is working…" while the session was already idle.
    harness.queue.push({ type: 'session.status', properties: { sessionID: 'oc-session-1', status: { type: 'busy' } } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statuses.length).toBe(countAfterComplete);
    expect(statuses.at(-1)).toMatchObject({ status: null });

    await provider.disconnect();
  });

  it('never echoes normalized user context as assistant text and buffers parts until their role is known', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const deltas: any[] = [];
    const completions: any[] = [];
    provider.onDelta((sessionId, delta) => deltas.push({ sessionId, ...delta }));
    provider.onComplete((sessionId, message) => completions.push({ sessionId, ...message }));
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-role-filter',
      cwd: '/tmp/project',
      agentId: 'anthropic/claude-sonnet-4-5',
    });
    const assembledMessage = [
      '[Related past work]',
      '<related-past-work advisory="true">',
      '- Keep this as reference only',
      '</related-past-work>',
      '',
      'run deploy-subs.sh',
    ].join('\n');
    await provider.send(routeId, assembledMessage);

    harness.queue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-user',
          sessionID: 'oc-session-1',
          messageID: 'msg-user',
          type: 'text',
          text: assembledMessage,
        },
      },
    });
    await Promise.resolve();
    expect(deltas).toHaveLength(0);

    harness.queue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-user',
          sessionID: 'oc-session-1',
          role: 'user',
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
          time: { created: 1 },
        },
      },
    });
    harness.queue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-user',
          sessionID: 'oc-session-1',
          messageID: 'msg-user',
          type: 'text',
          text: `${assembledMessage}\nignored update`,
        },
      },
    });
    await Promise.resolve();
    expect(deltas).toHaveLength(0);

    harness.queue.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-assistant',
          sessionID: 'oc-session-1',
          messageID: 'msg-assistant',
          type: 'text',
          text: 'Deployment complete',
        },
      },
    });
    await Promise.resolve();
    expect(deltas).toHaveLength(0);

    harness.queue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-assistant',
          sessionID: 'oc-session-1',
          role: 'assistant',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
          cost: 0.01,
          tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } },
          time: { created: 2 },
        },
      },
    });
    await vi.waitFor(() => expect(deltas).toHaveLength(1));
    expect(deltas[0]).toMatchObject({
      sessionId: 'route-role-filter',
      messageId: 'msg-assistant',
      delta: 'Deployment complete',
      role: 'assistant',
    });
    expect(deltas[0].delta).not.toContain('[Related past work]');

    harness.queue.push({ type: 'session.idle', properties: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]).toMatchObject({
      id: 'msg-assistant',
      content: 'Deployment complete',
      status: 'complete',
    });
    await provider.disconnect();
  });

  it('ignores the initial zero-token placeholder and completes with authoritative usage', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      harness.startOptions.push(options as unknown as Record<string, unknown>);
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const usage: any[] = [];
    const completions: any[] = [];
    provider.onUsage((sessionId, update) => usage.push({ sessionId, ...update }));
    provider.onComplete((sessionId, message) => completions.push({ sessionId, ...message }));

    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-placeholder',
      cwd: '/tmp/project',
      agentId: 'anthropic/claude-sonnet-4-5',
    });
    await provider.send(routeId, 'hello');

    harness.prompt.resolve({
      data: {
        info: {
          id: 'msg-placeholder',
          sessionID: 'oc-session-1',
          role: 'assistant',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      },
    });
    await vi.waitFor(() => expect(usage).toHaveLength(1));

    expect(completions).toHaveLength(0);
    expect(usage[0]).toMatchObject({
      sessionId: 'route-placeholder',
      messageId: 'msg-placeholder',
      finalized: false,
      usage: { model_context_window: 1_000_000 },
    });
    expect(usage[0].usage).not.toHaveProperty('input_tokens');
    expect(usage[0].usage).not.toHaveProperty('cache_read_input_tokens');

    harness.queue.push({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-placeholder',
          sessionID: 'oc-session-1',
          role: 'assistant',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
          finish: 'stop',
          time: { completed: 123 },
          cost: 0.01,
          tokens: { input: 90, output: 123, cache: { read: 88_192, write: 0 } },
        },
      },
    });
    await vi.waitFor(() => expect(completions).toHaveLength(1));

    expect(usage.at(-1)).toMatchObject({
      sessionId: 'route-placeholder',
      messageId: 'msg-placeholder',
      finalized: true,
      usage: {
        input_tokens: 90,
        output_tokens: 123,
        cache_read_input_tokens: 88_192,
        cache_creation_input_tokens: 0,
        model_context_window: 1_000_000,
      },
    });
    expect(completions[0]).toMatchObject({
      sessionId: 'route-placeholder',
      id: 'msg-placeholder',
      status: 'complete',
      metadata: {
        usage: {
          input_tokens: 90,
          output_tokens: 123,
          cache_read_input_tokens: 88_192,
          model_context_window: 1_000_000,
        },
      },
    });

    harness.queue.push({ type: 'session.idle', properties: { sessionID: 'oc-session-1' } });
    await Promise.resolve();
    expect(completions).toHaveLength(1);
    await provider.disconnect();
  });

  it('restores provider sessions, discovers connected models and cancels active work', async () => {
    const harness = createHarness();
    harness.sessions.set('resume-1', { id: 'resume-1', title: 'Restored', time: { updated: 12 } });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const errors: any[] = [];
    provider.onError((sessionId, error) => errors.push({ sessionId, ...error }));
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'ephemeral-route', cwd: '/tmp/project', skipCreate: true, resumeId: 'resume-1',
    });
    expect(routeId).toBe('ephemeral-route');
    expect(await provider.restoreSession('resume-1')).toBe(true);
    expect((await provider.listSessions())[0]).toMatchObject({ key: 'resume-1', displayName: 'Restored' });
    expect(await provider.listModels()).toMatchObject({
      defaultModel: 'anthropic/claude-sonnet-4-5',
      isAuthenticated: true,
      models: [expect.objectContaining({ id: 'anthropic/claude-sonnet-4-5', supportsReasoningEffort: true })],
    });

    await provider.send(routeId, 'work');
    await provider.cancel(routeId);
    expect(harness.client.session.abort).toHaveBeenCalledWith(expect.objectContaining({ path: { id: 'resume-1' } }));
    expect(errors).toEqual([expect.objectContaining({ sessionId: 'ephemeral-route', code: 'CANCELLED' })]);
    await provider.disconnect();
  });

  it('returns an actionable error when the OpenCode executable is missing', async () => {
    openCodeSdkRuntimeHooks.start = vi.fn(async () => {
      const error = new Error('spawn opencode ENOENT');
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    });
    const provider = new OpenCodeSdkProvider();

    await expect(provider.connect({})).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      recoverable: false,
      message: expect.stringContaining('Install OpenCode'),
    });
  });

  it('closes a started session server when event subscription fails', async () => {
    const harness = createHarness();
    const catalogServer = { url: 'http://127.0.0.1:45678', close: vi.fn() };
    const sessionServer = { url: 'http://127.0.0.1:45679', close: vi.fn() };
    let startCount = 0;
    harness.client.event.subscribe.mockRejectedValue(new Error('subscribe failed after process spawn'));
    openCodeSdkRuntimeHooks.start = vi.fn(async () => {
      startCount += 1;
      return {
        client: harness.client as any,
        server: startCount === 1 ? catalogServer : sessionServer,
      };
    });
    const provider = new OpenCodeSdkProvider();
    await provider.connect({});

    await expect(provider.createSession({ sessionKey: 'route-subscribe-fail', cwd: '/tmp/project' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('subscribe failed after process spawn'),
    });
    expect(sessionServer.close).toHaveBeenCalledOnce();
    expect(catalogServer.close).not.toHaveBeenCalled();

    await provider.disconnect();
    expect(catalogServer.close).toHaveBeenCalledOnce();
    expect(sessionServer.close).toHaveBeenCalledOnce();
  });

  it('fails closed by rejecting permission requests when no approval listener exists', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'route-no-ui', cwd: '/tmp/project' });

    harness.queue.push({
      type: 'permission.updated',
      properties: { id: 'perm-deny', sessionID: 'oc-session-1', messageID: 'msg-1', type: 'bash', title: 'Danger', metadata: {} },
    });

    await vi.waitFor(() => expect(harness.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(expect.objectContaining({
      path: { id: 'oc-session-1', permissionID: 'perm-deny' },
      body: { response: 'reject' },
    })));
    await provider.disconnect();
  });

  it('settles duplicate provider terminal errors exactly once', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const errors: any[] = [];
    const completions: any[] = [];
    provider.onError((sessionId, error) => errors.push({ sessionId, ...error }));
    provider.onComplete((sessionId, message) => completions.push({ sessionId, ...message }));
    await provider.connect({});
    const routeId = await provider.createSession({ sessionKey: 'route-error', cwd: '/tmp/project' });
    await provider.send(routeId, 'fail');

    harness.queue.push({
      type: 'session.error',
      properties: { sessionID: 'oc-session-1', error: { name: 'ProviderAuthError', message: 'upstream failed' } },
    });
    harness.prompt.reject(new Error('upstream failed again'));

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(completions).toHaveLength(0);
    await provider.disconnect();
  });
});
