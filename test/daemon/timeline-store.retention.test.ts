/**
 * Tests for async retention (`truncate` + tmp+rename atomicity).
 *
 * PR-A C3 contract:
 *   T5 — `truncate(sessionId, keep)` waits for the per-session append chain
 *        to settle before rewriting; in-flight events are never lost.
 *   T6 — `truncate` uses tmp+rename: a partial write must not corrupt the
 *        live file, and the chain head is reset on success so subsequent
 *        appends land in the new file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const projectionMocks = vi.hoisted(() => ({
  recordAppendedEvent: vi.fn(async () => undefined),
  queryHistory: vi.fn(),
  queryByTypes: vi.fn(),
  queryCompletedTextTail: vi.fn(),
  getLatest: vi.fn(),
  pruneSessionToAuthoritative: vi.fn(async () => undefined),
  deleteSession: vi.fn(),
  checkpointIfNeeded: vi.fn(),
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

describe('timeline-store async retention (T5-T6)', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-retention-'));
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

  it('T5: truncate awaits the pending per-session chain before rewriting', async () => {
    // Slow down appendFile so the chain has work in flight when truncate runs.
    vi.doMock('fs/promises', async () => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      return {
        ...actual,
        appendFile: vi.fn(async (...args: Parameters<typeof actual.appendFile>) => {
          await new Promise((r) => setTimeout(r, 30));
          return actual.appendFile(...args);
        }),
      };
    });
    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    const sessionId = 't5-session';
    const filePath = timelineStore.filePath(sessionId);
    mkdirSync(join(tempHome!, '.imcodes', 'timeline'), { recursive: true });

    // Seed with 5100 events so a truncate(keepLast=5000) reduces the file.
    const seedLines = Array.from({ length: 5100 }, (_, i) =>
      JSON.stringify({ sessionId, seq: i + 1, epoch: 1, ts: i + 1, type: 'assistant.text', payload: { text: `seed-${i + 1}` } }),
    );
    writeFileSync(filePath, seedLines.join('\n') + '\n', 'utf-8');

    // Kick off a fresh append, then immediately truncate. The append must
    // survive — its line must be present in the truncated file.
    const lateSeq = 5200;
    const appendPromise = timelineStore.append(makeEvent(sessionId, lateSeq, 'late-event'));
    const truncatePromise = timelineStore.truncate(sessionId, 5000);

    await Promise.all([appendPromise, truncatePromise]);

    const kept = readFileSync(filePath, 'utf-8').trimEnd().split('\n');
    expect(kept).toHaveLength(5000);
    const lastEvent = JSON.parse(kept[kept.length - 1]!) as { seq: number; payload: { text: string } };
    expect(lastEvent.seq).toBe(lateSeq);
    expect(lastEvent.payload.text).toBe('late-event');
  });

  it('T6: truncate uses tmp+rename — a failed write does not corrupt the live file', async () => {
    let firstWrite = true;
    vi.doMock('fs/promises', async () => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      return {
        ...actual,
        writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
          // Fail the *first* tmp write only — second call (the test's
          // second truncate) should succeed and complete normally.
          if (firstWrite) {
            firstWrite = false;
            throw new Error('simulated disk error');
          }
          return actual.writeFile(...args);
        }),
      };
    });
    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    const sessionId = 't6-session';
    const filePath = timelineStore.filePath(sessionId);
    mkdirSync(join(tempHome!, '.imcodes', 'timeline'), { recursive: true });

    const seed = Array.from({ length: 5050 }, (_, i) =>
      JSON.stringify({ sessionId, seq: i + 1, epoch: 1, ts: i + 1, type: 'assistant.text', payload: { text: `t-${i}` } }),
    );
    writeFileSync(filePath, seed.join('\n') + '\n', 'utf-8');

    // First attempt fails inside writeFile — live file must be untouched.
    await timelineStore.truncate(sessionId, 5000);
    const afterFailure = readFileSync(filePath, 'utf-8').trimEnd().split('\n');
    expect(afterFailure).toHaveLength(5050); // unchanged
    // tmp file should not linger
    expect(existsSync(`${filePath}.tmp`)).toBe(false);

    // Second attempt succeeds.
    await timelineStore.truncate(sessionId, 5000);
    const afterSuccess = readFileSync(filePath, 'utf-8').trimEnd().split('\n');
    expect(afterSuccess).toHaveLength(5000);
  });

  it('T6b: truncate resets the session chain so subsequent appends open a fresh fd', async () => {
    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    const sessionId = 't6b-session';
    const filePath = timelineStore.filePath(sessionId);
    mkdirSync(join(tempHome!, '.imcodes', 'timeline'), { recursive: true });

    const seed = Array.from({ length: 6000 }, (_, i) =>
      JSON.stringify({ sessionId, seq: i + 1, epoch: 1, ts: i + 1, type: 'assistant.text', payload: { text: `seed-${i}` } }),
    );
    writeFileSync(filePath, seed.join('\n') + '\n', 'utf-8');

    await timelineStore.truncate(sessionId, 5000);
    expect(timelineStore.getPendingSessionCount()).toBe(0);

    // Post-truncate append should land in the rewritten file.
    timelineStore.append(makeEvent(sessionId, 9999, 'post-truncate'));
    await timelineStore.flushSession(sessionId);

    const final = readFileSync(filePath, 'utf-8').trimEnd().split('\n');
    expect(final).toHaveLength(5001);
    expect(JSON.parse(final[final.length - 1]!).seq).toBe(9999);
  });
});
