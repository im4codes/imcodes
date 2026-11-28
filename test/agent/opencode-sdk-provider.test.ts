import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenCode } from '@opencode/sdk';
import {
  OpenCodeSdkProvider,
  openCodeSdkRuntimeHooks,
} from '../../src/agent/providers/opencode-sdk.js';
import { OPENCODE_NATIVE_AGENT_TOOLS } from '../../src/agent/native-agent-fence.js';
import { NATIVE_AGENT_FENCES } from '../../shared/native-collaboration-policy.js';
import {
  IMCODES_MEMORY_MCP_LAUNCH_ARGS,
  IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
} from '../../src/agent/providers/getDefaultMcpServers.js';
import type { ProviderContextPayload } from '../../shared/context-types.js';
import { MEMORY_MCP_STATUS } from '../../shared/memory-ws.js';
import { PROVIDER_ERROR_CODES } from '../../src/agent/transport-provider.js';
import { AGENT_DELEGATION_NOTIFICATION_RESULTS } from '../../shared/agent-delegation.js';
import { OPENCODE_SDK_EFFORT_LEVELS } from '../../shared/effort-levels.js';
import { SESSION_CONTROL_METADATA_COMMAND_FIELD } from '../../shared/session-control-commands.js';
import { DEFAULT_OPENCODE_MODEL_ID } from '../../src/shared/models/options.js';

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
  const waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
  let closed = false;
  let terminalError: unknown = null;
  let hasTerminalError = false;
  return {
    push(value: T) {
      if (closed || hasTerminalError) return;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else values.push(value);
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()?.resolve({ value: undefined, done: true });
    },
    fail(error: unknown) {
      hasTerminalError = true;
      terminalError = error;
      while (waiters.length) waiters.shift()?.reject(error);
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            const value = values.shift();
            if (value !== undefined) return Promise.resolve({ value, done: false });
            if (hasTerminalError) return Promise.reject(terminalError);
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
          },
        };
      },
    } as AsyncIterable<T>,
  };
}

function notFoundError(message = 'Message not found') {
  const err = new Error(message, { cause: { status: 404 } });
  err.name = 'MessageNotFoundError';
  return err;
}

function makePayload(
  overrides: Partial<ProviderContextPayload> & { userMessage: string; assembledMessage: string },
): ProviderContextPayload {
  return {
    context: {
      requiredAuthoredContext: [],
      advisoryAuthoredContext: [],
      appliedDocumentVersionIds: [],
      diagnostics: [],
    },
    authority: {
      namespace: { scope: 'personal', projectId: 'p' },
      authoritySource: 'none',
      freshness: 'fresh',
      fallbackAllowed: true,
      retryScheduled: false,
      providerPolicyOutcome: 'allowed',
      diagnostics: [],
    },
    supportClass: 'full-normalized-context-injection',
    diagnostics: [],
    ...overrides,
  };
}

function createHarness() {
  const queue = createAsyncQueue<Record<string, unknown>>();
  const sessions = new Map<string, Record<string, any>>();
  const messages = new Map<string, Record<string, any>>();
  const credentials: Array<{ id: string; integrationID: string; label?: string; active?: boolean }> = [];
  const messageOrder: string[] = [];
  const startOptions: Array<Record<string, unknown>> = [];
  let nextSession = 1;

  const sessionsApi = {
    create: vi.fn(async (input: any) => {
      const id = `oc-session-${nextSession++}`;
      const directory = input?.location?.directory;
      const session = {
        id,
        title: input?.title ?? id,
        ...(directory ? { location: { directory } } : {}),
        time: { created: 1, updated: 2 },
      };
      sessions.set(id, session);
      return session;
    }),
    get: vi.fn(async (input: any) => {
      const session = sessions.get(input?.sessionID);
      if (!session) {
        const err = new Error(`Session not found: ${input?.sessionID}`, { cause: { status: 404 } });
        err.name = 'SessionNotFoundError';
        throw err;
      }
      return session;
    }),
    prompt: vi.fn(async (input: any) => ({
      id: input?.id ?? 'msg-user-1',
      sessionID: input?.sessionID,
      type: 'user',
    })),
  };

  const client = {
    sessions: sessionsApi,
    session: {
      list: vi.fn(async (input?: any) => ({
        data: [...sessions.values()].filter((s) => (
          !input?.directory || s.location?.directory === input.directory || s.directory === input.directory
        )),
        cursor: {},
      })),
      switchModel: vi.fn(async () => undefined),
      compact: vi.fn(async () => ({ id: 'msg-compact-1' })),
      interrupt: vi.fn(async () => ({ interrupted: true })),
      active: vi.fn(async () => ({})),
      message: {
        get: vi.fn(async (input: any) => {
          const msg = messages.get(input?.messageID);
          if (!msg) throw notFoundError(`Message not found: ${input?.messageID}`);
          return msg;
        }),
      },
      form: {
        reply: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      },
    },
    message: {
      list: vi.fn(async (input?: any) => {
        const list = messageOrder
          .map((id) => messages.get(id))
          .filter((item): item is Record<string, any> => Boolean(item));
        const ordered = input?.order === 'desc' ? [...list].reverse() : list;
        return { data: ordered, cursor: {} };
      }),
    },
    provider: {
      list: vi.fn(async () => ({
        data: [{
          id: 'anthropic',
          name: 'Anthropic',
          activation: 'enabled',
        }],
      })),
    },
    model: {
      list: vi.fn(async () => ({
        data: [{
          id: 'anthropic/claude-sonnet-4-5',
          modelID: 'claude-sonnet-4-5',
          providerID: 'anthropic',
          name: 'Claude Sonnet 4.5',
          enabled: true,
          type: 'chat',
          capabilities: { reasoning: true },
          limit: { context: 1_000_000, output: 128_000 },
          variants: [],
        }],
      })),
      default: vi.fn(async () => ({
        data: {
          id: 'anthropic/claude-sonnet-4-5',
          modelID: 'claude-sonnet-4-5',
          providerID: 'anthropic',
          name: 'Claude Sonnet 4.5',
        },
      })),
    },
    events: {
      subscribe: vi.fn(async () => queue.stream),
    },
    permission: {
      reply: vi.fn(async () => undefined),
    },
    experimental: {
      session: {
        instructions: {
          entry: {
            put: vi.fn(async () => undefined),
            remove: vi.fn(async () => undefined),
          },
        },
        wait: vi.fn(async () => undefined),
      },
    },
    plugin: {
      list: vi.fn(async () => ({ data: [{ id: 'opencode-auth' }] })),
    },
    credential: {
      list: vi.fn(async () => [...credentials]),
      remove: vi.fn(async (input: { credentialID: string }) => {
        const idx = credentials.findIndex((c) => c.id === input.credentialID);
        if (idx >= 0) credentials.splice(idx, 1);
      }),
    },
    close: vi.fn(async () => undefined),
  };

  const server = { url: 'http://127.0.0.1:45678', close: vi.fn() };
  return {
    queue,
    sessions,
    messages,
    credentials,
    recordMessage(msg: Record<string, any>) {
      messages.set(msg.id, msg);
      if (!messageOrder.includes(msg.id)) messageOrder.push(msg.id);
    },
    client,
    server,
    startOptions,
  };
}

