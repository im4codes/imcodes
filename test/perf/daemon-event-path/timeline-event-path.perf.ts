import { Session } from 'node:inspector';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fakeRuntimes = new Map<string, unknown>();

vi.mock('../../../src/agent/session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agent/session-manager.js')>();
  return {
    ...actual,
    getTransportRuntime: (name: string) => fakeRuntimes.get(name) ?? actual.getTransportRuntime(name),
  };
});

import type { SessionRecord } from '../../../src/store/session-store.js';
import { getSession, upsertSession } from '../../../src/store/session-store.js';
import { timelineEmitter } from '../../../src/daemon/timeline-emitter.js';
import { supervisionAutomation } from '../../../src/daemon/supervision-automation.js';
import { liveSupervisionIdentity } from '../../../src/daemon/supervision-participant-delivery.js';
import {
  getSupervisionTaskRegistry,
  resolveSupervisionTaskRegistryDbPath,
} from '../../../src/daemon/supervision-state-store.js';
import { getTaskPairStore } from '../../../src/daemon/task-pairs/store.js';
import { TaskPairService } from '../../../src/daemon/task-pairs/service.js';
import { TaskPairAutomation } from '../../../src/daemon/task-pairs/scheduler.js';
import { setTaskPairDeliveryDepsForTests } from '../../../src/daemon/task-pairs/delivery.js';
import type { TaskPairState } from '../../../shared/task-pair.js';
import { PROJECT, seedProductionShapedSupervision } from '../../setup/fixtures/supervision-production-shape.js';

/**
 * Real-machine harness for the per-timeline-event path.
 *
 * It loads the production modules in one Node process with the production
 * subscribers registered on the real `timelineEmitter` (supervision automation,
 * task-pair service, the pairs heartbeat observer exactly as lifecycle.ts wires
 * it), a production-shaped supervision database and task-pair table (synthetic,
 * see test/setup/fixtures/supervision-production-shape.ts), and drives one Brain
 * session that streams continuously at the rate of a real turn, plus one live
 * worker. Main-thread stalls are measured with a 10 ms timer (lateness) and
 * perf_hooks' event-loop-delay histogram; each emit's synchronous cost is timed.
 *
 * The same file runs unchanged against the base commit and the fixed commit
 * (it only uses APIs both have), so the two results are directly comparable.
 */
const DURATION_SEC = Number(process.env.PERF_DURATION_SEC ?? 300);
const LABEL = process.env.PERF_LABEL ?? 'run';
const OUT = process.env.PERF_OUT ?? `/tmp/perf-event-path-${LABEL}.json`;
const STALL_MS = 50;
/** Optional: write a V8 CPU profile of the streaming window (open in DevTools/speedscope). */
const CPU_PROFILE_OUT = process.env.PERF_CPU_PROFILE;

const BRAIN = 'deck_perfproj_brain';
const LIVE_WORKER = 'deck_sub_perfliveworker';
const PAIR_WORKERS = Array.from({ length: 40 }, (_, i) => `deck_sub_perfpw${i}`);

function session(name: string, role: SessionRecord['role']): SessionRecord {
  return {
    name, projectName: PROJECT, role, agentType: 'claude-code-sdk', runtimeType: 'transport',
    projectDir: `/tmp/${PROJECT}`, state: 'running',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  } as SessionRecord;
}

function fakeRuntime(name: string) {
  return {
    getDiagnosticSnapshot: () => ({
      activityGeneration: { scope: 'session', sessionName: name, generation: 1 },
      lastProviderOutputAt: 0,
    }),
    activeDispatchEntries: [],
    pendingCount: 0,
  };
}

function pairState(index: number, status: TaskPairState['status'] = 'working'): TaskPairState {
  return {
    taskId: `tsk_perfpair${String(index).padStart(4, '0')}`, brain: BRAIN,
    executor: PAIR_WORKERS[index % PAIR_WORKERS.length], auditor: PAIR_WORKERS[(index + 17) % PAIR_WORKERS.length],
    status, flags: [], flagSides: {}, round: 1, blocking: ['P0'], previousAuditors: [], capCounts: {}, capRound: 1,
    createdAt: 1_000 + index, updatedAt: 1_000 + index, title: `Task ${index}`,
    brief: `Realistic brief ${index}. ${'Investigate, implement and verify the change end to end. '.repeat(200)}`,
  } as TaskPairState;
}

