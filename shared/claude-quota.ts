/**
 * Constants for the opt-in claude.ai weekly (7-day) quota feature.
 *
 * The 5-hour window is shown by default (it comes from the SDK
 * `rate_limit_event` — no token read). The weekly window requires the user to
 * authorize reading the local Claude OAuth token, since fetching it hits the
 * private /api/oauth/usage endpoint. The authorization is a single per-user
 * preference (stored in `user_preferences`), so it applies to every server the
 * user owns.
 */

/** Per-user preference key gating the weekly-quota token read (user_preferences). */
export const CLAUDE_WEEKLY_QUOTA_PREF_KEY = 'claude_weekly_quota';

/** Web → daemon control messages for the weekly-quota opt-in. */
export const CLAUDE_QUOTA_MSG = {
  /** Authorize (or revoke) reading the local Claude token for the weekly quota. */
  SET_OPT_IN: 'claude.weekly_quota.set_opt_in',
} as const;
