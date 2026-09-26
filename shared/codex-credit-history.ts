/**
 * Codex pay-as-you-go usage credit balance — the account-level balance you
 * can buy once the plan's included quota (5h / weekly rate-limit window) is
 * exhausted. This is DIFFERENT from the rate-limit "reset credits" in
 * `shared/codex-reset-credits.ts` (those force-reset the window early; they
 * are not a spendable balance).
 *
 * The balance is read from the codex `app-server` `account/rateLimits/read`
 * RPC (`result.rateLimits.credits`) — the SAME call the daemon already makes
 * for the 5h/weekly quota display (`src/agent/codex-runtime-config.ts`).
 * Every real (non-cached) refresh also records a snapshot to the daemon's
 * local SQLite (`src/store/context-store.ts` → `codex_credit_snapshots`), so
 * the web frontend can show not just the current number but how it changed
 * over time.
 *
 * Web ↔ daemon transport mirrors `CODEX_RESET_CREDITS_MSG`: a generic
 * requestId-correlated WS message relayed verbatim through the server (no
 * server-side registration needed — see `command-handler.ts`'s dispatch
 * table and `CodexResetCredits.tsx` for the sibling pattern).
 */

/** Web ↔ daemon messages for reading recorded credit-balance history. */
export const CODEX_CREDIT_HISTORY_MSG = {
  /** Web → daemon: request recent credit-balance snapshots. */
  REQUEST: 'codex.credit_history.request',
  /** Daemon → web: the snapshot list (correlated by requestId). */
  RESPONSE: 'codex.credit_history.response',
} as const;

export type CodexCreditHistoryMsgType =
  typeof CODEX_CREDIT_HISTORY_MSG[keyof typeof CODEX_CREDIT_HISTORY_MSG];

/** One recorded balance snapshot. Non-secret — safe to send to web. */
export interface CodexCreditSnapshot {
  capturedAt: number;
  accountId?: string;
  planType?: string;
  /**
   * Decimal string as reported by the codex backend (e.g. "12.50"), kept as
   * a string end to end rather than parsed to a float — avoids rounding
   * drift through storage/transport for a value that represents money.
   */
  balance: string;
  hasCredits: boolean;
  unlimited: boolean;
  /** The plan's 5h rate-limit window, at the moment this snapshot was taken — context for "was I actually out of plan quota". */
  fiveHourLeftPercent?: number;
  weeklyLeftPercent?: number;
}

export const CODEX_CREDIT_HISTORY_DEFAULT_LIMIT = 100;
export const CODEX_CREDIT_HISTORY_MAX_LIMIT = 500;

/** One derived consumption event — a balance decrease between two time-adjacent snapshots. */
export interface CodexCreditConsumptionEvent {
  atCapturedAt: number;
  fromBalance: string;
  toBalance: string;
  /** fromBalance − toBalance, as a fixed 2-decimal string; always > 0. */
  spent: string;
}

function parseDecimal(value: string | undefined | null): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Format a decimal-string balance for display, e.g. `"12.5"` → `"$12.50"`.
 * Falls back to the raw string when it isn't numeric, so an unexpected
 * backend shape degrades to "show something" rather than a crash.
 */
export function formatCodexCreditBalance(balance: string | undefined | null, unlimited?: boolean): string {
  if (unlimited) return '∞';
  if (!balance) return '$0.00';
  const n = parseDecimal(balance);
  return n === undefined ? balance : `$${n.toFixed(2)}`;
}

/**
 * Derive consumption events from a list of snapshots ordered NEWEST first
 * (as stored/returned by `listCodexCreditSnapshots` / the RESPONSE message)
 * — a balance decrease between two time-adjacent snapshots is one spend
 * event. An increase (a top-up) is not a consumption event and is skipped;
 * an unchanged balance produces no event either.
 */
export function deriveCodexCreditConsumptionEvents(
  snapshotsNewestFirst: readonly CodexCreditSnapshot[],
): CodexCreditConsumptionEvent[] {
  const events: CodexCreditConsumptionEvent[] = [];
  for (let i = 0; i < snapshotsNewestFirst.length - 1; i++) {
    const newer = snapshotsNewestFirst[i]!;
    const older = snapshotsNewestFirst[i + 1]!;
    const newerBalance = parseDecimal(newer.balance);
    const olderBalance = parseDecimal(older.balance);
    if (newerBalance === undefined || olderBalance === undefined) continue;
    if (newerBalance >= olderBalance) continue; // top-up or unchanged — not a spend
    events.push({
      atCapturedAt: newer.capturedAt,
      fromBalance: older.balance,
      toBalance: newer.balance,
      spent: (olderBalance - newerBalance).toFixed(2),
    });
  }
  return events;
}

/** Whether `credits` (the `account/rateLimits/read` sub-object) is worth persisting at all. */
export function isMeaningfulCodexCreditsPayload(
  credits: { hasCredits?: unknown; unlimited?: unknown; balance?: unknown } | null | undefined,
): credits is { hasCredits: boolean; unlimited: boolean; balance: string } {
  return !!credits
    && typeof credits.hasCredits === 'boolean'
    && typeof credits.unlimited === 'boolean'
    && typeof credits.balance === 'string';
}
