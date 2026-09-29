/**
 * Real-daemon stall benchmark. Boots the ACTUAL daemon (`startup()` from
 * src/daemon/lifecycle.ts: every timeline subscriber, the task-pairs and
 * supervision automations, the event-loop watchdog / delay monitor / latency
 * tracer, timeline store) in one process with an isolated HOME, then drives a
 * Brain and a worker session that stream for real through
 * QwenProvider -> transport-relay -> timelineEmitter -> subscribers. The model
 * backend is fake-qwen.mjs (same stream-json protocol as the qwen CLI).
 *
 * Supervision and task-pair state is a synthetic, production-shaped database
 * (test/setup/fixtures/supervision-production-shape.ts), no real data.
 *
 * Env: PERF_HOME (scratch dir, required), PERF_DURATION_SEC (default 300),
 * PERF_LABEL, PERF_OUT, PERF_CPU_PROFILE (optional path).
 * The same file runs unchanged on the base and the fixed commit.
 */
import { Session } from 'node:inspector';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.PERF_HOME;
if (!HOME) throw new Error('PERF_HOME is required');
const DURATION_SEC = Number(process.env.PERF_DURATION_SEC ?? 300);
const LABEL = process.env.PERF_LABEL ?? 'real';
const OUT = process.env.PERF_OUT ?? `/tmp/perf-real-daemon-${LABEL}.json`;
const CPU_PROFILE_OUT = process.env.PERF_CPU_PROFILE;
const STALL_MS = 50;

// Isolation: every daemon path resolves under HOME (never the machine's default daemon).
process.env.HOME = HOME;
process.env.IMCODES_HOME = join(HOME, '.imcodes');
process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
process.env.IMCODES_SUPERVISION_STATE_DB_PATH = join(HOME, '.imcodes', 'supervision-state.sqlite');
mkdirSync(join(HOME, '.imcodes'), { recursive: true });
mkdirSync(join(HOME, 'proj'), { recursive: true });

const { startup } = await import('../../../src/daemon/lifecycle.js');
const { launchSession } = await import('../../../src/agent/session-manager.js');
const { handleWebCommand } = await import('../../../src/daemon/command-handler.js');
const { getSession } = await import('../../../src/store/session-store.js');
const { timelineEmitter } = await import('../../../src/daemon/timeline-emitter.js');
const { getSupervisionTaskRegistry, resolveSupervisionTaskRegistryDbPath } = await import('../../../src/daemon/supervision-state-store.js');
const { liveSupervisionIdentity } = await import('../../../src/daemon/supervision-participant-delivery.js');
const { getTaskPairStore } = await import('../../../src/daemon/task-pairs/store.js');
const { readDaemonRuntimeStatus } = await import('../../../src/util/daemon-status.js');
const { PROJECT, BRAIN, seedProductionShapedSupervision } = await import('../../setup/fixtures/supervision-production-shape.js');

const WORKER = `deck_${PROJECT}_w1`;

function pct(sorted: number[], p: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

await startup();

for (const [name, role] of [[BRAIN, 'brain'], [WORKER, 'w1']] as const) {
  await launchSession({ name, projectName: PROJECT, role, agentType: 'qwen', projectDir: join(HOME, 'proj') } as never);
}

// Production-shaped supervision database + task pairs, seeded through the daemon's own stores.
const registry = getSupervisionTaskRegistry();
const seedDb = new DatabaseSync(resolveSupervisionTaskRegistryDbPath());
const shape = seedProductionShapedSupervision(registry, seedDb);
seedDb.close();
const workerIdentity = liveSupervisionIdentity(getSession(WORKER)!)!;
registry.createOrGet({
  taskId: 'tsk_perfliveonly', topLevelTaskId: 'tsk_perfliveonly', projectName: PROJECT,
  classification: 'independent_top_level', objective: 'live', currentRevision: 'perf-r1', now: Date.now() - 60_000,
});
registry.createAssignment({
  taskId: 'tsk_perfliveonly', assignmentId: 'asg_perfliveonly', role: 'implementer', identity: workerIdentity,
  auditRevision: 'perf-r1', now: Date.now() - 59_000,
});
registry.updateTask({ taskId: 'tsk_perfliveonly', status: 'implementing', currentRevision: 'perf-r1', now: Date.now() - 58_000 });
registry.updateAssignment({ assignmentId: 'asg_perfliveonly', identity: workerIdentity, status: 'implementing', now: Date.now() - 58_000 });
const store = getTaskPairStore();
for (let i = 0; i < 320; i += 1) {
  store.savePair(PROJECT, {
    taskId: `tsk_perfpair${String(i).padStart(4, '0')}`, brain: BRAIN, executor: WORKER, auditor: WORKER,
    status: i < 20 ? 'working' : 'done', flags: [], flagSides: {}, round: 1, blocking: ['P0'], previousAuditors: [],
    capCounts: {}, capRound: 1, createdAt: 1_000 + i, updatedAt: 1_000 + i, title: `Task ${i}`,
    brief: `Realistic brief ${i}. ${'Investigate, implement and verify the change end to end. '.repeat(200)}`,
  } as never);
}
console.log(`seeded supervision: ${shape.taskCount} tasks / ${shape.assignmentCount} assignments; 320 task pairs (20 open)`);

let profiler: Session | undefined;
if (CPU_PROFILE_OUT) {
  profiler = new Session();
  profiler.connect();
  await new Promise<void>((resolve) => profiler!.post('Profiler.enable', () => resolve()));
  await new Promise<void>((resolve) => profiler!.post('Profiler.start', () => resolve()));
}

const watchdogBefore = readDaemonRuntimeStatus(join(HOME, '.imcodes'))?.eventLoop?.stallCount ?? 0;
console.log('MEASURE_START');
const eventCounts = new Map<string, number>();
timelineEmitter.on((event) => { eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1); });

