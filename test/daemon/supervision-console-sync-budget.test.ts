/**
 * tsk_cd_send_spinner_console_sync (item 2): the console's durable-event sync
 * must never hold the daemon main thread for more than one small slice.
 *
 *  - a delta costs O(delta), and is BYTE-IDENTICAL to what the full projection
 *    would have produced (visibility, fail-closed status, pool counts);
 *  - the tail query seeks the event rowid range instead of walking the project;
 *  - a backlog drains in time-budgeted slices with a yield between slices;
 *  - re-reading the persisted cursor per slice means a concurrent inline pass
 *    can neither duplicate nor skip an event, and a refresh that arrives while a
 *    drain runs is not lost.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordStall = vi.hoisted(() => vi.fn());
vi.mock('../../src/util/daemon-status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/util/daemon-status.js')>()),
  recordDaemonEventLoopStall: (arg: unknown) => recordStall(arg),
}));
import {
  SUPERVISION_INLINE_SYNC_MAX_EVENTS,
  SUPERVISION_SYNC_SLICE_BUDGET_MS,
  SupervisionConsoleProducer,
} from '../../src/daemon/supervision-console-producer.js';
import {
  migrateSupervisionStore,
  type SupervisionMigrationDb,
} from '../../src/daemon/supervision-store-migrations.js';
import type { SupervisionTaskConsoleDelta } from '../../shared/supervision-task-console.js';
import { TaskPairStore, setTaskPairStoreForTests } from '../../src/daemon/task-pairs/store.js';
import {
  EVENT_LOOP_WATCHDOG_IDLE_PHASE,
  startEventLoopWatchdog,
  stopEventLoopWatchdog,
} from '../../src/daemon/event-loop-watchdog.js';

const SCOPE = { projectName: 'codedeck', coordinatorSessionName: 'deck_cd_brain' };
const EPOCH = 'epoch-budget';

const LEGACY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS supervision_tasks (
    task_id TEXT PRIMARY KEY, top_level_task_id TEXT NOT NULL, classification TEXT NOT NULL,
    status TEXT NOT NULL, current_revision TEXT, commit_sha TEXT, push_remote_ref TEXT,
    blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS supervision_task_assignments (
    assignment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
    session_name TEXT NOT NULL, session_instance_id TEXT NOT NULL, runtime_epoch TEXT NOT NULL,
    agent_type TEXT NOT NULL, provider_family TEXT NOT NULL, lease_id TEXT NOT NULL,
    generation INTEGER NOT NULL, audit_attempt_id TEXT, audit_revision TEXT, verdict TEXT,
    blocker TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS supervision_task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, assignment_id TEXT,
    event_type TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL);
`;

let db: DatabaseSync;
let sent: SupervisionTaskConsoleDelta[];
let clock: number;

const asDb = () => db as unknown as SupervisionMigrationDb;

function makeProducer(over: Partial<ConstructorParameters<typeof SupervisionConsoleProducer>[1]> = {}) {
  return new SupervisionConsoleProducer(asDb(), {
    projectionEpoch: EPOCH,
    now: () => ++clock,
    broadcast: (frame) => { sent.push(frame); },
    snapshotCacheTtlMs: 0,
    ...over,
  });
}

function insertTask(taskId: string, project = 'codedeck', payload: Record<string, unknown> = {}, status = 'implementing') {
  db.prepare(`INSERT INTO supervision_tasks
    (task_id, project_name, top_level_task_id, classification, status, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, 'slice', ?, ?, 1, 1)`).run(taskId, project, `top_${taskId}`, status, JSON.stringify(payload));
}

function insertAssignment(assignmentId: string, taskId: string, status: string, poolKind: string | null, opts: {
  session?: string; lease?: string; heartbeat?: number | null; payload?: Record<string, unknown>;
} = {}) {
  db.prepare(`INSERT INTO supervision_task_assignments
    (assignment_id, task_id, role, status, session_name, session_instance_id, runtime_epoch,
     agent_type, provider_family, lease_id, generation, payload_json, created_at, updated_at, pool_kind, heartbeat_at)
    VALUES (?, ?, 'implementer', ?, ?, 'i', 'e', 'codex', 'openai', ?, 1, ?, 1, 5, ?, ?)`)
    .run(assignmentId, taskId, status, opts.session ?? 'deck_sub_x', opts.lease ?? 'lease-1',
      JSON.stringify(opts.payload ?? {}), poolKind, opts.heartbeat ?? null);
}

function insertEvent(taskId: string, assignmentId: string | null, at = 10) {
  db.prepare(`INSERT INTO supervision_task_events (task_id, assignment_id, event_type, status, payload_json, created_at)
    VALUES (?, ?, 'implementing', 'implementing', '{}', ?)`).run(taskId, assignmentId, at);
}

const outbox = () => db.prepare('SELECT event_id, projection_version FROM supervision_outbox ORDER BY id')
  .all() as Array<{ event_id: number; projection_version: number }>;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(LEGACY_SCHEMA);
  migrateSupervisionStore(asDb());
  sent = [];
  clock = 100;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('O(delta) frames are identical to the full projection', () => {
  it('assignment rows and pool counts match readAssignmentRows/readPools for every kind of assignment', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    insertTask('t_visible');
    insertTask('t_archived', 'codedeck', { archivedAt: 5 });
    insertTask('t_other', 'other-project');
    insertAssignment('a_primary', 't_visible', 'implementing', 'primary', { lease: 'l', heartbeat: 1_799_999_999_000 });
    insertAssignment('a_economy', 't_visible', 'validated', 'economy', { lease: '' });
    insertAssignment('a_no_pool', 't_visible', 'implementing', null);
    insertAssignment('a_weird_pool', 't_visible', 'implementing', 'made-up');
    insertAssignment('a_terminal', 't_visible', 'finalized', 'primary');
    insertAssignment('a_blocked', 't_visible', 'blocked', 'economy');
    insertAssignment('a_bogus_status', 't_visible', 'implementing', 'primary');
    // A durable status outside the contract can only exist if the guard trigger
    // is bypassed (the existing projection test does the same): both paths must fail closed.
    db.exec('DROP TRIGGER IF EXISTS supervision_task_assignments_status_guard_update');
    db.prepare("UPDATE supervision_task_assignments SET status='scope_violation' WHERE assignment_id='a_bogus_status'").run();
    insertAssignment('a_archived_task', 't_archived', 'implementing', 'primary');
    insertAssignment('a_other_project', 't_other', 'implementing', 'primary');
    insertAssignment('a_required', 't_visible', 'implementing', 'primary', { payload: { required: true } });

    const p = makeProducer({
      resolveSessionPresentation: (name, at) => ({ label: `label:${name}`, model: 'm', state: 'running', source: 'runtime', observedAt: at }),
    });
    p.ensureProjectionBaseline(SCOPE);
    const ids = ['a_primary', 'a_economy', 'a_no_pool', 'a_weird_pool', 'a_terminal', 'a_blocked', 'a_bogus_status',
      'a_archived_task', 'a_other_project', 'a_required', 'a_missing'];
    for (const id of ids) insertEvent(id === 'a_archived_task' ? 't_archived' : id === 'a_other_project' ? 't_other' : 't_visible', id);
    // Other-project events are never tailed for this scope.
    expect(p.synchronizeDurableEvents(SCOPE)).toBe(ids.length - 1);

    const legacyRows = p.readAssignmentRows('codedeck');
    const legacyPools = p.readPools('codedeck');
    expect(p.readPoolsIncremental('codedeck')).toEqual(legacyPools);
    for (const frame of sent) {
      expect(frame.pools).toEqual(legacyPools);
      const assignmentId = frame.op === 'assignment_upsert' ? frame.assignment!.assignmentId : frame.removedId;
      const legacy = legacyRows.find((row) => row.assignmentId === assignmentId);
      if (legacy) {
        expect(frame.op).toBe('assignment_upsert');
        expect(frame.assignment).toEqual(legacy);
      } else {
        // hidden (archived task), unknown status, missing row: same as before -> removal
        expect(frame.op).toBe('assignment_remove');
      }
    }
    // Non-vacuous: a_primary + a_required count; the terminal, unknown-pool, unknown-status,
    // archived-task and other-project rows do not.
    expect(legacyPools.find((pool) => pool.poolId === 'primary')?.activeCount).toBe(2);
    expect(legacyPools.find((pool) => pool.poolId === 'economy')?.activeCount).toBe(1);
  });

  it('projects one assignment row once per pass however many events touch it', () => {
    insertTask('t1');
    insertAssignment('a1', 't1', 'implementing', 'primary');
    let presentations = 0;
    const p = makeProducer({
      resolveSessionPresentation: (_n, at) => { presentations += 1; return { state: 'idle', source: 'runtime', observedAt: at }; },
    });
    p.ensureProjectionBaseline(SCOPE);
    for (let i = 0; i < 5; i += 1) insertEvent('t1', 'a1', 10 + i);
    expect(p.synchronizeDurableEvents(SCOPE, { deliver: false })).toBe(5);
    expect(presentations).toBe(1);
  });

  it('does not project unrelated assignments when a delta is built', () => {
    insertTask('t1');
    for (let i = 0; i < 60; i += 1) insertAssignment(`bulk_${i}`, 't1', 'implementing', 'primary', { session: `deck_sub_${i}` });
    let presentations = 0;
    const p = makeProducer({
      resolveSessionPresentation: (_n, at) => { presentations += 1; return { state: 'idle', source: 'runtime', observedAt: at }; },
    });
    p.ensureProjectionBaseline(SCOPE);
    insertEvent('t1', 'bulk_7');
    expect(p.synchronizeDurableEvents(SCOPE, { deliver: false })).toBe(1);
    expect(presentations).toBe(1);
  });
});

describe('pairs-project snapshot pool counts', () => {
  const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
  afterEach(() => {
    if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
    else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
  });

  it('counts pool occupancy without projecting every registry assignment, with identical numbers', () => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    setTaskPairStoreForTests(new TaskPairStore(':memory:'));
    insertTask('t1');
    insertTask('t_archived', 'codedeck', { archivedAt: 5 });
    insertAssignment('p1', 't1', 'implementing', 'primary');
    insertAssignment('p2', 't1', 'validated', 'primary');
    insertAssignment('e1', 't1', 'implementing', 'economy');
    insertAssignment('done', 't1', 'finalized', 'primary');
    insertAssignment('hidden', 't_archived', 'implementing', 'primary');
    for (let i = 0; i < 80; i += 1) insertAssignment(`hist_${i}`, 't1', 'finalized', i % 2 ? 'primary' : 'economy');
    let presentations = 0;
    const p = makeProducer({
      resolveSessionPresentation: (_n, at) => { presentations += 1; return { state: 'idle', source: 'runtime', observedAt: at }; },
    });
    const legacyPools = p.readPools('codedeck');
    presentations = 0;
    const snapshot = p.buildSnapshot(SCOPE, 'sub-pairs');
    expect(snapshot.pools).toEqual(legacyPools);
    expect(snapshot.pools.find((pool) => pool.poolId === 'primary')?.activeCount).toBe(2);
    expect(snapshot.pools.find((pool) => pool.poolId === 'economy')?.activeCount).toBe(1);
    // The pairs snapshot takes its rows from the pair store; the 80+ historical
    // registry assignments must not be projected (live-state resolved) to count pools.
    expect(presentations).toBe(0);
  });
});

describe('durable tail query plan', () => {
  // The bad plan (project index -> every event of the project -> temp b-tree)
  // only appears at production table sizes, so the producer's OWN tail queries
  // are captured and required to pin the loop order with CROSS JOIN; SQLite then
  // guarantees the rowid-range seek asserted below.
  it('every tail query the producer runs pins the event rowid range as the outer loop', () => {
    insertTask('t1');
    const captured: string[] = [];
    const realPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (/supervision_task_events e\b/.test(sql) && /e\.id > \?/.test(sql)) captured.push(sql);
      return realPrepare(sql);
    }) as typeof db.prepare);
    const p = makeProducer();
    p.ensureProjectionBaseline(SCOPE);
    insertEvent('t1', null);
    p.needsYieldedDurableReplay(SCOPE);
    p.synchronizeDurableEvents(SCOPE, { deliver: false });
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const sql of captured) {
      expect(sql).toMatch(/supervision_task_events e\s+CROSS JOIN supervision_tasks t/);
      const plan = (realPrepare(`EXPLAIN QUERY PLAN ${sql}`).all('codedeck', 0, 32) as Array<{ detail: string }>)
        .map((row) => row.detail).join(' | ');
      expect(plan).toMatch(/SEARCH e USING INTEGER PRIMARY KEY \(rowid>\?\)/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
  });

  it('projects only this project\'s events, in id order, from the cursor', () => {
    insertTask('t1');
    insertTask('t_other', 'other-project');
    const p = makeProducer();
    p.ensureProjectionBaseline(SCOPE);
    insertEvent('t1', null, 1);
    insertEvent('t_other', null, 2);
    insertEvent('t1', null, 3);
    expect(p.synchronizeDurableEvents(SCOPE, { deliver: false })).toBe(2);
    expect(outbox().map((row) => row.projection_version)).toEqual([1, 2]);
  });
});

describe('time-budgeted, yielding slices', () => {
  function backlog(events: number) {
    insertTask('t1');
    insertAssignment('a1', 't1', 'implementing', 'primary');
    const p0 = makeProducer();
    p0.ensureProjectionBaseline(SCOPE);
    for (let i = 0; i < events; i += 1) insertEvent('t1', i % 2 === 0 ? 'a1' : null, 10 + i);
  }

  it('commits at most a budget\'s worth of events per slice and yields between slices', async () => {
    backlog(30);
    // Fake monotonic clock: every reading advances 2 ms. Projection deadline =
    // 60% of the 15 ms budget = 9 ms, so a slice stops after ~5 events.
    let t = 0;
    const yields: number[] = [];
    const p = makeProducer({
      monotonicNowMs: () => (t += 2),
      yieldToEventLoop: async () => { yields.push(outbox().length); },
    });
    const committed = await p.synchronizeDurableEventsAsync(SCOPE, { deliver: false });
    expect(committed).toBe(30);
    expect(yields.length).toBeGreaterThanOrEqual(5);
    const perSlice = yields.map((count, index) => count - (index === 0 ? 0 : yields[index - 1]!));
    // Every slice is bounded by the budget (never the full 32-event chunk) ...
    expect(Math.max(...perSlice)).toBeLessThanOrEqual(6);
    expect(Math.max(...perSlice)).toBeGreaterThanOrEqual(1);
    // ... and the drain is complete, dense and in order.
    expect(outbox().map((row) => row.projection_version)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(p.restoreCursor(SCOPE).lastDurableEventId).toBe(30);
  });

  it('always makes progress even when one event alone exceeds the budget', async () => {
    backlog(4);
    let t = 0;
    const p = makeProducer({ monotonicNowMs: () => (t += 1_000), syncSliceBudgetMs: 5 });
    expect(await p.synchronizeDurableEventsAsync(SCOPE, { deliver: false })).toBe(4);
    expect(outbox()).toHaveLength(4);
  });

  it('lets a timer and I/O callback run between slices of a real backlog', async () => {
    backlog(120);
    const p = makeProducer({ syncSliceBudgetMs: 1 });
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);
    const drain = p.synchronizeDurableEventsAsync(SCOPE, { deliver: false }).then(() => order.push('drained'));
    await drain;
    expect(order).toEqual(['timer', 'drained']);
  });

  it('a slice\'s real wall time stays within the budget on a realistic registry', async () => {
    insertTask('t1');
    for (let i = 0; i < 400; i += 1) insertAssignment(`bulk_${i}`, 't1', 'implementing', i % 2 ? 'primary' : 'economy', { session: `deck_sub_${i % 20}` });
    const p0 = makeProducer();
    p0.ensureProjectionBaseline(SCOPE);
    for (let i = 0; i < 300; i += 1) insertEvent('t1', `bulk_${i % 400}`, 10 + i);
    const sliceMs: number[] = [];
    let last = performance.now();
    const p = makeProducer({
      yieldToEventLoop: async () => { const now = performance.now(); sliceMs.push(now - last); last = performance.now(); },
    });
    last = performance.now();
    await p.synchronizeDurableEventsAsync(SCOPE, { deliver: true });
    expect(sliceMs.length).toBeGreaterThan(0);
    // Budget + generous CI headroom for one event overshooting the deadline.
    expect(Math.max(...sliceMs)).toBeLessThan(SUPERVISION_SYNC_SLICE_BUDGET_MS * 4);
  });
});

describe('cursor-exact interleaving', () => {
  it('an inline pass that runs while a drain is yielded neither duplicates nor skips an event', async () => {
    insertTask('t1');
    const p0 = makeProducer();
    p0.ensureProjectionBaseline(SCOPE);
    for (let i = 0; i < 20; i += 1) insertEvent('t1', null, 10 + i);
    let interleaved = false;
    let p!: SupervisionConsoleProducer;
    p = makeProducer({
      monotonicNowMs: (() => { let t = 0; return () => (t += 3); })(),
      yieldToEventLoop: async () => {
        if (interleaved) return;
        interleaved = true;
        insertEvent('t1', null, 99);
        // The live-push path: a small tail is projected inline mid-drain.
        p.synchronizeDurableEvents(SCOPE, { deliver: false });
      },
    });
    await p.synchronizeDurableEventsAsync(SCOPE, { deliver: false });
    const versions = outbox().map((row) => row.projection_version);
    const eventIds = outbox().map((row) => row.event_id);
    expect(versions).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(new Set(eventIds).size).toBe(21);
    expect(eventIds).toEqual([...eventIds].sort((a, b) => a - b));
    expect(p.restoreCursor(SCOPE).lastDurableEventId).toBe(21);
  });

  it('a refresh that arrives while a drain runs is projected, not lost', async () => {
    insertTask('t1');
    const p0 = makeProducer();
    p0.ensureProjectionBaseline(SCOPE);
    for (let i = 0; i < 12; i += 1) insertEvent('t1', null, 10 + i);
    let fired = false;
    let p!: SupervisionConsoleProducer;
    p = makeProducer({
      monotonicNowMs: (() => { let t = 0; return () => (t += 4); })(),
      yieldToEventLoop: async () => {
        if (fired) return;
        fired = true;
        insertEvent('t1', null, 50);
        // A concurrent refresh returns the in-flight promise; it must not be a no-op.
        void p.synchronizeDurableEventsAsync(SCOPE, { deliver: false });
      },
    });
    await p.synchronizeDurableEventsAsync(SCOPE, { deliver: false });
    expect(outbox()).toHaveLength(13);
    expect(p.restoreCursor(SCOPE).lastDurableEventId).toBe(13);
  });

  it('coalesces concurrent refreshes into one drain', async () => {
    insertTask('t1');
    const p0 = makeProducer();
    p0.ensureProjectionBaseline(SCOPE);
    for (let i = 0; i < 40; i += 1) insertEvent('t1', null, 10 + i);
    const p = makeProducer({ syncSliceBudgetMs: 1 });
    const runs = await Promise.all([1, 2, 3].map(() => p.synchronizeDurableEventsAsync(SCOPE, { deliver: false })));
    expect(runs[0]).toBe(40);
    expect(outbox()).toHaveLength(40);
  });
});

describe('inline vs yielded threshold', () => {
  it('keeps a steady-state tail inline and sends a real backlog to the yielded path', () => {
    insertTask('t1');
    const p = makeProducer();
    p.ensureProjectionBaseline(SCOPE);
    for (let i = 0; i < SUPERVISION_INLINE_SYNC_MAX_EVENTS; i += 1) insertEvent('t1', null, 10 + i);
    expect(p.needsYieldedDurableReplay(SCOPE)).toBe(false);
    insertEvent('t1', null, 99);
    expect(p.needsYieldedDurableReplay(SCOPE)).toBe(true);
  });
});

describe('a real console stall is attributed to its console phase (watchdog)', () => {
  const busyWait = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* block the loop */ } };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const phases = () => recordStall.mock.calls.map(([arg]) => (arg as { phase: string }).phase);

  beforeEach(async () => {
    recordStall.mockReset();
    startEventLoopWatchdog();
    await sleep(120);
    recordStall.mockReset();
  });
  afterEach(() => { stopEventLoopWatchdog(); });

  // The slow part is the live-session lookup the projection calls for every
  // assignment row it builds -- the same call a busy real daemon makes slowly.
  const slowPresentation = (_name: string, at: number) => {
    busyWait(200);
    return { state: 'idle' as const, source: 'runtime' as const, observedAt: at };
  };

  it('a slow snapshot build is reported under supervision-console.build-snapshot, once, never as idle', async () => {
    insertTask('t1');
    insertAssignment('a1', 't1', 'implementing', 'primary');
    const p = makeProducer({ resolveSessionPresentation: slowPresentation });
    p.buildSnapshot(SCOPE, 'sub-slow');
    await sleep(350);
    expect(phases().filter((phase) => phase === 'supervision-console.build-snapshot')).toHaveLength(1);
    expect(phases()).not.toContain(EVENT_LOOP_WATCHDOG_IDLE_PHASE);
  });

  it('a slow durable-tail slice is reported under supervision-console.synchronize-durable-events-async', async () => {
    insertTask('t1');
    insertAssignment('a1', 't1', 'implementing', 'primary');
    const p = makeProducer({ resolveSessionPresentation: slowPresentation });
    p.ensureProjectionBaseline(SCOPE);
    insertEvent('t1', 'a1');
    await p.synchronizeDurableEventsAsync(SCOPE, { deliver: false });
    await sleep(350);
    expect(phases().filter((phase) => phase === 'supervision-console.synchronize-durable-events-async')).toHaveLength(1);
    expect(phases()).not.toContain(EVENT_LOOP_WATCHDOG_IDLE_PHASE);
  });

  it('an unlabelled stall in the same process still reads as the idle phase', async () => {
    busyWait(200);
    await sleep(350);
    expect(phases()).toContain(EVENT_LOOP_WATCHDOG_IDLE_PHASE);
    expect(phases().every((phase) => phase === EVENT_LOOP_WATCHDOG_IDLE_PHASE)).toBe(true);
  });
});
