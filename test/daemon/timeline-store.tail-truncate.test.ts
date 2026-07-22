import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

describe('timeline-store truncate', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string | null = null;
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
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  });

  it('keeps conversation records ahead of status noise without readFileSync', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-store-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        readFileSync: vi.fn(() => {
          throw new Error('timelineStore.truncate should not call readFileSync');
        }),
      };
    });
    const [{ timelineStore }, { timelineProjection }] = await Promise.all([
      import('../../src/daemon/timeline-store.js'),
      import('../../src/daemon/timeline-projection.js'),
    ]);
    importedProjection = timelineProjection;

    const filePath = join(tempHome, '.imcodes', 'timeline', 'oversized_session.jsonl');
    mkdirSync(join(tempHome, '.imcodes', 'timeline'), { recursive: true });
    const lines = Array.from({ length: 6002 }, (_, index) => JSON.stringify({
      eventId: `oversized-${index}`,
      sessionId: 'oversized_session',
      ts: index,
      seq: index,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: index === 4 ? 'user.message' : index === 5 ? 'assistant.text' : 'agent.status',
      payload: index === 4 || index === 5 ? { text: `conversation-${index}` } : 'x'.repeat(512),
    }));
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    await timelineStore.truncate('oversized_session', 5000);

    const kept = readFileSync(filePath, 'utf8').trimEnd().split('\n');
    expect(kept).toHaveLength(5000);
    expect(kept.map((line) => JSON.parse(line).seq)).toEqual(expect.arrayContaining([4, 5]));
    expect(kept.some((line) => JSON.parse(line).seq === 0)).toBe(false);
    expect(JSON.parse(kept[kept.length - 1]!).seq).toBe(6001);

    const projectedConversation = await timelineStore.readByTypesPreferred(
      'oversized_session',
      ['user.message', 'assistant.text'],
      { limit: 10 },
    );
    expect(projectedConversation.map((event) => event.seq)).toEqual([4, 5]);
  });

  it('reads the tail of oversized timeline history and reports the latest event from the tail', async () => {
    tempHome = mkdtempSync(join(tmpdir(), 'imcodes-timeline-store-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    const [{ timelineStore }, { timelineProjection }] = await Promise.all([
      import('../../src/daemon/timeline-store.js'),
      import('../../src/daemon/timeline-projection.js'),
    ]);
    importedProjection = timelineProjection;

    const filePath = join(tempHome, '.imcodes', 'timeline', 'tail_read_session.jsonl');
    mkdirSync(join(tempHome, '.imcodes', 'timeline'), { recursive: true });
    const lines = Array.from({ length: 6200 }, (_, index) => JSON.stringify({
      sessionId: 'tail_read_session',
      seq: index + 1,
      epoch: 1,
      ts: index + 1,
      type: 'assistant.text',
      payload: { text: `message-${index}` },
    }));
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');

    const events = timelineStore.read('tail_read_session', { limit: 50 });
    expect(events).toHaveLength(50);
    expect(events[0]?.seq).toBe(6151);
    expect(events[events.length - 1]?.seq).toBe(6200);

    const latest = timelineStore.getLatest('tail_read_session');
    expect(latest).toEqual({ epoch: 1, seq: 6200 });
  });
});
