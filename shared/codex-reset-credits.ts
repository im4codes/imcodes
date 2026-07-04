/**
 * Codex (ChatGPT-auth) rate-limit reset credits.
 *
 * Each credit performs a "Full reset (Weekly + 5h)" of the codex account's rate
 * limits. The credit list is read from the ChatGPT backend; consuming one is
 * done via the codex `app-server` JSON-RPC method
 * `account/rateLimitResetCredit/consume`. Both use the local codex OAuth token
 * (`~/.codex/auth.json`) which stays in daemon memory only — the token never
 * crosses to the web; only the (non-secret) credit list + consume outcome do.
 *
 * Reset credits are ACCOUNT-level, not per-session — every codex session shares
 * the same pool.
 */

/** Web ↔ daemon messages for listing / consuming codex reset credits. */
export const CODEX_RESET_CREDITS_MSG = {
  /** Web → daemon: request the current reset-credit list. */
  LIST: 'codex.reset_credits.list',
  /** Daemon → web: the reset-credit list (correlated by requestId). */
  LIST_RESPONSE: 'codex.reset_credits.list_response',
  /** Web → daemon: consume one reset credit (carries idempotencyKey). */
  CONSUME: 'codex.reset_credits.consume',
  /** Daemon → web: the consume outcome (correlated by requestId). */
  CONSUME_RESPONSE: 'codex.reset_credits.consume_response',
} as const;

export type CodexResetCreditsMsgType =
  typeof CODEX_RESET_CREDITS_MSG[keyof typeof CODEX_RESET_CREDITS_MSG];

/** One available (or historical) reset credit. Non-secret — safe to send to web. */
export interface CodexResetCredit {
  id: string;
  /** e.g. 'available' | 'redeemed' | 'expired'. */
  status: string;
  /** ISO-8601 timestamps as reported by the backend (may be undefined). */
  grantedAt?: string;
  expiresAt?: string;
  title?: string;
  description?: string;
}

export interface CodexResetCreditsList {
  credits: CodexResetCredit[];
  /** Backend-reported count of currently-available credits. */
  availableCount: number;
}

/** Normalized outcome of consuming a reset credit. */
export type CodexConsumeOutcome =
  | 'reset'             // a credit was consumed and eligible windows were reset
  | 'nothing_to_reset'  // no eligible rate-limit window → NO credit consumed
  | 'already_redeemed'  // the same idempotencyKey already completed a reset
  | 'no_credits'        // the account has no earned reset credits available
  | 'error';            // unexpected / unmapped result

/** Machine-readable error codes for the list/consume responses. */
export const CODEX_RESET_CREDITS_ERROR = {
  NO_CODEX_AUTH: 'no_codex_auth',       // ~/.codex/auth.json missing / no token
  REQUEST_FAILED: 'request_failed',     // HTTP / app-server call failed
  APP_SERVER_TIMEOUT: 'app_server_timeout',
  INVALID_PARAMS: 'invalid_params',
} as const;

export type CodexResetCreditsErrorCode =
  typeof CODEX_RESET_CREDITS_ERROR[keyof typeof CODEX_RESET_CREDITS_ERROR];
