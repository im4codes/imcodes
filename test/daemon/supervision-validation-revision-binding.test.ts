import { createHash } from 'node:crypto';
import { SUPERVISION_UNBOUND_REVISION } from '../../shared/supervision-mcp-tools.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SupervisionTaskRegistry,
  bindValidationToRevision,
  validationAttestsRevision,
  type PersistedSupervisionTaskAssignment,
  type PersistedSupervisionTaskAssignmentIdentity,
  type PersistedSupervisionTaskRecord,
} from '../../src/daemon/supervision-state-store.js';
import { freezeSupervisionIntegrationBundle } from '../../src/daemon/supervision-integration-bundle.js';
import { suppressSqliteExperimentalWarning } from '../../src/util/suppress-sqlite-warning.js';

/**
 * tsk_hqx R3/R4 class: a Brain revision rebind copied the predecessor's
 * `validationState: passed` onto the successor. Lifecycle convergence then read
 * that inherited fact as durable validation of the NEW revision and projected
 * FINISHED immediately, so the successor's audit bundle froze whatever bytes the
 * worktree held at that instant -- typically the old revision. Validation is a
 * statement about one exact revision and must never survive a revision change.
 */

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const R1 = 'validation-binding-r1-aaaaaaaa';
const R2 = 'validation-binding-r2-bbbbbbbb';

function identity(name: string): PersistedSupervisionTaskAssignmentIdentity {
  return {
    sessionName: name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `epoch-${name}`,
    agentType: 'codex-sdk',
    providerFamily: 'openai',
  };
}

function snapshot(worktreePath = '/tmp/validation-binding') {
  return {
    worktreePath,
    headSha: 'a'.repeat(40),
    files: [{ path: 'src/exact.ts', sha256: 'b'.repeat(64) }],
    stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
  };
}

/** Raw persisted rewrite: models a row written by an older control plane. */
function rewriteAssignment(database: InstanceType<typeof DatabaseSync>, assignment: PersistedSupervisionTaskAssignment): void {
  database.prepare(`
    UPDATE supervision_task_assignments SET status = ?, validation_state = ?, audit_revision = ?,
      payload_json = ?, updated_at = ? WHERE assignment_id = ?
  `).run(assignment.status, assignment.validationState ?? null, assignment.auditRevision ?? null,
    JSON.stringify(assignment), assignment.updatedAt, assignment.assignmentId);
}

function rewriteTask(database: InstanceType<typeof DatabaseSync>, task: PersistedSupervisionTaskRecord): void {
  database.prepare(`
    UPDATE supervision_tasks SET status = ?, current_revision = ?, validation_state = ?,
      payload_json = ?, updated_at = ? WHERE task_id = ?
  `).run(task.status, task.currentRevision ?? null, task.validationState ?? null,
    JSON.stringify(task), task.updatedAt, task.taskId);
}

function validatedAtR1(taskId = 'tsk_validation_binding', database = new DatabaseSync(':memory:')) {
  const registry = new SupervisionTaskRegistry({ database });
  expect(registry.createOrGet({
    taskId, projectName: 'alpha', classification: 'independent_top_level',
    objective: 'bind validation to one revision', acceptance: ['no inheritance'],
    currentRevision: R1,
  })).toMatchObject({ ok: true });
  expect(registry.createAssignment({
    taskId, role: 'coordinator', identity: identity('deck_alpha_brain'), required: false,
  })).toMatchObject({ ok: true });
  const worker = registry.createAssignment({
    taskId, role: 'implementer', identity: identity('deck_alpha_worker'),
    auditRevision: R1, scopeFiles: ['src/exact.ts'],
  });
  if (!worker.ok) throw new Error(worker.reason);
  const assignmentId = worker.value.assignmentId;
  expect(registry.applyTaskIntent({
    taskId, assignmentId, intent: 'start', toStatus: 'implementing',
  })).toMatchObject({ ok: true });
  expect(registry.applyTaskIntent({ expectedRevision: R1,
    taskId, assignmentId, intent: 'record_validation', toStatus: 'validated', validationState: 'passed',
  })).toMatchObject({ ok: true });
  expect(registry.getAssignment(assignmentId)).toMatchObject({
    status: 'validated', validationState: 'passed', auditRevision: R1,
  });
  return { registry, database, taskId, assignmentId, worker: worker.value };
}

function rebindToR2(fixture: ReturnType<typeof validatedAtR1>) {
  const rebound = fixture.registry.rebindTaskAssignmentRevision({
    taskId: fixture.taskId, assignmentId: fixture.assignmentId,
    fromRevision: R1, toRevision: R2,
    worktreeSnapshot: snapshot(),
    leaseAction: 'renew', idempotencyKey: 'bind-successor-r2',
    reason: 'Brain binds the successor revision in place',
  });
  expect(rebound).toMatchObject({ ok: true, value: { status: 'implementing', currentRevision: R2 } });
}

