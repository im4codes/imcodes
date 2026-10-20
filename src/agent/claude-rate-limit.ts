import {
  PROVIDER_LIMIT_EVIDENCE_KINDS,
  PROVIDER_LIMIT_STATES,
  delegationLimitGroup,
  type ProviderLimitSignal,
} from '../../shared/delegation-availability.js';
import type { ProviderQuotaMeta, ProviderQuotaWindow } from '../../shared/provider-quota.js';

/**
 * The subset of the Claude Agent SDK's `rate_limit_event` → `rate_limit_info`
 * (`SDKRateLimitInfo`) that we consume. Verified against the live SDK
 * (@anthropic-ai/claude-agent-sdk 0.2.x):
 *   - `resetsAt` is epoch **SECONDS** (e.g. 1780123200), so it feeds the shared
 *     `formatResetDateTime`/`formatRemainingTime` directly with no conversion.
 *   - Each event carries exactly ONE `rateLimitType`. While well within limits
 *     the SDK only emits `five_hour` (with `status:'allowed'` and NO
 *     `utilization`); the weekly `seven_day*` window + `utilization` only
 *     surface as a limit is approached/binding. So callers must cache per type
 *     and tolerate a missing weekly window / missing percent.
 */
export interface ClaudeRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
}

/**
 * Claude's own verdict values on `rate_limit_info.status`.
 *
 * These are the ONLY authority for "this account is being refused". The quota
 * percentages next to them cannot answer it: `utilization` is undefined while
 * healthy, so a percentage threshold would be a policy we invented rather than
 * a fact the provider stated.
 */
export const CLAUDE_RATE_LIMIT_STATUS = Object.freeze({
  ALLOWED: 'allowed',
  ALLOWED_WARNING: 'allowed_warning',
  REJECTED: 'rejected',
} as const);

/** Names the provider-native field a limit came from, for auditability. */
export const CLAUDE_RATE_LIMIT_EVIDENCE_SOURCE = 'claude.rate_limit_event.status' as const;

/**
 * Map one `rate_limit_event` into the canonical signal.
 *
 * THE MAPPING LIVES HERE, IN CLAUDE'S OWN ADAPTER. The orchestration layer
 * reads only the canonical shape, so no code outside this file needs to know
 * that Claude spells its verdict `status` or its window `rateLimitType` -- and
 * there is no global table trying to understand every vendor at once.
 *
 * `toWindow()` below deliberately keeps only the display numbers, and for a
 * long time that was the ONLY thing this module produced. So `status`, the one
 * field that actually says whether Claude is refusing us, was parsed into the
 * interface and then dropped; anything downstream asking "are we limited" had
 * nothing to read.
 *
 * Returns `null` for an unrecognised status rather than guessing. An unknown
 * value must not clear an active limit, and the caller distinguishes "no
 * evidence" from "healthy" precisely so it cannot.
 */
export function claudeRateLimitSignal(
  info: ClaudeRateLimitInfo | undefined,
  agentType: string,
  observedAt: number,
): ProviderLimitSignal | null {
  if (!info || typeof info.status !== 'string') return null;
  const state = info.status === CLAUDE_RATE_LIMIT_STATUS.REJECTED
    ? PROVIDER_LIMIT_STATES.LIMITED
    : info.status === CLAUDE_RATE_LIMIT_STATUS.ALLOWED_WARNING
      ? PROVIDER_LIMIT_STATES.WARNING
      : info.status === CLAUDE_RATE_LIMIT_STATUS.ALLOWED
        ? PROVIDER_LIMIT_STATES.RECOVERED
        : null;
  if (state === null) return null;
  // `resetsAt` is epoch SECONDS on this event; the canonical signal carries
  // epoch milliseconds. Converting at the adapter boundary keeps exactly one
  // unit above it.
  const retryAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)
    ? info.resetsAt * 1000
    : undefined;
  return {
    providerId: agentType,
    limitGroup: delegationLimitGroup(agentType),
    state,
    observedAt,
    ...(retryAt === undefined ? {} : { retryAt }),
    ...(typeof info.rateLimitType === 'string' && info.rateLimitType
      ? { scope: info.rateLimitType }
      : {}),
    // A field Claude defines, not something we read out of a message.
    evidenceKind: PROVIDER_LIMIT_EVIDENCE_KINDS.PROVIDER_STRUCTURED,
    sourceCode: info.status,
  };
}

/** Claude's named rate-limit windows. */
export const CLAUDE_FIVE_HOUR_MINS = 5 * 60; // 300
export const CLAUDE_SEVEN_DAY_MINS = 7 * 24 * 60; // 10080

/**
 * Normalize `utilization` to a 0–100 percent. The SDK reports it as a 0–1
 * fraction in practice; we tolerate an already-percent value (>1) defensively.
 * (No non-null `utilization` was observed while healthy — confirm the exact
 * quantum the first time a value lands.)
 */
function toUsedPercent(utilization: number | undefined): number | undefined {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return undefined;
  return utilization <= 1 ? utilization * 100 : utilization;
}

function toWindow(info: ClaudeRateLimitInfo | undefined, windowDurationMins: number): ProviderQuotaWindow | undefined {
  if (!info) return undefined;
  const used = toUsedPercent(info.utilization);
  const window: ProviderQuotaWindow = { windowDurationMins };
  if (used !== undefined) window.usedPercent = used;
  if (typeof info.resetsAt === 'number') window.resetsAt = info.resetsAt;
  return window;
}

/**
 * Fold the cached per-type Claude rate-limit snapshots into the shared
 * `ProviderQuotaMeta` used by every provider's quota display:
 *   - `five_hour`                                   → `primary`   (5h window)
 *   - `seven_day` / `seven_day_opus` / `_sonnet`    → `secondary` (weekly)
 * Returns `undefined` when neither window is known yet, so we never emit an
 * empty quota snapshot. `resetsAt` passes through unchanged (epoch seconds).
 */
export function claudeRateLimitsToQuotaMeta(
  byType: Readonly<Record<string, ClaudeRateLimitInfo | undefined>>,
): ProviderQuotaMeta | undefined {
  const primary = toWindow(byType.five_hour, CLAUDE_FIVE_HOUR_MINS);
  const weekly = byType.seven_day ?? byType.seven_day_opus ?? byType.seven_day_sonnet;
  const secondary = toWindow(weekly, CLAUDE_SEVEN_DAY_MINS);
  if (!primary && !secondary) return undefined;
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}
