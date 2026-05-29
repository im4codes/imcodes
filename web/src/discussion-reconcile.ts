/**
 * Unified reconciler for the discussion bar.
 *
 * A single matcher + merge discipline backs the `discussion.started`,
 * `discussion.update`, `discussion.error`, and `discussion.list` handlers in
 * `app.tsx`, so the four code paths cannot drift (audit findings C1/C2/C3/C9/
 * C11). The merge discipline mirrors `mergeP2pDiscussionUpdate` in
 * `p2p-run-mapping.ts` (terminal monotonicity, defensive field merge) and adds
 * the optimistic-`pending` lifecycle the classic startup flow needs.
 *
 * Rules:
 *  - Match by `requestId` first, then `discussionId`/`id`.
 *  - Authoritative (daemon) fields overwrite; an absent/`undefined` field never
 *    clobbers an existing value.
 *  - Local-only fields (`requestId`, `pending`, `startedAt`, `displayReasonKey`,
 *    `rawError`) are preserved unless the patch explicitly sets them.
 *  - Terminal states (`done`/`failed`) are monotonic — never regressed.
 *  - Receiving any authoritative `id`/`state` clears the optimistic `pending`
 *    flag and swaps a `pending_<requestId>` id for the real `discussionId`.
 */
import { isTerminalDiscussionState } from './p2p-run-mapping.js';

/** Loose shape the reconciler operates on; the app's discussion entry satisfies it. */
export interface DiscussionEntryLike {
  id: string;
  requestId?: string;
  pending?: boolean;
  state?: string;
  startedAt?: number;
  updatedAt?: number;
  displayReasonKey?: string;
  rawError?: string;
}

/** A discussion is terminal when done or failed. */
export function isTerminalDiscussionUiState(state: unknown): boolean {
  return isTerminalDiscussionState(state);
}

/**
 * Active = visible in the bar and counted by the running-discussions badge.
 * Anything not terminal (pending / setup / running / any non-terminal P2P
 * state) is active; `done`/`failed` are not.
 */
export function isBarActiveDiscussion(d: { state?: string }): boolean {
  return !isTerminalDiscussionUiState(d.state);
}

/** Local-only fields that authoritative messages must never erase. */
const LOCAL_ONLY_KEYS = new Set(['requestId', 'pending', 'displayReasonKey', 'rawError']);

/** Find the index of the entry an authoritative message refers to, or -1. */
export function matchDiscussionIndex(
  list: readonly DiscussionEntryLike[],
  msg: { requestId?: unknown; discussionId?: unknown; id?: unknown },
): number {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
  if (requestId) {
    const i = list.findIndex((d) => d.requestId === requestId);
    if (i >= 0) return i;
  }
  const did = (typeof msg.discussionId === 'string' && msg.discussionId)
    || (typeof msg.id === 'string' && msg.id)
    || undefined;
  if (did) {
    const i = list.findIndex((d) => d.id === did);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Merge an authoritative patch onto an existing entry.
 * `patch` should contain ONLY authoritative fields that are actually present
 * (omit unknown ones; `undefined` values are skipped defensively).
 */
export function reconcileDiscussionEntry<T extends DiscussionEntryLike>(
  existing: T,
  patch: Partial<T> & { id?: string; state?: string },
): T {
  // Terminal monotonicity: never regress done/failed to a non-terminal state.
  if (isTerminalDiscussionUiState(existing.state) && patch.state !== undefined && !isTerminalDiscussionUiState(patch.state)) {
    return existing;
  }
  const merged: T = { ...existing };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) merged[key] = value as T[keyof T];
  }
  // Any authoritative id/state means the entry is no longer a bare optimistic
  // placeholder: clear pending (and the real id, if provided, replaced the
  // pending_<requestId> id above).
  if (patch.id !== undefined || patch.state !== undefined) {
    (merged as DiscussionEntryLike).pending = false;
  }
  return merged;
}

/**
 * Reconcile the bar list against an authoritative `discussion.list`.
 *  - Existing entries matched by requestId/id are merged in place.
 *  - Unresolved optimistic pending entries are PRESERVED (never dropped by a
 *    list that does not yet know about them) — they resolve via their own
 *    started/error or their pending timeout.
 *  - Terminal (done/failed) entries are kept (history; hidden by the bar).
 *  - P2P entries (`p2p_*`) are left untouched (handled by the P2P path).
 *  - Resolved, active, classic entries ABSENT from the live set are dropped
 *    (the run finished and was cleaned up daemon-side).
 *  - Live items not present locally are appended via `makeEntry`.
 */
export function reconcileClassicList<T extends DiscussionEntryLike>(
  prev: readonly T[],
  liveItems: ReadonlyArray<Record<string, unknown> & { id: string; requestId?: string }>,
  makeEntry: (item: Record<string, unknown> & { id: string }) => T,
): T[] {
  const liveByReq = new Map<string, Record<string, unknown> & { id: string }>();
  const liveById = new Map<string, Record<string, unknown> & { id: string }>();
  for (const item of liveItems) {
    if (typeof item.requestId === 'string') liveByReq.set(item.requestId, item);
    liveById.set(item.id, item);
  }
  const consumed = new Set<Record<string, unknown>>();
  const result: T[] = [];

  for (const d of prev) {
    let live: (Record<string, unknown> & { id: string }) | undefined;
    if (d.requestId && liveByReq.has(d.requestId)) live = liveByReq.get(d.requestId);
    else if (liveById.has(d.id)) live = liveById.get(d.id);

    if (live) {
      consumed.add(live);
      result.push(reconcileDiscussionEntry(d, live as Partial<T> & { id?: string; state?: string }));
      continue;
    }
    if (d.pending) { result.push(d); continue; }                 // preserve unresolved optimistic entry
    if (isTerminalDiscussionUiState(d.state)) { result.push(d); continue; } // keep terminal history
    if (typeof d.id === 'string' && d.id.startsWith('p2p_')) { result.push(d); continue; } // not our path
    // resolved + active + classic + absent from live set → finished daemon-side, drop it
  }

  for (const item of liveItems) {
    if (consumed.has(item)) continue;
    if (prev.some((d) => d.id === item.id || (typeof item.requestId === 'string' && d.requestId === item.requestId))) continue;
    result.push(makeEntry(item));
  }
  return result;
}

export { LOCAL_ONLY_KEYS };
