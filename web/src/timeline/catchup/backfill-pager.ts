/**
 * Newest-first WINDOW pager for HTTP timeline backfill (Tier-0).
 *
 * Fixes the real tail-gap symptom against the ACTUAL backend. The daemon serves
 * timeline history as `... WHERE ts > afterTs [AND ts < beforeTs] ORDER BY ts
 * DESC LIMIT n` — i.e. it returns the NEWEST `limit` events of the requested
 * window, not a forward page. So a single request with `{ afterTs = localTail }`
 * already syncs the timeline to the LATEST message, but if more than one page of
 * events accumulated above the local tail it returns only the newest `limit` and
 * leaves the rest of `(localTail, newest]` unfetched.
 *
 * To recover that backlog we hold the window's LOWER bound fixed at the round's
 * `afterTs` (the local tail) and walk the UPPER bound DOWN: each subsequent page
 * sets `beforeTs = minTs + 1` of the page just merged, so the next request
 * returns the next-newest `limit` events still inside `(afterTs, minTs]`. We
 * stop as soon as a page comes back shorter than `limit` (the window is
 * exhausted down to the local tail), and merge every page by `eventId`
 * (idempotent — the `+1` overlap re-includes the boundary millisecond's events
 * on purpose so a same-`ts` cluster split across the page boundary is never
 * dropped; the merge dedups the overlap).
 *
 * Wire-semantics note (do NOT confuse the two "more" signals):
 *  - WINDOW continuation is driven by COUNT truncation: `events.length >= limit`
 *    means the window held at least `limit` events and we got the newest slice,
 *    so there may be more below. `events.length < limit` proves the window is
 *    exhausted. (The server body `hasMore` is wired to the daemon's
 *    `droppedEvents > 0`, i.e. PAYLOAD truncation — it is an INCOMPLETE-page
 *    signal, not a count signal, and MUST NOT drive continuation.)
 *  - PAYLOAD truncation (`payloadTruncated` / `droppedEvents` / `truncatedEvents`
 *    / `cursorReset` / `recoverable`) means the page itself is incomplete; the
 *    round ends `truncated` and MUST NOT cool down.
 *
 * It ALSO separates "responded" from "caught up": only a `caught_up` terminal
 * (window exhausted with no truncation/drop/reset) should advance the backfill
 * cooldown / mark the step done. A `cap_hit` / `truncated` / `transient_null`
 * terminal must NOT write the cooldown, so the next trigger continues instead of
 * being suppressed by a false-completion.
 *
 * SCOPE (honest): this recovers the tail window `(localTail, newest]`. It does
 * NOT recover a "middle/ordering gap" — an event OLDER than `localTail`
 * (`localMax − OVERLAP`) that was missed while a later event arrived — because
 * the window's lower bound is the local tail. That, and same-millisecond
 * exactness when a single `ts` holds more than `limit` events (which terminates
 * `cap_hit`), are deferred Tier-1+ work in the OpenSpec change and are an
 * accepted product trade-off (occasional middle gaps, especially tool calls).
 *
 * Pure / framework-free and dependency-injected (fetch + merge) so it is
 * unit-testable with no React, no real network, and no real timers.
 */

/** Bounded number of window pages a single catch-up round may fetch. */
export const CATCHUP_TAIL_MAX_PAGES = 5;

/** Subset of the HTTP backfill response the pager needs. */
export interface BackfillPage {
  events: unknown[];
  /**
   * PAYLOAD-truncation signal (server body `hasMore` ← daemon `droppedEvents>0`).
   * Indicates the page is incomplete, NOT that more older events exist — do not
   * use it to drive window continuation (that is `events.length >= limit`).
   */
  hasMore: boolean;
  payloadTruncated?: boolean;
  droppedEvents?: number;
  truncatedEvents?: number;
  cursorReset?: boolean;
  recoverable?: boolean;
}

