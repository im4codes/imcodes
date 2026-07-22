import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PEER_AUDIT_REPLY_VERSION, type PeerAuditReplyEnvelope } from '../../shared/peer-audit.js';
import { PeerAuditController, type PeerAuditStartInput } from '../../src/daemon/peer-audit-controller.js';
import {
  processPeerAuditReplyAuthority,
  type PeerAuditReplyAuthority,
  type PeerAuditReplyCurrentBindings,
} from '../../src/daemon/peer-audit-reply-ingress.js';

const capability = 'A'.repeat(32);
const envelope: PeerAuditReplyEnvelope = {
  version: PEER_AUDIT_REPLY_VERSION,
  attemptId: 'attempt_1',
  replyCapability: capability,
  verdict: 'PASS',
  findings: 'Looks good.',
  validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '1 passed' }],
};

const authority: PeerAuditReplyAuthority = {
  attemptId: envelope.attemptId,
  sender: { sessionName: 'deck_sub_a', sessionInstanceId: 'sender_instance', runtimeEpoch: 'sender_epoch' },
  destination: { sessionName: 'deck_proj_brain', sessionInstanceId: 'dest_instance', runtimeEpoch: 'dest_epoch' },
  baselineId: 'baseline_1',
  targetRevision: 'target_revision_1',
  configRevision: 'config_revision_1',
  controllerRevision: 2,
  deadlineAt: 361_000,
};

const current: PeerAuditReplyCurrentBindings = {
  sender: { ...authority.sender },
  destination: { ...authority.destination },
  baselineId: authority.baselineId,
  baselineValid: true,
  targetRevision: authority.targetRevision,
  configRevision: authority.configRevision,
  controllerRevision: authority.controllerRevision,
};

function evaluate(overrides: Partial<Parameters<typeof processPeerAuditReplyAuthority<string>>[0]> = {}) {
  const onInvalidReply = vi.fn();
  const onDeadline = vi.fn();
  const reduce = vi.fn().mockReturnValue({ accepted: true, value: 'reduced' });
  const result = processPeerAuditReplyAuthority({
    envelope,
    receivedAt: authority.deadlineAt - 1,
    authority,
    current,
    capabilityMatches: (provided) => provided === capability,
    onInvalidReply,
    onDeadline,
    reduce,
    ...overrides,
  });
  return { result, onInvalidReply, onDeadline, reduce };
}

