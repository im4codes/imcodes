import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import { SupervisionTaskRegistry } from '../../src/daemon/supervision-state-store.js';

import {
  BRAIN,
  CANCELLED,
  FINALIZED,
  PROJECT,
  TASKS,
  identity,
  seedProductionShapedSupervision,
} from '../setup/fixtures/supervision-production-shape.js';

/**
 * The per-timeline-event implementation-activity path used to call
 * `registry.list({ projectName, ownerSessionName, includeArchived: true })`
 * for EVERY streamed assistant delta and tool event. `list()` hydrates each
 * task the session ever owned (task payload + assignments + file events +
 * audit receipts + completion evidence) and node:sqlite is synchronous, so a
 * Brain that owns hundreds of finished tasks blocked the daemon's main thread
 * for tens of milliseconds per event (measured on the real database: p50 60 ms,
 * max 148 ms for the Brain; a 120 s CPU profile showed 3.6 s bursts).
 *
 * The fixture (test/setup/fixtures/supervision-production-shape.ts) has the shape
 * of the production database, synthesized: no real data.
 */
const LIVE_WORKER = 'deck_sub_perflive';

interface Fixture {
  registry: SupervisionTaskRegistry;
  db: DatabaseSync;
  taskCount: number;
  assignmentCount: number;
}

function buildProductionShapedRegistry(): Fixture {
  const db = new DatabaseSync(':memory:');
  const registry = new SupervisionTaskRegistry({ database: db });
  return { registry, db, ...seedProductionShapedSupervision(registry, db) };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function measure(run: () => unknown, samples: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b);
}

