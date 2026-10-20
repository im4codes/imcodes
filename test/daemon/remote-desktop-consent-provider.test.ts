import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_CONSENT_CANCEL_REASON,
  REMOTE_DESKTOP_CONSENT_DECISION,
  REMOTE_DESKTOP_CONSENT_MSG,
  REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY,
  type RemoteDesktopConsentRequest,
} from '../../shared/remote-desktop-access.js';
import {
  LocalRemoteDesktopConsentProvider,
  localConsentCapabilities,
  type LocalConsentSurfaceState,
  type LocalConsentUi,
  type LocalConsentUiOutcome,
} from '../../src/daemon/remote-desktop-consent-provider.js';

// The contract requires 16-128 char ids; short fixtures would be rejected by
// validation and every test would pass for the wrong reason.
const APPROVAL_ID = 'approval-0000000000000001';
const HOST_ID = 'host-00000000000000000001';

const HEALTHY: LocalConsentSurfaceState = {
  uiAvailable: true,
  interactiveSession: true,
  protectedDesktopActive: false,
};

function request(overrides: Partial<RemoteDesktopConsentRequest> = {}): RemoteDesktopConsentRequest {
  return {
    type: REMOTE_DESKTOP_CONSENT_MSG.REQUEST,
    approvalId: APPROVAL_ID,
    hostId: HOST_ID,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    requesterLabel: 'alice@example.com',
    createdAt: 1_000,
    deadlineAt: 31_000,
    daemonGeneration: 7,
    ...overrides,
  };
}

function harness(options: {
  outcome?: LocalConsentUiOutcome | (() => Promise<LocalConsentUiOutcome>);
  surface?: LocalConsentSurfaceState | (() => Promise<LocalConsentSurfaceState>);
  generation?: () => number;
  hostId?: string;
  dismiss?: () => void;
} = {}) {
  const dismissed: string[] = [];
  const prompted: RemoteDesktopConsentRequest[] = [];
  const teardownFailures: string[] = [];
  const ui: LocalConsentUi = {
    async prompt(req) {
      prompted.push(req);
      const outcome = options.outcome
        ?? ({ kind: 'decision', decision: REMOTE_DESKTOP_CONSENT_DECISION.APPROVED } as const);
      return typeof outcome === 'function' ? outcome() : outcome;
    },
    dismiss(approvalId) {
      dismissed.push(approvalId);
      options.dismiss?.();
    },
    surfaceState() {
      const surface = options.surface ?? HEALTHY;
      return typeof surface === 'function' ? surface() : surface;
    },
  };
  const provider = new LocalRemoteDesktopConsentProvider({
    ui,
    daemonGeneration: options.generation ?? (() => 7),
    hostId: () => options.hostId ?? HOST_ID,
    now: () => Date.now(),
    onTeardownFailure: (approvalId) => teardownFailures.push(approvalId),
  });
  return { provider, dismissed, prompted, teardownFailures };
}

describe('LocalRemoteDesktopConsentProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  afterEach(() => vi.useRealTimers());

  it('returns the human approval bound to the requesting generation', async () => {
    const { provider, prompted } = harness();
    await expect(provider.request(request())).resolves.toEqual({
      type: REMOTE_DESKTOP_CONSENT_MSG.RESULT,
      approvalId: APPROVAL_ID,
      decision: REMOTE_DESKTOP_CONSENT_DECISION.APPROVED,
      daemonGeneration: 7,
    });
    // The label and mode the human saw are exactly what the Server sent.
    expect(prompted[0]).toMatchObject({
      requesterLabel: 'alice@example.com',
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    });
  });

  it('returns a denial as a decision, not as a cancel', async () => {
    // Deny is an answer. Collapsing it into a cancel would let the Server
    // retry it as though the operator had simply not been reached.
    const { provider } = harness({
      outcome: { kind: 'decision', decision: REMOTE_DESKTOP_CONSENT_DECISION.DENIED },
    });
    await expect(provider.request(request())).resolves.toMatchObject({
      type: REMOTE_DESKTOP_CONSENT_MSG.RESULT,
      decision: REMOTE_DESKTOP_CONSENT_DECISION.DENIED,
    });
  });

  it.each([
    ['non-interactive session', { ...HEALTHY, interactiveSession: false },
      REMOTE_DESKTOP_CONSENT_CANCEL_REASON.NON_INTERACTIVE_SESSION],
    ['protected desktop in front', { ...HEALTHY, protectedDesktopActive: true },
      REMOTE_DESKTOP_CONSENT_CANCEL_REASON.PROTECTED_DESKTOP],
    ['no signed local UI', { ...HEALTHY, uiAvailable: false },
      REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED],
  ] as const)('fails closed on %s without ever prompting', async (_label, surface, reason) => {
    const { provider, prompted } = harness({ surface });
    await expect(provider.request(request())).resolves.toEqual({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      approvalId: APPROVAL_ID,
      reason,
    });
    expect(prompted).toEqual([]);
  });

  it('fails closed when the surface probe itself throws', async () => {
    const { provider, prompted } = harness({
      surface: () => Promise.reject(new Error('adapter gone')),
    });
    await expect(provider.request(request())).resolves.toMatchObject({
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
    });
    expect(prompted).toEqual([]);
  });

  it('fails closed when the prompt throws mid-flight', async () => {
    const { provider, dismissed } = harness({
      outcome: () => Promise.reject(new Error('ui crashed')),
    });
    await expect(provider.request(request())).resolves.toMatchObject({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
    });
    // Even a crashed prompt gets torn down; a stuck window is its own hazard.
    expect(dismissed).toEqual([APPROVAL_ID]);
  });

  it('times out a prompt the human never answers', async () => {
    const { provider } = harness({ outcome: () => new Promise<never>(() => {}) });
    const pending = provider.request(request());
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(pending).resolves.toEqual({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      approvalId: APPROVAL_ID,
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT,
    });
  });

  it('refuses an approval that arrives after its own deadline', async () => {
    // The window closed while the human was deciding. The Server has already
    // stopped waiting, so honouring the click would resurrect a dead approval.
    let release!: (outcome: LocalConsentUiOutcome) => void;
    const { provider } = harness({
      outcome: () => new Promise<LocalConsentUiOutcome>((resolve) => { release = resolve; }),
    });
    const pending = provider.request(request());
    await vi.advanceTimersByTimeAsync(29_999);
    vi.setSystemTime(40_000);
    release({ kind: 'decision', decision: REMOTE_DESKTOP_CONSENT_DECISION.APPROVED });
    await expect(pending).resolves.toMatchObject({
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT,
    });
  });

  it('rejects a request minted for a different daemon generation', async () => {
    const { provider, prompted } = harness({ generation: () => 9 });
    await expect(provider.request(request({ daemonGeneration: 7 }))).resolves.toEqual({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      approvalId: APPROVAL_ID,
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.DAEMON_GENERATION_CHANGED,
    });
    expect(prompted).toEqual([]);
  });

  it('discards an approval when the daemon reconnected while the human decided', async () => {
    let generation = 7;
    let release!: (outcome: LocalConsentUiOutcome) => void;
    const { provider } = harness({
      generation: () => generation,
      outcome: () => new Promise<LocalConsentUiOutcome>((resolve) => { release = resolve; }),
    });
    const pending = provider.request(request());
    await vi.advanceTimersByTimeAsync(0);
    generation = 8;
    release({ kind: 'decision', decision: REMOTE_DESKTOP_CONSENT_DECISION.APPROVED });
    await expect(pending).resolves.toMatchObject({
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.DAEMON_GENERATION_CHANGED,
    });
  });

  it('refuses a request addressed to a different host', async () => {
    // Prompting here would ask this operator to approve access to a machine
    // they are not sitting at, and record their yes against it.
    const { provider, prompted } = harness({ hostId: 'host-99999999999999999999' });
    await expect(provider.request(request())).resolves.toMatchObject({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      approvalId: APPROVAL_ID,
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.HOST_MISMATCH,
    });
    expect(prompted).toEqual([]);
  });

  it('refuses a replayed approval id instead of opening a second prompt', async () => {
    const { provider, prompted } = harness({ outcome: () => new Promise<never>(() => {}) });
    const first = provider.request(request());
    // The prompt is registered after an async surface probe, so let that
    // settle before replaying -- otherwise the test races the guard it checks.
    await vi.advanceTimersByTimeAsync(0);
    const replay = await provider.request(request());
    expect(replay).toMatchObject({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
    });
    expect(prompted).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_001);
    await first;
  });

  it('refuses a replay after the first approval already completed', async () => {
    const { provider, prompted } = harness();
    await expect(provider.request(request())).resolves.toMatchObject({
      type: REMOTE_DESKTOP_CONSENT_MSG.RESULT,
      decision: REMOTE_DESKTOP_CONSENT_DECISION.APPROVED,
    });
    await expect(provider.request(request())).resolves.toEqual({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      approvalId: APPROVAL_ID,
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
    });
    expect(prompted).toHaveLength(1);
  });

  it.each([
    ['a malformed payload', { type: 'nonsense' }],
    ['a mode the contract does not define', { mode: 'god-mode' }],
    ['an oversized requester label', { requesterLabel: 'x'.repeat(200) }],
    ['a deadline that never advances', { deadlineAt: 1_000 }],
  ] as const)('fails closed on %s', async (_label, patch) => {
    const { provider, prompted } = harness();
    const payload = 'type' in patch ? patch : { ...request(), ...patch };
    const outcome = await provider.request(payload);
    expect(outcome.type).toBe(REMOTE_DESKTOP_CONSENT_MSG.CANCEL);
    expect(prompted).toEqual([]);
  });

  it('closes an open prompt on local Stop and answers nothing', async () => {
    const { provider, dismissed } = harness({ outcome: () => new Promise<never>(() => {}) });
    const pending = provider.request(request());
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.pendingApprovalIds()).toEqual([APPROVAL_ID]);

    await provider.cancelAll(REMOTE_DESKTOP_CONSENT_CANCEL_REASON.NODE_RESTARTED);
    expect(dismissed).toContain(APPROVAL_ID);
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(pending).resolves.toMatchObject({ type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL });
  });

  it.each([
    ['browser disconnect', REMOTE_DESKTOP_CONSENT_CANCEL_REASON.BROWSER_DISCONNECTED],
    ['link revocation', REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LINK_REVOKED],
  ] as const)('tears the prompt down on %s', async (_label, reason) => {
    const { provider, dismissed } = harness({ outcome: () => new Promise<never>(() => {}) });
    const pending = provider.request(request());
    await vi.advanceTimersByTimeAsync(0);
    await provider.cancelPending(APPROVAL_ID, reason);
    expect(dismissed).toContain(APPROVAL_ID);
    await vi.advanceTimersByTimeAsync(30_001);
    await pending;
  });

  it('fails an approval closed when the prompt cannot be torn down', async () => {
    const { provider, teardownFailures } = harness({
      dismiss: () => { throw new Error('window handle gone'); },
    });
    await expect(provider.request(request())).resolves.toEqual({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      approvalId: APPROVAL_ID,
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
    });
    expect(teardownFailures).toEqual([APPROVAL_ID]);
  });

  it('preserves the exact external cancellation reason', async () => {
    const { provider } = harness({ outcome: () => new Promise<never>(() => {}) });
    const pending = provider.request(request());
    await vi.advanceTimersByTimeAsync(0);
    await provider.cancelPending(
      APPROVAL_ID,
      REMOTE_DESKTOP_CONSENT_CANCEL_REASON.BROWSER_DISCONNECTED,
    );
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(pending).resolves.toEqual({
      type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
      approvalId: APPROVAL_ID,
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.BROWSER_DISCONNECTED,
    });
  });

  it('cancelling an unknown approval id is a safe no-op', async () => {
    const { provider, dismissed } = harness();
    await provider.cancelPending('never-existed-approval-id-0001', REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LINK_REVOKED);
    expect(dismissed).toEqual([]);
  });
});

describe('local consent capability advertisement', () => {
  it('advertises only when a human can actually be asked right now', () => {
    expect(localConsentCapabilities(HEALTHY)).toEqual([REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY]);
  });

  it.each([
    ['no signed UI on this host', { ...HEALTHY, uiAvailable: false }],
    ['a service session with no desktop', { ...HEALTHY, interactiveSession: false }],
  ] as const)('withholds the capability with %s', (_label, surface) => {
    // Advertising optimistically would let the Server route an attended link
    // to a host that will silently never prompt.
    expect(localConsentCapabilities(surface)).toEqual([]);
  });
});
