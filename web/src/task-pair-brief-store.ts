/**
 * On-demand pair briefs.
 *
 * Console snapshot rows carry only a `briefRevision` (a content hash), never the
 * brief text. The text is requested when a viewer actually opens or copies it
 * and cached here BY REVISION: equal revision means equal text, so the cache
 * needs no scoping or invalidation, and a re-sent snapshot or a pair delta that
 * does not touch the brief costs nothing.
 */

/** Bound the cache; briefs are a few KB, this is only a safety net. */
const MAX_CACHED_BRIEFS = 256;
/** An unanswered request (older daemon, dropped frame) becomes a visible, retryable failure. */
export const TASK_PAIR_BRIEF_REQUEST_TIMEOUT_MS = 10_000;

export type TaskPairBriefStatus = 'cached' | 'loading' | 'failed' | 'idle';

const cache = new Map<string, string>();
const inflight = new Map<string, { revision: string; timer: ReturnType<typeof setTimeout> }>();
const failed = new Set<string>();
const listeners = new Set<() => void>();
let requester: ((taskId: string) => void) | null = null;
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Monotonic; changes whenever any brief state changes (for cheap subscriptions). */
export function taskPairBriefStoreVersion(): number {
  return version;
}

export function subscribeTaskPairBriefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The controller that owns the daemon's current subscription registers itself:
 * the daemon answers only for the newest subscription of a scope, so requests
 * go through whichever subscription was started last. Returns an unregister.
 */
export function setTaskPairBriefRequester(next: (taskId: string) => void): () => void {
  requester = next;
  return () => { if (requester === next) requester = null; };
}

export function getCachedTaskPairBrief(revision: string): string | undefined {
  const brief = cache.get(revision);
  if (brief === undefined) return undefined;
  // Refresh recency so the newest-used briefs survive eviction.
  cache.delete(revision);
  cache.set(revision, brief);
  return brief;
}

export function taskPairBriefStatus(revision: string): TaskPairBriefStatus {
  if (cache.has(revision)) return 'cached';
  if (failed.has(revision)) return 'failed';
  for (const entry of inflight.values()) if (entry.revision === revision) return 'loading';
  return 'idle';
}

/** Ask the daemon for a pair's brief unless it is cached or already requested. */
export function requestTaskPairBrief(taskId: string, revision: string): void {
  if (cache.has(revision)) return;
  const pending = inflight.get(taskId);
  if (pending?.revision === revision) return;
  if (pending) clearTimeout(pending.timer);
  failed.delete(revision);
  if (!requester) {
    failed.add(revision);
    notify();
    return;
  }
  const timer = setTimeout(() => {
    if (inflight.get(taskId)?.timer !== timer) return;
    inflight.delete(taskId);
    failed.add(revision);
    notify();
  }, TASK_PAIR_BRIEF_REQUEST_TIMEOUT_MS);
  inflight.set(taskId, { revision, timer });
  requester(taskId);
  notify();
}

/** A BRIEF_RESPONSE arrived. `briefRevision`/`brief` are null when the pair has no brief any more. */
export function receiveTaskPairBrief(taskId: string, briefRevision: string | null, brief: string | null): void {
  const pending = inflight.get(taskId);
  if (pending) {
    clearTimeout(pending.timer);
    inflight.delete(taskId);
  }
  if (briefRevision !== null && brief !== null) {
    cache.delete(briefRevision);
    cache.set(briefRevision, brief);
    failed.delete(briefRevision);
    while (cache.size > MAX_CACHED_BRIEFS) cache.delete(cache.keys().next().value as string);
  } else if (pending) {
    failed.add(pending.revision);
  }
  notify();
}

/** Test seam: drop every cached/pending brief and the requester. */
export function resetTaskPairBriefStoreForTests(): void {
  for (const entry of inflight.values()) clearTimeout(entry.timer);
  inflight.clear();
  cache.clear();
  failed.clear();
  requester = null;
  version = 0;
  notify();
}
