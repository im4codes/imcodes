/**
 * The "gap" of a chat window that was reopened after a long time.
 *
 * A stale local cache ends at some timestamp (`lowerTs`); the newest messages arrive first (the
 * tail), which leaves a hole between the two. The hole is described by
 *
 *   lowerTs  exclusive lower bound: the newest event the cache held when the window was reopened
 *   upperTs  everything at or above this timestamp is already stitched in (null until the first
 *            page of the newest window proves there IS a hole and where it ends)
 *
 * and is filled from NEWEST to OLDEST by lowering `upperTs` page by page until it reaches
 * `lowerTs`. The record lives here (module level, persisted) rather than in a hook because
 *   - two windows on the same session must share one hole and one backfill,
 *   - a merged tail advances "the newest cached ts", which used to make the hole invisible to every
 *     later catch-up (it derived its lower bound from the cache), and
 *   - a page reload mid-backfill must resume where it stopped instead of forgetting the hole.
 *
 * Pure of React; storage is injectable so the state machine is testable without a browser.
 */

export interface TimelineGap {
  lowerTs: number;
  upperTs: number | null;
  /** Epoch ms the hole was first recorded (drives expiry). */
  createdAt: number;
}

const STORAGE_KEY = 'imcodes.timelineGaps.v1';
/** A hole older than this is dropped instead of resumed: the local cache it refers to has long been pruned. */
export const TIMELINE_GAP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Bounded so many windows cannot grow the single persisted record without limit. */
export const TIMELINE_GAP_MAX_ENTRIES = 64;

type GapListener = (gap: TimelineGap | null) => void;

interface GapStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

let storageOverride: GapStorage | null | undefined;
let loaded = false;
const gaps = new Map<string, TimelineGap>();
const listeners = new Map<string, Set<GapListener>>();

function resolveStorage(): GapStorage | null {
  if (storageOverride !== undefined) return storageOverride;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeGap(value: unknown, now: number): TimelineGap | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!isFiniteNumber(raw.lowerTs) || raw.lowerTs < 0) return null;
  const upperTs = raw.upperTs === null || raw.upperTs === undefined ? null : raw.upperTs;
  if (upperTs !== null && !isFiniteNumber(upperTs)) return null;
  const createdAt = isFiniteNumber(raw.createdAt) ? raw.createdAt : now;
  if (now - createdAt > TIMELINE_GAP_MAX_AGE_MS) return null;
  // A hole whose stitched top already reached its floor is closed, not a hole.
  if (upperTs !== null && upperTs <= raw.lowerTs) return null;
  return { lowerTs: raw.lowerTs, upperTs, createdAt };
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const storage = resolveStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return;
    const now = Date.now();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const gap = normalizeGap(value, now);
      if (gap) gaps.set(key, gap);
    }
  } catch {
    // an unreadable record is treated as "no holes known"; the next catch-up re-derives the cursor from the cache
  }
}

function persist(): void {
  const storage = resolveStorage();
  if (!storage) return;
  try {
    while (gaps.size > TIMELINE_GAP_MAX_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, gap] of gaps) {
        if (gap.createdAt < oldestAt) { oldestAt = gap.createdAt; oldestKey = key; }
      }
      if (oldestKey === null) break;
      gaps.delete(oldestKey);
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(gaps)));
  } catch {
    // quota / private mode: the in-memory record still drives this page session
  }
}

function notify(cacheKey: string, gap: TimelineGap | null): void {
  const set = listeners.get(cacheKey);
  if (!set) return;
  for (const listener of [...set]) {
    try { listener(gap); } catch { /* a listener must not break the store */ }
  }
}

export function getTimelineGap(cacheKey: string | null | undefined): TimelineGap | null {
  if (!cacheKey) return null;
  load();
  const gap = gaps.get(cacheKey);
  return gap ? { ...gap } : null;
}

export function setTimelineGap(cacheKey: string, gap: { lowerTs: number; upperTs: number | null; createdAt?: number } | null): void {
  load();
  if (gap === null) {
    if (!gaps.delete(cacheKey)) return;
    persist();
    notify(cacheKey, null);
    return;
  }
  const next = normalizeGap({ ...gap, createdAt: gap.createdAt ?? gaps.get(cacheKey)?.createdAt ?? Date.now() }, Date.now());
  if (!next) {
    setTimelineGap(cacheKey, null);
    return;
  }
  const previous = gaps.get(cacheKey);
  if (previous && previous.lowerTs === next.lowerTs && previous.upperTs === next.upperTs) return;
  gaps.set(cacheKey, next);
  persist();
  notify(cacheKey, { ...next });
}

