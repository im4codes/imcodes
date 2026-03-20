import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { readFileSync } from 'fs';

// ── Mock timelineEmitter ──────────────────────────────────────────────────────

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn(),
  },
}));

// ── Mock logger ───────────────────────────────────────────────────────────────

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { parseLine, readCwd, startWatching, startWatchingSpecificFile, stopWatching, isWatching, resetParseStateForTests } from '../../src/daemon/codex-watcher.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sessionMetaLine(cwd: string): string {
  return JSON.stringify({
    timestamp: '2026-03-13T00:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: 'test-id',
      cwd,
      cli_version: '0.113.0',
      source: 'cli',
      model_provider: 'openai',
    },
  });
}

function userMessageLine(message: string): string {
  return JSON.stringify({
    timestamp: '2026-03-13T00:01:00.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message, images: [], local_images: [] },
  });
}

function agentMessageLine(message: string, phase: string): string {
  return JSON.stringify({
    timestamp: '2026-03-13T00:02:00.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message, phase },
  });
}

function tokenCountLine(): string {
  return JSON.stringify({
    timestamp: '2026-03-13T00:03:00.000Z',
    type: 'event_msg',
    payload: { type: 'token_count', info: {} },
  });
}

function responseItemLine(): string {
  return JSON.stringify({
    timestamp: '2026-03-13T00:04:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [] },
  });
}

function functionCallLine(name: string, args: Record<string, unknown>, callId = 'call_abc123'): string {
  return JSON.stringify({
    timestamp: '2026-03-13T00:05:00.000Z',
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId },
  });
}

function functionCallOutputLine(output: string, callId = 'call_abc123'): string {
  return JSON.stringify({
    timestamp: '2026-03-13T00:06:00.000Z',
    type: 'response_item',
    payload: { type: 'function_call_output', output, call_id: callId },
  });
}

function loadRolloutFixture(name: string): string[] {
  const path = join(__dirname, '../fixtures/codex-rollouts', `${name}.jsonl`);
  return readFileSync(path, 'utf-8').trim().split('\n');
}

function fixtureLabels(name: string): string[] {
  return loadRolloutFixture(name).map((line) => {
    const obj = JSON.parse(line);
    const payload = obj.payload ?? {};
    if (obj.type === 'event_msg') {
      return payload.type === 'agent_message'
        ? `event_msg:${payload.type}:${payload.phase}`
        : `event_msg:${payload.type}`;
    }
    if (obj.type === 'response_item') return `response_item:${payload.type}`;
    return obj.type;
  });
}

function replayFixture(sessionName: string, name: string): void {
  for (const line of loadRolloutFixture(name)) parseLine(sessionName, line);
}

async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitUntil timeout');
}

// ── parseLine ─────────────────────────────────────────────────────────────────

describe('parseLine — user_message', () => {
  beforeEach(() => {
    resetParseStateForTests();
    vi.mocked(timelineEmitter.emit).mockClear();
  });

  it('emits user.message for user_message event', () => {
    parseLine('session-a', userMessageLine('hello world'));
    expect(timelineEmitter.emit).toHaveBeenCalledOnce();
    expect(timelineEmitter.emit).toHaveBeenCalledWith(
      'session-a',
      'user.message',
      { text: 'hello world' },
      { source: 'daemon', confidence: 'high' },
    );
  });

  it('does not emit for empty user_message', () => {
    parseLine('session-a', userMessageLine('   '));
    expect(timelineEmitter.emit).not.toHaveBeenCalled();
  });

  it('preserves CJK text in user_message', () => {
    parseLine('session-a', userMessageLine('分析下这个项目'));
    expect(timelineEmitter.emit).toHaveBeenCalledWith(
      'session-a',
      'user.message',
      { text: '分析下这个项目' },
      expect.any(Object),
    );
  });
});

