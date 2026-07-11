import type { MemoryMcpSourceProvenance } from './memory-mcp-provenance.js';

// ── Cron Action types (discriminated union) ──────────────────────────────

export type CronActionType = 'command' | 'p2p' | 'send';

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

export type CronJobStatus = 'active' | 'paused' | 'expired' | 'error';

export const CRON_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  EXPIRED: 'expired',
  ERROR: 'error',
} as const satisfies Record<string, CronJobStatus>;
