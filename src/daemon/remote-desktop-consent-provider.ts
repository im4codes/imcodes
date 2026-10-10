/**
 * Attended-consent provider: the local human's Allow/Deny gate.
 *
 * Everything here is written to fail CLOSED. A consent gate that answers
 * "approved" when it is merely confused is worse than one that never answers:
 * the operator is not at the machine, so nobody notices the wrong answer. Any
 * state this provider is not certain about resolves to a cancel with an
 * enumerated reason, never to a decision.
 *
 * The provider owns no transport of its own. The OS adapter that can actually
 * draw on the interactive desktop is injected, which keeps this state machine
 * testable off-Windows and keeps the platform code free of policy.
 */
import {
  REMOTE_DESKTOP_CONSENT_CANCEL_REASON,
  REMOTE_DESKTOP_CONSENT_DECISION,
  REMOTE_DESKTOP_CONSENT_MSG,
  REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY,
  validateRemoteDesktopConsentMessage,
  type RemoteDesktopConsentCancel,
  type RemoteDesktopConsentCancelReason,
  type RemoteDesktopConsentRequest,
  type RemoteDesktopConsentResult,
} from '../../shared/remote-desktop-access.js';

/**
 * What the OS adapter must be able to do before the node may advertise the
 * consent capability. Each is a separate reason a host can be unable to ask,
 * and the node must not claim the capability on any of them.
 */
export interface LocalConsentSurfaceState {
  /** A signed local UI exists and can be launched on this host. */
  uiAvailable: boolean;
  /** Some desktop is attached and can present UI (not a service session). */
  interactiveSession: boolean;
  /**
   * The secure/protected desktop (UAC, credential provider, lock screen) is
   * currently in front. Ordinary applications cannot draw there, so a prompt
   * would either not appear or appear behind it -- both read to the operator
   * as "nothing happened" while an approval is pending.
   */
  protectedDesktopActive: boolean;
}

export type LocalConsentUiOutcome =
  | { kind: 'decision'; decision: typeof REMOTE_DESKTOP_CONSENT_DECISION[keyof typeof REMOTE_DESKTOP_CONSENT_DECISION] }
  | { kind: 'cancelled'; reason: RemoteDesktopConsentCancelReason };

export interface LocalConsentUi {
  /**
   * Present the prompt and resolve with the local human's answer. Rejecting,
   * or resolving `cancelled`, is always acceptable: the provider converts both
   * into an enumerated cancel. It must never resolve `decision` for a prompt
   * it did not actually show.
   */
  prompt(request: RemoteDesktopConsentRequest, signal: AbortSignal): Promise<LocalConsentUiOutcome>;
  /** Tear the prompt down. Called for every terminal path, including throws. */
  dismiss(approvalId: string): void | Promise<void>;
  surfaceState(): LocalConsentSurfaceState | Promise<LocalConsentSurfaceState>;
}

export interface LocalRemoteDesktopConsentProviderDeps {
  ui: LocalConsentUi;
  /**
   * Current daemon generation. Authority is generation-bound: a result that
   * comes back after a reconnect belongs to an authority that no longer
   * exists and must not be honoured.
   */
  daemonGeneration: () => number;
  /**
   * This host's own id. A request addressed to a different host must never be
   * prompted here: it would ask THIS operator to approve access to a machine
   * they are not sitting at, and their yes would be recorded against it.
   */
  hostId: () => string;
  now?: () => number;
  onTeardownFailure?: (approvalId: string, error: unknown) => void;
}

export type ConsentOutcome = RemoteDesktopConsentResult | RemoteDesktopConsentCancel;

interface PendingConsent {
  controller: AbortController;
  externalReason?: RemoteDesktopConsentCancelReason;
}

// The Server also bounds pending approvals. Keep a local hard ceiling so a
// reconnecting or compromised peer cannot grow replay tombstones forever.
const MAX_REMEMBERED_APPROVALS = 256;

function cancel(approvalId: string, reason: RemoteDesktopConsentCancelReason): RemoteDesktopConsentCancel {
  return { type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL, approvalId, reason };
}

/**
 * The node may advertise local consent only when the surface can actually ask
 * a human right now. Advertising it optimistically would let the Server route
 * an attended link to a host that will silently never prompt.
 */
export function localConsentCapabilities(state: LocalConsentSurfaceState): string[] {
  return state.uiAvailable && state.interactiveSession
    ? [REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY]
    : [];
}

export class LocalRemoteDesktopConsentProvider {
  private readonly deps: LocalRemoteDesktopConsentProviderDeps;
  private readonly pending = new Map<string, PendingConsent>();
  /** Valid approval identities are one-shot even after the prompt completed. */
  private readonly seen = new Map<string, number>();

