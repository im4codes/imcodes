/**
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/preact';
import { h } from 'preact';
import type { TimelineEvent } from '../src/ws-client.js';
import { isGuaranteedVisibleTimelineEvent } from '../../src/shared/timeline/types.js';

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
// Hang cap only: the assertion awaits the real prune lifecycle edge. Under V8
// coverage and a saturated CI host, the real 1,000-row IDB sweep has taken 61s.
const MULTIPASS_PRUNE_HANG_TIMEOUT_MS = 180_000;

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
    // budget, so one pass provably cannot free the window. The three newest
    // rows cover every misleading "present but not visible" shape in the same
    // real-IDB run instead of repeating this expensive fixture four times.
    for (let i = 0; i < 5; i += 1) {
      rows.push(row(`msg-${i}`, i + 1, 'assistant.text', `message ${i}`));
    }
    for (let i = 0; i < 1_000; i += 1) {
      rows.push(row(`sig-${i}`, 6 + i, 'session.state', ''));
    }
    rows.push(row('audit-status', 1_100, 'peer_audit.status', ''));
    rows.push(row('deleted-msg', 1_101, 'assistant.text', 'deleted', true));
    rows.push(row('blank-msg', 1_102, 'assistant.text', '   '));
    await seedV1(rows);

    // Imported only now — after the seeded database exists.
    const {
      useTimeline,
      __resetTimelineCacheForTests,
      __resetLocalHistoryPruneStateForTests,
      __waitForLocalHistoryPruneForTests,
    } =
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
    // Register immediately after render, before the async IDB bootstrap can
    // schedule its sweep. Waiting for the sweep's real lifecycle boundary is
    // deterministic under coverage and also prevents this module's background
    // work leaking into the next test.
    await act(async () => {
      await __waitForLocalHistoryPruneForTests(`${SERVER}:${SESSION}`);
    });

    // eslint-disable-next-line no-console
    const rendered = screen.getByTestId('pane').textContent ?? '';
    expect(
      rendered,
      'the pane never showed the buried conversation — the drain freed the window with nobody looking',
    ).toContain('message 0');
    expect(rendered).toContain('message 4');
  }, MULTIPASS_PRUNE_HANG_TIMEOUT_MS);

  it('is not fooled by a newest event that renders as nothing', () => {
    expect(isGuaranteedVisibleTimelineEvent(
      row('audit-status', 1_100, 'peer_audit.status', ''),
    )).toBe(false);
  });

  it('is not fooled by a newest event that is hidden', () => {
    expect(isGuaranteedVisibleTimelineEvent(
      row('deleted-msg', 1_100, 'assistant.text', 'deleted', true),
    )).toBe(false);
  });

  it('is not fooled by a newest assistant row whose text is blank', () => {
    expect(isGuaranteedVisibleTimelineEvent(
      row('blank-msg', 1_100, 'assistant.text', '   '),
    )).toBe(false);
  });
});
