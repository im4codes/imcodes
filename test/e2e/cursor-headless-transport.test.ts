import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';

const cursorHarness = vi.hoisted(() => {
  const state = {
    versionOutput: 'Cursor Agent 1.0.0\n',
    statusOutput: 'Logged in\n',
    createChatOutput: 'cursor-e2e-chat-1\n',
    statusError: null as Error | null,
    createChatError: null as Error | null,
  };
  const spawned: Array<{
    file: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    child: EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: ReturnType<typeof vi.fn>;
      killed: boolean;
    };
  }> = [];
  const execFile = vi.fn((file: string, args: string[], optsOrCb?: unknown, maybeCb?: unknown) => {
    const cb = typeof optsOrCb === 'function'
      ? optsOrCb as (err: Error | null, stdout: string, stderr: string) => void
      : maybeCb as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
    if (args.includes('--version')) {
      cb?.(null, state.versionOutput, '');
      return {} as never;
    }
    if (args[0] === 'status') {
      if (state.statusError) cb?.(state.statusError, '', '');
      else cb?.(null, state.statusOutput, '');
      return {} as never;
    }
    if (args[0] === 'create-chat') {
      if (state.createChatError) cb?.(state.createChatError, '', '');
      else cb?.(null, state.createChatOutput, '');
      return {} as never;
    }
    cb?.(null, '', '');
    return {} as never;
  });
  const spawn = vi.fn((file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: ReturnType<typeof vi.fn>;
      killed: boolean;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.killed = false;
    child.kill = vi.fn((signal?: string) => {
      child.killed = true;
      queueMicrotask(() => child.emit('close', 0, signal ?? 'SIGTERM'));
      return true;
    });
    spawned.push({ file, args, cwd: opts.cwd, env: opts.env, child });
    queueMicrotask(() => child.emit('spawn'));
    return child as never;
  });
  return {
    state,
    spawned,
    execFile,
    spawn,
    lastSpawn(): (typeof spawned)[number] {
      const entry = spawned.at(-1);
      if (!entry) throw new Error('No Cursor spawn recorded');
      return entry;
    },
    async flush(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
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

import {
  CursorHeadlessProvider,
  cursorHeadlessRuntimeHooks,
} from '../../src/agent/providers/cursor-headless.js';
import type { ProviderContextPayload } from '../../shared/context-types.js';

describe('Cursor headless transport (e2e)', () => {
  const originalLoadChildProcess = cursorHeadlessRuntimeHooks.loadChildProcess;

  beforeEach(() => {
    cursorHeadlessRuntimeHooks.loadChildProcess = async () => ({
      execFile: cursorHarness.execFile,
      spawn: cursorHarness.spawn,
    } as typeof import('node:child_process'));
    cursorHarness.spawn.mockClear();
    cursorHarness.execFile.mockClear();
    cursorHarness.spawned.length = 0;
    cursorHarness.state.versionOutput = 'Cursor Agent 1.0.0\n';
    cursorHarness.state.statusOutput = 'Logged in\n';
    cursorHarness.state.createChatOutput = 'cursor-e2e-chat-1\n';
    cursorHarness.state.statusError = null;
    cursorHarness.state.createChatError = null;
  });

  afterEach(() => {
    cursorHeadlessRuntimeHooks.loadChildProcess = originalLoadChildProcess;
  });

  it('creates a session, streams a turn, cancels cleanly, and preserves restoreability for the known session id', async () => {
    const provider = new CursorHeadlessProvider();
    await provider.connect({ binaryPath: 'cursor-agent' });

    const sessionId = await provider.createSession({
      sessionKey: 'cursor-e2e-route',
      cwd: '/tmp/project',
      agentId: 'gpt-5.2',
    });

    const deltas: string[] = [];
    const completed: string[] = [];
    const errors: Array<Record<string, unknown>> = [];
    const tools: Array<{ status: string }> = [];
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));
    provider.onComplete((_sid, msg) => completed.push(String(msg.content)));
    provider.onError((_sid, error) => errors.push(error as Record<string, unknown>));
    provider.onToolCall((_sid, tool) => tools.push({ status: tool.status }));

    await provider.send(sessionId, {
      userMessage: 'run the probe',
      assembledMessage: 'Context block\n\nrun the probe',
      systemText: 'Probe the repo and then respond with PROBE_OK',
      messagePreamble: 'Context block',
      attachments: [],
      context: {
        systemText: 'Probe the repo and then respond with PROBE_OK',
        messagePreamble: 'Context block',
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: { scope: 'personal', projectId: 'cursor-e2e-route' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        diagnostics: [],
      },
      supportClass: 'degraded-message-side-context-mapping',
      diagnostics: [],
    } satisfies ProviderContextPayload);

    const firstSpawn = cursorHarness.lastSpawn();
    expect(firstSpawn.args).toContain('--resume');
    expect(firstSpawn.args).toContain('cursor-e2e-chat-1');
    expect(firstSpawn.args.at(-1)).toContain('run the probe');
    expect(sessionId).toBe('cursor-e2e-route');

    firstSpawn.child.stdout.write(`${JSON.stringify({ type: 'system.init', session_id: 'cursor-e2e-chat-1', model: 'gpt-5.2', permissionMode: 'default' })}\n`);
    firstSpawn.child.stdout.write(`${JSON.stringify({ type: 'stream_event', session_id: 'cursor-e2e-chat-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'PRO' } } })}\n`);
    firstSpawn.child.stdout.write(`${JSON.stringify({ type: 'stream_event', session_id: 'cursor-e2e-chat-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'PROBE_' } } })}\n`);
    firstSpawn.child.stdout.write(`${JSON.stringify({ type: 'tool_call.started', session_id: 'cursor-e2e-chat-1', id: 'tool-e2e-1', name: 'shell', input: { command: 'echo PROBE_OK' } })}\n`);
    firstSpawn.child.stdout.write(`${JSON.stringify({ type: 'tool_call.completed', session_id: 'cursor-e2e-chat-1', id: 'tool-e2e-1', name: 'shell', output: 'PROBE_OK' })}\n`);
    firstSpawn.child.stdout.write(`${JSON.stringify({ type: 'assistant', session_id: 'cursor-e2e-chat-1', message: { id: 'msg-e2e-1', content: [{ type: 'text', text: 'PROBE_OK' }] } })}\n`);
    firstSpawn.child.stdout.write(`${JSON.stringify({ type: 'result.success', session_id: 'cursor-e2e-chat-1', result: 'PROBE_OK', usage: { input_tokens: 9, output_tokens: 4 } })}\n`);
    firstSpawn.child.emit('close', 0, null);
    await cursorHarness.flush();

    expect(deltas).toEqual(['PRO', 'PROBE_']);
    expect(completed).toEqual(['PROBE_OK']);
    expect(tools).toEqual([{ status: 'running' }, { status: 'complete' }]);
    expect(errors).toEqual([]);
    await expect(provider.restoreSession(sessionId)).resolves.toBe(true);

    const cancelTurn = provider.send(sessionId, 'stop this turn');
    await cursorHarness.flush();
    await provider.cancel(sessionId);
    await cancelTurn;
    await cursorHarness.flush();

    expect(cursorHarness.lastSpawn().child.killed).toBe(true);
    expect(errors.some((error) => error.code === 'CANCELLED')).toBe(true);
  });
});
