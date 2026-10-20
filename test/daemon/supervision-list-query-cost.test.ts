import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import {
  SupervisionTaskRegistry,
  type PersistedSupervisionTaskAssignmentIdentity,
} from '../../src/daemon/supervision-state-store.js';

/**
 * `registry.list()` sits on the message-delivery path — `dispatchSendMessage`
 * reaches it through `ensureHookSupervisionAssignmentWorktree`, and
 * `runSupervisionConvergenceTick` calls it four times per tick on every
 * recorded final receipt and every finish.
 *
 * node:sqlite is SYNCHRONOUS, so every statement it issues blocks the whole
 * event loop. Measured against a copy of the real database (352 tasks), one
 * call blocked ~201 ms, of which ~194 ms was a trailing
 * `.map((record) => this.get(record.taskId))` re-reading payloads the first
 * SELECT had already returned — `get()` runs six sub-queries per task.
 *
 * This pins the SCALING rather than a threshold. A fixed statement budget
 * would drift with machine, schema or unrelated refactors; what actually has
 * to hold is that per-task cost does not grow with the size of the result.
 * Doubling the task count must not roughly double the statements issued.
 */
function countPreparedStatements<T>(run: () => T): { result: T; prepares: number } {
  const proto = DatabaseSync.prototype as unknown as { prepare: (...args: unknown[]) => unknown };
  const original = proto.prepare;
  let prepares = 0;
  proto.prepare = function patched(this: unknown, ...args: unknown[]) {
    prepares += 1;
    return original.apply(this, args);
  };
  try {
    return { result: run(), prepares };
  } finally {
    proto.prepare = original;
  }
}

function identity(sessionName: string): PersistedSupervisionTaskAssignmentIdentity {
  return {
    sessionName,
    sessionInstanceId: `${sessionName}-instance`,
    runtimeEpoch: `${sessionName}-epoch`,
    agentType: 'claude-code-sdk',
    providerFamily: 'anthropic',
  };
}

/** Builds a project of `size` tasks, each with one assignment, and returns the
 *  statement count of a single `list()` over it. */
function measureListCost(size: number): { prepares: number; returned: number } {
  const dir = mkdtempSync(join(tmpdir(), 'supervision-list-cost-'));
  const registry = new SupervisionTaskRegistry({ dbPath: join(dir, 'registry.sqlite') });
  try {
    for (let i = 0; i < size; i++) {
      const taskId = `tsk_cost${String(i).padStart(4, '0')}`;
      const created = registry.createOrGet({
        taskId,
        topLevelTaskId: taskId,
        projectName: 'costproj',
        classification: 'independent_top_level',
        objective: `objective ${i}`,
        now: 1_000 + i,
      });
      expect(created).toMatchObject({ ok: true });
      const assignment = registry.createAssignment({
        taskId,
        assignmentId: `asg_cost${String(i).padStart(4, '0')}`,
        role: 'implementer',
        identity: identity(`deck_cost_${i}`),
        now: 2_000 + i,
      });
      if (!assignment.ok) throw new Error(assignment.reason);
    }

    const { result, prepares } = countPreparedStatements(
      () => registry.list({ projectName: 'costproj' }),
    );

    // Guard against "make it fast by returning less": the snapshots must still
    // be complete, so a fix cannot pass this by dropping hydration.
    expect(result).toHaveLength(size);
    expect(result.every((task) => task.assignments.length === 1)).toBe(true);

    return { prepares, returned: result.length };
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('registry.list statement cost', () => {
  it('does not issue per-task queries: doubling the result set must not double the statements', () => {
    const small = measureListCost(20);
    const large = measureListCost(40);

    // With the N+1 present this is ~6 statements per extra task. Without it the
    // extra 20 tasks cost a constant number of additional statements.
    const perExtraTask = (large.prepares - small.prepares) / 20;
    expect(
      perExtraTask,
      `list() issued ${small.prepares} statements for 20 tasks and ${large.prepares} for 40 — `
      + `${perExtraTask.toFixed(1)} extra statements per additional task. `
      + 'Every one of those is a synchronous SQLite round-trip blocking the event loop on the send path.',
    ).toBeLessThan(1);
  }, 60_000);
});