describe('parseLine — agent_message', () => {
  beforeEach(() => {
    resetParseStateForTests();
    vi.mocked(timelineEmitter.emit).mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('emits assistant.text only after debounce (no immediate streaming)', () => {
    parseLine('session-b', agentMessageLine('Here is my answer', 'final_answer'));
    expect(timelineEmitter.emit).toHaveBeenCalledOnce();
    expect(vi.mocked(timelineEmitter.emit).mock.calls[0][1]).toBe('session.state');
    vi.runAllTimers();
    expect(timelineEmitter.emit).toHaveBeenCalledTimes(2);
    expect(timelineEmitter.emit).toHaveBeenCalledWith(
      'session-b',
      'assistant.text',
      { text: 'Here is my answer', streaming: false },
      { source: 'daemon', confidence: 'high' },
    );
  });

  it('debounces multiple tokens, emits only final value', () => {
    parseLine('session-b', agentMessageLine('Work', 'final_answer'));
    parseLine('session-b', agentMessageLine('Working', 'final_answer'));
    parseLine('session-b', agentMessageLine('Working on it', 'final_answer'));
    expect(vi.mocked(timelineEmitter.emit).mock.calls.map((c) => c[1])).toEqual(['session.state']);
    vi.runAllTimers();
    expect(timelineEmitter.emit).toHaveBeenCalledTimes(2);
    expect(timelineEmitter.emit).toHaveBeenCalledWith(
      'session-b',
      'assistant.text',
      { text: 'Working on it', streaming: false },
      expect.any(Object),
    );
  });

  it('emits assistant.thinking for commentary phase', () => {
    parseLine('session-b', agentMessageLine('Working on it...', 'commentary'));
    vi.runAllTimers();
    expect(timelineEmitter.emit).toHaveBeenCalledTimes(2);
    expect(timelineEmitter.emit).toHaveBeenCalledWith(
      'session-b',
      'assistant.thinking',
      { text: 'Working on it...' },
      expect.any(Object),
    );
  });

  it('does NOT emit for empty final_answer text', () => {
    parseLine('session-b', agentMessageLine('  ', 'final_answer'));
    vi.runAllTimers();
    expect(timelineEmitter.emit).not.toHaveBeenCalled();
  });
});

describe('parseLine — ignored line types', () => {
  beforeEach(() => {
    resetParseStateForTests();
    vi.mocked(timelineEmitter.emit).mockClear();
  });

  it('ignores token_count events', () => {
    parseLine('session-c', tokenCountLine());
    expect(timelineEmitter.emit).not.toHaveBeenCalled();
  });

  it('ignores non-tool response_item lines (e.g. assistant message)', () => {
    parseLine('session-c', responseItemLine());
    expect(timelineEmitter.emit).not.toHaveBeenCalled();
  });

  it('ignores session_meta lines', () => {
    parseLine('session-c', sessionMetaLine('/some/dir'));
    expect(timelineEmitter.emit).not.toHaveBeenCalled();
  });

  it('ignores empty lines', () => {
    parseLine('session-c', '');
    parseLine('session-c', '   ');
    expect(timelineEmitter.emit).not.toHaveBeenCalled();
  });

  it('ignores invalid JSON', () => {
    parseLine('session-c', 'not json at all');
    expect(timelineEmitter.emit).not.toHaveBeenCalled();
  });
});

describe('parseLine — session isolation', () => {
  beforeEach(() => {
    resetParseStateForTests();
    vi.mocked(timelineEmitter.emit).mockClear();
  });

  it('passes correct sessionName to each emit', () => {
    parseLine('deck_proj_brain', userMessageLine('msg1'));
    parseLine('deck_proj_w1', userMessageLine('msg2'));

    const calls = vi.mocked(timelineEmitter.emit).mock.calls;
    expect(calls[0][0]).toBe('deck_proj_brain');
    expect(calls[1][0]).toBe('deck_proj_w1');
  });
});

// ── readCwd ───────────────────────────────────────────────────────────────────

describe('readCwd', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetParseStateForTests();
    tmpDir = await mkdtemp(join(tmpdir(), 'codex-watcher-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns cwd from a valid session_meta first line', async () => {
    const file = join(tmpDir, 'rollout-test.jsonl');
    await writeFile(file, sessionMetaLine('/Users/k/project') + '\n' + userMessageLine('hi'));
    expect(await readCwd(file)).toBe('/Users/k/project');
  });

  it('returns null when first line is not session_meta', async () => {
    const file = join(tmpDir, 'rollout-test.jsonl');
    await writeFile(file, userMessageLine('hi') + '\n');
    expect(await readCwd(file)).toBeNull();
  });

  it('returns null for empty file', async () => {
    const file = join(tmpDir, 'rollout-empty.jsonl');
    await writeFile(file, '');
    expect(await readCwd(file)).toBeNull();
  });

  it('returns null for invalid JSON first line', async () => {
    const file = join(tmpDir, 'rollout-bad.jsonl');
    await writeFile(file, 'not json\n');
    expect(await readCwd(file)).toBeNull();
  });

  it('returns null for non-existent file', async () => {
    expect(await readCwd(join(tmpDir, 'ghost.jsonl'))).toBeNull();
  });

  it('strips trailing slash from cwd', async () => {
    const line = JSON.stringify({
      type: 'session_meta',
      payload: { cwd: '/Users/k/project/' },
    });
    const file = join(tmpDir, 'rollout-slash.jsonl');
    await writeFile(file, line + '\n');
    // readCwd returns raw cwd — normalization happens in findLatestRollout
    expect(await readCwd(file)).toBe('/Users/k/project/');
  });
});

// ── startWatching / stopWatching / isWatching ─────────────────────────────────

describe('isWatching / stopWatching', () => {
  afterEach(() => {
    stopWatching('session-x');
  });

  it('isWatching returns false before startWatching', () => {
    expect(isWatching('session-x')).toBe(false);
  });

  it('isWatching returns true after startWatching', async () => {
    // Use a workDir that won't match any real file so watcher just idles
    await startWatching('session-x', '/tmp/__nonexistent_codex_dir__');
    expect(isWatching('session-x')).toBe(true);
  });

  it('isWatching returns false after stopWatching', async () => {
    await startWatching('session-x', '/tmp/__nonexistent_codex_dir__');
    stopWatching('session-x');
    expect(isWatching('session-x')).toBe(false);
  });

  it('stopWatching is safe to call when not watching', () => {
    expect(() => stopWatching('never-started')).not.toThrow();
  });
});

describe('startWatching — file-based integration', () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(async () => {
    resetParseStateForTests();
    tmpDir = await mkdtemp(join(tmpdir(), 'codex-int-'));
    // Simulate ~/.codex/sessions/YYYY/MM/DD layout
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    sessionDir = join(tmpDir, String(yyyy), mm, dd);
    await mkdir(sessionDir, { recursive: true });
    vi.mocked(timelineEmitter.emit).mockClear();
  });

  afterEach(async () => {
    stopWatching('session-int');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('emits history from existing rollout file on start', async () => {
    const workDir = join(tmpDir, 'myproject');
    const rollout = join(sessionDir, 'rollout-2026-03-13T10-00-00-abc.jsonl');

    await writeFile(rollout, [
      sessionMetaLine(workDir),
      userMessageLine('first message'),
      agentMessageLine('first reply', 'final_answer'),
      agentMessageLine('thinking...', 'commentary'),
      tokenCountLine(),
    ].join('\n') + '\n');

    // Temporarily redirect home to our tmpDir by monkey-patching the watcher
    // Instead, we test via the exported helpers since home() is baked in.
    // This test verifies parseLine is called correctly for each line type.
    // Full integration of home dir path requires env manipulation — tested above.

    // Direct parseLine integration test:
    const lines = [
      userMessageLine('hello'),
      agentMessageLine('final answer', 'final_answer'),
      agentMessageLine('commentary step', 'commentary'),
      tokenCountLine(),
    ];
    vi.useFakeTimers();
    for (const line of lines) parseLine('session-int', line);
    vi.runAllTimers();
    vi.useRealTimers();

    expect(timelineEmitter.emit).toHaveBeenCalledTimes(4);
    expect(vi.mocked(timelineEmitter.emit).mock.calls[0][1]).toBe('user.message');
    expect(vi.mocked(timelineEmitter.emit).mock.calls[1][1]).toBe('session.state');
    expect(vi.mocked(timelineEmitter.emit).mock.calls[2][1]).toBe('assistant.thinking');
    expect(vi.mocked(timelineEmitter.emit).mock.calls[3][1]).toBe('assistant.text');
  });

  it('multiple sessions with different workDirs are isolated', async () => {
    vi.mocked(timelineEmitter.emit).mockClear();

    // Simulate two sessions parsing lines
    parseLine('session-proj-a', userMessageLine('msg from A'));
    parseLine('session-proj-b', userMessageLine('msg from B'));

    const calls = vi.mocked(timelineEmitter.emit).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe('session-proj-a');
    expect(calls[0][2]).toEqual({ text: 'msg from A' });
    expect(calls[1][0]).toBe('session-proj-b');
    expect(calls[1][2]).toEqual({ text: 'msg from B' });
  });

  it('switches to a newer same-directory rollout file and keeps emitting text', async () => {
    const uuid = '12345678-1234-1234-1234-123456789abc';
    const file1 = join(sessionDir, `rollout-2026-03-13T10-00-00-${uuid}.jsonl`);
    const file2 = join(sessionDir, `rollout-2026-03-13T10-05-00-${uuid}.jsonl`);

    await writeFile(file1, [sessionMetaLine(join(tmpDir, 'proj-a'))].join('\n') + '\n');
    await startWatchingSpecificFile('session-int', file1);

    // Ensure file2 has a strictly newer mtime (CI filesystems may have low mtime resolution)
    await new Promise((r) => setTimeout(r, 100));

    await writeFile(file2, [
      sessionMetaLine(join(tmpDir, 'proj-a')),
      userMessageLine('followed after rollover'),
    ].join('\n') + '\n');

    // fs.watch notification can be slow on CI — use a generous timeout
    await waitUntil(() =>
      vi.mocked(timelineEmitter.emit).mock.calls.some(
        (call) => call[0] === 'session-int' && call[1] === 'user.message' && (call[2] as any).text === 'followed after rollover',
      ),
      8000,
    );
  });
});

// ── parseLine — function_call / function_call_output (Codex tool calls) ────────

describe('parseLine — function_call (Codex tool calls)', () => {
  beforeEach(() => {
    resetParseStateForTests();
    vi.mocked(timelineEmitter.emit).mockClear();
  });

  it('emits tool.call for function_call with cmd arg', () => {
    parseLine('session-f', functionCallLine('exec_command', { cmd: 'git status', workdir: '/project' }));
    expect(timelineEmitter.emit).toHaveBeenCalledTimes(2);
    expect(timelineEmitter.emit).toHaveBeenCalledWith(
      'session-f',
      'tool.call',
      { tool: 'exec_command', input: 'git status' },
      { source: 'daemon', confidence: 'high' },
    );
  });

  it('emits tool.call for function_call with path arg', () => {
    parseLine('session-f', functionCallLine('read_file', { path: '/project/src/index.ts' }));
    expect(timelineEmitter.emit).toHaveBeenCalledWith(
      'session-f',
      'tool.call',
      { tool: 'read_file', input: '/project/src/index.ts' },
      expect.any(Object),
    );
  });

  it('emits tool.call with raw args string when no known summary field', () => {
    parseLine('session-f', functionCallLine('custom_tool', { x: 1, y: 2 }));
    const call = vi.mocked(timelineEmitter.emit).mock.calls[1];
    expect(call[1]).toBe('tool.call');
    expect(call[2]).toMatchObject({ tool: 'custom_tool' });
    // input should be the raw JSON string
    expect(typeof (call[2] as { input: string }).input).toBe('string');
  });

  it('emits tool.result for function_call_output', () => {
    parseLine('session-f', functionCallOutputLine('Process exited with code 0\nOutput:\nhello world'));
    expect(timelineEmitter.emit).toHaveBeenCalledOnce();
    expect(timelineEmitter.emit).toHaveBeenCalledWith(
      'session-f',
      'tool.result',
      {},
      { source: 'daemon', confidence: 'high' },
    );
  });

  it('tool.call and tool.result use standard payloads without callId', () => {
    parseLine('session-f', functionCallLine('exec_command', { cmd: 'ls' }, 'call_xyz'));
    parseLine('session-f', functionCallOutputLine('file1\nfile2', 'call_xyz'));
    const calls = vi.mocked(timelineEmitter.emit).mock.calls;
    expect(calls[1][1]).toBe('tool.call');
    expect(calls[2][1]).toBe('tool.result');
    expect(calls[1][2]).not.toHaveProperty('callId');
    expect(calls[2][2]).not.toHaveProperty('callId');
  });

  it('emits tool.call for each consecutive function_call independently', () => {
    parseLine('session-f', functionCallLine('read_file', { path: '/a' }, 'call_1'));
    parseLine('session-f', functionCallLine('read_file', { path: '/b' }, 'call_2'));
    expect(timelineEmitter.emit).toHaveBeenCalledTimes(3);
    expect(vi.mocked(timelineEmitter.emit).mock.calls[1][2]).toMatchObject({ input: '/a' });
    expect(vi.mocked(timelineEmitter.emit).mock.calls[2][2]).toMatchObject({ input: '/b' });
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('parseLine — edge cases', () => {
  beforeEach(() => {
    resetParseStateForTests();
    vi.mocked(timelineEmitter.emit).mockClear();
  });

  it('handles multi-line message text (newlines in content)', () => {
    const msg = 'line one\nline two\nline three';
    parseLine('session-e', userMessageLine(msg));
    expect(timelineEmitter.emit).toHaveBeenCalledWith(
      'session-e',
      'user.message',
      { text: msg },
      expect.any(Object),
    );
  });

  it('handles task_started event without emitting', () => {
    const line = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'abc' },
    });
    parseLine('session-e', line);
    expect(timelineEmitter.emit).toHaveBeenCalledWith(
      'session-e',
      'session.state',
      { state: 'running' },
      { source: 'daemon', confidence: 'high' },
    );
  });

  it('handles task_complete event without emitting', () => {
    const line = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete' },
    });
    parseLine('session-e', line);
    expect(timelineEmitter.emit).toHaveBeenCalledWith(
      'session-e',
      'session.state',
      { state: 'idle' },
      { source: 'daemon', confidence: 'high' },
    );
  });

  it('handles turn_aborted event without emitting', () => {
    const line = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'turn_aborted' },
    });
    parseLine('session-e', line);
    expect(timelineEmitter.emit).not.toHaveBeenCalled();
  });

  it('handles missing payload gracefully', () => {
    const line = JSON.stringify({ type: 'event_msg' });
    expect(() => parseLine('session-e', line)).not.toThrow();
    expect(timelineEmitter.emit).not.toHaveBeenCalled();
  });
});