describe('validation is bound to the exact revision it attested', () => {
  it('does not carry R1 validation onto an R2 rebind, so convergence cannot freeze R2 early', async () => {
    const fixture = validatedAtR1();
    rebindToR2(fixture);

    const task = fixture.registry.getTaskRecord(fixture.taskId)!;
    const assignment = fixture.registry.getAssignment(fixture.assignmentId)!;
    expect(task.validationState).toBeUndefined();
    expect(assignment.validationState).toBeUndefined();
    expect(assignment).toMatchObject({ status: 'implementing', auditRevision: R2 });

    // The reported accident: the very next convergence tick projected FINISHED.
    await fixture.registry.convergeLifecycle(Date.now());
    await fixture.registry.convergeValidatedAssignment(fixture.assignmentId);
    expect(fixture.registry.getAssignment(fixture.assignmentId)).toMatchObject({
      status: 'implementing', auditRevision: R2,
    });
    expect(fixture.registry.getTaskRecord(fixture.taskId)!.status).toBe('implementing');
  });

  it('refuses FINISHED at R2 until R2 itself is validated, then accepts it', () => {
    const fixture = validatedAtR1('tsk_validation_binding_finish');
    rebindToR2(fixture);

    expect(fixture.registry.finishAssignment({
      assignmentId: fixture.assignmentId, identity: fixture.worker.identity, revision: R2,
    }).ok).toBe(false);

    expect(fixture.registry.applyTaskIntent({ expectedRevision: R2,
      taskId: fixture.taskId, assignmentId: fixture.assignmentId,
      intent: 'record_validation', toStatus: 'validated', validationState: 'passed',
    })).toMatchObject({ ok: true });
    expect(fixture.registry.getAssignment(fixture.assignmentId)).toMatchObject({
      validationState: 'passed', validatedRevision: R2,
    });
    expect(fixture.registry.finishAssignment({
      assignmentId: fixture.assignmentId, identity: fixture.worker.identity, revision: R2,
    })).toMatchObject({ ok: true });
  });

  it('stamps validation with the revision it attested', () => {
    const fixture = validatedAtR1('tsk_validation_binding_stamp');
    expect(fixture.registry.getAssignment(fixture.assignmentId)).toMatchObject({ validatedRevision: R1 });
    expect(fixture.registry.getTaskRecord(fixture.taskId)).toMatchObject({
      validationState: 'passed', validatedRevision: R1,
    });
  });

  it('clears validation on the ordinary assignment revision update path too (not only Brain rebind)', async () => {
    const fixture = validatedAtR1('tsk_validation_binding_update');
    // Same class, different writer: the owner-facing revision update that first
    // binds a successor. The write boundary must clear it without a call-site reset.
    const current = fixture.registry.getAssignment(fixture.assignmentId)!;
    rewriteAssignment(fixture.database, { ...current, status: 'rework', updatedAt: current.updatedAt + 1 });
    const task = fixture.registry.getTaskRecord(fixture.taskId)!;
    rewriteTask(fixture.database, { ...task, status: 'rework', updatedAt: task.updatedAt + 1 });
    expect(fixture.registry.updateAssignment({
      assignmentId: fixture.assignmentId, identity: fixture.worker.identity, revision: R2, auditRevision: R2,
    })).toMatchObject({ ok: true });
    expect(fixture.registry.getAssignment(fixture.assignmentId)?.validationState).toBeUndefined();
    expect(fixture.registry.getTaskRecord(fixture.taskId)?.currentRevision).toBe(R2);
    expect(fixture.registry.getTaskRecord(fixture.taskId)?.validationState).toBeUndefined();
    await fixture.registry.convergeLifecycle(Date.now());
    expect(fixture.registry.getAssignment(fixture.assignmentId)?.status).toBe('rework');
  });

  it('never projects an implementing/rework object forward on a legacy unstamped outcome', async () => {
    for (const status of ['implementing', 'rework'] as const) {
      const fixture = validatedAtR1(`tsk_validation_binding_legacy_${status}`);
      const assignment = fixture.registry.getAssignment(fixture.assignmentId)!;
      const { validatedRevision: _a, ...legacyAssignment } = assignment;
      rewriteAssignment(fixture.database, {
        ...legacyAssignment, status, auditRevision: R1, updatedAt: assignment.updatedAt + 1,
      } as PersistedSupervisionTaskAssignment);
      const task = fixture.registry.getTaskRecord(fixture.taskId)!;
      const { validatedRevision: _t, ...legacyTask } = task;
      rewriteTask(fixture.database, {
        ...legacyTask, status, updatedAt: task.updatedAt + 1,
      } as PersistedSupervisionTaskRecord);

      expect(fixture.registry.finishAssignment({
        assignmentId: fixture.assignmentId, identity: fixture.worker.identity, revision: R1,
      }).ok, status).toBe(false);
      const eventCount = fixture.registry.listEvents(fixture.taskId).length;
      const actions = await fixture.registry.convergeLifecycle(Date.now());
      expect(actions.map((action) => action.action), status).not.toContain('project_validated_handoff');
      expect(fixture.registry.listEvents(fixture.taskId), status).toHaveLength(eventCount);
      expect(fixture.registry.getAssignment(fixture.assignmentId)?.status, status).toBe(status);
    }
  });

  it('still converges a legacy unstamped outcome whose status is already validated (compatibility)', async () => {
    const fixture = validatedAtR1('tsk_validation_binding_legacy_validated');
    const assignment = fixture.registry.getAssignment(fixture.assignmentId)!;
    const { validatedRevision: _a, ...legacyAssignment } = assignment;
    rewriteAssignment(fixture.database, legacyAssignment as PersistedSupervisionTaskAssignment);
    const task = fixture.registry.getTaskRecord(fixture.taskId)!;
    const { validatedRevision: _t, ...legacyTask } = task;
    rewriteTask(fixture.database, legacyTask as PersistedSupervisionTaskRecord);

    const actions = await fixture.registry.convergeLifecycle(Date.now());
    expect(actions.map((action) => action.action)).toContain('project_validated_handoff');
    expect(fixture.registry.getAssignment(fixture.assignmentId)?.status).toBe('ready_for_audit');
  });

  it('aligns a legacy unstamped validated revision split and stamps the aggregate with the new revision', async () => {
    const fixture = validatedAtR1('tsk_validation_binding_split');
    const assignment = fixture.registry.getAssignment(fixture.assignmentId)!;
    const { validatedRevision: _a, ...legacyAssignment } = assignment;
    rewriteAssignment(fixture.database, {
      ...legacyAssignment, auditRevision: R2, updatedAt: assignment.updatedAt + 1,
    } as PersistedSupervisionTaskAssignment);
    const task = fixture.registry.getTaskRecord(fixture.taskId)!;
    const { validatedRevision: _t, ...legacyTask } = task;
    rewriteTask(fixture.database, {
      ...legacyTask, status: 'validated', currentRevision: R1, updatedAt: task.updatedAt + 1,
    } as PersistedSupervisionTaskRecord);

    const actions = await fixture.registry.convergeLifecycle(Date.now());
    expect(actions.map((action) => action.action)).toContain('align_validated_revision');
    expect(fixture.registry.getTaskRecord(fixture.taskId)).toMatchObject({
      currentRevision: R2, validationState: 'passed', validatedRevision: R2,
    });
  });

  it('keeps a stamped successor validation across a daemon restart and rejects the predecessor stamp', async () => {
    const database = new DatabaseSync(':memory:');
    const fixture = validatedAtR1('tsk_validation_binding_restart', database);
    rebindToR2(fixture);
    expect(fixture.registry.applyTaskIntent({ expectedRevision: R2,
      taskId: fixture.taskId, assignmentId: fixture.assignmentId,
      intent: 'record_validation', toStatus: 'validated', validationState: 'passed',
    })).toMatchObject({ ok: true });

    // A fresh registry over the same persisted rows is the restart boundary.
    const restarted = new SupervisionTaskRegistry({ database });
    expect(restarted.getAssignment(fixture.assignmentId)).toMatchObject({
      validationState: 'passed', validatedRevision: R2, auditRevision: R2,
    });
    expect(restarted.getTaskRecord(fixture.taskId)).toMatchObject({ validatedRevision: R2, currentRevision: R2 });
    const actions = await restarted.convergeLifecycle(Date.now());
    expect(actions.map((action) => action.action)).toContain('project_validated_handoff');
    expect(restarted.getAssignment(fixture.assignmentId)?.status).toBe('ready_for_audit');
  });

  it('is idempotent across a duplicate rebind replay and repeated convergence ticks', async () => {
    const fixture = validatedAtR1('tsk_validation_binding_replay');
    rebindToR2(fixture);
    // Exact replay of the same Brain call must not resurrect the old outcome.
    expect(fixture.registry.rebindTaskAssignmentRevision({
      taskId: fixture.taskId, assignmentId: fixture.assignmentId,
      fromRevision: R1, toRevision: R2, worktreeSnapshot: snapshot(),
      leaseAction: 'renew', idempotencyKey: 'bind-successor-r2',
      reason: 'Brain binds the successor revision in place',
    }).ok).toBe(true);
    for (let tick = 0; tick < 3; tick += 1) {
      await fixture.registry.convergeLifecycle(Date.now() + tick);
    }
    expect(fixture.registry.getAssignment(fixture.assignmentId)).toMatchObject({
      status: 'implementing', auditRevision: R2,
    });
    expect(fixture.registry.getAssignment(fixture.assignmentId)?.validationState).toBeUndefined();
  });
});