/**
 * How a round ended:
 * - `caught_up`   — a page returned fewer than `limit` events with no
 *                   truncation; the window `(afterTs, beforeTs]` is exhausted and
 *                   the timeline is verified up-to-date as of this round (the
 *                   ONLY terminal that may advance the cooldown / mark done).
 * - `cap_hit`     — the page cap was reached while pages were still full, or no
 *                   downward progress was possible (a same-`ts` cluster larger
 *                   than `limit`); do NOT cool down — let the next trigger
 *                   continue.
 * - `truncated`   — a page was payload-truncated / dropped / reset / recoverable;
 *                   incomplete, do NOT cool down.
 * - `transient_null` — a fetch returned null (daemon offline / timeout / blip).
 */
export type BackfillTerminal = 'caught_up' | 'cap_hit' | 'truncated' | 'transient_null';

export interface NewestWindowBackfillDeps {
  /**
   * Fetch one window page. `afterTs` is the round's FIXED lower bound (undefined
   * = from the start); `beforeTs` is the moving upper bound (undefined on the
   * first page). The fetch MUST request `limit` events so the pager's
   * count-truncation check (`events.length >= limit`) is meaningful. Returns
   * null on transient failure.
   */
  fetchPage: (args: { afterTs: number | undefined; beforeTs?: number }) => Promise<BackfillPage | null>;
  /**
   * Merge a page's events into the timeline. Returns how many well-formed events
   * were merged (`candidateCount`, idempotent — re-merged overlap is fine) and
   * the min/max `ts` across them (`minTs` drives the next window's upper bound).
   * `minTs: null` signals "no usable cursor" (empty / all-malformed page).
   */
  mergePage: (events: unknown[]) => { candidateCount: number; minTs: number | null; maxTs: number | null };
  /**
   * The page size requested per fetch. A page with `events.length >= limit` is a
   * full window slice (there may be more below → continue); `< limit` proves the
   * window is exhausted (→ `caught_up`).
   */
  limit: number;
  /** Max window pages (default `CATCHUP_TAIL_MAX_PAGES`). */
  maxPages?: number;
}

export interface NewestWindowBackfillOutcome {
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
 * Run a bounded newest-first window backfill over `(lowerAfterTs, newest]`.
 * Holds the lower bound fixed and walks the upper bound (`beforeTs`) down by
 * each merged page's `minTs`, merging via `deps.mergePage`. Stops at the first
 * terminal condition; never loops unboundedly (it stops on cap, on a short page,
 * on a transient null, on truncation, or as soon as the upper bound cannot
 * descend).
 */
export async function runNewestWindowBackfill(
  lowerAfterTs: number | undefined,
  deps: NewestWindowBackfillDeps,
): Promise<NewestWindowBackfillOutcome> {
  const maxPages = deps.maxPages ?? CATCHUP_TAIL_MAX_PAGES;
  const afterTs = lowerAfterTs; // fixed lower bound for the whole round
  let beforeTs: number | undefined; // moving upper bound (undefined = newest)
  let prevMinTs = Number.POSITIVE_INFINITY;
  let pageCount = 0;
  let totalNew = 0;

  while (pageCount < maxPages) {
    const page = await deps.fetchPage({ afterTs, beforeTs });
    if (page === null) {
      return { terminal: 'transient_null', pageCount, totalNew };
    }
    const { candidateCount, minTs } = deps.mergePage(page.events);
    pageCount += 1;
    totalNew += candidateCount;

    if (pageIsIncomplete(page)) {
      // Payload-incomplete page — NOT caught up; let a later trigger retry.
      return { terminal: 'truncated', pageCount, totalNew };
    }
    if (page.events.length < deps.limit) {
      // Short page ⇒ the window is exhausted down to the local tail: caught up.
      return { terminal: 'caught_up', pageCount, totalNew };
    }
    // Full page ⇒ there may be more below. Descend the upper bound, but stop
    // bounded if we cannot derive a lower cursor or it fails to descend (a
    // single `ts` holding ≥ limit events — same-ms exactness is out of scope).
    if (minTs === null || minTs >= prevMinTs) {
      return { terminal: 'cap_hit', pageCount, totalNew };
    }
    prevMinTs = minTs;
    beforeTs = minTs + 1; // +1 re-includes the boundary ms; merge dedups it.
  }
  return { terminal: 'cap_hit', pageCount, totalNew };
}
