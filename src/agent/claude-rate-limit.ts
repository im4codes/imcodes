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
