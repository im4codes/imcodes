// ── Cron Action types (discriminated union) ──────────────────────────────

export type CronActionType = 'command' | 'p2p';

export interface CronCommandAction {
  type: 'command';
  command: string;
}

export interface CronP2pAction {
  type: 'p2p';
  topic: string;
  mode: string;
  participants: string[];
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
