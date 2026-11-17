/**
 * @vitest-environment jsdom
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { measureAsyncPerf, round2 } from './perf-helpers.js';

const mockApiState = vi.hoisted(() => ({
  subSessions: [] as any[],
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }),
  Trans: ({ children }: { children?: unknown }) => children ?? null,
}));

vi.mock('../../../web/src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../web/src/api.js')>();
  return {
    ...actual,
    listSubSessions: vi.fn(async () => mockApiState.subSessions),
    createSubSession: vi.fn(),
    patchSubSession: vi.fn(),
    getQuickData: vi.fn(async () => ({ history: [], commands: [], aliases: [] })),
    getUserPref: vi.fn(async () => null),
    saveUserPref: vi.fn(async () => {}),
    fetchAuthSession: vi.fn(async () => ({ ok: true })),
  };
});

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { TimelineDB } from '../../../web/src/timeline-db.js';
import { WsClient, type ServerMessage } from '../../../web/src/ws-client.js';
import { useSubSessions } from '../../../web/src/hooks/useSubSessions.js';
import { SubSessionBar } from '../../../web/src/components/SubSessionBar.js';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  url: string;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void) {
    const arr = this.listeners[type];
    if (arr) this.listeners[type] = arr.filter((f) => f !== fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }
  emit(type: string, data?: unknown) {
    if (type === 'open') this.readyState = MockWebSocket.OPEN;
    if (type === 'close') this.readyState = MockWebSocket.CLOSED;
    const direct = (this as unknown as Record<string, ((ev: unknown) => void) | null>)[`on${type}`];
    if (direct) direct(data);
    for (const fn of this.listeners[type] ?? []) fn(data);
  }
}

describe('Web 1000 sub-sessions & lock/unlock hang recovery perf suite', () => {
  const report: Record<string, unknown> = {
    label: process.env.PERF_LABEL ?? 'unlabeled',
  };

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    console.log(`[PERF_SCALE_WEB_UNLOCK] ${JSON.stringify(report)}`);
  });

  it('measures IDB hung open and hung transaction recovery under unlock simulation', async () => {
    const HANG_BUDGET_MS = 2_500;

    // 1) Hung indexedDB.open (WebKit post-sleep open that never fires onsuccess/onerror/onblocked)
    globalThis.indexedDB = {
      open: () => ({
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
        result: null,
        error: null,
      }),
    } as unknown as IDBFactory;

    const dbHungOpen = new TimelineDB();
    const openStart = performance.now();
    const openOutcome = await Promise.race([
      dbHungOpen.getRecentEvents('sess_hung_open', { limit: 50 }).then(() => ({ hung: false, ms: round2(performance.now() - openStart) })),
      new Promise<{ hung: boolean; ms: number }>((resolve) =>
        setTimeout(() => resolve({ hung: true, ms: round2(performance.now() - openStart) }), HANG_BUDGET_MS),
      ),
    ]);

    // 2) Hung IDB transaction (open succeeded, but transaction/get never fires callbacks after sleep)
    globalThis.indexedDB = {
      open: () => {
        const req: Record<string, any> = {
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          onblocked: null,
          error: null,
          result: {
            objectStoreNames: { contains: () => true },
            onclose: null,
            onversionchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            close: () => {},
            transaction: () => ({
              oncomplete: null,
              onerror: null,
              onabort: null,
              error: null,
              abort: () => {},
              objectStore: () => ({
                index: () => ({
                  openCursor: () => ({ onsuccess: null, onerror: null }),
                  getAll: () => ({ onsuccess: null, onerror: null }),
                }),
                getAll: () => ({ onsuccess: null, onerror: null }),
                get: () => ({ onsuccess: null, onerror: null }),
                put: () => ({ onsuccess: null, onerror: null }),
                delete: () => ({ onsuccess: null, onerror: null }),
              }),
            }),
          },
        };
        setTimeout(() => {
          req.onsuccess?.({ target: req });
        }, 0);
        return req;
      },
    } as unknown as IDBFactory;

    const dbHungTx = new TimelineDB();
    const txStart = performance.now();
    const txOutcome = await Promise.race([
      dbHungTx.getRecentEvents('sess_hung_tx', { limit: 50 }).then(() => ({ hung: false, ms: round2(performance.now() - txStart) })),
      new Promise<{ hung: boolean; ms: number }>((resolve) =>
        setTimeout(() => resolve({ hung: true, ms: round2(performance.now() - txStart) }), HANG_BUDGET_MS),
      ),
    ]);

    report.idbHungOpen = { ...openOutcome, memoryOnlyAfter: dbHungOpen.memoryOnly };
    report.idbHungTx = { ...txOutcome, memoryOnlyAfter: dbHungTx.memoryOnly };

    // Restore working IDB for subsequent tests
    globalThis.indexedDB = new IDBFactory();
    expect(openOutcome.ms).toBeGreaterThanOrEqual(0);
    expect(txOutcome.ms).toBeGreaterThanOrEqual(0);
  });

  it('measures WS stuck _connecting / hung ticket recovery across sleep on resumeConnection(true)', async () => {
    const sockets: MockWebSocket[] = [];
    let fetchAttempt = 0;

    vi.stubGlobal('WebSocket', class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
        if (sockets.length >= 2) {
          // Second (fresh post-unlock) socket opens cleanly
          setTimeout(() => this.emit('open'), 5);
        }
      }
    });

    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      fetchAttempt += 1;
      if (fetchAttempt === 1) {
        // First ticket fetch succeeds immediately so socket 1 enters stuck CONNECTING state
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ticket: 't1' }),
        } as Response);
      }
      // Subsequent ticket fetch after force-unlock succeeds immediately
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ticket: `t${fetchAttempt}` }),
      } as Response);
    }));

    const client = new WsClient('https://perf.local', 'srv-unlock');
    client.connect();
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(MockWebSocket.CONNECTING);

    // Simulate OS lock/sleep advancing Date.now() by 90s while socket 1 is still stuck in CONNECTING
    const realNow = Date.now;
    const baseNow = realNow();
    vi.spyOn(Date, 'now').mockImplementation(() => baseNow + 90_000);

    const t0 = performance.now();
    client.resumeConnection(true);

    // Wait up to 800ms for stale-in-flight abort + fresh socket open
    let recovered = false;
    while (performance.now() - t0 < 800) {
      if (client.connected) {
        recovered = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const recoveryMs = round2(performance.now() - t0);

    report.wsStuckConnectingUnlock = {
      recovered,
      recoveryMs,
      socketsCreated: sockets.length,
      fetchCalls: fetchAttempt,
    };

    client.disconnect();
    Date.now = realNow;
    expect(sockets.length).toBeGreaterThanOrEqual(1);
  });

  it('benchmarks useSubSessions 1000-sub ingestion + session.state storm and SubSessionBar mount at scale', async () => {
    const TOTAL_SUBS = 1000;
    const SUBS_IN_ACTIVE_PARENT = 200; // stress expanded card preview mount
    const now = Date.now();
    const initialSubs = Array.from({ length: TOTAL_SUBS }, (_, i) => ({
      id: `sub_${i}`,
      serverId: 'srv1',
      type: i % 4 === 3 ? 'shell' : 'claude-code-sdk',
      runtimeType: i % 4 === 3 ? 'process' : 'transport',
      shellBin: null,
      cwd: `/tmp/proj_${i % 100}`,
      label: `w_${i}`,
      ccSessionId: null,
      geminiSessionId: null,
      parentSession: i < SUBS_IN_ACTIVE_PARENT ? 'deck_proj_0_brain' : `deck_proj_${(i % 99) + 1}_brain`,
      requestedModel: 'sonnet',
      activeModel: 'sonnet',
      state: 'idle',
      createdAt: now,
      updatedAt: now,
    }));
    mockApiState.subSessions = initialSubs;

    const handlers = new Set<(msg: ServerMessage) => void>();
    const sentFrames: Array<Record<string, unknown>> = [];
    const mockWs = {
      send: (m: Record<string, unknown>) => sentFrames.push(m),
      subSessionRebuildAll: vi.fn(),
      onMessage: (fn: (msg: ServerMessage) => void) => {
        handlers.add(fn);
        return () => handlers.delete(fn);
      },
      subscribeTimelineSession: vi.fn(() => () => {}),
      subscribeTransportSession: vi.fn(),
      unsubscribeTransportSession: vi.fn(),
      onDaemonCapabilitySnapshot: vi.fn(() => () => {}),
      getDaemonCapabilitySnapshot: vi.fn(() => null),
      timelineReplayRequest: vi.fn(),
      timelineHistoryRequest: vi.fn(() => 'req-1'),
      timelineDetailRequest: vi.fn(),
      terminalSubscribe: vi.fn(),
      terminalUnsubscribe: vi.fn(),
    } as any;

    let hookResult: ReturnType<typeof useSubSessions> | null = null;
    function HookHarness() {
      hookResult = useSubSessions('srv1', mockWs, true, 'deck_proj_0_brain');
      return null;
    }

    const mountPerf = await measureAsyncPerf(async () => {
      render(<HookHarness />);
      await new Promise((r) => setTimeout(r, 30));
    });

    // Feed 1000 subsession.created + 200 session.state updates simulating reconnect sync burst
    const ingestPerf = await measureAsyncPerf(async () => {
      await act(async () => {
        for (let i = 0; i < TOTAL_SUBS; i++) {
          const msg = {
            type: 'subsession.created',
            id: `sub_${i}`,
            sessionType: i % 4 === 3 ? 'shell' : 'claude-code-sdk',
            runtimeType: i % 4 === 3 ? 'process' : 'transport',
            cwd: `/tmp/proj_${i % 100}`,
            label: `w_${i}`,
            parentSession: i < SUBS_IN_ACTIVE_PARENT ? 'deck_proj_0_brain' : `deck_proj_${(i % 99) + 1}_brain`,
            state: i % 5 === 0 ? 'running' : 'idle',
          } as unknown as ServerMessage;
          for (const h of handlers) h(msg);
        }
        for (let i = 0; i < 200; i++) {
          const msg = {
            type: 'session.state',
            session: `deck_sub_sub_${i}`,
            state: i % 2 === 0 ? 'running' : 'idle',
          } as unknown as ServerMessage;
          for (const h of handlers) h(msg);
        }
      });
    });

    const visibleForActive = hookResult!.visibleSubSessions;
    cleanup();

    // Now benchmark SubSessionBar expanded with SUBS_IN_ACTIVE_PARENT visible cards after letting progressive timers advance
    const barMountPerf = await measureAsyncPerf(async () => {
      render(
        <SubSessionBar
          subSessions={visibleForActive}
          openIds={new Set()}
          ws={mockWs}
          connected={true}
          serverId="srv1"
          quickClosePersistenceScope="deck_proj_0_brain"
          collapsed={false}
          onToggleOpen={vi.fn()}
          onNew={vi.fn()}
          onClose={vi.fn()}
          onRename={vi.fn()}
          onRestart={vi.fn()}
          onStop={vi.fn()}
          onSend={vi.fn()}
          onDiff={vi.fn()}
          onHistory={vi.fn()}
        />,
      );
      await new Promise((r) => setTimeout(r, 600));
    });

    const mountedCards = document.querySelectorAll('.subcard').length;
    const collapsedPills = document.querySelectorAll('.subsession-pill').length;

    report.webUseSubSessions1000 = {
      mountElapsedMs: mountPerf.stats.elapsedMs,
      ingest1000CreatedAnd200StateMs: ingestPerf.stats.elapsedMs,
      ingestMaxEventLoopMs: ingestPerf.stats.maxMs,
      heapUsedDeltaMb: ingestPerf.stats.heapUsedDeltaMb,
      visibleForActiveCount: visibleForActive.length,
    };
    report.webSubSessionBarExpanded = {
      ...barMountPerf.stats,
      mountedCardsAfter600ms: mountedCards,
      collapsedPills,
    };

    expect(hookResult!.subSessions.length).toBe(TOTAL_SUBS);
  });
});
