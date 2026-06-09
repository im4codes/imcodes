import {
  OPENSPEC_AUTO_DELIVER_EVIDENCE_PROVENANCE,
  OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_PROMPT_ID,
  OPENSPEC_AUTO_DELIVER_PRESET_IDS,
  OPENSPEC_AUTO_DELIVER_PROJECTION_VISIBILITIES,
  OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS,
  OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_PROMPT_ID,
  OPENSPEC_AUTO_DELIVER_STAGES,
  OPENSPEC_AUTO_DELIVER_VERDICTS,
  OPENSPEC_AUTO_DELIVER_VIEW_MODES,
  type OpenSpecAutoDeliverPresetId,
} from '@shared/openspec-auto-deliver-constants.js';
import type {
  OpenSpecAutoDeliverEvidence,
  OpenSpecAutoDeliverAuditResult,
  OpenSpecAutoDeliverListRow,
  OpenSpecAutoDeliverModuleScore,
  OpenSpecAutoDeliverProjection,
  OpenSpecAutoDeliverBrowserScoreSnapshot,
  OpenSpecAutoDeliverTaskStats,
} from './openspec-auto-deliver.js';

const STAGE_VALUES = new Set<string>(OPENSPEC_AUTO_DELIVER_STAGES);
const PRESET_VALUES = new Set<string>(OPENSPEC_AUTO_DELIVER_PRESET_IDS);
const PROJECTION_VISIBILITY_VALUES = new Set<string>(OPENSPEC_AUTO_DELIVER_PROJECTION_VISIBILITIES);
const VIEW_MODE_VALUES = new Set<string>(OPENSPEC_AUTO_DELIVER_VIEW_MODES);
const PROMPT_ID_VALUES = new Set<string>([
  OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_PROMPT_ID,
  OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_PROMPT_ID,
]);
const VERDICT_VALUES = new Set<string>(OPENSPEC_AUTO_DELIVER_VERDICTS);
const MODULE_VALUES = new Set<string>(OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS);
const PROVENANCE_VALUES = new Set<string>(OPENSPEC_AUTO_DELIVER_EVIDENCE_PROVENANCE);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeStatus(value: unknown): string | null {
  const status = nonEmptyString(value);
  return status && STAGE_VALUES.has(status) ? status : null;
}

function normalizeStage(value: unknown): string | null {
  const stage = nonEmptyString(value);
  return stage && STAGE_VALUES.has(stage) ? stage : null;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return nonEmptyString(record[key]);
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  return finiteNumber(record[key]);
}

function normalizeCounterPair(value: unknown): { current: number; total: number } | undefined {
  if (!isRecord(value)) return undefined;
  const current = finiteNumber(value.current);
  const total = finiteNumber(value.total);
  if (current === undefined || total === undefined) return undefined;
  return { current, total };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value
    .map((item) => nonEmptyString(item))
    .filter((item): item is string => !!item);
  return output.length > 0 ? output : undefined;
}