  constructor(deps: LocalRemoteDesktopConsentProviderDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Approval ids currently showing a prompt. Exposed for teardown on stop. */
  pendingApprovalIds(): string[] {
    return [...this.pending.keys()];
  }

  private pruneSeen(): void {
    const now = this.now();
    for (const [approvalId, deadlineAt] of this.seen) {
      if (deadlineAt <= now && !this.pending.has(approvalId)) this.seen.delete(approvalId);
    }
  }

  async request(raw: unknown): Promise<ConsentOutcome> {
    // Re-validate at the boundary even though the Server validated: this
    // process is the one that will draw an attacker-influenced label on the
    // local user's screen.
    const parsed = validateRemoteDesktopConsentMessage(raw);
    if (!parsed.ok || parsed.value.type !== REMOTE_DESKTOP_CONSENT_MSG.REQUEST) {
      const approvalId = typeof (raw as { approvalId?: unknown })?.approvalId === 'string'
        ? (raw as { approvalId: string }).approvalId
        : '';
      return cancel(approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED);
    }
    const request = parsed.value;

    // Replay: the same approval id must never open a second prompt, including
    // after its first result was already returned. Two prompts for one id mean
    // two chances to catch the operator off guard and make a captured replay
    // useful again.
    this.pruneSeen();
    if (this.seen.has(request.approvalId)) {
      return cancel(request.approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED);
    }
    if (this.seen.size >= MAX_REMEMBERED_APPROVALS) {
      return cancel(request.approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED);
    }
    this.seen.set(request.approvalId, request.deadlineAt);

    if (request.hostId !== this.deps.hostId()) {
      return cancel(request.approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.HOST_MISMATCH);
    }

    const generation = this.deps.daemonGeneration();
    if (request.daemonGeneration !== generation) {
      return cancel(request.approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.DAEMON_GENERATION_CHANGED);
    }

    const remaining = request.deadlineAt - this.now();
    if (remaining <= 0) {
      return cancel(request.approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT);
    }

    let surface: LocalConsentSurfaceState;
    try {
      surface = await this.deps.ui.surfaceState();
    } catch {
      return cancel(request.approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED);
    }
    // Order matters: report the most specific blocking cause so the Server can
    // tell the requester something true instead of a generic failure.
    if (!surface.interactiveSession) {
      return cancel(request.approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.NON_INTERACTIVE_SESSION);
    }
    if (surface.protectedDesktopActive) {
      return cancel(request.approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.PROTECTED_DESKTOP);
    }
    if (!surface.uiAvailable) {
      return cancel(request.approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED);
    }

    const controller = new AbortController();
    const pending: PendingConsent = { controller };
    this.pending.set(request.approvalId, pending);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolved: ConsentOutcome;
    try {
      const timeout = new Promise<LocalConsentUiOutcome>((resolveTimeout) => {
        timer = setTimeout(() => {
          controller.abort();
          resolveTimeout({ kind: 'cancelled', reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT });
        }, remaining);
        timer.unref?.();
      });
      const outcome = await Promise.race([
        this.deps.ui.prompt(request, controller.signal),
        timeout,
      ]);
      if (outcome.kind === 'cancelled') {
        resolved = cancel(
          request.approvalId,
          pending.externalReason ?? outcome.reason,
        );
      } else if (this.deps.daemonGeneration() !== generation) {
        // Re-check the generation AFTER the human answered. The answer took
        // real wall-clock time; a reconnect during it invalidated the
        // authority this approval would have been granted under.
        resolved = cancel(
          request.approvalId,
          REMOTE_DESKTOP_CONSENT_CANCEL_REASON.DAEMON_GENERATION_CHANGED,
        );
      } else if (this.now() >= request.deadlineAt) {
        // A prompt that outlived its own deadline must not be honoured even if
        // the human did click Allow: the Server has already given up on it.
        resolved = cancel(request.approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT);
      } else {
        resolved = {
          type: REMOTE_DESKTOP_CONSENT_MSG.RESULT,
          approvalId: request.approvalId,
          decision: outcome.decision,
          daemonGeneration: generation,
        };
      }
    } catch {
      // Provider failure. Never an approval.
      resolved = cancel(request.approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED);
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(request.approvalId);
    }
    // Approval is not safe until the prompt is gone. A teardown failure after
    // Allow could otherwise leave a stale trusted-looking question on screen
    // while PREPARE/capture starts behind it. Denial remains denial because it
    // cannot grant capture, but every approval fails closed.
    try {
      await this.deps.ui.dismiss(request.approvalId);
    } catch (error) {
      this.deps.onTeardownFailure?.(request.approvalId, error);
      if (resolved.type === REMOTE_DESKTOP_CONSENT_MSG.RESULT
        && resolved.decision === REMOTE_DESKTOP_CONSENT_DECISION.APPROVED) {
        return cancel(request.approvalId, REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED);
      }
    }
    return resolved;
  }

  /**
   * External cancellation: link revoked, browser gone, local Stop, node
   * restart. Idempotent, and safe for an id that was never pending.
   */
  async cancelPending(approvalId: string, reason: RemoteDesktopConsentCancelReason): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (!pending) return;
    pending.externalReason = reason;
    pending.controller.abort();
    try {
      await this.deps.ui.dismiss(approvalId);
    } catch (error) {
      this.deps.onTeardownFailure?.(approvalId, error);
    }
  }

  /** Local Stop / shutdown: every open prompt closes and answers nothing. */
  async cancelAll(reason: RemoteDesktopConsentCancelReason): Promise<void> {
    await Promise.all(this.pendingApprovalIds().map((id) => this.cancelPending(id, reason)));
    this.seen.clear();
  }
}
