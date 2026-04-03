import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const childProcessMock = vi.hoisted(() => {
  const execFile = vi.fn((file: string, args: string[], cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb?.(null, file === 'qwen' && args[0] === '--version' ? '0.13.2\n' : '', '');
    return {} as never;
  });

  const spawned: Array<{
    file: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    child: EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
      killed: boolean;
    };
  }> = [];

  const spawn = vi.fn((file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
      killed: boolean;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.killed = false;
    child.kill = vi.fn(() => { child.killed = true; child.emit('close', null, 'SIGTERM'); return true; });
    spawned.push({ file, args, cwd: opts.cwd, env: opts.env, child });
    queueMicrotask(() => child.emit('spawn'));
    return child as never;
  });

  return { execFile, spawn, spawned };
});

vi.mock('node:child_process', () => ({
  execFile: childProcessMock.execFile,
  spawn: childProcessMock.spawn,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { QwenProvider } from '../../src/agent/providers/qwen.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { ToolCallEvent } from '../../src/agent/transport-provider.js';

function lastSpawn() {
  const entry = childProcessMock.spawned.at(-1);
  if (!entry) throw new Error('No spawned qwen process');
  return entry;
}

async function flushIO(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('QwenProvider', () => {
  beforeEach(() => {
    childProcessMock.execFile.mockClear();
    childProcessMock.spawn.mockClear();
    childProcessMock.spawned.length = 0;
  });

  it('connects by validating qwen CLI', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    expect(childProcessMock.execFile).toHaveBeenCalledWith('qwen', ['--version'], expect.any(Function));
  });

  it('uses --session-id on first send, streams cumulative deltas, then resumes with --resume', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({
      sessionKey: 'sess-1',
      cwd: '/tmp/project',
      description: 'Be concise',
      agentId: 'qwen3-coder-plus',
    });

    const deltas: string[] = [];
    const completed: string[] = [];
    provider.onDelta((_sid, delta) => deltas.push(delta.delta));
    provider.onComplete((_sid, msg) => completed.push(String(msg.content)));

    await provider.send('sess-1', 'hello');
    const first = lastSpawn();
    expect(first.file).toBe('qwen');
    expect(first.cwd).toBe('/tmp/project');
    expect(first.args).toContain('--session-id');
    expect(first.args).toContain('sess-1');
    expect(first.args).not.toContain('--resume');
    expect(first.args).toContain('--append-system-prompt');
    expect(first.args).toContain('Be concise');
    expect(first.args).toContain('--model');
    expect(first.args).toContain('qwen3-coder-plus');

    first.child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'session_start', session_id: 'sess-1' })}\n`);
    first.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1' } } })}\n`);
    first.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } })}\n`);
    first.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } })}\n`);
    first.child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello' }] } })}\n`);
    first.child.emit('close', 0, null);
    await flushIO();

    expect(deltas).toEqual(['Hel', 'Hello']);
    expect(completed).toEqual(['Hello']);

    await provider.send('sess-1', 'again');
    const second = lastSpawn();
    expect(second.args).toContain('--resume');
    expect(second.args).toContain('sess-1');
    expect(second.args).not.toContain('--session-id');
  });

  it('keeps the streaming message id for final completion when qwen emits a different assistant id', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-2', cwd: '/tmp/project' });

    const completeIds: string[] = [];
    const metadata: Array<Record<string, unknown> | undefined> = [];
    provider.onComplete((_sid, msg) => { completeIds.push(msg.id); metadata.push(msg.metadata); });

    await provider.send('sess-2', 'hello');
    const run = lastSpawn();
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'stream-msg-1' } } })}\n`);
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } })}\n`);
    run.child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { id: 'assistant-msg-2', model: 'qwen3.5-plus', usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 }, content: [{ type: 'text', text: 'Hello' }] } })}\n`);
    run.child.emit('close', 0, null);
    await flushIO();

    expect(completeIds).toEqual(['stream-msg-1']);
    expect(metadata[0]).toEqual({
      model: 'qwen3.5-plus',
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
    });
  });


  it('does not release queued runtime sends until the qwen process actually finishes', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    const runtime = new TransportSessionRuntime(provider, 'sess-queue');
    await runtime.initialize({ sessionKey: 'sess-queue', cwd: '/tmp/project' });

    await runtime.send('first');
    const first = lastSpawn();
    first.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-queue-1' } } })}
`);
    first.child.stdout.write(`${JSON.stringify({ type: 'assistant', message: { id: 'assistant-queue-1', content: [{ type: 'text', text: 'Still running' }] } })}
`);
    await flushIO();

    const queued = runtime.send('second');
    await flushIO();
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);

    first.child.emit('close', 0, null);
    await queued;

    expect(childProcessMock.spawn).toHaveBeenCalledTimes(2);
  });

  it('emits provider error on result is_error payload', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-err', cwd: '/tmp/project' });

    const errors: string[] = [];
    provider.onError((_sid, err) => errors.push(err.message));

    await provider.send('sess-err', 'fail');
    const run = lastSpawn();
    run.child.stdout.write(`${JSON.stringify({ type: 'result', is_error: true, error: { message: 'bad request' } })}\n`);
    await flushIO();

    expect(errors).toEqual(['bad request']);
  });

  it('emits tool.call and tool.result events for qwen tool blocks', async () => {
    const provider = new QwenProvider();
    await provider.connect({});
    await provider.createSession({ sessionKey: 'sess-tool', cwd: '/tmp/project' });

    const tools: ToolCallEvent[] = [];
    provider.onToolCall?.((_sid, tool) => tools.push(tool));

    await provider.send('sess-tool', 'use a tool');
    const run = lastSpawn();
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'list_directory' } } })}\n`);
    run.child.stdout.write(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{\"path\":\"/tmp/project\"}' } } })}\n`);
    run.child.stdout.write(`${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }] } })}\n`);
    run.child.emit('close', 0, null);
    await flushIO();

    expect(tools).toEqual([
      {
        id: 'tool-1',
        name: 'list_directory',
        status: 'running',
        input: { path: '/tmp/project' },
      },
      {
        id: 'tool-1',
        name: 'list_directory',
        status: 'complete',
        output: 'ok',
      },
    ]);
  });
});
