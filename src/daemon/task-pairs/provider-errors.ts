/**
 * Transient provider refusals ("Selected model is at capacity", rate limits,
 * overload) seen on pair participants.
 *
 * Only some providers report a structured usage limit that delegation
 * availability understands; a Codex capacity error arrives as a plain failed
 * turn. For a pair both mean the same thing: the side cannot act right now. So
 * the pair treats such a session as limited for about a heartbeat after its
 * latest error, which routes it through the existing limited path (auditor replaced,
 * executor held without nudges and escalated only if the limit lasts), instead
 * of nudging a session that cannot answer or stopping anything.
 */
import { TASK_PAIR_HEARTBEAT_MS } from '../../../shared/task-pair.js';
import type { TimelineEvent } from '../timeline-event.js';

/** Provider refusals that pass on their own; anything else is a real failure. */
const TRANSIENT_PROVIDER_ERROR_RE = /\bat capacity\b|\bcapacity\b.*\b(?:model|reached|exceeded)\b|rate[ _-]?limit|too many requests|\b429\b|\b529\b|\b503\b|overloaded|temporarily unavailable|usage limit|quota (?:exceeded|exhausted)/i;

export function isTransientProviderError(message: string | undefined): boolean {
  return !!message && TRANSIENT_PROVIDER_ERROR_RE.test(message);
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
