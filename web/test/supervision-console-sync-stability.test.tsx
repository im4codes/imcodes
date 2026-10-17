/**
 * @vitest-environment jsdom
 *
 * tsk_58c8fb1b73, web side: the "task status" panel kept showing pairs that the
 * daemon had cancelled ("running 29 days") until the page was reloaded.
 *
 * Root causes pinned here (each test says which):
 *  - a legacy-registry DELTA replaced a cancelled pair row with the legacy
 *    `delegated` row of the SAME id (the registry still holds the task the pair
 *    was imported from);
 *  - the compact panel's bridge and the full console each owned a controller,
 *    i.e. two subscriptions, and the daemon honours only the newest;
 *  - an unanswered subscribe dead-ended in a stale state that needed a click;
 *  - accepted panel rows were MERGED into the old ones, so a field the daemon
 *    stopped sending (running state, queue position) never went away.
 */
import { cleanup, render, screen, waitFor, act } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  }),
}));

import { TaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import {
  SUPERVISION_TASK_CONSOLE_MSG,
  type SupervisionTaskConsoleDelta,
  type SupervisionTaskConsoleScope,
} from '../../shared/supervision-task-console.js';
import {
  SUPERVISION_TASK_CONSOLE_SUBSCRIBE_TIMEOUT_MS,
  SUPERVISION_TASK_CONSOLE_TIMEOUT_RETRY_DELAY_MS,
  SupervisionTaskConsoleController,
  supervisionTaskConsolePageClientId,
  type SupervisionTaskConsoleSocket,
} from '../src/supervision-task-console-controller.js';
import { SUPERVISION_TASK_CONSOLE_PHASE, supervisionTaskConsoleReducer } from '../src/supervision-task-console-reducer.js';
import { clearAllSupervisionTaskConsoleCaches } from '../src/supervision-task-console-cache.js';
import { taskConsoleStateToPairSnapshot } from '../src/components/SupervisionTaskConsole.js';
import { TaskPairStatusPanel } from '../src/components/TaskPairStatusPanel.js';
import { useSupervisionTaskConsole } from '../src/hooks/useSupervisionTaskConsole.js';
import { resetTaskPairBriefStoreForTests } from '../src/task-pair-brief-store.js';
import { createPairConsoleDaemon, type PairConsoleDaemon } from './helpers/pair-console-daemon.js';

const PROJECT = 'cd';
const BRAIN = 'deck_cd_brain';
const SCOPE: SupervisionTaskConsoleScope = { projectName: PROJECT, coordinatorSessionName: BRAIN };
const EPOCH = 'epoch-1';
const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;

let store: TaskPairStore;
let clock = 0;

function save(taskId: string, over: Record<string, unknown> = {}) {
  clock += 1;
  return store.savePair(PROJECT, {
    taskId, brain: BRAIN, executor: `deck_sub_${taskId}_x`, auditor: `deck_sub_${taskId}_a`,
    title: `Pair ${taskId}`, status: 'working', flags: [], flagSides: {}, round: 0, blocking: ['P0'],
    previousAuditors: [], createdAt: 1, updatedAt: 1_000 + clock, brief: '# brief', executorPool: 'primary',
    ...over,
  } as never, { liveness: { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 1_000, progressAuditorAt: 1_000 } as never });
}

function seedLegacyEvent(daemon: PairConsoleDaemon, taskId: string): void {
  daemon.db.prepare(`INSERT OR IGNORE INTO supervision_tasks (task_id, project_name, top_level_task_id, classification, status,
    payload_json, created_at, updated_at) VALUES (?, ?, ?, 'integration_slice', 'delegated', '{}', 1, 1)`).run(taskId, PROJECT, taskId);
  daemon.db.prepare(`INSERT INTO supervision_task_events (task_id, assignment_id, event_type, status, payload_json, created_at)
    VALUES (?, NULL, 'delegated', 'delegated', '{}', 5)`).run(taskId);
}

/** What an OLDER daemon (no suppression) would send: the legacy frames its outbox holds, stamped for a viewer. */
function legacyFramesFor(daemon: PairConsoleDaemon, subscriptionId: string): SupervisionTaskConsoleDelta[] {
  daemon.producer.synchronizeDurableEvents(SCOPE, { deliver: false });
  return daemon.producer.pendingFrames(SCOPE).map((row) => ({ ...row.frame, subscriptionId }));
}

function viewer(daemon: PairConsoleDaemon): SupervisionTaskConsoleController {
  const controller = new SupervisionTaskConsoleController(daemon.connect().socket, SCOPE);
  controller.start();
  controller.setConnected(true);
  return controller;
}

class FakeSocket implements SupervisionTaskConsoleSocket {
  sent: any[] = [];
  private handlers = new Set<(message: unknown) => void>();
  send(message: object): void { this.sent.push(message); }
  onMessage(handler: (message: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
  emit(message: unknown): void { for (const handler of [...this.handlers]) handler(message); }
  ofType(type: string): any[] { return this.sent.filter((frame) => frame.type === type); }
}

beforeEach(() => {
  process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
  clock = 0;
  store = new TaskPairStore(':memory:');
  setTaskPairStoreForTests(store);
  clearAllSupervisionTaskConsoleCaches();
  resetTaskPairBriefStoreForTests();
});

afterEach(() => {
  cleanup();
  setTaskPairStoreForTests(undefined);
  if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
  else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
  vi.useRealTimers();
  delete (window as any).__imcodesTaskPairSnapshot;
});

describe('the cancelled pairs that stayed "running" after a daemon restart', () => {
  it('end to end: legacy events re-appended at every daemon start never reach the viewer', () => {
    save('tsk_5', { status: 'cancelled' });
    save('tsk_b', { status: 'cancelled' });
    save('live');
    const daemon = createPairConsoleDaemon({ epoch: EPOCH });
    const controller = viewer(daemon);
    expect(Object.keys(controller.getState().tasks).sort()).toEqual(['live', 'tsk_5', 'tsk_b']);

    // "daemon restart": the legacy registry appends `delegated` for both tasks again.
    seedLegacyEvent(daemon, 'tsk_5');
    seedLegacyEvent(daemon, 'tsk_b');
    daemon.registry.refreshActiveSubscriptions();

    const state = controller.getState();
    expect(state.tasks.tsk_5?.pair?.status).toBe('cancelled');
    expect(state.tasks.tsk_b?.pair?.status).toBe('cancelled');
    expect(taskConsoleStateToPairSnapshot(state).tasks.map((task) => task.taskId)).toEqual(['live']);
    expect(daemon.frames.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.DELTA)).toEqual([]);
    controller.stop();
  });

  it('an older daemon that still sends those legacy deltas cannot overwrite pair rows either (version skew)', () => {
    save('tsk_5', { status: 'cancelled' });
    save('live');
    const daemon = createPairConsoleDaemon({ epoch: EPOCH });
    const socket = daemon.connect().socket;
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    const before = controller.getState();
    expect(before.pairProjection).toBe(true);

    seedLegacyEvent(daemon, 'tsk_5');
    seedLegacyEvent(daemon, 'tsk_b');
    const frames = legacyFramesFor(daemon, before.subscriptionId!);
    expect(frames.length).toBe(2);
    let state = before;
    for (const frame of frames) state = supervisionTaskConsoleReducer(state, { type: 'delta_received', payload: JSON.parse(JSON.stringify(frame)) });

    expect(state.tasks.tsk_5?.pair?.status).toBe('cancelled');
    expect(state.tasks.tsk_b).toBeUndefined();
    expect(state.phase).toBe(SUPERVISION_TASK_CONSOLE_PHASE.READY);
    // The cursor kept moving densely, so no resync was triggered and later frames still apply.
    expect(state.projectionVersion).toBe(frames.at(-1)!.projectionVersion);
    expect(state.lastDurableEventId).toBe(frames.at(-1)!.lastDurableEventId);
    expect(state.resyncGeneration).toBe(before.resyncGeneration);
    controller.stop();
  });

  it('legacy rows still apply on a project that is not a pairs projection (unchanged behaviour)', () => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'legacy';
    const daemon = createPairConsoleDaemon({ epoch: EPOCH });
    seedLegacyEvent(daemon, 'tsk_5');
    const controller = viewer(daemon);
    expect(controller.getState().pairProjection).toBe(false);
    seedLegacyEvent(daemon, 'tsk_5');
    daemon.registry.refreshActiveSubscriptions();
    expect(controller.getState().tasks.tsk_5?.status).toBe('delegated');
    expect(daemon.frames.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.DELTA)).toHaveLength(1);
    controller.stop();
  });

  it('the controller no longer pushes raw frames at the compact panel (the bridge is the only publisher)', () => {
    save('a');
    const daemon = createPairConsoleDaemon({ epoch: EPOCH });
    const events: unknown[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener('supervision:task-pairs', listener);
    const controller = viewer(daemon);
    save('a', { round: 1 });
    daemon.registry.pairsChanged(PROJECT, ['a'], 'task_pair_changed');
    window.removeEventListener('supervision:task-pairs', listener);
    expect(events).toEqual([]);
    expect((window as any).__imcodesTaskPairSnapshot).toBeUndefined();
    controller.stop();
  });
});

describe('one subscription per page and scope, however many views are open', () => {
  function Probe(props: { ws: any; connected: boolean; onState?: (state: any) => void }) {
    const { state } = useSupervisionTaskConsole({
      ws: props.ws, connected: props.connected, userId: 'user-1', serverId: 'server-1', scope: SCOPE,
    });
    props.onState?.(state);
    return <div data-testid="probe">{Object.keys(state.tasks).join(',')}</div>;
  }

  function fakeWs() {
    const socket = new FakeSocket();
    return {
      socket,
      ws: {
        send: (message: object) => socket.send(message),
        onMessage: (handler: (message: unknown) => void) => socket.onMessage(handler),
      },
    };
  }

  it('the panel bridge and the full console share ONE controller: one SUBSCRIBE, and closing one view keeps the other live', async () => {
    const daemon = createPairConsoleDaemon({ epoch: EPOCH });
    save('a');
    const real = daemon.connect().socket;
    const sent: any[] = [];
    const ws = {
      send: (message: any) => { sent.push(message); real.send(message); },
      onMessage: (handler: (message: unknown) => void) => real.onMessage(handler),
    };
    const states: Record<string, any> = {};
    const bridge = render(<Probe ws={ws} connected onState={(state) => { states.bridge = state; }} />);
    const consoleView = render(<Probe ws={ws} connected onState={(state) => { states.console = state; }} />);
    await waitFor(() => expect(states.bridge.hasAuthoritativeSnapshot).toBe(true));
    expect(sent.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE)).toHaveLength(1);
    expect(states.console.subscriptionId).toBe(states.bridge.subscriptionId);

    // The full console is closed: the compact panel must keep receiving updates.
    consoleView.unmount();
    expect(sent.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE)).toHaveLength(0);
    save('a', { round: 3 });
    act(() => { daemon.registry.pairsChanged(PROJECT, ['a'], 'task_pair_changed'); });
    await waitFor(() => expect(states.bridge.tasks.a.pair.round).toBe(3));

    // The last view leaves: only now is the scope unsubscribed.
    bridge.unmount();
    expect(sent.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE)).toHaveLength(1);
  });

  it('every SUBSCRIBE of a page carries the same clientId, so other tabs keep their own subscription', () => {
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    const a = new SupervisionTaskConsoleController(socketA, SCOPE);
    const b = new SupervisionTaskConsoleController(socketB, { projectName: 'other', coordinatorSessionName: 'deck_other_brain' });
    for (const controller of [a, b]) { controller.start(); controller.setConnected(true); }
    const idA = socketA.ofType(SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE)[0].clientId;
    const idB = socketB.ofType(SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE)[0].clientId;
    expect(typeof idA).toBe('string');
    expect(idA).toBe(idB);
    expect(idA).toBe(supervisionTaskConsolePageClientId());
    a.retry();
    expect(socketA.ofType(SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE).at(-1).clientId).toBe(idA);
    a.stop(); b.stop();
  });

  it('the connected flag is the OR of its views, so one view going offline does not disconnect the other', () => {
    const { ws, socket } = fakeWs();
    const first = render(<Probe ws={ws} connected />);
    const second = render(<Probe ws={ws} connected={false} />);
    expect(socket.ofType(SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE)).toHaveLength(1);
    second.rerender(<Probe ws={ws} connected />);
    second.unmount();
    expect(socket.ofType(SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE)).toHaveLength(0);
    first.unmount();
    expect(socket.ofType(SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE)).toHaveLength(1);
  });
});

