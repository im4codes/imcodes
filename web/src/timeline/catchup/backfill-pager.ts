/**
 * Tail-backlog continuation pager for HTTP timeline backfill (Tier-0).
 *
 * Fixes symptom S1 ("tail gap"): when the local timeline tail is old and the
 * server has MORE than one page of newer events, the previous `fireHttpBackfill`
 * fetched only the FIRST page (it never read `result.hasMore`), leaving the rest
 * missing until the next trigger. This pager consumes `hasMore` and continues
 * paging forward — bounded by `CATCHUP_TAIL_MAX_PAGES` — deriving the next
 * `afterTs` from the max `ts` of the page just merged (the server's
 * `nextCursor` is OLDER-oriented, so it cannot drive forward continuation).
 *
 * It ALSO separates "responded" from "caught up": only a `caught_up` terminal
 * (server `hasMore=false` with no truncation/drop/reset) should advance the
 * backfill cooldown / mark the step done. A `cap_hit` / `truncated` terminal
 * must NOT write the cooldown, so the next trigger continues instead of being
 * suppressed by a false-completion.
 *
 * SCOPE (honest): this does NOT fix symptom S2 ("middle/ordering gap" — an
 * event missed that is older than `localMax - OVERLAP`). The request base is
 * still derived from the local tail, so events earlier than the first page's
 * base are never returned. S2 requires a verified/contiguous base cursor +
 * forward `(ts,seq)` cursor (deferred Tier-1+ work in the OpenSpec change).
 *
 * Pure / framework-free and dependency-injected (fetch + merge) so it is
 * unit-testable with no React, no real network, and no real timers.
 */

/** Bounded number of forward pages a single tail-backfill round may fetch. */
export const CATCHUP_TAIL_MAX_PAGES = 5;

/** Subset of the HTTP backfill response the pager needs. */
export interface BackfillPage {
  events: unknown[];
  hasMore: boolean;
  payloadTruncated?: boolean;
  droppedEvents?: number;
  truncatedEvents?: number;
  cursorReset?: boolean;
  recoverable?: boolean;
}

/**
 * How a round ended:
 * - `caught_up`   — server reported `hasMore=false` with no truncation; the
 *                   timeline is verified up-to-date as of this round (the ONLY
 *                   terminal that may advance the cooldown / mark done).
 * - `cap_hit`     — page cap reached (or no forward progress possible) while
 *                   the server still reports more; do NOT cool down — let the
 *                   next trigger continue.
 * - `truncated`   — a page was payload-truncated / dropped / reset / recoverable;
 *                   incomplete, do NOT cool down.
 * - `transient_null` — a fetch returned null (daemon offline / timeout / blip).
 */
export type BackfillTerminal = 'caught_up' | 'cap_hit' | 'truncated' | 'transient_null';

export interface TailBackfillDeps {
  /**
   * Fetch one page starting strictly after `afterTs` (undefined = no cursor /
   * from the start). Returns null on transient failure.
   */
  fetchPage: (afterTs: number | undefined) => Promise<BackfillPage | null>;
  /**
   * Merge a page's events into the timeline. Returns the number of NEW events
   * merged and the max `ts` seen (used to advance the forward cursor). Returning
   * `newCount: 0` / `maxTs: null` signals "no forward progress possible".
   */
  mergePage: (events: unknown[]) => { newCount: number; maxTs: number | null };
  /** Max forward pages (default `CATCHUP_TAIL_MAX_PAGES`). */
  maxPages?: number;
}

export interface TailBackfillOutcome {
  terminal: BackfillTerminal;
  pageCount: number;
  totalNew: number;
}

function pageIsIncomplete(page: BackfillPage): boolean {
  return page.payloadTruncated === true
    || (page.droppedEvents ?? 0) > 0
    || (page.truncatedEvents ?? 0) > 0
    || page.cursorReset === true
    || page.recoverable === true;
}

/**
 * Run a bounded forward tail-backfill starting at `initialAfterTs`.
 * Merges each page via `deps.mergePage` and stops at the first terminal
 * condition. Never loops unboundedly: it stops on cap, on transient null, on
 * truncation, or as soon as it cannot make forward progress.
 */
export async function runTailBackfill(
  initialAfterTs: number | undefined,
  deps: TailBackfillDeps,
): Promise<TailBackfillOutcome> {
  const maxPages = deps.maxPages ?? CATCHUP_TAIL_MAX_PAGES;
  let afterTs: number | undefined = initialAfterTs;
  let pageCount = 0;
  let totalNew = 0;

  while (pageCount < maxPages) {
    const page = await deps.fetchPage(afterTs);
    if (page === null) {
      return { terminal: 'transient_null', pageCount, totalNew };
    }
    const { newCount, maxTs } = deps.mergePage(page.events);
    pageCount += 1;
    totalNew += newCount;

    if (pageIsIncomplete(page)) {
      // Incomplete page — NOT caught up; let a later trigger retry.
      return { terminal: 'truncated', pageCount, totalNew };
    }
    if (!page.hasMore) {
      // The only path that proves the tail is fully caught up.
      return { terminal: 'caught_up', pageCount, totalNew };
    }
    // Server says there is more, but if we made no progress / cannot advance the
    // forward cursor, stop bounded (do NOT cool down — avoids a same-afterTs loop).
    if (newCount === 0 || maxTs === null || (afterTs !== undefined && maxTs <= afterTs)) {
      return { terminal: 'cap_hit', pageCount, totalNew };
    }
    afterTs = maxTs;
  }
  return { terminal: 'cap_hit', pageCount, totalNew };
}
