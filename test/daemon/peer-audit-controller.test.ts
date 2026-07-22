import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerAuditDispatchReceipt } from '../../shared/peer-audit.js';
import {
  PeerAuditController,
  type PeerAuditControllerEffect,
  type PeerAuditStartInput,
} from '../../src/daemon/peer-audit-controller.js';

function request(attemptId: string, trigger: 'quick' | 'automatic' = 'quick'): PeerAuditStartInput {
  return {
    attemptId,
    trigger,
    baselineId: `baseline-${attemptId}`,
    candidateRevision: 'candidate-revision',
    targetConfigRevision: 'target-config-revision',
    auditedSessionName: 'deck_proj_brain',
    auditedSessionInstanceId: 'audited-instance',
    auditedRuntimeEpoch: 'audited-runtime',
    auditorSessionName: 'deck_sub_auditor',
    auditorSessionInstanceId: 'auditor-instance',
    auditorRuntimeEpoch: 'auditor-runtime',
    selectionIntent: 'explicit_picker',
    capabilityHash: `hash-${attemptId}`,
  };
}

function receipt(disposition: 'sent' | 'queued' | 'sent_unrevocable' = 'sent'): PeerAuditDispatchReceipt {
  return {
    disposition,
    dispatchId: 'dispatch-1',
    messageId: 'message-1',
    targetSessionInstanceId: 'auditor-instance',
    targetRuntimeEpoch: 'auditor-runtime',
    ...(disposition === 'queued' ? { queueEpoch: 'queue-1' } : {}),
  };
}