describe('OpenCodeSdkProvider', () => {
  const originalStart = openCodeSdkRuntimeHooks.start;
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    openCodeSdkRuntimeHooks.start = originalStart;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('confirms Stop on the captured provider-session idle, not interrupt ACK or another session idle', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    await provider.connect({});
    const route = await provider.createSession({ sessionKey: 'route-stop-proof', cwd: '/tmp/project' });
    await provider.send(route, 'foreground');
    let settled = false;
    const stopping = provider.cancelAndWait(route).then(() => { settled = true; });
    await vi.waitFor(() => expect(harness.client.session.interrupt).toHaveBeenCalledWith({ sessionID: 'oc-session-1' }));
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'unrelated-session' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await stopping;
    expect(settled).toBe(true);
    console.error("[T] 5 disconnect p1"); await provider.disconnect(); console.error("[T] 6 disconnected p1");
  });

  it('does not confirm an old Stop with a new run idle on the same provider session', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    await provider.connect({});
    const route = await provider.createSession({ sessionKey: 'route-stop-next-run', cwd: process.cwd() });
    await provider.send(route, 'old foreground');
    const stopping = provider.cancelAndWait(route);
    const rejected = expect(stopping).rejects.toThrow('instance changed');
    await vi.waitFor(() => expect(harness.client.session.interrupt).toHaveBeenCalledOnce());
    await provider.send(route, 'independent new foreground');
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await rejected;
    await provider.disconnect();
  });

  it('does not use early automatic compaction or uncorrelated compaction to confirm stop on an ordinary prompt', async () => {
    const harness = createHarness();
    let releaseInterrupt!: () => void;
    let hangInterrupt = true;
    harness.client.session.interrupt.mockImplementation(async () => {
      if (hangInterrupt) {
        await new Promise<void>((resolve) => { releaseInterrupt = resolve; });
      }
      return { interrupted: true };
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const errors: Array<{ sessionId: string; code: string }> = [];
    provider.onError((sid, err) => errors.push({ sessionId: sid, code: err.code }));
    await provider.connect({});
    const route = await provider.createSession({ sessionKey: 'route-auto-compact-stop', cwd: '/tmp/project' });

    await provider.send(route, 'ordinary foreground prompt');
    let settled = false;
    const cancelling = provider.cancel(route).then(() => { settled = true; });
    await vi.waitFor(() => expect(harness.client.session.interrupt).toHaveBeenCalledOnce());

    // Early auto compaction (and unkeyed legacy session.compacted) inside the 150ms interrupt window MUST NOT confirm stop!
    harness.queue.push({
      type: 'session.compaction.ended',
      data: { sessionID: 'oc-session-1', reason: 'auto' },
    });
    harness.queue.push({
      type: 'session.compacted',
      data: { sessionID: 'oc-session-1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(settled).toBe(false);
    expect(errors).toEqual([]);

    // Real session.idle settles CANCELLED once, clears busy, and enables next turn!
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await cancelling;
    expect(settled).toBe(true);
    expect(errors).toEqual([expect.objectContaining({ sessionId: route, code: PROVIDER_ERROR_CODES.CANCELLED })]);
    hangInterrupt = false;
    await provider.send(route, 'next foreground prompt');
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    releaseInterrupt?.();
    await provider.disconnect();
  });

  it('does not use a delayed prompt execution terminal to confirm stop while cancelling manual /compact', async () => {
    const harness = createHarness();
    let releaseInterrupt!: () => void;
    let hangInterrupt = true;
    harness.client.session.interrupt.mockImplementation(async () => {
      if (hangInterrupt) {
        await new Promise<void>((resolve) => { releaseInterrupt = resolve; });
      }
      return { interrupted: true };
    });
    harness.client.session.compact = vi.fn(async () => ({}));
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    let completedCount = 0;
    provider.onComplete(() => { completedCount += 1; });
    const errors: Array<{ sessionId: string; code: string }> = [];
    provider.onError((sid, err) => errors.push({ sessionId: sid, code: err.code }));
    await provider.connect({});
    const route = await provider.createSession({ sessionKey: 'route-compact-stop-proof', cwd: '/tmp/project' });

    // Preceding normal prompt finishes, leaving a delayed prompt terminal that can race into /compact.
    await provider.send(route, 'ordinary prompt before compact');
    harness.queue.push({
      type: 'session.text.delta',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-pre-compact', ordinal: 0, delta: 'ok' },
    });
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(completedCount).toBe(1));

    await provider.send(route, '/compact');
    await vi.waitFor(() => expect(harness.client.session.compact).toHaveBeenCalledTimes(1));

    let settled = false;
    const cancelling = provider.cancel(route).then(() => { settled = true; });
    await vi.waitFor(() => expect(harness.client.session.interrupt).toHaveBeenCalledTimes(1));

    // Delayed prompt execution terminals (and unrelated/auto compaction) before and after 150ms MUST NOT confirm /compact stop!
    harness.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1' } });
    harness.queue.push({ type: 'session.compaction.ended', data: { sessionID: 'oc-session-1', reason: 'auto' } });
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(settled).toBe(false);
    expect(errors).toEqual([]);
    harness.queue.push({ type: 'session.execution.interrupted', data: { sessionID: 'oc-session-1', reason: 'late' } });
    harness.queue.push({
      type: 'session.execution.failed',
      data: { sessionID: 'oc-session-1', error: { name: 'AbortError', message: 'late prompt abort' } },
    });
    await expect(provider.send(route, 'overlap during cancelled compact')).rejects.toThrow(/busy/i);
    expect(settled).toBe(false);
    expect(errors).toEqual([]);

    // Authoritative session.idle confirms stop cleanly once, releases busy, and enables next send.
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await cancelling;
    expect(settled).toBe(true);
    expect(errors).toEqual([expect.objectContaining({ sessionId: route, code: PROVIDER_ERROR_CODES.CANCELLED })]);
    releaseInterrupt?.();

    // Second manual /compact cancelled via correlated manual compaction terminal (not delayed prompt terminal).
    await provider.send(route, '/compact');
    await vi.waitFor(() => expect(harness.client.session.compact).toHaveBeenCalledTimes(2));
    const compactInputId = (harness.client.session.compact.mock.calls[1]?.[0] as { id?: string } | undefined)?.id;
    expect(compactInputId).toBeTruthy();
    let settledSecond = false;
    const cancellingSecond = provider.cancel(route).then(() => { settledSecond = true; });
    await vi.waitFor(() => expect(harness.client.session.interrupt).toHaveBeenCalledTimes(2));
    harness.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1' } });
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(settledSecond).toBe(false);
    harness.queue.push({
      type: 'session.compaction.ended',
      data: { sessionID: 'oc-session-1', reason: 'manual', inputID: compactInputId },
    });
    await cancellingSecond;
    expect(settledSecond).toBe(true);
    expect(errors).toHaveLength(2);

    hangInterrupt = false;
    releaseInterrupt?.();
    await provider.send(route, 'after cancelled compact');
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await provider.disconnect();
  });

  it('steers a correlated delegation completion through client.sessions.prompt', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-delegation-notify',
      sessionName: 'deck_project_brain',
      cwd: '/tmp/project',
    });
    await provider.send(routeId, 'foreground work');

    const result = await provider.notifyActiveDelegation?.(routeId, {
      notificationId: 'notification_identity',
      delegationId: 'delegation_identity',
      sourceSessionName: 'deck_sub_auditor',
      text: 'delegated audit finished',
    });

    expect(result).toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    expect(harness.client.sessions.prompt).toHaveBeenLastCalledWith({
      sessionID: 'oc-session-1',
      id: 'notification_identity',
      text: 'delegated audit finished',
      delivery: 'steer',
      resume: true,
    });
    expect(harness.client.session.interrupt).not.toHaveBeenCalled();
    await provider.disconnect();
  });

  it('does not replay a steer whose provider ACK races with session idle', async () => {
    const harness = createHarness();
    const steerAck = deferred<Record<string, unknown>>();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-steer-idle-race',
      sessionName: 'deck_project_brain',
      cwd: '/tmp/project',
    });
    await provider.send(routeId, 'foreground work');

    harness.client.sessions.prompt.mockImplementationOnce(() => steerAck.promise);
    const admission = provider.notifyActiveDelegation?.(routeId, {
      notificationId: 'notification_idle_race',
      delegationId: 'delegation_idle_race',
      sourceSessionName: 'deck_sub_auditor',
      text: 'accepted before idle is observed',
    });
    await vi.waitFor(() => expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(2));
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    steerAck.resolve({ id: 'notification_idle_race', type: 'user' });

    await expect(admission).resolves.toBe(AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED);
    expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(2);
    await provider.disconnect();
  });

  it('starts the v2 runtime host on loopback with databasePath and exposes connected status', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      harness.startOptions.push(options as unknown as Record<string, unknown>);
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    expect(provider.getMemoryMcpStatus().status).toBe(MEMORY_MCP_STATUS.UNKNOWN);

    await provider.connect({ databasePath: '/tmp/custom-opencode.db' } as any);

    expect(harness.startOptions[0]).toMatchObject({
      hostname: '127.0.0.1',
      databasePath: '/tmp/custom-opencode.db',
    });
    expect(provider.getMemoryMcpStatus()).toMatchObject({
      providerId: 'opencode-sdk',
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
    });
    await provider.disconnect();
    expect(harness.server.close).toHaveBeenCalledOnce();
  });

  it('detaches a stale route without unmapping or interrupting its replacement conversation', async () => {
    const harness = createHarness();
    const eventQueues: Array<ReturnType<typeof createAsyncQueue<Record<string, unknown>>>> = [];
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      const eventQueue = createAsyncQueue<Record<string, unknown>>();
      eventQueues.push(eventQueue);
      options.signal.addEventListener('abort', eventQueue.close, { once: true });
      return {
        client: {
          ...harness.client,
          events: {
            subscribe: vi.fn(async () => eventQueue.stream),
          },
        } as any,
        server: { url: harness.server.url, close: vi.fn() },
      };
    });
    const provider = new OpenCodeSdkProvider();
    const deltas: Array<{ sessionId: string; text: string }> = [];
    provider.onDelta((sessionId, delta) => deltas.push({ sessionId, text: delta.delta }));
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'route-seed',
      sessionName: 'Seed route',
      cwd: '/tmp/project',
    });
    const durableSessionId = 'oc-session-1';
    await provider.detachSession('route-seed');
    await provider.createSession({
      sessionKey: 'route-replacement-old',
      bindExistingKey: 'route-replacement-old',
      sessionName: 'Old replacement route',
      cwd: '/tmp/project',
      resumeId: durableSessionId,
      skipCreate: true,
    });
    await provider.createSession({
      sessionKey: 'route-replacement-new',
      bindExistingKey: 'route-replacement-new',
      sessionName: 'New replacement route',
      cwd: '/tmp/project',
      resumeId: durableSessionId,
      skipCreate: true,
    });
    await provider.createSession({
      sessionKey: 'route-stale-last',
      bindExistingKey: 'route-stale-last',
      sessionName: 'Stale route finishing last',
      cwd: '/tmp/project',
      resumeId: durableSessionId,
      skipCreate: true,
    });

    const sessions = (provider as any).sessions as Map<string, any>;
    const providerToRoute = (provider as any).providerToRoute as Map<string, string>;
    const staleState = sessions.get('route-stale-last');
    const replacementState = sessions.get('route-replacement-new');
    staleState.busy = true;
    expect(providerToRoute.get(durableSessionId)).toBe(staleState.routeId);

    await provider.detachSession(staleState.routeId);

    expect(sessions.has(staleState.routeId)).toBe(false);
    expect(sessions.get('route-replacement-new')).toBe(replacementState);
    expect(providerToRoute.get(durableSessionId)).toBe('route-replacement-new');
    expect(harness.client.session.interrupt).not.toHaveBeenCalled();

    replacementState.busy = true;
    eventQueues[3]?.push({
      type: 'session.step.started',
      data: {
        sessionID: durableSessionId,
        assistantMessageID: 'replacement-message',
        agent: 'build',
        model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
        started: 1,
      },
    });
    eventQueues[3]?.push({
      type: 'session.text.delta',
      data: {
        sessionID: durableSessionId,
        assistantMessageID: 'replacement-message',
        ordinal: 0,
        delta: 'replacement still streams',
      },
    });
    await vi.waitFor(() => {
      expect(deltas).toEqual([{
        sessionId: 'route-replacement-new',
        text: 'replacement still streams',
      }]);
    });
    await provider.disconnect();
  });

  it('maps v2 streaming text, tools, permissions, usage and duplicate terminals exactly once', async () => {
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
          servers: expect.objectContaining({
            'imcodes-memory': expect.objectContaining({
              type: 'local',
              command: [IMCODES_MEMORY_MCP_LAUNCH_COMMAND, ...IMCODES_MEMORY_MCP_LAUNCH_ARGS],
              environment: expect.objectContaining({ IMCODES_DAEMON_SESSION_NAME: 'deck_proj_brain' }),
            }),
          }),
        }),
      }),
    }));

    await provider.send(routeId, makePayload({
      userMessage: 'hello',
      assembledMessage: 'hello',
      sessionSystemText: 'system context',
      attachments: [{ id: 'a', daemonPath: '/tmp/image.png', type: 'image', mime: 'image/png' }],
      context: {
        sessionSystemText: 'system context', turnSystemText: undefined, systemText: undefined,
        messagePreamble: undefined, requiredAuthoredContext: [], advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [], diagnostics: [],
      },
    }));
    expect(harness.client.session.switchModel).toHaveBeenCalledWith({
      sessionID: 'oc-session-1',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
    });
    expect(harness.client.experimental.session.instructions.entry.put).toHaveBeenCalledWith({
      sessionID: 'oc-session-1',
      key: 'imcodes-system',
      value: 'system context',
    });
    expect(harness.client.sessions.prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'oc-session-1',
      id: expect.stringMatching(/^msg_[0-9a-f]{26}$/),
      text: 'hello',
      files: [{ uri: 'file:///tmp/image.png', source: { type: 'uri', uri: 'file:///tmp/image.png' } }],
    }));
    expect(harness.client.events.subscribe).toHaveBeenCalledWith({}, { signal: expect.any(AbortSignal) });

    harness.queue.push({
      type: 'session.step.started',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-1',
        agent: 'build',
        model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
        started: 1,
      },
    });
    harness.queue.push({
      type: 'session.text.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', ordinal: 0 },
    });
    harness.queue.push({
      type: 'session.text.delta',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', ordinal: 0, delta: 'Hello' },
    });
    harness.queue.push({
      type: 'session.text.ended',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', ordinal: 0, text: 'Hello' },
    });
    harness.queue.push({
      type: 'session.tool.input.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', id: 'call-1', name: 'bash' },
    });
    harness.queue.push({
      type: 'session.tool.called',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', id: 'call-1', input: { command: 'pwd' }, executed: false },
    });
    harness.queue.push({
      type: 'session.tool.success',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', id: 'call-1', content: [{ type: 'text', text: '/tmp/project' }], executed: true },
    });
    harness.queue.push({
      type: 'permission.asked',
      data: {
        id: 'perm-1',
        sessionID: 'oc-session-1',
        action: 'bash',
        resources: ['pwd'],
        message: 'Run pwd',
        source: { callID: 'call-1' },
      },
    });
    harness.queue.push({
      type: 'session.usage.updated',
      data: { sessionID: 'oc-session-1', cost: 0.02, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 3, write: 2 } } },
    });
    harness.queue.push({
      type: 'session.step.ended',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-1',
        finish: 'stop',
        cost: 0.02,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 3, write: 2 } },
      },
    });
    harness.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1' } });
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(completions).toHaveLength(1));

    expect(deltas.at(-1)).toMatchObject({ sessionId: 'route-1', messageId: 'msg-1', delta: 'Hello' });
    expect(tools).toEqual([
      expect.objectContaining({ sessionId: 'route-1', id: 'call-1', name: 'bash', status: 'running' }),
      expect.objectContaining({ sessionId: 'route-1', id: 'call-1', name: 'bash', status: 'complete', output: '/tmp/project' }),
    ]);
    expect(approvals).toEqual([expect.objectContaining({ sessionId: 'route-1', id: 'perm-1', tool: 'bash' })]);
    expect(usage[0]).toMatchObject({
      sessionId: 'route-1',
      messageId: 'msg-1',
      finalized: false,
      usage: expect.objectContaining({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
        model_context_window: 1_000_000,
      }),
    });
    expect(completions[0]).toMatchObject({ sessionId: 'route-1', id: 'msg-1', content: 'Hello', status: 'complete' });

    await provider.respondApproval(routeId, 'perm-1', true);
    expect(harness.client.permission.reply).toHaveBeenCalledWith({
      sessionID: 'oc-session-1',
      requestID: 'perm-1',
      decision: 'once',
    });

    expect(completions).toHaveLength(1);
    await provider.disconnect();
  });

  it('submits normal turns through client.sessions.prompt with a stable message ID', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-prompt-submit',
      cwd: '/tmp/project',
      agentId: 'anthropic/claude-sonnet-4-5',
    });

    await provider.send(routeId, makePayload({
      userMessage: 'run the monitor',
      assembledMessage: 'run the monitor',
      deliveryId: 'cron-command-1',
    }));

    expect(harness.client.sessions.prompt).toHaveBeenCalledOnce();
    expect(harness.client.sessions.prompt).toHaveBeenCalledWith({
      sessionID: 'oc-session-1',
      id: expect.stringMatching(/^msg_[0-9a-f]{26}$/),
      text: 'run the monitor',
    });
    await provider.disconnect();
  });

  it('does not submit a second prompt when a failed sessions.prompt request was already accepted', async () => {
    const harness = createHarness();
    harness.client.sessions.prompt.mockImplementationOnce(async (input: any) => {
      harness.recordMessage({
        id: input.id,
        type: 'user',
        content: [{ type: 'text', text: input.text }],
      });
      throw new TypeError('fetch failed');
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-prompt-accepted',
      cwd: '/tmp/project',
    });
    const payload = makePayload({
      userMessage: 'inspect the service',
      assembledMessage: 'inspect the service',
      deliveryId: 'cron-command-accepted',
    });

    await expect(provider.send(routeId, payload)).resolves.toBeUndefined();
    await expect(provider.send(routeId, payload)).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: 'OpenCode session is already busy',
    });

    expect(harness.client.sessions.prompt).toHaveBeenCalledOnce();
    expect(harness.client.session.message.get).toHaveBeenCalled();
    await provider.disconnect();
  });

  it('deduplicates the same stable delivery id after the provider client restarts', async () => {
    const harness = createHarness();
    harness.client.sessions.prompt.mockImplementation(async (input: any) => {
      harness.recordMessage({
        id: input.id,
        type: 'user',
        content: [{ type: 'text', text: input.text }],
      });
      return { id: input.id, type: 'user' };
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const payload = makePayload({
      userMessage: 'audit the exact revision',
      assembledMessage: 'audit the exact revision',
      deliveryId: 'stable-auto-audit-delivery',
    });

    const first = new OpenCodeSdkProvider();
    await first.connect({});
    const firstRoute = await first.createSession({
      sessionKey: 'restart-stable-route',
      cwd: '/tmp/project',
    });
    await first.send(firstRoute, payload);
    expect(first.capabilities.restartDurableDeliveryId).toEqual({
      restartDurable: true,
      replayAfterAcceptance: 'deduplicated',
    });
    const acceptedMessageId = harness.client.sessions.prompt.mock.calls[0]![0].id;
    await first.disconnect();

    const restarted = new OpenCodeSdkProvider();
    await restarted.connect({});
    const restartedRoute = await restarted.createSession({
      sessionKey: 'restart-stable-route',
      cwd: '/tmp/project',
      skipCreate: true,
      resumeId: 'oc-session-1',
    });
    await restarted.send(restartedRoute, payload);

    expect(harness.client.sessions.prompt).toHaveBeenCalledOnce();
    expect(harness.client.session.message.get).toHaveBeenCalledWith({
      sessionID: 'oc-session-1',
      messageID: acceptedMessageId,
    });
    await restarted.disconnect();
  });

  it('surfaces a missing prompt delivery as recoverable and reuses its message ID on retry', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.client.sessions.prompt
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
      .mockImplementationOnce(async (input: any) => ({ id: input.id, type: 'user' }));
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-prompt-retry',
      cwd: '/tmp/project',
    });
    const payload = makePayload({
      userMessage: 'inspect the service',
      assembledMessage: 'inspect the service',
      deliveryId: 'cron-command-retry',
    });

    const firstSend = provider.send(routeId, payload).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(firstSend).resolves.toMatchObject({
      error: {
        code: PROVIDER_ERROR_CODES.CONNECTION_LOST,
        recoverable: true,
        message: expect.stringContaining('fetch failed'),
      },
    });
    await expect(provider.send(routeId, payload)).resolves.toBeUndefined();

    expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(2);
    const firstMessageId = harness.client.sessions.prompt.mock.calls[0]?.[0].id;
    const secondMessageId = harness.client.sessions.prompt.mock.calls[1]?.[0].id;
    expect(firstMessageId).toMatch(/^msg_[0-9a-f]{26}$/);
    expect(secondMessageId).toBe(firstMessageId);
    await provider.disconnect();
  });

  it('keeps an unobservable prompt delivery recoverable without calling it absent', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.client.session.message.get
      .mockRejectedValueOnce(notFoundError())
      .mockRejectedValue(new TypeError('fetch failed'));
    harness.client.sessions.prompt.mockRejectedValueOnce(new TypeError('fetch failed'));
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-prompt-unknown',
      cwd: '/tmp/project',
    });
    const send = provider.send(routeId, makePayload({
      userMessage: 'inspect the service',
      assembledMessage: 'inspect the service',
      deliveryId: 'cron-command-unknown',
    })).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(send).resolves.toMatchObject({
      error: {
        code: PROVIDER_ERROR_CODES.CONNECTION_LOST,
        recoverable: true,
        message: expect.stringContaining('fetch failed'),
      },
    });
    expect(harness.client.sessions.prompt).toHaveBeenCalledOnce();
    expect(harness.client.session.message.get).toHaveBeenCalledTimes(6);
    await provider.disconnect();
  });

  it('handles current OpenCode permission events without duplicating approval requests', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const approvals: any[] = [];
    provider.onApprovalRequest((sessionId, approval) => approvals.push({ sessionId, ...approval }));
    await provider.connect({});
    const routeId = await provider.createSession({ sessionKey: 'route-modern-permissions', cwd: '/tmp/project' });

    const asked = {
      type: 'permission.asked',
      data: {
        id: 'perm-asked',
        sessionID: 'oc-session-1',
        action: 'external_directory',
        resources: ['/tmp/*'],
        metadata: {},
        source: { callID: 'call-asked' },
      },
    };
    harness.queue.push(asked);
    harness.queue.push(asked);
    harness.queue.push({
      type: 'permission.v2.asked',
      data: {
        id: 'perm-v2',
        sessionID: 'oc-session-1',
        action: 'external_directory',
        resources: ['/var/tmp/*'],
        metadata: {},
        source: { callID: 'call-v2' },
      },
    });

    await vi.waitFor(() => expect(approvals).toHaveLength(2));
    expect(approvals).toEqual([
      expect.objectContaining({
        sessionId: routeId,
        id: 'perm-asked',
        tool: 'external_directory',
        providerToolUseId: 'call-asked',
        inputPreview: '/tmp/*',
        description: 'Allow OpenCode external_directory: /tmp/*',
      }),
      expect.objectContaining({
        sessionId: routeId,
        id: 'perm-v2',
        tool: 'external_directory',
        providerToolUseId: 'call-v2',
        inputPreview: '/var/tmp/*',
        description: 'Allow OpenCode external_directory: /var/tmp/*',
      }),
    ]);

    await provider.respondApproval(routeId, 'perm-asked', true);
    await provider.respondApproval(routeId, 'perm-v2', false);
    expect(harness.client.permission.reply).toHaveBeenNthCalledWith(1, {
      sessionID: 'oc-session-1',
      requestID: 'perm-asked',
      decision: 'once',
    });
    expect(harness.client.permission.reply).toHaveBeenNthCalledWith(2, {
      sessionID: 'oc-session-1',
      requestID: 'perm-v2',
      decision: 'reject',
    });
    await provider.disconnect();
  });

  it('self-heals the model context window when the first catalog snapshot lacked limits', async () => {
    const harness = createHarness();
    let serveWarm = false;
    harness.client.model.list = vi.fn(async () => ({
      data: [{
        id: 'anthropic/claude-sonnet-4-5',
        modelID: 'claude-sonnet-4-5',
        providerID: 'anthropic',
        name: 'Claude Sonnet 4.5',
        enabled: true,
        type: 'chat',
        capabilities: { reasoning: true },
        variants: [],
        ...(serveWarm ? { limit: { context: 200_000, output: 128_000 } } : {}),
      }],
    }));
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

    const primeListCalls = harness.client.model.list.mock.calls.length;
    serveWarm = true;

    harness.queue.push({
      type: 'session.step.started',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-1',
        agent: 'build',
        model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
        started: 1,
      },
    });
    harness.queue.push({
      type: 'session.usage.updated',
      data: { sessionID: 'oc-session-1', cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 3, write: 2 } } },
    });
    await vi.waitFor(() => expect(usage).toHaveLength(1));
    expect(usage[0].usage).not.toHaveProperty('model_context_window');

    await vi.waitFor(() => expect(harness.client.model.list.mock.calls.length).toBeGreaterThan(primeListCalls));
    await new Promise((resolve) => setTimeout(resolve, 0));

    harness.queue.push({
      type: 'session.step.started',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-2',
        agent: 'build',
        model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
        started: 2,
      },
    });
    harness.queue.push({
      type: 'session.usage.updated',
      data: { sessionID: 'oc-session-1', cost: 0.02, tokens: { input: 12, output: 6, reasoning: 0, cache: { read: 4, write: 2 } } },
    });
    await vi.waitFor(() => expect(usage.at(-1)?.usage?.model_context_window).toBe(200_000));

    await provider.disconnect();
  });

  it('ignores stale progress frames and reasoning events that arrive after the turn completed', async () => {
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

    harness.queue.push({ type: 'session.status', data: { sessionID: 'oc-session-1', status: { type: 'busy' } } });
    await vi.waitFor(() => expect(statuses.filter((s) => s.status === 'working').length).toBeGreaterThanOrEqual(2));

    harness.queue.push({
      type: 'session.step.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-status', agent: 'build', model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' }, started: 1 },
    });
    harness.queue.push({
      type: 'session.text.delta',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-status', ordinal: 0, delta: 'Done.' },
    });
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(statuses.at(-1)).toMatchObject({ status: null, label: null });
    const countAfterComplete = statuses.length;

    harness.queue.push({ type: 'session.status', data: { sessionID: 'oc-session-1', status: { type: 'busy' } } });
    harness.queue.push({
      type: 'session.reasoning.delta',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-status', ordinal: 0, delta: 'stale reasoning' },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statuses.length).toBe(countAfterComplete);
    expect(statuses.at(-1)).toMatchObject({ status: null });

    await provider.disconnect();
  });

  it('streams assistant text deltas without echoing normalized user context', async () => {
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
      type: 'session.step.started',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-assistant',
        agent: 'build',
        model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
        started: 1,
      },
    });
    harness.queue.push({
      type: 'session.text.delta',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-assistant',
        ordinal: 0,
        delta: 'Deployment complete',
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

    harness.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1' } });
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

    harness.queue.push({
      type: 'session.step.started',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-placeholder',
        agent: 'build',
        model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' },
        started: 1,
      },
    });
    harness.queue.push({
      type: 'session.usage.updated',
      data: {
        sessionID: 'oc-session-1',
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
      type: 'session.text.delta',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-placeholder',
        ordinal: 0,
        delta: 'Done.',
      },
    });
    harness.queue.push({
      type: 'session.step.ended',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-placeholder',
        finish: 'stop',
        cost: 0.01,
        tokens: { input: 90, output: 123, reasoning: 0, cache: { read: 88_192, write: 0 } },
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
      content: 'Done.',
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

    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await Promise.resolve();
    expect(completions).toHaveLength(1);
    await provider.disconnect();
  });

  it('keeps the turn running across completed tool-call steps until a final assistant message', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const tools: any[] = [];
    const completions: any[] = [];
    const errors: any[] = [];
    provider.onToolCall((sessionId, tool) => tools.push({ sessionId, ...tool }));
    provider.onComplete((sessionId, message) => completions.push({ sessionId, ...message }));
    provider.onError((sessionId, error) => errors.push({ sessionId, ...error }));

    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-tool-steps',
      cwd: '/tmp/project',
      agentId: 'opencode/deepseek-v4-flash-free',
    });
    await provider.send(routeId, 'inspect presets');

    harness.queue.push({
      type: 'session.step.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-tool-step', agent: 'build', model: { providerID: 'opencode', id: 'deepseek-v4-flash-free' }, started: 1 },
    });
    harness.queue.push({
      type: 'session.tool.input.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-tool-step', id: 'call-tool-step', name: 'grep' },
    });
    harness.queue.push({
      type: 'session.tool.called',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-tool-step', id: 'call-tool-step', input: { pattern: 'preset' }, executed: false },
    });
    harness.queue.push({
      type: 'session.tool.success',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-tool-step', id: 'call-tool-step', content: [{ type: 'text', text: 'match' }], executed: true },
    });
    harness.queue.push({
      type: 'session.step.ended',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-tool-step',
        finish: 'tool-calls',
        cost: 0,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    await vi.waitFor(() => expect(tools).toHaveLength(2));
    expect(completions).toHaveLength(0);
    expect(errors).toHaveLength(0);

    harness.queue.push({
      type: 'session.step.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-final', agent: 'build', model: { providerID: 'opencode', id: 'deepseek-v4-flash-free' }, started: 2 },
    });
    harness.queue.push({
      type: 'session.text.delta',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-final', ordinal: 0, delta: 'Preset inspection complete.' },
    });
    harness.queue.push({
      type: 'session.step.ended',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-final',
        finish: 'stop',
        cost: 0,
        tokens: { input: 20, output: 8, reasoning: 0, cache: { read: 4, write: 0 } },
      },
    });

    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]).toMatchObject({
      sessionId: routeId,
      id: 'msg-final',
      content: 'Preset inspection complete.',
      status: 'complete',
    });
    expect(errors).toHaveLength(0);
    await provider.disconnect();
  });

  it('treats a self-managed cron SILENT tool result as terminal and stops speculative tools', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const tools: any[] = [];
    const completions: any[] = [];
    provider.onToolCall((sessionId, tool) => tools.push({ sessionId, ...tool }));
    provider.onComplete((sessionId, message) => completions.push({ sessionId, ...message }));

    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-cron-silent',
      cwd: '/tmp/project',
      agentId: 'opencode/deepseek-v4-flash-free',
    });
    await provider.send(routeId, 'run monitor\n\n<imcodes-cron-control id="cron-1">');
    harness.queue.push({
      type: 'session.tool.input.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-cron-tool', id: 'call-cron-tool', name: 'bash' },
    });
    harness.queue.push({
      type: 'session.tool.success',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-cron-tool', id: 'call-cron-tool', content: [{ type: 'text', text: 'SILENT\n' }], executed: true },
    });

    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]).toMatchObject({
      sessionId: routeId,
      content: 'SILENT',
      status: 'complete',
      metadata: { source: 'cron.tool.silent' },
    });
    expect(tools).toHaveLength(1);
    expect(harness.client.session.interrupt).not.toHaveBeenCalled();

    harness.queue.push({
      type: 'session.tool.input.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-cron-tool', id: 'call-unrequested-fetch', name: 'webfetch' },
    });
    harness.queue.push({
      type: 'session.tool.success',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-cron-tool', id: 'call-unrequested-fetch', content: [{ type: 'text', text: 'should be ignored' }], executed: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tools).toHaveLength(1);
    await provider.disconnect();
  });

  it('does not treat a SILENT tool result as terminal outside a self-managed cron turn', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const tools: any[] = [];
    const completions: any[] = [];
    provider.onToolCall((sessionId, tool) => tools.push({ sessionId, ...tool }));
    provider.onComplete((sessionId, message) => completions.push({ sessionId, ...message }));

    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-ordinary-silent-tool',
      cwd: '/tmp/project',
      agentId: 'opencode/deepseek-v4-flash-free',
    });
    await provider.send(routeId, 'run a normal command');
    harness.queue.push({
      type: 'session.tool.input.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-ordinary-tool', id: 'call-ordinary-tool', name: 'bash' },
    });
    harness.queue.push({
      type: 'session.tool.success',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-ordinary-tool', id: 'call-ordinary-tool', content: [{ type: 'text', text: 'SILENT\n' }], executed: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tools).toHaveLength(1);
    expect(completions).toHaveLength(0);
    expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(1);

    harness.queue.push({
      type: 'session.step.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-ordinary-final', agent: 'build', model: { providerID: 'opencode', id: 'deepseek-v4-flash-free' }, started: 2 },
    });
    harness.queue.push({
      type: 'session.text.delta',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-ordinary-final', ordinal: 0, delta: 'Normal final response.' },
    });
    harness.queue.push({
      type: 'session.step.ended',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-ordinary-final',
        finish: 'stop',
        cost: 0,
        tokens: { input: 5, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });

    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]).toMatchObject({
      sessionId: routeId,
      content: 'Normal final response.',
      metadata: { source: 'session.step.ended' },
    });
    await provider.disconnect();
  });

  it('recovers once when OpenCode becomes idle after tools without a final response', async () => {
    const harness = createHarness();
    const waitGate = deferred<void>();
    harness.client.experimental.session.wait.mockImplementationOnce(async () => {
      await waitGate.promise;
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const completions: any[] = [];
    const errors: any[] = [];
    provider.onComplete((sessionId, message) => completions.push({ sessionId, ...message }));
    provider.onError((sessionId, error) => errors.push({ sessionId, ...error }));

    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-empty-final',
      cwd: '/tmp/project',
      agentId: 'opencode/deepseek-v4-flash-free',
    });
    await provider.send(routeId, 'inspect presets');

    // Older completed message exists before recovery, verifying searchPool does not grab older messages if recovery has no reply yet.
    harness.recordMessage({
      id: 'msg-older-ignored',
      type: 'assistant',
      finish: 'stop',
      content: [{ type: 'text', text: 'Should never be mistakenly re-emitted' }],
    });

    harness.queue.push({
      type: 'session.step.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-tool-step', agent: 'build', model: { providerID: 'opencode', id: 'deepseek-v4-flash-free' }, started: 1 },
    });
    harness.queue.push({
      type: 'session.text.delta',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-tool-step', ordinal: 0, delta: '\n\n' },
    });
    harness.queue.push({
      type: 'session.step.ended',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-tool-step',
        finish: 'tool-calls',
        cost: 0,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    await Promise.resolve();
    expect(completions).toHaveLength(0);
    expect(errors).toHaveLength(0);

    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(2));
    expect(completions).toHaveLength(0);
    expect(errors).toHaveLength(0);
    const recoveryCall = harness.client.sessions.prompt.mock.calls[1]![0];
    expect(recoveryCall).toMatchObject({
      sessionID: 'oc-session-1',
      text: expect.stringContaining("answer the user's original request now"),
    });

    harness.recordMessage({ id: recoveryCall.id, type: 'user', content: [{ type: 'text', text: recoveryCall.text }] });
    harness.recordMessage({
      id: 'msg-recovered-final',
      type: 'assistant',
      model: { providerID: 'opencode', id: 'deepseek-v4-flash-free' },
      finish: 'stop',
      tokens: { input: 25, output: 12, reasoning: 0, cache: { read: 4, write: 0 } },
      content: [{ type: 'text', text: 'The project contains 42 TypeScript lines.' }],
    });
    waitGate.resolve();

    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]).toMatchObject({
      sessionId: routeId,
      id: 'msg-recovered-final',
      content: '\n\nThe project contains 42 TypeScript lines.',
      status: 'complete',
    });
    expect(errors).toHaveLength(0);
    await provider.disconnect();
  });

  it('waits for final step completion instead of recovering on intermediate tool-calls step alone', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const completions: any[] = [];
    const errors: any[] = [];
    provider.onComplete((sessionId, message) => completions.push({ sessionId, ...message }));
    provider.onError((sessionId, error) => errors.push({ sessionId, ...error }));

    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-late-final-part',
      cwd: '/tmp/project',
      agentId: 'opencode/deepseek-v4-flash-free',
    });
    await provider.send(routeId, 'inspect presets');

    harness.queue.push({
      type: 'session.step.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-late-final', agent: 'build', model: { providerID: 'opencode', id: 'deepseek-v4-flash-free' }, started: 1 },
    });
    harness.queue.push({
      type: 'session.step.ended',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-late-final',
        finish: 'unknown',
        cost: 0,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(1);
    expect(completions).toHaveLength(0);
    expect(errors).toHaveLength(0);

    harness.queue.push({
      type: 'session.text.delta',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-late-final',
        ordinal: 0,
        delta: 'Late but valid final response.',
      },
    });
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });

    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]).toMatchObject({
      sessionId: routeId,
      id: 'msg-late-final',
      content: 'Late but valid final response.',
      status: 'complete',
    });
    expect(errors).toHaveLength(0);
    expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(1);
    await provider.disconnect();
  });

  it('reports an explicit failure when bounded missing-final recovery remains empty', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const completions: any[] = [];
    const errors: any[] = [];
    provider.onComplete((sessionId, message) => completions.push({ sessionId, ...message }));
    provider.onError((sessionId, error) => errors.push({ sessionId, ...error }));

    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-empty-recovery',
      cwd: '/tmp/project',
      agentId: 'opencode/deepseek-v4-flash-free',
    });
    await provider.send(routeId, 'inspect presets');

    // Also include a prior completed assistant message to prove searchPool stops at recoveryUserIdx === 0!
    harness.recordMessage({
      id: 'msg-prior',
      type: 'assistant',
      finish: 'stop',
      content: [{ type: 'text', text: 'Prior turn answer' }],
    });
    harness.client.sessions.prompt.mockImplementation(async (input: any) => {
      harness.recordMessage({ id: input.id, type: 'user', content: [{ type: 'text', text: input.text }] });
      return { id: input.id, type: 'user' };
    });

    harness.queue.push({
      type: 'session.step.ended',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-tool-step',
        finish: 'tool-calls',
        cost: 0,
        tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });

    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 4_000 });
    expect(completions).toHaveLength(0);
    expect(errors[0]).toMatchObject({
      sessionId: routeId,
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: 'OpenCode ended the turn without a final response after bounded recovery.',
      recoverable: false,
      details: { recoveryMessageId: expect.stringMatching(/^msg_/) },
    });
    await provider.disconnect();
  });

  it('does not attach a replacement OpenCode runtime after cancellation wins the reconnect race', async () => {
    const harness = createHarness();
    const replacementStart = deferred<any>();
    const replacementQueue = createAsyncQueue<Record<string, unknown>>();
    const replacementServer = { url: harness.server.url, close: vi.fn() };
    harness.client.sessions.prompt
      .mockResolvedValueOnce({ id: 'msg-initial', type: 'user' })
      .mockRejectedValue(new TypeError('fetch failed'));
    let startCount = 0;
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      startCount += 1;
      if (startCount === 3) return replacementStart.promise;
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const errors: any[] = [];
    provider.onError((sessionId, error) => errors.push({ sessionId, ...error }));

    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-cancel-reconnect',
      cwd: '/tmp/project',
      agentId: 'opencode/deepseek-v4-flash-free',
    });
    await provider.send(routeId, 'inspect presets');
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(openCodeSdkRuntimeHooks.start).toHaveBeenCalledTimes(3), { timeout: 4_000 });

    await provider.cancel(routeId);
    replacementStart.resolve({
      client: {
        ...harness.client,
        events: { subscribe: vi.fn(async () => replacementQueue.stream) },
      },
      server: replacementServer,
    });

    await vi.waitFor(() => expect(replacementServer.close).toHaveBeenCalledOnce());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      sessionId: routeId,
      code: PROVIDER_ERROR_CODES.CANCELLED,
    });
    await provider.disconnect();
  });

  it('restores provider sessions, discovers connected models and cancels active work', async () => {
    const harness = createHarness();
    harness.sessions.set('resume-1', {
      id: 'resume-1',
      title: 'Restored',
      location: { directory: '/tmp/project' },
      time: { updated: 12 },
    });
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
    expect((await provider.listSessions({ directory: '/tmp/project' }))[0]).toMatchObject({
      key: 'resume-1',
      displayName: 'Restored',
      directory: '/tmp/project',
    });
    expect(harness.client.session.list).toHaveBeenCalledWith({
      directory: '/tmp/project',
    });
    expect(await provider.listModels()).toMatchObject({
      defaultModel: 'anthropic/claude-sonnet-4-5',
      isAuthenticated: true,
      models: [expect.objectContaining({ id: 'anthropic/claude-sonnet-4-5', supportsReasoningEffort: true })],
    });

    await provider.send(routeId, 'work');
    await provider.cancel(routeId);
    expect(harness.client.session.interrupt).toHaveBeenCalledWith({ sessionID: 'resume-1' });
    expect(errors).toEqual([expect.objectContaining({ sessionId: 'ephemeral-route', code: 'CANCELLED' })]);
    await provider.disconnect();
  });

  it('returns actionable diagnostics when @opencode/sdk is unavailable or connects to an incompatible v1 server', async () => {
    openCodeSdkRuntimeHooks.start = vi.fn(async () => {
      const error = new Error('Cannot find package @opencode/sdk');
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    });
    const provider = new OpenCodeSdkProvider();

    await expect(provider.connect({})).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      recoverable: false,
      message: expect.stringContaining('opencode upgrade --major'),
    });

    openCodeSdkRuntimeHooks.start = vi.fn(async () => {
      const err = new Error('ClientError: UnexpectedStatus 404');
      err.name = 'ClientError';
      (err as any).status = 404;
      throw err;
    });
    await expect(provider.connect({})).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      recoverable: false,
      message: expect.stringContaining('incompatible OpenCode v1 endpoint'),
    });
  });

  it('closes a started session server when event subscription fails', async () => {
    const harness = createHarness();
    const catalogServer = { url: 'http://127.0.0.1:45678', close: vi.fn() };
    const sessionServer = { url: 'http://127.0.0.1:45679', close: vi.fn() };
    let startCount = 0;
    harness.client.events.subscribe.mockRejectedValue(new Error('subscribe failed after process start'));
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
      message: expect.stringContaining('subscribe failed after process start'),
    });
    expect(sessionServer.close).toHaveBeenCalledOnce();
    expect(catalogServer.close).not.toHaveBeenCalled();

    await provider.disconnect();
    expect(catalogServer.close).toHaveBeenCalledOnce();
    expect(sessionServer.close).toHaveBeenCalledOnce();
  });

  it('fails closed by rejecting current permission requests when no approval listener exists', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'route-no-ui', cwd: '/tmp/project' });

    harness.queue.push({
      type: 'permission.asked',
      data: {
        id: 'perm-deny',
        sessionID: 'oc-session-1',
        action: 'bash',
        resources: ['rm -rf /tmp/project'],
        metadata: {},
      },
    });

    await vi.waitFor(() => expect(harness.client.permission.reply).toHaveBeenCalledWith({
      sessionID: 'oc-session-1',
      requestID: 'perm-deny',
      decision: 'reject',
    }));
    await provider.disconnect();
  });

  it('settles duplicate provider terminal errors and 429 rate limits accurately', async () => {
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
      type: 'session.step.failed',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-err-1',
        error: { type: 'provider.free-limit', status: 429, message: 'Free usage limit reached' },
      },
    });
    harness.queue.push({
      type: 'session.execution.failed',
      data: {
        sessionID: 'oc-session-1',
        error: { name: 'ProviderAuthError', message: 'upstream failed again' },
      },
    });

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({
      sessionId: routeId,
      code: PROVIDER_ERROR_CODES.RATE_LIMITED,
      recoverable: true,
    });
    expect(completions).toHaveLength(0);
    await provider.disconnect();
  });

  it('bridges form.created into AskUserQuestion, delivers parsed answers via session.form.reply, and cleans up on form.replied/teardown', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const tools: Array<{ sessionId: string; tool: any }> = [];
    provider.onToolCall((sessionId, tool) => tools.push({ sessionId, tool }));
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-oc-ask',
      sessionName: 'deck_oc_brain',
      cwd: '/tmp/oc-project',
    });
    await provider.send(routeId, 'ask me');

    harness.queue.push({
      type: 'session.tool.input.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-a1', id: 'call-q1', name: 'form' },
    });
    harness.queue.push({
      type: 'session.tool.called',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-a1', id: 'call-q1', input: {}, executed: false },
    });
    harness.queue.push({
      type: 'form.created',
      data: {
        form: {
          id: 'form-1',
          sessionID: 'oc-session-1',
          title: 'Setup',
          metadata: { callID: 'call-q1' },
          fields: [
            {
              key: 'targets',
              type: 'multiselect',
              title: 'Pick targets?',
              options: [{ label: 'Web', description: 'UI' }, { label: 'Daemon', description: 'BG' }],
            },
            {
              key: 'confirm',
              type: 'boolean',
              title: 'Proceed?',
              options: [{ label: 'true' }, { label: 'false' }],
            },
          ],
        },
      },
    });

    await vi.waitFor(() => expect(tools).toHaveLength(1));
    expect(tools[0]).toEqual({
      sessionId: 'route-oc-ask',
      tool: {
        id: 'call-q1',
        name: 'AskUserQuestion',
        status: 'complete',
        input: {
          questions: [
            { question: 'Pick targets?', header: 'Setup', multiSelect: true, options: [{ label: 'Web', description: 'UI' }, { label: 'Daemon', description: 'BG' }] },
            { question: 'Proceed?', header: 'Setup', options: [{ label: 'true' }, { label: 'false' }] },
          ],
        },
      },
    });

    expect(provider.answerPendingQuestion('other_session', '[Setup] Web\n[Setup] true')).toBe(false);
    expect(provider.answerPendingQuestion('deck_oc_brain', '[Setup] Web, Daemon\n[Setup] yes')).toBe(true);
    expect(provider.answerPendingQuestion('deck_oc_brain', '[Setup] Web\n[Setup] yes')).toBe(false);
    await vi.waitFor(() => expect(harness.client.session.form.reply).toHaveBeenCalledWith({
      sessionID: 'oc-session-1',
      formID: 'form-1',
      answer: { targets: ['Web', 'Daemon'], confirm: true },
    }));

    harness.queue.push({
      type: 'form.created',
      data: {
        form: {
          id: 'form-2',
          sessionID: 'oc-session-1',
          title: 'Remote',
          fields: [{ key: 'ok', type: 'string', title: 'Cleared remotely?' }],
        },
      },
    });
    await vi.waitFor(() => expect(tools).toHaveLength(2));
    harness.queue.push({ type: 'form.replied', data: { sessionID: 'oc-session-1', id: 'form-2', answer: { ok: 'Ok' } } });
    await vi.waitFor(() => expect(provider.answerPendingQuestion('deck_oc_brain', '[Remote] Ok')).toBe(false));

    harness.queue.push({
      type: 'form.created',
      data: {
        form: {
          id: 'form-3',
          sessionID: 'oc-session-1',
          title: 'End',
          fields: [{ key: 'end', type: 'string', title: 'Before teardown?' }],
        },
      },
    });
    await vi.waitFor(() => expect(tools).toHaveLength(3));
    await provider.endSession(routeId);
    expect(harness.client.session.form.cancel).toHaveBeenCalledWith({
      sessionID: 'oc-session-1',
      formID: 'form-3',
    });
    expect(provider.answerPendingQuestion('deck_oc_brain', '[End] Yes')).toBe(false);
    await provider.disconnect();
  });

  it('declares reasoningEffort and compact capabilities and parses v2 model capabilities and variants', async () => {
    const harness = createHarness();
    harness.client.provider.list.mockResolvedValue({
      data: [
        { id: 'anthropic', name: 'Anthropic', activation: 'enabled' },
        { id: 'openai', name: 'OpenAI', activation: 'enabled' },
      ],
    });
    harness.client.model.list.mockResolvedValue({
      data: [
        {
          id: 'anthropic/claude-sonnet-4-5',
          modelID: 'claude-sonnet-4-5',
          providerID: 'anthropic',
          name: 'Claude Sonnet 4.5',
          enabled: true,
          type: 'chat',
          capabilities: { reasoning: true },
          variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }, { id: 'minimal', disabled: true }],
          limit: { context: 1_000_000, output: 128_000 },
        },
        {
          id: 'anthropic/claude-haiku-3-5',
          modelID: 'claude-haiku-3-5',
          providerID: 'anthropic',
          name: 'Claude Haiku 3.5',
          enabled: true,
          type: 'chat',
          capabilities: { reasoning: false },
          variants: [],
          limit: { context: 200_000, output: 8_192 },
        },
        {
          id: 'openai/o3-mini',
          modelID: 'o3-mini',
          providerID: 'openai',
          name: 'o3-mini',
          enabled: true,
          type: 'chat',
          variants: [{ id: 'low' }, { id: 'high' }, { id: 'xhigh', disabled: true }],
          limit: { context: 200_000, output: 100_000 },
        },
      ],
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    expect(provider.capabilities.reasoningEffort).toBe(true);
    expect(provider.capabilities.supportedEffortLevels).toEqual(OPENCODE_SDK_EFFORT_LEVELS);
    expect(provider.capabilities.compact).toEqual({
      execution: 'sdk-rpc',
      verified: true,
      completion: 'rpc-result-or-provider-event',
      cancellation: 'provider-cancel',
      reassertsSessionSystemText: true,
    });

    await provider.connect({});
    const catalog = await provider.listModels(true);
    expect(catalog.models).toEqual([
      {
        id: 'anthropic/claude-haiku-3-5',
        name: 'Anthropic · Claude Haiku 3.5',
      },
      {
        id: 'anthropic/claude-sonnet-4-5',
        name: 'Anthropic · Claude Sonnet 4.5',
        supportsReasoningEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      },
      {
        id: 'openai/o3-mini',
        name: 'OpenAI · o3-mini',
        supportsReasoningEffort: true,
        supportedEffortLevels: ['low', 'high'],
      },
    ]);
    await provider.disconnect();
  });

  it('tracks effort via setSessionEffort and passes variant via switchModel only for reasoning-capable models', async () => {
    const harness = createHarness();
    harness.client.provider.list.mockResolvedValue({
      data: [
        { id: 'anthropic', name: 'Anthropic', activation: 'enabled' },
        { id: 'openai', name: 'OpenAI', activation: 'enabled' },
      ],
    });
    harness.client.model.list.mockResolvedValue({
      data: [
        {
          id: 'anthropic/claude-sonnet-4-5',
          modelID: 'claude-sonnet-4-5',
          providerID: 'anthropic',
          name: 'Claude Sonnet 4.5',
          enabled: true,
          type: 'chat',
          capabilities: { reasoning: true },
          variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
          limit: { context: 1_000_000, output: 128_000 },
        },
        {
          id: 'openai/gpt-plain',
          modelID: 'gpt-plain',
          providerID: 'openai',
          name: 'GPT Plain',
          enabled: true,
          type: 'chat',
          capabilities: { reasoning: false },
          variants: [],
          limit: { context: 128_000, output: 16_000 },
        },
      ],
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    const infos: Array<{ sessionId: string; info: any }> = [];
    provider.onSessionInfo((sessionId, info) => infos.push({ sessionId, info }));
    await provider.connect({});

    const routeId = await provider.createSession({
      sessionKey: 'route-effort',
      cwd: '/tmp/project',
      agentId: 'anthropic/claude-sonnet-4-5',
      effort: 'medium',
    });
    expect(infos[0]).toEqual({
      sessionId: 'route-effort',
      info: { resumeId: 'oc-session-1', model: 'anthropic/claude-sonnet-4-5', effort: 'medium' },
    });

    await provider.send(routeId, 'turn 1');
    expect(harness.client.session.switchModel).toHaveBeenLastCalledWith({
      sessionID: 'oc-session-1',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-5', variant: 'medium' },
    });
    harness.queue.push({
      type: 'session.step.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-eff-1', agent: 'build', model: { providerID: 'anthropic', id: 'claude-sonnet-4-5' }, started: 1 },
    });
    harness.queue.push({
      type: 'session.text.delta',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-eff-1', ordinal: 0, delta: 'ok' },
    });
    harness.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(1));

    provider.setSessionEffort(routeId, 'max');
    expect(infos[infos.length - 1]).toEqual({
      sessionId: 'route-effort',
      info: { resumeId: 'oc-session-1', model: 'anthropic/claude-sonnet-4-5', effort: 'max' },
    });

    const routeNonReasoning = await provider.createSession({
      sessionKey: 'route-no-reasoning',
      cwd: '/tmp/project',
      agentId: 'openai/gpt-plain',
      effort: 'high',
    });
    await provider.send(routeNonReasoning, 'plain turn');
    expect(harness.client.session.switchModel).toHaveBeenLastCalledWith({
      sessionID: 'oc-session-2',
      model: { providerID: 'openai', id: 'gpt-plain' },
    });

    const routeClamped = await provider.createSession({
      sessionKey: 'route-clamped',
      cwd: '/tmp/project',
      agentId: 'anthropic/claude-sonnet-4-5',
      effort: 'max',
    });
    await provider.send(routeClamped, 'clamped turn');
    expect(harness.client.session.switchModel).toHaveBeenLastCalledWith({
      sessionID: 'oc-session-3',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-5', variant: 'high' },
    });

    await provider.disconnect();
  });

  it('executes /compact via session.compact, handles v2 compaction events + legacy session.compacted, cancel, failure, and missing compact', async () => {
    const harness = createHarness();
    const compactDeferred = deferred<Record<string, unknown>>();
    harness.client.session.compact.mockImplementationOnce(() => compactDeferred.promise);
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    const statuses: Array<any> = [];
    const completions: Array<any> = [];
    const errors: Array<any> = [];
    provider.onStatus((_sid, status) => statuses.push(status));
    provider.onComplete((_sid, message) => completions.push(message));
    provider.onError((_sid, error) => errors.push(error));

    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-compact',
      cwd: '/tmp/oc-project',
      agentId: 'anthropic/claude-sonnet-4-5',
    });

    const compactPromise = provider.send(routeId, '/compact');
    await vi.waitFor(() => expect(harness.client.session.compact).toHaveBeenCalledWith({
      sessionID: 'oc-session-1',
      id: expect.stringMatching(/^msg_/),
    }));
    const firstCompactId = (harness.client.session.compact.mock.calls[0]?.[0] as { id: string }).id;
    expect(statuses).toContainEqual({ status: 'compacting', label: 'Compacting conversation...' });

    // v2 session.compaction.started keeps compacting status; idle mid-compaction must not fail empty
    harness.queue.push({
      type: 'session.compaction.started',
      data: { sessionID: 'oc-session-1', reason: 'manual', inputID: firstCompactId },
    });
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    // Real v2 session.compaction.ended omits inputID and settles only after matching manual start
    harness.queue.push({ type: 'session.compaction.ended', data: { sessionID: 'oc-session-1', reason: 'manual', text: 'Summary' } });
    harness.queue.push({ type: 'session.compacted', data: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    compactDeferred.resolve({ id: firstCompactId });
    await compactPromise;

    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      kind: 'system',
      role: 'system',
      content: 'OpenCode context compacted.',
      status: 'complete',
      metadata: {
        provider: 'opencode-sdk',
        event: 'session.compaction.ended',
        [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact',
        resumeId: 'oc-session-1',
      },
    });
    expect(statuses[statuses.length - 1]).toEqual({ status: null, label: null });
    expect(errors).toHaveLength(0);

    // Legacy session.compacted also still works when no v2 compaction events occurred
    harness.client.session.compact.mockImplementationOnce(async ({ id }: { id: string }) => ({ id }));
    await provider.send(routeId, '/compact');
    harness.queue.push({ type: 'session.compacted', data: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    expect(completions[1]).toMatchObject({
      metadata: expect.objectContaining({ event: 'session.compacted' }),
    });

    // session.compaction.failed surfaces normalized error
    harness.client.session.compact.mockImplementationOnce(async ({ id }: { id: string }) => ({ id }));
    await provider.send(routeId, '/compact');
    const failedCompactId = (harness.client.session.compact.mock.calls[2]?.[0] as { id: string }).id;
    harness.queue.push({
      type: 'session.compaction.failed',
      data: { sessionID: 'oc-session-1', reason: 'manual', inputID: failedCompactId, error: { message: 'compaction failed upstream' } },
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: expect.stringContaining('compaction failed upstream'),
    });

    // Cancel during an in-flight compact
    const pendingCompact = deferred<Record<string, unknown>>();
    harness.client.session.compact.mockImplementationOnce(() => pendingCompact.promise);
    const secondCompact = provider.send(routeId, '/compact');
    await vi.waitFor(() => expect(harness.client.session.compact).toHaveBeenCalledTimes(4));
    await provider.cancel(routeId);
    pendingCompact.resolve({ id: 'msg-compact-cancelled' });
    await secondCompact;
    expect(errors).toContainEqual(expect.objectContaining({
      code: PROVIDER_ERROR_CODES.CANCELLED,
      message: 'OpenCode compact cancelled',
    }));

    // Graceful controlled error when client lacks session.compact
    delete (harness.client.session as any).compact;
    await expect(provider.send(routeId, '/compact')).rejects.toMatchObject({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: 'OpenCode compact failed: SDK session.compact is unavailable',
      recoverable: false,
    });
    await provider.disconnect();
  });

  it('persists sessions across real embedded @opencode/sdk host stop/restart using databasePath', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-sdk-v2-test-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'opencode-sdk.db');

    const first = new OpenCodeSdkProvider();
    await first.connect({ databasePath: dbPath, cwd: tempDir } as any);
    const catalog = await first.listModels(true);
    expect(catalog.isAuthenticated).toBe(true);
    expect(catalog.defaultModel).toBe(DEFAULT_OPENCODE_MODEL_ID);
    expect(catalog.models.some((m) => m.id === DEFAULT_OPENCODE_MODEL_ID)).toBe(true);

    const route1 = await first.createSession({
      sessionKey: 'real-v2-persist',
      sessionName: 'deck_real_v2',
      label: 'Real V2 Persistence Check',
      cwd: tempDir,
    });
    const sessionsBefore = await first.listSessions({ directory: tempDir });
    expect(sessionsBefore.length).toBeGreaterThanOrEqual(1);
    const persistedId = sessionsBefore[0]!.key;
    expect(route1).toBe('real-v2-persist');
    await first.disconnect();

    const restarted = new OpenCodeSdkProvider();
    await restarted.connect({ databasePath: dbPath, cwd: tempDir } as any);
    await expect(restarted.restoreSession(persistedId)).resolves.toBe(true);
    await expect(restarted.createSession({
      sessionKey: 'real-v2-persist',
      sessionName: 'deck_real_v2',
      cwd: tempDir,
      skipCreate: true,
      resumeId: persistedId,
    })).resolves.toBe('real-v2-persist');
    await restarted.disconnect();
  }, 30_000);

  it('prefers DEFAULT_OPENCODE_MODEL_ID (opencode/big-pickle) in listModels() and unspecified new sessions', async () => {
    const harness = createHarness();
    harness.client.provider.list.mockResolvedValue({
      data: [
        { id: 'anthropic', name: 'Anthropic', activation: 'enabled' },
        { id: 'opencode', name: 'OpenCode', activation: 'enabled' },
      ],
    });
    harness.client.model.list.mockResolvedValue({
      data: [
        {
          id: 'anthropic/claude-sonnet-4-5',
          modelID: 'claude-sonnet-4-5',
          providerID: 'anthropic',
          name: 'Claude Sonnet 4.5',
          enabled: true,
          type: 'chat',
        },
        {
          id: DEFAULT_OPENCODE_MODEL_ID,
          modelID: 'big-pickle',
          providerID: 'opencode',
          name: 'Big Pickle',
          enabled: true,
          type: 'chat',
          limit: { context: 200_000, output: 16_000 },
        },
      ],
    });
    // Even if SDK reports anthropic/claude-sonnet-4-5 as its default, IM.codes prefers opencode/big-pickle.
    harness.client.model.default.mockResolvedValue({
      data: {
        id: 'anthropic/claude-sonnet-4-5',
        modelID: 'claude-sonnet-4-5',
        providerID: 'anthropic',
        name: 'Claude Sonnet 4.5',
      },
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    const infos: Array<{ sessionId: string; info: any }> = [];
    provider.onSessionInfo((sessionId, info) => infos.push({ sessionId, info }));
    await provider.connect({});

    const catalog = await provider.listModels(true);
    expect(catalog.defaultModel).toBe(DEFAULT_OPENCODE_MODEL_ID);

    const routeId = await provider.createSession({ sessionKey: 'route-default-bp', cwd: '/tmp/project' });
    expect(infos[0]).toEqual({
      sessionId: routeId,
      info: { resumeId: 'oc-session-1', model: DEFAULT_OPENCODE_MODEL_ID },
    });
    expect(harness.client.session.switchModel).toHaveBeenCalledWith({
      sessionID: 'oc-session-1',
      model: { providerID: 'opencode', id: 'big-pickle' },
    });
    await provider.disconnect();
  });

  it('auto-removes expired opencode credentials on 401 api_key_expired, switches unavailable model to big-pickle, and retries once', async () => {
    const harness = createHarness();
    harness.credentials.push(
      { id: 'cred-oc-1', integrationID: 'opencode', label: 'stale-opencode', active: true },
      { id: 'cred-mm-1', integrationID: 'minimax', label: 'valid-minimax', active: true },
    );
    let healed = false;
    harness.client.provider.list.mockImplementation(async () => ({
      data: [
        { id: 'opencode', name: 'OpenCode', activation: 'enabled' },
        { id: 'minimax', name: 'MiniMax', activation: 'enabled' },
      ],
    }));
    harness.client.model.list.mockImplementation(async () => ({
      data: [
        ...(!healed
          ? [{
            id: 'opencode/paid-claude',
            modelID: 'paid-claude',
            providerID: 'opencode',
            name: 'Paid Claude',
            enabled: true,
            type: 'chat',
          }]
          : []),
        {
          id: DEFAULT_OPENCODE_MODEL_ID,
          modelID: 'big-pickle',
          providerID: 'opencode',
          name: 'Big Pickle',
          enabled: true,
          type: 'chat',
          limit: { context: 200_000, output: 16_000 },
        },
      ],
    }));
    harness.client.credential.remove.mockImplementation(async ({ credentialID }) => {
      const idx = harness.credentials.findIndex((c) => c.id === credentialID);
      if (idx >= 0) harness.credentials.splice(idx, 1);
      healed = true;
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    const infos: Array<{ sessionId: string; info: any }> = [];
    const completes: any[] = [];
    const errors: any[] = [];
    provider.onSessionInfo((sessionId, info) => infos.push({ sessionId, info }));
    provider.onComplete((sessionId, msg) => completes.push({ sessionId, msg }));
    provider.onError((sessionId, err) => errors.push({ sessionId, err }));

    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-auth-heal',
      cwd: '/tmp/project',
      agentId: 'opencode/paid-claude',
    });
    await provider.send(routeId, 'hello heal');

    harness.queue.push({
      type: 'session.step.started',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-fail-1',
        agent: 'build',
        model: { providerID: 'opencode', id: 'paid-claude' },
        started: 1,
      },
    });
    harness.queue.push({
      type: 'session.step.failed',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-fail-1',
        error: {
          type: 'provider.auth',
          status: 401,
          message: 'API key expired',
          response: { body: '{"error":{"type":"api_key_expired","message":"API key expired"}}' },
        },
      },
    });
    // Back-to-back duplicate failure + idle from the failed step must NOT break healing
    harness.queue.push({
      type: 'session.execution.failed',
      data: {
        sessionID: 'oc-session-1',
        error: { type: 'provider.auth', status: 401, message: 'API key expired' },
      },
    });
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });

    await vi.waitFor(() => expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(2));
    expect(harness.client.credential.remove).toHaveBeenCalledOnce();
    expect(harness.client.credential.remove).toHaveBeenCalledWith({ credentialID: 'cred-oc-1' });
    // Sibling minimax credential must remain untouched!
    expect(harness.credentials).toEqual([{ id: 'cred-mm-1', integrationID: 'minimax', label: 'valid-minimax', active: true }]);
    // Unavailable paid model switched to opencode/big-pickle and emitted to sessionInfo
    expect(infos.at(-1)).toEqual({
      sessionId: routeId,
      info: { resumeId: 'oc-session-1', model: DEFAULT_OPENCODE_MODEL_ID },
    });
    expect(harness.client.session.switchModel).toHaveBeenLastCalledWith({
      sessionID: 'oc-session-1',
      model: { providerID: 'opencode', id: 'big-pickle' },
    });

    harness.queue.push({
      type: 'session.step.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-healed-1', agent: 'build', model: { providerID: 'opencode', id: 'big-pickle' }, started: 2 },
    });
    harness.queue.push({
      type: 'session.text.delta',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-healed-1', ordinal: 0, delta: 'Healed OK' },
    });
    harness.queue.push({
      type: 'session.step.ended',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-healed-1', finish: 'stop' },
    });

    await vi.waitFor(() => expect(completes).toHaveLength(1));
    expect(completes[0].msg.content).toBe('Healed OK');
    expect(errors).toHaveLength(0);
    await provider.disconnect();
  });

  it('keeps the original model during auth self-heal when still available after credential cleanup', async () => {
    const harness = createHarness();
    harness.credentials.push({ id: 'cred-oc-bp', integrationID: 'opencode', active: true });
    harness.client.model.list.mockResolvedValue({
      data: [{
        id: DEFAULT_OPENCODE_MODEL_ID,
        modelID: 'big-pickle',
        providerID: 'opencode',
        name: 'Big Pickle',
        enabled: true,
        type: 'chat',
      }],
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    const completes: any[] = [];
    provider.onComplete((_s, msg) => completes.push(msg));
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-keep-model-heal',
      cwd: '/tmp/project',
      agentId: DEFAULT_OPENCODE_MODEL_ID,
    });
    await provider.send(routeId, 'ping');

    harness.queue.push({
      type: 'session.step.failed',
      data: {
        sessionID: 'oc-session-1',
        error: { type: 'provider.auth', status: 401, message: 'API key expired' },
      },
    });
    await vi.waitFor(() => expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(2));
    expect(harness.client.credential.remove).toHaveBeenCalledWith({ credentialID: 'cred-oc-bp' });
    expect(harness.client.session.switchModel).toHaveBeenLastCalledWith({
      sessionID: 'oc-session-1',
      model: { providerID: 'opencode', id: 'big-pickle' },
    });

    harness.queue.push({
      type: 'session.text.delta',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-ok', ordinal: 0, delta: 'Still big-pickle' },
    });
    harness.queue.push({
      type: 'session.step.ended',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-ok', finish: 'stop' },
    });
    await vi.waitFor(() => expect(completes).toHaveLength(1));
    expect(completes[0].content).toBe('Still big-pickle');
    await provider.disconnect();
  });

  it('does NOT remove credentials or retry when 401 originates from a third-party provider such as minimax', async () => {
    const harness = createHarness();
    harness.credentials.push(
      { id: 'cred-oc-keep', integrationID: 'opencode', active: true },
      { id: 'cred-mm-keep', integrationID: 'minimax', active: true },
    );
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    const errors: any[] = [];
    provider.onError((_s, err) => errors.push(err));
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-minimax-401',
      cwd: '/tmp/project',
      agentId: 'minimax/MiniMax-M2.5',
    });
    await provider.send(routeId, 'hello minimax');

    harness.queue.push({
      type: 'session.step.started',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-mm-1',
        agent: 'build',
        model: { providerID: 'minimax', id: 'MiniMax-M2.5' },
        started: 1,
      },
    });
    harness.queue.push({
      type: 'session.step.failed',
      data: {
        sessionID: 'oc-session-1',
        assistantMessageID: 'msg-mm-1',
        error: { type: 'provider.auth', status: 401, message: 'api_key_expired' },
      },
    });

    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0].code).toBe(PROVIDER_ERROR_CODES.AUTH_FAILED);
    expect(harness.client.credential.remove).not.toHaveBeenCalled();
    expect(harness.credentials).toHaveLength(2);
    expect(harness.client.sessions.prompt).toHaveBeenCalledOnce();
    await provider.disconnect();
  });

  it('caps auth self-healing to strictly 1 retry per turn and reports an actionable error if OPENCODE_API_KEY remains expired', async () => {
    const harness = createHarness();
    harness.credentials.push({ id: 'cred-oc-1', integrationID: 'opencode', active: true });
    harness.client.model.list.mockResolvedValue({
      data: [{
        id: DEFAULT_OPENCODE_MODEL_ID,
        modelID: 'big-pickle',
        providerID: 'opencode',
        name: 'Big Pickle',
        enabled: true,
        type: 'chat',
      }],
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    const errors: any[] = [];
    provider.onError((_s, err) => errors.push(err));
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-env-expired',
      cwd: '/tmp/project',
      agentId: DEFAULT_OPENCODE_MODEL_ID,
    });
    await provider.send(routeId, 'hello');

    harness.queue.push({
      type: 'session.step.failed',
      data: { sessionID: 'oc-session-1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
    });
    await vi.waitFor(() => expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(2));

    // Retry also fails with 401 (e.g. expired OPENCODE_API_KEY env var)
    harness.queue.push({
      type: 'session.step.failed',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-retry-env-err', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatchObject({
      code: PROVIDER_ERROR_CODES.AUTH_FAILED,
      recoverable: false,
      message: expect.stringContaining('OPENCODE_API_KEY'),
    });
    expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(2);
    expect(harness.client.credential.remove).toHaveBeenCalledOnce();
    await provider.disconnect();
  });

  it('aborts expired-key self-healing cleanly when cancelled mid-recovery without sending a zombie retry', async () => {
    const harness = createHarness();
    harness.credentials.push({
      id: 'cred-pre-cancel',
      integrationID: 'opencode',
      label: 'pre-cancel',
      active: true,
      value: { type: 'key', key: 'sk-pre-cancel' },
    } as any);
    const credGate = deferred<Array<{ id: string; integrationID: string }>>();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    const errors: any[] = [];
    provider.onError((_s, err) => errors.push(err));
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-cancel-auth-heal',
      cwd: '/tmp/project',
      agentId: DEFAULT_OPENCODE_MODEL_ID,
    });
    await provider.send(routeId, 'hello cancel');

    harness.client.credential.list.mockImplementationOnce(() => credGate.promise);
    harness.queue.push({
      type: 'session.step.failed',
      data: { sessionID: 'oc-session-1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
    });
    await vi.waitFor(() => expect(harness.client.credential.list).toHaveBeenCalledTimes(2));

    await provider.cancel(routeId);
    credGate.resolve([{ id: 'cred-pre-cancel', integrationID: 'opencode' }]);
    await new Promise((r) => setTimeout(r, 20));

    expect(harness.client.credential.remove).not.toHaveBeenCalled();
    expect(harness.client.sessions.prompt).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(PROVIDER_ERROR_CODES.CANCELLED);
    await provider.disconnect();
  });

  it('ignores late normal execution completions, auto compactions, and stale/pre-ACK frames during manual /compact', async () => {
    const harness = createHarness();
    const compactDeferred = deferred<Record<string, unknown>>();
    harness.client.session.compact.mockImplementationOnce(() => compactDeferred.promise);
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    const completes: any[] = [];
    const errors: any[] = [];
    provider.onComplete((_s, msg) => completes.push(msg));
    provider.onError((_s, err) => errors.push(err));
    await provider.connect({});
    const routeId = await provider.createSession({ sessionKey: 'route-compact-race', cwd: '/tmp/project' });

    const compactPromise = provider.send(routeId, '/compact');
    await vi.waitFor(() => expect(harness.client.session.compact).toHaveBeenCalledOnce());
    const preBoundId = (harness.client.session.compact.mock.calls[0]?.[0] as { id: string }).id;
    expect(preBoundId).toMatch(/^msg_/);

    // 1. Late normal turn completion arrives while manual compaction is in-flight -> MUST NOT settle /compact
    harness.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1' } });
    // 2. Stale pre-ACK manual started + omitted-inputID ended BEFORE compact() RPC resolves -> MUST NOT settle
    harness.queue.push({ type: 'session.compaction.started', data: { sessionID: 'oc-session-1', reason: 'manual', inputID: 'msg_stale_old_1' } });
    harness.queue.push({ type: 'session.compaction.ended', data: { sessionID: 'oc-session-1', reason: 'manual', text: 'stale pre-ack' } });
    // 3. Background auto compaction lifecycle -> MUST NOT settle /compact or fail it
    harness.queue.push({ type: 'session.compaction.started', data: { sessionID: 'oc-session-1', reason: 'auto' } });
    harness.queue.push({ type: 'session.compaction.ended', data: { sessionID: 'oc-session-1', reason: 'auto', text: 'auto' } });
    harness.queue.push({ type: 'session.compaction.failed', data: { sessionID: 'oc-session-1', reason: 'auto', error: { message: 'auto err' } } });
    // 4. Legacy session.compacted after v2 compaction events MUST NOT bypass v2 correlation
    harness.queue.push({ type: 'session.compacted', data: { sessionID: 'oc-session-1' } });
    compactDeferred.resolve({ id: preBoundId });
    await compactPromise;
    harness.queue.push({ type: 'session.compaction.started', data: { sessionID: 'oc-session-1', reason: 'manual', inputID: 'msg_old_other_1' } });
    harness.queue.push({ type: 'session.compaction.failed', data: { sessionID: 'oc-session-1', reason: 'manual', inputID: 'msg_old_other_1', error: { message: 'old failed' } } });

    await new Promise((r) => setTimeout(r, 25));
    expect(completes).toHaveLength(0);
    expect(errors).toHaveLength(0);

    // 5. Matching current manual started (exact preBoundId) + v2 ended (no inputID) settles once, duplicates ignored
    harness.queue.push({ type: 'session.compaction.started', data: { sessionID: 'oc-session-1', reason: 'manual', inputID: preBoundId } });
    harness.queue.push({ type: 'session.compaction.ended', data: { sessionID: 'oc-session-1', reason: 'manual', text: 'Current summary' } });
    harness.queue.push({ type: 'session.compaction.ended', data: { sessionID: 'oc-session-1', reason: 'manual', text: 'Duplicate' } });
    await vi.waitFor(() => expect(completes).toHaveLength(1));
    expect(completes[0].content).toBe('OpenCode context compacted.');
    expect(errors).toHaveLength(0);
    await provider.disconnect();
  });

  it('always syncs IMCODES_SYSTEM_INSTRUCTION_KEY on every turn across reconnect and propagates non-404 removal failures', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-sys-inst-'));
    const dbPath = join(tempDir, 'v2.db');
    try {
      // Real SQLite round-trip: Session A stores instruction -> disconnect -> restored Session B sends WITHOUT instruction
      const first = new OpenCodeSdkProvider();
      await first.connect({ databasePath: dbPath, cwd: tempDir } as any);
      const rA = await first.createSession({ sessionKey: 'sys-a', cwd: tempDir });
      const psid = (first as any).sessions.get(rA).providerSessionId as string;
      const clientA = (first as any).sessions.get(rA).client;
      await clientA.experimental.session.instructions.entry.put({
        sessionID: psid,
        key: 'imcodes-system',
        value: 'Session A private system prompt',
      });
      await first.disconnect();

      const second = new OpenCodeSdkProvider();
      await second.connect({ databasePath: dbPath, cwd: tempDir } as any);
      const rB = await second.createSession({ sessionKey: 'sys-b', cwd: tempDir, skipCreate: true, resumeId: psid });
      const stateB = (second as any).sessions.get(rB);
      // Even though restored state starts with fresh in-memory fields, applySystemInstruction(undefined) removes stale key
      await (second as any).applySystemInstruction(stateB, undefined);

      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const activeRows = db.prepare('SELECT key, value, removed FROM instruction_entry WHERE session_id = ? AND removed = 0').all(psid) as Array<{ key: string }>;
      const allRows = db.prepare('SELECT key, value, removed FROM instruction_entry WHERE session_id = ?').all(psid) as Array<{ key: string; value: unknown; removed: number }>;
      db.close();
      expect(activeRows).toHaveLength(0);
      expect(allRows).toContainEqual(expect.objectContaining({ key: 'imcodes-system', value: null, removed: 1 }));
      await second.disconnect();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    // Transient non-404 delete error must block prompt submission rather than leaking stale instructions
    const harness = createHarness();
    harness.client.experimental.session.instructions.entry.remove
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }));
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    await provider.connect({});
    const routeId = await provider.createSession({ sessionKey: 'route-sys-fail', cwd: '/tmp/project' });
    await expect(provider.send(routeId, 'hello without system')).rejects.toThrow(/SQLITE_BUSY/);
    expect(harness.client.sessions.prompt).not.toHaveBeenCalled();

    // True 404 when key is absent is safely ignored
    await expect(provider.send(routeId, 'hello second try')).resolves.toBeUndefined();
    expect(harness.client.sessions.prompt).toHaveBeenCalledOnce();
    await provider.disconnect();
  }, 30_000);

  it('imports legacy v1 opencode.db sessions idempotently preserving original ses_* ID and reports corrupt migration failures', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-v1-import-'));
    const xdgDir = join(tempDir, 'xdg-data');
    const legacyDir = join(xdgDir, 'opencode');
    const projectDir = join(tempDir, 'proj');
    const v2DbPath = join(tempDir, 'v2', 'opencode-sdk.db');
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgDir;

    try {
      const { DatabaseSync } = await import('node:sqlite');
      const v1Db = new DatabaseSync(join(legacyDir, 'opencode.db'));
      const now = Date.now();
      v1Db.exec(`
        CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, sandboxes TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
        CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, agent TEXT, model TEXT, cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL, tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      `);
      const legacySid = 'ses_legacy_v1_restore_001';
      v1Db.prepare('INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (?, ?, ?, ?, ?)')
        .run('proj_v1', projectDir, '[]', now - 2000, now - 1000);
      v1Db.prepare('INSERT INTO session (id, project_id, directory, title, version, agent, model, cost, tokens_input, tokens_output, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(legacySid, 'proj_v1', projectDir, 'Legacy 1.18.4 Session', '1.18.4', 'build', JSON.stringify({ providerID: 'opencode', modelID: 'big-pickle' }), 0, 12, 8, now - 2000, now - 1000);
      v1Db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
        .run('msg_v1_user_1', legacySid, now - 1800, now - 1800, JSON.stringify({ role: 'user', agent: 'build', model: { providerID: 'opencode', modelID: 'big-pickle' } }));
      v1Db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run('prt_v1_1', 'msg_v1_user_1', legacySid, now - 1800, now - 1800, JSON.stringify({ type: 'text', text: 'Remember v1 context' }));
      v1Db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
        .run('msg_v1_asst_1', legacySid, now - 1500, now - 1400, JSON.stringify({
          role: 'assistant',
          agent: 'build',
          providerID: 'opencode',
          modelID: 'big-pickle',
          finish: 'stop',
          cost: 0,
          tokens: { input: 12, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now - 1500, completed: now - 1400 },
        }));
      v1Db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run('prt_v1_2', 'msg_v1_asst_1', legacySid, now - 1500, now - 1400, JSON.stringify({ type: 'text', text: 'Legacy response text' }));
      v1Db.close();

      const provider = new OpenCodeSdkProvider();
      await provider.connect({ databasePath: v2DbPath, cwd: projectDir } as any);
      expect(await provider.restoreSession(legacySid)).toBe(true);
      const restoredRoute = await provider.createSession({
        sessionKey: 'restored-v1-route',
        cwd: projectDir,
        skipCreate: true,
        resumeId: legacySid,
      });
      expect(restoredRoute).toBe('restored-v1-route');

      const v2Msgs = await (provider as any).client.message.list({ sessionID: legacySid });
      expect(v2Msgs.data.some((m: any) => m.type === 'user' && m.text === 'Remember v1 context')).toBe(true);
      expect(v2Msgs.data.some((m: any) => m.type === 'assistant')).toBe(true);
      await provider.disconnect();

      // Reconnecting on v2 DB alone (even if v1 DB is removed) keeps exact ses_* ID & single imported history
      rmSync(join(legacyDir, 'opencode.db'));
      const provider2 = new OpenCodeSdkProvider();
      await provider2.connect({ databasePath: v2DbPath, cwd: projectDir } as any);
      expect(await provider2.restoreSession(legacySid)).toBe(true);
      await provider2.disconnect();
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('enforces native subagent fence (subagent:deny) on managed create/restore without polluting plain sessions on single shared DB host', async () => {
    expect(OPENCODE_NATIVE_AGENT_TOOLS).toEqual(['subagent']);

    const seenToolLists: Array<{ titleHint: string; tools: string[] }> = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        const tools = Array.isArray(parsed.tools)
          ? parsed.tools.map((t: any) => String(t.name ?? t.function?.name ?? ''))
          : [];
        if (tools.length > 0) {
          seenToolLists.push({ titleHint: String(parsed.input?.[0]?.content?.[0]?.text ?? body), tools });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (req.url?.includes('/responses')) {
          res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_fence_1', model: parsed.model || 'gpt-4o-mini' } })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_item_1', type: 'message', role: 'assistant', content: [] } })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_item_1', output_index: 0, content_index: 0, delta: 'fence check ok' })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_fence_1', status: 'completed', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'fence check ok' }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl_1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
        res.end();
      });
    });
    await new Promise<void>((resolveListen) => srv.listen(0, '127.0.0.1', () => resolveListen()));
    const address = srv.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const tempDir = mkdtempSync(join(tmpdir(), 'oc-single-host-fence-'));
    const xdgDir = join(tempDir, 'xdg-data');
    const dirA = join(tempDir, 'dir-a');
    const dirB = join(tempDir, 'dir-b');
    const dbPath = join(tempDir, 'shared.db');
    mkdirSync(xdgDir, { recursive: true });
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgDir;

    const origCreate = OpenCode.create.bind(OpenCode);
    const createSpy = vi.spyOn(OpenCode, 'create');
    try {
      // Seed OpenCode config pointing built-in openai provider at our loopback server
      createSpy.mockImplementation(async (opts: any) => origCreate({
        ...opts,
        config: {
          content: JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            share: 'disabled',
            provider: {
              openai: {
                options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-local-test' },
              },
            },
          }),
        },
      }));

      const provider = new OpenCodeSdkProvider();
      provider.setNativeAgentFenceResolver((_sid, name) => name === 'managed-worker' || name === 'restored-managed');

      const completed: string[] = [];
      const errors1: any[] = [];
      provider.onComplete((sessionId) => completed.push(sessionId));
      provider.onError((sessionId, err) => errors1.push({ sessionId, err }));
      await provider.connect({ databasePath: dbPath, cwd: dirA } as any);
      const client = (provider as any).client;
      await client.credential.create({
        integrationID: 'openai',
        label: 'test-openai',
        value: { type: 'key', key: 'sk-local-test' },
        activate: true,
      });

      const catalog1 = await provider.listModels(true);
      const testModelId = catalog1.models.find((m) => m.id === 'openai/gpt-5.2')?.id
        ?? catalog1.models.find((m) => m.id === 'openai/gpt-5.4')?.id
        ?? catalog1.models.find((m) => m.id.startsWith('openai/'))?.id;
      expect(testModelId).toBeTruthy();
      await vi.waitFor(async () => {
        const list = await provider.listModels(true);
        expect(list.models.map((m) => m.id)).toContain(testModelId);
      }, { timeout: 5_000 });

      const managedRoute = await provider.createSession({
        sessionKey: 'managed-route',
        sessionName: 'managed-worker',
        cwd: dirA,
        agentId: testModelId,
      });
      const plainRoute = await provider.createSession({
        sessionKey: 'plain-route',
        sessionName: 'plain-worker',
        cwd: dirB,
        agentId: testModelId,
      });

      // Only ONE OpenCode.create() host owned the shared DB across connect() + 2 sessions!
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(await provider.getNativeAgentFence(managedRoute)).toBe(NATIVE_AGENT_FENCES.DISABLED);
      expect(await provider.getNativeAgentFence(plainRoute)).toBe(NATIVE_AGENT_FENCES.PROVIDER_DEFAULT);

      await provider.send(managedRoute, 'check managed tools');
      await vi.waitFor(() => {
        if (errors1.length > 0) throw new Error(`provider1 error: ${JSON.stringify(errors1)}`);
        expect(completed).toContain(managedRoute);
      }, { timeout: 10_000 });
      await provider.send(plainRoute, 'check plain tools');
      await vi.waitFor(() => {
        if (errors1.length > 0) throw new Error(`provider1 error: ${JSON.stringify(errors1)}`);
        expect(completed).toContain(plainRoute);
      }, { timeout: 10_000 });

      expect(seenToolLists.length).toBeGreaterThanOrEqual(2);
      const managedTools = seenToolLists.find((item) => item.titleHint.includes('check managed tools'))?.tools ?? [];
      const plainTools = seenToolLists.find((item) => item.titleHint.includes('check plain tools'))?.tools ?? [];
      expect(managedTools).not.toContain('subagent');
      expect(plainTools).toContain('subagent');

      // Reopen on same DB after full disconnect -> restore the previously-plain session under a managed resolver
      const plainProviderSid = (provider as any).sessions.get(plainRoute).providerSessionId as string;
      await provider.disconnect();

      const provider2 = new OpenCodeSdkProvider();
      provider2.setNativeAgentFenceResolver((_sid, name) => name === 'restored-managed');
      const completed2: string[] = [];
      const errors2: any[] = [];
      provider2.onComplete((sid) => completed2.push(sid));
      provider2.onError((sid, err) => errors2.push({ sid, err }));
      await provider2.connect({ databasePath: dbPath, cwd: dirB } as any);
      expect(createSpy).toHaveBeenCalledTimes(2);
      await vi.waitFor(async () => {
        const list = await provider2.listModels(true);
        expect(list.models.map((m) => m.id)).toContain(testModelId);
      }, { timeout: 5_000 });
      const restoredManaged = await provider2.createSession({
        sessionKey: 'restored-managed-route',
        sessionName: 'restored-managed',
        cwd: dirB,
        skipCreate: true,
        resumeId: plainProviderSid,
        agentId: testModelId,
      });
      expect(await provider2.getNativeAgentFence(restoredManaged)).toBe(NATIVE_AGENT_FENCES.DISABLED);
      await provider2.send(restoredManaged, 'check restored managed tools');
      await vi.waitFor(() => {
        if (errors2.length > 0) throw new Error(`provider2 error: ${JSON.stringify(errors2)}`);
        expect(completed2).toContain(restoredManaged);
      }, { timeout: 10_000 });
      const restoredManagedTools = seenToolLists.find((item) => item.titleHint.includes('check restored managed tools'))?.tools ?? [];
      expect(restoredManagedTools).not.toContain('subagent');
      await provider2.disconnect();
    } finally {
      createSpy.mockRestore();
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
      srv.closeAllConnections?.();
      srv.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects plain 401, non-401 api_key_expired text, conflicting provider, and keeps inactive opencode backup credentials', async () => {
    for (const badError of [
      { type: 'provider.error', status: 401, message: 'Unauthorized: missing organization scope' },
      { type: 'provider.error', status: 400, message: 'note mentions api_key_expired in body without 401' },
      { type: 'provider.auth', status: 401, providerID: 'minimax', message: 'api_key_expired' },
    ]) {
      const harness = createHarness();
      harness.credentials.push({ id: 'cred-oc-only', integrationID: 'opencode', active: true });
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', harness.queue.close, { once: true });
        return { client: harness.client as any, server: harness.server };
      });
      const provider = new OpenCodeSdkProvider();
      const errors: any[] = [];
      provider.onError((_s, err) => errors.push(err));
      await provider.connect({});
      const routeId = await provider.createSession({
        sessionKey: 'route-strict-auth',
        cwd: '/tmp/project',
        agentId: DEFAULT_OPENCODE_MODEL_ID,
      });
      await provider.send(routeId, 'strict check');
      harness.queue.push({
        type: 'session.step.failed',
        data: { sessionID: 'oc-session-1', error: badError },
      });
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(harness.client.credential.remove).not.toHaveBeenCalled();
      expect(harness.client.sessions.prompt).toHaveBeenCalledOnce();
      await provider.disconnect();
    }

    // Multiple opencode credentials: remove ONLY active=true, leave inactive backup untouched!
    const harness = createHarness();
    harness.credentials.push(
      { id: 'cred-oc-expired', integrationID: 'opencode', label: 'expired-active', active: true },
      { id: 'cred-oc-backup', integrationID: 'opencode', label: 'valid-backup', active: false },
    );
    harness.client.provider.list.mockResolvedValue({
      data: [{ id: 'opencode', name: 'OpenCode', activation: 'enabled' }],
    });
    harness.client.model.list.mockResolvedValue({
      data: [{
        id: DEFAULT_OPENCODE_MODEL_ID,
        modelID: 'big-pickle',
        providerID: 'opencode',
        name: 'Big Pickle',
        enabled: true,
        type: 'chat',
      }],
    });
    harness.client.credential.remove.mockImplementation(async ({ credentialID }) => {
      const idx = harness.credentials.findIndex((c) => c.id === credentialID);
      if (idx >= 0) harness.credentials.splice(idx, 1);
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    const completes: any[] = [];
    provider.onComplete((_s, msg) => completes.push(msg));
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-backup-cred',
      cwd: '/tmp/project',
      agentId: DEFAULT_OPENCODE_MODEL_ID,
    });
    await provider.send(routeId, 'backup cred test');
    harness.queue.push({
      type: 'session.step.failed',
      data: {
        sessionID: 'oc-session-1',
        error: { type: 'provider.auth', status: 401, code: 'api_key_expired', message: 'API key expired' },
      },
    });
    await vi.waitFor(() => expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(2));
    expect(harness.client.credential.remove).toHaveBeenCalledOnce();
    expect(harness.client.credential.remove).toHaveBeenCalledWith({ credentialID: 'cred-oc-expired' });
    expect(harness.credentials).toEqual([{ id: 'cred-oc-backup', integrationID: 'opencode', label: 'valid-backup', active: false }]);
    harness.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-backup-ok', ordinal: 0, delta: 'OK with backup' } });
    harness.queue.push({ type: 'session.step.ended', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-backup-ok', finish: 'stop' } });
    await vi.waitFor(() => expect(completes).toHaveLength(1));
    await provider.disconnect();
  });

  it('keeps authHealInFlight fenced across hung switchModel against late attempt-1 frames, aborts cleanly on close, and refuses third-party model leak', async () => {
    // 1. Hung switchModel + late attempt-1 execution.failed / idle / execution.succeeded must not break retry
    const harness = createHarness();
    harness.credentials.push({ id: 'cred-oc-1', integrationID: 'opencode', active: true });
    let healed = false;
    harness.client.credential.remove.mockImplementation(async () => { healed = true; });
    harness.client.model.list.mockImplementation(async () => ({
      data: [
        ...(!healed ? [{ id: 'opencode/paid', modelID: 'paid', providerID: 'opencode', enabled: true, type: 'chat' }] : []),
        { id: DEFAULT_OPENCODE_MODEL_ID, modelID: 'big-pickle', providerID: 'opencode', enabled: true, type: 'chat' },
      ],
    }));
    const switchGate = deferred<void>();
    let switchCount = 0;
    harness.client.session.switchModel.mockImplementation(async () => {
      switchCount += 1;
      if (switchCount === 2) return switchGate.promise;
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    const completes: any[] = [];
    const errors: any[] = [];
    provider.onComplete((_s, msg) => completes.push(msg));
    provider.onError((_s, err) => errors.push(err));
    await provider.connect({});
    const routeId = await provider.createSession({
      sessionKey: 'route-hung-switch',
      cwd: '/tmp/project',
      agentId: 'opencode/paid',
    });
    await provider.send(routeId, 'attempt 1');

    harness.queue.push({
      type: 'session.step.failed',
      data: { sessionID: 'oc-session-1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
    });
    await vi.waitFor(() => expect(switchCount).toBe(2));

    // Late attempt-1 frames arrive while switchModel is STILL suspended!
    harness.queue.push({ type: 'session.execution.failed', data: { sessionID: 'oc-session-1', error: { message: 'late attempt 1 err' } } });
    harness.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1' } });
    harness.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await new Promise((r) => setTimeout(r, 25));
    expect(completes).toHaveLength(0);
    expect(errors).toHaveLength(0);

    switchGate.resolve();
    await vi.waitFor(() => expect(harness.client.sessions.prompt).toHaveBeenCalledTimes(2));
    harness.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-attempt-2', ordinal: 0, delta: 'Attempt 2 succeeded' } });
    harness.queue.push({ type: 'session.step.ended', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-attempt-2', finish: 'stop' } });
    await vi.waitFor(() => expect(completes).toHaveLength(1));
    expect(completes[0].content).toBe('Attempt 2 succeeded');
    expect(errors).toHaveLength(0);
    await provider.disconnect();

    // 2. endSession() / close mid-heal aborts cleanly without sending zombie retry
    const h2 = createHarness();
    const listGate = deferred<{ data: any[] }>();
    h2.client.model.list.mockImplementationOnce(async () => ({
      data: [{ id: DEFAULT_OPENCODE_MODEL_ID, modelID: 'big-pickle', providerID: 'opencode', enabled: true, type: 'chat' }],
    })).mockImplementationOnce(() => listGate.promise);
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', h2.queue.close, { once: true });
      return { client: h2.client as any, server: h2.server };
    });
    const p2 = new OpenCodeSdkProvider();
    await p2.connect({});
    const r2 = await p2.createSession({ sessionKey: 'route-close-mid-heal', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
    await p2.send(r2, 'trigger');
    h2.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } } });
    await vi.waitFor(() => expect(h2.client.model.list).toHaveBeenCalledTimes(2));
    await p2.endSession(r2);
    listGate.resolve({ data: [{ id: DEFAULT_OPENCODE_MODEL_ID, modelID: 'big-pickle', providerID: 'opencode', enabled: true, type: 'chat' }] });
    await new Promise((r) => setTimeout(r, 25));
    expect(h2.client.sessions.prompt).toHaveBeenCalledOnce();
    await p2.disconnect();

    // 3. Missing opencode/big-pickle in refreshed catalog with only third-party minimax model -> fail cleanly (no minimax leak!)
    const h3 = createHarness();
    h3.credentials.push({ id: 'cred-oc-paid', integrationID: 'opencode', active: true });
    let cleared = false;
    h3.client.credential.remove.mockImplementation(async () => { cleared = true; });
    h3.client.provider.list.mockImplementation(async () => ({
      data: cleared ? [{ id: 'minimax', name: 'MiniMax', activation: 'enabled' }] : [{ id: 'opencode', name: 'OpenCode', activation: 'enabled' }],
    }));
    h3.client.model.list.mockImplementation(async () => ({
      data: cleared
        ? [{ id: 'minimax/minimax-m2.5', modelID: 'minimax-m2.5', providerID: 'minimax', enabled: true, type: 'chat' }]
        : [{ id: 'opencode/paid', modelID: 'paid', providerID: 'opencode', enabled: true, type: 'chat' }],
    }));
    h3.client.model.default.mockImplementation(async () => ({
      data: cleared ? { providerID: 'minimax', modelID: 'minimax-m2.5' } : { providerID: 'opencode', modelID: 'paid' },
    }));
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', h3.queue.close, { once: true });
      return { client: h3.client as any, server: h3.server };
    });
    const p3 = new OpenCodeSdkProvider();
    const errs3: any[] = [];
    p3.onError((_s, err) => errs3.push(err));
    await p3.connect({});
    const r3 = await p3.createSession({ sessionKey: 'route-no-leak', cwd: '/tmp/project', agentId: 'opencode/paid' });
    await p3.send(r3, 'no third party leak');
    h3.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } } });
    await vi.waitFor(() => expect(errs3).toHaveLength(1));
    expect(errs3[0]).toMatchObject({ code: PROVIDER_ERROR_CODES.AUTH_FAILED, recoverable: false });
    expect(h3.client.sessions.prompt).toHaveBeenCalledOnce();
    await p3.disconnect();
  });

  it('losslessly converts project-scoped v1 file/agent parts, fails closed on unmigratable files/parts, and restores a v1.18.4 session without an external CLI binary', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-v1-real-attach-'));
    tempDirs.push(tempDir);
    const v1Bin = process.env.OPENCODE_V1_BIN;
    const xdgConfig = join(tempDir, 'xdg-config');
    const xdgData = join(tempDir, 'xdg-data');
    const xdgState = join(tempDir, 'xdg-state');
    const xdgCache = join(tempDir, 'xdg-cache');
    const workDir = join(tempDir, 'work');
    const outsideDir = join(tempDir, 'outside');
    const v2DbPath = join(tempDir, 'v2.db');
    mkdirSync(join(xdgConfig, 'opencode'), { recursive: true });
    mkdirSync(join(xdgData, 'opencode'), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const sampleContent = 'legacy-v1-attachment-payload\n';
    const sampleFile = join(workDir, 'attachment.txt');
    const outsideFile = join(outsideDir, 'secret.txt');
    writeFileSync(sampleFile, sampleContent);
    writeFileSync(outsideFile, 'outside-secret\n');

    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) as { messages?: Array<{ content?: unknown }> } : {};
        const lastMsg = JSON.stringify(parsed.messages?.at(-1) ?? {});
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: `V2_FOLLOWUP_OK:${lastMsg.slice(0, 40)}` }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolveListen) => srv.listen(0, '127.0.0.1', resolveListen));
    const port = (srv.address() as { port: number }).port;

    const prevXdgData = process.env.XDG_DATA_HOME;
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    const origCreate = OpenCode.create.bind(OpenCode);
    const createSpy = vi.spyOn(OpenCode, 'create');

    try {
      let legacySid = '';
      const { DatabaseSync } = await import('node:sqlite');
      const v1DbFile = join(xdgData, 'opencode', 'opencode.db');
      if (v1Bin && existsSync(v1Bin)) {
        writeFileSync(join(xdgConfig, 'opencode', 'opencode.json'), JSON.stringify({
          provider: {
            opencode: {
              name: 'OpenCode',
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'mock-v1-key' },
              models: { 'big-pickle': { name: 'Big Pickle' } },
            },
          },
          model: 'opencode/big-pickle',
        }));
        const runV1 = await new Promise<{ status: number | null; stderr: string }>((resolveRun, rejectRun) => {
          const child = spawn(v1Bin, ['run', '--file', sampleFile, '--', 'inspect attached file'], {
            cwd: workDir,
            env: {
              ...process.env,
              HOME: tempDir,
              PWD: workDir,
              XDG_CONFIG_HOME: xdgConfig,
              XDG_DATA_HOME: xdgData,
              XDG_STATE_HOME: xdgState,
              XDG_CACHE_HOME: xdgCache,
              OPENCODE_API_KEY: 'mock-v1-key',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stderr = '';
          child.stderr.on('data', (d) => { stderr += String(d); });
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            rejectRun(new Error(`v1 binary timed out: ${stderr}`));
          }, 20_000);
          child.on('error', (err) => {
            clearTimeout(timer);
            rejectRun(err);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolveRun({ status: code, stderr });
          });
        });
        expect(runV1.status).toBe(0);
        const v1Db = new DatabaseSync(v1DbFile);
        try {
          const row = v1Db.prepare('SELECT id FROM session ORDER BY time_created DESC LIMIT 1').get() as { id: string } | undefined;
          expect(row?.id).toMatch(/^ses_/);
          legacySid = row!.id;
        } finally {
          v1Db.close();
        }
      } else {
        // Exact v1.18.4 SQLite schema + row shapes observed from real `opencode run --file`
        legacySid = 'ses_legacy_v1_18_4_portable_001';
        const now = Date.now();
        const v1Db = new DatabaseSync(v1DbFile);
        try {
          v1Db.exec(`
            CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
            CREATE TABLE session (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              parent_id TEXT,
              slug TEXT NOT NULL,
              directory TEXT NOT NULL,
              title TEXT NOT NULL,
              version TEXT NOT NULL,
              permission TEXT,
              time_created INTEGER NOT NULL,
              time_updated INTEGER NOT NULL
            );
            CREATE TABLE message (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              time_created INTEGER NOT NULL,
              time_updated INTEGER NOT NULL,
              data TEXT NOT NULL
            );
            CREATE TABLE part (
              id TEXT PRIMARY KEY,
              message_id TEXT NOT NULL,
              session_id TEXT NOT NULL,
              time_created INTEGER NOT NULL,
              time_updated INTEGER NOT NULL,
              data TEXT NOT NULL
            );
          `);
          v1Db.prepare('INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)')
            .run('global', workDir, now, now);
          v1Db.prepare('INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, permission, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
              legacySid,
              'global',
              null,
              'portable-v1-file-session',
              workDir,
              'inspect attached file',
              '1.18.4',
              JSON.stringify([{ permission: 'external_directory', pattern: `${workDir}/*`, action: 'allow' }]),
              now,
              now,
            );
          v1Db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
            .run('msg_v1_user_1', legacySid, now, now, JSON.stringify({
              role: 'user',
              agent: 'build',
              model: { providerID: 'opencode', modelID: 'big-pickle' },
              time: { created: now },
            }));
          v1Db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
            .run('prt_v1_read_1', 'msg_v1_user_1', legacySid, now, now, JSON.stringify({
              type: 'text',
              text: `Called the Read tool with the following input: {"filePath":"${sampleFile}"}`,
              synthetic: true,
            }));
          v1Db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
            .run('prt_v1_file_1', 'msg_v1_user_1', legacySid, now + 1, now + 1, JSON.stringify({
              type: 'file',
              mime: 'text/plain',
              filename: 'attachment.txt',
              url: pathToFileURL(sampleFile).href,
            }));
          v1Db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
            .run('prt_v1_text_1', 'msg_v1_user_1', legacySid, now + 2, now + 2, JSON.stringify({
              type: 'text',
              text: 'inspect attached file',
            }));
          v1Db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
            .run('msg_v1_assistant_1', legacySid, now + 3, now + 4, JSON.stringify({
              role: 'assistant',
              parentID: 'msg_v1_user_1',
              modelID: 'big-pickle',
              providerID: 'opencode',
              finish: 'stop',
              time: { created: now + 3, completed: now + 4 },
            }));
          v1Db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
            .run('prt_v1_ast_1', 'msg_v1_assistant_1', legacySid, now + 4, now + 4, JSON.stringify({
              type: 'text',
              text: 'Read attachment.txt successfully.',
            }));
        } finally {
          v1Db.close();
        }
      }

      const v1DbExtra = new DatabaseSync(v1DbFile);
      try {
        const msg2 = 'msg_v1_inline_agent_2';
        v1DbExtra.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
          .run(msg2, legacySid, Date.now(), Date.now(), JSON.stringify({ role: 'user', agent: 'build', time: { created: Date.now() } }));
        v1DbExtra.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
          .run('prt_inline_1', msg2, legacySid, Date.now(), Date.now(), JSON.stringify({
            type: 'file',
            mime: 'image/png',
            filename: 'inline.png',
            url: `data:image/png;base64,${Buffer.from('PNG').toString('base64')}`,
          }));
        v1DbExtra.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
          .run('prt_agent_1', msg2, legacySid, Date.now(), Date.now(), JSON.stringify({
            type: 'agent',
            name: 'reviewer',
            source: { value: '@reviewer', start: 0, end: 9 },
          }));
      } finally {
        v1DbExtra.close();
      }

      process.env.XDG_DATA_HOME = xdgData;
      process.env.XDG_CONFIG_HOME = xdgConfig;
      createSpy.mockImplementation(async (opts: any) => origCreate({
        ...opts,
        config: {
          content: JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            share: 'disabled',
            provider: {
              mock: {
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-v2-local' },
                models: { 'big-pickle': { name: 'Mock Model' } },
              },
            },
            model: 'mock/big-pickle',
          }),
        },
      }));

      const provider = new OpenCodeSdkProvider();
      const completes: Array<{ sessionId: string; msg: any }> = [];
      provider.onComplete((sessionId, msg) => completes.push({ sessionId, msg }));
      await provider.connect({ databasePath: v2DbPath, cwd: workDir } as any);
      const client = (provider as any).client;
      const catalog = await provider.listModels(true);
      const modelId = catalog.models.find((m) => m.id === 'mock/big-pickle')?.id ?? 'mock/big-pickle';

      const restoredRoute = await provider.createSession({
        sessionKey: 'restored-v1-attach-route',
        cwd: workDir,
        skipCreate: true,
        resumeId: legacySid,
        agentId: modelId,
      });
      const importedMsgs = await client.message.list({ sessionID: legacySid });
      const msgData = importedMsgs.data ?? [];
      expect(msgData.some((m: any) => m.type === 'user' && Array.isArray(m.files) && m.files[0]?.name === 'inline.png')).toBe(true);
      expect(msgData.some((m: any) => m.type === 'user' && Array.isArray(m.agents) && m.agents[0]?.name === 'reviewer')).toBe(true);
      const migratedFileMsg = msgData.find((m: any) =>
        m.type === 'user'
        && Array.isArray(m.files)
        && m.files.some((f: any) => f.name === 'attachment.txt'),
      );
      expect(migratedFileMsg).toBeDefined();
      const migratedAttachment = migratedFileMsg.files.find((f: any) => f.name === 'attachment.txt');
      expect(migratedAttachment).toMatchObject({
        mime: 'text/plain',
        name: 'attachment.txt',
        data: Buffer.from(sampleContent).toString('base64'),
        source: { type: 'uri', uri: pathToFileURL(sampleFile).href },
      });
      expect(String(migratedFileMsg.text)).not.toContain('Attachment unavailable after migration');

      await provider.send(restoredRoute, 'continue restored v1 attachment session');
      await vi.waitFor(() => expect(completes).toHaveLength(1), { timeout: 10_000 });
      expect(completes[0].msg.content).toContain('V2_FOLLOWUP_OK:');
      expect(completes[0].msg.metadata?.providerSessionId).toBe(legacySid);

      // Fail-closed checks: unknown part type, missing file:// attachment, and out-of-project file:// attachment
      // MUST reject with actionable `opencode export <id>`, NEVER register partial session in v2 DB, and preserve v1 DB!
      const v1DbWrite = new DatabaseSync(v1DbFile);
      const badSid = 'ses_legacy_bad_part_001';
      const missingFileSid = 'ses_legacy_missing_file_001';
      const outsideFileSid = 'ses_legacy_outside_file_001';
      try {
        v1DbWrite.prepare('INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(badSid, 'global', workDir, 'bad-part-session', 'Bad Part Session', '1.18.4', Date.now(), Date.now());
        v1DbWrite.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
          .run('msg_bad_1', badSid, Date.now(), Date.now(), JSON.stringify({ role: 'user', time: { created: Date.now() } }));
        v1DbWrite.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
          .run('prt_bad_1', 'msg_bad_1', badSid, Date.now(), Date.now(), JSON.stringify({ type: 'unknown-v1-widget', payload: 1 }));

        v1DbWrite.prepare('INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(missingFileSid, 'global', workDir, 'missing-file-session', 'Missing File Session', '1.18.4', Date.now(), Date.now());
        v1DbWrite.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
          .run('msg_missing_1', missingFileSid, Date.now(), Date.now(), JSON.stringify({ role: 'user', time: { created: Date.now() } }));
        v1DbWrite.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
          .run('prt_missing_1', 'msg_missing_1', missingFileSid, Date.now(), Date.now(), JSON.stringify({
            type: 'file',
            mime: 'text/plain',
            filename: 'gone.txt',
            url: pathToFileURL(join(workDir, 'gone.txt')).href,
          }));

        v1DbWrite.prepare('INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(outsideFileSid, 'global', workDir, 'outside-file-session', 'Outside File Session', '1.18.4', Date.now(), Date.now());
        v1DbWrite.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
          .run('msg_outside_1', outsideFileSid, Date.now(), Date.now(), JSON.stringify({ role: 'user', time: { created: Date.now() } }));
        v1DbWrite.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
          .run('prt_outside_1', 'msg_outside_1', outsideFileSid, Date.now(), Date.now(), JSON.stringify({
            type: 'file',
            mime: 'text/plain',
            filename: 'secret.txt',
            url: pathToFileURL(outsideFile).href,
          }));
      } finally {
        v1DbWrite.close();
      }

      for (const failSid of [badSid, missingFileSid, outsideFileSid]) {
        await expect(provider.createSession({
          sessionKey: `fail-route-${failSid}`,
          cwd: workDir,
          skipCreate: true,
          resumeId: failSid,
        })).rejects.toThrow(`opencode export ${failSid}`);
        await expect(client.session.get({ sessionID: failSid })).rejects.toThrow();
      }

      const v1Check = new DatabaseSync(v1DbFile, { readOnly: true });
      try {
        expect(v1Check.prepare('SELECT id FROM session WHERE id = ?').get(missingFileSid)).toEqual({ id: missingFileSid });
      } finally {
        v1Check.close();
      }

      await provider.disconnect();
    } finally {
      createSpy.mockRestore();
      if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdgData;
      if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdgConfig;
      srv.closeAllConnections?.();
      srv.close();
    }
  }, 30_000);

  it('uses a single host event subscription (zero duplicate delivery) and isolates parallel same-cwd MCP sessions on a shared DB host', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-parallel-samecwd-mcp-'));
    tempDirs.push(tempDir);
    const sharedDir = join(tempDir, 'shared-project');
    const xdgDir = join(tempDir, 'xdg');
    const dbPath = join(tempDir, 'shared-v2.db');
    const mcpScript = join(tempDir, 'fake-mcp.mjs');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(xdgDir, { recursive: true });

    // Zero-dependency stdio MCP server returning its own process.env.IMCODES_SESSION
    writeFileSync(mcpScript, [
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  const msg = JSON.parse(line);",
      "  if (msg.method === 'initialize') {",
      "    reply(msg.id, {",
      "      protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',",
      "      capabilities: { tools: {} },",
      "      serverInfo: { name: 'imcodes-memory', version: '1.0.0' },",
      "    });",
      "  } else if (msg.method === 'tools/list') {",
      "    reply(msg.id, {",
      "      tools: [{",
      "        name: 'whoami',",
      "        description: 'Return session env identity',",
      "        inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
      "      }],",
      "    });",
      "  } else if (msg.method === 'tools/call') {",
      "    reply(msg.id, {",
      "      content: [{ type: 'text', text: JSON.stringify({ session: process.env.IMCODES_DAEMON_SESSION_NAME ?? 'unset' }) }],",
      "    });",
      "  } else if (msg.id !== undefined) {",
      "    reply(msg.id, {});",
      "  }",
      "});",
    ].join('\n'));

    let callSeq = 0;
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) as {
          messages?: Array<{ role?: string; content?: unknown }>;
          tools?: Array<{ function?: { name?: string } }>;
        } : {};
        const last = parsed.messages?.at(-1);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (last?.role === 'tool') {
          const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
          res.write(`data: ${JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: `WHOAMI=${text}` }, finish_reason: null }],
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 15, completion_tokens: 8 },
          })}\n\n`);
        } else {
          const toolName = (parsed.tools ?? []).map((t) => t.function?.name).find((n) => n?.includes('whoami'));
          if (!toolName) {
            res.write(`data: ${JSON.stringify({
              id: 'c1',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: 'NO_MCP_TOOL' }, finish_reason: null }],
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
              id: 'c1',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({
              id: 'c1',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `tc_${++callSeq}`, type: 'function', function: { name: toolName, arguments: '{}' } }] }, finish_reason: null }],
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
              id: 'c1',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            })}\n\n`);
          }
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolveListen) => srv.listen(0, '127.0.0.1', resolveListen));
    const port = (srv.address() as { port: number }).port;

    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgDir;
    const origCreate = OpenCode.create.bind(OpenCode);
    const createSpy = vi.spyOn(OpenCode, 'create');
    let subscribeCalls = 0;

    try {
      createSpy.mockImplementation(async (opts: any) => {
        const sdk = await origCreate({
          ...opts,
          config: {
            content: JSON.stringify({
              $schema: 'https://opencode.ai/config.json',
              share: 'disabled',
              provider: {
                mock: {
                  npm: '@ai-sdk/openai-compatible',
                  options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-mcp-test' },
                  models: { 'big-pickle': { name: 'Mock Model' } },
                },
              },
              model: 'mock/big-pickle',
            }),
          },
        });
        const origSub = sdk.events.subscribe.bind(sdk.events);
        (sdk.events as any).subscribe = (...args: any[]) => {
          subscribeCalls += 1;
          return origSub(...args);
        };
        return sdk;
      });

      const provider = new OpenCodeSdkProvider();
      const completes: Array<{ sessionId: string; msg: any }> = [];
      const toolsBySession = new Map<string, string[]>();
      const errors: any[] = [];
      provider.onComplete((sessionId, msg) => completes.push({ sessionId, msg }));
      provider.onToolCall((sessionId, tool) => {
        if (tool.status === 'complete') {
          const list = toolsBySession.get(sessionId) ?? [];
          list.push(tool.id);
          toolsBySession.set(sessionId, list);
        }
      });
      provider.onError((sessionId, err) => errors.push({ sessionId, err }));

      await provider.connect({ databasePath: dbPath, cwd: sharedDir } as any);
      const catalog = await provider.listModels(true);
      const modelId = catalog.models.find((m) => m.id === 'mock/big-pickle')?.id ?? 'mock/big-pickle';

      // Create two concurrent sessions sharing the EXACT same `sharedDir` cwd, pointing to our isolated stdio MCP script
      const origStart = openCodeSdkRuntimeHooks.start.bind(openCodeSdkRuntimeHooks);
      const hookSpy = vi.spyOn(openCodeSdkRuntimeHooks, 'start').mockImplementation(async (startOpts) => {
        const res = await origStart(startOpts);
        const origBind = res.bindSessionMcp;
        return {
          ...res,
          ...(origBind
            ? {
              bindSessionMcp: (psid, dir, servers) => {
                const patched = Object.fromEntries(
                  Object.entries(servers).map(([name, spec]) => [name, {
                    ...spec,
                    command: ['node', mcpScript],
                  }]),
                );
                return origBind(psid, dir, patched);
              },
            }
            : {}),
        };
      });

      try {
        const routeA = await provider.createSession({
          sessionKey: 'samecwd-alpha',
          sessionName: 'deck_sub_alpha',
          cwd: sharedDir,
          agentId: modelId,
        });
        const routeB = await provider.createSession({
          sessionKey: 'samecwd-beta',
          sessionName: 'deck_sub_beta',
          cwd: sharedDir,
          agentId: modelId,
        });

        // Only ONE shared host AND ONLY ONE events.subscribe() stream across connect + both sessions!
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(subscribeCalls).toBe(1);

        // Execute parallel turns in both sessions sharing sharedDir
        await Promise.all([
          provider.send(routeA, 'identify alpha'),
          provider.send(routeB, 'identify beta'),
        ]);
        await vi.waitFor(() => {
          if (errors.length > 0) throw new Error(`Parallel MCP errors: ${JSON.stringify(errors)}`);
          expect(completes.filter((c) => c.sessionId === routeA)).toHaveLength(1);
          expect(completes.filter((c) => c.sessionId === routeB)).toHaveLength(1);
        }, { timeout: 15_000 });

        const completeA = completes.find((c) => c.sessionId === routeA)!;
        const completeB = completes.find((c) => c.sessionId === routeB)!;
        expect(completeA.msg.content).toContain('"session":"deck_sub_alpha"');
        expect(completeB.msg.content).toContain('"session":"deck_sub_beta"');
        // Zero duplicate tool call / completion deliveries
        expect(toolsBySession.get(routeA)).toHaveLength(1);
        expect(toolsBySession.get(routeB)).toHaveLength(1);

        // Close Session B only -> Session A's stream & MCP client must keep working identically
        await provider.endSession(routeB);
        await provider.send(routeA, 'identify alpha again');
        await vi.waitFor(() => {
          expect(completes.filter((c) => c.sessionId === routeA)).toHaveLength(2);
        }, { timeout: 15_000 });
        expect(completes.filter((c) => c.sessionId === routeA)[1].msg.content).toContain('"session":"deck_sub_alpha"');
        expect(subscribeCalls).toBe(1);

        await provider.disconnect();
      } finally {
        hookSpy.mockRestore();
      }
    } finally {
      createSpy.mockRestore();
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
      srv.closeAllConnections?.();
      srv.close();
    }
  }, 35_000);

  it('ignores late session.execution.failed and session.execution.interrupted during manual /compact', async () => {
    const harness = createHarness();
    const compactDeferred = deferred<Record<string, unknown>>();
    harness.client.session.compact.mockImplementationOnce(() => compactDeferred.promise);
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    const completes: any[] = [];
    const errors: any[] = [];
    provider.onComplete((_s, msg) => completes.push(msg));
    provider.onError((_s, err) => errors.push(err));
    await provider.connect({});
    const routeId = await provider.createSession({ sessionKey: 'route-compact-stale-fail', cwd: '/tmp/project' });

    const compactPromise = provider.send(routeId, '/compact');
    await vi.waitFor(() => expect(harness.client.session.compact).toHaveBeenCalledOnce());
    const compactInputId = (harness.client.session.compact.mock.calls[0]?.[0] as { id: string }).id;

    harness.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', error: { message: 'stale prior step failed' } } });
    harness.queue.push({ type: 'session.execution.failed', data: { sessionID: 'oc-session-1', error: { message: 'stale prior exec failed' } } });
    harness.queue.push({ type: 'session.execution.interrupted', data: { sessionID: 'oc-session-1', reason: 'user' } });
    compactDeferred.resolve({ id: compactInputId });
    await compactPromise;
    await new Promise((r) => setTimeout(r, 20));
    expect(errors).toHaveLength(0);
    expect(completes).toHaveLength(0);

    harness.queue.push({ type: 'session.compaction.started', data: { sessionID: 'oc-session-1', reason: 'manual', inputID: compactInputId } });
    harness.queue.push({ type: 'session.compaction.ended', data: { sessionID: 'oc-session-1', reason: 'manual', inputID: compactInputId } });
    await vi.waitFor(() => expect(completes).toHaveLength(1));
    expect(completes[0].content).toBe('OpenCode context compacted.');
    expect(errors).toHaveLength(0);
    await provider.disconnect();
  });

  it('deduplicates concurrent acquireClientEventSubscription calls, handles failures cleanly, and unsubscribes once after all leases release', async () => {
    const harness = createHarness();
    let subCalls = 0;
    let abortedCount = 0;
    const subGate = deferred<any>();
    harness.client.events.subscribe = vi.fn(async (_opts: any, reqOpts?: { signal?: AbortSignal }) => {
      subCalls += 1;
      reqOpts?.signal?.addEventListener('abort', () => { abortedCount += 1; }, { once: true });
      if (subCalls === 1) return subGate.promise;
      if (subCalls === 2) throw new Error('transient subscribe error');
      return {
        stream: (async function* () {
          while (!reqOpts?.signal?.aborted) {
            await new Promise((r) => setTimeout(r, 5));
          }
        })(),
      };
    });

    const provider = new OpenCodeSdkProvider();
    const acquire = (provider as any).acquireClientEventSubscription.bind(provider) as (c: any) => Promise<() => Promise<void>>;

    // Concurrent acquire calls before subscribe settles MUST share 1 upstream subscribe and refCount=2
    const p1 = acquire(harness.client);
    const p2 = acquire(harness.client);
    await vi.waitFor(() => expect(subCalls).toBe(1));
    subGate.resolve({
      stream: (async function* () {
        await new Promise((r) => setTimeout(r, 500));
      })(),
    });
    const [rel1, rel2] = await Promise.all([p1, p2]);
    expect(subCalls).toBe(1);
    await rel1();
    expect(abortedCount).toBe(0);
    await rel2();
    expect(abortedCount).toBe(1);

    // Concurrent failure cleans up pending entry so subsequent acquire succeeds cleanly
    const failedClient = { events: { subscribe: harness.client.events.subscribe } };
    const f1 = acquire(failedClient);
    const f2 = acquire(failedClient);
    await expect(Promise.all([f1, f2])).rejects.toThrow('transient subscribe error');
    expect(subCalls).toBe(2);

    const rel3 = await acquire(failedClient);
    expect(subCalls).toBe(3);
    await rel3();
    expect(abortedCount).toBe(2);
  });

  it('hands off MCP session ownership across routes sharing resumeId and restores fallback owner immediately on detach', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-same-resume-handoff-'));
    tempDirs.push(tempDir);
    const workDir = join(tempDir, 'project');
    const xdgDir = join(tempDir, 'xdg');
    const dbPath = join(tempDir, 'v2.db');
    const mcpScript = join(tempDir, 'fake-mcp.mjs');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(xdgDir, { recursive: true });

    writeFileSync(mcpScript, [
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  const msg = JSON.parse(line);",
      "  if (msg.method === 'initialize') {",
      "    reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'imcodes-memory', version: '1.0.0' } });",
      "  } else if (msg.method === 'tools/list') {",
      "    reply(msg.id, { tools: [{ name: 'whoami', description: 'Return session env', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] });",
      "  } else if (msg.method === 'tools/call') {",
      "    reply(msg.id, { content: [{ type: 'text', text: JSON.stringify({ owner: process.env.IMCODES_DAEMON_SESSION_NAME ?? 'unset' }) }] });",
      "  } else if (msg.id !== undefined) {",
      "    reply(msg.id, {});",
      "  }",
      "});",
    ].join('\n'));

    let tcSeq = 0;
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> } : {};
        const last = parsed.messages?.at(-1);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (last?.role === 'tool') {
          const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: `RESULT=${text}` }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
        } else {
          const toolName = (parsed.tools ?? []).map((t) => t.function?.name).find((n) => n?.includes('whoami'));
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `tc_r_${++tcSeq}`, type: 'function', function: { name: toolName, arguments: '{}' } }] }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolveListen) => srv.listen(0, '127.0.0.1', resolveListen));
    const port = (srv.address() as { port: number }).port;

    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgDir;
    const origCreate = OpenCode.create.bind(OpenCode);
    const createSpy = vi.spyOn(OpenCode, 'create').mockImplementation(async (opts: any) => origCreate({
      ...opts,
      config: {
        content: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          share: 'disabled',
          provider: {
            mock: {
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-handoff' },
              models: { 'big-pickle': { name: 'Mock Model' } },
            },
          },
          model: 'mock/big-pickle',
        }),
      },
    }));
    const origStart = openCodeSdkRuntimeHooks.start.bind(openCodeSdkRuntimeHooks);
    const hookSpy = vi.spyOn(openCodeSdkRuntimeHooks, 'start').mockImplementation(async (startOpts) => {
      const res = await origStart(startOpts);
      const origBind = res.bindSessionMcp;
      return {
        ...res,
        ...(origBind
          ? {
            bindSessionMcp: (psid, dir, servers) => {
              const patched = Object.fromEntries(
                Object.entries(servers).map(([name, spec]) => [name, { ...spec, command: ['node', mcpScript] }]),
              );
              return origBind(psid, dir, patched);
            },
          }
          : {}),
      };
    });

    try {
      const provider = new OpenCodeSdkProvider();
      const completes: Array<{ sessionId: string; msg: any }> = [];
      provider.onComplete((sessionId, msg) => completes.push({ sessionId, msg }));
      await provider.connect({ databasePath: dbPath, cwd: workDir } as any);
      const catalog = await provider.listModels(true);
      const modelId = catalog.models.find((m) => m.id === 'mock/big-pickle')?.id ?? 'mock/big-pickle';

      const infos: Array<{ sessionId: string; resumeId?: string }> = [];
      provider.onSessionInfo((sessionId, info) => infos.push({ sessionId, resumeId: info.resumeId }));

      const route1 = await provider.createSession({
        sessionKey: 'handoff-route-1',
        sessionName: 'deck_owner_one',
        cwd: workDir,
        agentId: modelId,
      });
      const sharedSid = infos.find((i) => i.sessionId === route1)?.resumeId!;
      expect(sharedSid).toBeTruthy();

      const route2 = await provider.createSession({
        sessionKey: 'handoff-route-2',
        sessionName: 'deck_owner_two',
        cwd: workDir,
        skipCreate: true,
        resumeId: sharedSid,
        agentId: modelId,
      });

      await provider.send(route2, 'check route2 owner');
      await vi.waitFor(() => expect(completes.filter((c) => c.sessionId === route2)).toHaveLength(1), { timeout: 15_000 });
      expect(completes.find((c) => c.sessionId === route2)!.msg.content).toContain('"owner":"deck_owner_two"');

      // Detaching route2 MUST immediately restore route1's MCP identity instead of keeping route2 env or losing MCP!
      await provider.detachSession(route2);
      await provider.send(route1, 'check route1 restored owner');
      await vi.waitFor(() => expect(completes.filter((c) => c.sessionId === route1)).toHaveLength(1), { timeout: 15_000 });
      expect(completes.find((c) => c.sessionId === route1)!.msg.content).toContain('"owner":"deck_owner_one"');

      await provider.disconnect();
    } finally {
      hookSpy.mockRestore();
      createSpy.mockRestore();
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
      srv.closeAllConnections?.();
      srv.close();
    }
  }, 35_000);

  it('rejects non-expired 401/403, conflicting providers, mid-turn credential switches, and unattributable OPENCODE_API_KEY deletion', async () => {
    // 1. Generic 401 invalid_api_key / Invalid credential & 403 must NOT delete credentials
    for (const [label, err] of [
      ['invalid_api_key', { type: 'provider.auth', status: 401, code: 'invalid_api_key', message: 'Invalid credential' }],
      ['403_with_expired_phrase', { type: 'provider.auth', status: 403, message: 'api_key_expired forbidden' }],
      ['conflict_opencode_turn_minimax_err', { type: 'provider.auth', status: 401, providerID: 'minimax', message: 'api_key_expired' }],
    ] as const) {
      const h = createHarness();
      h.credentials.push({ id: `cred-${label}`, integrationID: 'opencode', active: true });
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });
      const provider = new OpenCodeSdkProvider();
      const errs: any[] = [];
      provider.onError((_s, e) => errs.push(e));
      await provider.connect({});
      const routeId = await provider.createSession({ sessionKey: `route-${label}`, cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await provider.send(routeId, 'test');
      h.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', error: err } });
      await vi.waitFor(() => expect(errs).toHaveLength(1));
      expect(errs[0].code).toBe(PROVIDER_ERROR_CODES.AUTH_FAILED);
      expect(h.client.credential.remove).not.toHaveBeenCalled();
      expect(h.client.sessions.prompt).toHaveBeenCalledOnce();
      await provider.disconnect();
    }

    // 2. Minimax turn whose error carries providerID: 'opencode' still refuses healing (conflicting active step provider)
    const hConflict = createHarness();
    hConflict.credentials.push({ id: 'cred-oc-keep', integrationID: 'opencode', active: true });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', hConflict.queue.close, { once: true });
      return { client: hConflict.client as any, server: hConflict.server };
    });
    const pConflict = new OpenCodeSdkProvider();
    const errsConflict: any[] = [];
    pConflict.onError((_s, e) => errsConflict.push(e));
    await pConflict.connect({});
    const rConflict = await pConflict.createSession({ sessionKey: 'route-mm-oc-err', cwd: '/tmp/project', agentId: 'minimax/MiniMax-M2.5' });
    await pConflict.send(rConflict, 'test');
    hConflict.queue.push({
      type: 'session.step.started',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-mm', model: { providerID: 'minimax', id: 'MiniMax-M2.5' } },
    });
    hConflict.queue.push({
      type: 'session.step.failed',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-mm', error: { type: 'provider.auth', status: 401, providerID: 'opencode', message: 'api_key_expired' } },
    });
    await vi.waitFor(() => expect(errsConflict).toHaveLength(1));
    expect(hConflict.client.credential.remove).not.toHaveBeenCalled();
    await pConflict.disconnect();

    // 3. Credential replaced after turn started (`time.created` > startedAt + credential.switched) MUST NOT be deleted
    const hSwitched = createHarness();
    hSwitched.credentials.push({ id: 'cred-fresh-replacement', integrationID: 'opencode', active: true, time: { updated: Date.now() + 60_000 } } as any);
    hSwitched.client.model.list.mockResolvedValue({
      data: [{ id: DEFAULT_OPENCODE_MODEL_ID, modelID: 'big-pickle', providerID: 'opencode', enabled: true, type: 'chat' }],
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', hSwitched.queue.close, { once: true });
      return { client: hSwitched.client as any, server: hSwitched.server };
    });
    const pSwitched = new OpenCodeSdkProvider();
    const completesSwitched: any[] = [];
    pSwitched.onComplete((_s, m) => completesSwitched.push(m));
    await pSwitched.connect({});
    const rSwitched = await pSwitched.createSession({ sessionKey: 'route-fresh-cred', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
    await pSwitched.send(rSwitched, 'hello');
    hSwitched.queue.push({ type: 'credential.switched', data: { integrationID: 'opencode' } });
    hSwitched.queue.push({
      type: 'session.step.failed',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-old-attempt', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
    });
    await vi.waitFor(() => expect(hSwitched.client.sessions.prompt).toHaveBeenCalledTimes(2));
    expect(hSwitched.client.credential.remove).not.toHaveBeenCalled();
    hSwitched.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-new-attempt', ordinal: 0, delta: 'Kept fresh cred' } });
    hSwitched.queue.push({ type: 'session.step.ended', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-new-attempt', finish: 'stop' } });
    await vi.waitFor(() => expect(completesSwitched).toHaveLength(1));
    expect(completesSwitched[0].content).toBe('Kept fresh cred');
    await pSwitched.disconnect();

    // 4. OPENCODE_API_KEY env var active with only inactive backup DB cred -> fail cleanly, preserve backup cred
    const prevEnvKey = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = 'sk-expired-env-only';
    try {
      const hEnv = createHarness();
      hEnv.credentials.push({ id: 'cred-backup-inactive', integrationID: 'opencode', active: false });
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', hEnv.queue.close, { once: true });
        return { client: hEnv.client as any, server: hEnv.server };
      });
      const pEnv = new OpenCodeSdkProvider();
      const errsEnv: any[] = [];
      pEnv.onError((_s, e) => errsEnv.push(e));
      await pEnv.connect({});
      const rEnv = await pEnv.createSession({ sessionKey: 'route-env-backup', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await pEnv.send(rEnv, 'hello env');
      hEnv.queue.push({
        type: 'session.step.failed',
        data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-env-1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
      });
      await vi.waitFor(() => expect(errsEnv).toHaveLength(1));
      expect(errsEnv[0]).toMatchObject({
        code: PROVIDER_ERROR_CODES.AUTH_FAILED,
        recoverable: false,
        message: expect.stringContaining('OPENCODE_API_KEY'),
      });
      expect(hEnv.client.credential.remove).not.toHaveBeenCalled();
      expect(hEnv.credentials).toHaveLength(1);
      expect(hEnv.client.sessions.prompt).toHaveBeenCalledOnce();
      await pEnv.disconnect();
    } finally {
      if (prevEnvKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = prevEnvKey;
    }
  });

  it('correlates retry attempt pre-ACK events and ignores delayed stale ID-less Attempt-1 terminal frames', async () => {
    // 1. Synchronous pre-ACK retry events (both success and fast fail) inside sessions.prompt settle cleanly
    for (const mode of ['succeed-pre-ack', 'fail-pre-ack'] as const) {
      const h = createHarness();
      h.credentials.push({ id: 'cred-preack', integrationID: 'opencode', active: true });
      h.client.model.list.mockResolvedValue({
        data: [{ id: DEFAULT_OPENCODE_MODEL_ID, modelID: 'big-pickle', providerID: 'opencode', enabled: true, type: 'chat' }],
      });
      const retryPromptGate = deferred<Record<string, unknown>>();
      h.client.sessions.prompt.mockImplementation(async (args: { id: string }) => {
        if (h.client.sessions.prompt.mock.calls.length === 1) return { id: args.id };
        h.queue.push({ type: 'session.inbox.delivered', data: { sessionID: 'oc-session-1', inboxID: args.id } });
        h.queue.push({ type: 'session.step.started', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-retry-preack', inputID: args.id, model: { providerID: 'opencode', id: 'big-pickle' } } });
        if (mode === 'succeed-pre-ack') {
          h.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-retry-preack', ordinal: 0, delta: 'Retry pre-ACK ok' } });
          h.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1', inputID: args.id } });
        } else {
          h.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-retry-preack', inputID: args.id, error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } } });
        }
        return retryPromptGate.promise;
      });
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });
      const provider = new OpenCodeSdkProvider();
      const completes: any[] = [];
      const errors: any[] = [];
      provider.onComplete((_s, m) => completes.push(m));
      provider.onError((_s, e) => errors.push(e));
      await provider.connect({});
      const routeId = await provider.createSession({ sessionKey: `route-${mode}`, cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await provider.send(routeId, 'hello pre-ack');
      h.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-attempt1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } } });
      if (mode === 'succeed-pre-ack') {
        await vi.waitFor(() => expect(completes).toHaveLength(1));
        expect(completes[0].content).toBe('Retry pre-ACK ok');
      } else {
        await vi.waitFor(() => expect(errors).toHaveLength(1));
        expect(errors[0].code).toBe(PROVIDER_ERROR_CODES.AUTH_FAILED);
      }
      retryPromptGate.resolve({});
      await provider.disconnect();
    }

    // 2. Stale Attempt-1 ID-less execution.succeeded / execution.failed / idle AFTER Retry prompt ACK are ignored when message.list has no Retry assistant reply yet
    const h2 = createHarness();
    h2.credentials.push({ id: 'cred-stale-ack', integrationID: 'opencode', active: true });
    h2.client.model.list.mockResolvedValue({
      data: [{ id: DEFAULT_OPENCODE_MODEL_ID, modelID: 'big-pickle', providerID: 'opencode', enabled: true, type: 'chat' }],
    });
    let retryIdCaptured = '';
    h2.client.sessions.prompt.mockImplementation(async (args: { id: string }) => {
      if (h2.client.sessions.prompt.mock.calls.length === 2) retryIdCaptured = args.id;
      return { id: args.id };
    });
    h2.client.message.list.mockImplementation(async () => ({
      data: retryIdCaptured
        ? [
          { id: retryIdCaptured, type: 'user' },
          { id: 'msg-attempt1-err', type: 'assistant', error: { type: 'provider.auth', message: 'api_key_expired' } },
        ]
        : [],
    }));
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', h2.queue.close, { once: true });
      return { client: h2.client as any, server: h2.server };
    });
    const p2 = new OpenCodeSdkProvider();
    const c2: any[] = [];
    const e2: any[] = [];
    p2.onComplete((_s, m) => c2.push(m));
    p2.onError((_s, e) => e2.push(e));
    await p2.connect({});
    const r2 = await p2.createSession({ sessionKey: 'route-stale-after-ack', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
    await p2.send(r2, 'hello stale noise');
    h2.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-attempt1-err', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } } });
    await vi.waitFor(() => expect(h2.client.sessions.prompt).toHaveBeenCalledTimes(2));

    // Stale Attempt-1 ID-less terminal frames + old Attempt-1 assistant delta arrive BEFORE Retry finishes
    h2.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-attempt1-err', ordinal: 0, delta: 'STALE_ATTEMPT1' } });
    h2.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1' } });
    h2.queue.push({ type: 'session.execution.failed', data: { sessionID: 'oc-session-1', error: { message: 'stale err' } } });
    h2.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(c2).toHaveLength(0);
    expect(e2).toHaveLength(0);

    // Real Retry step & completion settle cleanly (ID-less execution.succeeded confirms via persisted assistant record in message.list)
    let retryCompletedInDb = false;
    h2.client.message.list.mockImplementation(async () => ({
      data: retryIdCaptured
        ? [
          ...(retryCompletedInDb
            ? [{ id: 'msg-retry-2', type: 'assistant', parentID: retryIdCaptured, finish: 'stop' }]
            : []),
          { id: retryIdCaptured, type: 'user' },
          { id: 'msg-attempt1-err', type: 'assistant', error: { type: 'provider.auth', message: 'api_key_expired' } },
        ]
        : [],
    }));
    h2.queue.push({ type: 'session.step.started', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-retry-2', inputID: retryIdCaptured, model: { providerID: 'opencode', id: 'big-pickle' } } });
    h2.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-retry-2', ordinal: 0, delta: 'Genuine Retry Success' } });
    retryCompletedInDb = true;
    h2.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(c2).toHaveLength(1));
    expect(c2[0].content).toBe('Genuine Retry Success');
    expect(e2).toHaveLength(0);
    await p2.disconnect();
  });

  it('recovers a dropped or EOF event feed across both existing route next turn and new routes with 1x delivery', async () => {
    const h = createHarness();
    const q1 = createAsyncQueue<Record<string, unknown>>();
    const q2 = createAsyncQueue<Record<string, unknown>>();
    let subSeq = 0;
    h.client.events.subscribe = vi.fn(async () => {
      subSeq += 1;
      if (subSeq === 1) {
        return {
          stream: {
            [Symbol.asyncIterator]() {
              const inner = q1.stream[Symbol.asyncIterator]();
              return {
                async next() {
                  const res = await inner.next();
                  if (!res.done && (res.value as any).__throwStreamErr) {
                    throw new Error('upstream subscriber overflow');
                  }
                  return res;
                },
                return: inner.return?.bind(inner),
              };
            },
          },
        };
      }
      return { stream: q2.stream };
    });
    let createCount = 0;
    h.client.sessions.create.mockImplementation(async () => ({ id: `oc-feed-ses-${++createCount}` }));
    openCodeSdkRuntimeHooks.start = vi.fn(async () => ({ client: h.client as any, server: h.server }));

    const provider = new OpenCodeSdkProvider();
    const completes: Array<{ sessionId: string; content: string }> = [];
    const errors: Array<{ sessionId: string; error: any }> = [];
    provider.onComplete((s, m) => completes.push({ sessionId: s, content: m.content }));
    provider.onError((s, e) => errors.push({ sessionId: s, error: e }));
    await provider.connect({});

    const r1 = await provider.createSession({ sessionKey: 'feed-route-1', cwd: '/tmp/project' });
    await provider.send(r1, 'turn 1');
    q1.push({ type: 'session.text.delta', data: { sessionID: 'oc-feed-ses-1', assistantMessageID: 'm1', ordinal: 0, delta: 'r1-t1' } });
    q1.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-feed-ses-1' } });
    await vi.waitFor(() => expect(completes).toHaveLength(1));

    // Stream 1 drops with upstream overflow while route 1 stays open (idle)
    q1.push({ __throwStreamErr: true });
    await vi.waitFor(() => expect(subSeq).toBe(2));
    expect(errors).toHaveLength(0);

    // Existing route1 next turn recovers on live stream 2 AND new route2 shares live stream 2 with 1x delivery
    const r2 = await provider.createSession({ sessionKey: 'feed-route-2', cwd: '/tmp/project' });
    await provider.send(r1, 'turn 2');
    await provider.send(r2, 'r2 turn 1');
    q2.push({ type: 'session.text.delta', data: { sessionID: 'oc-feed-ses-1', assistantMessageID: 'm2', ordinal: 0, delta: 'r1-t2' } });
    q2.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-feed-ses-1' } });
    q2.push({ type: 'session.text.delta', data: { sessionID: 'oc-feed-ses-2', assistantMessageID: 'm3', ordinal: 0, delta: 'r2-t1' } });
    q2.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-feed-ses-2' } });
    await vi.waitFor(() => expect(completes).toHaveLength(3));
    expect(completes.map((c) => `${c.sessionId}:${c.content}`)).toEqual([
      `${r1}:r1-t1`,
      `${r1}:r1-t2`,
      `${r2}:r2-t1`,
    ]);
    expect(subSeq).toBe(2);
    expect(errors).toHaveLength(0);
    q2.close();
    await provider.disconnect();
  });

  it('prevents delayed route-A send admission or concurrent fallback from clobbering route-B MCP ownership on shared resumeId', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-concurrent-handoff-'));
    tempDirs.push(tempDir);
    const workDir = join(tempDir, 'project');
    const xdgDir = join(tempDir, 'xdg');
    const dbPath = join(tempDir, 'v2.db');
    const mcpScript = join(tempDir, 'fake-mcp.mjs');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(xdgDir, { recursive: true });

    writeFileSync(mcpScript, [
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  const msg = JSON.parse(line);",
      "  if (msg.method === 'initialize') reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'imcodes-memory', version: '1.0.0' } });",
      "  else if (msg.method === 'tools/list') reply(msg.id, { tools: [{ name: 'whoami', description: 'Return session identity', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] });",
      "  else if (msg.method === 'tools/call') reply(msg.id, { content: [{ type: 'text', text: JSON.stringify({ owner: process.env.IMCODES_DAEMON_SESSION_NAME ?? 'unset' }) }] });",
      "  else if (msg.id !== undefined) reply(msg.id, {});",
      "});",
    ].join('\n'));

    let tcSeq = 0;
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }> } : {};
        const last = parsed.messages?.at(-1);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (last?.role === 'tool') {
          const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: `TOOL=${text}` }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        } else {
          const toolName = (parsed.tools ?? []).map((t) => t.function?.name).find((n) => n?.includes('whoami'));
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `tc_race_${++tcSeq}`, type: 'function', function: { name: toolName, arguments: '{}' } }] }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolveListen) => srv.listen(0, '127.0.0.1', resolveListen));
    const port = (srv.address() as { port: number }).port;

    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgDir;
    const origCreate = OpenCode.create.bind(OpenCode);
    const createSpy = vi.spyOn(OpenCode, 'create').mockImplementation(async (opts: any) => origCreate({
      ...opts,
      config: {
        content: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          share: 'disabled',
          provider: {
            mock: {
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-race' },
              models: { 'big-pickle': { name: 'Mock Model' } },
            },
          },
          model: 'mock/big-pickle',
        }),
      },
    }));
    const origStart = openCodeSdkRuntimeHooks.start.bind(openCodeSdkRuntimeHooks);
    const hookSpy = vi.spyOn(openCodeSdkRuntimeHooks, 'start').mockImplementation(async (startOpts) => {
      const res = await origStart(startOpts);
      const origBind = res.bindSessionMcp;
      return {
        ...res,
        ...(origBind
          ? {
            bindSessionMcp: (psid, dir, servers) => {
              const patched = Object.fromEntries(
                Object.entries(servers).map(([name, spec]) => [name, { ...spec, command: ['node', mcpScript] }]),
              );
              return origBind(psid, dir, patched);
            },
          }
          : {}),
      };
    });

    try {
      const provider = new OpenCodeSdkProvider();
      const completes: Array<{ sessionId: string; msg: any }> = [];
      provider.onComplete((sessionId, msg) => completes.push({ sessionId, msg }));
      await provider.connect({ databasePath: dbPath, cwd: workDir } as any);
      const catalog = await provider.listModels(true);
      const modelId = catalog.models.find((m) => m.id === 'mock/big-pickle')?.id ?? 'mock/big-pickle';
      const infos: Array<{ sessionId: string; resumeId?: string }> = [];
      provider.onSessionInfo((sessionId, info) => infos.push({ sessionId, resumeId: info.resumeId }));

      const routeA = await provider.createSession({
        sessionKey: 'race-route-a',
        sessionName: 'deck_owner_a',
        cwd: workDir,
        agentId: modelId,
      });
      const sharedSid = infos.find((i) => i.sessionId === routeA)?.resumeId!;

      // Suspend routeA's send at pre-lock acceptance check, then let routeB take ownership of sharedSid
      const acceptGate = deferred<boolean>();
      const acceptSpy = vi.spyOn(provider as any, 'hasAcceptedPrompt').mockImplementationOnce(async () => acceptGate.promise);
      const delayedSendA = provider.send(routeA, 'stale A send');
      await vi.waitFor(() => expect(acceptSpy).toHaveBeenCalledOnce());

      const routeB = await provider.createSession({
        sessionKey: 'race-route-b',
        sessionName: 'deck_owner_b',
        cwd: workDir,
        skipCreate: true,
        resumeId: sharedSid,
        agentId: modelId,
      });

      // Releasing delayed routeA send AFTER routeB took ownership MUST reject routeA without overwriting B's MCP
      acceptGate.resolve(false);
      await expect(delayedSendA).rejects.toThrow();

      await provider.send(routeB, 'real tool call on B');
      await vi.waitFor(() => expect(completes.filter((c) => c.sessionId === routeB)).toHaveLength(1), { timeout: 15_000 });
      expect(completes.find((c) => c.sessionId === routeB)!.msg.content).toContain('"owner":"deck_owner_b"');

      // During in-flight detach (before fallback MCP rebind settles), fallback routeA MUST NOT be executable yet;
      // once detachSession completes, routeA becomes owner and receives deck_owner_a.
      const detachPromise = provider.detachSession(routeB);
      await expect(provider.send(routeA, 'premature pre-rebind A send')).rejects.toThrow();
      await detachPromise;
      await provider.send(routeA, 'post-detach A send');
      await vi.waitFor(() => expect(completes.filter((c) => c.sessionId === routeA)).toHaveLength(1), { timeout: 15_000 });
      expect(completes.find((c) => c.sessionId === routeA)!.msg.content).toContain('"owner":"deck_owner_a"');

      await provider.disconnect();
    } finally {
      hookSpy.mockRestore();
      createSpy.mockRestore();
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
      srv.closeAllConnections?.();
      srv.close();
    }
  }, 35_000);

  it('preserves a credential activated while credential.list() is pending under real v2.4.2 list shapes and refuses DB deletion when OPENCODE_API_KEY is active', async () => {
    // 1. Real v2.4.2 list shape (NO timestamps: id/integrationID/label/active/value only) + credential activated mid-read
    const h = createHarness();
    h.credentials.push({
      id: 'cred-old-real',
      integrationID: 'opencode',
      label: 'old',
      active: true,
      value: { type: 'key', key: 'sk-old' },
    } as any);
    const listGate = deferred<Array<Record<string, unknown>>>();
    h.client.model.list.mockResolvedValue({
      data: [{ id: DEFAULT_OPENCODE_MODEL_ID, modelID: 'big-pickle', providerID: 'opencode', enabled: true, type: 'chat' }],
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', h.queue.close, { once: true });
      return { client: h.client as any, server: h.server };
    });

    const p = new OpenCodeSdkProvider();
    const completes: any[] = [];
    const errors: any[] = [];
    p.onComplete((_s, m) => completes.push(m));
    p.onError((_s, e) => errors.push(e));
    await p.connect({});
    const routeId = await p.createSession({ sessionKey: 'route-mid-read-switch', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
    await p.send(routeId, 'hello');

    h.client.credential.list.mockImplementationOnce(() => listGate.promise);
    h.queue.push({
      type: 'session.step.failed',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-att1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
    });
    await vi.waitFor(() => expect(h.client.credential.list).toHaveBeenCalledTimes(2));

    // Activate new credential AFTER 401 while credential.list() is STILL pending, with ZERO timestamp fields
    h.queue.push({ type: 'credential.switched', data: { integrationID: 'opencode', credentialID: 'cred-new-real' } });
    listGate.resolve([
      { id: 'cred-old-real', integrationID: 'opencode', label: 'old', active: false, value: { type: 'key', key: 'sk-old' } },
      { id: 'cred-new-real', integrationID: 'opencode', label: 'new', active: true, value: { type: 'key', key: 'sk-new' } },
    ]);

    await vi.waitFor(() => expect(h.client.sessions.prompt).toHaveBeenCalledTimes(2));
    expect(h.client.credential.remove).not.toHaveBeenCalled();

    h.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-att2', ordinal: 0, delta: 'Recovered with new real key' } });
    h.queue.push({ type: 'session.step.ended', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-att2', finish: 'stop' } });
    await vi.waitFor(() => expect(completes).toHaveLength(1));
    expect(completes[0].content).toBe('Recovered with new real key');
    expect(errors).toHaveLength(0);
    await p.disconnect();

    // 2. OPENCODE_API_KEY env var active + DB ALSO contains an active stored opencode cred -> must fail safe BEFORE any credential.remove()
    const prevEnvKey = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = 'sk-env-precedence';
    try {
      const hEnv = createHarness();
      hEnv.credentials.push({ id: 'cred-stored-active', integrationID: 'opencode', active: true });
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', hEnv.queue.close, { once: true });
        return { client: hEnv.client as any, server: hEnv.server };
      });
      const pEnv = new OpenCodeSdkProvider();
      const errsEnv: any[] = [];
      pEnv.onError((_s, e) => errsEnv.push(e));
      await pEnv.connect({});
      const rEnv = await pEnv.createSession({ sessionKey: 'route-env-preserve-active', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await pEnv.send(rEnv, 'hello env');
      hEnv.queue.push({
        type: 'session.step.failed',
        data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-env-2', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
      });
      await vi.waitFor(() => expect(errsEnv).toHaveLength(1));
      expect(errsEnv[0]).toMatchObject({
        code: PROVIDER_ERROR_CODES.AUTH_FAILED,
        recoverable: false,
        message: expect.stringContaining('OPENCODE_API_KEY'),
      });
      expect(hEnv.client.credential.remove).not.toHaveBeenCalled();
      expect(hEnv.credentials).toHaveLength(1);
      await pEnv.disconnect();
    } finally {
      if (prevEnvKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = prevEnvKey;
    }
  });

  it('never settles retry on transient history read failure after ACK or on late ID-less Attempt-1 terminals after retry becomes active', async () => {
    const h = createHarness();
    h.credentials.push({ id: 'cred-reconcile', integrationID: 'opencode', active: true });
    h.client.model.list.mockResolvedValue({
      data: [{ id: DEFAULT_OPENCODE_MODEL_ID, modelID: 'big-pickle', providerID: 'opencode', enabled: true, type: 'chat' }],
    });
    let retryId = '';
    h.client.sessions.prompt.mockImplementation(async (args: { id: string }) => {
      if (h.client.sessions.prompt.mock.calls.length === 2) retryId = args.id;
      return { id: args.id };
    });
    let listMode: 'throw' | 'pending' | 'terminal-ok' = 'throw';
    h.client.message.list.mockImplementation(async () => {
      if (listMode === 'throw') throw new Error('temporary SQLite busy');
      if (listMode === 'pending') {
        return {
          data: [
            { id: retryId, type: 'user' },
            { id: 'msg-att1-fail', type: 'assistant', error: { type: 'provider.auth', message: 'api_key_expired' } },
          ],
        };
      }
      return {
        data: [
          { id: 'msg-retry-active-1', type: 'assistant', parentID: retryId, finish: 'stop' },
          { id: retryId, type: 'user' },
        ],
      };
    });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', h.queue.close, { once: true });
      return { client: h.client as any, server: h.server };
    });

    const p = new OpenCodeSdkProvider();
    const completes: any[] = [];
    const errors: any[] = [];
    p.onComplete((_s, m) => completes.push(m));
    p.onError((_s, e) => errors.push(e));
    await p.connect({});
    const routeId = await p.createSession({ sessionKey: 'route-retry-active-reconcile', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
    await p.send(routeId, 'hello retry active');

    h.queue.push({
      type: 'session.step.failed',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-att1-fail', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
    });
    await vi.waitFor(() => expect(h.client.sessions.prompt).toHaveBeenCalledTimes(2));

    // 1. After ACK, transient message.list failure MUST NOT let delayed ID-less idle or execution.failed settle retry
    listMode = 'throw';
    h.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    h.queue.push({ type: 'session.execution.failed', data: { sessionID: 'oc-session-1', error: { message: 'delayed attempt-1 fail' } } });
    await new Promise((r) => setTimeout(r, 30));
    expect(completes).toHaveLength(0);
    expect(errors).toHaveLength(0);

    // 2. Retry becomes 'retry-active', then late ID-less Attempt-1 terminals STILL must go through reconciliation and NOT settle
    listMode = 'pending';
    h.queue.push({ type: 'session.inbox.delivered', data: { sessionID: 'oc-session-1', inboxID: retryId } });
    h.queue.push({ type: 'session.step.started', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-retry-active-1', inputID: retryId, model: { providerID: 'opencode', id: 'big-pickle' } } });
    h.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-retry-active-1', ordinal: 0, delta: 'Final active output' } });
    h.queue.push({ type: 'session.idle', data: { sessionID: 'oc-session-1' } });
    h.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1' } });
    h.queue.push({ type: 'session.execution.failed', data: { sessionID: 'oc-session-1', error: { message: 'late noise' } } });
    await new Promise((r) => setTimeout(r, 30));
    expect(completes).toHaveLength(0);
    expect(errors).toHaveLength(0);

    // 3. Only once Retry's terminal assistant record exists in message.list does a single ID-less terminal
    // recover across transient read errors and settle strictly once (no double push needed)
    listMode = 'terminal-ok';
    h.client.message.list.mockRejectedValueOnce(new Error('transient sqlite busy'));
    h.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(completes).toHaveLength(1));
    expect(completes[0].content).toBe('Final active output');
    expect(errors).toHaveLength(0);
    await p.disconnect();
  });

  it('serializes in-flight sessions.prompt and session.compact admission with route handoff on a shared providerSessionId', async () => {
    const harness = createHarness();
    harness.sessions.set('oc-shared-1', { id: 'oc-shared-1', title: 'shared', location: { directory: '/tmp/project' } });
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });

    const provider = new OpenCodeSdkProvider();
    await provider.connect({});
    const routeA = await provider.createSession({
      sessionKey: 'handoff-lock-a',
      sessionName: 'deck_handoff_a',
      cwd: '/tmp/project',
      skipCreate: true,
      resumeId: 'oc-shared-1',
      agentId: DEFAULT_OPENCODE_MODEL_ID,
    });

    // Pending sessions.prompt inside withProviderSessionLock for routeA is aborted immediately by routeB takeover (not hung for 15s)
    const promptGate = deferred<{ id: string; sessionID: string; type: string }>();
    harness.client.sessions.prompt.mockImplementationOnce(async () => promptGate.promise);
    const sendAResult = provider.send(routeA, 'locked prompt A').then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.waitFor(() => expect(harness.client.sessions.prompt).toHaveBeenCalledOnce());

    const routeB = await provider.createSession({
      sessionKey: 'handoff-lock-b',
      sessionName: 'deck_handoff_b',
      cwd: '/tmp/project',
      skipCreate: true,
      resumeId: 'oc-shared-1',
      agentId: DEFAULT_OPENCODE_MODEL_ID,
    });
    await expect(sendAResult).resolves.toBe('rejected');
    expect((provider as any).providerToRoute.get('oc-shared-1')).toBe(routeB);
    expect(harness.client.session.interrupt).toHaveBeenCalledWith({ sessionID: 'oc-shared-1' });
    promptGate.resolve({ id: 'msg-a-1', sessionID: 'oc-shared-1', type: 'user' });

    // Compact admission on stale routeA is rejected cleanly after B owns the session
    await expect(provider.send(routeA, '/compact')).rejects.toThrow(/owner/i);
    expect(harness.client.session.compact).not.toHaveBeenCalled();

    // Pending compact on current owner routeB is also aborted immediately when routeC takes over ownership
    const compactGate = deferred<{ id: string }>();
    harness.client.session.compact.mockImplementationOnce(async () => compactGate.promise);
    const compactBResult = provider.send(routeB, '/compact').then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.waitFor(() => expect(harness.client.session.compact).toHaveBeenCalledOnce());

    const routeC = await provider.createSession({
      sessionKey: 'handoff-lock-c',
      sessionName: 'deck_handoff_c',
      cwd: '/tmp/project',
      skipCreate: true,
      resumeId: 'oc-shared-1',
      agentId: DEFAULT_OPENCODE_MODEL_ID,
    });
    await expect(compactBResult).resolves.toBe('rejected');
    expect((provider as any).providerToRoute.get('oc-shared-1')).toBe(routeC);
    compactGate.resolve({ id: 'msg-compact-b' });
    await provider.disconnect();
  });

  it('revokes the active turn generation on feed disconnect so suspended heal and retry RPCs cannot run after recovery', async () => {
    const h1 = createHarness();
    const h2 = createHarness();
    h1.credentials.push({
      id: 'cred-stale-gen',
      integrationID: 'opencode',
      label: 'stale',
      active: true,
      value: { type: 'key', key: 'sk-stale-gen' },
    } as any);
    let subscribeCalls = 0;
    const sharedClient = {
      ...h1.client,
      events: {
        subscribe: vi.fn(async () => {
          subscribeCalls += 1;
          return subscribeCalls === 1 ? h1.queue.stream : h2.queue.stream;
        }),
      },
    };
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', () => {
        h1.queue.close();
        h2.queue.close();
      }, { once: true });
      return { client: sharedClient as any, server: h1.server };
    });

    const p = new OpenCodeSdkProvider();
    const completes: any[] = [];
    const errors: any[] = [];
    p.onComplete((_s, m) => completes.push(m));
    p.onError((_s, e) => errors.push(e));
    await p.connect({});
    const routeId = await p.createSession({ sessionKey: 'route-eof-revoke', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
    await p.send(routeId, 'turn-1');

    // Suspend credential.list() inside tryHeal, then kill stream 1 with an error (simulating EOF/disconnect)
    const credGate = deferred<Array<Record<string, unknown>>>();
    sharedClient.credential.list.mockImplementationOnce(() => credGate.promise);
    h1.queue.push({
      type: 'session.step.failed',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-att1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
    });
    await vi.waitFor(() => expect(sharedClient.credential.list).toHaveBeenCalledTimes(2));

    h1.queue.fail(new Error('unexpected EOF'));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0].recoverable).toBe(true);

    // Resolve the suspended credential read AFTER failOnce revoked generation and host feed restarted on stream 2:
    // neither credential.remove nor a zombie retry prompt may execute.
    credGate.resolve([{ id: 'cred-stale-gen', integrationID: 'opencode', active: true, value: { type: 'key', key: 'sk-stale-gen' } }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(sharedClient.credential.remove).not.toHaveBeenCalled();
    expect(sharedClient.sessions.prompt).toHaveBeenCalledTimes(1);

    // Next normal send re-attaches cleanly to live stream 2 and completes strictly once
    await p.send(routeId, 'turn-2');
    h2.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-att2', ordinal: 0, delta: 'Recovered post-EOF' } });
    h2.queue.push({ type: 'session.step.ended', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-att2', finish: 'stop' } });
    await vi.waitFor(() => expect(completes).toHaveLength(1));
    expect(completes[0].content).toBe('Recovered post-EOF');
    expect(subscribeCalls).toBe(2);
    await p.disconnect();
  });

  it('preserves active replacement credentials, in-place rotated keys, ambiguous provenance, and refreshes provenance after feed drops', async () => {
    const defaultModelCatalog = {
      data: [{ id: DEFAULT_OPENCODE_MODEL_ID, modelID: 'big-pickle', providerID: 'opencode', enabled: true, type: 'chat' }],
    };

    // A. Another active credential already appears in credential.list() BEFORE credential.switched arrives -> preserved!
    {
      const h = createHarness();
      h.client.model.list.mockResolvedValue(defaultModelCatalog);
      h.credentials.push({ id: 'cred-old', integrationID: 'opencode', label: 'old', active: true, value: { type: 'key', key: 'sk-old' } } as any);
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });
      const p = new OpenCodeSdkProvider();
      const completes: any[] = [];
      p.onComplete((_s, m) => completes.push(m));
      await p.connect({});
      const r = await p.createSession({ sessionKey: 'prov-a', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await p.send(r, 'go');

      // Mutate list directly without pushing credential.switched SSE yet
      h.credentials.splice(0, h.credentials.length,
        { id: 'cred-old', integrationID: 'opencode', label: 'old', active: false, value: { type: 'key', key: 'sk-old' } } as any,
        { id: 'cred-new', integrationID: 'opencode', label: 'new', active: true, value: { type: 'key', key: 'sk-new' } } as any,
      );
      h.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } } });
      await vi.waitFor(() => expect(h.client.sessions.prompt).toHaveBeenCalledTimes(2));
      expect(h.client.credential.remove).not.toHaveBeenCalled();
      await p.disconnect();
    }

    // B. Same credential ID updated in-place (value changed, no timestamps, no SSE switched) -> preserved!
    {
      const h = createHarness();
      h.client.model.list.mockResolvedValue(defaultModelCatalog);
      h.credentials.push({ id: 'cred-same', integrationID: 'opencode', label: 'same', active: true, value: { type: 'key', key: 'sk-v1' } } as any);
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });
      const p = new OpenCodeSdkProvider();
      await p.connect({});
      const r = await p.createSession({ sessionKey: 'prov-b', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await p.send(r, 'go');

      h.credentials[0] = { id: 'cred-same', integrationID: 'opencode', label: 'same', active: true, value: { type: 'key', key: 'sk-v2' } } as any;
      h.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } } });
      await vi.waitFor(() => expect(h.client.sessions.prompt).toHaveBeenCalledTimes(2));
      expect(h.client.credential.remove).not.toHaveBeenCalled();
      await p.disconnect();
    }

    // C. Ambiguous multiple active stored opencode credentials at dispatch -> fail safe, delete NONE, emit AUTH_FAILED
    {
      const h = createHarness();
      h.client.model.list.mockResolvedValue(defaultModelCatalog);
      h.credentials.push(
        { id: 'cred-1', integrationID: 'opencode', active: true, value: { type: 'key', key: 'sk-1' } } as any,
        { id: 'cred-2', integrationID: 'opencode', active: true, value: { type: 'key', key: 'sk-2' } } as any,
      );
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });
      const p = new OpenCodeSdkProvider();
      const errors: any[] = [];
      p.onError((_s, e) => errors.push(e));
      await p.connect({});
      const r = await p.createSession({ sessionKey: 'prov-c', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await p.send(r, 'go');

      h.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } } });
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0].code).toBe(PROVIDER_ERROR_CODES.AUTH_FAILED);
      expect(h.client.credential.remove).not.toHaveBeenCalled();
      expect(h.client.sessions.prompt).toHaveBeenCalledOnce();
      await p.disconnect();
    }

    // D. Feed drop + credential rotation while disconnected refreshes provenance on next send and removes the NEW expired id only
    {
      const h1 = createHarness();
      const h2 = createHarness();
      h1.client.model.list.mockResolvedValue(defaultModelCatalog);
      h1.credentials.push({ id: 'cred-a', integrationID: 'opencode', active: true, value: { type: 'key', key: 'sk-a' } } as any);
      let subCount = 0;
      const client = {
        ...h1.client,
        events: {
          subscribe: vi.fn(async () => {
            subCount += 1;
            return subCount === 1 ? h1.queue.stream : h2.queue.stream;
          }),
        },
      };
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', () => {
          h1.queue.close();
          h2.queue.close();
        }, { once: true });
        return { client: client as any, server: h1.server };
      });
      const p = new OpenCodeSdkProvider();
      await p.connect({});
      const r = await p.createSession({ sessionKey: 'prov-d', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await p.send(r, 'turn 1');
      h1.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', ordinal: 0, delta: 'ok1' } });
      h1.queue.push({ type: 'session.step.ended', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', finish: 'stop' } });
      await new Promise((res) => setTimeout(res, 20));

      // Drop stream 1 while switching active credential to cred-b on disk
      h1.credentials.splice(0, h1.credentials.length,
        { id: 'cred-a', integrationID: 'opencode', active: false, value: { type: 'key', key: 'sk-a' } } as any,
        { id: 'cred-b', integrationID: 'opencode', active: true, value: { type: 'key', key: 'sk-b' } } as any,
      );
      h1.queue.fail(new Error('stream dropped'));
      await new Promise((res) => setTimeout(res, 20));

      // Next send refreshes provenance -> binds cred-b -> 401 deletes ONLY cred-b (never cred-a)
      await p.send(r, 'turn 2');
      h2.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-2', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } } });
      await vi.waitFor(() => expect(h1.client.credential.remove).toHaveBeenCalledOnce());
      expect(h1.client.credential.remove).toHaveBeenCalledWith({ credentialID: 'cred-b' });
      await p.disconnect();
    }
  });

  it('fails with recoverable CONNECTION_LOST and clears busy state when retry terminal reconciliation keeps failing to read history', async () => {
    const h = createHarness();
    h.client.model.list.mockResolvedValue({
      data: [{ id: DEFAULT_OPENCODE_MODEL_ID, modelID: 'big-pickle', providerID: 'opencode', enabled: true, type: 'chat' }],
    });
    h.credentials.push({ id: 'cred-cap', integrationID: 'opencode', active: true, value: { type: 'key', key: 'sk-cap' } } as any);
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', h.queue.close, { once: true });
      return { client: h.client as any, server: h.server };
    });

    const p = new OpenCodeSdkProvider();
    const completes: any[] = [];
    const errors: any[] = [];
    p.onComplete((_s, m) => completes.push(m));
    p.onError((_s, e) => errors.push(e));
    await p.connect({});
    const routeId = await p.createSession({ sessionKey: 'route-reconcile-cap', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
    await p.send(routeId, 'hello cap');

    h.queue.push({
      type: 'session.step.failed',
      data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-att1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
    });
    await vi.waitFor(() => expect(h.client.sessions.prompt).toHaveBeenCalledTimes(2));

    h.client.message.list.mockRejectedValue(new Error('persistent 503 history unavailable'));
    h.queue.push({ type: 'session.execution.succeeded', data: { sessionID: 'oc-session-1' } });
    await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 5_000 });
    expect(errors[0].code).toBe(PROVIDER_ERROR_CODES.CONNECTION_LOST);
    expect(errors[0].recoverable).toBe(true);
    expect(completes).toHaveLength(0);

    // Confirm route is no longer stuck busy: subsequent send succeeds cleanly
    await p.send(routeId, 'follow-up after cap');
    h.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-follow', ordinal: 0, delta: 'Healthy follow-up' } });
    h.queue.push({ type: 'session.step.ended', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-follow', finish: 'stop' } });
    await vi.waitFor(() => expect(completes).toHaveLength(1));
    expect(completes[0].content).toBe('Healthy follow-up');
    await p.disconnect();
  });

  it('does NOT auto-delete OAuth/external credentials or plain Reconnect-Console 401s without an api_key_expired signal', async () => {
    // 1. OAuth credential passing fingerprint check MUST NEVER be removed without atomic CAS precondition
    {
      const h = createHarness();
      h.credentials.push({
        id: 'cred-oauth-1',
        integrationID: 'opencode',
        label: 'oauth-acc',
        active: true,
        value: { type: 'oauth', methodID: 'device', refresh: 'r-1', access: 'a-1', expires: Date.now() + 60_000 },
      } as any);
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });
      const p = new OpenCodeSdkProvider();
      const errors: any[] = [];
      p.onError((_s, e) => errors.push(e));
      await p.connect({});
      const r = await p.createSession({ sessionKey: 'route-oauth-preserve', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await p.send(r, 'hello oauth');

      h.queue.push({
        type: 'session.step.failed',
        data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
      });
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0].code).toBe(PROVIDER_ERROR_CODES.AUTH_FAILED);
      expect(errors[0].message).toMatch(/atomic|reconnect/i);
      expect(h.client.credential.remove).not.toHaveBeenCalled();
      expect(h.credentials).toHaveLength(1);
      await p.disconnect();
    }

    // 2. External credential MUST also be preserved with actionable AUTH_FAILED diagnostic
    {
      const h = createHarness();
      h.credentials.push({
        id: 'cred-ext-1',
        integrationID: 'opencode',
        active: true,
        value: { type: 'external', methodID: 'sso' },
      } as any);
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });
      const p = new OpenCodeSdkProvider();
      const errors: any[] = [];
      p.onError((_s, e) => errors.push(e));
      await p.connect({});
      const r = await p.createSession({ sessionKey: 'route-ext-preserve', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await p.send(r, 'hello ext');

      h.queue.push({
        type: 'session.step.failed',
        data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } },
      });
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0].code).toBe(PROVIDER_ERROR_CODES.AUTH_FAILED);
      expect(h.client.credential.remove).not.toHaveBeenCalled();
      await p.disconnect();
    }

    // 3. Generic Console SignedOutError ("Reconnect OpenCode Console to continue.") without api_key_expired MUST preserve key
    {
      const h = createHarness();
      h.credentials.push({ id: 'cred-generic-401', integrationID: 'opencode', active: true, value: { type: 'key', key: 'sk-wrong' } } as any);
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });
      const p = new OpenCodeSdkProvider();
      const errors: any[] = [];
      p.onError((_s, e) => errors.push(e));
      await p.connect({});
      const r = await p.createSession({ sessionKey: 'route-signed-out-preserve', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await p.send(r, 'hello bad key');

      h.queue.push({
        type: 'session.step.failed',
        data: {
          sessionID: 'oc-session-1',
          assistantMessageID: 'msg-1',
          error: {
            type: 'provider.auth',
            status: 401,
            message: 'Reconnect OpenCode Console to continue.',
            response: { body: JSON.stringify({ error: { type: 'authentication_error', message: 'Reconnect OpenCode Console to continue.' } }) },
          },
        },
      });
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0].code).toBe(PROVIDER_ERROR_CODES.AUTH_FAILED);
      expect(h.client.credential.remove).not.toHaveBeenCalled();
      expect(h.credentials).toHaveLength(1);
      await p.disconnect();
    }
  });

  it('aborts pending SDK admission AbortController on timeout, cancel, and route handoff and releases suspended routes safely', async () => {
    // 1. Fake timers: prompt stays pending until request timeout -> signal aborts, send rejects, concurrent routeB owns session cleanly
    {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const harness = createHarness();
        harness.sessions.set('oc-timeout-1', { id: 'oc-timeout-1', title: 't', location: { directory: '/tmp/project' } });
        const promptGate = deferred<{ id: string; sessionID: string; type: string }>();
        let observedSignal: AbortSignal | undefined;
        let promptCalls = 0;
        harness.client.sessions.prompt = (async (_input: any, opts?: { signal?: AbortSignal }) => {
          promptCalls += 1;
          observedSignal = opts?.signal;
          return promptGate.promise;
        }) as any;
        openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
          options.signal.addEventListener('abort', harness.queue.close, { once: true });
          return { client: harness.client as any, server: harness.server };
        });

        const provider = new OpenCodeSdkProvider();
        await provider.connect({});
        const routeA = await provider.createSession({
          sessionKey: 'timeout-route-a',
          sessionName: 'deck_to_a',
          cwd: '/tmp/project',
          skipCreate: true,
          resumeId: 'oc-timeout-1',
          agentId: DEFAULT_OPENCODE_MODEL_ID,
        });

        const sendA = provider.send(routeA, 'slow admission A');
        const sendAResult = sendA.then(
          () => ({ rejected: false }),
          () => ({ rejected: true }),
        );
        await vi.waitFor(() => expect(promptCalls).toBe(1));
        expect(observedSignal?.aborted).toBe(false);

        // Trigger timeout while promptGate is still pending
        await vi.advanceTimersByTimeAsync(16_000);
        expect(observedSignal?.aborted).toBe(true);

        const routeB = await provider.createSession({
          sessionKey: 'timeout-route-b',
          sessionName: 'deck_to_b',
          cwd: '/tmp/project',
          skipCreate: true,
          resumeId: 'oc-timeout-1',
          agentId: DEFAULT_OPENCODE_MODEL_ID,
        });
        expect((provider as any).providerToRoute.get('oc-timeout-1')).toBe(routeB);

        // Late settlement of underlying SDK RPC after timeout + handoff must reject A cleanly and leave B intact
        promptGate.resolve({ id: 'msg-late-resolved', sessionID: 'oc-timeout-1', type: 'user' });
        await expect(sendAResult).resolves.toEqual({ rejected: true });
        expect((provider as any).providerToRoute.get('oc-timeout-1')).toBe(routeB);
        await provider.disconnect();
      } finally {
        vi.useRealTimers();
      }
    }

    // 2. Cancel while SDK admission is STILL pending (not yet accepted): aborts signal immediately without blocking Stop
    {
      const harness = createHarness();
      const promptGate = deferred<{ id: string; sessionID: string; type: string }>();
      let observedSignal: AbortSignal | undefined;
      let promptCalls = 0;
      harness.client.sessions.prompt = (async (_input: any, opts?: { signal?: AbortSignal }) => {
        promptCalls += 1;
        observedSignal = opts?.signal;
        return promptGate.promise;
      }) as any;
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', harness.queue.close, { once: true });
        return { client: harness.client as any, server: harness.server };
      });
      const provider = new OpenCodeSdkProvider();
      const errors: any[] = [];
      provider.onError((_s, e) => errors.push(e));
      await provider.connect({});
      const routeId = await provider.createSession({ sessionKey: 'cancel-unaccepted', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });

      const sendP = provider.send(routeId, 'unaccepted prompt').then(
        () => 'resolved',
        () => 'rejected',
      );
      await vi.waitFor(() => expect(promptCalls).toBe(1));
      expect(observedSignal?.aborted).toBe(false);

      await provider.cancel(routeId);
      expect(observedSignal?.aborted).toBe(true);
      expect(errors.map((e) => e.code)).toContain(PROVIDER_ERROR_CODES.CANCELLED);
      await expect(sendP).resolves.toBe('resolved');

      // Resolving the underlying gate afterward produces zero extra errors or completions
      promptGate.resolve({ id: 'msg-after-cancel', sessionID: 'oc-session-1', type: 'user' });
      await new Promise((r) => setTimeout(r, 20));
      expect(errors).toHaveLength(1);
      await provider.disconnect();
    }
  });

  it('settles assistant-less retry execution.failed/interrupted cleanly via bounded reconciliation while preserving active retry on late Attempt-1 noise', async () => {
    const defaultModelCatalog = {
      data: [{ id: DEFAULT_OPENCODE_MODEL_ID, modelID: 'big-pickle', providerID: 'opencode', enabled: true, type: 'chat' }],
    };

    // A. True Retry execution.failed BEFORE any assistant message is created (empty assistant history, inbox drained) -> recoverable error + busy cleared
    {
      const h = createHarness();
      h.client.model.list.mockResolvedValue(defaultModelCatalog);
      h.credentials.push({ id: 'cred-no-asst', integrationID: 'opencode', active: true, value: { type: 'key', key: 'sk-old' } } as any);
      (h.client.session as any).inbox = { list: vi.fn(async () => []) };
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });

      const p = new OpenCodeSdkProvider();
      const completes: any[] = [];
      const errors: any[] = [];
      p.onComplete((_s, m) => completes.push(m));
      p.onError((_s, e) => errors.push(e));
      await p.connect({});
      const r = await p.createSession({ sessionKey: 'no-asst-fail', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await p.send(r, 'hello');

      h.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-att1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } } });
      await vi.waitFor(() => expect(h.client.sessions.prompt).toHaveBeenCalledTimes(2));
      const retryId = (h.client.sessions.prompt.mock.calls[1]?.[0] as { id: string }).id;
      h.client.message.list.mockResolvedValue({
        data: [
          { id: retryId, type: 'user' },
          { id: 'msg-att1', type: 'assistant', error: { type: 'provider.auth', message: 'api_key_expired' } },
        ],
      });

      // ID-less execution.failed arrives from Retry before any assistant record exists
      h.queue.push({
        type: 'session.execution.failed',
        data: { sessionID: 'oc-session-1', error: { type: 'provider.internal', message: 'model init crashed pre-step' } },
      });
      await vi.waitFor(() => expect(errors).toHaveLength(1), { timeout: 5_000 });
      expect(errors[0].recoverable).toBe(true);
      expect(errors[0].message).toContain('model init crashed pre-step');
      expect(completes).toHaveLength(0);

      // Route must NOT be stuck busy: subsequent turn runs cleanly
      await p.send(r, 'after no-asst failure');
      h.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-next', ordinal: 0, delta: 'Recovered turn' } });
      h.queue.push({ type: 'session.step.ended', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-next', finish: 'stop' } });
      await vi.waitFor(() => expect(completes).toHaveLength(1));
      expect(completes[0].content).toBe('Recovered turn');
      await p.disconnect();
    }

    // B. Late Attempt-1 ID-less execution.interrupted followed by Retry still pending in inbox + Retry activity MUST keep Retry alive
    {
      const h = createHarness();
      h.client.model.list.mockResolvedValue(defaultModelCatalog);
      h.credentials.push({ id: 'cred-active-retry', integrationID: 'opencode', active: true, value: { type: 'key', key: 'sk-old' } } as any);
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });

      const p = new OpenCodeSdkProvider();
      const completes: any[] = [];
      const errors: any[] = [];
      p.onComplete((_s, m) => completes.push(m));
      p.onError((_s, e) => errors.push(e));
      await p.connect({});
      const r = await p.createSession({ sessionKey: 'active-retry-inbox', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await p.send(r, 'hello');

      h.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-att1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } } });
      await vi.waitFor(() => expect(h.client.sessions.prompt).toHaveBeenCalledTimes(2));
      const retryId = (h.client.sessions.prompt.mock.calls[1]?.[0] as { id: string }).id;

      // Retry is still sitting in inbox when late Attempt-1 execution.interrupted arrives
      (h.client.session as any).inbox = { list: vi.fn(async () => [{ id: retryId, type: 'user' }]) };
      h.queue.push({ type: 'session.execution.interrupted', data: { sessionID: 'oc-session-1', reason: 'superseded' } });
      await new Promise((res) => setTimeout(res, 50));
      expect(errors).toHaveLength(0);
      expect(completes).toHaveLength(0);

      // Retry starts executing and completes strictly once
      (h.client.session as any).inbox = { list: vi.fn(async () => []) };
      h.queue.push({ type: 'session.inbox.delivered', data: { sessionID: 'oc-session-1', inboxID: retryId } });
      h.queue.push({ type: 'session.step.started', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-retry-live', inputID: retryId, model: { providerID: 'opencode', id: 'big-pickle' } } });
      h.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-retry-live', ordinal: 0, delta: 'Live retry succeeded' } });
      h.queue.push({ type: 'session.step.ended', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-retry-live', finish: 'stop' } });
      await vi.waitFor(() => expect(completes).toHaveLength(1));
      expect(completes[0].content).toBe('Live retry succeeded');
      expect(errors).toHaveLength(0);
      await p.disconnect();
    }
  });

  it('aborts in-flight SDK admission signal immediately on endSession and route handoff before timeout', async () => {
    // 1. endSession (close) while sessions.prompt is still waiting on network: aborts signal immediately without waiting 15s timeout
    {
      const h = createHarness();
      const promptGate = deferred<{ id: string; sessionID: string; type: string }>();
      let observedSignal: AbortSignal | undefined;
      let promptCalls = 0;
      h.client.sessions.prompt = (async (_input: any, opts?: { signal?: AbortSignal }) => {
        promptCalls += 1;
        observedSignal = opts?.signal;
        return promptGate.promise;
      }) as any;
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });
      const p = new OpenCodeSdkProvider();
      await p.connect({});
      const r = await p.createSession({ sessionKey: 'close-pre-timeout', cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });

      const sendP = p.send(r, 'hanging send before close').catch(() => 'rejected');
      await vi.waitFor(() => expect(promptCalls).toBe(1));
      expect(observedSignal?.aborted).toBe(false);

      await p.endSession(r);
      expect(observedSignal?.aborted).toBe(true);
      promptGate.resolve({ id: 'late-close', sessionID: 'oc-session-1', type: 'user' });
      await sendP;
      await p.disconnect();
    }

    // 2. Concurrent routeB takeover while routeA sessions.prompt is suspended: pre-lock aborts A signal immediately before timeout
    {
      const h = createHarness();
      h.sessions.set('oc-handoff-imm', { id: 'oc-handoff-imm', title: 'imm', location: { directory: '/tmp/project' } });
      const promptGate = deferred<{ id: string; sessionID: string; type: string }>();
      let observedSignal: AbortSignal | undefined;
      let promptCalls = 0;
      h.client.sessions.prompt = (async (_input: any, opts?: { signal?: AbortSignal }) => {
        promptCalls += 1;
        observedSignal = opts?.signal;
        return promptGate.promise;
      }) as any;
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });
      const p = new OpenCodeSdkProvider();
      await p.connect({});
      const routeA = await p.createSession({
        sessionKey: 'imm-a',
        sessionName: 'deck_imm_a',
        cwd: '/tmp/project',
        skipCreate: true,
        resumeId: 'oc-handoff-imm',
        agentId: DEFAULT_OPENCODE_MODEL_ID,
      });

      const sendA = p.send(routeA, 'slow before handoff').catch(() => 'rejected');
      await vi.waitFor(() => expect(promptCalls).toBe(1));
      expect(observedSignal?.aborted).toBe(false);

      const routeBPromise = p.createSession({
        sessionKey: 'imm-b',
        sessionName: 'deck_imm_b',
        cwd: '/tmp/project',
        skipCreate: true,
        resumeId: 'oc-handoff-imm',
        agentId: DEFAULT_OPENCODE_MODEL_ID,
      });
      await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
      const routeB = await routeBPromise;
      expect((p as any).providerToRoute.get('oc-handoff-imm')).toBe(routeB);

      promptGate.resolve({ id: 'late-handoff', sessionID: 'oc-handoff-imm', type: 'user' });
      await expect(sendA).resolves.toBe('rejected');
      await p.disconnect();
    }
  });

  it('keeps quiet running retry alive via session.active() after leaving inbox until late first-byte completes once', async () => {
    const defaultModelCatalog = {
      data: [{ id: DEFAULT_OPENCODE_MODEL_ID, modelID: 'big-pickle', providerID: 'opencode', enabled: true, type: 'chat' }],
    };

    // 1. Retry already left inbox (inbox.list === []), no assistant/first-byte yet, session.active() reports running -> stays alive!
    // 2. Also session.active() throwing (unknown execution state) keeps turn alive!
    for (const mode of ['active-running', 'active-unknown'] as const) {
      const h = createHarness();
      h.client.model.list.mockResolvedValue(defaultModelCatalog);
      h.credentials.push({ id: `cred-${mode}`, integrationID: 'opencode', active: true, value: { type: 'key', key: 'sk-old' } } as any);
      (h.client.session as any).inbox = { list: vi.fn(async () => []) };
      if (mode === 'active-running') {
        h.client.session.active.mockResolvedValue({ 'oc-session-1': { type: 'running' } });
      } else {
        h.client.session.active.mockRejectedValue(new Error('transient status rpc unavailable'));
      }
      openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
        options.signal.addEventListener('abort', h.queue.close, { once: true });
        return { client: h.client as any, server: h.server };
      });

      const p = new OpenCodeSdkProvider();
      const completes: any[] = [];
      const errors: any[] = [];
      p.onComplete((_s, m) => completes.push(m));
      p.onError((_s, e) => errors.push(e));
      await p.connect({});
      const r = await p.createSession({ sessionKey: `quiet-${mode}`, cwd: '/tmp/project', agentId: DEFAULT_OPENCODE_MODEL_ID });
      await p.send(r, 'hello');

      h.queue.push({ type: 'session.step.failed', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-att1', error: { type: 'provider.auth', status: 401, message: 'api_key_expired' } } });
      await vi.waitFor(() => expect(h.client.sessions.prompt).toHaveBeenCalledTimes(2));

      // Late Attempt-1 ID-less execution.failed arrives while Retry left inbox and is quiet (>950ms before first byte)
      h.queue.push({ type: 'session.execution.failed', data: { sessionID: 'oc-session-1', error: { message: 'late attempt 1 noise' } } });
      await new Promise((res) => setTimeout(res, 1_000));
      expect(h.client.session.active).toHaveBeenCalled();
      expect(errors).toHaveLength(0);
      expect(completes).toHaveLength(0);

      // Late first-byte + completion arrive and settle strictly once
      h.queue.push({ type: 'session.text.delta', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-late-first-byte', ordinal: 0, delta: `Late first byte (${mode})` } });
      h.queue.push({ type: 'session.step.ended', data: { sessionID: 'oc-session-1', assistantMessageID: 'msg-late-first-byte', finish: 'stop' } });
      await vi.waitFor(() => expect(completes).toHaveLength(1));
      expect(completes[0].content).toBe(`Late first byte (${mode})`);
      expect(errors).toHaveLength(0);
      await p.disconnect();
    }
  });

  it('enforces toolExecutionGuard in processPermission with untruncated properties BEFORE emitting approval', async () => {
    const harness = createHarness();
    openCodeSdkRuntimeHooks.start = vi.fn(async (options) => {
      options.signal.addEventListener('abort', harness.queue.close, { once: true });
      return { client: harness.client as any, server: harness.server };
    });
    const provider = new OpenCodeSdkProvider();
    let blockSensitive = true;
    const seenInputs: unknown[] = [];
    provider.setToolExecutionGuard(async (_sid, req) => {
      seenInputs.push(req.input);
      return blockSensitive && JSON.stringify(req.input).includes('/home/k/.ssh/id_ed25519')
        ? { allow: false, reason: 'Sensitive path denied' }
        : { allow: true };
    });
    const approvals: Array<{ id: string }> = [];
    provider.onApprovalRequest((_sid, req) => approvals.push({ id: req.id }));

    await provider.connect({});
    await provider.createSession({ sessionKey: 'route-priv', cwd: '/tmp/project' });

    const longPadding = 'x'.repeat(350);
    harness.queue.push({
      type: 'permission.asked',
      data: {
        id: 'perm-secret',
        sessionID: 'oc-session-1',
        action: 'read',
        resources: [longPadding, '/home/k/.ssh/id_ed25519'],
        metadata: {},
      },
    });

    await vi.waitFor(() => expect(harness.client.permission.reply).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'oc-session-1',
      requestID: 'perm-secret',
      decision: 'reject',
    })));
    expect(approvals).toHaveLength(0);
    expect(JSON.stringify(seenInputs[0])).toContain('/home/k/.ssh/id_ed25519');

    // Subsequent owner turn in the same session forwards normally
    blockSensitive = false;
    harness.queue.push({
      type: 'permission.asked',
      data: {
        id: 'perm-owner',
        sessionID: 'oc-session-1',
        action: 'read',
        resources: ['/home/k/.ssh/id_ed25519'],
        metadata: {},
      },
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]!.id).toBe('perm-owner');
    await provider.disconnect();
  });
});