describe('peer-audit reply authority pipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks capability and bound identities before deadline or evidence', () => {
    const capabilityRejected = evaluate({
      envelope: { ...envelope, validations: [] },
      receivedAt: authority.deadlineAt,
      capabilityMatches: () => false,
      current: { ...current, sender: undefined, baselineValid: false },
    });
    expect(capabilityRejected.result).toEqual({
      ok: false, error: 'invalid_capability', internalReason: 'capability_rejected',
    });
    expect(capabilityRejected.onDeadline).not.toHaveBeenCalled();
    expect(capabilityRejected.reduce).not.toHaveBeenCalled();

    const senderRejected = evaluate({
      envelope: { ...envelope, validations: [] },
      receivedAt: authority.deadlineAt,
      current: { ...current, sender: { ...authority.sender, runtimeEpoch: 'replaced' } },
    });
    expect(senderRejected.result).toEqual({
      ok: false, error: 'identity_mismatch', internalReason: 'sender_identity_rejected',
    });
    expect(senderRejected.onDeadline).not.toHaveBeenCalled();

    const destinationRejected = evaluate({
      envelope: { ...envelope, validations: [] },
      receivedAt: authority.deadlineAt,
      current: { ...current, destination: { ...authority.destination, sessionInstanceId: 'recreated' } },
    });
    expect(destinationRejected.result).toEqual({
      ok: false, error: 'identity_mismatch', internalReason: 'destination_identity_rejected',
    });
    expect(destinationRejected.onDeadline).not.toHaveBeenCalled();
  });

  it('checks baseline then target/config/controller revision before giving equality to timeout', () => {
    const baselineRejected = evaluate({
      envelope: { ...envelope, validations: [] },
      receivedAt: authority.deadlineAt,
      current: { ...current, baselineValid: false, targetRevision: 'stale' },
    });
    expect(baselineRejected.result).toEqual({
      ok: false, error: 'identity_mismatch', internalReason: 'baseline_rejected',
    });
    expect(baselineRejected.onDeadline).not.toHaveBeenCalled();

    const revisionRejected = evaluate({
      envelope: { ...envelope, validations: [] },
      receivedAt: authority.deadlineAt,
      current: { ...current, controllerRevision: authority.controllerRevision + 1 },
    });
    expect(revisionRejected.result).toEqual({
      ok: false, error: 'identity_mismatch', internalReason: 'revision_rejected',
    });
    expect(revisionRejected.onDeadline).not.toHaveBeenCalled();

    const deadlineWins = evaluate({
      envelope: { ...envelope, validations: [] },
      receivedAt: authority.deadlineAt,
    });
    expect(deadlineWins.result).toEqual({
      ok: false, error: 'deadline_expired', internalReason: 'deadline_expired',
    });
    expect(deadlineWins.onDeadline).toHaveBeenCalledOnce();
    expect(deadlineWins.onInvalidReply).not.toHaveBeenCalled();
    expect(deadlineWins.reduce).not.toHaveBeenCalled();
  });

  it('sanitizes evidence text and findings before the reducer', () => {
    const reduce = vi.fn().mockReturnValue({ accepted: true, value: 'done' });
    const result = evaluate({
      envelope: {
        ...envelope,
        findings: 'token=secret-value\u0001',
        validations: [{
          kind: 'test', label: 'token=label-secret', outcome: 'passed', summary: 'password=summary-secret',
        }],
      },
      reduce,
    });
    expect(result.result).toEqual({ ok: true, value: 'done', internalReason: 'accepted' });
    expect(reduce).toHaveBeenCalledWith(expect.objectContaining({
      findings: expect.not.stringContaining('secret-value'),
      validations: [expect.objectContaining({
        label: expect.not.stringContaining('label-secret'),
        summary: expect.not.stringContaining('summary-secret'),
      })],
    }));
    expect(reduce.mock.calls[0]?.[0]).not.toHaveProperty('replyCapability');
  });

  it('keeps invalid evidence non-terminal so a later valid reply can complete the same attempt', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    const start: PeerAuditStartInput = {
      attemptId: envelope.attemptId,
      trigger: 'quick',
      baselineId: authority.baselineId,
      candidateRevision: authority.targetRevision,
      targetConfigRevision: authority.configRevision,
      auditedSessionName: authority.destination.sessionName,
      auditedSessionInstanceId: authority.destination.sessionInstanceId,
      auditedRuntimeEpoch: authority.destination.runtimeEpoch,
      auditorSessionName: authority.sender.sessionName,
      auditorSessionInstanceId: authority.sender.sessionInstanceId,
      auditorRuntimeEpoch: authority.sender.runtimeEpoch,
      selectionIntent: 'explicit_picker',
      capabilityHash: 'stored_hash',
    };
    controller.request(start);
    controller.dispatchResolved({
      attemptId: envelope.attemptId,
      effectRevision: 1,
      receipt: {
        disposition: 'sent',
        dispatchId: 'dispatch_1',
        messageId: 'message_1',
        targetSessionInstanceId: authority.sender.sessionInstanceId,
        targetRuntimeEpoch: authority.sender.runtimeEpoch,
      },
    });
    const boundAuthority = { ...authority, controllerRevision: controller.pending!.revision };
    const boundCurrent = { ...current, controllerRevision: controller.pending!.revision };
    const reduce = (reply: Parameters<NonNullable<Parameters<typeof processPeerAuditReplyAuthority>[0]['reduce']>>[0]) => {
      const transition = controller.replyAccepted({
        attemptId: reply.attemptId,
        attemptRevision: reply.controllerRevision,
        receivedAt: reply.receivedAt,
        verdict: reply.verdict,
        findings: reply.findings,
      });
      return transition.status === 'applied'
        ? { accepted: true as const, value: transition }
        : { accepted: false as const };
    };

    const invalid = processPeerAuditReplyAuthority({
      envelope: { ...envelope, validations: [] },
      receivedAt: boundAuthority.deadlineAt - 2,
      authority: boundAuthority,
      current: boundCurrent,
      capabilityMatches: () => true,
      onInvalidReply: () => { controller.invalidReply({ attemptId: envelope.attemptId }); },
      onDeadline: () => { controller.timeout({ attemptId: envelope.attemptId, occurredAt: boundAuthority.deadlineAt }); },
      reduce,
    });
    expect(invalid).toEqual({
      ok: false, error: 'insufficient_validation_evidence', internalReason: 'evidence_rejected',
    });
    expect(controller.pending?.attemptId).toBe(envelope.attemptId);
    expect(controller.tombstoneCount).toBe(0);

    const accepted = processPeerAuditReplyAuthority({
      envelope,
      receivedAt: boundAuthority.deadlineAt - 1,
      authority: boundAuthority,
      current: boundCurrent,
      capabilityMatches: () => true,
      onInvalidReply: () => { controller.invalidReply({ attemptId: envelope.attemptId }); },
      onDeadline: () => { controller.timeout({ attemptId: envelope.attemptId, occurredAt: boundAuthority.deadlineAt }); },
      reduce,
    });
    expect(accepted).toMatchObject({ ok: true, value: { terminal: { outcome: 'pass' } } });
    expect(controller.pending).toBeUndefined();
    expect(controller.tombstoneCount).toBe(1);
  });
});
