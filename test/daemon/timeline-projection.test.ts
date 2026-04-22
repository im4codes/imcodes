import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';

function makeEvent(
  sessionId: string,
  seq: number,
  overrides: Partial<TimelineEvent> = {},
): TimelineEvent {
  return {
    eventId: `${sessionId}-event-${seq}`,
    sessionId,
    ts: seq,
    seq,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'assistant.text',
    payload: { text: `message-${seq}`, streaming: false },
    ...overrides,
  };
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    last = await fn();
    if (predicate(last)) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('timeline projection integration', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalDbPath = process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH;
  let tempHome: string | null = null;

  afterEach(async () => {
    try {
      const { timelineProjection } = await import('../../src/daemon/timeline-projection.js');
      await timelineProjection.shutdown();
    } catch {
      // ignore
    }
    vi.resetModules();
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalDbPath === undefined) delete process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH;
    else process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = originalDbPath;
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  });

  it('preserves append order for equal-ts events in SQLite-backed reads', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-projection-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = join(tempHome, '.imcodes', 'timeline.sqlite');

    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    const { timelineProjection } = await import('../../src/daemon/timeline-projection.js');

    timelineStore.append(makeEvent('same-ts', 1, { ts: 10, payload: { text: 'first', streaming: false } }));
    timelineStore.append(makeEvent('same-ts', 2, { ts: 10, payload: { text: 'second', streaming: false } }));
    await timelineProjection.rebuildSession('same-ts');

    const events = await timelineStore.readPreferred('same-ts', { limit: 10 });
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.payload.text)).toEqual(['first', 'second']);
  });

  it('rebuilds from authoritative JSONL when append happens before any projection metadata exists', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-projection-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = join(tempHome, '.imcodes', 'timeline.sqlite');

    const timelineDir = join(tempHome, '.imcodes', 'timeline');
    mkdirSync(timelineDir, { recursive: true });
    const seedEvent = makeEvent('seeded-session', 1, { payload: { text: 'seeded', streaming: false } });
    writeFileSync(join(timelineDir, 'seeded-session.jsonl'), `${JSON.stringify(seedEvent)}\n`, 'utf8');

    const { timelineStore } = await import('../../src/daemon/timeline-store.js');

    timelineStore.append(makeEvent('seeded-session', 2, { payload: { text: 'appended', streaming: false } }));

    const events = await waitFor(
      () => timelineStore.readPreferred('seeded-session', { limit: 10 }),
      (value) => value.length === 2,
    );
    expect(events.map((event) => event.payload.text)).toEqual(['seeded', 'appended']);
  });

  it('rebuilds stale projections when the authoritative JSONL changes behind SQLite', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-projection-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = join(tempHome, '.imcodes', 'timeline.sqlite');

    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    const { timelineProjection } = await import('../../src/daemon/timeline-projection.js');

    timelineStore.append(makeEvent('stale-session', 1, { payload: { text: 'one', streaming: false } }));
    await timelineProjection.rebuildSession('stale-session');

    const filePath = timelineStore.filePath('stale-session');
    const injected = makeEvent('stale-session', 2, { payload: { text: 'two', streaming: false } });
    writeFileSync(filePath, `${JSON.stringify(makeEvent('stale-session', 1, { payload: { text: 'one', streaming: false } }))}\n${JSON.stringify(injected)}\n`, 'utf8');

    const events = await waitFor(
      () => timelineStore.readPreferred('stale-session', { limit: 10 }),
      (value) => value.length === 2,
    );
    expect(events.map((event) => event.payload.text)).toEqual(['one', 'two']);
  });

  it('falls back to JSONL when the SQLite projection database is unavailable', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-projection-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    const brokenDbPath = join(tempHome, '.imcodes', 'projection-dir');
    mkdirSync(brokenDbPath, { recursive: true });
    process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = brokenDbPath;

    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    timelineStore.append(makeEvent('fallback-session', 1, { payload: { text: 'jsonl-only', streaming: false } }));

    const events = await timelineStore.readPreferred('fallback-session', { limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.text).toBe('jsonl-only');
  });

  it('keeps truncate parity and continues appending after pruning the projection', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-projection-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = join(tempHome, '.imcodes', 'timeline.sqlite');

    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    const { timelineProjection } = await import('../../src/daemon/timeline-projection.js');

    for (let seq = 1; seq <= 5; seq += 1) {
      timelineStore.append(makeEvent('truncate-session', seq, { payload: { text: `message-${seq}`, streaming: false } }));
    }
    await timelineProjection.rebuildSession('truncate-session');

    timelineStore.truncate('truncate-session', 3);
    const truncated = await waitFor(
      () => timelineStore.readPreferred('truncate-session', { limit: 10 }),
      (value) => value.length === 3,
    );
    expect(truncated.map((event) => event.seq)).toEqual([3, 4, 5]);

    timelineStore.append(makeEvent('truncate-session', 6, { payload: { text: 'message-6', streaming: false } }));
    const afterAppend = await waitFor(
      () => timelineStore.readPreferred('truncate-session', { limit: 10 }),
      (value) => value.length === 4 && value[value.length - 1]?.seq === 6,
    );
    expect(afterAppend.map((event) => event.seq)).toEqual([3, 4, 5, 6]);
  });

  it('supports completed text-tail and type-filtered SQLite queries', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-projection-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = join(tempHome, '.imcodes', 'timeline.sqlite');

    const { timelineStore } = await import('../../src/daemon/timeline-store.js');
    const { timelineProjection } = await import('../../src/daemon/timeline-projection.js');

    timelineStore.append(makeEvent('tail-session', 1, { type: 'user.message', payload: { text: 'user-text' } }));
    timelineStore.append(makeEvent('tail-session', 2, { type: 'assistant.text', payload: { text: 'streaming-fragment', streaming: true } }));
    timelineStore.append(makeEvent('tail-session', 3, { type: 'assistant.text', payload: { text: 'assistant-final', streaming: false } }));
    timelineStore.append(makeEvent('tail-session', 4, { type: 'tool.call', payload: { tool: 'Edit', args: {} } }));
    await timelineProjection.rebuildSession('tail-session');

    const completed = await timelineStore.readCompletedTextTail('tail-session', 10);
    expect(completed.map((event) => event.type)).toEqual(['user.message', 'assistant.text']);
    expect(completed.map((event) => event.payload.text)).toEqual(['user-text', 'assistant-final']);

    const toolOnly = await timelineStore.readByTypesPreferred('tail-session', ['tool.call'], { limit: 10 });
    expect(toolOnly).toHaveLength(1);
    expect(toolOnly[0]?.type).toBe('tool.call');
  });
});