function pct(sorted: number[], p: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

describe(`timeline event path (${LABEL}, ${DURATION_SEC}s)`, () => {
  let taskPairService: TaskPairService;
  let pairsHeartbeat: TaskPairAutomation;

  beforeAll(() => {
    process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    // Under vitest the registry defaults to :memory:; a file keeps the run
    // identical to the daemon (and lets a second connection seed terminal rows).
    process.env.IMCODES_SUPERVISION_STATE_DB_PATH = join(process.env.IMCODES_HOME!, 'supervision-state.sqlite');
    for (const [name, role] of [[BRAIN, 'brain'], [LIVE_WORKER, 'w1'], ...PAIR_WORKERS.map((n) => [n, 'w2'] as const)] as const) {
      upsertSession(session(name, role));
      fakeRuntimes.set(name, fakeRuntime(name));
    }
    // Supervision database of production shape, plus one live implementer.
    const registry = getSupervisionTaskRegistry();
    const db = new DatabaseSync(resolveSupervisionTaskRegistryDbPath());
    seedProductionShapedSupervision(registry, db);
    db.close();
    const liveIdentity = liveSupervisionIdentity(getSession(LIVE_WORKER)!)!;
    registry.createOrGet({
      taskId: 'tsk_perfliveonly', topLevelTaskId: 'tsk_perfliveonly', projectName: PROJECT,
      classification: 'independent_top_level', objective: 'live', currentRevision: 'perf-r1', now: Date.now() - 60_000,
    });
    registry.createAssignment({
      taskId: 'tsk_perfliveonly', assignmentId: 'asg_perfliveonly', role: 'implementer', identity: liveIdentity,
      auditRevision: 'perf-r1', now: Date.now() - 59_000,
    });
    registry.updateTask({ taskId: 'tsk_perfliveonly', status: 'implementing', currentRevision: 'perf-r1', now: Date.now() - 58_000 });
    registry.updateAssignment({ assignmentId: 'asg_perfliveonly', identity: liveIdentity, status: 'implementing', now: Date.now() - 58_000 });
    // Task pairs: open pairs owned by the Brain plus terminal history.
    const store = getTaskPairStore();
    for (let i = 0; i < 150; i += 1) store.savePair(PROJECT, pairState(i));
    for (let i = 150; i < 450; i += 1) store.savePair(PROJECT, pairState(i, 'done'));
    setTaskPairDeliveryDepsForTests({ send: async () => undefined });
    taskPairService = new TaskPairService();
    pairsHeartbeat = new TaskPairAutomation({
      now: () => Date.now(), isBusy: () => false, isLimited: () => false, pickCandidate: () => undefined,
      provision: async () => undefined, poolOf: () => 'primary', importLegacy: () => undefined,
    });
    taskPairService.setScheduler(pairsHeartbeat);
    taskPairService.init();
    supervisionAutomation.init();
    // lifecycle.ts: the pairs heartbeat observer on the same emitter.
    timelineEmitter.on((event) => {
      pairsHeartbeat.observeTimelineEvent(event);
      if (event.type !== 'session.state' && event.type !== 'assistant.thinking' && event.type !== 'assistant.text'
        && event.type !== 'tool.call' && event.type !== 'tool.result') return;
      getTaskPairStore().pairsForSession(event.sessionId);
    });
  });

  afterAll(async () => {
    await taskPairService?.dispose();
    setTaskPairDeliveryDepsForTests(undefined);
  });

  it('streams a Brain (and one live worker) for the whole duration and records main-thread stalls', async () => {
    let profiler: Session | undefined;
    if (CPU_PROFILE_OUT) {
      profiler = new Session();
      profiler.connect();
      await new Promise<void>((resolve) => profiler!.post('Profiler.enable', () => resolve()));
      await new Promise<void>((resolve) => profiler!.post('Profiler.start', () => resolve()));
    }
    const emitCosts: number[] = [];
    const lateness: number[] = [];
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();

    let seq = 0;
    const emit = (sessionId: string, type: 'assistant.text' | 'assistant.thinking' | 'tool.call' | 'tool.result', payload: Record<string, unknown>, eventId: string) => {
      const start = performance.now();
      timelineEmitter.emit(sessionId, type, payload, { source: 'daemon', confidence: 'high', eventId });
      emitCosts.push(performance.now() - start);
    };

    // A 10 ms tick: how late it fires is how long the main thread was blocked.
    let expected = performance.now() + 10;
    const ticker = setInterval(() => {
      const now = performance.now();
      lateness.push(Math.max(0, now - expected));
      expected = now + 10;
    }, 10);

    let turn = 0;
    let text = '';
    const streamBrain = setInterval(() => {
      seq += 1;
      if (seq % 750 === 0) { turn += 1; text = ''; } // a new turn about every 30 s
      text += 'The daemon keeps streaming assistant output for the Brain session. ';
      emit(BRAIN, 'assistant.text', { text, streaming: true }, `perf-brain-${turn}`);
      if (seq % 6 === 0) emit(BRAIN, 'assistant.thinking', { text: `thinking ${seq}`, streaming: true }, `perf-brain-think-${turn}`);
      if (seq % 37 === 0) {
        emit(BRAIN, 'tool.call', { toolCallId: `c${seq}`, tool: 'Bash', input: { command: 'ls' } }, `perf-brain-call-${seq}`);
        emit(BRAIN, 'tool.result', { toolCallId: `c${seq}`, tool: 'Bash', output: 'ok' }, `perf-brain-result-${seq}`);
      }
    }, 40);
    let workerSeq = 0;
    let workerText = '';
    const streamWorker = setInterval(() => {
      workerSeq += 1;
      workerText += 'worker output ';
      emit(LIVE_WORKER, 'assistant.text', { text: workerText, streaming: true }, `perf-worker-${Math.floor(workerSeq / 400)}`);
      if (workerSeq % 20 === 0) emit(LIVE_WORKER, 'tool.call', { toolCallId: `w${workerSeq}`, tool: 'Read' }, `perf-worker-call-${workerSeq}`);
    }, 100);

    await new Promise((resolve) => setTimeout(resolve, DURATION_SEC * 1000));
    clearInterval(streamBrain);
    clearInterval(streamWorker);
    clearInterval(ticker);
    histogram.disable();
    if (profiler && CPU_PROFILE_OUT) {
      const profile = await new Promise<unknown>((resolve) => profiler!.post('Profiler.stop', (_err, result) => resolve((result as { profile: unknown }).profile)));
      writeFileSync(CPU_PROFILE_OUT, JSON.stringify(profile));
      profiler.disconnect();
    }

    const sortedCosts = [...emitCosts].sort((a, b) => a - b);
    const stalls = lateness.filter((ms) => ms >= STALL_MS).sort((a, b) => a - b);
    const blocked = lateness.reduce((sum, ms) => sum + ms, 0);
    const result = {
      label: LABEL,
      durationSec: DURATION_SEC,
      events: emitCosts.length,
      emitCostMs: { p50: pct(sortedCosts, 0.5), p90: pct(sortedCosts, 0.9), p99: pct(sortedCosts, 0.99), max: sortedCosts.at(-1) ?? 0 },
      stallThresholdMs: STALL_MS,
      stalls: {
        count: stalls.length,
        perMinute: stalls.length / (DURATION_SEC / 60),
        p50Ms: pct(stalls, 0.5), p90Ms: pct(stalls, 0.9), p99Ms: pct(stalls, 0.99), maxMs: stalls.at(-1) ?? 0,
      },
      blockedRatio: blocked / (DURATION_SEC * 1000),
      eventLoopDelayMs: {
        p50: histogram.percentile(50) / 1e6, p90: histogram.percentile(90) / 1e6,
        p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6,
      },
    };
    writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log(`PERF_RESULT ${JSON.stringify(result)}`);
    expect(result.events).toBeGreaterThan(0);
  });
});
