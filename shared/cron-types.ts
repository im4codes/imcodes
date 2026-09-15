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
  CLOSE_TAG: '</imcodes-cron-control>',
  SILENT_RESULT: 'SILENT',
} as const;

/** Registered immutable contract used by every self-managed cron schedule. */
export const CRON_CONTROL_CONTRACT = {
  contractId: 'supervision_cron_control_v1',
  version: 1,
  constraints: {
    updateSelf: 'explicit_user_request_only',
    cancelRecurring: 'explicit_user_request_only',
    cancelUntilComplete: 'overall_goal_complete_only',
    silent: 'first_non_empty_SILENT_stops_immediately_no_more_tools',
    network: 'explicit_task_request_only',
    finalResponse: 'exactly_one',
  },
} as const;

export interface CronControlRegistration {
  contractId: string;
  version: number;
  scheduleId: string;
  constraints: Record<string, unknown>;
}

export interface RegisteredCronSystemContract {
  contractId: string;
  signature: string;
  body: string;
}

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
  /** Server-authored, restart-durable registration for the immutable control contract. */
  cronControl?: CronControlRegistration;
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

export type CronControlValidationReason =
  | 'missing_authoritative_body'
  | 'missing_authoritative_contract'
  | 'unknown_contract_version'
  | 'task_id_mismatch'
  | 'tampered_contract_ref'
  | 'tampered_contract_body'
  | 'legacy_contract_mismatch';

export type CronControlActionResult =
  | { ok: true; action: CronCommandAction; migrated: boolean }
  | { ok: false; reason: CronControlValidationReason };

function canonicalCronControlRegistration(scheduleId: string): CronControlRegistration {
  return {
    contractId: CRON_CONTROL_CONTRACT.contractId,
    version: CRON_CONTROL_CONTRACT.version,
    scheduleId,
    constraints: { ...CRON_CONTROL_CONTRACT.constraints },
  };
}

/** Exact legacy body emitted before the registered-contract cutover. */
export function buildLegacyCronControlBlock(
  scheduleId: string,
  completionPolicy: CronCompletionPolicy,
): string {
  const lifecycleInstruction = completionPolicy === CRON_COMPLETION_POLICY.UNTIL_COMPLETE
    ? 'This schedule repeats until its overall goal is complete. Call cron_cancel_self with this id only when the overall goal—not merely this occurrence—is complete.'
    : 'Recurring task: complete this run and keep it scheduled. Cancel only on an explicit user request; force=true is required.';
  return `${CRON_CONTROL_PROTOCOL.OPEN_TAG}id=${JSON.stringify(scheduleId)} completion-policy=${JSON.stringify(completionPolicy)}>\nUse cron_update_self to change this task only when the user explicitly asks.\n${lifecycleInstruction}\nExecute only the operations explicitly requested above. Do not add web fetches, curl requests, or other network checks unless the task explicitly requests them.\nIf an explicitly requested tool returns ${CRON_CONTROL_PROTOCOL.SILENT_RESULT} as its first non-empty line, stop immediately, call no more tools, and finish this occurrence with exactly ${CRON_CONTROL_PROTOCOL.SILENT_RESULT}.\nAlways produce one final response for this occurrence.\n${CRON_CONTROL_PROTOCOL.CLOSE_TAG}`;
}

function validateRegistration(
  registration: CronControlRegistration | undefined,
  scheduleId: string,
): CronControlValidationReason | undefined {
  if (!registration) return 'missing_authoritative_contract';
  if (registration.contractId !== CRON_CONTROL_CONTRACT.contractId) return 'tampered_contract_ref';
  if (registration.version !== CRON_CONTROL_CONTRACT.version) return 'unknown_contract_version';
  if (registration.scheduleId !== scheduleId) return 'task_id_mismatch';
  if (JSON.stringify(registration.constraints) !== JSON.stringify(CRON_CONTROL_CONTRACT.constraints)) {
    return 'tampered_contract_body';
  }
  return undefined;
}

/** Strict daemon-side validation. Missing registrations never degrade to legacy behavior. */
export function validateRegisteredCronControlAction(
  action: CronCommandAction,
  scheduleId: string,
): CronControlActionResult {
  if (!action.command.trim()) return { ok: false, reason: 'missing_authoritative_body' };
  const reason = validateRegistration(action.cronControl, scheduleId);
  return reason ? { ok: false, reason } : { ok: true, action, migrated: false };
}

/**
 * Server-side idempotent migration. A missing registration is added once to
 * the authoritative action JSON; any present-but-invalid registration fails
 * closed instead of being overwritten.
 */
export function registerCronControlAction(
  action: CronCommandAction,
  scheduleId: string,
  completionPolicy: CronCompletionPolicy,
): CronControlActionResult {
  let command = action.command;
  const legacySuffix = `\n\n${buildLegacyCronControlBlock(scheduleId, completionPolicy)}`;
  if (command.endsWith(legacySuffix)) command = command.slice(0, -legacySuffix.length);
  else if (command.includes(CRON_CONTROL_PROTOCOL.OPEN_TAG)) {
    return { ok: false, reason: 'legacy_contract_mismatch' };
  }
  if (!command.trim()) return { ok: false, reason: 'missing_authoritative_body' };
  if (action.cronControl) {
    const reason = validateRegistration(action.cronControl, scheduleId);
    return reason ? { ok: false, reason } : { ok: true, action: { ...action, command }, migrated: command !== action.command };
  }
  return {
    ok: true,
    action: { ...action, command, cronControl: canonicalCronControlRegistration(scheduleId) },
    migrated: true,
  };
}

/** Per-occurrence binding; the immutable contract body stays in schedule state. */
export function buildCompactCronControlRef(
  scheduleId: string,
  completionPolicy: CronCompletionPolicy,
  executionId?: string,
): string {
  return JSON.stringify({
    contractRef: CRON_CONTROL_CONTRACT.contractId,
    scheduleId,
    completionPolicy,
    ...(executionId ? { executionId } : {}),
  });
}

/** Full provider-visible registration, emitted once per live provider thread. */
export function buildRegisteredCronSystemContract(
  action: CronCommandAction,
  scheduleId: string,
): RegisteredCronSystemContract {
  const body = JSON.stringify({
    contractId: CRON_CONTROL_CONTRACT.contractId,
    v: CRON_CONTROL_CONTRACT.version,
    binding: { scheduleId },
    authoritative: {
      taskBody: action.command,
      constraints: CRON_CONTROL_CONTRACT.constraints,
    },
  });
  return { contractId: CRON_CONTROL_CONTRACT.contractId, signature: body, body };
}

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