describe('peer-audit controller reducer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the six-minute deadline in preparing and times out an unresolved dispatch', () => {
    const emitted: PeerAuditControllerEffect[][] = [];
    const controller = new PeerAuditController('deck_proj_brain', {
      onEffects: (effects) => emitted.push([...effects]),
    });
    const started = controller.request(request('attempt-1'));
    expect(started).toMatchObject({
      status: 'started',
      pending: { phase: 'preparing', startedAt: 1_000, deadlineAt: 361_000, revision: 1 },
    });

    vi.advanceTimersByTime(359_999);
    expect(controller.pending?.attemptId).toBe('attempt-1');
    vi.advanceTimersByTime(1);

    expect(controller.pending).toBeUndefined();
    expect(controller.getTombstone('attempt-1')?.terminal).toMatchObject({
      outcome: 'timeout',
      completedAt: 361_000,
      elapsedMs: 360_000,
    });
    expect(emitted.flat().filter((effect) => effect.type === 'emit_terminal')).toHaveLength(1);
  });

  it('accepts receivedAt strictly before deadline and gives equality to timeout', () => {
    const before = new PeerAuditController('deck_proj_brain');
    before.request(request('before'));
    before.dispatchResolved({ attemptId: 'before', effectRevision: 1, receipt: receipt() });
    const deadline = before.pending!.deadlineAt;
    const accepted = before.replyAccepted({
      attemptId: 'before',
      attemptRevision: 2,
      receivedAt: deadline - 1,
      verdict: 'PASS',
      findings: 'looks good',
    });
    expect(accepted).toMatchObject({ status: 'applied', terminal: { outcome: 'pass', verdict: 'PASS' } });

    const equal = new PeerAuditController('deck_proj_brain');
    equal.request(request('equal'));
    equal.dispatchResolved({ attemptId: 'equal', effectRevision: 1, receipt: receipt() });
    const equality = equal.replyAccepted({
      attemptId: 'equal',
      attemptRevision: 2,
      receivedAt: equal.pending!.deadlineAt,
      verdict: 'PASS',
      findings: 'too late',
    });
    expect(equality).toMatchObject({ status: 'applied', terminal: { outcome: 'timeout' } });
    expect(equality.terminal?.verdict).toBeUndefined();
  });

  it('treats same-tick reply/timeout ordering deterministically and never revives terminal state', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    controller.request(request('race'));
    controller.dispatchResolved({ attemptId: 'race', effectRevision: 1, receipt: receipt() });
    const deadline = controller.pending!.deadlineAt;

    const reply = controller.replyAccepted({
      attemptId: 'race',
      attemptRevision: 2,
      receivedAt: deadline - 1,
      verdict: 'REWORK',
      findings: 'one finding',
    });
    expect(reply.terminal?.outcome).toBe('rework');

    vi.setSystemTime(deadline);
    expect(controller.timeout({ attemptId: 'race', occurredAt: deadline }).status).toBe('duplicate');
    expect(controller.getTombstone('race')?.terminal.outcome).toBe('rework');
  });

  it('rejects duplicate terminal replies and emits exactly one result effect', () => {
    const effects: PeerAuditControllerEffect[] = [];
    const controller = new PeerAuditController('deck_proj_brain', {
      onEffects: (next) => effects.push(...next),
    });
    controller.request(request('duplicate'));
    controller.dispatchResolved({ attemptId: 'duplicate', effectRevision: 1, receipt: receipt() });
    const first = controller.replyAccepted({
      attemptId: 'duplicate', attemptRevision: 2, receivedAt: 2_000, verdict: 'PASS', findings: 'ok',
    });
    const duplicate = controller.replyAccepted({
      attemptId: 'duplicate', attemptRevision: 2, receivedAt: 2_001, verdict: 'REWORK', findings: 'again',
    });

    expect(first.status).toBe('applied');
    expect(duplicate.status).toBe('duplicate');
    expect(effects.filter((effect) => effect.type === 'emit_terminal')).toHaveLength(1);
    expect(controller.request(request('duplicate'))).toMatchObject({ status: 'duplicate', effects: [] });
  });

  it('discards stale dispatch/queue effects by attempt revision', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    controller.request(request('stale'));
    expect(controller.dispatchResolved({ attemptId: 'stale', effectRevision: 1, receipt: receipt('sent') }).status).toBe('applied');
    expect(controller.pending?.revision).toBe(2);

    const staleDispatch = controller.dispatchResolved({ attemptId: 'stale', effectRevision: 1, receipt: receipt('queued') });
    expect(staleDispatch.status).toBe('stale');
    expect(controller.pending).toMatchObject({ revision: 2, disposition: 'sent', messageId: 'message-1' });

    expect(controller.markWaitingReply({ attemptId: 'stale', effectRevision: 2 }).status).toBe('applied');
    expect(controller.markWaitingReply({ attemptId: 'stale', effectRevision: 2 }).status).toBe('stale');
    expect(controller.pending).toMatchObject({ revision: 3, phase: 'waiting_reply' });
  });

  it('does not cancel or tombstone a valid attempt for invalid replies', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    controller.request(request('valid-pending'));
    const original = controller.pending;

    expect(controller.invalidReply({ attemptId: 'valid-pending' })).toMatchObject({ status: 'invalid' });
    expect(controller.invalidReply({ attemptId: 'forged' })).toMatchObject({ status: 'missing' });
    expect(controller.pending).toEqual(original);
    expect(controller.tombstoneCount).toBe(0);
  });

  it('removes exactly the queued audit message on timeout, once', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    controller.request(request('queued'));
    controller.dispatchResolved({ attemptId: 'queued', effectRevision: 1, receipt: receipt('queued') });
    const terminal = controller.timeout({ attemptId: 'queued', occurredAt: controller.pending!.deadlineAt });

    expect(terminal.effects).toEqual([
      expect.objectContaining({
        type: 'remove_queued_message', messageId: 'message-1', queueEpoch: 'queue-1', effectRevision: 3,
      }),
      expect.objectContaining({ type: 'emit_terminal', effectRevision: 3 }),
    ]);
    expect(controller.timeout({ attemptId: 'queued', occurredAt: 999_999 }).effects).toEqual([]);
  });

  it('never claims unrevocable process delivery was removed', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    controller.request(request('process'));
    controller.dispatchResolved({ attemptId: 'process', effectRevision: 1, receipt: receipt('sent_unrevocable') });
    const cancelled = controller.cancel({ attemptId: 'process' });
    expect(cancelled.effects.some((effect) => effect.type === 'remove_queued_message')).toBe(false);
    expect(cancelled.terminal).toMatchObject({ outcome: 'cancelled', disposition: 'sent_unrevocable' });
  });

  it('times out unrevocable process delivery and ignores a harmless late reply', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    controller.request(request('process-timeout'));
    controller.dispatchResolved({
      attemptId: 'process-timeout',
      effectRevision: 1,
      receipt: receipt('sent_unrevocable'),
    });
    const deadlineAt = controller.pending!.deadlineAt;
    const timedOut = controller.timeout({ attemptId: 'process-timeout', occurredAt: deadlineAt });
    expect(timedOut.terminal).toMatchObject({ outcome: 'timeout', disposition: 'sent_unrevocable' });
    expect(timedOut.effects.some((effect) => effect.type === 'remove_queued_message')).toBe(false);

    expect(controller.replyAccepted({
      attemptId: 'process-timeout',
      attemptRevision: 2,
      receivedAt: deadlineAt + 1,
      verdict: 'PASS',
      findings: 'late',
    })).toMatchObject({ status: 'duplicate', effects: [] });
  });

  it('returns busy for Quick during automatic without changing the original attempt', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    controller.request(request('automatic', 'automatic'));
    const original = controller.pending;
    const quick = controller.request(request('quick', 'quick'));

    expect(quick).toMatchObject({ status: 'busy', error: 'peer_audit_busy' });
    expect(controller.pending).toEqual(original);
  });

  it('holds automatic work outside the active slot during Quick and signals revalidation after terminal', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    controller.request(request('quick', 'quick'));
    const automatic = controller.request(request('automatic', 'automatic'), {
      waiterId: 'run-1',
      generationOrEpoch: 9,
      baselineId: 'baseline-automatic',
      configRevision: 'config-1',
      targetRevision: 'target-1',
    });
    expect(automatic).toMatchObject({
      status: 'awaiting_slot',
      registration: 'registered',
      error: 'awaiting_peer_audit_slot',
      waiter: { waiterId: 'run-1' },
    });
    expect(controller.pending?.attemptId).toBe('quick');

    const done = controller.cancel({ attemptId: 'quick', reason: 'user_cancelled' });
    expect(controller.pending).toBeUndefined();
    expect(done.effects).toContainEqual(expect.objectContaining({
      type: 'automatic_slot_available',
      waiter: expect.objectContaining({ waiterId: 'run-1', generationOrEpoch: 9 }),
    }));
  });

  it('registers W1 exactly once, reports duplicate W1, and keeps W2 busy without a ghost waiter', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    controller.request(request('quick', 'quick'));
    const w1 = {
      waiterId: 'W1',
      generationOrEpoch: 1,
      baselineId: 'baseline-W1',
      configRevision: 'config-W1',
      targetRevision: 'target-W1',
    };
    const w2 = { ...w1, waiterId: 'W2', generationOrEpoch: 2 };

    expect(controller.request(request('automatic-W1', 'automatic'), w1)).toMatchObject({
      status: 'awaiting_slot', registration: 'registered', waiter: { waiterId: 'W1' },
    });
    expect(controller.request(request('automatic-W1-retry', 'automatic'), w1)).toMatchObject({
      status: 'duplicate', kind: 'automatic_waiter', waiter: { waiterId: 'W1' },
    });
    expect(controller.request(request('automatic-W2', 'automatic'), w2)).toMatchObject({
      status: 'busy', error: 'peer_audit_busy',
    });
    expect(controller.request(request('automatic-without-registration', 'automatic'))).toMatchObject({
      status: 'busy', error: 'peer_audit_busy',
    });
    expect(controller.automaticWaiter).toMatchObject({
      waiterId: 'W1',
      request: { attemptId: 'automatic-W1' },
    });

    const done = controller.cancel({ attemptId: 'quick' });
    expect(done.effects.filter((effect) => effect.type === 'automatic_slot_available')).toEqual([
      expect.objectContaining({ waiter: expect.objectContaining({ waiterId: 'W1' }) }),
    ]);
  });

  it('exposes discriminated registered, duplicate, and busy waiter registration results', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    controller.request(request('quick', 'quick'));
    const w1 = {
      waiterId: 'W1',
      generationOrEpoch: 1,
      baselineId: 'baseline-W1',
      configRevision: 'config-W1',
      targetRevision: 'target-W1',
    };
    const automatic = request('automatic-W1', 'automatic');

    expect(controller.registerAutomaticWaiter(automatic, w1)).toMatchObject({
      status: 'registered', waiter: { waiterId: 'W1' },
    });
    expect(controller.registerAutomaticWaiter(request('automatic-W1-retry', 'automatic'), w1)).toMatchObject({
      status: 'duplicate', waiter: { request: { attemptId: 'automatic-W1' } },
    });
    expect(controller.registerAutomaticWaiter(request('automatic-W2', 'automatic'), {
      ...w1, waiterId: 'W2',
    })).toMatchObject({
      status: 'busy', waiter: { waiterId: 'W1' },
    });
  });

  it('keeps Quick alive on mode-only change but cancels unrunnable automatic attempts', () => {
    const quick = new PeerAuditController('deck_proj_brain');
    quick.request(request('quick'));
    const unchanged = quick.modeChanged({ automaticRunnable: false });
    expect(unchanged).toMatchObject({ status: 'applied', pending: { attemptId: 'quick', revision: 1 } });

    const automatic = new PeerAuditController('deck_proj_brain');
    automatic.request(request('automatic', 'automatic'));
    expect(automatic.modeChanged({ automaticRunnable: false })).toMatchObject({
      terminal: { outcome: 'invalid_configuration', reason: 'automatic_mode_unrunnable' },
    });
  });

  it('invalidates a registered automatic waiter when its mode becomes unrunnable without ending Quick', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    controller.request(request('quick'));
    controller.request(request('automatic', 'automatic'), {
      waiterId: 'W1',
      generationOrEpoch: 1,
      baselineId: 'baseline-automatic',
      configRevision: 'config-automatic',
      targetRevision: 'target-automatic',
    });

    const changed = controller.modeChanged({ automaticRunnable: false });
    expect(changed).toMatchObject({ status: 'applied', pending: { attemptId: 'quick' } });
    expect(changed.effects).toEqual([expect.objectContaining({
      type: 'automatic_waiter_invalidated',
      attemptId: 'quick',
      effectRevision: 1,
      reason: 'automatic_mode_unrunnable',
      waiter: expect.objectContaining({ waiterId: 'W1' }),
    })]);
    expect(controller.automaticWaiter).toBeUndefined();

    const done = controller.cancel({ attemptId: 'quick' });
    expect(done.effects.some((effect) => effect.type === 'automatic_slot_available')).toBe(false);
  });

  it('cancels on baseline loss, target identity loss, configuration loss, and shutdown', () => {
    const cases = [
      (controller: PeerAuditController) => controller.baselineInvalidated('new_intent'),
      (controller: PeerAuditController) => controller.targetInvalidated('runtime_replaced'),
      (controller: PeerAuditController) => controller.configurationInvalidated('target_removed'),
      (controller: PeerAuditController) => controller.shutdown(),
    ];
    const outcomes = ['cancelled', 'target_unavailable', 'invalid_configuration', 'cancelled'];
    cases.forEach((terminate, index) => {
      const controller = new PeerAuditController('deck_proj_brain');
      controller.request(request(`attempt-${index}`));
      expect(terminate(controller).terminal?.outcome).toBe(outcomes[index]);
      expect(controller.pending).toBeUndefined();
    });
  });

  it('bounds terminal tombstones by capacity and TTL', () => {
    const controller = new PeerAuditController('deck_proj_brain', {
      tombstoneCapacity: 2,
      tombstoneTtlMs: 100,
    });
    for (const id of ['one', 'two', 'three']) {
      controller.request(request(id));
      controller.cancel({ attemptId: id });
    }
    expect(controller.tombstoneCount).toBe(2);
    expect(controller.getTombstone('one')).toBeUndefined();
    expect(controller.getTombstone('two')).toBeDefined();

    vi.advanceTimersByTime(100);
    expect(controller.tombstoneCount).toBe(0);
  });

  it('fails closed when a dispatch receipt binds a replaced auditor identity', () => {
    const controller = new PeerAuditController('deck_proj_brain');
    controller.request(request('identity'));
    const changed = controller.dispatchResolved({
      attemptId: 'identity',
      effectRevision: 1,
      receipt: { ...receipt(), targetRuntimeEpoch: 'replacement-runtime' },
    });
    expect(changed).toMatchObject({
      terminal: { outcome: 'target_unavailable', reason: 'target_identity_changed' },
    });
  });
});
