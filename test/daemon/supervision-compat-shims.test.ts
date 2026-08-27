import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  mapLegacySupervisionUpdate, mapLegacySupervisionFinish,
  SUPERVISION_COMPAT_UPDATE_FIELDS, SUPERVISION_COMPAT_FINISH_FIELDS,
} from '../../src/daemon/supervision-compat-shims.js';
import { SUPERVISION_MCP_FORBIDDEN_ARG_NAMES } from '../../shared/supervision-mcp-tools.js';
import { SUPERVISION_CONSOLE_VALIDATION_STATES } from '../../shared/supervision-task-console.js';
import { SUPERVISION_INTENT_TRANSITIONS } from '../../src/daemon/supervision-intent-ops.js';
import { SupervisionTaskRegistry } from '../../src/daemon/supervision-state-store.js';

describe('intent-only update shim', () => {
  it('maps a plain update to heartbeat, never to a caller-named status', () => {
    const out = mapLegacySupervisionUpdate({ assignmentId: 'asg_1', revision: 'r1' });
    expect(out).toMatchObject({ ok: true, intent: 'heartbeat', assignmentId: 'asg_1' });
    expect((out as any).metadata).toEqual({ revision: 'r1' });
    expect(JSON.stringify(out)).not.toContain('"status"');
  });

  it('maps a reported validation outcome to record_validation', () => {
    for (const state of SUPERVISION_CONSOLE_VALIDATION_STATES) {
      const out = mapLegacySupervisionUpdate({ assignmentId: 'asg_1', validationState: state });
      expect(out, state).toMatchObject({ ok: true, intent: 'record_validation', validationState: state });
    }
  });

  it('REFUSES every forbidden lifecycle field, before any other validation', () => {
    for (const field of SUPERVISION_MCP_FORBIDDEN_ARG_NAMES) {
      // No assignmentId either: the status refusal must still win.
      const out = mapLegacySupervisionUpdate({ [field]: 'finalized' });
      expect(out, field).toMatchObject({ ok: false, reason: 'model_supplied_status' });
      expect((out as any).detail, field).toContain(field);
    }
  });

  it('refuses an unknown validation state and a missing assignment', () => {
    expect(mapLegacySupervisionUpdate({ assignmentId: 'a', validationState: 'maybe' }))
      .toMatchObject({ ok: false, reason: 'invalid_validation_state' });
    expect(mapLegacySupervisionUpdate({ revision: 'r' }))
      .toMatchObject({ ok: false, reason: 'missing_assignment' });
  });

  it('drops any field outside the published non-lifecycle set', () => {
    const out: any = mapLegacySupervisionUpdate({ assignmentId: 'a', revision: 'r', sneaky: 'x' });
    expect(Object.keys(out.metadata)).toEqual(['revision']);
    expect(SUPERVISION_COMPAT_UPDATE_FIELDS).not.toContain('sneaky');
  });
});

describe('intent-only finish shim', () => {
  it('maps to the fixed finish intent with no caller-chosen destination', () => {
    const out = mapLegacySupervisionFinish({ assignmentId: 'asg_1', evidence: 'logs' });
    expect(out).toMatchObject({ ok: true, intent: 'finish', assignmentId: 'asg_1' });
    expect((out as any).metadata).toEqual({ evidence: 'logs' });
  });

  it('REFUSES a caller-supplied destination status', () => {
    for (const field of SUPERVISION_MCP_FORBIDDEN_ARG_NAMES) {
      expect(mapLegacySupervisionFinish({ assignmentId: 'a', [field]: 'finalized' }), field)
        .toMatchObject({ ok: false, reason: 'model_supplied_status' });
    }
  });

  it('derives its destination from the transition table, not the payload', () => {
    // The shim names only the intent; the table owns where finish leads.
    expect(SUPERVISION_INTENT_TRANSITIONS.finish.to).toBe('finalized');
    expect(SUPERVISION_COMPAT_FINISH_FIELDS).not.toContain('status');
  });
});

describe('pinned registry guarantees the shim relies on', () => {
  // These are the guarantees I WRONGLY reported as missing. Pinned so a future
  // edit cannot silently remove them.
  const identity = {
    sessionName: 'deck_cd_cc2', sessionInstanceId: 'i', runtimeEpoch: 'e',
    agentType: 'claude-code', providerFamily: 'anthropic',
  };
  function seeded() {
    const reg = new SupervisionTaskRegistry({ database: new DatabaseSync(':memory:') });
    const task: any = reg.createOrGet({ taskId: 'tsk_p' });
    reg.createAssignment({ taskId: task.value.taskId, assignmentId: 'asg_p', role: 'implementer', identity } as never);
    return reg;
  }

  it('refuses an illegal transition (planned/delegated -> finalized)', () => {
    expect(seeded().updateAssignment({ assignmentId: 'asg_p', identity, status: 'finalized' } as never))
      .toMatchObject({ ok: false, reason: 'invalid_transition' });
  });

  it('refuses a foreign owner', () => {
    expect(seeded().updateAssignment({
      assignmentId: 'asg_p', identity: { ...identity, sessionName: 'deck_intruder' }, status: 'implementing',
    } as never)).toMatchObject({ ok: false, reason: 'owner_mismatch' });
  });

  it('still allows a legal owned transition', () => {
    expect(seeded().updateAssignment({ assignmentId: 'asg_p', identity, status: 'implementing' } as never))
      .toMatchObject({ ok: true });
  });
});
