import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

const realSetTimeout = setTimeout;

interface FakeChild {
  child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; killed: boolean; kill: () => boolean };
  requests: Array<{ id?: number; method?: string; params?: Record<string, any> }>;
  residentThreads: Set<string>;
  emits: (message: Record<string, unknown>) => void;
}

const appServer = vi.hoisted(() => {
  const children: FakeChild[] = [];
  let threadCounter = 0;
  let turnCounter = 0;
  let unsubscribeHandler:
    | ((params: Record<string, any> | undefined, record: FakeChild, id: number) => 'auto' | 'delayed-unload' | 'defer' | { error: string })
    | undefined;
  let resumeHandler:
    | ((params: Record<string, any> | undefined, record: FakeChild, id: number) => 'auto' | 'defer' | { error: string })
    | undefined;
  const deferredUnsubscribes: Array<() => void> = [];
  const deferredResumes: Array<() => void> = [];

  const emitUnloadComplete = (record: FakeChild, threadId: string): void => {
    if (!threadId) return;
    record.residentThreads.delete(threadId);
    record.emits({ method: 'thread/status/changed', params: { threadId, status: { type: 'notLoaded' } } });
    record.emits({ method: 'thread/closed', params: { threadId } });
  };

  const spawn = vi.fn(() => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let record!: FakeChild;
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          const message = JSON.parse(line) as FakeChild['requests'][number];
          record.requests.push(message);
          if (typeof message.id !== 'number') continue;
          const id = message.id;
          if (message.method === 'initialize') {
            record.emits({ id, result: { userAgent: 'codex-test' } });
          } else if (message.method === 'config/read') {
            record.emits({ id, result: { config: { mcp_servers: {} } } });
          } else if (message.method === 'thread/start') {
            threadCounter += 1;
            const threadId = `thread-${threadCounter}`;
            const ephemeral = message.params?.ephemeral === true;
            record.residentThreads.add(threadId);
            record.emits({
              id,
              result: { thread: { id: threadId, ephemeral, path: ephemeral ? null : `/tmp/${threadId}.jsonl` } },
            });
            record.emits({
              method: 'thread/started',
              params: { thread: { id: threadId, ephemeral, path: ephemeral ? null : `/tmp/${threadId}.jsonl` } },
            });
          } else if (message.method === 'thread/resume') {
            const threadId = String(message.params?.threadId ?? 'thread-1');
            const action = resumeHandler?.(message.params, record, id) ?? 'auto';
            if (action === 'defer') {
              deferredResumes.push(() => {
                record.residentThreads.add(threadId);
                record.emits({ id, result: { thread: { id: threadId } } });
              });
            } else if (typeof action === 'object' && 'error' in action) {
              record.emits({ id, error: { code: -32000, message: action.error } });
            } else {
              record.residentThreads.add(threadId);
              record.emits({ id, result: { thread: { id: threadId } } });
            }
          } else if (message.method === 'thread/loaded/list') {
            record.emits({ id, result: { data: [...record.residentThreads], nextCursor: null } });
          } else if (message.method === 'turn/start') {
            turnCounter += 1;
            record.emits({
              id,
              result: { turn: { id: `turn-${turnCounter}`, status: 'inProgress', items: [], error: null } },
            });
          } else if (message.method === 'thread/compact/start') {
            record.emits({ id, result: {} });
          } else if (message.method === 'mcpServerStatus/list') {
            record.emits({ id, result: { data: [], nextCursor: null } });
          } else if (message.method === 'config/mcpServer/reload') {
            record.emits({ id, result: {} });
          } else if (message.method === 'mcpServer/tool/call') {
            record.emits({ id, result: { content: [{ type: 'text', text: '{}' }] } });
          } else if (message.method === 'turn/interrupt' || message.method === 'thread/settings/update') {
            record.emits({ id, result: {} });
          } else if (message.method === 'thread/unsubscribe') {
            const threadId = typeof message.params?.threadId === 'string' ? message.params.threadId : '';
            const action = unsubscribeHandler?.(message.params, record, id) ?? 'auto';
            if (action === 'defer') {
              deferredUnsubscribes.push(() => {
                emitUnloadComplete(record, threadId);
                record.emits({ id, result: { status: 'unsubscribed' } });
              });
            } else if (action === 'delayed-unload') {
              record.emits({ id, result: { status: 'unsubscribed' } });
            } else if (typeof action === 'object' && 'error' in action) {
              record.emits({ id, error: { code: -32000, message: action.error } });
            } else {
              emitUnloadComplete(record, threadId);
              record.emits({ id, result: { status: 'unsubscribed' } });
            }
          }
        }
        callback();
      },
    });
    const child = new EventEmitter() as FakeChild['child'];
    Object.assign(child, { stdout, stderr, stdin, killed: false });
    child.kill = () => {
      child.killed = true;
      child.emit('exit', 0);
      return true;
    };
    record = {
      child,
      requests: [],
      residentThreads: new Set<string>(),
      emits: (message) => {
        stdout.write(`${JSON.stringify(message)}\n`);
      },
    };
    children.push(record);
    return child;
  });

  const execFile = vi.fn((...args: unknown[]) => {
    const callback = (typeof args[2] === 'function' ? args[2] : args[3]) as
      | ((e: Error | null, out: string, err: string) => void)
      | undefined;
    callback?.(null, 'ok\n', '');
    return {} as never;
  });

  return {
    children,
    deferredUnsubscribes,
    deferredResumes,
    emitUnloadComplete,
    spawn,
    execFile,
    setUnsubscribeHandler: (fn: typeof unsubscribeHandler) => {
      unsubscribeHandler = fn;
    },
    setResumeHandler: (fn: typeof resumeHandler) => {
      resumeHandler = fn;
    },
    reset: () => {
      children.length = 0;
      deferredUnsubscribes.length = 0;
      deferredResumes.length = 0;
      threadCounter = 0;
      turnCounter = 0;
      unsubscribeHandler = undefined;
      resumeHandler = undefined;
    },
  };
});

