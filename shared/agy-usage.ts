import { PROVIDER_QUOTA_GROUP_ID, PROVIDER_QUOTA_GROUP_LABEL } from './agy-agent.js';

/** CLI arguments used to probe quota/usage from `agy`. */
export const AGY_USAGE_CLI_ARGS = ['--print', '/usage'] as const;

/** Raw tier labels reported by `agy --print /usage`. */
export const AGY_USAGE_TIER_LABEL = {
  GEMINI: 'Gemini Models',
  CLAUDE_GPT: 'Claude and GPT models',
} as const;

/** Known tier label to canonical quota group ID mapping. */
export const AGY_USAGE_TIER_TO_GROUP_ID: Readonly<Record<string, string>> = {
  [AGY_USAGE_TIER_LABEL.GEMINI]: PROVIDER_QUOTA_GROUP_ID.GEMINI,
  [AGY_USAGE_TIER_LABEL.CLAUDE_GPT]: PROVIDER_QUOTA_GROUP_ID.CLAUDE_GPT,
};

/** Known tier label to product display label mapping. */
export const AGY_USAGE_TIER_TO_GROUP_LABEL: Readonly<Record<string, string>> = {
  [AGY_USAGE_TIER_LABEL.GEMINI]: PROVIDER_QUOTA_GROUP_LABEL.GEMINI,
  [AGY_USAGE_TIER_LABEL.CLAUDE_GPT]: PROVIDER_QUOTA_GROUP_LABEL.CLAUDE_GPT,
};

/** Canonical display ordering for known quota groups. */
export const AGY_USAGE_KNOWN_GROUP_ORDER: readonly string[] = [
  PROVIDER_QUOTA_GROUP_ID.GEMINI,
  PROVIDER_QUOTA_GROUP_ID.CLAUDE_GPT,
];

/** Raw window labels reported by `agy --print /usage`. */
export const AGY_USAGE_WINDOW_LABEL = {
  FIVE_HOUR: 'Five Hour Limit Remaining',
  WEEKLY: 'Weekly Limit Remaining',
} as const;

/** Window durations in minutes. */
export const AGY_USAGE_WINDOW_MINS = {
  FIVE_HOUR: 300,
  WEEKLY: 10080,
} as const;

/** Window label to duration in minutes mapping. */
export const AGY_USAGE_WINDOW_LABEL_TO_MINS: Readonly<Record<string, number>> = {
  [AGY_USAGE_WINDOW_LABEL.FIVE_HOUR]: AGY_USAGE_WINDOW_MINS.FIVE_HOUR,
  [AGY_USAGE_WINDOW_LABEL.WEEKLY]: AGY_USAGE_WINDOW_MINS.WEEKLY,
};

/** Throttle TTL for caching usage probe results (15 min). */
export const AGY_USAGE_CACHE_TTL_MS = 15 * 60 * 1000;

/** Idle suppression interval: skip probing if no agy-sdk session active within this window (15 min). */
export const AGY_USAGE_IDLE_SUPPRESS_MS = 15 * 60 * 1000;

/** Failure backoff interval before retrying a failed probe (5 min). */
export const AGY_USAGE_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

/** Hard timeout for running `agy --print /usage` (30 s). */
export const AGY_USAGE_TIMEOUT_MS = 30 * 1000;

/** Maximum age for persisted cache snapshot across restarts (24 h). */
export const AGY_USAGE_MAX_PERSISTED_AGE_MS = 24 * 60 * 60 * 1000;

/** File name for persisting quota snapshot on disk. */
export const AGY_USAGE_CACHE_FILE_NAME = 'agy-usage-quota.json' as const;
