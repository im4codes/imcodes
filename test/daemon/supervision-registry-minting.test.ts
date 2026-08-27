import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SupervisionTaskRegistry } from '../../src/daemon/supervision-state-store.js';
import { parseSupervisionCanonicalId } from '../../shared/supervision-durable-identity.js';

function registry() {
  return new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
}

describe('daemon-minted ids in the registry', () => {
  it('mints a canonical task id from a proposed semantic key', () => {
    const created = registry().createOrGet({ semanticTaskKey: 'live-task-console-producer' });
    expect(created.ok).toBe(true);
    const taskId = (created as { value: { taskId: string } }).value.taskId;
    const parsed = parseSupervisionCanonicalId(taskId);
    expect(parsed).toMatchObject({ kind: 'task', semanticKey: 'live-task-console-producer' });
    expect(taskId.startsWith('tsk_live-task-console-producer_')).toBe(true);
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
