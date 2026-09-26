/**
 * Free-text provider refusals seen on pair participants, e.g. "Selected model
 * is at capacity" -- a plain failed turn, with no structured field a caller
 * could trust the way `SessionRecord.providerLimit` is trusted.
 *
 * OWNER RULE (tsk_cd_limit_failover addendum 2): despite the wording overlap,
 * this is NEVER treated as a rate/usage limit. A real limit is decided ONLY
 * by structured evidence (`isSessionProviderLimited`, `SessionRecord.providerLimit`);
 * this regex intentionally ALSO matches rate-limit-shaped wording ("rate
 * limit", "429", "quota exceeded") because a provider that only ever reports
 * its limit as free text -- no structured field at all -- must still be held
 * and retried like any other capacity error, not silently ignored. A hit here
 * means "this session cannot act right now, retry it on the next heartbeat";
 * it is scheduler.ts's `#capacityLimited`, checked strictly AFTER
 * `#rateLimited`, and it never fails over or replaces the auditor, however
 * long it persists (`#escalateCapacityAuditor`/`#escalateExecutor` just keep
 * retrying the same session and tell Brain once). Do not read a match here as
 * "this provider is rate-limited" -- it is not, unless structured evidence
 * also says so.
 */
import { TASK_PAIR_HEARTBEAT_MS } from '../../../shared/task-pair.js';
import { isTransientProviderError as isSharedTransientProviderError } from '../../../shared/provider-error-codes.js';
import type { TimelineEvent } from '../timeline-event.js';

/**
 * Wording that means "try again shortly" -- capacity, overload, and (despite
 * the name of the exported check) rate-limit-shaped text with no structured
 * evidence behind it. See the module doc above: never treated as a real
 * limit here regardless of which of these phrases matched.
 */

/**
 * True for capacity/overload/rate-limit-SHAPED free text. Despite matching
 * rate-limit wording, this is a capacity signal, never a rate-limit one --
 * see the module doc above. Kept under its original name (`isTransientProviderError`)
 * since it is exercised directly by existing tests; do not repurpose it as
 * "is this session rate-limited".
 */
export function isTransientProviderError(message: string | undefined): boolean {
  return isSharedTransientProviderError(message);
}

const lastErrorAt = new Map<string, number>();

/** A `session.state` error event: remember it when it is a transient provider refusal. */
export function noteTaskPairProviderError(event: Pick<TimelineEvent, 'sessionId' | 'ts' | 'payload'>): void {
  const payload = event.payload as Record<string, unknown>;
  if (payload.state !== 'error' || typeof payload.error !== 'string') return;
  if (!isTransientProviderError(payload.error)) return;
  lastErrorAt.set(event.sessionId, event.ts ?? Date.now());
}

/** The session produced output again: it is no longer refused. */
export function clearTaskPairProviderError(sessionName: string): void {
  lastErrorAt.delete(sessionName);
}

/**
 * Limited because of a transient provider refusal recently: within one and a
 * half heartbeats of the latest error. The heartbeat right after an error
 * always sees it (however close to that tick it landed); the one after that
 * retries with an ordinary nudge, which either succeeds or refreshes the error.
 */
export function hasRecentTaskPairProviderError(sessionName: string, now: number, heartbeatMs = TASK_PAIR_HEARTBEAT_MS): boolean {
  const at = lastErrorAt.get(sessionName);
  return at !== undefined && now - at < heartbeatMs * 1.5;
}

export function resetTaskPairProviderErrorsForTests(): void {
  lastErrorAt.clear();
}