export function subscribeTimelineGap(cacheKey: string, listener: GapListener): () => void {
  let set = listeners.get(cacheKey);
  if (!set) {
    set = new Set();
    listeners.set(cacheKey, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(cacheKey);
  };
}

/**
 * Fold one fetched page into the hole for `cacheKey`.
 *
 * `lowerTs` is the floor the page was fetched against (the cache cursor captured at open, or the
 * recorded hole's floor); `pageMinTs`/`pageMaxTs` bound the page's events; `fullPage` says the page
 * held a whole window (more may lie below it). Returns the new hole (null = none / closed).
 *
 * Rules:
 *  - no hole recorded yet: a full page whose oldest event is still above the floor PROVES a hole,
 *    (lowerTs, pageMinTs); a short page (or one that reaches the floor) proves there is none.
 *  - hole recorded: a page contiguous with the stitched top (its newest event reaches `upperTs`)
 *    lowers `upperTs` to its oldest event; reaching the floor, or a short page, closes the hole.
 *    A page that is not contiguous with the stitched top (its newest event lies below `upperTs` and
 *    it was not fetched for the hole) cannot move the top.
 */
export function foldPageIntoGap(
  current: TimelineGap | null,
  page: {
    lowerTs: number;
    pageMinTs: number | null;
    pageMaxTs: number | null;
    fullPage: boolean;
    /** The page was fetched for the hole itself (`beforeTs` = the stitched top): contiguous by construction. */
    descending?: boolean;
    /**
     * The page was payload-trimmed / dropped / reset (the pager's `pageIsIncomplete`). Its event count says
     * nothing about exhaustion, and the trimmed events lie inside its range: it can neither prove "no hole"
     * nor close one, and it holds the stitched top instead of lowering it (the next round refetches the
     * page; the merge dedups). `skipIncomplete` is the escape hatch for a page that stays trimmed every time:
     * treat it as a normal full page so the filler still descends past it instead of wedging on it.
     */
    incomplete?: boolean;
    skipIncomplete?: boolean;
  },
): { lowerTs: number; upperTs: number | null } | null {
  const { pageMinTs, pageMaxTs } = page;
  const holdIncomplete = page.incomplete === true && page.skipIncomplete !== true;
  // An incomplete page that is still being held is treated as a full window for the decision to OPEN a hole
  // (short means nothing for a trimmed page), and holds the top for an open one.
  const fullPage = page.fullPage || page.incomplete === true;
  if (pageMinTs === null || pageMaxTs === null) {
    // nothing came back: nothing to stitch; an empty answer for a window that should hold events means "no more"
    return current ? { lowerTs: current.lowerTs, upperTs: current.upperTs } : null;
  }
  if (!current) {
    if (!fullPage) return null;
    if (pageMinTs <= page.lowerTs) return null;
    return { lowerTs: page.lowerTs, upperTs: pageMinTs };
  }
  const floor = current.lowerTs;
  const top = current.upperTs;
  if (holdIncomplete) {
    // Never closes on its own (only a page that reaches the floor with nothing above it does, below) and never
    // lowers the top past what the page proved: the trimmed events are inside its range.
    if (pageMaxTs <= floor) return null;
    return { lowerTs: floor, upperTs: top === null ? null : Math.min(top, pageMaxTs) };
  }
  if (pageMinTs <= floor || !fullPage) return null;
  if (top === null) return { lowerTs: floor, upperTs: pageMinTs };
  if (pageMaxTs < top && page.descending !== true) return { lowerTs: floor, upperTs: top };
  return { lowerTs: floor, upperTs: Math.min(top, pageMinTs) };
}

/** Test seam: wipe module state and choose the storage (`undefined` restores the real one). */
export function __resetTimelineGapsForTests(storage?: GapStorage | null): void {
  gaps.clear();
  listeners.clear();
  loaded = false;
  storageOverride = storage;
  // Forget what an earlier test persisted too, or the next read would resurrect it.
  try { resolveStorage()?.setItem(STORAGE_KEY, '{}'); } catch { /* ignore */ }
}
