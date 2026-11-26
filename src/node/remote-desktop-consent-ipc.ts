/**
 * Minimal typed adapter between the consent provider and the native worker.
 *
 * The existing worker `Signal` protocol is session-shaped: every frame carries
 * requestId/sessionId/capability and is authenticated against a tracked
 * session. A consent request has none of those -- it exists precisely because
 * no session has been authorized yet -- so routing it through that union would
 * either require forging a session or weakening the authentication that
 * protects real ones. This adapter is therefore a separate, narrow frame pair
 * that shares only the pipe.
 *
 * Frame type strings are spelled here because C++ cannot import the shared TS
 * module. `test/spec/windows-remote-desktop-build-manifests.test.ts` asserts
 * these literals equal the shared contract and equal the native header, so the
 * three cannot drift.
 */
import {
  REMOTE_DESKTOP_CONSENT_MSG,
  type RemoteDesktopConsentRequest,
} from '../../shared/remote-desktop-access.js';
import {
  hasExactRemoteDesktopKeys,
  isRemoteDesktopId,
} from '../../shared/remote-desktop-contract-primitives.js';
import type {
  LocalConsentSurfaceState,
  LocalConsentUi,
  LocalConsentUiOutcome,
} from '../daemon/remote-desktop-consent-provider.js';
import { REMOTE_DESKTOP_CONSENT_CANCEL_REASON } from '../../shared/remote-desktop-access.js';

/** Worker-bound frames. Deliberately not part of the session Signal union. */
export const WORKER_CONSENT_FRAME = {
  ASK: 'worker.consent.ask',
  ANSWER: 'worker.consent.answer',
  DISMISS: 'worker.consent.dismiss',
  SURFACE_QUERY: 'worker.consent.surface_query',
  SURFACE_STATE: 'worker.consent.surface_state',
} as const;

/**
 * What the native prompt can report. `allowed`/`denied` are the only values
 * that may become a decision; the rest are cancels with a cause.
 */
export const WORKER_CONSENT_OUTCOME = {
  ALLOWED: 'allowed',
  DENIED: 'denied',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
  UNAVAILABLE: 'unavailable',
} as const;

export type WorkerConsentOutcome =
  typeof WORKER_CONSENT_OUTCOME[keyof typeof WORKER_CONSENT_OUTCOME];

export interface WorkerConsentAnswerFrame {
  type: typeof WORKER_CONSENT_FRAME.ANSWER;
  approvalId: string;
  outcome: WorkerConsentOutcome;
}

export interface WorkerConsentSurfaceFrame {
  type: typeof WORKER_CONSENT_FRAME.SURFACE_STATE;
  uiAvailable: boolean;
  interactiveSession: boolean;
  protectedDesktopActive: boolean;
}

export type WorkerConsentInboundFrame =
  | WorkerConsentAnswerFrame
  | WorkerConsentSurfaceFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const OUTCOMES = new Set<string>(Object.values(WORKER_CONSENT_OUTCOME));

/**
 * Parse a frame arriving from the worker. Unrecognised or malformed input
 * returns null rather than a partially-trusted object: this pipe carries the
 * answer to a security question, so "close enough" is not acceptable.
 */
export function parseWorkerConsentFrame(value: unknown): WorkerConsentInboundFrame | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === WORKER_CONSENT_FRAME.ANSWER) {
    if (!hasExactRemoteDesktopKeys(value, ['type', 'approvalId', 'outcome'])) return null;
    if (!isRemoteDesktopId(value.approvalId)) return null;
    if (typeof value.outcome !== 'string' || !OUTCOMES.has(value.outcome)) return null;
    return {
      type: WORKER_CONSENT_FRAME.ANSWER,
      approvalId: value.approvalId,
      outcome: value.outcome as WorkerConsentOutcome,
    };
  }
  if (value.type === WORKER_CONSENT_FRAME.SURFACE_STATE) {
    if (!hasExactRemoteDesktopKeys(value, [
      'type', 'uiAvailable', 'interactiveSession', 'protectedDesktopActive',
    ])) return null;
    if (typeof value.uiAvailable !== 'boolean'
      || typeof value.interactiveSession !== 'boolean'
      || typeof value.protectedDesktopActive !== 'boolean') return null;
    return {
      type: WORKER_CONSENT_FRAME.SURFACE_STATE,
      uiAvailable: value.uiAvailable,
      interactiveSession: value.interactiveSession,
      protectedDesktopActive: value.protectedDesktopActive,
    };
  }
  return null;
}

