import type { MemoryMcpSourceProvenance } from './memory-mcp-provenance.js';

// ── Cron Action types (discriminated union) ──────────────────────────────

export type CronActionType = 'command' | 'p2p' | 'send';

export const CRON_COMPLETION_POLICY = {
  /** Each dispatch completes one occurrence; the schedule remains active. */
  RECURRING: 'recurring',
  /** The schedule may cancel itself once its overall goal is complete. */
  UNTIL_COMPLETE: 'until_complete',
} as const;

/** Protocol markers used by self-managed scheduled turns. Keep these shared. */
export const CRON_CONTROL_PROTOCOL = {
  OPEN_TAG: '<imcodes-cron-control ',
  SILENT_RESULT: 'SILENT',
} as const;

/** True when a self-managed cron tool result explicitly declares a no-op run. */
export function isCronSilentResult(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const firstNonEmptyLine = value.split(/\r?\n/u).find((line) => line.trim().length > 0);
  return firstNonEmptyLine?.trim() === CRON_CONTROL_PROTOCOL.SILENT_RESULT;
}

export type CronCompletionPolicy = (typeof CRON_COMPLETION_POLICY)[keyof typeof CRON_COMPLETION_POLICY];

/** Legacy and malformed values fail safe to recurring so a run cannot silently delete its schedule. */
export function normalizeCronCompletionPolicy(value: unknown): CronCompletionPolicy {
  return value === CRON_COMPLETION_POLICY.UNTIL_COMPLETE
    ? CRON_COMPLETION_POLICY.UNTIL_COMPLETE
    : CRON_COMPLETION_POLICY.RECURRING;
}

export interface CronCommandAction {
  type: 'command';
  command: string;
  /** Marks a runtime-bound self cron whose prompt should include lifecycle controls. */
  selfManaged?: boolean;
}

/** A participant can be identified by main-session role or direct sub-session name. */
export type CronParticipant =
  | { type: 'role'; value: string }
  | { type: 'session'; value: string };

export interface CronP2pAction {
  type: 'p2p';
  topic: string;
  mode: string;
  /** @deprecated Use `participantEntries` for new jobs. Kept for backward compat with existing DB rows. */
  participants?: string[];
  /** Discriminated participant list — supports both roles and direct session names. */
  participantEntries?: CronParticipant[];
  rounds?: number;
  /**
   * Audit:R3 hardening / task 10.2 — when present, the cron dispatcher routes
   * this job through the daemon's advanced-workflow envelope path
   * (`prepareAdvancedWorkflowLaunch`) instead of the legacy `startP2pRun`
   * fallback. Carries the same shape as web-side
   * `p2pWorkflowLaunchEnvelope`. Stored in DB as JSON; daemon validates +
   * compiles + binds at dispatch time. v1a compatibility: legacy cron rows
   * without this field continue to use the direct legacy path.
   */
  workflowLaunchEnvelope?: Record<string, unknown>;
  /**
   * Bounded retry budget for `daemon_busy` — `dispatchAttempts` total tries
   * (default 3), `retryDelayMs` between each. After exhaustion the cron run
   * is marked failed with a stable diagnostic. Task 10.3.
   */
  daemonBusyRetry?: {
    attempts: number;
    delayMs: number;
  };
}

export interface CronSendAction extends MemoryMcpSourceProvenance {
  type: 'send';
  target: string;
  message: string;
  reply?: boolean;
  broadcast?: boolean;
  idempotencyKey?: string;
}

export type CronAction = CronCommandAction | CronP2pAction | CronSendAction;

// ── WS message types ─────────────────────────────────────────────────────

export const CRON_MSG = {
  DISPATCH: 'cron.dispatch',
  COMMAND_RESULT: 'cron.command_result',
} as const;

export interface CronDispatchMessage {
  type: typeof CRON_MSG.DISPATCH;
  jobId: string;
  executionId?: string;
  jobName: string;
  serverId: string;
  projectName: string;
  targetRole: string;
  cronExpr?: string;
  timezone?: string | null;
  expiresAt?: number | null;
  /** Missing in older server dispatches; daemon treats it as recurring. */
  completionPolicy?: CronCompletionPolicy;
  /** Direct session name for sub-session targeting (e.g. deck_sub_xxx). When set, overrides targetRole. */
  targetSessionName?: string;
  action: CronAction;
}

