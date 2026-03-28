// ── Cron Action types (discriminated union) ──────────────────────────────

export type CronActionType = 'command' | 'p2p';

export interface CronCommandAction {
  type: 'command';
  command: string;
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
}

export type CronAction = CronCommandAction | CronP2pAction;

// ── WS message types ─────────────────────────────────────────────────────

export const CRON_MSG = {
  DISPATCH: 'cron.dispatch',
} as const;

export interface CronDispatchMessage {
  type: typeof CRON_MSG.DISPATCH;
  jobId: string;
  jobName: string;
  serverId: string;
  projectName: string;
  targetRole: string;
  /** Direct session name for sub-session targeting (e.g. deck_sub_xxx). When set, overrides targetRole. */
  targetSessionName?: string;
  action: CronAction;
}

// ── Job status ───────────────────────────────────────────────────────────

export type CronJobStatus = 'active' | 'paused' | 'expired' | 'error';

export const CRON_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  EXPIRED: 'expired',
  ERROR: 'error',
} as const satisfies Record<string, CronJobStatus>;
