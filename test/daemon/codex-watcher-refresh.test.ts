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

vi.mock('../../src/store/session-store.js', () => {
  const sessions = new Map<string, any>();
  return {
    updateSessionState: vi.fn((name: string, state: string) => {
      const existing = sessions.get(name);
      if (existing) sessions.set(name, { ...existing, state });
    }),
    getSession: vi.fn((name: string) => sessions.get(name) ?? null),
    listSessions: vi.fn(() => [...sessions.values()]),
    upsertSession: vi.fn((rec: any) => { sessions.set(rec.name, rec); }),
  };
});

import { startWatchingSpecificFile, stopWatching, parseLine, resetParseStateForTests } from '../../src/daemon/codex-watcher.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import {
  bindProcessSharedMachineActivity,
  clearProcessSharedMachineAuthoritiesForTests,
  readActiveTreeAuthorityForSession,
  readProcessSharedMachineActivityEpoch,
} from '../../src/daemon/shared-machine-authority-context.js';
import { SHARED_MACHINE_ACTIVITY_KIND } from '../../shared/shared-machine-authority.js';

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
    resetParseStateForTests();
    clearProcessSharedMachineAuthoritiesForTests();
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

  it('startWatchingSpecificFile never replays pre-existing content (no replay ever)', async () => {
    // Write content BEFORE starting the watcher — simulates daemon restart or session respawn
    await writeFile(file, `${meta(cwd)}\n${user('pre-existing message')}\n`, 'utf8');
    vi.mocked(timelineEmitter.emit).mockClear();

    await startWatchingSpecificFile('codex-refresh', file);
    await new Promise((r) => setTimeout(r, 100));

    // Pre-existing content must NEVER be emitted — history lives in timeline store, not watcher
    expect(vi.mocked(timelineEmitter.emit).mock.calls.some(
      (c) => c[0] === 'codex-refresh' && c[1] === 'user.message' && (c[2] as any).text === 'pre-existing message',
    )).toBe(false);
    stopWatching('codex-refresh');
  });

  it('drops delayed async task_complete idle when a newer process turn window binds mid-refresh (from existing epoch or null)', async () => {
    const control = await startWatchingSpecificFile('codex-refresh', file);

    // Case 1: Turn 1 bound epoch1 -> task_complete (no assistant text) starts async refresh -> Turn 2 binds epoch2 mid-refresh
    const id = { sessionInstanceId: 'inst-cw-1', runtimeEpoch: 'epoch-cw-1' };
    bindProcessSharedMachineActivity('codex-refresh', id, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: 'trg_cw_turn1_11111111111111111111',
    }, { now: Date.now(), sessionRunning: true }).typed(Date.now());
    const epoch1 = readProcessSharedMachineActivityEpoch('codex-refresh')!;
    expect(typeof epoch1).toBe('number');

    parseLine('codex-refresh', JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }));
    vi.mocked(timelineEmitter.emit).mockClear();

    // Feed no-text task_complete so codex-watcher enters async finalizeIdleAfterRefresh(capturedEpoch = epoch1)
    parseLine('codex-refresh', JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }));

    // New turn arrives immediately BEFORE the async refresh completes
    bindProcessSharedMachineActivity('codex-refresh', id, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
      actorUserId: 'user-p1',
      authority: 'trg_cw_turn2_22222222222222222222',
    }, { now: Date.now() + 1, sessionRunning: true }).typed(Date.now() + 1);
    const epoch2 = readProcessSharedMachineActivityEpoch('codex-refresh')!;
    expect(epoch2).toBeGreaterThan(epoch1);

    // Ensure async refresh/retrack finishes and drain settles
    await control.refresh();
    await new Promise((r) => setTimeout(r, 80));

    expect(vi.mocked(timelineEmitter.emit).mock.calls.some(
      (c) => c[0] === 'codex-refresh' && c[1] === 'session.state' && (c[2] as any)?.state === 'idle',
    )).toBe(false);
    expect(readProcessSharedMachineActivityEpoch('codex-refresh')).toBe(epoch2);
    expect(readActiveTreeAuthorityForSession('codex-refresh')?.authority).toBe('trg_cw_turn2_22222222222222222222');

    // Case 2: Null window at task_complete -> Turn binds mid-refresh -> stale null completion must NOT emit idle or touch Turn 1 window
    stopWatching('codex-refresh');
    resetParseStateForTests();
    clearProcessSharedMachineAuthoritiesForTests();

    const control2 = await startWatchingSpecificFile('codex-refresh', file);
    parseLine('codex-refresh', JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }));
    vi.mocked(timelineEmitter.emit).mockClear();
    expect(readProcessSharedMachineActivityEpoch('codex-refresh')).toBeNull();

    parseLine('codex-refresh', JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }));

    bindProcessSharedMachineActivity('codex-refresh', id, {
      kind: SHARED_MACHINE_ACTIVITY_KIND.OWNER,
      authority: 'trg_cw_null_guarded_333333333333',
    }, { now: Date.now() + 2, sessionRunning: true }).typed(Date.now() + 2);
    const freshEpoch = readProcessSharedMachineActivityEpoch('codex-refresh');
    expect(typeof freshEpoch).toBe('number');

    await control2.refresh();
    await new Promise((r) => setTimeout(r, 80));

    expect(vi.mocked(timelineEmitter.emit).mock.calls.some(
      (c) => c[0] === 'codex-refresh' && c[1] === 'session.state' && (c[2] as any)?.state === 'idle',
    )).toBe(false);
    expect(readProcessSharedMachineActivityEpoch('codex-refresh')).toBe(freshEpoch);
    expect(readActiveTreeAuthorityForSession('codex-refresh')?.authority).toBe('trg_cw_null_guarded_333333333333');
  });
});
