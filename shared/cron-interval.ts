import { MEMORY_MCP_CAPS } from './memory-mcp-contracts.js';

export interface CronOccurrenceStepper {
  nextRun(prev?: Date): Date | null;
}

export type CronIntervalValidationResult =
  | { nextRunAt: number; intervalMs: number | null }
  | { error: 'invalid_cron_expression' }
  | { error: 'cron_interval_too_short'; minIntervalMinutes: number; message: string };

export type CronShortIntervalCheckResult =
  | { ok: true }
  | {
      ok: false;
      error: 'cron_short_interval_reason_required';
      thresholdMinutes: number;
      message: string;
    };

export function checkAgentShortIntervalJustification(options: {
  isAgentOrDaemon: boolean;
  intervalMs: number | null;
  shortIntervalReason: unknown;
}): CronShortIntervalCheckResult {
  const thresholdMinutes = MEMORY_MCP_CAPS.CRON_AGENT_SHORT_INTERVAL_THRESHOLD_MINUTES;
  const thresholdMs = thresholdMinutes * 60 * 1000;
  if (!options.isAgentOrDaemon || options.intervalMs === null || options.intervalMs >= thresholdMs) {
    return { ok: true };
  }
  if (typeof options.shortIntervalReason === 'string' && options.shortIntervalReason.trim().length > 0) {
    return { ok: true };
  }
  return {
    ok: false,
    error: 'cron_short_interval_reason_required',
    thresholdMinutes,
    message: `Intervals under ${thresholdMinutes} minutes require shortIntervalReason explaining why a shorter interval is genuinely needed instead of reactive wakeups or >=${thresholdMinutes}m (>=30m recommended).`,
  };
}

/**
 * Sample a bounded horizon of occurrences from a parsed cron schedule so step
 * expressions (such as 14-minute steps) are judged by their nominal cadence (`max` gap).
 */
export function sampleCronOccurrences(job: CronOccurrenceStepper, maxSteps = 7): Date[] {
  const first = job.nextRun();
  if (!first) return [];
  const occurrences = [first];
  let cursor = first;
  for (let i = 0; i < maxSteps; i++) {
    const next = job.nextRun(cursor);
    if (!next) break;
    occurrences.push(next);
    cursor = next;
  }
  return occurrences;
}

/** Validate a cron schedule using an occurrence sampler against `minIntervalMinutes`. */
export function validateCronScheduleWithSampler(
  sampleOccurrences: () => Date[],
  minIntervalMinutes: number = MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES,
): CronIntervalValidationResult {
  try {
    const occurrences = sampleOccurrences();
    const first = occurrences[0];
    if (!first) return { error: 'invalid_cron_expression' };
    const intervals = occurrences
      .slice(1)
      .map((next, index) => next.getTime() - occurrences[index]!.getTime());
    const intervalMs = intervals.length > 0 ? Math.max(...intervals) : null;
    const minIntervalMs = minIntervalMinutes * 60 * 1000;
    if (intervalMs !== null && intervalMs < minIntervalMs) {
      return {
        error: 'cron_interval_too_short',
        minIntervalMinutes,
        message: `Minimum cron interval is ${minIntervalMinutes} minutes`,
      };
    }
    return {
      nextRunAt: first.getTime(),
      intervalMs,
    };
  } catch {
    return { error: 'invalid_cron_expression' };
  }
}
