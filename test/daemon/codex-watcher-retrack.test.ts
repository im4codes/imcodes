import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn() },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/store/session-store.js', () => ({
  updateSessionState: vi.fn(),
}));

import { startWatchingSpecificFile, retrackLatestRollout, stopWatching, parseLine, resetParseStateForTests } from '../../src/daemon/codex-watcher.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';

function sessionMetaLine(cwd: string): string {
  return JSON.stringify({
    timestamp: '2026-04-05T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'test-id', cwd, cli_version: '0.113.0', source: 'cli', model_provider: 'openai' },
  });
}

function userMessageLine(message: string): string {
  return JSON.stringify({
    timestamp: '2026-04-05T00:01:00.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message, images: [], local_images: [] },
  });
}

function taskStartedLine(): string {
  return JSON.stringify({
    timestamp: '2026-04-05T00:02:00.000Z',
    type: 'event_msg',
    payload: { type: 'task_started' },
  });
}

function taskCompleteLine(): string {
  return JSON.stringify({
    timestamp: '2026-04-05T00:03:00.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete' },
  });
}

async function waitUntil(fn: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitUntil timeout');
}

describe('codex retrackLatestRollout', () => {
  let projectDir: string;
  let sessionDir: string;
  let retrackDir: string;
  let oldFile: string;
  let newFile: string;
  let otherUuidFile: string;
  const sessionName = `session-codex-retrack-${Date.now()}`;
  const sessionUuid = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    resetParseStateForTests();
    vi.mocked(timelineEmitter.emit).mockClear();
    projectDir = await mkdtemp(join(tmpdir(), 'codex-retrack-proj-'));
    const now = new Date();
    sessionDir = join(
      homedir(),
      '.codex',
      'sessions',
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
    );
    await mkdir(sessionDir, { recursive: true });
    const prev = new Date(now.getTime() - 86_400_000);
    retrackDir = join(
      homedir(),
      '.codex',
      'sessions',
      String(prev.getUTCFullYear()),
      String(prev.getUTCMonth() + 1).padStart(2, '0'),
      String(prev.getUTCDate()).padStart(2, '0'),
    );
    await mkdir(retrackDir, { recursive: true });
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    oldFile = join(sessionDir, `rollout-${unique}-old-${sessionUuid}.jsonl`);
    newFile = join(retrackDir, `rollout-${unique}-new-${sessionUuid}.jsonl`);
    otherUuidFile = join(retrackDir, `rollout-${unique}-other-22222222-2222-2222-2222-222222222222.jsonl`);
    await writeFile(oldFile, `${sessionMetaLine(projectDir)}\n`, 'utf8');
    await startWatchingSpecificFile(sessionName, oldFile);
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(newFile, `${sessionMetaLine(projectDir)}\n${userMessageLine('retracked codex message')}\n`, 'utf8');
  });

  afterEach(async () => {
    stopWatching(sessionName);
    await rm(projectDir, { recursive: true, force: true });
    await rm(oldFile, { force: true });
    await rm(newFile, { force: true });
    await rm(otherUuidFile, { force: true });
  });

  it('switches to the latest matching rollout and replays missed lines', async () => {
    expect(await retrackLatestRollout(sessionName)).toBe(true);
    await waitUntil(() =>
      vi.mocked(timelineEmitter.emit).mock.calls.some(
        (call) => call[0] === sessionName && call[1] === 'user.message' && (call[2] as any).text === 'retracked codex message',
      ),
    );
  });

  it('does not switch to a different UUID just because it is newer', async () => {
    vi.mocked(timelineEmitter.emit).mockClear();
    await rm(newFile, { force: true });
    await writeFile(otherUuidFile, `${sessionMetaLine(projectDir)}\n${userMessageLine('wrong uuid message')}\n`, 'utf8');
    expect(await retrackLatestRollout(sessionName)).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(
      vi.mocked(timelineEmitter.emit).mock.calls.some(
        (call) => call[0] === sessionName && call[1] === 'user.message' && (call[2] as any).text === 'retracked codex message',
      ),
    ).toBe(false);
    expect(
      vi.mocked(timelineEmitter.emit).mock.calls.some(
        (call) => call[0] === sessionName && call[1] === 'user.message' && (call[2] as any).text === 'wrong uuid message',
      ),
    ).toBe(false);
  });

  it('does not force idle if retracked replay shows the agent is still running', async () => {
    const runningFile = join(sessionDir, `rollout-running-${Date.now()}-${sessionUuid}.jsonl`);
    await writeFile(runningFile, `${sessionMetaLine(projectDir)}\n${taskStartedLine()}\n`, 'utf8');
    vi.mocked(timelineEmitter.emit).mockClear();

    parseLine(sessionName, taskCompleteLine());

    await waitUntil(() =>
      vi.mocked(timelineEmitter.emit).mock.calls.some(
        (call) => call[0] === sessionName && call[1] === 'session.state' && (call[2] as any).state === 'running',
      ),
    );
    await new Promise((r) => setTimeout(r, 200));

    const states = vi.mocked(timelineEmitter.emit).mock.calls
      .filter((call) => call[0] === sessionName && call[1] === 'session.state')
      .map((call) => (call[2] as any).state);
    expect(states).toContain('running');
    expect(states.at(-1)).toBe('running');

    await rm(runningFile, { force: true });
  });
});
