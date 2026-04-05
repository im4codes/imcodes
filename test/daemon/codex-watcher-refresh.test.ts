import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, stat, utimes } from 'fs/promises';
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

import { startWatchingSpecificFile, stopWatching } from '../../src/daemon/codex-watcher.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';

function meta(cwd: string, id = '11111111-1111-1111-1111-111111111111'): string {
  return JSON.stringify({ timestamp: '2026-04-05T00:00:00.000Z', type: 'session_meta', payload: { id, cwd, cli_version: '0.113.0', source: 'cli', model_provider: 'openai' } });
}
function user(message: string): string {
  return JSON.stringify({ timestamp: '2026-04-05T00:01:00.000Z', type: 'event_msg', payload: { type: 'user_message', message, images: [], local_images: [] } });
}

async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitUntil timeout');
}

describe('codex watcher refresh()', () => {
  let root: string;
  let cwd: string;
  let file: string;
  let newerSameUuid: string;
  let newerOtherUuid: string;

  beforeEach(async () => {
    vi.mocked(timelineEmitter.emit).mockClear();
    root = await mkdtemp(join(tmpdir(), 'codex-refresh-'));
    cwd = join(root, 'proj');
    await mkdir(cwd, { recursive: true });
    const now = new Date();
    const dirA = join(homedir(), '.codex', 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'));
    const next = new Date(now.getTime() - 86_400_000);
    const dirB = join(homedir(), '.codex', 'sessions', String(next.getUTCFullYear()), String(next.getUTCMonth() + 1).padStart(2, '0'), String(next.getUTCDate()).padStart(2, '0'));
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    file = join(dirA, 'rollout-old-11111111-1111-1111-1111-111111111111.jsonl');
    newerSameUuid = join(dirB, 'rollout-new-11111111-1111-1111-1111-111111111111.jsonl');
    newerOtherUuid = join(dirB, 'rollout-other-22222222-2222-2222-2222-222222222222.jsonl');
    await writeFile(file, `${meta(cwd)}\n`, 'utf8');
  });

  afterEach(async () => {
    stopWatching('codex-refresh');
    await rm(root, { recursive: true, force: true });
  });

  it('refresh drains newly appended lines from current rollout', async () => {
    const control = await startWatchingSpecificFile('codex-refresh', file);
    await writeFile(file, `${meta(cwd)}\n${user('refresh sees current file')}\n`, 'utf8');

    expect(await control.refresh()).toBe(true);
    await waitUntil(() => vi.mocked(timelineEmitter.emit).mock.calls.some((c) => c[1] === 'user.message'));
    expect(vi.mocked(timelineEmitter.emit).mock.calls.some((c) => c[0] === 'codex-refresh' && c[1] === 'user.message' && (c[2] as any).text === 'refresh sees current file')).toBe(true);
  });

  it('refresh follows newer same-uuid rollout but ignores different uuid rollout', async () => {
    const control = await startWatchingSpecificFile('codex-refresh', file);
    await writeFile(newerOtherUuid, `${meta(cwd, '22222222-2222-2222-2222-222222222222')}\n${user('wrong uuid')}\n`, 'utf8');
    await writeFile(newerSameUuid, `${meta(cwd)}\n${user('same uuid moved')}\n`, 'utf8');
    // Explicitly advance mtime so checkNewer() works on HFS+ (1-second mtime resolution)
    const fileMtime = (await stat(file)).mtimeMs;
    const future = new Date(fileMtime + 2000);
    await utimes(newerSameUuid, future, future);

    expect(await control.refresh()).toBe(true);
    await waitUntil(() => vi.mocked(timelineEmitter.emit).mock.calls.some((c) => c[1] === 'user.message'));
    expect(vi.mocked(timelineEmitter.emit).mock.calls.some((c) => c[0] === 'codex-refresh' && (c[2] as any).text === 'same uuid moved')).toBe(true);
    expect(vi.mocked(timelineEmitter.emit).mock.calls.some((c) => c[0] === 'codex-refresh' && (c[2] as any).text === 'wrong uuid')).toBe(false);
  });

  it('refresh returns false after stop', async () => {
    const control = await startWatchingSpecificFile('codex-refresh', file);
    stopWatching('codex-refresh');
    expect(await control.refresh()).toBe(false);
  });

  it('startWatchingSpecificFile does NOT replay existing content by default (no replayHistory)', async () => {
    // Write content to the file BEFORE starting the watcher (simulates session restart)
    await writeFile(file, `${meta(cwd)}\n${user('pre-existing message')}\n`, 'utf8');
    vi.mocked(timelineEmitter.emit).mockClear();

    await startWatchingSpecificFile('codex-refresh', file);
    await new Promise((r) => setTimeout(r, 100));

    // Pre-existing content must NOT be emitted
    expect(vi.mocked(timelineEmitter.emit).mock.calls.some(
      (c) => c[0] === 'codex-refresh' && c[1] === 'user.message' && (c[2] as any).text === 'pre-existing message',
    )).toBe(false);
    stopWatching('codex-refresh');
  });

  it('startWatchingSpecificFile replays content when replayHistory: true (daemon restore)', async () => {
    await writeFile(file, `${meta(cwd)}\n${user('historical message')}\n`, 'utf8');
    vi.mocked(timelineEmitter.emit).mockClear();

    await startWatchingSpecificFile('codex-refresh', file, undefined, { replayHistory: true });
    await waitUntil(() => vi.mocked(timelineEmitter.emit).mock.calls.some((c) => c[1] === 'user.message'));

    expect(vi.mocked(timelineEmitter.emit).mock.calls.some(
      (c) => c[0] === 'codex-refresh' && c[1] === 'user.message' && (c[2] as any).text === 'historical message',
    )).toBe(true);
    stopWatching('codex-refresh');
  });
});
