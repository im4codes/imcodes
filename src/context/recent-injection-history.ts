/**
 * Per-session recent-injection history.
 *
 * Purpose: prevent the same memory items from being re-injected into prompts
 * on consecutive turns of the same session. Once a memory has been included
 * in a recall-injected prompt, it becomes low-value to inject again in the
 * immediate follow-up turns — the model already saw it, and repeating it
 * is noise.
 *
 * Scope:
 *   - Per session (keyed by `sessionKey` — e.g. `deck_<project>_<role>`).
 *   - Daemon-only, in-memory. Cleared on session `clear` and on daemon
 *     restart (a restart is effectively a clear from the user's POV).
 *   - Does NOT apply to startup bootstrap (which is project-scoped memory
 *     load, not a query-driven recall) or to server-side recall endpoint
 *     (no per-session context).
 *
 * Semantics:
 *   - "Last 10 turns" = the last 10 successful injection events, where
 *     each event carries the set of memory IDs that were injected on
 *     that turn. Unit is "turn", not "memory id": 1 event with 5 ids
 *     consumes 1 slot, not 5.
 *   - A candidate is considered "already injected recently" if its id
 *     appears in ANY of the retained injection events for this session.
 *   - The history is a ring buffer: recording the 11th event evicts
 *     the oldest.
 */

const HISTORY_SIZE = 10;

/**
 * One past injection turn — the set of memory IDs that entered the prompt
 * on that turn.
 */
type InjectionEvent = ReadonlySet<string>;

/**
 * Keyed by `sessionKey`. Each value is an array of up to `HISTORY_SIZE`
 * injection events, most recent first.
 */
const sessionHistory: Map<string, InjectionEvent[]> = new Map();

/**
 * Drop `memoryIds` that appear in any of the last `HISTORY_SIZE` injection
 * events for this session. Returns a new array; does not mutate input.
 *
 * When `sessionKey` is falsy (e.g. anonymous WS lookup), no dedup is
 * performed and all ids pass through.
 */
export function filterRecentlyInjected(
  sessionKey: string | undefined,
  memoryIds: readonly string[],
): string[] {
  if (!sessionKey) return [...memoryIds];
  const events = sessionHistory.get(sessionKey);
  if (!events || events.length === 0) return [...memoryIds];
  const seen = new Set<string>();
  for (const ev of events) for (const id of ev) seen.add(id);
  return memoryIds.filter((id) => !seen.has(id));
}

/**
 * Record that `memoryIds` were injected into this session's prompt on the
 * current turn. Pushes a new event onto the ring buffer; evicts the oldest
 * event when the buffer exceeds `HISTORY_SIZE`.
 *
 * Empty id lists are ignored (no event recorded) — we don't want the ring
 * buffer filled with no-op turns.
 */
export function recordRecentInjection(
  sessionKey: string | undefined,
  memoryIds: readonly string[],
): void {
  if (!sessionKey) return;
  if (memoryIds.length === 0) return;
  const event: InjectionEvent = new Set(memoryIds);
  const existing = sessionHistory.get(sessionKey) ?? [];
  // Most-recent-first ordering — unshift then trim.
  existing.unshift(event);
  if (existing.length > HISTORY_SIZE) existing.length = HISTORY_SIZE;
  sessionHistory.set(sessionKey, existing);
}

/**
 * Clear all injection history for this session. Called from session
 * `clear` / fresh-conversation paths.
 */
export function clearRecentInjectionHistory(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  sessionHistory.delete(sessionKey);
}

/**
 * Drop all session histories. Mainly for tests.
 */
export function resetAllRecentInjectionHistories(): void {
  sessionHistory.clear();
}

/**
 * Snapshot the current history for inspection/testing. Returns a copy.
 */
export function getRecentInjectionHistory(
  sessionKey: string | undefined,
): readonly (readonly string[])[] {
  if (!sessionKey) return [];
  const events = sessionHistory.get(sessionKey);
  if (!events) return [];
  return events.map((ev) => Array.from(ev));
}

/**
 * Exposed for tests that want to assert the ring-buffer bound.
 */
export const RECENT_INJECTION_HISTORY_SIZE = HISTORY_SIZE;
