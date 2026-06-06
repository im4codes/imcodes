import {
  OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET_ID,
  OPENSPEC_AUTO_DELIVER_MSG,
  OPENSPEC_AUTO_DELIVER_PRESET_LIMITS,
  type OpenSpecAutoDeliverPresetId,
} from '@shared/openspec-auto-deliver-constants.js';

export { OPENSPEC_AUTO_DELIVER_MSG };

export type OpenSpecAutoDeliverMessageType = typeof OPENSPEC_AUTO_DELIVER_MSG[keyof typeof OPENSPEC_AUTO_DELIVER_MSG];

export const OPENSPEC_AUTO_DELIVER_PRESETS = [
  { id: 'fast', labelKey: 'openspec.auto.preset.fast', ...OPENSPEC_AUTO_DELIVER_PRESET_LIMITS.fast },
  { id: 'standard', labelKey: 'openspec.auto.preset.standard', ...OPENSPEC_AUTO_DELIVER_PRESET_LIMITS.standard },
  { id: 'strict', labelKey: 'openspec.auto.preset.strict', ...OPENSPEC_AUTO_DELIVER_PRESET_LIMITS.strict },
  { id: 'deep', labelKey: 'openspec.auto.preset.deep', ...OPENSPEC_AUTO_DELIVER_PRESET_LIMITS.deep },
] as const;

export type { OpenSpecAutoDeliverPresetId };

export const OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET: OpenSpecAutoDeliverPresetId = OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET_ID;

export type OpenSpecAutoDeliverStatus =
  | 'launching'
  | 'active'
  | 'passed'
  | 'needs_human'
  | 'failed'
  | 'stopped';

export type OpenSpecAutoDeliverStage =
  | 'proposed'
  | 'spec_audit_repair'
  | 'implementation_task_loop'
  | 'implementation_audit_repair'
  | 'passed'
  | 'needs_human'
  | 'failed'
  | 'stopped';

export type OpenSpecAutoDeliverVerdict = 'PASS' | 'REWORK' | 'BLOCKED';

export interface OpenSpecAutoDeliverTaskStats {
  total: number;
  checked: number;
  unchecked: number;
  uncheckedLabels?: string[];
  items?: Array<{ line?: number; checked: boolean; label: string }>;
}

export interface OpenSpecAutoDeliverModuleScore {
  module: 'spec' | 'tasks' | 'implementation' | 'tests' | 'risk' | string;
  score: number;
  maxScore?: number;
  max_score?: number;
  summary?: string;
}

export interface OpenSpecAutoDeliverEvidence {
  label?: string;
  provenance?: 'daemon' | 'implementation_reported' | 'audit_reported' | 'none' | string;
  source?: 'daemon' | 'implementation_reported' | 'audit_reported' | 'none' | string;
  summary?: string;
  command?: string;
  exitCode?: number;
  stale?: boolean;
}

export interface OpenSpecAutoDeliverProjection {
  runId: string;
  projectionVersion: number;
  visibility?: 'full' | 'conflict';
  changeName: string;
  presetId?: OpenSpecAutoDeliverPresetId | string;
  status: OpenSpecAutoDeliverStatus | string;
  stage: OpenSpecAutoDeliverStage | string;
  startedAt?: number;
  elapsedMs?: number;
  owningMainSessionName?: string;
  launchedFromSessionName?: string;
  targetImplementationSessionName?: string;
  materializedLimits?: {
    specAuditRepairRounds: number;
    implementationAuditRepairRounds: number;
    maxImplementationPrompts?: number;
    maxElapsedMinutes?: number;
  };
  specAuditRepairRound?: number;
  implementationAuditRepairRound?: number;
  specAuditRound?: { current: number; total: number };
  implementationAuditRound?: { current: number; total: number };
  implementationPromptCount?: number;
  taskStats?: OpenSpecAutoDeliverTaskStats;
  activeP2pRunId?: string | null;
  activeComboId?: string | null;
  latestVerdict?: OpenSpecAutoDeliverVerdict | string | null;
  moduleScores?: OpenSpecAutoDeliverModuleScore[];
  latestRepairSummary?: string | null;
  evidence?: OpenSpecAutoDeliverEvidence[];
  recentFinding?: string | null;
  terminalReason?: string | null;
  conflictReason?: string | null;
  canStop?: boolean;
  canDismiss?: boolean;
}

export interface OpenSpecAutoDeliverLaunchPayload {
  type: typeof OPENSPEC_AUTO_DELIVER_MSG.LAUNCH;
  requestId: string;
  serverId?: string;
  sessionName: string;
  changeName: string;
  presetId: OpenSpecAutoDeliverPresetId;
}

export interface OpenSpecAutoDeliverStopPayload {
  type: typeof OPENSPEC_AUTO_DELIVER_MSG.STOP;
  requestId: string;
  serverId?: string;
  sessionName: string;
  runId: string;
}

export interface OpenSpecAutoDeliverStatusRequestPayload {
  type: typeof OPENSPEC_AUTO_DELIVER_MSG.STATUS_REQUEST;
  requestId: string;
  serverId?: string;
  sessionName: string;
}

export function isOpenSpecAutoDeliverTerminalStatus(status: OpenSpecAutoDeliverStatus | string | undefined): boolean {
  return status === 'passed' || status === 'needs_human' || status === 'failed' || status === 'stopped';
}

export function isOpenSpecAutoDeliverActiveProjection(projection: OpenSpecAutoDeliverProjection | null | undefined): boolean {
  return !!projection && !isOpenSpecAutoDeliverTerminalStatus(projection.status);
}

export function materializedPresetLimits(presetId: OpenSpecAutoDeliverPresetId) {
  const preset = OPENSPEC_AUTO_DELIVER_PRESETS.find((entry) => entry.id === presetId)
    ?? OPENSPEC_AUTO_DELIVER_PRESETS.find((entry) => entry.id === OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET)!;
  return {
    specAuditRepairRounds: preset.specAuditRepairRounds,
    implementationAuditRepairRounds: preset.implementationAuditRepairRounds,
  };
}
