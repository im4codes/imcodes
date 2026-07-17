import { beforeEach, describe, expect, it } from 'vitest';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { emitPeerAuditResult, emitPeerAuditStatus, peerAuditResultEventId } from '../../src/daemon/peer-audit-result.js';
import { resetMetricsForTests, snapshotCounters } from '../../src/util/metrics.js';

describe('peer audit result timeline projection', () => {
  beforeEach(() => resetMetricsForTests());

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