function normalizeTaskStats(value: unknown): OpenSpecAutoDeliverTaskStats | undefined {
  if (!isRecord(value)) return undefined;
  const total = finiteNumber(value.total);
  const checked = finiteNumber(value.checked);
  const unchecked = finiteNumber(value.unchecked);
  if (total === undefined || checked === undefined || unchecked === undefined) return undefined;
  const stats: OpenSpecAutoDeliverTaskStats = { total, checked, unchecked };
  const uncheckedLabels = normalizeStringArray(value.uncheckedLabels);
  if (uncheckedLabels) stats.uncheckedLabels = uncheckedLabels;
  if (Array.isArray(value.items)) {
    const items = value.items
      .filter(isRecord)
      .map((item) => {
        const checkedValue = booleanValue(item.checked);
        const label = nonEmptyString(item.label);
        if (checkedValue === undefined || !label) return null;
        const line = finiteNumber(item.line);
        return {
          ...(line !== undefined ? { line } : {}),
          checked: checkedValue,
          label,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    if (items.length > 0) stats.items = items;
  }
  return stats;
}

function normalizeMaterializedLimits(value: unknown): NonNullable<Extract<OpenSpecAutoDeliverProjection, { visibility: 'full' }>['materializedLimits']> | undefined {
  if (!isRecord(value)) return undefined;
  const limits: Partial<NonNullable<Extract<OpenSpecAutoDeliverProjection, { visibility: 'full' }>['materializedLimits']>> = {};
  for (const key of ['specAuditRepairRounds', 'implementationAuditRepairRounds', 'maxImplementationPrompts', 'maxElapsedMinutes'] as const) {
    const numberValue = finiteNumber(value[key]);
    if (numberValue !== undefined) limits[key] = numberValue;
  }
  return Object.keys(limits).length > 0
    ? limits as NonNullable<Extract<OpenSpecAutoDeliverProjection, { visibility: 'full' }>['materializedLimits']>
    : undefined;
}

function normalizeModuleScores(value: unknown): OpenSpecAutoDeliverModuleScore[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value
    .filter(isRecord)
    .map((item) => {
      const module = nonEmptyString(item.module);
      const score = finiteNumber(item.score);
      if (!module || !MODULE_VALUES.has(module) || score === undefined) return null;
      const maxScore = finiteNumber(item.maxScore);
      const max_score = finiteNumber(item.max_score);
      const summary = nonEmptyString(item.summary);
      return {
        module,
        score,
        ...(maxScore !== undefined ? { maxScore } : {}),
        ...(max_score !== undefined ? { max_score } : {}),
        ...(summary ? { summary } : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  return output.length > 0 ? output : undefined;
}

function normalizeEvidence(value: unknown): OpenSpecAutoDeliverEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value
    .filter(isRecord)
    .map((item) => {
      const label = nonEmptyString(item.label);
      const rawProvenance = nonEmptyString(item.provenance);
      const rawSource = nonEmptyString(item.source);
      const provenance = rawProvenance && PROVENANCE_VALUES.has(rawProvenance) ? rawProvenance : undefined;
      const source = rawSource && PROVENANCE_VALUES.has(rawSource) ? rawSource : undefined;
      const summary = nonEmptyString(item.summary);
      if (!label && !summary) return null;
      const command = nonEmptyString(item.command);
      const exitCode = finiteNumber(item.exitCode);
      return {
        ...(label ? { label } : {}),
        ...(provenance ? { provenance } : {}),
        ...(source ? { source } : {}),
        ...(summary ? { summary } : {}),
        ...(command ? { command } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(item.stale === true ? { stale: true } : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  return output.length > 0 ? output : undefined;
}

function normalizeRepairSummaries(value: unknown): OpenSpecAutoDeliverAuditResult['repairSummaries'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value
    .filter(isRecord)
    .map((item) => {
      const reason = nonEmptyString(item.reason);
      if (!reason) return null;
      return {
        files: normalizeStringArray(item.files) ?? [],
        reason,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  return output.length > 0 ? output : undefined;
}

function normalizeAuditResults(value: unknown): OpenSpecAutoDeliverAuditResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value
    .filter(isRecord)
    .map((item) => {
      const stage = normalizeStage(item.stage);
      const roundIndex = nonNegativeInteger(item.roundIndex);
      const attemptId = nonEmptyString(item.attemptId);
      const generation = nonNegativeInteger(item.generation);
      const verdict = normalizeVerdict(item.verdict);
      const moduleScores = normalizeModuleScores(item.moduleScores);
      const completedAt = nonNegativeInteger(item.completedAt);
      if (!stage || roundIndex === undefined || !attemptId || generation === undefined || !verdict || !moduleScores || completedAt === undefined) {
        return null;
      }
      return {
        stage: stage as OpenSpecAutoDeliverAuditResult['stage'],
        roundIndex,
        attemptId,
        generation,
        ...(optionalString(item, 'discussionFilePath') ? { discussionFilePath: optionalString(item, 'discussionFilePath') } : {}),
        verdict: verdict as OpenSpecAutoDeliverAuditResult['verdict'],
        moduleScores: moduleScores.map((score) => ({
          module: score.module as OpenSpecAutoDeliverAuditResult['moduleScores'][number]['module'],
          score: score.score,
          max_score: 10 as const,
          summary: score.summary ?? '',
        })),
        uncheckedTasks: normalizeStringArray(item.uncheckedTasks) ?? [],
        requiredChanges: normalizeStringArray(item.requiredChanges) ?? [],
        repairSummaries: normalizeRepairSummaries(item.repairSummaries) ?? [],
        evidence: normalizeEvidence(item.evidence)?.map((entry) => ({
          source: (entry.source ?? entry.provenance ?? 'audit_reported') as OpenSpecAutoDeliverAuditResult['evidence'][number]['source'],
          summary: entry.summary ?? entry.label ?? '',
          ...(entry.command ? { command: entry.command } : {}),
          ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
          ...(entry.stale ? { stale: true } : {}),
        })) ?? [],
        completedAt,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  return output.length > 0 ? output : undefined;
}

function normalizeScoreSnapshot(value: unknown): OpenSpecAutoDeliverBrowserScoreSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const phase = nonEmptyString(value.phase);
  const stage = normalizeStage(value.stage);
  const roundIndex = nonNegativeInteger(value.roundIndex);
  const attemptId = nonEmptyString(value.attemptId);
  const generation = nonNegativeInteger(value.generation);
  const verdict = normalizeVerdict(value.verdict);
  const moduleScores = normalizeModuleScores(value.moduleScores);
  const summary = nonEmptyString(value.summary);
  const completedAt = nonNegativeInteger(value.completedAt);
  if (
    (phase !== 'audit_before_repair' && phase !== 'final_after_repair')
    || stage !== 'implementation_audit_repair'
    || roundIndex === undefined
    || !attemptId
    || generation === undefined
    || !verdict
    || !moduleScores
    || !summary
    || completedAt === undefined
  ) {
    return undefined;
  }
  return {
    phase,
    stage,
    roundIndex,
    attemptId,
    generation,
    verdict,
    moduleScores,
    summary,
    completedAt,
  };
}

function normalizePresetId(value: unknown): OpenSpecAutoDeliverPresetId | undefined {
  const presetId = nonEmptyString(value);
  return presetId && PRESET_VALUES.has(presetId) ? presetId as OpenSpecAutoDeliverPresetId : undefined;
}

function normalizePromptId(value: unknown): string | undefined {
  const promptId = nonEmptyString(value);
  return promptId && PROMPT_ID_VALUES.has(promptId) ? promptId : undefined;
}

function normalizeVerdict(value: unknown): string | undefined {
  const verdict = nonEmptyString(value);
  return verdict && VERDICT_VALUES.has(verdict) ? verdict : undefined;
}

function normalizeViewMode(value: unknown): OpenSpecAutoDeliverListRow['viewMode'] | undefined {
  const viewMode = nonEmptyString(value);
  return viewMode && VIEW_MODE_VALUES.has(viewMode)
    ? viewMode as OpenSpecAutoDeliverListRow['viewMode']
    : undefined;
}

export function normalizeOpenSpecAutoDeliverProjection(raw: unknown): OpenSpecAutoDeliverProjection | null {
  if (!isRecord(raw)) return null;
  const visibility = nonEmptyString(raw.visibility);
  if (!visibility || !PROJECTION_VISIBILITY_VALUES.has(visibility)) return null;
  const projectionVersion = nonNegativeInteger(raw.projectionVersion);
  const runId = nonEmptyString(raw.runId);
  const status = normalizeStatus(raw.status);
  const stage = normalizeStage(raw.stage);
  if (projectionVersion === undefined || !runId || !status || !stage) return null;

  if (visibility === 'conflict') {
    const owningMainSessionName = nonEmptyString(raw.owningMainSessionName);
    const reason = nonEmptyString(raw.conflictReason) ?? nonEmptyString(raw.reason);
    if (!owningMainSessionName || !reason) return null;
    return {
      visibility: 'conflict',
      projectionVersion,
      runId,
      owningMainSessionName,
      status,
      stage,
      busy: true,
      reason,
      conflictReason: reason,
      canStop: false,
    };
  }

  const changeName = nonEmptyString(raw.changeName);
  if (!changeName) return null;
  const projection: Record<string, unknown> = {
    visibility: 'full',
    projectionVersion,
    runId,
    changeName,
    status,
    stage,
  };

  const generation = nonNegativeInteger(raw.generation);
  if (generation !== undefined) projection.generation = generation;
  for (const key of [
    'owningMainSessionName',
    'launchedFromSessionName',
    'targetImplementationSessionName',
    'resumeStage',
    'activeP2pRunId',
    'selectedTeamComboId',
    'latestRepairSummary',
    'recentFinding',
    'terminalReason',
    'updatedAt',
  ]) {
    const value = optionalString(raw, key);
    if (value !== undefined) projection[key] = value;
  }
  const presetId = normalizePresetId(raw.presetId);
  if (presetId) projection.presetId = presetId;
  const activeOpenSpecPromptId = normalizePromptId(raw.activeOpenSpecPromptId);
  if (activeOpenSpecPromptId) projection.activeOpenSpecPromptId = activeOpenSpecPromptId;
  const latestVerdict = normalizeVerdict(raw.latestVerdict);
  if (latestVerdict) projection.latestVerdict = latestVerdict;
  if (!projection.recentFinding) {
    const lastMessage = optionalString(raw, 'lastMessage');
    if (lastMessage) projection.recentFinding = lastMessage;
  }
  for (const key of ['startedAt', 'elapsedMs', 'specAuditRepairRound', 'implementationAuditRepairRound', 'implementationPromptCount']) {
    const value = optionalNumber(raw, key);
    if (value !== undefined) projection[key] = value;
  }
  for (const key of ['canStop', 'canContinue', 'canDismiss', 'terminal']) {
    const value = booleanValue(raw[key]);
    if (value !== undefined) projection[key] = value;
  }

  const materializedLimits = normalizeMaterializedLimits(raw.materializedLimits);
  if (materializedLimits) projection.materializedLimits = materializedLimits;
  const taskStats = normalizeTaskStats(raw.taskStats);
  if (taskStats) projection.taskStats = taskStats;
  const specAuditRound = normalizeCounterPair(raw.specAuditRound);
  if (specAuditRound) projection.specAuditRound = specAuditRound;
  const implementationAuditRound = normalizeCounterPair(raw.implementationAuditRound);
  if (implementationAuditRound) projection.implementationAuditRound = implementationAuditRound;
  const moduleScores = normalizeModuleScores(raw.moduleScores);
  if (moduleScores) projection.moduleScores = moduleScores;
  const auditBeforeRepair = normalizeScoreSnapshot(raw.auditBeforeRepair);
  if (auditBeforeRepair) projection.auditBeforeRepair = auditBeforeRepair;
  const finalAfterRepair = normalizeScoreSnapshot(raw.finalAfterRepair);
  if (finalAfterRepair) projection.finalAfterRepair = finalAfterRepair;
  const auditResults = normalizeAuditResults(raw.auditResults);
  if (auditResults) projection.auditResults = auditResults;
  const evidence = normalizeEvidence(raw.evidence);
  if (evidence) projection.evidence = evidence;
  const validationEvidenceProvenance = normalizeStringArray(raw.validationEvidenceProvenance);
  if (validationEvidenceProvenance) projection.validationEvidenceProvenance = validationEvidenceProvenance;

  return projection as unknown as OpenSpecAutoDeliverProjection;
}

export function normalizeOpenSpecAutoDeliverListRow(raw: unknown): OpenSpecAutoDeliverListRow | null {
  if (!isRecord(raw)) return null;
  const visibility = nonEmptyString(raw.visibility);
  if (!visibility || !PROJECTION_VISIBILITY_VALUES.has(visibility)) return null;
  const projectionVersion = nonNegativeInteger(raw.projectionVersion);
  const runId = nonEmptyString(raw.runId);
  const owningMainSessionName = nonEmptyString(raw.owningMainSessionName);
  const status = normalizeStatus(raw.status);
  const stage = normalizeStage(raw.stage);
  if (projectionVersion === undefined || !runId || !owningMainSessionName || !status || !stage) return null;

  const row: OpenSpecAutoDeliverListRow = {
    projectionVersion,
    visibility: visibility as OpenSpecAutoDeliverListRow['visibility'],
    runId,
    owningMainSessionName,
    status,
    stage,
  };
  const generation = nonNegativeInteger(raw.generation);
  if (generation !== undefined) row.generation = generation;
  const viewMode = normalizeViewMode(raw.viewMode);
  if (viewMode) row.viewMode = viewMode;

  if (visibility === 'conflict') {
    const reason = nonEmptyString(raw.reason) ?? nonEmptyString(raw.conflictReason);
    if (!reason) return null;
    row.reason = reason;
    row.viewMode = 'conflict';
    return row;
  }

  const changeName = optionalString(raw, 'changeName');
  if (!changeName) return null;
  row.changeName = changeName;
  const presetId = normalizePresetId(raw.presetId);
  if (presetId) row.presetId = presetId;
  for (const key of ['selectedTeamComboId', 'targetImplementationSessionName', 'launchedFromSessionName', 'terminalReason'] as const) {
    const value = optionalString(raw, key);
    if (value) row[key] = value;
  }
  const recentFinding = optionalString(raw, 'recentFinding') ?? optionalString(raw, 'lastMessage');
  if (recentFinding) row.recentFinding = recentFinding;
  const elapsedMs = finiteNumber(raw.elapsedMs);
  if (elapsedMs !== undefined && elapsedMs >= 0) row.elapsedMs = elapsedMs;
  return row;
}

export function openSpecAutoDeliverRowFromProjection(projection: OpenSpecAutoDeliverProjection): OpenSpecAutoDeliverListRow {
  const status = normalizeStatus(projection.status);
  const stage = normalizeStage(projection.stage);
  if (!status || !stage) {
    throw new Error('invalid_openspec_auto_deliver_projection_row');
  }
  const base: OpenSpecAutoDeliverListRow = {
    projectionVersion: projection.projectionVersion,
    visibility: projection.visibility,
    runId: projection.runId,
    owningMainSessionName: projection.owningMainSessionName ?? '',
    status,
    stage,
    viewMode: projection.visibility === 'conflict'
      ? 'conflict'
      : projection.terminal ? 'compactRecovery' : 'fullRunbar',
  };
  if (projection.visibility === 'conflict') {
    return {
      ...base,
      reason: projection.conflictReason,
      viewMode: 'conflict',
    };
  }
  return {
    ...base,
    ...(typeof projection.generation === 'number' && Number.isFinite(projection.generation) ? { generation: projection.generation } : {}),
    changeName: projection.changeName,
    presetId: normalizePresetId(projection.presetId),
    selectedTeamComboId: projection.selectedTeamComboId ?? undefined,
    targetImplementationSessionName: projection.targetImplementationSessionName,
    launchedFromSessionName: projection.launchedFromSessionName,
    elapsedMs: projection.elapsedMs,
    terminalReason: projection.terminalReason ?? undefined,
    recentFinding: projection.recentFinding ?? undefined,
  };
}
