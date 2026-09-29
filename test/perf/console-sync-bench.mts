/**
 * Supervision-console main-thread cost at production scale (test-only).
 *
 * Builds a synthetic registry + pair store the size of a real owner machine
 * (default: 600 tasks, 2,121 assignments, 75k events, 228 pairs with 3 KB
 * briefs), subscribes one console viewer through the REAL session registry,
 * then drives the two production triggers while an event-loop lag sampler runs
 * on the same thread:
 *   - pair activity: `resyncProject` -> the viewer re-subscribes -> durable
 *     replay + full snapshot build + serialization (the browser's loop);
 *   - registry commits: a new task event + `refreshActiveSubscriptions`.
 *
 * Run the SAME script against two source trees to compare revisions:
 *   BENCH_ROOT=/path/to/tree npx tsx test/perf/console-sync-bench.mts
 * (BENCH_ROOT defaults to this repository; the tree needs node_modules.)
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(process.env.BENCH_ROOT ?? new URL('../..', import.meta.url).pathname);
const SECONDS = Number(process.env.BENCH_SECONDS ?? 30);
const RESYNC_HZ = Number(process.env.BENCH_RESYNC_HZ ?? 4);
const EVENT_HZ = Number(process.env.BENCH_EVENT_HZ ?? 0.3);
const TASKS = Number(process.env.BENCH_TASKS ?? 600);
const ASSIGNMENTS = Number(process.env.BENCH_ASSIGNMENTS ?? 2121);
const EVENTS = Number(process.env.BENCH_EVENTS ?? 75_000);
const PAIRS = Number(process.env.BENCH_PAIRS ?? 228);
const STALL_MS = 75;
const PROJECT = 'perfproj';
const SCOPE = { projectName: PROJECT, coordinatorSessionName: `deck_${PROJECT}_brain` };

const dir = mkdtempSync(join(tmpdir(), 'imc-console-bench-'));
process.env.IMCODES_TASK_PAIRS_DB_PATH = join(dir, 'task-pairs.sqlite');
process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';

const load = (path: string) => import(pathToFileURL(join(ROOT, path)).href);
const { SupervisionConsoleProducer } = await load('src/daemon/supervision-console-producer.ts');
const { SupervisionConsoleSessionRegistry } = await load('src/daemon/supervision-console-session.ts');
const { migrateSupervisionStore } = await load('src/daemon/supervision-store-migrations.ts');
const { TaskPairStore, setTaskPairStoreForTests } = await load('src/daemon/task-pairs/store.ts');
const consoleShared = await load('shared/supervision-task-console.ts');
const supervisionShared = await load('shared/supervision-config.ts');

const db = new DatabaseSync(join(dir, 'supervision-state.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE TABLE supervision_tasks (task_id TEXT PRIMARY KEY, top_level_task_id TEXT NOT NULL, classification TEXT NOT NULL,
    status TEXT NOT NULL, current_revision TEXT, commit_sha TEXT, push_remote_ref TEXT, blocker TEXT, payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE supervision_task_assignments (assignment_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
    status TEXT NOT NULL, session_name TEXT NOT NULL, session_instance_id TEXT NOT NULL, runtime_epoch TEXT NOT NULL,
    agent_type TEXT NOT NULL, provider_family TEXT NOT NULL, lease_id TEXT NOT NULL, generation INTEGER NOT NULL,
    audit_attempt_id TEXT, audit_revision TEXT, verdict TEXT, blocker TEXT, payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE supervision_task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, assignment_id TEXT,
    event_type TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL);`);
migrateSupervisionStore(db);

const filler = (bytes: number) => 'x'.repeat(bytes);
const statuses = ['implementing', 'validated', 'ready_for_audit', 'finalized', 'finalized', 'finalized', 'cancelled'];
db.exec('BEGIN');
const insTask = db.prepare(`INSERT INTO supervision_tasks (task_id, project_name, top_level_task_id, classification, status,
  payload_json, created_at, updated_at) VALUES (?, ?, ?, 'slice', ?, ?, 1, 1)`);
for (let i = 0; i < TASKS; i += 1) {
  insTask.run(`tsk_${i}`, PROJECT, `top_${i}`, statuses[i % statuses.length], JSON.stringify({ objective: filler(2_800) }));
}
const insAsg = db.prepare(`INSERT INTO supervision_task_assignments (assignment_id, task_id, role, status, session_name,
  session_instance_id, runtime_epoch, agent_type, provider_family, lease_id, generation, payload_json, created_at, updated_at, pool_kind)
  VALUES (?, ?, 'implementer', ?, ?, 'i', 'e', 'codex', 'openai', ?, 1, ?, 1, 5, ?)`);
for (let i = 0; i < ASSIGNMENTS; i += 1) {
  const status = statuses[i % statuses.length]!;
  const active = status === 'implementing' || status === 'validated';
  insAsg.run(`asg_${i}`, `tsk_${i % TASKS}`, status, `deck_sub_${i % 40}`, active ? 'lease' : '',
    JSON.stringify({ required: true, note: filler(1_200) }), i % 3 === 0 ? 'primary' : i % 3 === 1 ? 'economy' : null);
}
const insEvt = db.prepare(`INSERT INTO supervision_task_events (task_id, assignment_id, event_type, status, payload_json, created_at)
  VALUES (?, ?, 'implementing', 'implementing', ?, 1)`);
for (let i = 0; i < EVENTS; i += 1) insEvt.run(`tsk_${i % TASKS}`, i % 4 === 0 ? `asg_${i % ASSIGNMENTS}` : null, filler(300));
db.exec('COMMIT');

const pairStore = new TaskPairStore(process.env.IMCODES_TASK_PAIRS_DB_PATH);
setTaskPairStoreForTests(pairStore);
const brief = `# Brief\n${'- [ ][ ] a checklist line with some words in it\n'.repeat(60)}`;
for (let i = 0; i < PAIRS; i += 1) {
  pairStore.savePair(PROJECT, {
    taskId: `pair_${i}`, brain: SCOPE.coordinatorSessionName, executor: `deck_sub_${i % 40}`, auditor: `deck_sub_${(i + 7) % 40}`,
    title: `Pair ${i}`, status: i % 5 === 0 ? 'working' : 'done', flags: [], flagSides: {}, round: i % 4, blocking: ['P0'],
    previousAuditors: [], createdAt: 1, updatedAt: 1_000 + i, brief, executorPool: 'primary',
  } as never, { liveness: { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 1_000, progressAuditorAt: 1_000 } as never });
}

let clock = 0;
const producer = new SupervisionConsoleProducer(db, {
  projectionEpoch: 'bench-epoch',
  now: () => ++clock,
  snapshotCacheTtlMs: 0,
  broadcast: (frame: unknown) => registry.broadcast(frame),
  resolveSessionPresentation: (name: string, at: number) => ({ label: name, model: 'm', state: 'running', source: 'runtime', observedAt: at }),
});
let bytesSent = 0;
let frames = 0;
let subscriptionSeq = 0;
const busy = { resync: 0, registry: 0 };
const registry = new SupervisionConsoleSessionRegistry({
  producer,
  authorize: () => true,
  now: () => Date.now(),
  send: (frame: { type?: string }) => {
    frames += 1;
    bytesSent += JSON.stringify(frame).length;
    if (frame.type === consoleShared.SUPERVISION_TASK_CONSOLE_MSG.RESYNC_REQUIRED) setImmediate(subscribe);
  },
});

function subscribe(): void {
  subscriptionSeq += 1;
  const started = performance.now();
  registry.handleFrame({
    type: consoleShared.SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE,
    scope: SCOPE,
    subscriptionId: `bench-${subscriptionSeq}`,
    afterEventId: null,
    reason: 'resync',
    schemaVersion: consoleShared.SUPERVISION_TASK_CONSOLE_SCHEMA_VERSION,
    statusContractVersion: supervisionShared.SUPERVISION_TASK_STATUS_CONTRACT_VERSION,
    projectionVersion: 0,
    lastDurableEventId: null,
    projectionEpoch: 'bench-epoch',
  });
  busy.resync += performance.now() - started;
}

const lags: number[] = [];
let expected = performance.now() + 10;
const sampler = setInterval(() => {
  const now = performance.now();
  lags.push(Math.max(0, now - expected));
  expected = now + 10;
}, 10);

subscribe();
const resyncTimer = setInterval(() => {
  const started = performance.now();
  registry.resyncProject(PROJECT, 'task_pair_changed');
  busy.resync += performance.now() - started;
}, 1000 / RESYNC_HZ);
let nextEvent = 0;
const eventTimer = setInterval(() => {
  const started = performance.now();
  nextEvent += 1;
  insEvt.run(`tsk_${nextEvent % TASKS}`, `asg_${nextEvent % ASSIGNMENTS}`, filler(300));
  registry.refreshActiveSubscriptions();
  busy.registry += performance.now() - started;
}, 1000 / EVENT_HZ);

await new Promise((resolveDone) => setTimeout(resolveDone, SECONDS * 1000));
clearInterval(sampler);
clearInterval(resyncTimer);
clearInterval(eventTimer);
await new Promise((resolveDone) => setTimeout(resolveDone, 500));

const sorted = [...lags].sort((a, b) => a - b);
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const result = {
  root: ROOT,
  scale: { tasks: TASKS, assignments: ASSIGNMENTS, events: EVENTS, pairs: PAIRS, seconds: SECONDS, resyncHz: RESYNC_HZ, eventHz: EVENT_HZ },
  loop: { samples: lags.length, lagP50: +q(0.5).toFixed(2), lagP95: +q(0.95).toFixed(2), lagP99: +q(0.99).toFixed(2), lagMax: +(sorted.at(-1) ?? 0).toFixed(2), stallsOver75ms: lags.filter((lag) => lag > STALL_MS).length },
  console: { subscribes: subscriptionSeq, framesSent: frames, bytesSent, busyMs: { resync: +busy.resync.toFixed(1), registry: +busy.registry.toFixed(1) }, busyPercentOfWall: +(((busy.resync + busy.registry) / (SECONDS * 1000)) * 100).toFixed(2) },
};
console.log(JSON.stringify(result));
db.close();
pairStore.close();
rmSync(dir, { recursive: true, force: true });
