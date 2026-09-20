import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { emitPeerAuditResult, emitPeerAuditStatus, peerAuditResultEventId } from '../../src/daemon/peer-audit-result.js';
import { resetMetricsForTests, snapshotCounters } from '../../src/util/metrics.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
} from '../../src/daemon/supervision-state-store.js';

describe('peer audit result timeline projection', () => {
  beforeEach(() => {
    resetMetricsForTests();
    resetSupervisionTaskRegistryForTests();
  });
  afterEach(() => resetSupervisionTaskRegistryForTests());

  it('attaches the authoritative full task objective for a uniquely bound formal audit', () => {
    const registry = getSupervisionTaskRegistry();
    const attemptId = 'formal-attempt';
    const objective = `Repair the peer audit card. ${'Keep the authoritative objective visible. '.repeat(30)}`.trim();
    expect(registry.createOrGet({
      taskId: 'tsk_formal', projectName: 'alpha', classification: 'independent_top_level',
      objective, currentRevision: 'formal-r1',
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId: 'tsk_formal', assignmentId: 'asg_formal_auditor', role: 'auditor', required: true,
      identity: {
        sessionName: 'deck_formal_auditor', sessionInstanceId: 'instance-formal',
        runtimeEpoch: 'epoch-formal', agentType: 'codex-sdk', providerFamily: 'openai',
      },
      auditAttemptId: attemptId, auditRevision: 'formal-r1',
    })).toMatchObject({ ok: true });
    const events: any[] = [];
    const off = timelineEmitter.on((event) => {
      if (event.sessionId === 'deck_formal_brain' && event.type === 'peer_audit.result') events.push(event);
    });
    emitPeerAuditResult({
      auditedSessionName: 'deck_formal_brain', attemptId, trigger: 'automatic', outcome: 'rework',
      auditorSessionName: 'deck_formal_auditor', elapsedMs: 10,
    });
    off();
    expect(events).toHaveLength(1);
    expect(events[0].payload.supervisionTask).toMatchObject({
      version: 1,
      taskId: 'tsk_formal',
      assignmentId: 'asg_formal_auditor',
      revision: 'formal-r1',
      objective,
    });
    expect(registry.getSupervisionTaskProjection('tsk_formal', 'asg_formal_auditor')).toMatchObject({
      taskId: 'tsk_formal',
      assignmentId: 'asg_formal_auditor',
      objective,
    });
    expect(registry.getSupervisionTaskProjection('tsk_other', 'asg_formal_auditor')).toBeUndefined();
    expect(registry.getSupervisionTaskProjection('tsk_formal', 'asg_other')).toBeUndefined();
    expect(JSON.stringify(events[0])).not.toContain(attemptId);
  });

  it('attaches the daemon-authoritative audit round after a final receipt', () => {
    const registry = getSupervisionTaskRegistry();
    const taskId = 'tsk_round_projection';
    const assignmentId = 'asg_round_projection';
    const attemptId = 'round-projection-attempt';
    const revision = 'round-projection-r1';
    const auditorIdentity = {
      sessionName: 'deck_round_projection_auditor',
      sessionInstanceId: 'instance-round-projection',
      runtimeEpoch: 'epoch-round-projection',
      agentType: 'codex-sdk',
      providerFamily: 'openai',
    };
    expect(registry.createOrGet({
      taskId, projectName: 'alpha', classification: 'independent_top_level',
      objective: 'Project the audit round', currentRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.createAssignment({
      taskId, assignmentId, role: 'auditor', required: true, identity: auditorIdentity,
      auditAttemptId: attemptId, auditRevision: revision,
    })).toMatchObject({ ok: true });
    expect(registry.appendMatchingAuditReceipt({
      taskId, auditorAssignmentId: assignmentId, attemptId, revision,
      receiptKind: 'final', verdict: 'PASS', auditorSessionName: auditorIdentity.sessionName,
      auditorIdentity, findings: 'PASS', validations: [], now: 100,
    })).toMatchObject({ ok: true });

    const events: any[] = [];
    const off = timelineEmitter.on((event) => {
      if (event.sessionId === 'deck_round_projection_brain' && event.type === 'peer_audit.result') events.push(event);
    });
    emitPeerAuditResult({
      auditedSessionName: 'deck_round_projection_brain', attemptId, trigger: 'automatic', outcome: 'pass',
      auditorSessionName: auditorIdentity.sessionName, elapsedMs: 10,
    });
    off();
    expect(events).toHaveLength(1);
    expect(events[0].payload.round).toBe(1);
  });

  it('emits a stable reconnect-safe id and excludes opaque/capability/provider material', () => {
    const events: unknown[] = [];
    const off = timelineEmitter.on((event) => {
      if (event.sessionId === 'deck_result_brain' && event.type === 'peer_audit.result') events.push(event);
    });
    const attemptId = 'opaque-attempt-that-must-not-appear';
    const eventId = emitPeerAuditResult({
      auditedSessionName: 'deck_result_brain',
      attemptId,
      trigger: 'quick',
      outcome: 'pass',
      auditorSessionName: 'deck_sub_auditor1',
      auditorLabel: 'Auditor',
      elapsedMs: 1234.4,
      disposition: 'sent',
      findings: 'validated token=secret-value',
      reason: 'reply_accepted',
    });
    off();
    expect(eventId).toBe(peerAuditResultEventId(attemptId));
    expect(events).toHaveLength(1);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain(attemptId);
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('replyCapability');
    expect(serialized).not.toContain('providerFamily');
    expect(events[0]).toMatchObject({
      eventId,
      payload: {
        memoryExcluded: true,
        trigger: 'quick',
        outcome: 'pass',
        elapsedMs: 1234,
        disposition: 'sent',
      },
    });
    const counters = snapshotCounters();
    expect(counters).toEqual({
      'peer_audit.terminal{contractVersion=peer_audit_v1,disposition=sent,outcome=pass,reason=other,trigger=quick}': 1,
    });
    expect(JSON.stringify(counters)).not.toContain('deck_');
    expect(JSON.stringify(counters)).not.toContain('secret-value');
    expect(JSON.stringify(counters)).not.toContain(attemptId);
  });

  it('emits bounded localized-code-only status correlated by the public result event id', () => {
    const events: any[] = [];
    const off = timelineEmitter.on((event) => {
      if (event.sessionId === 'deck_status_brain' && event.type === 'peer_audit.status') events.push(event);
    });
    const attemptId = 'opaque-status-attempt';
    const eventId = emitPeerAuditStatus({
      auditedSessionName: 'deck_status_brain',
      attemptId,
      revision: 3,
      trigger: 'quick',
      phase: 'waiting_reply',
      auditorSessionName: 'deck_sub_auditor2',
      disposition: 'queued',
      reason: `waiting_${'x'.repeat(400)}`,
    });
    off();
    expect(eventId).toBe(`${peerAuditResultEventId(attemptId)}:status:3:waiting_reply`);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain(attemptId);
    expect(events[0].payload).toMatchObject({
      memoryExcluded: true,
      resultEventId: peerAuditResultEventId(attemptId),
      phase: 'waiting_reply',
      trigger: 'quick',
      disposition: 'queued',
    });
    expect(new TextEncoder().encode(events[0].payload.reason).length).toBeLessThanOrEqual(256);
    expect(snapshotCounters()).toEqual({
      'peer_audit.status{contractVersion=peer_audit_v1,disposition=queued,outcome=pending,reason=waiting_reply,trigger=quick}': 1,
    });
  });
});
