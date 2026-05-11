/**
 * T7 — Daemon startup must NOT block on `timelineStore.cleanup()` /
 * `truncateAll()`. The pre-R3 path blocked the main thread for 5–20s
 * with a backlog of 100 sessions × 5 MB. PR-A C4 runs both calls in
 * a void-detached promise with `setImmediate` yields between sessions.
 *
 * We don't drive the full lifecycle.ts startup path (it pulls in WS,
 * tmux, SQLite, etc.) — instead we exercise the contract directly on
 * `timelineStore`:
 *   1. `truncateAll()` and `cleanup()` are async and yield between
 *      sessions so a backlog of large files cannot stall the event
 *      loop for the full duration.
 *   2. Awaiting `truncateAll` produces the right final state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const projectionMocks = vi.hoisted(() => ({
  recordAppendedEvent: vi.fn(async () => undefined),
  queryHistory: vi.fn(),
  queryByTypes: vi.fn(),
  queryCompletedTextTail: vi.fn(),
  getLatest: vi.fn(),
  pruneSessionToAuthoritative: vi.fn(async () => undefined),
  deleteSession: vi.fn(async () => undefined),
  checkpointIfNeeded: vi.fn(async () => undefined),
  drain: vi.fn(async () => undefined),
}));

vi.mock('../../src/daemon/timeline-projection.js', () => ({
  timelineProjection: projectionMocks,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('timeline-store background startup (T7)', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-truncate-bg-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  });

  it('T7a: truncateAll yields the event loop between sessions', async () => {
    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    const timelineDir = join(tempHome!, '.imcodes', 'timeline');
    mkdirSync(timelineDir, { recursive: true });

    // Seed 5 oversized sessions.
    for (let i = 0; i < 5; i++) {
      const seed = Array.from({ length: 5100 }, (_, idx) =>
        JSON.stringify({ sessionId: `bg-${i}`, seq: idx + 1, epoch: 1, ts: idx + 1, type: 'assistant.text', payload: { text: `s${idx}` } }),
      );
      writeFileSync(join(timelineDir, `bg-${i}.jsonl`), seed.join('\n') + '\n', 'utf-8');
    }

    // Spy on `setImmediate` to verify the loop yielded between sessions.
    // More reliable than racing a `setInterval(.., 0)` against the loop.
    const setImmediateSpy = vi.spyOn(global, 'setImmediate');

    await timelineStore.truncateAll();

    // With 5 sessions the loop body must invoke `setImmediate` at least
    // 5 times (once after each session).
    expect(setImmediateSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
    setImmediateSpy.mockRestore();

    // All sessions are now ≤ 5000 lines.
    for (let i = 0; i < 5; i++) {
      const lines = readFileSync(join(timelineDir, `bg-${i}.jsonl`), 'utf-8').trimEnd().split('\n');
      expect(lines.length).toBe(5000);
    }
  });

  it('T7b: cleanup yields between deletes and respects MAX_AGE_MS', async () => {
    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    const timelineDir = join(tempHome!, '.imcodes', 'timeline');
    mkdirSync(timelineDir, { recursive: true });

    // Create one fresh and one old file.
    const fresh = join(timelineDir, 'fresh.jsonl');
    const old = join(timelineDir, 'old.jsonl');
    writeFileSync(fresh, JSON.stringify({ seq: 1 }) + '\n', 'utf-8');
    writeFileSync(old, JSON.stringify({ seq: 1 }) + '\n', 'utf-8');

    // Backdate the old file ~30 days.
    const { utimesSync } = await import('node:fs');
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);

    // Spy on `setImmediate` directly — more reliable than racing a
    // `setInterval(.., 0)` against a short cleanup loop.
    const setImmediateSpy = vi.spyOn(global, 'setImmediate');
    await timelineStore.cleanup();
    expect(setImmediateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    setImmediateSpy.mockRestore();

    // Fresh survives; old is gone.
    expect(() => readFileSync(fresh, 'utf-8')).not.toThrow();
    expect(() => readFileSync(old, 'utf-8')).toThrow();
  });

  it('T7c: truncateAll with empty dir is a no-op (no crash)', async () => {
    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    // Directory may not even exist — should not throw.
    await expect(timelineStore.truncateAll()).resolves.toBeUndefined();
    await expect(timelineStore.cleanup()).resolves.toBeUndefined();
  });
});