describe('a lost subscribe recovers by itself', () => {
  it('an unanswered subscribe is retried after the stale state is shown, on the bounded resync budget', () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    expect(socket.ofType(SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE)).toHaveLength(1);

    vi.advanceTimersByTime(SUPERVISION_TASK_CONSOLE_SUBSCRIBE_TIMEOUT_MS);
    // The retryable error is visible first ...
    expect(controller.getState()).toMatchObject({ phase: SUPERVISION_TASK_CONSOLE_PHASE.ERROR, error: 'subscription_timeout' });
    expect(socket.ofType(SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE)).toHaveLength(1);
    // ... then the console asks again without any click.
    vi.advanceTimersByTime(SUPERVISION_TASK_CONSOLE_TIMEOUT_RETRY_DELAY_MS);
    const subscribes = socket.ofType(SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE);
    expect(subscribes).toHaveLength(2);
    expect(subscribes[1].afterEventId).toBeNull();
    expect(subscribes[1].subscriptionId).not.toBe(subscribes[0].subscriptionId);
    controller.stop();
  });

  it('gives up after the cap instead of looping forever against a daemon that never answers', () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const controller = new SupervisionTaskConsoleController(socket, SCOPE);
    controller.start();
    controller.setConnected(true);
    for (let i = 0; i < 40; i += 1) vi.advanceTimersByTime(SUPERVISION_TASK_CONSOLE_SUBSCRIBE_TIMEOUT_MS + 61_000);
    const count = socket.ofType(SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE).length;
    expect(count).toBeGreaterThan(2);
    expect(count).toBeLessThanOrEqual(8);
    expect(controller.getState().phase).toBe(SUPERVISION_TASK_CONSOLE_PHASE.ERROR);
    controller.stop();
  });
});