vi.mock('node:child_process', () => ({ spawn: appServer.spawn, execFile: appServer.execFile }));
vi.mock('../../src/util/kill-process-tree.js', () => ({
  killProcessTree: vi.fn(async (child?: { kill?: () => boolean }) => {
    child?.kill?.();
  }),
}));
vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn(async () => ({ availableModels: ['gpt-5.4'], models: [{ id: 'gpt-5.4' }] })),
  getCodexBaseInstructions: vi.fn(async () => '[catalog-prompt]'),
}));

import {
  CODEX_IDLE_SWEEP_INTERVAL_MS,
  CODEX_IDLE_THREAD_EVICT_MS,
  CODEX_THREAD_UNSUBSCRIBE_TIMEOUT_MS,
  CodexSdkProvider,
} from '../../src/agent/providers/codex-sdk.js';
import { CODEX_USER_INPUT_METHOD, INTERACTIVE_QUESTION_TOOL_NAME } from '../../shared/codex-user-input.js';

interface InternalSessionStateView {
  loaded: boolean;
  threadId?: string;
  ephemeral?: boolean;
  runningTurnId?: string;
  lastActivityAt: number;
}

function getSessionState(provider: CodexSdkProvider, sessionId: string): InternalSessionStateView | undefined {
  return (provider as unknown as { sessions: Map<string, InternalSessionStateView> }).sessions.get(sessionId);
}

async function waitForCondition(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = realDateNow() + timeoutMs;
  while (!condition()) {
    if (realDateNow() > deadline) {
      throw new Error('Timed out waiting for condition in codex-sdk-idle-eviction.test.ts');
    }
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => realSetTimeout(resolve, 2));
  }
}

const realDateNow = Date.now.bind(Date);

async function flushIo(): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
}

async function runCompleteTurn(
  provider: CodexSdkProvider,
  child: FakeChild | (() => FakeChild),
  sessionId: string,
  text: string,
): Promise<{ threadId: string; turnId: string }> {
  const resolveChild = typeof child === 'function' ? child : () => child;
  const beforeTurns = resolveChild().requests.filter((r) => r.method === 'turn/start').length;
  await provider.send(sessionId, text);
  const activeChild = resolveChild();
  const state = getSessionState(provider, sessionId)!;
  const turnStartReq = activeChild.requests.filter((r) => r.method === 'turn/start')[beforeTurns];
  const threadId = String(state.threadId ?? turnStartReq?.params?.threadId);
  const turnId = String(state.runningTurnId);
  activeChild.emits({
    method: 'item/agentMessage/delta',
    params: { threadId, turnId, itemId: `msg-${turnId}`, delta: `reply:${text}` },
  });
  activeChild.emits({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage: {
        last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, totalTokens: 15 },
      },
    },
  });
  activeChild.emits({
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, status: 'completed', error: null } },
  });
  await waitForCondition(() => !getSessionState(provider, sessionId)?.runningTurnId);
  await flushIo();
  return { threadId, turnId };
}

