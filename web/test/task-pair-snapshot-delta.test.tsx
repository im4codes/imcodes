/**
 * @vitest-environment jsdom
 *
 * tsk_cd_console_pairs_snapshot_delta, web side. The daemon half (real
 * producer + session registry over a real pair store) is wired to the real web
 * controller/reducer through a JSON round-trip, so the equivalence checks below
 * compare what a viewer really ends up with.
 */
import { DatabaseSync } from 'node:sqlite';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  }),
}));

import { SupervisionConsoleSessionRegistry } from '../../src/daemon/supervision-console-session.js';
import { SupervisionConsoleProducer } from '../../src/daemon/supervision-console-producer.js';
import { migrateSupervisionStore, type SupervisionMigrationDb } from '../../src/daemon/supervision-store-migrations.js';
import { TaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import {
  SUPERVISION_TASK_CONSOLE_FEATURES,
  SUPERVISION_TASK_CONSOLE_MSG,
  SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
  type SupervisionTaskConsoleScope,
} from '../../shared/supervision-task-console.js';
import { SUPERVISION_TASK_STATUS_CONTRACT_VERSION } from '../../shared/supervision-config.js';
import {
  SupervisionTaskConsoleController,
  type SupervisionTaskConsoleSocket,
} from '../src/supervision-task-console-controller.js';
import {
  SUPERVISION_TASK_CONSOLE_PHASE,
  createSupervisionTaskConsoleState,
  supervisionTaskConsoleReducer,
  type SupervisionTaskConsoleReducerState,
} from '../src/supervision-task-console-reducer.js';
import { taskConsoleStateToPairSnapshot } from '../src/components/SupervisionTaskConsole.js';
import { TaskPairBrief } from '../src/components/TaskPairBrief.js';
import { TaskPairStatusPanel } from '../src/components/TaskPairStatusPanel.js';
import {
  TASK_PAIR_BRIEF_REQUEST_TIMEOUT_MS,
  getCachedTaskPairBrief,
  receiveTaskPairBrief,
  requestTaskPairBrief,
  resetTaskPairBriefStoreForTests,
  setTaskPairBriefRequester,
  taskPairBriefStatus,
} from '../src/task-pair-brief-store.js';
import { clearAllSupervisionTaskConsoleCaches } from '../src/supervision-task-console-cache.js';

const PROJECT = 'alpha';
const BRAIN = 'deck_alpha_brain';
const SCOPE: SupervisionTaskConsoleScope = { projectName: PROJECT, coordinatorSessionName: BRAIN };
const EPOCH = 'epoch-1';
const BRIEF = (label: string) => `# Goal\n\nDetails **matter** for ${label}.\n\n- [x][ ] Implement ${label}\n- [ ][ ] Audit ${label}\n`;

let clock = 0;
const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

function newStore(): TaskPairStore {
  return new TaskPairStore(':memory:');
}

function save(store: TaskPairStore, taskId: string, over: Record<string, unknown> = {}) {
  clock += 1;
  return store.savePair(PROJECT, {
    taskId, brain: BRAIN, executor: `deck_sub_${taskId}_x`, auditor: `deck_sub_${taskId}_a`,
    title: `Pair ${taskId}`, status: 'working', flags: [], flagSides: {}, round: 0, blocking: ['P0'],
    previousAuditors: [], createdAt: 1, updatedAt: 1_000 + clock, brief: BRIEF(taskId), executorPool: 'primary',
    ...over,
  } as never, { liveness: { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 1_000, progressAuditorAt: 1_000 } as never });
}

interface Daemon {
  registry: SupervisionConsoleSessionRegistry;
  producer: SupervisionConsoleProducer;
  /** Frames the daemon pushed, in order (already JSON round-tripped, as on the wire). */
  frames: any[];
  bytes: () => number;
  connect(): { socket: SupervisionTaskConsoleSocket };
}

function newDaemon(): Daemon {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE supervision_tasks (task_id TEXT PRIMARY KEY, top_level_task_id TEXT NOT NULL,
      classification TEXT NOT NULL, status TEXT NOT NULL, current_revision TEXT, commit_sha TEXT,
      push_remote_ref TEXT, blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL);
    CREATE TABLE supervision_task_assignments (assignment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL, session_name TEXT NOT NULL, session_instance_id TEXT NOT NULL,
      runtime_epoch TEXT NOT NULL, agent_type TEXT NOT NULL, provider_family TEXT NOT NULL,
      lease_id TEXT NOT NULL, generation INTEGER NOT NULL, audit_attempt_id TEXT, audit_revision TEXT,
      verdict TEXT, blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE supervision_task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      assignment_id TEXT, event_type TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL);
  `);
  migrateSupervisionStore(db as unknown as SupervisionMigrationDb);
  const handlers = new Set<(message: unknown) => void>();
  const frames: any[] = [];
  let total = 0;
  let registry!: SupervisionConsoleSessionRegistry;
  const producer = new SupervisionConsoleProducer(db as unknown as SupervisionMigrationDb, {
    projectionEpoch: EPOCH, now: () => 5_000, snapshotCacheTtlMs: 0,
    broadcast: (frame) => registry.broadcast(frame),
  });
  registry = new SupervisionConsoleSessionRegistry({
    producer, authorize: () => true, now: () => 5_000,
    send: (frame) => {
      const wire = JSON.stringify(frame);
      total += wire.length;
      const parsed = JSON.parse(wire);
      frames.push(parsed);
      for (const handler of handlers) handler(parsed);
    },
  });
  return {
    registry, producer, frames, bytes: () => total,
    connect: () => ({
      socket: {
        send: (message: object) => { registry.handleFrame(JSON.parse(JSON.stringify(message))); },
        onMessage: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
      },
    }),
  };
}

/** A connected viewer: the real controller subscribed through the real registry. */
function viewer(daemon: Daemon): SupervisionTaskConsoleController {
  const controller = new SupervisionTaskConsoleController(daemon.connect().socket, SCOPE);
  controller.start();
  controller.setConnected(true);
  return controller;
}

const visible = (state: SupervisionTaskConsoleReducerState) => JSON.stringify({
  tasks: Object.values(state.tasks),
  assignments: Object.values(state.assignments),
  panel: taskConsoleStateToPairSnapshot(state),
});

beforeEach(() => {
  process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
  clock = 0;
  clearAllSupervisionTaskConsoleCaches();
  resetTaskPairBriefStoreForTests();
});

afterEach(() => {
  cleanup();
  setTaskPairStoreForTests(undefined);
  if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
  else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  vi.useRealTimers();
});

describe('delta-merged view == full snapshot view (counter-example)', () => {
  it('after every step of a mixed scenario, a delta viewer displays byte-for-byte what a fresh snapshot viewer does', () => {
    const store = newStore();
    setTaskPairStoreForTests(store);
    for (let i = 0; i < 12; i += 1) save(store, `p${i}`, { status: i % 3 === 0 ? 'done' : 'working' });
    save(store, 'q1', { status: 'queued', executor: undefined, auditor: undefined });
    save(store, 'q2', { status: 'queued', executor: undefined, auditor: undefined });
    save(store, 'q3', { status: 'queued', executor: undefined, auditor: undefined, urgent: true });

    const daemon = newDaemon();
    const delta = viewer(daemon);
    expect(delta.getState().pairRevision).toBe(0);

    const steps: Array<[string, () => string[]]> = [
      ['status change', () => { save(store, 'p1', { status: 'in_audit', round: 1 }); return ['p1']; }],
      ['brief checklist tick', () => { save(store, 'p2', { brief: BRIEF('p2').replace('[ ][ ] Audit', '[x][x] Audit') }); return ['p2']; }],
      ['queue head starts (siblings move)', () => { save(store, 'q3', { status: 'working', executor: 'deck_sub_q3_x', auditor: 'deck_sub_q3_a' }); return ['q3']; }],
      ['new pair', () => { save(store, 'p99'); return ['p99']; }],
      ['terminal pair reopened and older pair touched', () => { save(store, 'p0', { status: 'working' }); save(store, 'p5', { round: 2 }); return ['p0', 'p5']; }],
      ['participant swap (assignments change)', () => { save(store, 'p3', { executor: 'deck_sub_new_x' }); return ['p3']; }],
      ['auditor removed', () => { save(store, 'p4', { auditor: undefined }); return ['p4']; }],
      ['no-op activity refresh', () => ['p1']],
    ];
    const revisions: number[] = [];
    for (const [label, mutate] of steps) {
      const ids = mutate();
      daemon.registry.pairsChanged(PROJECT, ids, 'task_pair_changed');
      const reference = newDaemon();
      const fresh = viewer(reference);
      expect(fresh.getState().phase, label).toBe(SUPERVISION_TASK_CONSOLE_PHASE.READY);
      expect(visible(delta.getState()), label).toBe(visible(fresh.getState()));
      revisions.push(delta.getState().pairRevision!);
      fresh.stop();
    }
    // Each visible step (even one that touched two pairs) is exactly one revision; the no-op step burned none.
    expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7, 7]);
    expect(daemon.frames.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED)).toHaveLength(0);
    expect(daemon.frames.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT)).toHaveLength(1);
    delta.stop();
  });

  it('the compact panel renders identical rows and order from deltas as from a fresh snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    const store = newStore();
    setTaskPairStoreForTests(store);
    for (let i = 0; i < 6; i += 1) save(store, `p${i}`);
    const daemon = newDaemon();
    const delta = viewer(daemon);
    save(store, 'p2', { status: 'in_audit' });
    save(store, 'p0', { status: 'rework', round: 1 });
    daemon.registry.pairsChanged(PROJECT, ['p2', 'p0'], 'task_pair_changed');

    // The controller republishes the merged list to the panel like a snapshot.
    const published = (window as any).__imcodesTaskPairSnapshot;
    expect(published.type).toBe(SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT);
    const fromDelta = render(<TaskPairStatusPanel events={[]} serverId="delta" />);
    const deltaHtml = fromDelta.container.innerHTML;
    fromDelta.unmount();

    delete (window as any).__imcodesTaskPairSnapshot;
    const reference = newDaemon();
    const fresh = viewer(reference);
    const fromSnapshot = render(<TaskPairStatusPanel events={[]} serverId="fresh" />);
    expect(deltaHtml.length).toBeGreaterThan(0);
    expect(fromSnapshot.container.innerHTML).toBe(deltaHtml);
    delta.stop(); fresh.stop();
  });

  it('a reconnect (new subscription) delivers a full snapshot that replaces the merged view', () => {
    const store = newStore();
    setTaskPairStoreForTests(store);
    for (let i = 0; i < 4; i += 1) save(store, `p${i}`);
    const daemon = newDaemon();
    const delta = viewer(daemon);
    save(store, 'p1', { round: 1 });
    daemon.registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
    // Changed while the viewer could not hear it (no pairsChanged call at all).
    save(store, 'p3', { status: 'done' });
    save(store, 'brand-new');
    delta.setConnected(false);
    delta.setConnected(true);
    const reference = newDaemon();
    const fresh = viewer(reference);
    expect(delta.getState().pairRevision).toBe(0);
    expect(visible(delta.getState())).toBe(visible(fresh.getState()));
    expect(Object.keys(delta.getState().tasks)).toContain('brand-new');
    delta.stop(); fresh.stop();
  });
});

describe('reducer: pair_delta_received', () => {
  const stateWithSnapshot = (): { state: SupervisionTaskConsoleReducerState; frames: any[]; store: TaskPairStore; daemon: Daemon } => {
    const store = newStore();
    setTaskPairStoreForTests(store);
    save(store, 'a'); save(store, 'b');
    const daemon = newDaemon();
    const controller = viewer(daemon);
    const state = controller.getState();
    controller.stop();
    return { state, frames: daemon.frames, store, daemon };
  };
  const deltaFor = (store: TaskPairStore, daemon: Daemon, id: string, over: Record<string, unknown>) => {
    const before = daemon.frames.length;
    save(store, id, over);
    daemon.registry.pairsChanged(PROJECT, [id], 'task_pair_changed');
    return daemon.frames.slice(before).find((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA);
  };

  it('applies the next revision, ignores a duplicate, and asks for a resync on a gap', () => {
    const { state, store, daemon } = stateWithSnapshot();
    const controller = viewer(daemon); // subscription 2 owns the daemon's view now
    const live = controller.getState();
    const first = deltaFor(store, daemon, 'a', { round: 1 });
    const second = deltaFor(store, daemon, 'a', { round: 2 });
    expect([first.pairRevision, second.pairRevision]).toEqual([1, 2]);
    let next = live;
    next = supervisionTaskConsoleReducer(next, { type: 'pair_delta_received', payload: first });
    expect(next.pairRevision).toBe(1);
    expect(next.tasks.a!.pair!.round).toBe(1);
    // duplicate of an applied revision
    expect(supervisionTaskConsoleReducer(next, { type: 'pair_delta_received', payload: first })).toBe(next);
    // gap: a third revision arrives without the second
    const third = { ...second, pairRevision: 3 };
    const gapped = supervisionTaskConsoleReducer(next, { type: 'pair_delta_received', payload: third });
    expect(gapped.resyncGeneration).toBe(next.resyncGeneration + 1);
    expect(gapped.resyncReason).toBe('version_gap');
    expect(gapped.tasks).toBe(next.tasks);
    void state;
    controller.stop();
  });

  it('ignores a delta stamped for a superseded subscription and one that arrives before its snapshot', () => {
    const { store, daemon } = stateWithSnapshot();
    const controller = viewer(daemon);
    const live = controller.getState();
    const frame = deltaFor(store, daemon, 'b', { round: 1 });
    expect(supervisionTaskConsoleReducer(live, { type: 'pair_delta_received', payload: { ...frame, subscriptionId: 'old' } })).toBe(live);
    const syncing = { ...live, syncing: true };
    expect(supervisionTaskConsoleReducer(syncing, { type: 'pair_delta_received', payload: frame })).toBe(syncing);
    controller.stop();
  });

  it('resyncs when the state has no pair revision (legacy snapshot) or the frame is malformed', () => {
    const legacy = { ...createSupervisionTaskConsoleState(SCOPE), subscriptionId: 's', hasAuthoritativeSnapshot: true, phase: SUPERVISION_TASK_CONSOLE_PHASE.READY } as SupervisionTaskConsoleReducerState;
    const frame = { type: SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA, scope: SCOPE, subscriptionId: 's', pairRevision: 1, generatedAt: 1, upserts: [], removes: [] };
    expect(supervisionTaskConsoleReducer(legacy, { type: 'pair_delta_received', payload: frame }).resyncReason).toBe('cursor_unknown');
    const ready = { ...legacy, pairRevision: 0 };
    expect(supervisionTaskConsoleReducer(ready, { type: 'pair_delta_received', payload: { ...frame, pairRevision: 'x' } }).resyncReason).toBe('cursor_unknown');
    expect(supervisionTaskConsoleReducer(ready, { type: 'pair_delta_received', payload: { ...frame, upserts: [{ position: 0, task: { taskId: 't' }, assignments: [] }] } }).resyncReason).toBe('cursor_unknown');
  });

  it('keeps an unknown lifecycle status on the neutral bucket instead of rejecting the delta', () => {
    const { store, daemon } = stateWithSnapshot();
    const controller = viewer(daemon);
    const live = controller.getState();
    const frame = deltaFor(store, daemon, 'a', { round: 1 });
    frame.upserts[0].task.status = 'brand_new_status';
    const next = supervisionTaskConsoleReducer(live, { type: 'pair_delta_received', payload: frame });
    expect(next.resyncGeneration).toBe(live.resyncGeneration);
    expect(next.tasks.a).toMatchObject({ status: 'planned', unknownStatus: 'brand_new_status' });
    controller.stop();
  });
});

describe('controller wiring', () => {
  it('declares PAIR_DELTA_V1 on subscribe and answers brief requests through the newest subscription only', () => {
    const store = newStore();
    setTaskPairStoreForTests(store);
    save(store, 'a');
    const sent: any[] = [];
    const handlers = new Set<(message: unknown) => void>();
    const socket: SupervisionTaskConsoleSocket = {
      send: (message) => { sent.push(message); },
      onMessage: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    };
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    const subscribe = sent.find((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    expect(subscribe.features).toEqual([SUPERVISION_TASK_CONSOLE_FEATURES.PAIR_DELTA_V1]);
    expect(subscribe.schemaVersion).toBe(SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION);
    expect(subscribe.statusContractVersion).toBe(SUPERVISION_TASK_STATUS_CONTRACT_VERSION);

    requestTaskPairBrief('a', 'rev-1');
    expect(sent.at(-1)).toEqual({
      type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_REQUEST, subscriptionId: subscribe.subscriptionId, scope: SCOPE, taskId: 'a',
    });
    const emit = (message: unknown) => { for (const handler of handlers) handler(message); };
    // A response for another subscription is dropped; the right one lands in the store by revision.
    emit({ type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_RESPONSE, scope: SCOPE, subscriptionId: 'other', taskId: 'a', briefRevision: 'rev-1', brief: 'wrong' });
    expect(getCachedTaskPairBrief('rev-1')).toBeUndefined();
    emit({ type: SUPERVISION_TASK_CONSOLE_MSG.BRIEF_RESPONSE, scope: SCOPE, subscriptionId: subscribe.subscriptionId, taskId: 'a', briefRevision: 'rev-1', brief: 'the brief' });
    expect(getCachedTaskPairBrief('rev-1')).toBe('the brief');
    controller.stop();
  });

  it('a pair delta reaches the compact panel as the whole merged list, in snapshot order', () => {
    const store = newStore();
    setTaskPairStoreForTests(store);
    for (const id of ['a', 'b', 'c']) save(store, id);
    const daemon = newDaemon();
    const controller = viewer(daemon);
    const events: any[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener('supervision:task-pairs', listener);
    save(store, 'a', { round: 1 });
    daemon.registry.pairsChanged(PROJECT, ['a'], 'task_pair_changed');
    window.removeEventListener('supervision:task-pairs', listener);
    expect(events).toHaveLength(1);
    expect(events[0].tasks.map((task: any) => task.taskId)).toEqual(['a', 'c', 'b']);
    expect(events[0].tasks[0].pair.round).toBe(1);
    controller.stop();
  });

  it('a pair change never triggers a re-subscribe on a delta viewer (one subscribe, one snapshot)', () => {
    const store = newStore();
    setTaskPairStoreForTests(store);
    save(store, 'a');
    const daemon = newDaemon();
    const controller = viewer(daemon);
    for (let round = 1; round <= 5; round += 1) {
      save(store, 'a', { round });
      daemon.registry.pairsChanged(PROJECT, ['a'], 'task_pair_changed');
    }
    expect(daemon.frames.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT)).toHaveLength(1);
    expect(daemon.frames.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.PAIR_DELTA)).toHaveLength(5);
    expect(controller.getState().tasks.a!.pair!.round).toBe(5);
    controller.stop();
  });
});

describe('task-pair brief store (content-addressed by revision)', () => {
  it('caches by revision, dedupes in-flight requests and fails visibly when unanswered', () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const unregister = setTaskPairBriefRequester((taskId) => requests.push(taskId));
    requestTaskPairBrief('t1', 'r1');
    requestTaskPairBrief('t1', 'r1');
    expect(requests).toEqual(['t1']);
    expect(taskPairBriefStatus('r1')).toBe('loading');
    receiveTaskPairBrief('t1', 'r1', 'text');
    expect(taskPairBriefStatus('r1')).toBe('cached');
    requestTaskPairBrief('t1', 'r1'); // cached: no new request
    expect(requests).toEqual(['t1']);
    // A different task with the same revision is served from the same entry.
    requestTaskPairBrief('t2', 'r1');
    expect(requests).toEqual(['t1']);
    // Unanswered => failed after the timeout, and a retry sends a fresh request.
    requestTaskPairBrief('t3', 'r3');
    vi.advanceTimersByTime(TASK_PAIR_BRIEF_REQUEST_TIMEOUT_MS + 1);
    expect(taskPairBriefStatus('r3')).toBe('failed');
    requestTaskPairBrief('t3', 'r3');
    expect(requests).toEqual(['t1', 't3', 't3']);
    // "no brief" answer for the pending revision => failed, not stuck loading.
    receiveTaskPairBrief('t3', null, null);
    expect(taskPairBriefStatus('r3')).toBe('failed');
    unregister();
    requestTaskPairBrief('t4', 'r4'); // nobody to ask
    expect(taskPairBriefStatus('r4')).toBe('failed');
  });
});

describe('TaskPairBrief (lazy)', () => {
  const counts = { total: 2, implemented: 1, audited: 0 };

  it('shows the checklist counts from the row without any text, fetches on expand and renders the fetched brief', async () => {
    const requests: string[] = [];
    setTaskPairBriefRequester((taskId) => requests.push(taskId));
    const view = render(<TaskPairBrief taskId="t1" briefRevision="rev-a" checklist={counts} />);
    expect(view.container.querySelector('.task-pair-brief-checklist-summary')?.textContent).toContain('taskPair.implemented: 1/2');
    expect(requests).toEqual([]); // collapsed: nothing fetched
    fireEvent.click(screen.getByRole('button', { name: 'taskPair.brief_expand' }));
    expect(requests).toEqual(['t1']);
    expect(view.container.querySelector('.task-pair-brief-content')?.textContent).toContain('taskPair.brief_loading');
    receiveTaskPairBrief('t1', 'rev-a', BRIEF('t1'));
    await waitFor(() => expect(view.container.querySelector('.task-pair-brief-content')?.textContent).toContain('Details matter for t1.'));
    expect(view.container.querySelector('.task-pair-brief-content')?.textContent).toContain('Implement t1');
    expect(view.container.querySelectorAll('.task-pair-brief-checklist-row')).toHaveLength(2);
    // Collapse/expand again: served from cache, no second request.
    fireEvent.click(screen.getByRole('button', { name: 'taskPair.brief_collapse' }));
    fireEvent.click(screen.getByRole('button', { name: 'taskPair.brief_expand' }));
    expect(requests).toEqual(['t1']);
  });

  it('renders exactly what the inline (legacy) brief renders once the text is fetched', async () => {
    setTaskPairBriefRequester(() => {});
    const inline = render(<TaskPairBrief taskId="t1" brief={BRIEF('t1')} defaultOpen />);
    const inlineHtml = inline.container.querySelector('.task-pair-brief')!.innerHTML;
    inline.unmount();
    receiveTaskPairBrief('t1', 'rev-a', BRIEF('t1'));
    const lazy = render(<TaskPairBrief taskId="t1" briefRevision="rev-a" checklist={{ total: 2, implemented: 1, audited: 0 }} defaultOpen />);
    await waitFor(() => expect(lazy.container.querySelector('.task-pair-brief-content')?.textContent).toContain('Details matter'));
    expect(lazy.container.querySelector('.task-pair-brief')!.innerHTML).toBe(inlineHtml);
  });

  it('copies after fetching when the copy button is used before the text arrived', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
    const requests: string[] = [];
    setTaskPairBriefRequester((taskId) => requests.push(taskId));
    render(<TaskPairBrief taskId="t9" briefRevision="rev-z" checklist={counts} />);
    fireEvent.click(screen.getByRole('button', { name: 'taskPair.brief_copy' }));
    expect(requests).toEqual(['t9']);
    expect(written).toEqual([]);
    receiveTaskPairBrief('t9', 'rev-z', BRIEF('t9'));
    await waitFor(() => expect(written).toEqual([BRIEF('t9').trim()]));
  });

  it('says so when the brief cannot be fetched, and retries on the next expand', async () => {
    const requests: string[] = [];
    setTaskPairBriefRequester((taskId) => requests.push(taskId));
    const view = render(<TaskPairBrief taskId="t5" briefRevision="rev-5" checklist={counts} />);
    fireEvent.click(screen.getByRole('button', { name: 'taskPair.brief_expand' }));
    receiveTaskPairBrief('t5', null, null);
    await waitFor(() => expect(view.container.querySelector('.task-pair-brief-content')?.textContent).toContain('taskPair.brief_unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'taskPair.brief_collapse' }));
    fireEvent.click(screen.getByRole('button', { name: 'taskPair.brief_expand' }));
    expect(requests).toEqual(['t5', 't5']);
  });

  it('renders nothing for a pair that has neither text nor a revision', () => {
    const view = render(<TaskPairBrief taskId="none" />);
    expect(view.container.innerHTML).toBe('');
  });
});

describe('TaskPairStatusPanel with revision-only briefs', () => {
  it('opens the default-expanded brief of an active pair through a fetch', async () => {
    const requests: string[] = [];
    setTaskPairBriefRequester((taskId) => requests.push(taskId));
    (window as any).__imcodesTaskPairSnapshot = {
      tasks: [{ taskId: 'mine', title: 'Mine', pair: { status: 'working', executor: 'sub-window', updatedAt: 1, briefRevision: 'rev-m', checklist: { total: 1, implemented: 1, audited: 0 } } }],
      assignments: [],
    };
    const view = render(<TaskPairStatusPanel events={[]} serverId="lazy-panel" scopeSessionId="sub-window" />);
    expect(view.container.querySelector('.task-pair-brief-checklist-summary')?.textContent).toContain('taskPair.implemented: 1/1');
    await waitFor(() => expect(requests).toEqual(['mine']));
    receiveTaskPairBrief('mine', 'rev-m', '- [x][ ] Mine it');
    await waitFor(() => expect(view.container.querySelector('.task-pair-brief-content')?.textContent).toContain('Mine it'));
    delete (window as any).__imcodesTaskPairSnapshot;
  });
});
