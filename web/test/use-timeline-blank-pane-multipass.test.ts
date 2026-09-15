/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/preact';
import { h } from 'preact';
import type { TimelineEvent } from '../src/ws-client.js';

vi.mock('../src/api.js', () => ({
  fetchTimelineHistoryHttp: vi.fn(async () => { throw new Error('offline'); }),
  fetchTimelineTextTailHttp: vi.fn(async () => { throw new Error('offline'); }),
}));

/**
 * The blank pane against a REAL IndexedDB, with a backlog bigger than one
 * deletion budget.
 *
 * A single deletion budget is 500 rows, and a v1 backlog has no such bound. So
 * the first drain pass frees the newest 500 — and the window that is re-read
 * immediately afterwards is STILL nothing but the next layer of signals. Later
 * passes do clear it, but IndexedDB deletions notify nobody, so a repair that
 * refreshes only once leaves the pane blank with the fix "working" underneath it.
 *
 * Nothing here is mocked except the network: the real TimelineDB, the real
 * drain, the real prune loop. `ws` is null and both HTTP helpers reject, so the
 * only thing that can make this pane render is local storage.
 */

const DB_NAME = 'imcodes-timeline';
const STORE = 'events';
const SESSION = 'deck_multipass';
const SERVER = 'srv-multipass';

function row(
  eventId: string,
  seq: number,
  type: string,
  text: string,
  hidden = false,
): TimelineEvent {
  return {
    eventId,
    ...(hidden ? { hidden: true } : {}),
    // Stored under the scoped cache key, which is what the hook reads.
    sessionId: `${SERVER}:${SESSION}`,
    ts: seq * 1_000,
    epoch: 1,
    seq,
    source: 'daemon',
    confidence: 'high',
    type,
    payload: type === 'session.state' ? { state: 'idle' } : { text },
  } as unknown as TimelineEvent;
}

function seedV1(rows: TimelineEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE, { keyPath: 'eventId' });
      store.createIndex('session_epoch_seq', ['sessionId', 'epoch', 'seq'], { unique: false });
      store.createIndex('session_ts', ['sessionId', 'ts'], { unique: false });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const r of rows) store.put(r);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Real timers: the drain loop sleeps between chunks, and IDB is async. */
async function waitFor(predicate: () => boolean, budgetMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
}