describe('CodexSdkProvider idle thread eviction & LRU cap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    appServer.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('evicts idle durable threads after CODEX_IDLE_THREAD_EVICT_MS, resumes cleanly via thread/resume on next send, and clears sweep timer on disconnect', async () => {
    const provider = new CodexSdkProvider();
    const completedTexts: string[] = [];
    provider.onComplete((_sid, msg) => completedTexts.push(msg.content));
    await provider.connect({ binaryPath: 'codex' });
    const child = appServer.children[0]!;

    await provider.createSession({ sessionKey: 's-idle-1', cwd: '/tmp/p1', agentId: 'gpt-5.4' });
    const first = await runCompleteTurn(provider, child, 's-idle-1', 'hello');
    expect(first.threadId).toBe('thread-1');
    expect(getSessionState(provider, 's-idle-1')?.loaded).toBe(true);

    // 15 minutes (< 20 min default): must NOT evict across three 5-minute sweeps.
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_SWEEP_INTERVAL_MS * 3);
    expect(child.requests.filter((r) => r.method === 'thread/unsubscribe')).toHaveLength(0);
    expect(getSessionState(provider, 's-idle-1')?.loaded).toBe(true);

    // At CODEX_IDLE_THREAD_EVICT_MS (20m): periodic sweep unsubscribes thread-1 and marks loaded=false while keeping threadId & metadata.
    expect(CODEX_IDLE_THREAD_EVICT_MS).toBe(20 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(CODEX_IDLE_THREAD_EVICT_MS - CODEX_IDLE_SWEEP_INTERVAL_MS * 3);
    const unsubs = child.requests.filter((r) => r.method === 'thread/unsubscribe');
    expect(unsubs).toHaveLength(1);
    expect(unsubs[0]?.params).toEqual({ threadId: 'thread-1' });
    expect(getSessionState(provider, 's-idle-1')?.loaded).toBe(false);
    expect(getSessionState(provider, 's-idle-1')?.threadId).toBe('thread-1');

    // Sending again resumes the SAME durable thread seamlessly via thread/resume -> turn/start and routes completion events.
    const resumesBefore = child.requests.filter((r) => r.method === 'thread/resume').length;
    const startsBefore = child.requests.filter((r) => r.method === 'thread/start').length;
    const second = await runCompleteTurn(provider, child, 's-idle-1', 'after-evict');
    expect(second.threadId).toBe('thread-1');
    expect(child.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(resumesBefore + 1);
    expect(child.requests.filter((r) => r.method === 'thread/start')).toHaveLength(startsBefore);
    expect(completedTexts).toEqual(['reply:hello', 'reply:after-evict']);

    await provider.disconnect();
    // Sweep interval timer must be cleared on disconnect so zero timers remain.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces per-channel CODEX_MAX_LOADED_THREADS via LRU eviction of idle threads and skips silently when all threads are active', async () => {
    const provider = new CodexSdkProvider({
      maxLoadedThreads: 3,
      idleThreadEvictMs: 60 * 60 * 1000,
      idleSweepIntervalMs: 60_000,
    });
    await provider.connect({ binaryPath: 'codex' });
    const child = appServer.children[0]!;

    await provider.createSession({ sessionKey: 's1', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 's1', 't1');

    await vi.advanceTimersByTimeAsync(1_000);
    await provider.createSession({ sessionKey: 's2', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 's2', 't2');

    await vi.advanceTimersByTimeAsync(1_000);
    await provider.createSession({ sessionKey: 's3', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 's3', 't3');

    // Refresh s1 activity via streaming usage event so s2 becomes the least-recently-used idle session.
    await vi.advanceTimersByTimeAsync(1_000);
    child.emits({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-1', tokenUsage: { last: { inputTokens: 12, outputTokens: 2 } } },
    });
    await flushIo();

    // Loading s4 pushes normalChannel to 4 loaded (> cap 3) -> only s2 (thread-2) is evicted.
    await vi.advanceTimersByTimeAsync(1_000);
    await provider.createSession({ sessionKey: 's4', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 's4', 't4');
    await waitForCondition(() => child.requests.some((r) => r.method === 'thread/unsubscribe'));

    const lruUnsubs = child.requests.filter((r) => r.method === 'thread/unsubscribe');
    expect(lruUnsubs.map((r) => r.params?.threadId)).toEqual(['thread-2']);
    expect(getSessionState(provider, 's1')?.loaded).toBe(true);
    expect(getSessionState(provider, 's2')?.loaded).toBe(false);
    expect(getSessionState(provider, 's3')?.loaded).toBe(true);
    expect(getSessionState(provider, 's4')?.loaded).toBe(true);

    // Boundary check: if all loaded threads (and newly starting s5) have active turns running,
    // LRU eviction silently skips without throwing or blocking new sends.
    await provider.send('s1', 'busy-1');
    await provider.send('s3', 'busy-3');
    await provider.send('s4', 'busy-4');
    await provider.createSession({ sessionKey: 's5', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await provider.send('s5', 'busy-5');
    await flushIo();

    expect(child.requests.filter((r) => r.method === 'thread/unsubscribe')).toHaveLength(1);
    expect(getSessionState(provider, 's5')?.loaded).toBe(true);
    expect(getSessionState(provider, 's5')?.runningTurnId).toBeTruthy();

    await provider.disconnect();
  });

  it('exempts active turns, pending user-input questions, compacting sessions, and ephemeral threads from idle eviction', async () => {
    const provider = new CodexSdkProvider({
      idleThreadEvictMs: 1_000,
      idleSweepIntervalMs: 500,
    });
    await provider.connect({ binaryPath: 'codex' });
    const normalChild = appServer.children[0]!;

    // Control durable idle session -> MUST be evicted.
    await provider.createSession({ sessionKey: 's-idle', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, normalChild, 's-idle', 'done');

    // Active turn session -> MUST NOT be evicted.
    await provider.createSession({ sessionKey: 's-active', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await provider.send('s-active', 'working');

    // Compacting session -> MUST NOT be evicted.
    await provider.createSession({ sessionKey: 's-compact', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, normalChild, 's-compact', 'setup');
    await provider.send('s-compact', '/compact');

    // Session waiting on interactive requestUserInput -> MUST NOT be evicted (even if turn is awaiting user input).
    await provider.createSession({ sessionKey: 's-question', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await provider.send('s-question', 'ask');
    const qState = getSessionState(provider, 's-question')!;
    normalChild.emits({
      id: 'srv-q-1',
      method: CODEX_USER_INPUT_METHOD,
      params: {
        threadId: qState.threadId,
        turnId: qState.runningTurnId,
        itemId: 'item-q-1',
        questions: [{ id: 'q1', header: 'Choice', question: 'Pick one?' }],
      },
    });
    await flushIo();

    // Async agentMessage questions emitted through REAL app-server events (item/completed + turn/completed)
    // MUST remain exempt after turn completion until answered / superseded by the next user turn.
    const emittedQuestionCards: Array<{ sessionId: string; id: string; name: string }> = [];
    provider.onToolCall((sid, tool) => {
      if (tool.name === INTERACTIVE_QUESTION_TOOL_NAME) {
        emittedQuestionCards.push({ sessionId: sid, id: tool.id, name: tool.name });
      }
    });
    await provider.createSession({ sessionKey: 's-async-q', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await provider.send('s-async-q', 'ask-async');
    const asyncState = getSessionState(provider, 's-async-q')!;
    const asyncTurnId = asyncState.runningTurnId!;
    normalChild.emits({
      method: 'item/completed',
      params: {
        threadId: asyncState.threadId,
        turnId: asyncTurnId,
        item: {
          type: 'agentMessage',
          id: 'msg-async-q',
          text: 'Choose an option',
          questions: [{ title: 'Confirm?', options: ['Proceed', 'Cancel'] }],
        },
      },
    });
    normalChild.emits({
      method: 'turn/completed',
      params: { threadId: asyncState.threadId, turn: { id: asyncTurnId, status: 'completed', error: null } },
    });
    await waitForCondition(() => !getSessionState(provider, 's-async-q')?.runningTurnId);
    await flushIo();
    expect(emittedQuestionCards.some((c) => c.sessionId === 's-async-q')).toBe(true);

    // Ephemeral / incognito session -> MUST NEVER be evicted (cannot thread/resume).
    await provider.createSession({ sessionKey: 's-incog', cwd: '/tmp/p', agentId: 'gpt-5.4', incognito: true });
    await runCompleteTurn(provider, () => appServer.children[1] ?? normalChild, 's-incog', 'secret');
    expect(getSessionState(provider, 's-incog')?.ephemeral).toBe(true);

    // Durable-flagged ephemeral override on normal channel -> ALSO exempt.
    await provider.createSession({ sessionKey: 's-ephem-flag', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, normalChild, 's-ephem-flag', 'ephem');
    getSessionState(provider, 's-ephem-flag')!.ephemeral = true;

    await vi.advanceTimersByTimeAsync(1_500);
    await flushIo();

    const evictedThreadIds = appServer.children
      .flatMap((c) => c.requests)
      .filter((r) => r.method === 'thread/unsubscribe')
      .map((r) => r.params?.threadId);

    expect(evictedThreadIds).toEqual([getSessionState(provider, 's-idle')?.threadId]);
    expect(getSessionState(provider, 's-idle')?.loaded).toBe(false);
    expect(normalChild.residentThreads.has(getSessionState(provider, 's-idle')!.threadId!)).toBe(false);
    expect(getSessionState(provider, 's-active')?.loaded).toBe(true);
    expect(getSessionState(provider, 's-compact')?.loaded).toBe(true);
    expect(getSessionState(provider, 's-question')?.loaded).toBe(true);
    expect(getSessionState(provider, 's-async-q')?.loaded).toBe(true);
    expect(normalChild.residentThreads.has(getSessionState(provider, 's-async-q')!.threadId!)).toBe(true);
    expect(getSessionState(provider, 's-incog')?.loaded).toBe(true);
    expect(getSessionState(provider, 's-ephem-flag')?.loaded).toBe(true);

    // Answering / starting the next user turn on s-async-q clears the pending async question so it becomes evictable when idle.
    await runCompleteTurn(provider, normalChild, 's-async-q', 'Proceed');
    await vi.advanceTimersByTimeAsync(1_500);
    await flushIo();
    expect(getSessionState(provider, 's-async-q')?.loaded).toBe(false);
    expect(normalChild.residentThreads.has(getSessionState(provider, 's-async-q')!.threadId!)).toBe(false);

    await provider.disconnect();
  });

  it('tracks actual channel residency across loaded=false config invalidations and retries transient thread/unsubscribe failures', async () => {
    const provider = new CodexSdkProvider({
      maxLoadedThreads: 2,
      idleThreadEvictMs: 1_000,
      idleSweepIntervalMs: 60_000,
    });
    await provider.connect({ binaryPath: 'codex' });
    const child = appServer.children[0]!;

    // 1. Model change (`setSessionAgentId`), system text refresh (`refreshSessionSystemText`), and cold `setServiceTier`
    // all set `state.loaded = false` WITHOUT unsubscribing from app-server. Residency MUST remain tracked for LRU & sweep.
    await provider.createSession({ sessionKey: 's-cfg-model', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 's-cfg-model', 't1');
    provider.setSessionAgentId('s-cfg-model', 'gpt-5.4-mini');
    expect(getSessionState(provider, 's-cfg-model')?.loaded).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await provider.createSession({ sessionKey: 's-cfg-sys', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 's-cfg-sys', 't2');
    provider.refreshSessionSystemText('s-cfg-sys');
    expect(getSessionState(provider, 's-cfg-sys')?.loaded).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await provider.createSession({ sessionKey: 's-cold-tier', cwd: '/tmp/p', agentId: 'gpt-5.4', resumeId: 'thread-cold-99' });
    await provider.setServiceTier('s-cold-tier', 'fast');
    expect(getSessionState(provider, 's-cold-tier')?.loaded).toBe(false);
    await flushIo();

    // Cold setServiceTier loaded a 3rd resident thread while s-cfg-model & s-cfg-sys stayed resident with loaded=false (> cap 2).
    // Oldest resident (`s-cfg-model`, thread-1) MUST be LRU-evicted despite loaded=false.
    expect(child.residentThreads.has('thread-1')).toBe(false);
    expect(child.residentThreads.has('thread-2')).toBe(true);
    expect(child.residentThreads.has('thread-cold-99')).toBe(true);
    expect(child.residentThreads.size).toBe(2);

    // 2. Transient unsubscribe failure MUST return 0 confirmed evictions and retry cleanly on the next sweep.
    let failUnsub = true;
    appServer.setUnsubscribeHandler(() => (failUnsub ? { error: 'internal busy' } : 'auto'));
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(provider.sweepIdleThreads('periodic-idle-sweep')).resolves.toBe(0);
    expect(child.residentThreads.has('thread-2')).toBe(true);
    expect(child.residentThreads.has('thread-cold-99')).toBe(true);

    failUnsub = false;
    await expect(provider.sweepIdleThreads('periodic-idle-sweep')).resolves.toBe(2);
    expect(child.residentThreads.size).toBe(0);

    await provider.disconnect();
  });

  it('serializes concurrent send during in-flight thread/unsubscribe so thread/resume never clobbers loaded=true', async () => {
    const provider = new CodexSdkProvider({
      idleThreadEvictMs: 1_000,
      idleSweepIntervalMs: 60_000,
    });
    await provider.connect({ binaryPath: 'codex' });
    const child = appServer.children[0]!;

    await provider.createSession({ sessionKey: 's-race', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 's-race', 'first');

    appServer.setUnsubscribeHandler(() => 'defer');
    await vi.advanceTimersByTimeAsync(1_000);
    const sweepPromise = provider.sweepIdleThreads('periodic-idle-sweep');
    await waitForCondition(() => appServer.deferredUnsubscribes.length === 1);

    // Unsubscribe has been transmitted and is still in flight; state is already marked unloaded.
    expect(child.requests.filter((r) => r.method === 'thread/unsubscribe')).toHaveLength(1);
    expect(appServer.deferredUnsubscribes).toHaveLength(1);
    expect(getSessionState(provider, 's-race')?.loaded).toBe(false);

    // Concurrent send arrives BEFORE thread/unsubscribe RPC resolves.
    const completed: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg.content));
    const sendPromise = provider.send('s-race', 'urgent-during-evict');
    await flushIo();

    // Must wait for thread/unsubscribe to settle before sending thread/resume or turn/start.
    expect(child.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(0);

    // Resolve the in-flight unsubscribe and wait for both sweep + send.
    appServer.deferredUnsubscribes.shift()!();
    await sweepPromise;
    await sendPromise;

    const methodOrder = child.requests
      .filter((r) => r.method === 'thread/unsubscribe' || r.method === 'thread/resume' || r.method === 'turn/start')
      .map((r) => r.method);
    expect(methodOrder.slice(-3)).toEqual(['thread/unsubscribe', 'thread/resume', 'turn/start']);

    // Crucial invariant: sweep completion must NOT reset state.loaded back to false.
    const state = getSessionState(provider, 's-race')!;
    expect(state.loaded).toBe(true);
    expect(state.runningTurnId).toBeTruthy();

    child.emits({
      method: 'item/agentMessage/delta',
      params: { threadId: state.threadId, turnId: state.runningTurnId, itemId: 'msg-r', delta: 'race-ok' },
    });
    child.emits({
      method: 'turn/completed',
      params: { threadId: state.threadId, turn: { id: state.runningTurnId, status: 'completed', error: null } },
    });
    await waitForCondition(() => completed.length === 1);
    expect(completed).toEqual(['race-ok']);

    await provider.disconnect();
  });

  it('rejects concurrent send cleanly without orphan thread/resume or turn/start when endSession runs during in-flight thread/unsubscribe', async () => {
    const provider = new CodexSdkProvider({
      idleThreadEvictMs: 1_000,
      idleSweepIntervalMs: 60_000,
    });
    await provider.connect({ binaryPath: 'codex' });
    const child = appServer.children[0]!;

    await provider.createSession({ sessionKey: 's-end-race', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 's-end-race', 'first');

    appServer.setUnsubscribeHandler(() => 'defer');
    await vi.advanceTimersByTimeAsync(1_000);
    const sweepPromise = provider.sweepIdleThreads('periodic-idle-sweep');
    await waitForCondition(() => appServer.deferredUnsubscribes.length === 1);

    // Begin endSession while thread/unsubscribe is still pending on the wire.
    const endPromise = provider.endSession('s-end-race');
    await flushIo();

    // Concurrent send arrives before endSession finishes awaiting threadUnsubscribePromise.
    const rejectedSend = provider.send('s-end-race', 'too-late');

    appServer.deferredUnsubscribes.shift()!();
    await sweepPromise;
    await endPromise;

    await expect(rejectedSend).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(child.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(0);
    expect(child.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
    expect(child.residentThreads.size).toBe(0);

    // Case 2: send enters ensureThreadLoaded & awaits threadUnsubscribePromise BEFORE endSession runs.
    appServer.setUnsubscribeHandler(undefined);
    await provider.createSession({ sessionKey: 's-end-race-2', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 's-end-race-2', 'first-2');

    appServer.setUnsubscribeHandler(() => 'defer');
    await vi.advanceTimersByTimeAsync(1_000);
    const sweepPromise2 = provider.sweepIdleThreads('periodic-idle-sweep');
    await waitForCondition(() => appServer.deferredUnsubscribes.length === 1);

    const inflightSend = provider.send('s-end-race-2', 'caught-waiting');
    await flushIo();
    const endPromise2 = provider.endSession('s-end-race-2');
    await flushIo();

    appServer.deferredUnsubscribes.shift()!();
    await sweepPromise2;
    await endPromise2;

    await expect(inflightSend).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    expect(child.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(0);
    expect(child.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2);
    expect(child.residentThreads.size).toBe(0);

    await provider.disconnect();
  });

  it('tolerates thread/unsubscribe RPC errors and timeouts without unhandled rejections and keeps later sweeps & resumes healthy', async () => {
    const provider = new CodexSdkProvider({
      idleThreadEvictMs: 1_000,
      idleSweepIntervalMs: 60_000,
    });
    await provider.connect({ binaryPath: 'codex' });
    const child = appServer.children[0]!;

    await provider.createSession({ sessionKey: 's-err', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 's-err', 'one');
    await provider.createSession({ sessionKey: 's-timeout', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 's-timeout', 'two');

    appServer.setUnsubscribeHandler((params) => {
      if (params?.threadId === 'thread-1') return { error: 'thread not found' };
      return 'defer'; // never responds -> hits CODEX_THREAD_UNSUBSCRIBE_TIMEOUT_MS
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const sweepPromise = provider.sweepIdleThreads('periodic-idle-sweep');
    await vi.advanceTimersByTimeAsync(CODEX_THREAD_UNSUBSCRIBE_TIMEOUT_MS + 100);
    // thread-1 returned "thread not found" (confirmed non-resident = 1); thread-2 timed out (transient = stays resident, not counted).
    await expect(sweepPromise).resolves.toBe(1);

    expect(getSessionState(provider, 's-err')?.loaded).toBe(false);
    expect(getSessionState(provider, 's-timeout')?.loaded).toBe(false);

    // Subsequent send on previously gone session resumes cleanly, and next sweep retries & confirms thread-2 removal too.
    appServer.setUnsubscribeHandler(undefined);
    await runCompleteTurn(provider, child, 's-err', 'recovered');
    expect(getSessionState(provider, 's-err')?.loaded).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(provider.sweepIdleThreads('periodic-idle-sweep')).resolves.toBe(2);
    expect(getSessionState(provider, 's-err')?.loaded).toBe(false);
    expect(getSessionState(provider, 's-timeout')?.loaded).toBe(false);
    expect(child.residentThreads.size).toBe(0);

    await provider.disconnect();
  });

  it('never unsubscribes a shared durable threadId when a delayed stale resumeThread or ending owner finishes after a successor takes over', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    const child = appServer.children[0]!;

    // Case 1: old state starts resumeThread('thread-shared') which stalls on wire;
    // session rebind/successor starts on same threadId and completes first.
    await provider.createSession({ sessionKey: 's-shared', cwd: '/tmp/p', agentId: 'gpt-5.4', resumeId: 'thread-shared' });
    let resumeCount = 0;
    appServer.setResumeHandler(() => {
      resumeCount += 1;
      return resumeCount === 1 ? 'defer' : 'auto';
    });
    const staleSend = provider.send('s-shared', 'old-request');
    await waitForCondition(() => appServer.deferredResumes.length === 1);

    // Rebind the session route (or create a successor sharing thread-shared) and let successor resume & run first.
    await provider.createSession({ sessionKey: 's-shared-2', cwd: '/tmp/p', agentId: 'gpt-5.4', resumeId: 'thread-shared' });
    await provider.createSession({ sessionKey: 's-shared', cwd: '/tmp/p', agentId: 'gpt-5.4', resumeId: 'thread-shared' });
    const completed: string[] = [];
    provider.onComplete((sid, msg) => completed.push(`${sid}:${msg.content}`));

    const successorSend = provider.send('s-shared', 'new-request');
    await waitForCondition(() => Boolean(getSessionState(provider, 's-shared')?.runningTurnId));
    const successorState = getSessionState(provider, 's-shared')!;
    const successorTurnId = successorState.runningTurnId!;

    // Now delayed old resumeThread finishes: stale branch MUST NOT send thread/unsubscribe for thread-shared.
    appServer.deferredResumes.shift()!();
    await staleSend;
    await successorSend;
    await flushIo();

    expect(child.requests.filter((r) => r.method === 'thread/unsubscribe')).toHaveLength(0);
    expect(child.residentThreads.has('thread-shared')).toBe(true);
    expect(successorState.loaded).toBe(true);

    // Notifications still route to successor on thread-shared.
    child.emits({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-shared', turnId: successorTurnId, itemId: 'msg-s', delta: 'still-subscribed' },
    });
    child.emits({
      method: 'turn/completed',
      params: { threadId: 'thread-shared', turn: { id: successorTurnId, status: 'completed', error: null } },
    });
    await waitForCondition(() => completed.length === 1);
    expect(completed).toEqual(['s-shared:still-subscribed']);

    // Case 2: endSession on one owner of thread-shared must NOT unsubscribe while s-shared-2 still owns thread-shared.
    await provider.endSession('s-shared');
    expect(child.requests.filter((r) => r.method === 'thread/unsubscribe')).toHaveLength(0);
    expect(child.residentThreads.has('thread-shared')).toBe(true);

    // Once the final active owner ends, thread-shared IS unsubscribed cleanly.
    await provider.endSession('s-shared-2');
    expect(child.requests.filter((r) => r.method === 'thread/unsubscribe')).toHaveLength(1);
    expect(child.residentThreads.size).toBe(0);

    await provider.disconnect();
  });

  it('preserves channel residency and pending unsubscribe serialization across createSession rebinds', async () => {
    const provider = new CodexSdkProvider({
      maxLoadedThreads: 1,
      idleThreadEvictMs: 1_000,
      idleSweepIntervalMs: 60_000,
    });
    await provider.connect({ binaryPath: 'codex' });
    const child = appServer.children[0]!;

    await provider.createSession({ sessionKey: 's-rebind', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 's-rebind', 'init');

    appServer.setUnsubscribeHandler(() => 'defer');
    await vi.advanceTimersByTimeAsync(1_000);
    const sweepPromise = provider.sweepIdleThreads('periodic-idle-sweep');
    await waitForCondition(() => appServer.deferredUnsubscribes.length === 1);

    // Rebind the session route with the same threadId while thread/unsubscribe is in flight.
    await provider.createSession({ sessionKey: 's-rebind', cwd: '/tmp/p', agentId: 'gpt-5.4', resumeId: 'thread-1' });

    const sendPromise = provider.send('s-rebind', 'after-rebind');
    await flushIo();
    // Must still serialize behind the pre-rebind thread/unsubscribe before sending thread/resume.
    expect(child.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(0);

    appServer.deferredUnsubscribes.shift()!();
    await sweepPromise;
    await sendPromise;

    const order = child.requests
      .filter((r) => r.method === 'thread/unsubscribe' || r.method === 'thread/resume' || r.method === 'turn/start')
      .map((r) => r.method);
    expect(order.slice(-3)).toEqual(['thread/unsubscribe', 'thread/resume', 'turn/start']);

    // Finish turn and advance idle window again: residency must still be tracked so sweep can evict cleanly.
    const state = getSessionState(provider, 's-rebind')!;
    child.emits({
      method: 'item/agentMessage/delta',
      params: { threadId: state.threadId, turnId: state.runningTurnId, itemId: 'msg-rebind', delta: 'ok' },
    });
    child.emits({
      method: 'turn/completed',
      params: { threadId: state.threadId, turn: { id: state.runningTurnId, status: 'completed', error: null } },
    });
    await waitForCondition(() => !getSessionState(provider, 's-rebind')?.runningTurnId);
    await flushIo();

    appServer.setUnsubscribeHandler(undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(provider.sweepIdleThreads('periodic-idle-sweep')).resolves.toBe(1);
    expect(child.residentThreads.size).toBe(0);

    await provider.disconnect();
  });

  it('keeps delayed-unload threads counted against LRU and confirmedEvicted=0 until thread/closed or thread/loaded/list confirms unload', async () => {
    const provider = new CodexSdkProvider({
      maxLoadedThreads: 2,
      idleThreadEvictMs: 1_000,
      idleSweepIntervalMs: 60_000,
    });
    await provider.connect({ binaryPath: 'codex' });
    const child = appServer.children[0]!;

    await provider.createSession({ sessionKey: 'd1', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 'd1', 'm1');
    await vi.advanceTimersByTimeAsync(100);

    // Server returns { status: 'unsubscribed' } WITHOUT unloading physically yet (thread remains in thread/loaded/list).
    appServer.setUnsubscribeHandler(() => 'delayed-unload');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(provider.sweepIdleThreads('periodic-idle-sweep')).resolves.toBe(0);
    expect(child.residentThreads.has('thread-1')).toBe(true);

    // Load 2 more sessions (total 3 resident including delayed-unload thread-1 > cap 2).
    // Once unload completes normally on retry, LRU sweep confirms eviction and enforces cap <= 2.
    await provider.createSession({ sessionKey: 'd2', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 'd2', 'm2');
    await vi.advanceTimersByTimeAsync(100);
    appServer.setUnsubscribeHandler(undefined);
    await provider.createSession({ sessionKey: 'd3', cwd: '/tmp/p', agentId: 'gpt-5.4' });
    await runCompleteTurn(provider, child, 'd3', 'm3');
    await flushIo();

    expect(child.residentThreads.has('thread-1')).toBe(false);
    expect(child.residentThreads.size).toBeLessThanOrEqual(2);

    await provider.disconnect();
  });

  it('retries thread/resume boundedly when app-server reports thread is closing and preserves durable threadId', async () => {
    const provider = new CodexSdkProvider();
    await provider.connect({ binaryPath: 'codex' });
    const child = appServer.children[0]!;

    await provider.createSession({ sessionKey: 's-closing', cwd: '/tmp/p', agentId: 'gpt-5.4', resumeId: 'thread-closing-7' });

    let attempts = 0;
    appServer.setResumeHandler(() => {
      attempts += 1;
      if (attempts === 1) return { error: 'thread thread-closing-7 is closing' };
      return 'auto';
    });

    const completed: string[] = [];
    provider.onComplete((_sid, msg) => completed.push(msg.content));
    const sendPromise = provider.send('s-closing', 'hello-closing');
    await waitForCondition(() => attempts === 1);

    // Emit thread/closed -> retry wakes immediately and succeeds on the SAME durable threadId (never spawns thread/start).
    appServer.emitUnloadComplete(child, 'thread-closing-7');
    await sendPromise;

    expect(attempts).toBe(2);
    expect(child.requests.filter((r) => r.method === 'thread/start')).toHaveLength(0);
    expect(child.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(2);
    const state = getSessionState(provider, 's-closing')!;
    expect(state.threadId).toBe('thread-closing-7');

    child.emits({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-closing-7', turnId: state.runningTurnId, itemId: 'msg-c', delta: 'resumed-ok' },
    });
    child.emits({
      method: 'turn/completed',
      params: { threadId: 'thread-closing-7', turn: { id: state.runningTurnId, status: 'completed', error: null } },
    });
    await waitForCondition(() => completed.length === 1);
    expect(completed).toEqual(['resumed-ok']);

    await provider.disconnect();
  });
});