describe('the compact panel replaces an accepted row instead of merging it', () => {
  const publish = (detail: unknown) => act(() => { window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail })); });
  const row = (pair: Record<string, unknown>, updatedAt: number) => ({
    tasks: [{ taskId: 'p1', title: 'P1', updatedAt, pair: { createdAt: 1, startedAt: 1, updatedAt, ...pair } }],
    assignments: [],
  });

  it('a participant that stopped running no longer shows the running dot', async () => {
    render(<TaskPairStatusPanel events={[]} />);
    publish(row({ status: 'working', executor: 'deck_sub_x', executorState: 'running' }, 100));
    await waitFor(() => expect(document.querySelector('.task-pair-status-dot.is-running')).toBeTruthy());
    // The daemon's next row carries no executorState (the session went away): it must not linger.
    publish(row({ status: 'working', executor: 'deck_sub_x' }, 200));
    await waitFor(() => expect(document.querySelector('.task-pair-status-dot.is-running')).toBeNull());
  });

  it('a pair that left the queue loses its queue position', async () => {
    render(<TaskPairStatusPanel events={[]} />);
    publish(row({ status: 'queued', queuePosition: 3 }, 100));
    await waitFor(() => expect(screen.getByText(/#3/)).toBeTruthy());
    publish(row({ status: 'working' }, 200));
    await waitFor(() => expect(document.querySelector('[data-status="working"]')).toBeTruthy());
    expect(screen.queryByText(/#3/)).toBeNull();
  });

  it('rows the daemon no longer lists disappear (an authoritative snapshot replaces the list)', async () => {
    render(<TaskPairStatusPanel events={[]} />);
    publish({
      tasks: [
        { taskId: 'gone', title: 'Gone pair', updatedAt: 100, pair: { status: 'working', createdAt: 1, startedAt: 1, updatedAt: 100 } },
        { taskId: 'stays', title: 'Stays pair', updatedAt: 100, pair: { status: 'working', createdAt: 1, startedAt: 1, updatedAt: 100 } },
      ],
      assignments: [],
    });
    await waitFor(() => expect(screen.getByText('Gone pair')).toBeTruthy());
    publish({
      tasks: [{ taskId: 'stays', title: 'Stays pair', updatedAt: 100, pair: { status: 'working', createdAt: 1, startedAt: 1, updatedAt: 100 } }],
      assignments: [],
    });
    await waitFor(() => expect(screen.queryByText('Gone pair')).toBeNull());
    expect(screen.getByText('Stays pair')).toBeTruthy();
  });
});

describe('every state change a user can see reaches the viewer as a delta, identical to a fresh snapshot', () => {
  const rows = (controller: SupervisionTaskConsoleController) => JSON.stringify({
    tasks: Object.values(controller.getState().tasks),
    assignments: Object.values(controller.getState().assignments),
  });

  it('flags, waitingReason, verdicts, rework rounds and terminal states', () => {
    save('p1');
    const daemon = createPairConsoleDaemon({ epoch: EPOCH });
    const delta = viewer(daemon);
    const steps: Array<[string, Record<string, unknown>]> = [
      ['waits for capacity with a reason', { status: 'queued', flags: ['waiting_for_capacity'], capacityWaitReason: 'primary pool full' }],
      ['the reason changes', { status: 'queued', flags: ['waiting_for_capacity'], capacityWaitReason: 'economy pool full' }],
      ['capacity frees up (flag and reason cleared)', { status: 'working', flags: [] }],
      ['blocked', { status: 'working', flags: ['blocked'] }],
      ['needs input', { status: 'working', flags: ['needs_input'] }],
      ['audit starts', { status: 'in_audit', flags: [] }],
      ['REWORK verdict', { status: 'rework', round: 1, lastVerdict: { verb: 'REWORK', counts: { P0: 1, P1: 0, P2: 0, P3: 0, P4: 0 }, judgement: 'rework', round: 1 } }],
      ['PASS verdict', { status: 'passed', round: 1, lastVerdict: { verb: 'PASS', counts: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 }, judgement: 'pass', round: 1 } }],
      ['DONE', { status: 'done', round: 1 }],
    ];
    for (const [label, over] of steps) {
      save('p1', over);
      daemon.registry.pairsChanged(PROJECT, ['p1'], 'task_pair_changed');
      const reference = viewer(createPairConsoleDaemon({ epoch: EPOCH }));
      expect(rows(delta), label).toBe(rows(reference));
      reference.stop();
    }
    const pair = delta.getState().tasks.p1!.pair!;
    expect(pair.status).toBe('done');
    expect(pair.flags).toEqual([]);
    expect('waitingReason' in pair).toBe(false);
    expect(daemon.frames.filter((frame) => frame.type === SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED)).toEqual([]);
    delta.stop();
  });

  it('a pair cancelled while the viewer was subscribed leaves the open-pair list without a reload', () => {
    save('keep');
    save('victim');
    const daemon = createPairConsoleDaemon({ epoch: EPOCH });
    const controller = viewer(daemon);
    expect(taskConsoleStateToPairSnapshot(controller.getState()).tasks.map((task) => task.taskId).sort()).toEqual(['keep', 'victim']);
    save('victim', { status: 'cancelled' });
    daemon.registry.pairsChanged(PROJECT, ['victim'], 'task_pair_changed');
    expect(taskConsoleStateToPairSnapshot(controller.getState()).tasks.map((task) => task.taskId)).toEqual(['keep']);
    controller.stop();
  });
});