describe('revision-bound validation primitives', () => {
  it('clears only on a change between two defined revisions without a matching stamp', () => {
    const passed = { validationState: 'passed', validatedRevision: R1 };
    expect(bindValidationToRevision(R1, R1, passed)).toEqual(passed);
    expect(bindValidationToRevision(R1, R2, passed)).toEqual({});
    expect(bindValidationToRevision(R1, R2, { validationState: 'passed', validatedRevision: R2 }))
      .toEqual({ validationState: 'passed', validatedRevision: R2 });
    expect(bindValidationToRevision(R1, R2, { validationState: 'passed' })).toEqual({});
    expect(bindValidationToRevision(R1, R2, { validationState: 'failed', validatedRevision: R1 })).toEqual({});
    // First bind of a revision onto the validated object keeps its outcome.
    expect(bindValidationToRevision(undefined, R1, { validationState: 'passed' }))
      .toEqual({ validationState: 'passed' });
  });

  it('attests a revision only by exact stamp, and legacy only when allowed', () => {
    expect(validationAttestsRevision({ validationState: 'passed', validatedRevision: R2 }, R2, false)).toBe(true);
    expect(validationAttestsRevision({ validationState: 'passed', validatedRevision: R1 }, R2, true)).toBe(false);
    expect(validationAttestsRevision({ validationState: 'passed' }, R2, false)).toBe(false);
    expect(validationAttestsRevision({ validationState: 'passed' }, R2, true)).toBe(true);
    expect(validationAttestsRevision({ validationState: 'failed', validatedRevision: R2 }, R2, true)).toBe(false);
  });
});

