import { describe, expect, it } from 'vitest';
import {
  SUPERVISION_INTEGRATION_FINALIZATION_STATUS_PATH,
  SUPERVISION_INTENTS, SUPERVISION_INTENT_TRANSITIONS, SUPERVISION_MCP_TOOL_SCHEMAS,
  resolveSupervisionIntent, supervisionSchemaStatusEnums,
} from '../../src/daemon/supervision-intent-ops.js';
import {
  canTransitionSupervisionTaskStatus,
  SUPERVISION_BRAIN_COORDINATION_RECOVERY_STATUSES,
  SUPERVISION_RECOVERY_LEASE_ACTIONS,
  SUPERVISION_TASK_LIFECYCLE_STATUSES, SUPERVISION_TASK_RECOVERY_TARGET_STATUSES,
  SUPERVISION_TASK_REGISTRY_EVENT_TYPES,
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
  it('keeps the structured integration finalization path explicit and legal', () => {
    expect(SUPERVISION_INTEGRATION_FINALIZATION_STATUS_PATH).toEqual([
      'ready_for_integration', 'integrating', 'final_audit', 'passed',
      'finalizing', 'committed', 'pushed', 'finalized',
    ]);
    for (let index = 1; index < SUPERVISION_INTEGRATION_FINALIZATION_STATUS_PATH.length; index += 1) {
      expect(canTransitionSupervisionTaskStatus(
        SUPERVISION_INTEGRATION_FINALIZATION_STATUS_PATH[index - 1],
        SUPERVISION_INTEGRATION_FINALIZATION_STATUS_PATH[index],
      )).toBe(true);
    }
    expect(resolveSupervisionIntent({
      request: { intent: 'finish', taskId: 't' }, currentStatus: 'ready_for_integration',
    })).toMatchObject({ ok: false, refusal: 'illegal_transition' });
  });

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

  it('publishes recovery authority while keeping file lists record-only and omitting clearLease', () => {
    const recovery = SUPERVISION_MCP_TOOL_SCHEMAS.supervision_task_recover;
    expect(recovery.required).toEqual(['taskId', 'reason']);
    expect(recovery.additionalProperties).toBe(false);
    expect(recovery.properties).toEqual(expect.objectContaining({
      taskId: expect.any(Object),
      assignmentId: expect.any(Object),
      fromRevision: expect.any(Object),
      toRevision: expect.any(Object),
      ownedFiles: expect.objectContaining({ description: expect.stringContaining('provenance') }),
      scopeFiles: expect.objectContaining({ description: expect.stringContaining('never restrict edits') }),
      evidenceManifestSha256: expect.objectContaining({ pattern: '^[a-f0-9]{64}$' }),
      leaseAction: expect.objectContaining({ enum: [...SUPERVISION_RECOVERY_LEASE_ACTIONS] }),
      idempotencyKey: expect.any(Object),
      reason: expect.any(Object),
    }));
    expect(recovery.properties.ownedFiles).not.toHaveProperty('type');
    expect(recovery.properties.scopeFiles).not.toHaveProperty('type');
    expect(recovery.properties).not.toHaveProperty('clearLease');
  });

  it('every enum in every schema matches a contract constant exactly', () => {
    const known = [
      JSON.stringify([...SUPERVISION_INTENTS]),
      JSON.stringify([...SUPERVISION_TASK_LIFECYCLE_STATUSES]),
      JSON.stringify([...SUPERVISION_TASK_RECOVERY_TARGET_STATUSES]),
      JSON.stringify([...SUPERVISION_BRAIN_COORDINATION_RECOVERY_STATUSES]),
      JSON.stringify([...SUPERVISION_RECOVERY_LEASE_ACTIONS]),
      JSON.stringify([...SUPERVISION_CONSOLE_VALIDATION_STATES]),
    ];
    const found = supervisionSchemaStatusEnums();
    expect(found.length).toBeGreaterThan(0);
    for (const e of found) expect(known, JSON.stringify(e)).toContain(JSON.stringify(e));
  });
});

describe('recovered must not be a lifecycle sink (tsk_4ft R2, live reproduction)', () => {
  // LIVE RED. supervision_task_recover set an integration_owner pointer target
  // to `recovered`, but no intent could leave that status and
  // integration_finalize rejected invalid_transition. The task therefore
  // deadlocked while already holding a PASS receipt, a pushed commit and a
  // green CI run. A status the recovery tool can PRODUCE must have at least
  // one legal, authority-preserving way OUT, or "recovery" strands the object.
  it('offers a legal outgoing transition from recovered', () => {
    const escapes = SUPERVISION_INTENTS.filter((intent) => {
      const rule = SUPERVISION_INTENT_TRANSITIONS[intent];
      // heartbeat/checkpoint are non-advancing (to === null): they observe the
      // object without moving it. `cancel` DOES leave `recovered`, but only to
      // `cancelled` -- that destroys the work rather than recovering it, so it
      // must not count as an escape. Without this exclusion the assertion
      // passes against the broken code.
      return rule.to !== null && rule.to !== 'cancelled' && rule.from.includes('recovered');
    });
    expect(escapes, 'recovered can only be cancelled, never resumed').not.toHaveLength(0);
  });

  it('resumes a recovered assignment via start without reopening an audit', () => {
    const outcome = resolveSupervisionIntent({
      request: { intent: 'start' },
      currentStatus: 'recovered',
    });
    expect(outcome.ok).toBe(true);
    // Must land on a status the existing legal path can carry to
    // ready_for_integration (record_validation -> finish), so preserved
    // PASS/attempt/revision/commit/CI never need a fresh audit.
    expect(outcome.ok && outcome.toStatus).toBe('implementing');
    expect(SUPERVISION_INTENT_TRANSITIONS.record_validation.from).toContain('implementing');
  });

  it('every status the recovery tool can produce has an escape or is terminal', () => {
    // Guards the general rule, not just the one status that bit us.
    const TERMINAL = new Set(['finalized', 'cancelled']);
    for (const produced of ['recovered', 'blocked'] as const) {
      if (TERMINAL.has(produced)) continue;
      const escapes = SUPERVISION_INTENTS.filter((intent) => {
        const rule = SUPERVISION_INTENT_TRANSITIONS[intent];
        return rule.to !== null && rule.to !== 'cancelled' && rule.from.includes(produced);
      });
      expect(escapes, `status "${produced}" can only be cancelled, not resumed`).not.toHaveLength(0);
    }
  });
});