const lateness: number[] = [];
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();
let expected = performance.now() + 10;
const ticker = setInterval(() => {
  const now = performance.now();
  lateness.push(Math.max(0, now - expected));
  expected = now + 10;
}, 10);

// Keep both sessions streaming: send a fresh message as soon as the previous turn ends.
const serverLink = { send: () => undefined } as never;
let commandSeq = 0;
let running = true;
const inflight = new Set<string>();
const kick = (session: string): void => {
  if (!running || inflight.has(session)) return;
  inflight.add(session);
  commandSeq += 1;
  handleWebCommand({ type: 'session.send', session, text: `continue ${commandSeq}`, commandId: `perf-cmd-${commandSeq}` } as never, serverLink);
};
timelineEmitter.on((event) => {
  if ((event.sessionId === BRAIN || event.sessionId === WORKER) && event.type === 'session.state') {
    const state = (event.payload as { state?: string }).state;
    if (state === 'idle') { inflight.delete(event.sessionId); setTimeout(() => kick(event.sessionId), 200); }
  }
});
const startedAt = Date.now();
kick(BRAIN);
kick(WORKER);
await new Promise((resolve) => setTimeout(resolve, DURATION_SEC * 1000));
running = false;
console.log('MEASURE_END');
clearInterval(ticker);
histogram.disable();

let profileFile: string | undefined;
if (profiler && CPU_PROFILE_OUT) {
  await new Promise<void>((resolve) => profiler!.post('Profiler.stop', (_err, result) => {
    writeFileSync(CPU_PROFILE_OUT, JSON.stringify((result as { profile: unknown }).profile));
    profileFile = CPU_PROFILE_OUT;
    resolve();
  }));
  profiler.disconnect();
}

const stalls = lateness.filter((ms) => ms >= STALL_MS).sort((a, b) => a - b);
const runtimeStatus = readDaemonRuntimeStatus(join(HOME, '.imcodes'));
const result = {
  label: LABEL,
  durationSec: (Date.now() - startedAt) / 1000,
  timelineEvents: Object.fromEntries(eventCounts),
  assistantTextEvents: eventCounts.get('assistant.text') ?? 0,
  stallThresholdMs: STALL_MS,
  stalls: {
    count: stalls.length,
    perMinute: Number((stalls.length / (DURATION_SEC / 60)).toFixed(2)),
    p50Ms: pct(stalls, 0.5), p90Ms: pct(stalls, 0.9), p99Ms: pct(stalls, 0.99), maxMs: stalls[stalls.length - 1] ?? 0,
  },
  blockedRatio: lateness.reduce((sum, ms) => sum + (ms >= STALL_MS ? ms : 0), 0) / (DURATION_SEC * 1000),
  eventLoopDelayMs: {
    p50: histogram.percentile(50) / 1e6, p90: histogram.percentile(90) / 1e6,
    p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6,
  },
  // The daemon's own watchdog (>75 ms drift on its 100 ms timer). Seeding the database blocks it once before the window.
  daemonWatchdogStallsInWindow: (runtimeStatus?.eventLoop?.stallCount ?? 0) - watchdogBefore,
  daemonWatchdog: runtimeStatus?.eventLoop ?? null,
  supervisionSeed: shape,
  cpuProfile: profileFile,
};
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