/**
 * Concurrency: every read-decide-write registry operation is serialized against
 * other connections.
 *
 * Audit auto-audit-b870aa76 P1-1: record_validation / FINISHED decided from rows
 * read before BEGIN IMMEDIATE and wrote them over a committed R1→R2 successor.
 * Audit auto-audit-30e3d626 P1-1: restart identity convergence wrote a stale
 * assignment row before the lock (partial write on a refused intent). P1-2: a
 * stale FINISHED replay answered ok from pre-lock rows.
 *
 * Two real SQLite connections share one file. Connection A is the registry under
 * test; its prepared statements can be paused IMMEDIATELY AFTER a read returns
 * (the exact window the counterexamples used), or at its outer BEGIN IMMEDIATE.
 * Connection B is a second writer with busy_timeout 0.
 */
describe('registry operations are atomic against a concurrent connection', () => {
  const ROTATED = { sessionInstanceId: 'instance-rotated', runtimeEpoch: 'epoch-rotated' };

  function twoConnections(taskId: string) {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-validation-race-'));
    const dbPath = join(dir, 'supervision.db');
    const databaseA = new DatabaseSync(dbPath);
    const fixture = validatedAtR1(taskId, databaseA);
    // Second writer: a registry for semantic writes and a raw handle, both with
    // no busy wait so exclusion surfaces as an immediate SQLITE_BUSY.
    const registryB = new SupervisionTaskRegistry({ database: new DatabaseSync(dbPath), busyTimeoutMs: 0 } as never);
    const rawB = new DatabaseSync(dbPath);
    let atBegin: (() => void) | undefined;
    let afterRead: { match: string; fn: () => void } | undefined;
    const originalExec = databaseA.exec.bind(databaseA);
    (databaseA as { exec: (sql: string) => void }).exec = (sql: string) => {
      if (atBegin && sql.trim().toUpperCase() === 'BEGIN IMMEDIATE') {
        const interleave = atBegin;
        atBegin = undefined;
        interleave();
      }
      return originalExec(sql);
    };
    const originalPrepare = databaseA.prepare.bind(databaseA);
    (databaseA as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      if (!afterRead || !sql.includes(afterRead.match)) return statement;
      return new Proxy(statement, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (typeof value !== 'function') return value;
          if (property !== 'get' && property !== 'all') return (value as (...a: unknown[]) => unknown).bind(target);
          return (...args: unknown[]) => {
            const row = (value as (...a: unknown[]) => unknown).apply(target, args);
            const hook = afterRead;
            if (hook && sql.includes(hook.match)) {
              afterRead = undefined;
              hook.fn();
            }
            return row;
          };
        },
      });
    };
    /** Byte-level durable state read on a separate raw connection. */
    const raw = () => {
      const reader = new DatabaseSync(dbPath);
      const task = reader.prepare('SELECT status, current_revision, validation_state, payload_json FROM supervision_tasks WHERE task_id = ?').get(taskId);
      const assignment = reader.prepare('SELECT status, audit_revision, validation_state, lease_id, generation, payload_json FROM supervision_task_assignments WHERE assignment_id = ?').get(fixture.assignmentId);
      const events = reader.prepare('SELECT COUNT(*) AS n FROM supervision_task_events WHERE task_id = ?').get(taskId) as { n: number };
      reader.close();
      return JSON.stringify({ task, assignment, events: events.n });
    };
    const durable = () => {
      const fresh = new SupervisionTaskRegistry({ database: new DatabaseSync(dbPath) });
      return {
        task: fresh.getTaskRecord(taskId)!,
        assignment: fresh.getAssignment(fixture.assignmentId)!,
        events: fresh.listEvents(taskId).length,
      };
    };
    const rebindOnB = (key: string) => registryB.rebindTaskAssignmentRevision({
      taskId, assignmentId: fixture.assignmentId, fromRevision: R1, toRevision: R2,
      worktreeSnapshot: snapshot(), leaseAction: 'renew',
      idempotencyKey: key, reason: 'concurrent Brain successor bind',
    });
    /** Raw successor commit on B touching BOTH rows (task + assignment → R2). */
    const rawSuccessorOnB = (status: string) => {
      const taskRow = rawB.prepare('SELECT payload_json AS p FROM supervision_tasks WHERE task_id = ?').get(taskId) as { p: string };
      const ownerRow = rawB.prepare('SELECT payload_json AS p FROM supervision_task_assignments WHERE assignment_id = ?').get(fixture.assignmentId) as { p: string };
      const task = { ...JSON.parse(taskRow.p), status, currentRevision: R2, validationState: undefined, validatedRevision: undefined };
      const owner = { ...JSON.parse(ownerRow.p), status, auditRevision: R2, validationState: undefined, validatedRevision: undefined };
      rawB.exec('BEGIN IMMEDIATE');
      try {
        rawB.prepare('UPDATE supervision_tasks SET status = ?, current_revision = ?, validation_state = NULL, payload_json = ? WHERE task_id = ?')
          .run(status, R2, JSON.stringify(task), taskId);
        rawB.prepare('UPDATE supervision_task_assignments SET status = ?, audit_revision = ?, validation_state = NULL, payload_json = ? WHERE assignment_id = ?')
          .run(status, R2, JSON.stringify(owner), fixture.assignmentId);
        rawB.exec('COMMIT');
      } catch (error) {
        try { rawB.exec('ROLLBACK'); } catch { /* BEGIN itself was refused */ }
        throw error;
      }
    };
    const attempt = (fn: () => unknown): { threw: boolean; error?: string } => {
      try {
        fn();
        return { threw: false };
      } catch (error) {
        return { threw: true, error: error instanceof Error ? error.message : String(error) };
      }
    };
    return {
      ...fixture, dbPath, registryB, durable, raw, rebindOnB, rawSuccessorOnB, attempt,
      atBegin: (fn: () => void) => { atBegin = fn; },
      afterRead: (match: string, fn: () => void) => { afterRead = { match, fn }; },
      fired: () => atBegin === undefined && afterRead === undefined,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it('excludes a successor rebind from the identity-convergence window of record_validation', () => {
    const race = twoConnections('tsk_race_identity_validation');
    try {
      let concurrent: ReturnType<typeof race.attempt> | undefined;
      // Pause A right after it READ the assignment for identity convergence.
      race.afterRead('FROM supervision_task_assignments', () => {
        concurrent = race.attempt(() => {
          const rebound = race.rebindOnB('race-identity-rebind');
          if (!rebound.ok) throw new Error(rebound.reason);
        });
      });
      const result = race.registry.applyTaskIntent({ expectedRevision: R1,
        taskId: race.taskId, assignmentId: race.assignmentId,
        intent: 'record_validation', toStatus: 'validated', validationState: 'passed',
        identity: { ...race.worker.identity, ...ROTATED },
      });
      expect(race.fired()).toBe(true);
      expect(concurrent, 'the successor writer must be excluded while A decides').toMatchObject({ threw: true });
      expect(concurrent!.error).toMatch(/locked|busy/i);
      expect(result).toMatchObject({ ok: true });
      const after = race.durable();
      // Coherent: task and assignment still name ONE revision; identity converged.
      expect(after.task.currentRevision).toBe(R1);
      expect(after.assignment.auditRevision).toBe(R1);
      expect(after.assignment.identity).toMatchObject(ROTATED);

      // Once A committed, the successor proceeds and nothing stale resurfaces.
      expect(race.rebindOnB('race-identity-rebind')).toMatchObject({ ok: true });
      const successor = race.durable();
      expect(successor.task).toMatchObject({ currentRevision: R2, status: 'implementing' });
      expect(successor.assignment).toMatchObject({ auditRevision: R2, status: 'implementing' });
      expect(successor.assignment.validationState).toBeUndefined();
    } finally {
      race.cleanup();
    }
  });

  it('leaves durable state byte-identical when an identity-converging intent is refused against a committed successor', () => {
    const race = twoConnections('tsk_race_identity_refused');
    try {
      let afterSuccessor = '';
      race.atBegin(() => {
        expect(race.rebindOnB('race-refused-rebind')).toMatchObject({ ok: true });
        afterSuccessor = race.raw();
      });
      // open_audit from `implementing` at R2 is not a legal edge from a rotated
      // caller holding R1 expectations; the refusal must not leave a partial write.
      const result = race.registry.applyTaskIntent({
        taskId: race.taskId, assignmentId: race.assignmentId,
        intent: 'claim', toStatus: 'validated' as never,
        identity: { ...race.worker.identity, sessionName: 'deck_alpha_intruder' },
      });
      expect(race.fired()).toBe(true);
      expect(result.ok).toBe(false);
      expect(race.raw()).toBe(afterSuccessor);
    } finally {
      race.cleanup();
    }
  });

  it('excludes a successor commit from the FINISHED replay decision window', () => {
    const race = twoConnections('tsk_race_finish_replay_window');
    try {
      expect(race.registry.finishAssignment({
        assignmentId: race.assignmentId, identity: race.worker.identity, revision: R1,
      })).toMatchObject({ ok: true });
      expect(race.durable().assignment).toMatchObject({ status: 'ready_for_audit', auditRevision: R1 });
      let concurrent: ReturnType<typeof race.attempt> | undefined;
      // Pause A right after its first assignment read: the pre-lock row the old
      // replay path answered from.
      race.afterRead('FROM supervision_task_assignments', () => {
        concurrent = race.attempt(() => race.rawSuccessorOnB('ready_for_audit'));
      });
      const replay = race.registry.finishAssignment({
        assignmentId: race.assignmentId, identity: race.worker.identity, revision: R1,
      });
      expect(race.fired()).toBe(true);
      expect(concurrent, 'no successor can commit inside the replay decision').toMatchObject({ threw: true });
      expect(replay).toMatchObject({ ok: true, replay: true });
      expect(race.durable().task.currentRevision).toBe(R1);
    } finally {
      race.cleanup();
    }
  });

  it('refuses a stale FINISHED replay once a successor is durable, with zero change', () => {
    const race = twoConnections('tsk_race_finish_stale_replay');
    try {
      expect(race.registry.finishAssignment({
        assignmentId: race.assignmentId, identity: race.worker.identity, revision: R1,
      })).toMatchObject({ ok: true });
      let afterSuccessor = '';
      race.atBegin(() => {
        race.rawSuccessorOnB('ready_for_audit');
        afterSuccessor = race.raw();
      });
      const stale = race.registry.finishAssignment({
        assignmentId: race.assignmentId, identity: race.worker.identity, revision: R1,
      });
      expect(race.fired()).toBe(true);
      expect(stale).toEqual({ ok: false, reason: 'old_revision' });
      expect(race.raw()).toBe(afterSuccessor);
    } finally {
      race.cleanup();
    }
  });

  it('answers a quiet idempotent FINISHED replay without touching durable bytes', () => {
    const race = twoConnections('tsk_race_finish_quiet_replay');
    try {
      expect(race.registry.finishAssignment({
        assignmentId: race.assignmentId, identity: race.worker.identity, revision: R1,
      })).toMatchObject({ ok: true });
      const before = race.raw();
      expect(race.registry.finishAssignment({
        assignmentId: race.assignmentId, identity: race.worker.identity, revision: R1,
      })).toMatchObject({ ok: true, replay: true });
      expect(race.raw()).toBe(before);
    } finally {
      race.cleanup();
    }
  });

  it('refuses a stale FINISHED at the predecessor revision without rolling R2 back', () => {
    const race = twoConnections('tsk_validation_race_finish');
    try {
      let afterRebind: ReturnType<typeof race.durable> | undefined;
      race.atBegin(() => {
        expect(race.rebindOnB('race-rebind-finish')).toMatchObject({ ok: true });
        afterRebind = race.durable();
      });
      const stale = race.registry.finishAssignment({
        assignmentId: race.assignmentId, identity: race.worker.identity, revision: R1,
      });
      expect(race.fired()).toBe(true);
      expect(stale).toEqual({ ok: false, reason: 'old_revision' });
      const after = race.durable();
      expect(after.task).toEqual(afterRebind!.task);
      expect(after.assignment).toEqual(afterRebind!.assignment);
      expect(after.events).toBe(afterRebind!.events);
      expect(after.task).toMatchObject({ currentRevision: R2, status: 'implementing' });
      expect(after.assignment.leaseId).toBe(afterRebind!.assignment.leaseId);
      expect(after.assignment.leaseId).toBeTruthy();

      // Crash/restart: a fresh registry still refuses R2 FINISHED until R2 is
      // validated, then accepts it once and replays idempotently.
      const restarted = new SupervisionTaskRegistry({ database: new DatabaseSync(race.dbPath) });
      expect(restarted.finishAssignment({
        assignmentId: race.assignmentId, identity: race.worker.identity, revision: R2,
      }).ok).toBe(false);
      expect(restarted.applyTaskIntent({ expectedRevision: R2,
        taskId: race.taskId, assignmentId: race.assignmentId,
        intent: 'record_validation', toStatus: 'validated', validationState: 'passed',
      })).toMatchObject({ ok: true });
      expect(restarted.finishAssignment({
        assignmentId: race.assignmentId, identity: race.worker.identity, revision: R2,
      })).toMatchObject({ ok: true });
      expect(restarted.finishAssignment({
        assignmentId: race.assignmentId, identity: race.worker.identity, revision: R2,
      })).toMatchObject({ ok: true, replay: true });
      expect(race.durable().task).toMatchObject({ currentRevision: R2, status: 'ready_for_audit' });
    } finally {
      race.cleanup();
    }
  });

  it('refuses a stale assignment update that read its row before a committed successor', () => {
    const race = twoConnections('tsk_race_update_assignment');
    try {
      let afterRebind = '';
      race.atBegin(() => {
        expect(race.rebindOnB('race-update-rebind')).toMatchObject({ ok: true });
        afterRebind = race.raw();
      });
      // updateAssignment computes its record from the pre-lock row (validated R1).
      const stale = race.registry.updateAssignment({
        assignmentId: race.assignmentId, identity: race.worker.identity, status: 'ready_for_audit',
      });
      expect(race.fired()).toBe(true);
      expect(stale.ok).toBe(false);
      expect(race.raw()).toBe(afterRebind);
      expect(race.durable().assignment).toMatchObject({ auditRevision: R2, status: 'implementing' });
    } finally {
      race.cleanup();
    }
  });

  it('refuses a stale FINISHED when only the assignment row moved under it', () => {
    const race = twoConnections('tsk_validation_race_assignment_only');
    try {
      let afterMove: ReturnType<typeof race.durable> | undefined;
      race.atBegin(() => {
        const current = race.durable().assignment;
        const { validationState: _v, validatedRevision: _r, ...moved } = current;
        rewriteAssignment(new DatabaseSync(race.dbPath), {
          ...moved, status: 'implementing', auditRevision: R2, updatedAt: current.updatedAt + 1,
        } as PersistedSupervisionTaskAssignment);
        afterMove = race.durable();
      });
      const stale = race.registry.finishAssignment({
        assignmentId: race.assignmentId, identity: race.worker.identity, revision: R1,
      });
      expect(race.fired()).toBe(true);
      expect(stale).toEqual({ ok: false, reason: 'old_revision' });
      const after = race.durable();
      expect(after.task).toEqual(afterMove!.task);
      expect(after.assignment).toEqual(afterMove!.assignment);
      expect(after.events).toBe(afterMove!.events);
    } finally {
      race.cleanup();
    }
  });
});

