import { DatabaseSync } from 'node:sqlite';

import {
  type PersistedSupervisionTaskAssignmentIdentity,
  type SupervisionTaskRegistry,
} from '../../../src/daemon/supervision-state-store.js';

/**
 * Synthetic supervision data with the shape of a production database, shared by
 * the cost test and the real-machine perf harness. NO real data is used or
 * committed: 616 tasks (363 finalized, 243 cancelled, 10 live), >2000
 * assignments (a Brain owning a coordinator row on every task, 20 workers,
 * auditors), long objectives and file events, so hydrating the tasks a session
 * ever owned costs what it costs on the real database.
 */
export const PROJECT = 'perfproj';
export const BRAIN = 'deck_perfproj_brain';
export const TASKS = 616;
export const FINALIZED = 363;
export const CANCELLED = 243;

export function identity(sessionName: string): PersistedSupervisionTaskAssignmentIdentity {
  return {
    sessionName,
    sessionInstanceId: `${sessionName}-instance`,
    runtimeEpoch: `${sessionName}-epoch`,
    agentType: 'claude-code-sdk',
    providerFamily: 'anthropic',
  };
}

export interface ProductionShape {
  taskCount: number;
  assignmentCount: number;
}

/**
 * Seed `registry` through its public API; `db` is a handle on the SAME database
 * (the registry does not expose its own) used to end the 606 terminal tasks.
 */
export function seedProductionShapedSupervision(registry: SupervisionTaskRegistry, db: DatabaseSync): ProductionShape {
  const objective = `Realistic objective text. ${'Investigate, implement and verify the change end to end. '.repeat(480)}`;
  let assignmentCount = 0;
  const taskIds: string[] = [];
  for (let i = 0; i < TASKS; i += 1) {
    const taskId = `tsk_perf${String(i).padStart(4, '0')}`;
    taskIds.push(taskId);
    const created = registry.createOrGet({
      taskId,
      topLevelTaskId: taskId,
      projectName: PROJECT,
      classification: 'independent_top_level',
      objective,
      acceptance: Array.from({ length: 6 }, (_, n) => `Acceptance criterion ${n}: ${'detail '.repeat(40)}`),
      now: 1_000 + i,
    });
    if (!created.ok) throw new Error(created.reason);
    const roles: Array<[string, 'coordinator' | 'implementer' | 'auditor']> = [
      [BRAIN, 'coordinator'],
      [`deck_sub_perfworker${i % 20}`, 'implementer'],
    ];
    roles.push([`deck_sub_perfworker${(i + 7) % 20}`, 'implementer']);
    if (i % 2 === 0) roles.push([`deck_sub_perfaudit${i % 5}`, 'auditor']);
    if (i % 2 === 1) roles.push([`deck_sub_perfworker${(i + 11) % 20}`, 'implementer']);
    for (const [session, role] of roles) {
      const assignment = registry.createAssignment({
        taskId,
        assignmentId: `asg_perf${String(i).padStart(4, '0')}_${role}_${assignmentCount}`,
        role,
        identity: identity(session),
        required: role !== 'auditor',
        now: 2_000 + i,
        scopeFiles: role === 'implementer'
          ? Array.from({ length: 12 }, (_, n) => `src/module${i % 40}/component${n}/file${n}.ts`)
          : [],
        ...(role === 'auditor' ? { auditAttemptId: `attempt-${i}-${assignmentCount}`, auditRevision: `rev-${i}-${assignmentCount}` } : {}),
      });
      if (!assignment.ok) throw new Error(`${taskId} ${role}: ${assignment.reason}`);
      assignmentCount += 1;
    }
  }
  // File events (the production database has thousands): each is read by list().
  const fileEvent = db.prepare(
    `INSERT INTO supervision_task_file_events (task_id, assignment_id, file_path, operation, session_name, session_instance_id, runtime_epoch, agent_type, provider_family, created_at)
     VALUES (?, ?, ?, 'modify', 'deck_sub_perfworker0', 'i', 'e', 'claude-code-sdk', 'anthropic', ?)`,
  );
  const implementers = db.prepare(`SELECT task_id AS taskId, assignment_id AS assignmentId FROM supervision_task_assignments WHERE role = 'implementer'`).all() as Array<{ taskId: string; assignmentId: string }>;
  for (const row of implementers) {
    for (let n = 0; n < 24; n += 1) fileEvent.run(row.taskId, row.assignmentId, `src/area${n}/deep/path/to/module${n}.ts`, 3_000 + n);
  }
  // 606 terminal tasks (their assignments end with them); 10 stay live.
  const setTerminal = (status: 'finalized' | 'cancelled', ids: string[]) => {
    const task = db.prepare(
      `UPDATE supervision_tasks SET status = ?, payload_json = json_set(payload_json, '$.status', ?) WHERE task_id = ?`,
    );
    const assignments = db.prepare(
      `UPDATE supervision_task_assignments SET status = ?, payload_json = json_set(payload_json, '$.status', ?) WHERE task_id = ?`,
    );
    for (const id of ids) { task.run(status, status, id); assignments.run(status, status, id); }
  };
  setTerminal('finalized', taskIds.slice(0, FINALIZED));
  setTerminal('cancelled', taskIds.slice(FINALIZED, FINALIZED + CANCELLED));
  // Housekeeping archives ended tasks (in production 581 of the 606 are
  // archived): the default list() hides them, which is why periodic scans stay
  // cheap while an includeArchived owner query pays for all of them.
  const archive = db.prepare(
    `UPDATE supervision_tasks SET payload_json = json_set(payload_json, '$.archivedAt', 5000) WHERE task_id = ?`,
  );
  taskIds.slice(0, FINALIZED + CANCELLED).forEach((id, index) => { if (index % 25 !== 0) archive.run(id); });
  return { taskCount: TASKS, assignmentCount };
}
