import { describe, expect, it } from 'vitest';
import {
  SUPERVISION_INTENTS, SUPERVISION_INTENT_TRANSITIONS, SUPERVISION_MCP_TOOL_SCHEMAS,
  resolveSupervisionIntent, supervisionSchemaStatusEnums,
} from '../../src/daemon/supervision-intent-ops.js';
import {
  SUPERVISION_TASK_LIFECYCLE_STATUSES, SUPERVISION_TASK_REGISTRY_EVENT_TYPES,
} from '../../shared/supervision-config.js';
import { SUPERVISION_CONSOLE_VALIDATION_STATES } from '../../shared/supervision-task-console.js';

describe('intent resolution', () => {
  it('moves the lifecycle only through the daemon-owned table', () => {
    expect(resolveSupervisionIntent({ request: { intent: 'start', taskId: 't' }, currentStatus: 'planned' }))
      .toEqual({ ok: true, intent: 'start', fromStatus: 'planned', toStatus: 'implementing' });
    expect(resolveSupervisionIntent({ request: { intent: 'open_audit', taskId: 't' }, currentStatus: 'validated' }))
      .toMatchObject({ ok: true, toStatus: 'ready_for_audit' });
  });

  it('REFUSES a model-supplied status outright, before anything else', () => {
    const out = resolveSupervisionIntent({
      request: { intent: 'start', taskId: 't', status: 'finalized' }, currentStatus: 'planned',
    });
    expect(out.ok).toBe(false);
    expect(out.refusal).toBe('model_supplied_status');
    expect(out.toStatus).toBeUndefined();
  });

  it('refuses an unknown or event-named intent', () => {
    for (const intent of ['file_event', 'scope_violation', 'promote', 'Start', '']) {
      expect(resolveSupervisionIntent({ request: { intent, taskId: 't' }, currentStatus: 'planned' }).refusal, intent)
        .toBe('unknown_intent');
    }
  });

  it('refuses an illegal transition from every disallowed source status', () => {
    for (const status of SUPERVISION_TASK_LIFECYCLE_STATUSES) {
      const out = resolveSupervisionIntent({ request: { intent: 'open_audit', taskId: 't' }, currentStatus: status });
      if (SUPERVISION_INTENT_TRANSITIONS.open_audit.from.includes(status)) {
        expect(out.ok, status).toBe(true);
      } else {
        expect(out.refusal, status).toBe('illegal_transition');
        expect(out.toStatus, status).toBeUndefined();
      }
    }
  });

  it('refuses a task with unknown or absent durable status', () => {
    for (const status of [undefined, '', 'file_event', 'nonsense']) {
      expect(resolveSupervisionIntent({ request: { intent: 'start', taskId: 't' }, currentStatus: status }).refusal, String(status))
        .toBe('unknown_task');
    }
  });

  it('requires a fixed-enum validation state and never invents one', () => {
    for (const state of SUPERVISION_CONSOLE_VALIDATION_STATES) {
      expect(resolveSupervisionIntent({
        request: { intent: 'record_validation', taskId: 't', validationState: state }, currentStatus: 'implementing',
      }), state).toMatchObject({
        ok: true,
        validationState: state,
        toStatus: state === 'passed' ? 'validated' : null,
      });
    }
    for (const bad of [undefined, 'maybe', 'PASSED', ' passed']) {
      expect(resolveSupervisionIntent({
        request: { intent: 'record_validation', taskId: 't', validationState: bad as never }, currentStatus: 'implementing',
      }).refusal, String(bad)).toBe('invalid_validation_state');
    }
  });

  it('never advances a shipped terminal task and treats repeated cancel as cleanup replay', () => {
    for (const status of ['finalized', 'pushed'] as const) {
      expect(resolveSupervisionIntent({ request: { intent: 'cancel', taskId: 't' }, currentStatus: status }).refusal, status)
        .toBe('illegal_transition');
    }
    expect(resolveSupervisionIntent({ request: { intent: 'cancel', taskId: 't' }, currentStatus: 'cancelled' }))
      .toMatchObject({ ok: true, fromStatus: 'cancelled', toStatus: 'cancelled' });
    expect(resolveSupervisionIntent({ request: { intent: 'cancel', taskId: 't' }, currentStatus: 'implementing' }))
      .toMatchObject({ ok: true, toStatus: 'cancelled' });
  });
});

describe('transition table integrity', () => {
  it('names only real lifecycle statuses, never event types', () => {
    for (const intent of SUPERVISION_INTENTS) {
      const rule = SUPERVISION_INTENT_TRANSITIONS[intent];
      for (const from of rule.from) {
        expect(SUPERVISION_TASK_LIFECYCLE_STATUSES, `${intent}.from`).toContain(from);
      }
      if (rule.to !== null) expect(SUPERVISION_TASK_LIFECYCLE_STATUSES, `${intent}.to`).toContain(rule.to);
    }
    const eventOnly = SUPERVISION_TASK_REGISTRY_EVENT_TYPES.filter(
      (e) => !(SUPERVISION_TASK_LIFECYCLE_STATUSES as readonly string[]).includes(e));
    const all = JSON.stringify(SUPERVISION_INTENT_TRANSITIONS);
    for (const e of eventOnly) expect(all, e).not.toContain(`"${e}"`);
  });

  it('covers every declared intent exactly once', () => {
    expect(Object.keys(SUPERVISION_INTENT_TRANSITIONS).sort()).toEqual([...SUPERVISION_INTENTS].sort());
  });
});

describe('published MCP schemas', () => {
  it('exposes intent and status as closed enums, never a free string', () => {
    const intentSchema = SUPERVISION_MCP_TOOL_SCHEMAS.supervision_task_intent;
    expect(intentSchema.properties.intent.enum).toEqual([...SUPERVISION_INTENTS]);
    expect(intentSchema.additionalProperties).toBe(false);
    // The intent tool must NOT accept a status property at all.
    expect(Object.keys(intentSchema.properties)).not.toContain('status');
    expect(SUPERVISION_MCP_TOOL_SCHEMAS.supervision_task_list.properties.status.enum)
      .toEqual([...SUPERVISION_TASK_LIFECYCLE_STATUSES]);
  });

  it('every enum in every schema matches a contract constant exactly', () => {
    const known = [
      JSON.stringify([...SUPERVISION_INTENTS]),
      JSON.stringify([...SUPERVISION_TASK_LIFECYCLE_STATUSES]),
      JSON.stringify([...SUPERVISION_CONSOLE_VALIDATION_STATES]),
    ];
    const found = supervisionSchemaStatusEnums();
    expect(found.length).toBeGreaterThan(0);
    for (const e of found) expect(known, JSON.stringify(e)).toContain(JSON.stringify(e));
  });
});