export interface WorkerConsentTransport {
  /** Resolves false when the frame could not be handed to the worker. */
  send(frame: Record<string, unknown>): Promise<boolean> | boolean;
  /** Register for inbound consent frames; returns an unsubscribe. */
  subscribe(handler: (frame: WorkerConsentInboundFrame) => void): () => void;
}

const SURFACE_PROBE_TIMEOUT_MS = 2_000;
/** Nothing may be believed about the desktop without a fresh answer. */
const UNAVAILABLE_SURFACE: LocalConsentSurfaceState = {
  uiAvailable: false,
  interactiveSession: false,
  protectedDesktopActive: false,
};

/**
 * Drives the native prompt over the worker pipe. Every failure mode -- worker
 * gone, frame refused, no reply, malformed reply -- resolves to a cancel or an
 * unavailable surface, never to an approval.
 */
export class WorkerConsentUi implements LocalConsentUi {
  private readonly transport: WorkerConsentTransport;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;

  constructor(transport: WorkerConsentTransport, options: {
    probeTimeoutMs?: number;
    now?: () => number;
  } = {}) {
    this.transport = transport;
    this.probeTimeoutMs = options.probeTimeoutMs ?? SURFACE_PROBE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async surfaceState(): Promise<LocalConsentSurfaceState> {
    return new Promise<LocalConsentSurfaceState>((resolve) => {
      let settled = false;
      const finish = (state: LocalConsentSurfaceState) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(state);
      };
      const unsubscribe = this.transport.subscribe((frame) => {
        if (frame.type !== WORKER_CONSENT_FRAME.SURFACE_STATE) return;
        finish({
          uiAvailable: frame.uiAvailable,
          interactiveSession: frame.interactiveSession,
          protectedDesktopActive: frame.protectedDesktopActive,
        });
      });
      const timer = setTimeout(() => finish(UNAVAILABLE_SURFACE), this.probeTimeoutMs);
      timer.unref?.();
      void Promise.resolve(this.transport.send({ type: WORKER_CONSENT_FRAME.SURFACE_QUERY }))
        .then((sent) => { if (!sent) finish(UNAVAILABLE_SURFACE); })
        .catch(() => finish(UNAVAILABLE_SURFACE));
    });
  }

  async prompt(
    request: RemoteDesktopConsentRequest,
    signal: AbortSignal,
  ): Promise<LocalConsentUiOutcome> {
    return new Promise<LocalConsentUiOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: LocalConsentUiOutcome) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish({
        kind: 'cancelled',
        reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
      });
      const unsubscribe = this.transport.subscribe((frame) => {
        if (frame.type !== WORKER_CONSENT_FRAME.ANSWER) return;
        // An answer for a different approval belongs to another prompt; it is
        // never evidence about this one.
        if (frame.approvalId !== request.approvalId) return;
        if (frame.outcome === WORKER_CONSENT_OUTCOME.ALLOWED) {
          finish({ kind: 'decision', decision: 'approved' });
          return;
        }
        if (frame.outcome === WORKER_CONSENT_OUTCOME.DENIED) {
          finish({ kind: 'decision', decision: 'denied' });
          return;
        }
        finish({
          kind: 'cancelled',
          reason: frame.outcome === WORKER_CONSENT_OUTCOME.TIMED_OUT
            ? REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT
            : frame.outcome === WORKER_CONSENT_OUTCOME.UNAVAILABLE
              ? REMOTE_DESKTOP_CONSENT_CANCEL_REASON.PROTECTED_DESKTOP
              : REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
        });
      });
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      // The worker gets the deadline too, so a node that dies mid-prompt
      // cannot leave a question on the user's screen forever.
      void Promise.resolve(this.transport.send({
        type: WORKER_CONSENT_FRAME.ASK,
        approvalId: request.approvalId,
        requesterLabel: request.requesterLabel,
        mode: request.mode,
        deadlineMs: Math.max(1, request.deadlineAt - this.now()),
      })).then((sent) => {
        if (!sent) {
          finish({
            kind: 'cancelled',
            reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
          });
        }
      }).catch(() => finish({
        kind: 'cancelled',
        reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
      }));
    });
  }

  async dismiss(approvalId: string): Promise<void> {
    const sent = await Promise.resolve(
      this.transport.send({ type: WORKER_CONSENT_FRAME.DISMISS, approvalId }),
    );
    if (!sent) throw new Error('remote_desktop_consent_dismiss_failed');
  }
}

/** Re-exported for the consent request type used by the caller. */
export { REMOTE_DESKTOP_CONSENT_MSG };
