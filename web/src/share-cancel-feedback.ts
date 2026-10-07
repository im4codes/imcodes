import { SHARE_DENIAL_REASONS } from '@shared/tab-sharing.js';

/**
 * A shared participant's Stop can be refused (rate limit, the turn changed,
 * access ended...). The refusal arrives as `command.failed` on the websocket or
 * as an HTTP error body; either way the participant must be told, never left
 * with a Stop that silently did nothing. Components register the commandId of
 * each cancel they send; the app turns a refusal of a registered id into a toast.
 */
export const SHARE_CANCEL_FAILED_EVENT = 'deck:share-cancel-failed';
const MAX_TRACKED_CANCELS = 64;
const trackedCancelIds = new Set<string>();

export interface ShareCancelFailure {
  reason: string | null;
  /** The turn the server knows is running, when it refused because the turn changed. */
  activeDispatchId?: string | null;
  session?: string;
}

export function trackShareCancelCommand(commandId: string): void {
  trackedCancelIds.add(commandId);
  while (trackedCancelIds.size > MAX_TRACKED_CANCELS) {
    const oldest = trackedCancelIds.values().next().value;
    if (oldest === undefined) break;
    trackedCancelIds.delete(oldest);
  }
}

/** True once per registered cancel id. */
export function takeTrackedShareCancel(commandId: string): boolean {
  return trackedCancelIds.delete(commandId);
}

export function notifyShareCancelFailure(failure: ShareCancelFailure): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ShareCancelFailure>(SHARE_CANCEL_FAILED_EVENT, { detail: failure }));
}

const KNOWN_REASONS: ReadonlySet<string> = new Set(SHARE_DENIAL_REASONS);

/** i18n key (under `share.cancel_failed.reason`) for a refusal; an unknown reason reads as the generic one. */
export function shareCancelFailureReasonKey(reason: string | null | undefined): string {
  if (!reason || !KNOWN_REASONS.has(reason)) return 'generic';
  switch (reason) {
    case 'share-rate-limited': return 'rate_limited';
    case 'share-dispatch-changed': return 'dispatch_changed';
    case 'share-cancel-unsupported': return 'unsupported';
    case 'share-role-denied': return 'role_denied';
    case 'share-revoked':
    case 'share-expired':
    case 'share-role-changed': return 'access_ended';
    default: return 'generic';
  }
}

/** The refusal an HTTP cancel returned (`{error, reason, activeDispatchId}`), or null for any other failure. */
export function shareCancelFailureFromHttpError(err: unknown): ShareCancelFailure | null {
  const body = (err as { body?: unknown } | null)?.body;
  if (typeof body !== 'string') return null;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown; activeDispatchId?: unknown };
    if (typeof parsed.reason !== 'string') return null;
    return {
      reason: parsed.reason,
      ...(typeof parsed.activeDispatchId === 'string' ? { activeDispatchId: parsed.activeDispatchId } : {}),
    };
  } catch {
    return null;
  }
}
