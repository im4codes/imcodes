import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { SupervisionTaskRegistry } from '../../src/daemon/supervision-state-store.js';

/**
 * Evidence-driven archival of stale supervision aggregates.
 *
 * Stale rows accumulate whenever work is redone: an older aggregate is abandoned
 * mid-flight and a successor ships the same change. The old row then sits in the
 * console for ever looking actionable, and a human has to decide every time.
 * Archiving it is only safe on IMMUTABLE evidence -- a finalized successor
 * carrying a real commit -- and only while nothing still references the stale
 * object. CI is optional smoke here and never the authority: a project with no
 * CI configured must still converge.
 *
 * Every successor below is built through the PRODUCTION path (createAssignment
 * -> status walk -> finishAssignment -> finalizeIntegration). Fabricating a
 * finalized row directly would mean these rules were never exercised against
 * real finalization authority.
 */
const OBJECTIVE = 'superseded work';
const FAMILY = 'tsk_family';

function identity(sessionName: string, agentType = 'claude-code-sdk', providerFamily = 'anthropic') {
  return {
    sessionName,
    sessionInstanceId: `${sessionName}-instance`,
    runtimeEpoch: `${sessionName}-epoch`,
    agentType,
    providerFamily,
  };
}

function registry() {
  return new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') } as never);
}

/** Rewrite a persisted row's payload_json, simulating data written by an older build. */
function rewriteAssignmentStatus(
  db: InstanceType<typeof DatabaseSync>,
  assignmentId: string,
  status: string,
): void {
  const row = db.prepare(
    'SELECT payload_json AS payloadJson FROM supervision_task_assignments WHERE assignment_id = ?',
  ).get(assignmentId) as { payloadJson: string };
  const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
  payload.status = status;
  db.prepare('UPDATE supervision_task_assignments SET status = ?, payload_json = ? WHERE assignment_id = ?')
    .run(status, JSON.stringify(payload), assignmentId);
}

/** Persist a finalization commit exactly as a historical/looser build might have. */
function rewriteFinalizationCommit(
  db: InstanceType<typeof DatabaseSync>,
  taskId: string,
  commitSha: unknown,
): void {
  const row = db.prepare(
    'SELECT payload_json AS payloadJson FROM supervision_tasks WHERE task_id = ?',
  ).get(taskId) as { payloadJson: string };
  const payload = JSON.parse(row.payloadJson) as { finalization?: Record<string, unknown> };
  if (payload.finalization) payload.finalization.commitSha = commitSha;
  db.prepare('UPDATE supervision_tasks SET payload_json = ? WHERE task_id = ?')
    .run(JSON.stringify(payload), taskId);
}

