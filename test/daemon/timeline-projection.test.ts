import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { TimelineEvent } from '../../src/daemon/timeline-event.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalDbPath = process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH;

function makeEvent(sessionId: string, seq: number, type: TimelineEvent['type'], payload: Record<string, unknown>, ts = seq): TimelineEvent {
  return {
    eventId: `${sessionId}-${seq}-${type}`,
    sessionId,
    ts,
    seq,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type,
    payload,
  };
}

describe('timeline projection', () => {
  let tempHome: string | null = null;
  let dbPath: string | null = null;
  let importedProjection: typeof import('../../src/daemon/timeline-projection.js').timelineProjection | null = null;

  afterEach(async () => {
    if (importedProjection) {
      await importedProjection.shutdown();
    }
    importedProjection = null;
    vi.restoreAllMocks();
    vi.resetModules();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalDbPath === undefined) delete process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH;
    else process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = originalDbPath;
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
    dbPath = null;
  });

  async function loadModules() {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-projection-'));
    dbPath = join(tempHome, '.imcodes', 'timeline-projection.sqlite');
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.IMCODES_TIMELINE_PROJECTION_DB_PATH = dbPath;
    const [{ timelineProjection }, { timelineStore }] = await Promise.all([
      import('../../src/daemon/timeline-projection.js'),
      import('../../src/daemon/timeline-store.js'),
    ]);
    importedProjection = timelineProjection;
    return { timelineProjection, timelineStore };
  }

  it('preserves append order for equal-ts events and honors afterTs / beforeTs exclusivity', async () => {
    const { timelineProjection, timelineStore } = await loadModules();
    const sessionId = 'projection_order';
    timelineStore.append(makeEvent(sessionId, 1, 'assistant.text', { text: 'first' }, 1000));
    timelineStore.append(makeEvent(sessionId, 2, 'assistant.text', { text: 'second' }, 1000));
    timelineStore.append(makeEvent(sessionId, 3, 'assistant.text', { text: 'third' }, 1000));
    timelineStore.append(makeEvent(sessionId, 4, 'assistant.text', { text: 'fourth' }, 1001));

    await timelineProjection.rebuildSession(sessionId);

    const full = await timelineStore.readPreferred(sessionId, { limit: 10 });
    expect(full.map((event) => event.seq)).toEqual([1, 2, 3, 4]);

    const after = await timelineStore.readPreferred(sessionId, { afterTs: 1000, limit: 10 });
    expect(after.map((event) => event.seq)).toEqual([4]);

    const before = await timelineStore.readPreferred(sessionId, { beforeTs: 1001, limit: 10 });
    expect(before.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('returns completed text tail only for non-empty completed text events', async () => {
    const { timelineProjection, timelineStore } = await loadModules();
    const sessionId = 'projection_text_tail';
    timelineStore.append(makeEvent(sessionId, 1, 'user.message', { text: 'hello user' }, 1000));
    timelineStore.append(makeEvent(sessionId, 2, 'assistant.text', { text: 'typing', streaming: true }, 1001));
    timelineStore.append(makeEvent(sessionId, 3, 'assistant.text', { text: 'done', streaming: false }, 1002));
    timelineStore.append(makeEvent(sessionId, 4, 'assistant.text', { text: '   ', streaming: false }, 1003));
    timelineStore.append(makeEvent(sessionId, 5, 'tool.call', { tool: 'search' }, 1004));

    await timelineProjection.rebuildSession(sessionId);

    const tail = await timelineStore.readCompletedTextTail(sessionId, 10);
    expect(tail.map((event) => `${event.type}:${String(event.payload.text ?? '')}`)).toEqual([
      'user.message:hello user',
      'assistant.text:done',
    ]);

    const typed = await timelineStore.readByTypesPreferred(sessionId, ['tool.call', 'assistant.text'], { limit: 10 });
    expect(typed.map((event) => event.seq)).toEqual([2, 3, 4, 5]);
  });

  it('rebuilds stale sessions and prunes to authoritative truncation', async () => {
    const { timelineProjection, timelineStore } = await loadModules();
    const sessionId = 'projection_stale';
    const timelineFile = timelineStore.filePath(sessionId);
    mkdirSync(join(tempHome!, '.imcodes', 'timeline'), { recursive: true });

    timelineStore.append(makeEvent(sessionId, 1, 'assistant.text', { text: 'one' }, 1000));
    timelineStore.append(makeEvent(sessionId, 2, 'assistant.text', { text: 'two' }, 1001));
    await timelineProjection.rebuildSession(sessionId);

    appendFileSync(timelineFile, `${JSON.stringify(makeEvent(sessionId, 3, 'assistant.text', { text: 'three' }, 1002))}\n`);
    const rebuilt = await timelineStore.readPreferred(sessionId, { limit: 10 });
    expect(rebuilt.map((event) => event.seq)).toEqual([1, 2, 3]);

    timelineStore.truncate(sessionId, 2);
    await timelineProjection.pruneSessionToAuthoritative(sessionId, 2);

    const pruned = await timelineStore.readPreferred(sessionId, { limit: 10 });
    expect(pruned.map((event) => event.seq)).toEqual([2, 3]);

    await timelineProjection.deleteSession(sessionId);
    const rebuiltFromAuthoritative = await timelineProjection.queryHistory({ sessionId, limit: 10 });
    expect(rebuiltFromAuthoritative?.map((event) => event.seq)).toEqual([2, 3]);
  });
});