describe('validation-authority snapshot is enforced under the writer locks', () => {
  function frozenBundle(taskId: string, assignmentId: string) {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-authority-bundle-'));
    const source = join(root, 'source');
    mkdirSync(join(source, 'src'), { recursive: true });
    writeFileSync(join(source, 'src/exact.ts'), 'exact-r2-bytes\n');
    const frozen = freezeSupervisionIntegrationBundle({
      taskId, assignmentId, revision: R2, bundleRoot: join(root, 'bundles'),
      snapshot: {
        worktreePath: source, headSha: 'a'.repeat(40),
        files: [{ path: 'src/exact.ts', sha256: createHash('sha256').update('exact-r2-bytes\n').digest('hex') }],
        stagedPaths: [], conflictedPaths: [], untrackedPaths: [],
      },
    });
    if (!frozen.ok) throw new Error(frozen.reason);
    return { bundle: frozen.bundle, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  function readyAtR2() {
    const fixture = validatedAtR1('tsk_authority_snapshot');
    rebindToR2(fixture);
    expect(fixture.registry.applyTaskIntent({ expectedRevision: R2,
      taskId: fixture.taskId, assignmentId: fixture.assignmentId,
      intent: 'record_validation', toStatus: 'validated', validationState: 'passed',
    })).toMatchObject({ ok: true });
    return fixture;
  }

  it('binds a bundle and materializes an auditor only while the exact snapshot still holds', () => {
    const fixture = readyAtR2();
    const authority = fixture.registry.readyAuditValidationAuthoritySnapshot({
      taskId: fixture.taskId, assignmentId: fixture.assignmentId, revision: R2, allowLegacy: true,
    });
    expect(authority).toBeTruthy();
    expect(fixture.registry.validationAuthoritySnapshotHolds(authority, { taskId: fixture.taskId, revision: R2 })).toBe(true);
    // A snapshot never authorizes a different task or revision.
    expect(fixture.registry.validationAuthoritySnapshotHolds(authority, { taskId: 'other', revision: R2 })).toBe(false);
    expect(fixture.registry.validationAuthoritySnapshotHolds(authority, { taskId: fixture.taskId, revision: R1 })).toBe(false);

    // Revoke after the snapshot was taken.
    expect(fixture.registry.applyTaskIntent({ expectedRevision: R2,
      taskId: fixture.taskId, assignmentId: fixture.assignmentId,
      intent: 'record_validation', toStatus: null, validationState: 'failed',
    })).toMatchObject({ ok: true });
    expect(fixture.registry.validationAuthoritySnapshotHolds(authority, { taskId: fixture.taskId, revision: R2 })).toBe(false);

    const auditor = fixture.registry.createAssignment({
      taskId: fixture.taskId, role: 'auditor', required: false, identity: identity('deck_alpha_auditor'),
      auditAttemptId: 'attempt-revoked', auditRevision: R2, validationAuthority: authority,
    });
    expect(auditor).toEqual({ ok: false, reason: 'stale_audit_revision' });
    expect(fixture.registry.listAssignments(fixture.taskId).filter((a) => a.role === 'auditor')).toEqual([]);

    const frozen = frozenBundle(fixture.taskId, fixture.assignmentId);
    try {
      const bound = fixture.registry.bindIntegrationBundle({
        taskId: fixture.taskId, assignmentId: fixture.assignmentId, identity: fixture.worker.identity,
        revision: R2, bundle: frozen.bundle, validationAuthority: authority!,
      });
      expect(bound).toEqual({ ok: false, reason: 'stale_audit_revision' });
    } finally {
      frozen.cleanup();
    }
    expect(fixture.registry.getTaskRecord(fixture.taskId)!.integrationBundle).toBeUndefined();
  });

  it('materializes the auditor when the snapshot still holds (positive control)', () => {
    const fixture = readyAtR2();
    const authority = fixture.registry.readyAuditValidationAuthoritySnapshot({
      taskId: fixture.taskId, assignmentId: fixture.assignmentId, revision: R2, allowLegacy: true,
    });
    const auditor = fixture.registry.createAssignment({
      taskId: fixture.taskId, role: 'auditor', required: false, identity: identity('deck_alpha_auditor'),
      auditAttemptId: 'attempt-held', auditRevision: R2, validationAuthority: authority,
    });
    expect(auditor).toMatchObject({ ok: true, value: { auditAttemptId: 'attempt-held', auditRevision: R2 } });
    const frozen = frozenBundle(fixture.taskId, fixture.assignmentId);
    try {
      expect(fixture.registry.bindIntegrationBundle({
        taskId: fixture.taskId, assignmentId: fixture.assignmentId, identity: fixture.worker.identity,
        revision: R2, bundle: frozen.bundle, validationAuthority: authority!,
      })).toMatchObject({ ok: true });
      expect(fixture.registry.getTaskRecord(fixture.taskId)!.integrationBundle?.revision).toBe(R2);
    } finally {
      frozen.cleanup();
    }
  });
});

describe('caller revision authority is checked before every FINISHED branch', () => {
  it('never lets a stale caller revision finalize a pushed assignment (branch without its own revision check)', () => {
    const registry = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const taskId = 'tsk_caller_revision_pushed';
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'pushed finish authority', currentRevision: R2,
    })).toMatchObject({ ok: true });
    const worker = registry.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_alpha_worker'),
      auditRevision: R2, scopeFiles: ['src/exact.ts'],
    });
    if (!worker.ok) throw new Error(worker.reason);
    for (const status of [
      'implementing', 'validated', 'ready_for_audit', 'auditing', 'passed',
      'ready_for_integration', 'integrating', 'final_audit', 'passed',
      'finalizing', 'committed', 'pushed',
    ] as const) {
      expect(registry.updateAssignment({
        assignmentId: worker.value.assignmentId, identity: worker.value.identity, status,
      }).ok, status).toBe(true);
    }
    const before = JSON.stringify({ task: registry.get(taskId), events: registry.listEvents(taskId).length });
    for (const stale of [R1, SUPERVISION_UNBOUND_REVISION]) {
      expect(registry.finishAssignment({
        assignmentId: worker.value.assignmentId, identity: worker.value.identity, expectedRevision: stale,
      }), stale).toEqual({ ok: false, reason: 'old_revision' });
    }
    expect(registry.finishAssignment({
      assignmentId: worker.value.assignmentId, identity: worker.value.identity, expectedRevision: '  ',
    })).toEqual({ ok: false, reason: 'invalid' });
    expect(JSON.stringify({ task: registry.get(taskId), events: registry.listEvents(taskId).length })).toBe(before);
    expect(registry.finishAssignment({
      assignmentId: worker.value.assignmentId, identity: worker.value.identity, expectedRevision: R2,
    })).toMatchObject({ ok: true, value: { status: 'finalized' } });
  });
});
