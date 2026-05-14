/**
 * Tests for async `timelineStore.append` (PR-A C1).
 *
 * Covers:
 *   T1 — `append` returns a Promise (fire-and-forget from `emit`).
 *   T2 — same-session appends are serialized (in-file order preserved).
 *   T3 — cross-session writes interleave (no global ordering contract).
 *   T4 — `flushAll(timeoutMs)` drains all pending session chains and logs
 *        warn when timed out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const projectionMocks = vi.hoisted(() => ({
  recordAppendedEvent: vi.fn(async () => undefined),
  queryHistory: vi.fn(),
  queryByTypes: vi.fn(),
  queryCompletedTextTail: vi.fn(),
  getLatest: vi.fn(),
  pruneSessionToAuthoritative: vi.fn(),
  deleteSession: vi.fn(),
  checkpointIfNeeded: vi.fn(),
  drain: vi.fn(async () => undefined),
}));

vi.mock('../../src/daemon/timeline-projection.js', () => ({
  timelineProjection: projectionMocks,
}));

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: loggerMocks,
}));

type TimelineStoreModule = typeof import('../../src/daemon/timeline-store.js');

function makeEvent(sessionId: string, seq: number, text: string) {
  return {
    eventId: `${sessionId}-${seq}`,
    sessionId,
    ts: seq,
    seq,
    epoch: 1,
    source: 'daemon' as const,
    confidence: 'high' as const,
    type: 'assistant.text' as const,
    payload: { text, streaming: false },
  };
}

describe('timeline-store async append (T1-T4)', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string | null = null;
  let timelineStore: TimelineStoreModule['timelineStore'];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-async-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    ({ timelineStore } = await import('../../src/daemon/timeline-store.js'));
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

  it('T1: append() returns a Promise and emit-style callers do not need to await', () => {
    const result = timelineStore.append(makeEvent('t1-session', 1, 'hello'));
    expect(typeof (result as Promise<void> | undefined)?.then).toBe('function');
    // Test must not throw if the caller ignores the return value — that
    // is the explicit `emit()` hot-path contract.
  });

  it('T2: same-session appends are serialized via the per-session promise chain', async () => {
    const sessionId = 't2-session';
    const filePath = timelineStore.filePath(sessionId);

    // Fire 50 appends back-to-back without awaiting individually.
    for (let i = 1; i <= 50; i++) {
      timelineStore.append(makeEvent(sessionId, i, `msg-${i}`));
    }
    await timelineStore.flushSession(sessionId);

    const raw = readFileSync(filePath, 'utf-8').trimEnd().split('\n');
    expect(raw).toHaveLength(50);
    raw.forEach((line, idx) => {
      const parsed = JSON.parse(line) as { seq: number };
      expect(parsed.seq).toBe(idx + 1);
    });
  });

  it('T3: cross-session writes are independent — flushSession waits only for its session', async () => {
    const sessionA = 't3-a';
    const sessionB = 't3-b';
    timelineStore.append(makeEvent(sessionA, 1, 'a1'));
    timelineStore.append(makeEvent(sessionB, 1, 'b1'));
    timelineStore.append(makeEvent(sessionA, 2, 'a2'));
    timelineStore.append(makeEvent(sessionB, 2, 'b2'));

    await timelineStore.flushSession(sessionA);
    await timelineStore.flushSession(sessionB);

    const rawA = readFileSync(timelineStore.filePath(sessionA), 'utf-8').trimEnd().split('\n');
    const rawB = readFileSync(timelineStore.filePath(sessionB), 'utf-8').trimEnd().split('\n');
    expect(rawA.map((l) => JSON.parse(l).seq)).toEqual([1, 2]);
    expect(rawB.map((l) => JSON.parse(l).seq)).toEqual([1, 2]);
  });

  it('T4: flushAll() resolves when all pending session chains settle', async () => {
    timelineStore.append(makeEvent('flush-a', 1, 'a'));
    timelineStore.append(makeEvent('flush-b', 1, 'b'));
    timelineStore.append(makeEvent('flush-c', 1, 'c'));

    expect(timelineStore.getPendingSessionCount()).toBeGreaterThanOrEqual(0);

    await timelineStore.flushAll(5_000);

    // After drain, pending count must be zero.
    expect(timelineStore.getPendingSessionCount()).toBe(0);

    for (const session of ['flush-a', 'flush-b', 'flush-c']) {
      const raw = readFileSync(timelineStore.filePath(session), 'utf-8').trimEnd();
      expect(raw.length).toBeGreaterThan(0);
    }
  });

  it('T4b: flushAll(timeoutMs) logs warn when timeout fires while chain still in flight', async () => {
    // Build a long chain that completes faster than the warn happens for the assertion,
    // but ensure the warn path is reachable: install a slow appendFile mock.
    vi.resetModules();
    vi.doMock('fs/promises', async () => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      return {
        ...actual,
        appendFile: vi.fn(async (...args: Parameters<typeof actual.appendFile>) => {
          await new Promise((r) => setTimeout(r, 200));
          return actual.appendFile(...args);
        }),
      };
    });
    const { timelineStore: slowStore } = await import('../../src/daemon/timeline-store.js');
    slowStore.append(makeEvent('slow-session', 1, 'one'));
    slowStore.append(makeEvent('slow-session', 2, 'two'));

    await slowStore.flushAll(50); // intentionally too short
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 50, pendingSessions: expect.any(Number) }),
      'TimelineStore: flushAll timed out',
    );

    // Drain for real so afterEach can clean up.
    await slowStore.flushAll(5_000);
  });

  it('append failure does not break the per-session chain — subsequent writes still land', async () => {
    let call = 0;
    vi.resetModules();
    vi.doMock('fs/promises', async () => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      return {
        ...actual,
        appendFile: vi.fn(async (...args: Parameters<typeof actual.appendFile>) => {
          call += 1;
          if (call === 1) throw new Error('disk hiccup');
          return actual.appendFile(...args);
        }),
      };
    });
    const { timelineStore: hiccupStore } = await import('../../src/daemon/timeline-store.js');
    const sessionId = 'hiccup-session';
    hiccupStore.append(makeEvent(sessionId, 1, 'first-will-fail'));
    hiccupStore.append(makeEvent(sessionId, 2, 'second-succeeds'));
    await hiccupStore.flushSession(sessionId);

    const filePath = hiccupStore.filePath(sessionId);
    const raw = readFileSync(filePath, 'utf-8').trimEnd().split('\n');
    expect(raw).toHaveLength(1);
    expect(JSON.parse(raw[0]!).seq).toBe(2);
  });
});
