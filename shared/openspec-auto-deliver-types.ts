import type { P2pAdvancedRound } from './p2p-advanced.js';
import type { P2pPermissionScope } from './p2p-workflow-constants.js';
import type {
  OpenSpecAutoDeliverComboId,
  OpenSpecAutoDeliverComboWriteMode,
  OpenSpecAutoDeliverEvidenceProvenance,
  OpenSpecAutoDeliverMutationScope,
  OpenSpecAutoDeliverProjectionVisibility,
  OpenSpecAutoDeliverPresetId,
  OpenSpecAutoDeliverRoundLimits,
  OpenSpecAutoDeliverScoreModuleId,
  OpenSpecAutoDeliverStage,
  OpenSpecAutoDeliverStagePromptId,
  OpenSpecAutoDeliverStrictResultChannel,
  OpenSpecAutoDeliverViewMode,
  OpenSpecAutoDeliverVerdict,
} from './openspec-auto-deliver-constants.js';

export interface OpenSpecAutoDeliverLaunchRequest {
  requestId: string;
  serverId?: string;
  sessionName: string;
  projectName?: string;
  changeName: string;
  presetId: OpenSpecAutoDeliverPresetId;
  materializedLimits?: OpenSpecAutoDeliverRoundLimits & {
    maxImplementationPrompts?: number;
    maxElapsedMinutes?: number;
  };
  selectedTeamComboId?: string;
}

export interface OpenSpecAutoDeliverStopRequest {
  requestId: string;
  serverId?: string;
  sessionName: string;
  runId: string;
}

export interface OpenSpecAutoDeliverStatusRequest {
  requestId: string;
  serverId?: string;
  sessionName: string;
}

export interface OpenSpecAutoDeliverTaskItem {
  line: number;
  checked: boolean;
  label: string;
}

export interface OpenSpecAutoDeliverTaskStats {
  total: number;
  checked: number;
  unchecked: number;
  items: OpenSpecAutoDeliverTaskItem[];
}

export interface OpenSpecAutoDeliverModuleScore {
  module: OpenSpecAutoDeliverScoreModuleId;
  score: number;
  max_score: 10;
  summary: string;
}

export interface OpenSpecAutoDeliverRepairSummary {
  files: string[];
  reason: string;
}

export interface OpenSpecAutoDeliverEvidence {
  source: OpenSpecAutoDeliverEvidenceProvenance;
  summary: string;
  command?: string;
  exitCode?: number;
  stale?: boolean;
}

export interface OpenSpecAutoDeliverVerdictPayload {
  verdict: OpenSpecAutoDeliverVerdict;
  module_scores: OpenSpecAutoDeliverModuleScore[];
  unchecked_tasks: string[];
  required_changes: string[];
  repairs_applied: OpenSpecAutoDeliverRepairSummary[];
  evidence: OpenSpecAutoDeliverEvidence[];
}

export interface OpenSpecAutoDeliverP2pMetadata {
  owner: 'openspec_auto_deliver';
  runId: string;
  owningMainSessionName: string;
  executionSessionName: string;
  changeName: string;
  resolvedChangeRootIdentity: string;
  stage: Extract<OpenSpecAutoDeliverStage, 'spec_audit_repair' | 'implementation_audit_repair'>;
  selectedTeamComboId: string;
  activeOpenSpecPromptId: OpenSpecAutoDeliverStagePromptId;
  roundIndex: number;
  attemptId: string;
  generation: number;
}

export interface OpenSpecAutoDeliverComboCapability {
  stage: Extract<OpenSpecAutoDeliverStage, 'spec_audit_repair' | 'implementation_audit_repair'>;
  requiredPermissionScope: P2pPermissionScope;
  allowedMutationScopes: OpenSpecAutoDeliverMutationScope[];
  writeMode: OpenSpecAutoDeliverComboWriteMode;
  strictResultChannel: OpenSpecAutoDeliverStrictResultChannel;
  minTransportParticipants: number;
  supportsGenerationMetadata: boolean;
  supportsStopCancellation: boolean;
}

export interface OpenSpecAutoDeliverComboDescriptor {
  id: OpenSpecAutoDeliverComboId;
  title: string;
  capability: OpenSpecAutoDeliverComboCapability;
  rounds: P2pAdvancedRound[];
}

export interface OpenSpecAutoDeliverProjection {
  visibility?: Extract<OpenSpecAutoDeliverProjectionVisibility, 'full'>;
  projectionVersion: number;
  runId: string;
  changeName: string;
  presetId: OpenSpecAutoDeliverPresetId;
  materializedLimits: OpenSpecAutoDeliverRoundLimits & {
    maxImplementationPrompts?: number;
    maxElapsedMinutes?: number;
  };
  status: OpenSpecAutoDeliverStage;
  stage: OpenSpecAutoDeliverStage;
  owningMainSessionName: string;
  launchedFromSessionName: string;
  targetImplementationSessionName: string;
  generation: number;
  implementationPromptCount: number;
  elapsedMs: number;
  taskStats: OpenSpecAutoDeliverTaskStats;
  specAuditRepairRound: number;
  implementationAuditRepairRound: number;
  activeP2pRunId?: string;
  selectedTeamComboId?: string;
  activeOpenSpecPromptId?: OpenSpecAutoDeliverStagePromptId;
  canStop?: boolean;
  latestVerdict?: OpenSpecAutoDeliverVerdict;
  moduleScores?: OpenSpecAutoDeliverModuleScore[];
  latestRepairSummary?: string;
  evidence?: OpenSpecAutoDeliverEvidence[];
  lastMessage?: string;
  terminalReason?: string;
}