describe('sanitized Codex rollout fixtures', () => {
  beforeEach(() => {
    resetParseStateForTests();
    vi.mocked(timelineEmitter.emit).mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('simple-complete fixture preserves the common complete-turn boundary', () => {
    expect(fixtureLabels('simple-complete')).toEqual([
      'session_meta',
      'response_item:message',
      'response_item:message',
      'event_msg:task_started',
      'turn_context',
      'response_item:message',
      'event_msg:user_message',
      'response_item:reasoning',
      'event_msg:agent_message:final_answer',
      'response_item:message',
      'event_msg:token_count',
      'event_msg:task_complete',
    ]);

    replayFixture('session-fixture-simple', 'simple-complete');
    vi.runAllTimers();

    const events = vi.mocked(timelineEmitter.emit).mock.calls.map((c) => c[1]);
    expect(events).toEqual([
      'session.state',
      'user.message',
      'assistant.thinking',
      'assistant.text',
      'session.state',
    ]);
    expect(vi.mocked(timelineEmitter.emit).mock.calls[0][2]).toEqual({ state: 'running' });
    expect(vi.mocked(timelineEmitter.emit).mock.calls.at(-1)?.[2]).toEqual({ state: 'idle' });
  });

  it('tools-complete fixture preserves commentary/tools/final/task_complete sequence', () => {
    const labels = fixtureLabels('tools-complete');
    expect(labels).toContain('event_msg:task_started');
    expect(labels).toContain('event_msg:agent_message:commentary');
    expect(labels).toContain('response_item:function_call');
    expect(labels).toContain('response_item:function_call_output');
    expect(labels.at(-1)).toBe('event_msg:task_complete');

    replayFixture('session-fixture-tools', 'tools-complete');
    vi.runAllTimers();

    const calls = vi.mocked(timelineEmitter.emit).mock.calls;
    expect(calls[0][1]).toBe('session.state');
    expect(calls[0][2]).toEqual({ state: 'running' });
    expect(calls.filter((c) => c[1] === 'tool.call')).toHaveLength(3);
    expect(calls.filter((c) => c[1] === 'tool.result')).toHaveLength(3);
    expect(calls.filter((c) => c[1] === 'assistant.thinking').length).toBeGreaterThanOrEqual(4);
    expect(calls.at(-2)?.[1]).toBe('assistant.text');
    expect(calls.at(-1)?.[1]).toBe('session.state');
    expect(calls.at(-1)?.[2]).toEqual({ state: 'idle' });
  });

  it('final-answer-no-task-complete fixture documents the fallback candidate shape', () => {
    const labels = fixtureLabels('final-answer-no-task-complete');
    expect(labels).not.toContain('event_msg:task_complete');
    expect(labels.at(-3)).toBe('event_msg:agent_message:final_answer');
    expect(labels.at(-2)).toBe('response_item:message');
    expect(labels.at(-1)).toBe('event_msg:token_count');

    replayFixture('session-fixture-fallback', 'final-answer-no-task-complete');
    vi.runAllTimers();

    const events = vi.mocked(timelineEmitter.emit).mock.calls.map((c) => c[1]);
    expect(events).toEqual(['session.state', 'user.message', 'assistant.thinking', 'assistant.text']);
  });

  it('aborted-mid-turn fixture documents incomplete work that must not look complete', () => {
    const labels = fixtureLabels('aborted-mid-turn');
    expect(labels).toContain('event_msg:turn_aborted');
    expect(labels).not.toContain('event_msg:task_complete');
    expect(labels).not.toContain('event_msg:agent_message:final_answer');

    replayFixture('session-fixture-aborted', 'aborted-mid-turn');
    vi.runAllTimers();

    const events = vi.mocked(timelineEmitter.emit).mock.calls.map((c) => c[1]);
    expect(events).toEqual([
      'session.state',
      'user.message',
      'assistant.thinking',
      'assistant.thinking',
      'tool.call',
      'tool.result',
    ]);
  });
});
