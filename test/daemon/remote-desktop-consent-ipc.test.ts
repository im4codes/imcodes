import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_CONSENT_CANCEL_REASON,
  REMOTE_DESKTOP_CONSENT_MSG,
  type RemoteDesktopConsentRequest,
} from '../../shared/remote-desktop-access.js';
import {
  WORKER_CONSENT_FRAME,
  WORKER_CONSENT_OUTCOME,
  WorkerConsentUi,
  parseWorkerConsentFrame,
  type WorkerConsentInboundFrame,
} from '../../src/node/remote-desktop-consent-ipc.js';

const APPROVAL_ID = 'approval-0000000000000001';

function request(): RemoteDesktopConsentRequest {
  return {
    type: REMOTE_DESKTOP_CONSENT_MSG.REQUEST,
    approvalId: APPROVAL_ID,
    hostId: 'host-00000000000000000001',
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    requesterLabel: 'alice@example.com',
    createdAt: 1_000,
    deadlineAt: 31_000,
    daemonGeneration: 7,
  };
}

function transport(options: { send?: () => boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  const handlers = new Set<(frame: WorkerConsentInboundFrame) => void>();
  return {
    sent,
    emit(frame: WorkerConsentInboundFrame) { for (const h of [...handlers]) h(frame); },
    transport: {
      send(frame: Record<string, unknown>) { sent.push(frame); return options.send?.() ?? true; },
      subscribe(handler: (frame: WorkerConsentInboundFrame) => void) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
    handlerCount: () => handlers.size,
  };
}

describe('parseWorkerConsentFrame', () => {
  it.each([
    ['a non-object', 42],
    ['an unknown type', { type: 'worker.consent.whatever' }],
    ['an answer with no approval id', { type: WORKER_CONSENT_FRAME.ANSWER, outcome: 'allowed' }],
    ['an answer with an outcome outside the enum', {
      type: WORKER_CONSENT_FRAME.ANSWER, approvalId: APPROVAL_ID, outcome: 'probably_fine',
    }],
    ['an answer with an unknown key', {
      type: WORKER_CONSENT_FRAME.ANSWER, approvalId: APPROVAL_ID,
      outcome: WORKER_CONSENT_OUTCOME.ALLOWED, authority: 'smuggled',
    }],
    ['an answer with a malformed approval id', {
      type: WORKER_CONSENT_FRAME.ANSWER, approvalId: 'short',
      outcome: WORKER_CONSENT_OUTCOME.ALLOWED,
    }],
    ['a surface frame with a non-boolean field', {
      type: WORKER_CONSENT_FRAME.SURFACE_STATE,
      uiAvailable: 'yes', interactiveSession: true, protectedDesktopActive: false,
    }],
  ] as const)('returns null for %s', (_label, value) => {
    // This pipe carries the answer to a security question; a partially
    // trusted parse is not acceptable.
    expect(parseWorkerConsentFrame(value)).toBeNull();
  });

  it('accepts a well-formed answer', () => {
    expect(parseWorkerConsentFrame({
      type: WORKER_CONSENT_FRAME.ANSWER,
      approvalId: APPROVAL_ID,
      outcome: WORKER_CONSENT_OUTCOME.DENIED,
    })).toEqual({
      type: WORKER_CONSENT_FRAME.ANSWER,
      approvalId: APPROVAL_ID,
      outcome: WORKER_CONSENT_OUTCOME.DENIED,
    });
  });
});

describe('WorkerConsentUi', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('carries the deadline to the worker so a dead node cannot strand a prompt', async () => {
    const t = transport();
    const ui = new WorkerConsentUi(t.transport, { now: () => 1_000 });
    const pending = ui.prompt(request(), new AbortController().signal);
    expect(t.sent[0]).toMatchObject({
      type: WORKER_CONSENT_FRAME.ASK,
      approvalId: APPROVAL_ID,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      deadlineMs: 30_000,
    });
    t.emit({ type: WORKER_CONSENT_FRAME.ANSWER, approvalId: APPROVAL_ID, outcome: WORKER_CONSENT_OUTCOME.ALLOWED });
    await expect(pending).resolves.toEqual({ kind: 'decision', decision: 'approved' });
  });

  it('sends only the deadline that remains when the prompt is finally shown', async () => {
    const t = transport();
    const ui = new WorkerConsentUi(t.transport, { now: () => 21_000 });
    const pending = ui.prompt(request(), new AbortController().signal);
    expect(t.sent[0]).toMatchObject({ deadlineMs: 10_000 });
    t.emit({
      type: WORKER_CONSENT_FRAME.ANSWER,
      approvalId: APPROVAL_ID,
      outcome: WORKER_CONSENT_OUTCOME.DENIED,
    });
    await pending;
  });

  it.each([
    [WORKER_CONSENT_OUTCOME.DENIED, { kind: 'decision', decision: 'denied' }],
    [WORKER_CONSENT_OUTCOME.TIMED_OUT, { kind: 'cancelled', reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT }],
    [WORKER_CONSENT_OUTCOME.UNAVAILABLE, { kind: 'cancelled', reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.PROTECTED_DESKTOP }],
    [WORKER_CONSENT_OUTCOME.CANCELLED, { kind: 'cancelled', reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED }],
  ] as const)('maps worker outcome %s without inventing a decision', async (outcome, expected) => {
    const t = transport();
    const ui = new WorkerConsentUi(t.transport);
    const pending = ui.prompt(request(), new AbortController().signal);
    t.emit({ type: WORKER_CONSENT_FRAME.ANSWER, approvalId: APPROVAL_ID, outcome });
    await expect(pending).resolves.toEqual(expected);
  });

  it('ignores an answer minted for a different approval', async () => {
    // Another prompt's answer is never evidence about this one.
    const t = transport();
    const ui = new WorkerConsentUi(t.transport);
    const pending = ui.prompt(request(), new AbortController().signal);
    t.emit({
      type: WORKER_CONSENT_FRAME.ANSWER,
      approvalId: 'approval-0000000000000099',
      outcome: WORKER_CONSENT_OUTCOME.ALLOWED,
    });
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);
    t.emit({ type: WORKER_CONSENT_FRAME.ANSWER, approvalId: APPROVAL_ID, outcome: WORKER_CONSENT_OUTCOME.DENIED });
    await expect(pending).resolves.toMatchObject({ kind: 'decision', decision: 'denied' });
  });

  it('cancels when the worker refuses the frame', async () => {
    const t = transport({ send: () => false });
    const ui = new WorkerConsentUi(t.transport);
    await expect(ui.prompt(request(), new AbortController().signal)).resolves.toEqual({
      kind: 'cancelled',
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
    });
  });

  it('cancels on abort and unsubscribes', async () => {
    const t = transport();
    const ui = new WorkerConsentUi(t.transport);
    const controller = new AbortController();
    const pending = ui.prompt(request(), controller.signal);
    expect(t.handlerCount()).toBe(1);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ kind: 'cancelled' });
    expect(t.handlerCount()).toBe(0);
  });

  it('reports an unavailable surface when the worker never answers the probe', async () => {
    // Silence must never read as "a human could be asked".
    const t = transport();
    const ui = new WorkerConsentUi(t.transport, { probeTimeoutMs: 100 });
    const pending = ui.surfaceState();
    await vi.advanceTimersByTimeAsync(101);
    await expect(pending).resolves.toEqual({
      uiAvailable: false,
      interactiveSession: false,
      protectedDesktopActive: false,
    });
  });

  it('reports an unavailable surface when the probe cannot be sent', async () => {
    const t = transport({ send: () => false });
    const ui = new WorkerConsentUi(t.transport, { probeTimeoutMs: 100 });
    await expect(ui.surfaceState()).resolves.toMatchObject({ uiAvailable: false });
  });

  it('relays a real surface answer', async () => {
    const t = transport();
    const ui = new WorkerConsentUi(t.transport, { probeTimeoutMs: 100 });
    const pending = ui.surfaceState();
    t.emit({
      type: WORKER_CONSENT_FRAME.SURFACE_STATE,
      uiAvailable: true,
      interactiveSession: true,
      protectedDesktopActive: true,
    });
    await expect(pending).resolves.toEqual({
      uiAvailable: true,
      interactiveSession: true,
      protectedDesktopActive: true,
    });
  });

  it('reports a dead worker while dismissing so approval fails closed', async () => {
    const t = transport({ send: () => false });
    const ui = new WorkerConsentUi(t.transport);
    await expect(ui.dismiss(APPROVAL_ID)).rejects.toThrow('remote_desktop_consent_dismiss_failed');
    expect(t.sent.at(-1)).toMatchObject({ type: WORKER_CONSENT_FRAME.DISMISS, approvalId: APPROVAL_ID });
  });
});