export interface OpenSpecAutoDeliverConflictSummary {
  visibility?: Extract<OpenSpecAutoDeliverProjectionVisibility, 'conflict'>;
  projectionVersion?: number;
  runId: string;
  owningMainSessionName: string;
  status: OpenSpecAutoDeliverStage;
  stage: OpenSpecAutoDeliverStage;
  reason: string;
  canStop?: false;
}

export interface OpenSpecAutoDeliverBrowserTaskStats {
  total: number;
  checked: number;
  unchecked: number;
  uncheckedLabels?: string[];
  items?: Array<{ line?: number; checked: boolean; label: string }>;
}

export interface OpenSpecAutoDeliverBrowserModuleScore {
  module: OpenSpecAutoDeliverScoreModuleId | string;
  score: number;
  maxScore?: number;
  max_score?: number;
  summary?: string;
}

export interface OpenSpecAutoDeliverBrowserEvidence {
  label?: string;
  provenance?: OpenSpecAutoDeliverEvidenceProvenance | string;
  source?: OpenSpecAutoDeliverEvidenceProvenance | string;
  summary?: string;
  command?: string;
  exitCode?: number;
  stale?: boolean;
}

export interface OpenSpecAutoDeliverBrowserFullProjection {
  visibility: Extract<OpenSpecAutoDeliverProjectionVisibility, 'full'>;
  projectionVersion: number;
  generation: number;
  runId: string;
  changeName: string;
  presetId?: OpenSpecAutoDeliverPresetId | string;
  status: OpenSpecAutoDeliverStage | string;
  stage: OpenSpecAutoDeliverStage | string;
  startedAt?: number;
  elapsedMs?: number;
  owningMainSessionName?: string;
  launchedFromSessionName?: string;
  targetImplementationSessionName?: string;
  materializedLimits?: OpenSpecAutoDeliverRoundLimits & {
    maxImplementationPrompts?: number;
    maxElapsedMinutes?: number;
  };
  specAuditRepairRound?: number;
  implementationAuditRepairRound?: number;
  specAuditRound?: { current: number; total: number };
  implementationAuditRound?: { current: number; total: number };
  implementationPromptCount?: number;
  taskStats?: OpenSpecAutoDeliverBrowserTaskStats;
  activeP2pRunId?: string | null;
  selectedTeamComboId?: string | null;
  activeOpenSpecPromptId?: OpenSpecAutoDeliverStagePromptId | string | null;
  latestVerdict?: OpenSpecAutoDeliverVerdict | string | null;
  moduleScores?: OpenSpecAutoDeliverBrowserModuleScore[];
  latestRepairSummary?: string | null;
  evidence?: OpenSpecAutoDeliverBrowserEvidence[];
  validationEvidenceProvenance?: string[];
  recentFinding?: string | null;
  terminalReason?: string | null;
  terminal?: boolean;
  updatedAt?: string;
  canStop?: boolean;
  canDismiss?: boolean;
}

export interface OpenSpecAutoDeliverBrowserConflictProjection {
  visibility: Extract<OpenSpecAutoDeliverProjectionVisibility, 'conflict'>;
  projectionVersion: number;
  runId: string;
  owningMainSessionName: string;
  status?: OpenSpecAutoDeliverStage | string;
  stage?: OpenSpecAutoDeliverStage | string;
  busy: true;
  reason: string;
  conflictReason: string;
  canStop: false;
  changeName?: never;
  presetId?: never;
  launchedFromSessionName?: never;
  targetImplementationSessionName?: never;
  materializedLimits?: never;
  specAuditRepairRound?: never;
  implementationAuditRepairRound?: never;
  specAuditRound?: never;
  implementationAuditRound?: never;
  implementationPromptCount?: never;
  taskStats?: never;
  activeP2pRunId?: never;
  selectedTeamComboId?: never;
  activeOpenSpecPromptId?: never;
  latestVerdict?: never;
  moduleScores?: never;
  latestRepairSummary?: never;
  evidence?: never;
  validationEvidenceProvenance?: never;
  recentFinding?: never;
  terminalReason?: never;
  terminal?: never;
  updatedAt?: never;
  canDismiss?: never;
}

export type OpenSpecAutoDeliverBrowserProjection =
  | OpenSpecAutoDeliverBrowserFullProjection
  | OpenSpecAutoDeliverBrowserConflictProjection;

export interface OpenSpecAutoDeliverListRow {
  projectionVersion: number;
  visibility: OpenSpecAutoDeliverProjectionVisibility;
  runId: string;
  owningMainSessionName: string;
  status: OpenSpecAutoDeliverStage | string;
  stage: OpenSpecAutoDeliverStage | string;
  viewMode?: OpenSpecAutoDeliverViewMode;
  changeName?: string;
  presetId?: OpenSpecAutoDeliverPresetId;
  selectedTeamComboId?: string;
  targetImplementationSessionName?: string;
  launchedFromSessionName?: string;
  elapsedMs?: number;
  terminalReason?: string;
  reason?: string;
}

export type OpenSpecAutoDeliverValidationSeverity = 'error' | 'warning';

export interface OpenSpecAutoDeliverValidationIssue {
  code: string;
  message: string;
  path?: string;
  severity: OpenSpecAutoDeliverValidationSeverity;
}

export type OpenSpecAutoDeliverValidationResult<T> =
  | { ok: true; value: T; issues: OpenSpecAutoDeliverValidationIssue[] }
  | { ok: false; issues: OpenSpecAutoDeliverValidationIssue[] };

export interface OpenSpecAutoDeliverValidationRecommendation {
  command: string;
  reason: string;
  safety: 'recommended' | 'unsafe' | 'unknown';
  sourceFile: string;
}