/** Clone a finalized task row under a new id, as a second valid successor. */
function cloneFinalizedTask(
  db: InstanceType<typeof DatabaseSync>,
  fromTaskId: string,
  toTaskId: string,
): void {
  const row = db.prepare(
    `SELECT project_name AS projectName, top_level_task_id AS topLevelTaskId,
            classification, validation_state AS validationState, status,
            current_revision AS currentRevision, commit_sha AS commitSha,
            push_remote_ref AS pushRemoteRef, blocker, payload_json AS payloadJson,
            created_at AS createdAt, updated_at AS updatedAt
       FROM supervision_tasks WHERE task_id = ?`,
  ).get(fromTaskId) as Record<string, unknown>;
  const payload = JSON.parse(row.payloadJson as string) as Record<string, unknown>;
  payload.taskId = toTaskId;
  db.prepare(
    `INSERT INTO supervision_tasks
       (task_id, project_name, top_level_task_id, classification, validation_state, status,
        current_revision, commit_sha, push_remote_ref, blocker, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    toTaskId, row.projectName, row.topLevelTaskId, row.classification, row.validationState,
    row.status, row.currentRevision, row.commitSha, row.pushRemoteRef, row.blocker,
    JSON.stringify(payload), row.createdAt, row.updatedAt,
  );
}

/**
 * A database whose FIRST `BEGIN IMMEDIATE` runs `onBegin` first. That is the
 * exact pre-BEGIN moment the archive contract cares about: everything the
 * planner decided is now potentially stale, so the transaction must re-read and
 * re-plan before it writes anything.
 */
function racingDatabase(real: InstanceType<typeof DatabaseSync>, onBegin: () => void) {
  let armed = true;
  return new Proxy(real as never, {
    get(target: never, prop: string | symbol, receiver: unknown) {
      if (prop === 'exec') {
        return (sql: string) => {
          if (armed && sql.includes('BEGIN IMMEDIATE')) {
            armed = false;
            onBegin();
          }
          return (target as never as { exec: (q: string) => unknown }).exec(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as InstanceType<typeof DatabaseSync>;
}

/** A stale, non-terminal aggregate: one cancelled implementer, no live lease. */
function staleTask(r: SupervisionTaskRegistry, taskId = 'tsk_stale') {
  expect(r.createOrGet({
    taskId, projectName: 'cd', topLevelTaskId: FAMILY,
    classification: 'integration_task', objective: OBJECTIVE,
  } as never)).toMatchObject({ ok: true });
  const impl = r.createAssignment({
    taskId, role: 'implementer', identity: identity('deck_sub_old'), required: true, scopeFiles: [],
  } as never);
  if (!impl.ok) throw new Error(impl.reason);
  expect(r.applyTaskIntent({
    taskId, assignmentId: impl.value.assignmentId, intent: 'cancel',
    toStatus: 'cancelled', identity: impl.value.identity,
  } as never)).toMatchObject({ ok: true });
  return { taskId, impl: impl.value };
}

/** A genuinely finalized successor in the same family, via the production path. */
function finalizedSuccessor(
  r: SupervisionTaskRegistry,
  taskId = 'tsk_successor',
  options: { files?: string[]; commitSha?: string; withCi?: boolean } = {},
) {
  const revision = `${taskId}-r1`;
  const attemptId = `${taskId}-audit`;
  const files = [...(options.files ?? ['src/shipped.ts'])].sort();
  const commitSha = options.commitSha ?? 'a'.repeat(40);
  const ownerIdentity = identity(`${taskId}-owner`);
  const implIdentity = identity(`${taskId}-worker`);
  const auditorIdentity = identity(`${taskId}-auditor`, 'codex-sdk', 'openai');
  expect(r.createOrGet({
    taskId, projectName: 'cd', topLevelTaskId: FAMILY,
    classification: 'integration_task', objective: OBJECTIVE, currentRevision: revision,
  } as never)).toMatchObject({ ok: true });
  const owner = r.createAssignment({
    taskId, role: 'integration_owner', identity: ownerIdentity, scopeFiles: files,
    auditAttemptId: attemptId, auditRevision: revision,
  } as never);
  const impl = r.createAssignment({
    taskId, role: 'implementer', identity: implIdentity, scopeFiles: files,
    auditAttemptId: attemptId, auditRevision: revision,
  } as never);
  const auditor = r.createAssignment({
    taskId, role: 'auditor', identity: auditorIdentity, required: false,
    auditAttemptId: attemptId, auditRevision: revision,
  } as never);
  if (!owner.ok || !impl.ok || !auditor.ok) throw new Error('successor setup failed');
  for (const [index, path] of files.entries()) {
    expect(r.recordFileEvent({
      assignmentId: impl.value.assignmentId, identity: impl.value.identity,
      path, operation: 'modify', idempotencyKey: `${taskId}-file-${index}`,
    } as never)).toMatchObject({ ok: true });
  }
  for (const target of [owner.value, impl.value]) {
    for (const status of ['implementing', 'validated', 'ready_for_audit', 'auditing', 'passed', 'ready_for_integration'] as const) {
      expect(r.updateAssignment({
        assignmentId: target.assignmentId, identity: target.identity, status,
        revision, auditAttemptId: attemptId, auditRevision: revision,
        ...(status === 'passed' || status === 'ready_for_integration'
          ? { verdict: 'PASS', crossVendorAuditPassed: true } : {}),
      } as never)).toMatchObject({ ok: true });
    }
  }
  for (const status of ['auditing', 'passed'] as const) {
    expect(r.updateAssignment({
      assignmentId: auditor.value.assignmentId, identity: auditor.value.identity, status,
      auditAttemptId: attemptId, auditRevision: revision,
      ...(status === 'passed' ? { verdict: 'PASS', crossVendorAuditPassed: true } : {}),
    } as never)).toMatchObject({ ok: true });
  }
  for (const target of [auditor.value, impl.value, owner.value]) {
    expect(r.finishAssignment({
      assignmentId: target.assignmentId, identity: target.identity, revision,
    } as never)).toMatchObject({ ok: true });
  }
  expect(r.finalizeIntegration({
    assignmentId: owner.value.assignmentId, identity: ownerIdentity,
    revision, auditAttemptId: attemptId, auditRevision: revision, verdict: 'PASS',
    ownedFiles: files,
    integrationManifest: files.map((path, index) => ({
      path, sha256: ((index + 1) % 10).toString().repeat(64),
    })),
    integrationOwner: ownerIdentity.sessionName,
    commitSha, pushResult: 'pushed', pushRemoteRef: 'refs/heads/dev',
    stagedPaths: files, conflictedPaths: [], untrackedOtherOwnerPaths: [],
    // CI is OPTIONAL smoke. Omitted entirely unless a test asks for it, which
    // also exercises the rule that absent CI forbids the external run fields.
    ...(options.withCi ? {
      externalRunId: '33287386936', externalHeadSha: 'a'.repeat(40),
      externalTaskId: 'ci-node24', ciResult: 'success' as const,
    } : {}),
  } as never)).toMatchObject({ ok: true, value: { status: 'finalized' } });
  return taskId;
}

function sweep(r: SupervisionTaskRegistry, now = Date.now()) {
  return r.reconcileHousekeeping({ mode: 'apply', projectName: 'cd', now } as never);
}

describe('stale-aggregate archival on immutable finalized-successor evidence', () => {
  it('archives a stale aggregate whose successor finalized with a real commit', () => {
    const r = registry();
    const { taskId } = staleTask(r);
    finalizedSuccessor(r);

    const result = sweep(r);

    expect(result.actions.some((action: { taskId: string; kind: string }) => (
      action.taskId === taskId && action.kind === 'archive_superseded'
    ))).toBe(true);
    const archived = r.getTaskRecord(taskId)!;
    expect(archived.archivedAt).toBeTruthy();
    expect(archived.archiveReason).toBe('superseded');
    expect(archived.supersededBy).toBe('tsk_successor');
  });

  it('archives with NO CI recorded at all, because CI is optional smoke', () => {
    const r = registry();
    const { taskId } = staleTask(r);
    finalizedSuccessor(r, 'tsk_successor', { withCi: false });

    sweep(r);

    expect(r.getTaskRecord(taskId)!.archiveReason).toBe('superseded');
  });

  it('is idempotent across repeated sweeps', () => {
    const r = registry();
    const { taskId } = staleTask(r);
    finalizedSuccessor(r);
    sweep(r, 1_000);
    const archivedAt = r.getTaskRecord(taskId)!.archivedAt;
    const events = r.listEvents(taskId).length;

    sweep(r, 61_000);
    sweep(r, 121_000);

    expect(r.getTaskRecord(taskId)!.archivedAt).toBe(archivedAt);
    expect(r.listEvents(taskId).length).toBe(events);
  });

  it('fails closed while an active assignment still references the stale aggregate', () => {
    const r = registry();
    const { taskId } = staleTask(r);
    const live = r.createAssignment({
      taskId, role: 'implementer', identity: identity('deck_sub_live'), required: true, scopeFiles: [],
    } as never);
    if (!live.ok) throw new Error(live.reason);
    finalizedSuccessor(r);

    sweep(r);

    expect(r.getTaskRecord(taskId)!.archivedAt ?? null).toBeNull();
  });

  it('fails closed when the stale aggregate holds bytes the successor never integrated', () => {
    const r = registry();
    const { taskId, impl } = staleTask(r);
    expect(r.recordFileEvent({
      assignmentId: impl.assignmentId, identity: impl.identity,
      path: 'src/never-shipped.ts', operation: 'modify',
    } as never)).toMatchObject({ ok: true });
    finalizedSuccessor(r, 'tsk_successor', { files: ['src/shipped.ts'] });

    sweep(r);

    // Those bytes were never integrated by anyone. Hiding the only record of
    // them is how work silently disappears.
    expect(r.getTaskRecord(taskId)!.archivedAt ?? null).toBeNull();
  });

  it('archives when the stale bytes ARE covered by the successor manifest', () => {
    // The positive counterpart, so the byte rule is a real comparison rather
    // than "any file event blocks archival".
    const r = registry();
    const { taskId, impl } = staleTask(r);
    expect(r.recordFileEvent({
      assignmentId: impl.assignmentId, identity: impl.identity,
      path: 'src/shipped.ts', operation: 'modify',
    } as never)).toMatchObject({ ok: true });
    finalizedSuccessor(r, 'tsk_successor', { files: ['src/shipped.ts'] });

    sweep(r);

    expect(r.getTaskRecord(taskId)!.archiveReason).toBe('superseded');
  });

  it('never labels a task that SHIPPED ITSELF as superseded', () => {
    // A task carrying its own finalization and commit was not superseded by
    // anyone -- it shipped. Terminal retention owns that row. Archiving it as
    // `superseded` would misattribute its own delivery to a sibling and lose
    // the fact that it landed on its own.
    const r = registry();
    const shipped = finalizedSuccessor(r, 'tsk_shipped_itself');
    finalizedSuccessor(r, 'tsk_sibling_shipped');

    sweep(r);

    expect(r.getTaskRecord(shipped)!.archiveReason ?? null).not.toBe('superseded');
    expect(r.getTaskRecord(shipped)!.supersededBy ?? null).toBeNull();
  });

  it('writes nothing when an active reference appears between planning and the write', () => {
    // The planner decides on a snapshot; the write happens later. If a worker
    // claims the aggregate in that window, the plan is already wrong. Archiving
    // on it would hide a row something is actively working on, and the console
    // would simply lose it. The transaction must re-read and re-plan the FULL
    // evidence, not just re-check archivedAt.
    const db = new DatabaseSync(':memory:');
    const r = new SupervisionTaskRegistry({ database: db } as never);
    const { taskId, impl } = staleTask(r);
    finalizedSuccessor(r);

    // Race: the moment the archive transaction opens, the cancelled implementer
    // is back to `implementing` -- an active reference the plan never saw.
    const racing = new SupervisionTaskRegistry({
      database: racingDatabase(db, () => rewriteAssignmentStatus(db, impl.assignmentId, 'implementing')),
    } as never);
    racing.reconcileHousekeeping({ mode: 'apply', projectName: 'cd', now: Date.now() } as never);

    expect(r.getTaskRecord(taskId)!.archivedAt ?? null).toBeNull();
    expect(r.getTaskRecord(taskId)!.supersededBy ?? null).toBeNull();
  });

  it('writes nothing when the re-plan names a DIFFERENT successor than the plan did', () => {
    // Re-planning is not enough on its own: it must still name the SAME
    // successor the plan named. Here the planned successor is disqualified in
    // the race window and a different valid one appears, so the aggregate is
    // arguably still superseded -- but by somebody else. Archiving would then
    // record `supersededBy` pointing at the task the plan chose, which is now
    // simply the wrong attribution.
    const db = new DatabaseSync(':memory:');
    const r = new SupervisionTaskRegistry({ database: db } as never);
    const { taskId } = staleTask(r);
    const planned = finalizedSuccessor(r, 'tsk_successor_a');

    const racing = new SupervisionTaskRegistry({
      database: racingDatabase(db, () => {
        // The planned successor stops being valid evidence...
        rewriteFinalizationCommit(db, planned, 'not-a-commit');
        // ...and a different, genuinely finalized one takes its place.
        cloneFinalizedTask(db, planned, 'tsk_successor_b');
        rewriteFinalizationCommit(db, 'tsk_successor_b', 'c'.repeat(40));
      }),
    } as never);
    racing.reconcileHousekeeping({ mode: 'apply', projectName: 'cd', now: Date.now() } as never);

    expect(r.getTaskRecord(taskId)!.archivedAt ?? null).toBeNull();
    expect(r.getTaskRecord(taskId)!.supersededBy ?? null).toBeNull();
  });

  it('refuses a persisted finalization whose commit is malformed or historical', () => {
    // Rows written by older builds are not guaranteed to hold a real object id.
    // Only a genuine 40-char lowercase commit may authorize supersession; a
    // short, uppercase, or non-hex value names nothing that can be verified.
    for (const badCommit of ['abc123', 'A'.repeat(40), 'z'.repeat(40), '', 42]) {
      const db = new DatabaseSync(':memory:');
      const r = new SupervisionTaskRegistry({ database: db } as never);
      const { taskId } = staleTask(r);
      const successor = finalizedSuccessor(r);
      rewriteFinalizationCommit(db, successor, badCommit);

      r.reconcileHousekeeping({ mode: 'apply', projectName: 'cd', now: Date.now() } as never);

      expect(r.getTaskRecord(taskId)!.archivedAt ?? null, `commit=${String(badCommit)}`).toBeNull();
      r.close();
    }
  });

  it('does not treat an UNFINISHED sibling as successor evidence', () => {
    // Distinct from "no successor at all": here a sibling with the same
    // objective exists in the family but has shipped nothing. Only finalization
    // with a real commit is immutable evidence; anything in flight can still
    // fail, and archiving against it would hide a row whose work was never
    // actually superseded.
    const r = registry();
    const { taskId } = staleTask(r);
    expect(r.createOrGet({
      taskId: 'tsk_inflight', projectName: 'cd', topLevelTaskId: FAMILY,
      classification: 'integration_task', objective: OBJECTIVE,
    } as never)).toMatchObject({ ok: true });

    sweep(r);

    expect(r.getTaskRecord(taskId)!.archivedAt ?? null).toBeNull();
  });

  it('fails closed when two finalized successors disagree on the commit', () => {
    const r = registry();
    const { taskId } = staleTask(r);
    finalizedSuccessor(r, 'tsk_successor_a', { commitSha: 'a'.repeat(40) });
    finalizedSuccessor(r, 'tsk_successor_b', { commitSha: 'b'.repeat(40) });

    sweep(r);

    expect(r.getTaskRecord(taskId)!.archivedAt ?? null).toBeNull();
  });

  it('does not archive a stale aggregate that has no finalized successor at all', () => {
    const r = registry();
    const { taskId } = staleTask(r);

    sweep(r);

    expect(r.getTaskRecord(taskId)!.archivedAt ?? null).toBeNull();
  });
});