describe('implementation-activity per-event cost on a production-shaped supervision database', () => {
  const fixture = buildProductionShapedRegistry();
  const { registry } = fixture;

  it('fixture has the production shape (616 tasks, 606 terminal, >2000 assignments)', () => {
    expect(fixture.taskCount).toBe(616);
    expect(fixture.assignmentCount).toBeGreaterThan(2000);
    const all = registry.list({ projectName: PROJECT, includeArchived: true });
    expect(all).toHaveLength(TASKS);
    const live = all.filter((task) => task.status !== 'finalized' && task.status !== 'cancelled');
    expect(live).toHaveLength(TASKS - FINALIZED - CANCELLED);
    // Ended tasks are archived (as in production), so a default list() is small.
    expect(registry.list({ projectName: PROJECT }).length).toBeLessThan(60);
  });

  it('BASELINE: the old per-event call (list with includeArchived for the owning session) blocks > 50 ms per event for a Brain', () => {
    const times = measure(() => registry.list({
      projectName: PROJECT, ownerSessionName: BRAIN, includeArchived: true,
    }), 5);
    expect(percentile(times, 0.5)).toBeGreaterThan(50);
  }, 60_000);

  it('FIXED: a session with no live implementer assignment (the Brain, every streamed delta) costs < 1 ms p99 and issues no SQL once known', () => {
    expect(registry.hasActiveImplementerAssignment(BRAIN)).toBe(false);
    const proto = DatabaseSync.prototype as unknown as { prepare: (...args: unknown[]) => unknown };
    const original = proto.prepare;
    let prepares = 0;
    proto.prepare = function patched(this: unknown, ...args: unknown[]) {
      prepares += 1;
      return original.apply(this, args);
    };
    let times: number[];
    try {
      times = measure(() => registry.hasActiveImplementerAssignment(BRAIN), 5000);
    } finally {
      proto.prepare = original;
    }
    expect(prepares).toBe(0);
    expect(percentile(times, 0.99)).toBeLessThan(1);
  });

  it('FIXED: a worker with one live assignment reads only its live task (narrow indexed query) in < 1 ms p99', () => {
    const task = registry.createOrGet({
      taskId: 'tsk_perflive0001',
      topLevelTaskId: 'tsk_perflive0001',
      projectName: PROJECT,
      classification: 'independent_top_level',
      objective: 'live work',
      now: 9_000,
    });
    expect(task).toMatchObject({ ok: true });
    const assignment = registry.createAssignment({
      taskId: 'tsk_perflive0001',
      assignmentId: 'asg_perflive0001',
      role: 'implementer',
      identity: identity(LIVE_WORKER),
      now: 9_001,
    });
    expect(assignment).toMatchObject({ ok: true });
    // createAssignment changed membership: the answer flips immediately.
    expect(registry.hasActiveImplementerAssignment(LIVE_WORKER)).toBe(true);

    const times = measure(() => registry.listTasksWithActiveImplementerAssignments({
      projectName: PROJECT, sessionName: LIVE_WORKER,
    }), 400);
    const result = registry.listTasksWithActiveImplementerAssignments({ projectName: PROJECT, sessionName: LIVE_WORKER });
    expect(result.map((entry) => entry.taskId)).toEqual(['tsk_perflive0001']);
    expect(result[0]!.assignments.map((entry) => entry.assignmentId)).toEqual(['asg_perflive0001']);
    expect(percentile(times, 0.99)).toBeLessThan(1);
  });

  it('a workers finished (terminal) tasks never come back from the narrow query, and never need activity accounting: recordImplementationRuntimeActivity refuses terminal tasks', () => {
    // A worker whose every assignment is under a finalized/cancelled task has
    // nothing live: nothing is hydrated for it. (Each terminal task's
    // assignments ended with it; a session never seen owns none at all.)
    const terminalOnly = fixture.db.prepare(
      `SELECT a.session_name AS s FROM supervision_task_assignments a
       WHERE a.role = 'implementer' GROUP BY a.session_name
       HAVING SUM(CASE WHEN a.status IN ('delegated','implementing') THEN 1 ELSE 0 END) = 0 LIMIT 1`,
    ).get() as { s: string } | undefined;
    expect(terminalOnly).toBeDefined();
    expect(registry.hasActiveImplementerAssignment(terminalOnly!.s)).toBe(false);
    expect(registry.listTasksWithActiveImplementerAssignments({
      projectName: PROJECT, sessionName: terminalOnly!.s,
    })).toEqual([]);

    // Even an implementer assignment that lingers as `implementing` under a
    // terminal task is refused by the registry, so excluding it loses nothing.
    const stale = registry.createOrGet({
      taskId: 'tsk_perfterminal',
      topLevelTaskId: 'tsk_perfterminal',
      projectName: PROJECT,
      classification: 'independent_top_level',
      objective: 'terminal with a lingering assignment',
      now: 10_000,
    });
    expect(stale).toMatchObject({ ok: true });
    const created = registry.createAssignment({
      taskId: 'tsk_perfterminal',
      assignmentId: 'asg_perfterminal',
      role: 'implementer',
      identity: identity('deck_sub_perflingering'),
      now: 10_001,
    });
    expect(created).toMatchObject({ ok: true });
    fixture.db.prepare(
      `UPDATE supervision_task_assignments SET status = 'implementing', payload_json = json_set(payload_json, '$.status', 'implementing') WHERE assignment_id = ?`,
    ).run('asg_perfterminal');
    fixture.db.prepare(
      `UPDATE supervision_tasks SET status = 'cancelled', payload_json = json_set(payload_json, '$.status', 'cancelled') WHERE task_id = ?`,
    ).run('tsk_perfterminal');

    const refused = registry.recordImplementationRuntimeActivity({
      taskId: 'tsk_perfterminal',
      assignmentId: 'asg_perfterminal',
      identity: identity('deck_sub_perflingering'),
      activityGeneration: { scope: 'session', sessionName: 'deck_sub_perflingering', generation: 1 },
      signal: 'provider_tool_call',
      eventId: 'evt-1',
      fingerprint: 'fp-1',
      now: 20_000,
    });
    expect(refused).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(registry.listTasksWithActiveImplementerAssignments({
      projectName: PROJECT, sessionName: 'deck_sub_perflingering',
    })).toEqual([]);
  });

  it('membership changes invalidate the gate at once (an assignment moving out of delegated/implementing stops counting)', () => {
    expect(registry.hasActiveImplementerAssignment(LIVE_WORKER)).toBe(true);
    const asg = registry.getAssignment('asg_perflive0001')!;
    const cancelled = registry.updateAssignment({
      assignmentId: asg.assignmentId,
      identity: asg.identity,
      status: 'cancelled',
      now: 30_000,
    });
    expect(cancelled).toMatchObject({ ok: true });
    expect(registry.hasActiveImplementerAssignment(LIVE_WORKER)).toBe(false);
  });
});
