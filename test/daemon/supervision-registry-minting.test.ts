import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SupervisionTaskRegistry } from '../../src/daemon/supervision-state-store.js';
import { parseSupervisionCanonicalId } from '../../shared/supervision-durable-identity.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function registry() {
  return new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
}

describe('daemon-minted ids in the registry', () => {
  it('uses the persistent event sequence for compact opaque task, assignment, and lease ids', () => {
    const reg = registry();
    const task = reg.createOrGet({ projectName: 'alpha' }) as { value: { taskId: string } };
    expect(task.value.taskId).toBe('tsk_1');

    const first = reg.createAssignment({
      taskId: task.value.taskId, role: 'coordinator', identity: {
        sessionName: 'deck_alpha_brain', sessionInstanceId: 'i1', runtimeEpoch: 'e1',
        agentType: 'codex-sdk', providerFamily: 'openai',
      },
    }) as { value: { assignmentId: string; leaseId: string } };
    expect(first.value).toMatchObject({ assignmentId: 'asg_2', leaseId: 'lse_2' });

    // The first assignment also advances the task aggregate (event 3), so the
    // next assignment deterministically consumes event sequence 4.
    const second = reg.createAssignment({
      taskId: task.value.taskId, role: 'implementer', identity: {
        sessionName: 'deck_alpha_worker', sessionInstanceId: 'i2', runtimeEpoch: 'e2',
        agentType: 'codex-sdk', providerFamily: 'openai',
      },
    }) as { value: { assignmentId: string; leaseId: string } };
    expect(second.value).toMatchObject({ assignmentId: 'asg_4', leaseId: 'lse_4' });
  });

  it('continues the compact sequence after reopening the same SQLite database', () => {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-supervision-compact-ids-'));
    roots.push(root);
    const dbPath = join(root, 'state.sqlite');
    const first = new SupervisionTaskRegistry({ dbPath });
    expect((first.createOrGet({ projectName: 'alpha' }) as { value: { taskId: string } }).value.taskId)
      .toBe('tsk_1');
    first.close();

    const reopened = new SupervisionTaskRegistry({ dbPath });
    expect((reopened.createOrGet({ projectName: 'alpha' }) as { value: { taskId: string } }).value.taskId)
      .toBe('tsk_2');
    reopened.close();
  });

  it('fails away from an occupied compact candidate without weakening uniqueness', () => {
    const reg = registry();
    expect((reg.createOrGet({ projectName: 'alpha' }) as { value: { taskId: string } }).value.taskId)
      .toBe('tsk_1');
    // A caller-supplied historical value can occupy a future short candidate.
    expect(reg.createOrGet({ projectName: 'alpha', taskId: 'tsk_3' }).ok).toBe(true);
    const recovered = reg.createOrGet({ projectName: 'alpha' }) as { value: { taskId: string } };
    expect(recovered.value.taskId).toBe('tsk_3-1');
    expect(reg.list({ projectName: 'alpha' }).map((task) => task.taskId).sort())
      .toEqual(['tsk_1', 'tsk_3', 'tsk_3-1'].sort());
  });

  it('mints a canonical task id from a proposed semantic key', () => {
    const created = registry().createOrGet({ semanticTaskKey: 'live-task-console-producer' });
    expect(created.ok).toBe(true);
    const taskId = (created as { value: { taskId: string } }).value.taskId;
    const parsed = parseSupervisionCanonicalId(taskId);
    expect(parsed).toMatchObject({ kind: 'task', semanticKey: 'live-task-console-producer' });
    expect(taskId).toBe('tsk_live-task-console-producer_1');
  });

  it('IGNORES a caller-supplied taskId when a semantic key is present', () => {
    const created = registry().createOrGet({
      semanticTaskKey: 'real-slice', taskId: 'tsk_impersonated-other-slice_01JFAKE',
    });
    const taskId = (created as { value: { taskId: string } }).value.taskId;
    expect(taskId).not.toContain('impersonated');
    expect(parseSupervisionCanonicalId(taskId)?.semanticKey).toBe('real-slice');
  });

  it('refuses an invalid semantic key rather than falling back to a random id', () => {
    for (const key of ['Not Kebab', 'test', 'ab', 'trailing-', 'snake_case']) {
      expect(registry().createOrGet({ semanticTaskKey: key }), key)
        .toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('gives two tasks with the same semantic key distinct ids', () => {
    const reg = registry();
    const a = reg.createOrGet({ semanticTaskKey: 'same-objective' }) as { value: { taskId: string } };
    const b = reg.createOrGet({ semanticTaskKey: 'same-objective' }) as { value: { taskId: string } };
    expect(a.value.taskId).not.toBe(b.value.taskId);
    expect(parseSupervisionCanonicalId(a.value.taskId)?.semanticKey)
      .toBe(parseSupervisionCanonicalId(b.value.taskId)?.semanticKey);
  });

  it('still honours the legacy path when no semantic key is given', () => {
    const created = registry().createOrGet({ taskId: 'legacy-task-1' }) as { ok: boolean; value: { taskId: string } };
    expect(created.ok).toBe(true);
    expect(created.value.taskId).toBe('legacy-task-1');
  });

  it('reads and idempotently replays legacy long task, assignment, and lease ids unchanged', () => {
    const db = new DatabaseSync(':memory:');
    const reg = new SupervisionTaskRegistry({ database: db });
    const taskId = 'supervision_task_11111111-1111-4111-8111-111111111111';
    const assignmentId = 'supervision_assignment_22222222-2222-4222-8222-222222222222';
    const leaseId = 'supervision_lease_33333333-3333-4333-8333-333333333333';
    const task = reg.createOrGet({
      projectName: 'alpha', taskId, idempotencyKey: 'legacy-task-replay',
    });
    expect(task).toMatchObject({ ok: true, value: { taskId } });
    expect(reg.createOrGet({
      projectName: 'alpha', idempotencyKey: 'legacy-task-replay',
    })).toMatchObject({ ok: true, replay: true, value: { taskId } });

    const assignment = reg.createAssignment({
      taskId, assignmentId, idempotencyKey: 'legacy-assignment-replay', role: 'implementer',
      identity: {
        sessionName: 'deck_alpha_legacy', sessionInstanceId: 'i', runtimeEpoch: 'e',
        agentType: 'codex-sdk', providerFamily: 'openai',
      },
    }) as { value: Record<string, unknown> };
    const legacyPayload = { ...assignment.value, leaseId };
    db.prepare(`UPDATE supervision_task_assignments
      SET lease_id = ?, payload_json = ? WHERE assignment_id = ?`)
      .run(leaseId, JSON.stringify(legacyPayload), assignmentId);
    expect(reg.getAssignment(assignmentId)).toMatchObject({ assignmentId, taskId, leaseId });
    expect(reg.createAssignment({
      taskId, idempotencyKey: 'legacy-assignment-replay', role: 'implementer',
      identity: {
        sessionName: 'deck_alpha_legacy', sessionInstanceId: 'i', runtimeEpoch: 'e',
        agentType: 'codex-sdk', providerFamily: 'openai',
      },
    })).toMatchObject({ ok: true, replay: true, value: { assignmentId, taskId, leaseId } });
  });

  it('mints a canonical assignment id from a proposed key', () => {
    const reg = registry();
    const task = reg.createOrGet({ semanticTaskKey: 'console-slice' }) as { value: { taskId: string } };
    const created = reg.createAssignment({
      taskId: task.value.taskId,
      semanticAssignmentKey: 'media-binder-rebind',
      role: 'implementer',
      identity: {
        sessionName: 'deck_cd_cc2', sessionInstanceId: 'i', runtimeEpoch: 'e',
        agentType: 'claude-code', providerFamily: 'anthropic',
      },
    }) as { ok: boolean; value?: { assignmentId: string } };
    expect(created.ok).toBe(true);
    expect(parseSupervisionCanonicalId(created.value!.assignmentId))
      .toMatchObject({ kind: 'assignment', semanticKey: 'media-binder-rebind' });
  });
});