export interface CronCommandResultMessage {
  type: typeof CRON_MSG.COMMAND_RESULT;
  jobId: string;
  executionId?: string;
  detail: string;
  status?: 'manual_trigger' | 'dispatched' | 'partial' | 'skipped_busy' | 'error';
}

// ── Job status ───────────────────────────────────────────────────────────

// Older daemons persisted every cumulative `assistant.text` streaming snapshot
// by joining them with newlines. Besides wasting space, the 4KB execution cap
// could be exhausted before the terminal snapshot arrived. Recover the newest
// snapshot only when the text contains a strong monotonic-prefix chain; normal
// multiline output is returned byte-for-byte unchanged.
const LEGACY_CRON_STREAM_MIN_PREFIX_SNAPSHOTS = 4;
const LEGACY_CRON_STREAM_MIN_GROWTH_STEPS = 4;
const LEGACY_CRON_STREAM_MIN_DISCARDED_CHARS = 32;
const LEGACY_CRON_STREAM_MIN_FINAL_CHARS = 16;

interface LegacyCronSnapshotChainScore {
  snapshots: number;
  growthSteps: number;
}

function findLegacyCronSnapshotChain(
  source: string,
  prefixEnd: number,
  finalSnapshot: string,
): LegacyCronSnapshotChainScore | null {
  const memo = new Map<string, LegacyCronSnapshotChainScore | null>();

  const visit = (start: number, previousLength: number): LegacyCronSnapshotChainScore | null => {
    const key = `${start}:${previousLength}`;
    if (memo.has(key)) return memo.get(key) ?? null;

    let best: LegacyCronSnapshotChainScore | null = null;
    let end = source.indexOf('\n', start);
    while (end >= 0 && end <= prefixEnd) {
      const snapshot = source.slice(start, end);
      const length = snapshot.length;
      if (
        length > 0
        && length >= previousLength
        && length <= finalSnapshot.length
        && finalSnapshot.startsWith(snapshot)
      ) {
        const tail = end === prefixEnd
          ? { snapshots: 0, growthSteps: length < finalSnapshot.length ? 1 : 0 }
          : visit(end + 1, length);
        if (tail) {
          const score = {
            snapshots: tail.snapshots + 1,
            growthSteps: tail.growthSteps + (previousLength >= 0 && length > previousLength ? 1 : 0),
          };
          if (
            !best
            || score.snapshots > best.snapshots
            || (score.snapshots === best.snapshots && score.growthSteps > best.growthSteps)
          ) {
            best = score;
          }
        }
      }
      end = source.indexOf('\n', end + 1);
    }

    memo.set(key, best);
    return best;
  };

  return visit(0, -1);
}

/**
 * Collapse the legacy newline-joined cumulative stream format to its newest
 * snapshot. This is intentionally conservative so ordinary Markdown, lists,
 * logs, and repeated lines are not rewritten.
 */
export function normalizeCronExecutionDetail(detail: string): string {
  if (!detail.includes('\n')) return detail;
  const source = detail.includes('\r\n') ? detail.replace(/\r\n/g, '\n') : detail;
  let best: { detail: string; score: LegacyCronSnapshotChainScore } | null = null;

  let separator = source.indexOf('\n');
  while (separator >= 0 && separator < source.length - 1) {
    const finalSnapshot = source.slice(separator + 1);
    const score = findLegacyCronSnapshotChain(source, separator, finalSnapshot);
    if (
      score
      && score.snapshots >= LEGACY_CRON_STREAM_MIN_PREFIX_SNAPSHOTS
      && score.growthSteps >= LEGACY_CRON_STREAM_MIN_GROWTH_STEPS
      && separator >= LEGACY_CRON_STREAM_MIN_DISCARDED_CHARS
      && finalSnapshot.length >= LEGACY_CRON_STREAM_MIN_FINAL_CHARS
      && (
        !best
        || score.snapshots > best.score.snapshots
        || (score.snapshots === best.score.snapshots && score.growthSteps > best.score.growthSteps)
        || (
          score.snapshots === best.score.snapshots
          && score.growthSteps === best.score.growthSteps
          && finalSnapshot.length > best.detail.length
        )
      )
    ) {
      best = { detail: finalSnapshot, score };
    }
    separator = source.indexOf('\n', separator + 1);
  }

  return best?.detail ?? detail;
}

export type CronJobStatus = 'active' | 'paused' | 'expired' | 'error';

export const CRON_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  EXPIRED: 'expired',
  ERROR: 'error',
} as const satisfies Record<string, CronJobStatus>;
