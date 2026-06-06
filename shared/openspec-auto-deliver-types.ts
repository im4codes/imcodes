import type { P2pAdvancedRound } from './p2p-advanced.js';
import type { P2pPermissionScope } from './p2p-workflow-constants.js';
import type {
  OpenSpecAutoDeliverComboId,
  OpenSpecAutoDeliverComboWriteMode,
  OpenSpecAutoDeliverEvidenceProvenance,
  OpenSpecAutoDeliverMutationScope,
  OpenSpecAutoDeliverPresetId,
  OpenSpecAutoDeliverRoundLimits,
  OpenSpecAutoDeliverScoreModuleId,
  OpenSpecAutoDeliverStage,
  OpenSpecAutoDeliverStrictResultChannel,
  OpenSpecAutoDeliverVerdict,
} from './openspec-auto-deliver-constants.js';

export interface OpenSpecAutoDeliverLaunchRequest {
  requestId: string;
  serverId?: string;
  sessionName: string;
  projectName?: string;
  changeName: string;
  presetId: OpenSpecAutoDeliverPresetId;
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
  designatedComboId: OpenSpecAutoDeliverComboId;
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
  activeComboId?: OpenSpecAutoDeliverComboId;
  latestVerdict?: OpenSpecAutoDeliverVerdict;
  moduleScores?: OpenSpecAutoDeliverModuleScore[];
  latestRepairSummary?: string;
  evidence?: OpenSpecAutoDeliverEvidence[];
  lastMessage?: string;
  terminalReason?: string;
}

export interface OpenSpecAutoDeliverConflictSummary {
  runId: string;
  owningMainSessionName: string;
  status: OpenSpecAutoDeliverStage;
  stage: OpenSpecAutoDeliverStage;
  reason: string;
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