describe('a backlog larger than one deletion budget still repairs the live pane', () => {
  beforeEach(() => {
    // Fresh factory BEFORE the hook module is loaded: its shared TimelineDB is
    // a module singleton, so a module imported earlier would bind to whatever
    // database existed then and read an empty store forever.
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps refreshing across passes until the conversation is visible', async () => {
    const rows: TimelineEvent[] = [];
    // 5 real messages, buried under 1000 legacy signals — twice the 500-row
    // budget, so one pass provably cannot free the window.
    for (let i = 0; i < 5; i += 1) {
      rows.push(row(`msg-${i}`, i + 1, 'assistant.text', `message ${i}`));
    }
    for (let i = 0; i < 1_000; i += 1) {
      rows.push(row(`sig-${i}`, 6 + i, 'session.state', ''));
    }
    await seedV1(rows);

    // Imported only now — after the seeded database exists.
    const { useTimeline, __resetTimelineCacheForTests, __resetLocalHistoryPruneStateForTests } =
      await import('../src/hooks/useTimeline.js');
    __resetTimelineCacheForTests();
    __resetLocalHistoryPruneStateForTests();

    function Probe() {
      const { events } = useTimeline(SESSION, null, SERVER, { isActiveSession: true });
      return h(
        'div',
        { 'data-testid': 'pane' },
        events.filter((e) => e.type === 'assistant.text')
          .map((e) => String(e.payload.text ?? '')).join('|'),
      );
    }

    render(h(Probe));

    await waitFor(() => (screen.getByTestId('pane').textContent ?? '').includes('message 0'));

    // eslint-disable-next-line no-console
    const rendered = screen.getByTestId('pane').textContent ?? '';
    expect(
      rendered,
      'the pane never showed the buried conversation — the drain freed the window with nobody looking',
    ).toContain('message 0');
    expect(rendered).toContain('message 4');
  }, 40_000);

  it('is not fooled by a newest event that renders as nothing', async () => {
    // Same backlog, but the newest row is a peer_audit.status — an event the
    // chat renders as null. It must not count as "the pane has content": doing
    // so both delays the immediate repair and stops the refresh loop after the
    // first pass, leaving the buried conversation unreachable.
    const rows: TimelineEvent[] = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push(row(`msg-${i}`, i + 1, 'assistant.text', `message ${i}`));
    }
    for (let i = 0; i < 1_000; i += 1) {
      rows.push(row(`sig-${i}`, 6 + i, 'session.state', ''));
    }
    rows.push(row('audit-status', 1_100, 'peer_audit.status', ''));
    await seedV1(rows);

    const { useTimeline, __resetTimelineCacheForTests, __resetLocalHistoryPruneStateForTests } =
      await import('../src/hooks/useTimeline.js');
    __resetTimelineCacheForTests();
    __resetLocalHistoryPruneStateForTests();

    function Probe() {
      const { events } = useTimeline(SESSION, null, SERVER, { isActiveSession: true });
      return h(
        'div',
        { 'data-testid': 'pane' },
        events.filter((e) => e.type === 'assistant.text')
          .map((e) => String(e.payload.text ?? '')).join('|'),
      );
    }

    render(h(Probe));
    await waitFor(() => (screen.getByTestId('pane').textContent ?? '').includes('message 0'));

    expect(
      screen.getByTestId('pane').textContent ?? '',
      'a null-rendered newest event was mistaken for visible content',
    ).toContain('message 0');
  }, 40_000);

  it('is not fooled by a newest event that is hidden', async () => {
    // A DELETED message: the daemon re-emits it with hidden:true and that row is
    // persisted, so it legitimately sits at the top of a restored window.
    // ChatView drops it before anything else (`!event.hidden`), so it draws
    // nothing — but a type-only judgement sees a renderable `assistant.text`
    // and concludes the pane has content, stopping the refresh loop.
    const rows: TimelineEvent[] = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push(row(`msg-${i}`, i + 1, 'assistant.text', `message ${i}`));
    }
    for (let i = 0; i < 1_000; i += 1) {
      rows.push(row(`sig-${i}`, 6 + i, 'session.state', ''));
    }
    rows.push(row('deleted-msg', 1_100, 'assistant.text', 'deleted', true));
    await seedV1(rows);

    const { useTimeline, __resetTimelineCacheForTests, __resetLocalHistoryPruneStateForTests } =
      await import('../src/hooks/useTimeline.js');
    __resetTimelineCacheForTests();
    __resetLocalHistoryPruneStateForTests();

    function Probe() {
      const { events } = useTimeline(SESSION, null, SERVER, { isActiveSession: true });
      return h(
        'div',
        { 'data-testid': 'pane' },
        events.filter((e) => e.type === 'assistant.text' && !(e as { hidden?: boolean }).hidden)
          .map((e) => String(e.payload.text ?? '')).join('|'),
      );
    }

    render(h(Probe));
    await waitFor(() => (screen.getByTestId('pane').textContent ?? '').includes('message 0'));

    expect(
      screen.getByTestId('pane').textContent ?? '',
      'a hidden (deleted) event was mistaken for visible content',
    ).toContain('message 0');
  }, 40_000);

  it('is not fooled by a newest assistant row whose text is blank', async () => {
    // Providers really do emit empty completions (Cursor headless, Kimi and
    // Gemini forward accumulated text with no non-empty guard) and the row is
    // persisted. `buildViewItems` trims it and skips it, so it draws nothing —
    // but a type-only judgement sees a renderable, non-hidden assistant.text.
    const rows: TimelineEvent[] = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push(row(`msg-${i}`, i + 1, 'assistant.text', `message ${i}`));
    }
    for (let i = 0; i < 1_000; i += 1) {
      rows.push(row(`sig-${i}`, 6 + i, 'session.state', ''));
    }
    rows.push(row('blank-msg', 1_100, 'assistant.text', '   '));
    await seedV1(rows);

    const { useTimeline, __resetTimelineCacheForTests, __resetLocalHistoryPruneStateForTests } =
      await import('../src/hooks/useTimeline.js');
    __resetTimelineCacheForTests();
    __resetLocalHistoryPruneStateForTests();

    function Probe() {
      const { events } = useTimeline(SESSION, null, SERVER, { isActiveSession: true });
      return h(
        'div',
        { 'data-testid': 'pane' },
        events.filter((e) => e.type === 'assistant.text')
          .map((e) => String(e.payload.text ?? '').trim())
          .filter((text) => text.length > 0)
          .join('|'),
      );
    }

    render(h(Probe));
    await waitFor(() => (screen.getByTestId('pane').textContent ?? '').includes('message 0'));

    expect(
      screen.getByTestId('pane').textContent ?? '',
      'a blank assistant row was mistaken for visible content',
    ).toContain('message 0');
  }, 40_000);
});
