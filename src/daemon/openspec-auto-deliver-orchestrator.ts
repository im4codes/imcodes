import { lstat, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { P2P_TERMINAL_RUN_STATUSES } from '../../shared/p2p-status.js';
import { getSession } from '../store/session-store.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import type { ServerLink } from './server-link.js';
import { timelineEmitter } from './timeline-emitter.js';
import {
  activeOpenSpecPromptIdForAutoDeliverStage,
  evaluateOpenSpecAutoDeliverComboCompatibility,
} from '../../shared/openspec-auto-deliver-combos.js';
import {
  OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
  OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_METADATA_FIELDS,
  OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_RESULT_FIELDS,
  OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_ELAPSED_MINUTES,
  OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS,
  OPENSPEC_AUTO_DELIVER_MAX_IMPLEMENTATION_MARKER_REMINDERS,
  OPENSPEC_AUTO_DELIVER_EVIDENCE_OPTIONAL_FIELDS,
  OPENSPEC_AUTO_DELIVER_EVIDENCE_REQUIRED_FIELDS,
  OPENSPEC_AUTO_DELIVER_MIN_ACCEPTABLE_MODULE_SCORE,
  OPENSPEC_AUTO_DELIVER_MSG,
  OPENSPEC_AUTO_DELIVER_MODULE_SCORE_FIELDS,
  OPENSPEC_AUTO_DELIVER_REPAIR_SUMMARY_FIELDS,
  OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS,
  OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_ROUNDS_MAX,
  OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_ROUNDS_MAX,
  OPENSPEC_AUTO_DELIVER_TERMINAL_REASONS,
  OPENSPEC_AUTO_DELIVER_VERDICTS,
  isOpenSpecAutoDeliverTerminalStage,
  materializeOpenSpecAutoDeliverPreset,
  type OpenSpecAutoDeliverPresetId,
  type OpenSpecAutoDeliverStagePromptId,
  type OpenSpecAutoDeliverStage,
  type OpenSpecAutoDeliverVerdict,
} from '../../shared/openspec-auto-deliver-constants.js';
import type {
  OpenSpecAutoDeliverEvidence,
  OpenSpecAutoDeliverAuditResult,
  OpenSpecAutoDeliverContinueRequest,
  OpenSpecAutoDeliverLaunchRequest,
  OpenSpecAutoDeliverModuleScore,
  OpenSpecAutoDeliverRepairSummary,
  OpenSpecAutoDeliverP2pMetadata,
  OpenSpecAutoDeliverProjection,
  OpenSpecAutoDeliverScoreSnapshot,
  OpenSpecAutoDeliverStatusRequest,
  OpenSpecAutoDeliverStopRequest,
  OpenSpecAutoDeliverTaskStats,
  OpenSpecAutoDeliverVerdictPayload,
} from '../../shared/openspec-auto-deliver-types.js';
import {
  buildOpenSpecAutoDeliverValidationRecommendations,
} from '../../shared/openspec-auto-deliver-validation-recommendations.js';
import {
  parseOpenSpecTasksMarkdown,
  validateOpenSpecAutoDeliverChangeSlug,
  validateOpenSpecAutoDeliverLaunchRequest,
  validateOpenSpecAutoDeliverRequestId,
  validateOpenSpecAutoDeliverVerdictPayload,
  parseOpenSpecAutoDeliverAuthoritativeJsonPayload,
} from '../../shared/openspec-auto-deliver-validators.js';
import { formatOpenSpecAuditStandardTemplate, formatOpenSpecPromptTemplate } from '../../shared/openspec-prompt-templates.js';
import {
  buildP2pExecutionMarker,
  isPostSummaryExecutionGateFailure,
  stringifyP2pExecutionMarker,
  validateP2pExecutionMarkerContent,
  type P2pExecutionMarker,
  type P2pExecutionMarkerSpec,
  type P2pExecutionMarkerValidation,
} from '../../shared/p2p-execution-marker.js';
import {
  hasActiveP2pRunForMainSession,
  registerAutoDeliverP2pLock,
  releaseAutoDeliverP2pLock,
} from './p2p-launch-admission.js';
import {
  cancelP2pRun,
  getP2pRun,
  listP2pRuns,
  startP2pRun,
  type P2pRun,
} from './p2p-orchestrator.js';
import { resolveConfiguredP2pTargets } from './p2p-target-selection.js';

type AutoDeliverRunStatus = Extract<OpenSpecAutoDeliverStage,
  'proposed' | 'spec_audit_repair' | 'implementation_task_loop' | 'implementation_audit_repair' | 'commit_push' | 'passed' | 'needs_human' | 'failed' | 'stopped'>;

type AuditRepairStage = Extract<OpenSpecAutoDeliverStage, 'spec_audit_repair' | 'implementation_audit_repair'>;
export type OpenSpecAutoDeliverTransitionEvent =
  | 'launch'
  | 'spec_audit_started'
  | 'spec_audit_pass'
  | 'spec_audit_rework'
  | 'spec_audit_blocked'
  | 'implementation_prompt_dispatched'
  | 'implementation_idle_incomplete'
  | 'implementation_idle_all_checked'
  | 'implementation_audit_started'
  | 'implementation_audit_pass'
  | 'implementation_audit_rework'
  | 'implementation_audit_blocked'
  | 'auto_commit_push_dispatched'
  | 'stop'
  | 'restart_cleanup'
  | 'runtime_error';

const OPENSPEC_AUTO_DELIVER_TRANSITIONS: Record<OpenSpecAutoDeliverStage, Partial<Record<OpenSpecAutoDeliverTransitionEvent, OpenSpecAutoDeliverStage>>> = {
  proposed: {
    launch: 'proposed',
    spec_audit_started: 'spec_audit_repair',
    implementation_prompt_dispatched: 'implementation_task_loop',
    stop: 'stopped',
    restart_cleanup: 'failed',
    runtime_error: 'failed',
  },
  spec_audit_repair: {
    spec_audit_started: 'spec_audit_repair',
    spec_audit_pass: 'implementation_task_loop',
    spec_audit_rework: 'spec_audit_repair',
    spec_audit_blocked: 'needs_human',
    implementation_prompt_dispatched: 'implementation_task_loop',
    stop: 'stopped',
    restart_cleanup: 'failed',
    runtime_error: 'failed',
  },
  implementation_task_loop: {
    implementation_prompt_dispatched: 'implementation_task_loop',
    implementation_idle_incomplete: 'implementation_task_loop',
    implementation_idle_all_checked: 'implementation_audit_repair',
    implementation_audit_started: 'implementation_audit_repair',
    stop: 'stopped',
    restart_cleanup: 'failed',
    runtime_error: 'failed',
  },
  implementation_audit_repair: {
    implementation_prompt_dispatched: 'implementation_task_loop',
    implementation_audit_started: 'implementation_audit_repair',
    implementation_audit_pass: 'passed',
    implementation_audit_rework: 'implementation_audit_repair',
    implementation_audit_blocked: 'needs_human',
    auto_commit_push_dispatched: 'commit_push',
    stop: 'stopped',
    restart_cleanup: 'failed',
    runtime_error: 'failed',
  },
  commit_push: {
    stop: 'stopped',
    restart_cleanup: 'failed',
    runtime_error: 'failed',
  },
  stopping: {
    stop: 'stopped',
    restart_cleanup: 'failed',
  },
  passed: {},
  needs_human: {},
  failed: {},
  stopped: {},
};

export function getOpenSpecAutoDeliverTransitionTarget(
  stage: OpenSpecAutoDeliverStage,
  event: OpenSpecAutoDeliverTransitionEvent,
): OpenSpecAutoDeliverStage | null {
  return OPENSPEC_AUTO_DELIVER_TRANSITIONS[stage]?.[event] ?? null;
}

function transitionAllowed(run: AutoDeliverRun, event: OpenSpecAutoDeliverTransitionEvent): boolean {
  return getOpenSpecAutoDeliverTransitionTarget(run.stage, event) !== null;
}

interface AutoDeliverRun {
  runId: string;
  changeName: string;
  projectRoot: string;
  changeRoot: string;
  changeRootIdentity: string;
  owningMainSessionName: string;
  launchedFromSessionName: string;
  targetImplementationSessionName: string;
  presetId: OpenSpecAutoDeliverPresetId;
  selectedTeamComboId: string;
  locale?: string;
  autoCommitPush: boolean;
  materializedLimits: OpenSpecAutoDeliverProjection['materializedLimits'];
  status: AutoDeliverRunStatus;
  stage: OpenSpecAutoDeliverStage;
  generation: number;
  projectionVersion: number;
  startedAt: number;
  updatedAt: number;
  implementationPromptCount: number;
  specAuditRepairRound: number;
  implementationAuditRepairRound: number;
  taskStats: OpenSpecAutoDeliverTaskStats;
  terminalReason?: string;
  resumeStage?: OpenSpecAutoDeliverStage;
  latestMessage?: string;
  activeCommandId?: string;
  activeImplementationMarker?: {
    markerPath: string;
    spec: P2pExecutionMarkerSpec;
    retryCount: number;
    /** Unchecked-task count at the previous reminder; lets the reminder loop
     *  reset retryCount when the implementation makes progress between idles. */
    lastUncheckedCount?: number;
    /** Epoch ms of the last reminder actually sent; used to throttle the rate. */
    lastReminderAt?: number;
  };
  activeAudit?: {
    p2pRunId: string;
    selectedTeamComboId: string;
    activeOpenSpecPromptId: OpenSpecAutoDeliverStagePromptId;
    stage: AuditRepairStage;
    attemptId: string;
    authoritativeResultPath: string;
    resultFileRepairAttempted?: boolean;
    roundIndex: number;
    generation: number;
  };
  activeAcceptanceAudit?: {
    selectedTeamComboId: string;
    activeOpenSpecPromptId: OpenSpecAutoDeliverStagePromptId;
    stage: AuditRepairStage;
    attemptId: string;
    authoritativeResultPath: string;
    resultFileRepairAttempted?: boolean;
    roundIndex: number;
    generation: number;
  };
  latestVerdict?: OpenSpecAutoDeliverVerdict;
  moduleScores?: OpenSpecAutoDeliverModuleScore[];
  auditBeforeRepair?: OpenSpecAutoDeliverScoreSnapshot;
  finalAfterRepair?: OpenSpecAutoDeliverScoreSnapshot;
  auditResults?: OpenSpecAutoDeliverAuditResult[];
  specAuditDiscussionFilePath?: string;
  implementationAuditDiscussionFilePath?: string;
  needsPostRepairAcceptanceAudit?: boolean;
  postRepairAcceptanceStage?: AuditRepairStage;
  lastImplementationRepairPromptKey?: string;
  latestRepairSummary?: string;
  lastAuditResultError?: string;
  evidence?: OpenSpecAutoDeliverEvidence[];
  baselineProductChangedFiles?: string[];
  baselineProductFileFingerprints?: Record<string, string>;
  productBaselineUnavailableReason?: string;
  autoCommitPushBaselineHead?: string;
  autoCommitPushBaselineAhead?: number;
  autoCommitPushCandidateFiles?: string[];
  requestIds: Map<string, OpenSpecAutoDeliverProjection>;
  serverLink: ServerLink;
}

type LaunchResult =
  | { ok: true; projection: OpenSpecAutoDeliverProjection }
  | { ok: false; error: string; projection?: OpenSpecAutoDeliverProjection };

const runsById = new Map<string, AutoDeliverRun>();
const activeRunByOwner = new Map<string, string>();
const terminalRunByOwner = new Map<string, AutoDeliverRun>();
const requestProjectionByFingerprint = new Map<string, OpenSpecAutoDeliverProjection>();
const auditPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const auditFixRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const implementationReminderTimers = new Map<string, ReturnType<typeof setTimeout>>();
let timelineUnsubscribe: (() => void) | null = null;
const execFileAsync = promisify(execFile);
const OPENSPEC_AUTO_DELIVER_AUDIT_FIX_RETRY_WAIT_MS = process.env.NODE_ENV === 'test' ? 50 : 15_000;
// Minimum spacing between implementation "marker missing" reminders. Unless the
// implementation just made task progress, a reminder is throttled to at least
// this interval so a fast-flapping idle cannot spam the agent.
const OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_REMINDER_MIN_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 40 : 30_000;
// A transport runtime can be briefly absent while a session reconnects or its SDK
// transport is restored (e.g. a relaunch) — it comes back on its own. Wait this
// long for it to reappear before treating it as genuinely gone, so a healthy
// in-flight delivery is not hard-failed on a momentary miss.
const OPENSPEC_AUTO_DELIVER_TRANSPORT_RUNTIME_WAIT_MS = process.env.NODE_ENV === 'test' ? 200 : 15_000;

async function awaitTransportRuntime(sessionName: string): Promise<ReturnType<typeof getTransportRuntime>> {
  let runtime = getTransportRuntime(sessionName);
  if (runtime) return runtime;
  const deadline = Date.now() + OPENSPEC_AUTO_DELIVER_TRANSPORT_RUNTIME_WAIT_MS;
  while (!runtime && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    runtime = getTransportRuntime(sessionName);
  }
  return runtime;
}
const OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_FOLLOWUP_REPAIR_REASON = 'implementation_audit_followup_repair';

export interface OpenSpecAutoDeliverUpgradeBlockReason {
  runId: string;
  changeName: string;
  status: OpenSpecAutoDeliverStage;
  stage: OpenSpecAutoDeliverStage;
  owningMainSessionName: string;
  launchedFromSessionName: string;
  targetImplementationSessionName: string;
}

function clearAuditPollTimer(runId: string): void {
  const timer = auditPollTimers.get(runId);
  if (timer) clearTimeout(timer);
  auditPollTimers.delete(runId);
}

function clearAuditFixRetryTimer(runId: string): void {
  const timer = auditFixRetryTimers.get(runId);
  if (timer) clearTimeout(timer);
  auditFixRetryTimers.delete(runId);
}

function clearImplementationReminderTimer(runId: string): void {
  const timer = implementationReminderTimers.get(runId);
  if (timer) clearTimeout(timer);
  implementationReminderTimers.delete(runId);
}

function cloneTaskStats(stats: OpenSpecAutoDeliverTaskStats): OpenSpecAutoDeliverTaskStats {
  return {
    total: stats.total,
    checked: stats.checked,
    unchecked: stats.unchecked,
    items: stats.items.map((item) => ({ ...item })),
  };
}

export function resolveOpenSpecAutoDeliverOwningMainSession(sessionName: string): string {
  const record = getSession(sessionName);
  if (record?.parentSession) return resolveOpenSpecAutoDeliverOwningMainSession(record.parentSession);
  if (sessionName.startsWith('deck_sub_')) return record?.parentSession ?? sessionName;
  return sessionName;
}

function send(serverLink: ServerLink, message: Record<string, unknown>): void {
  try { serverLink.send(message); } catch { /* connection may be closing */ }
}

function broadcastProjection(run: AutoDeliverRun, type = OPENSPEC_AUTO_DELIVER_MSG.PROJECTION): OpenSpecAutoDeliverProjection {
  const projection = bumpProjection(run);
  send(run.serverLink, { type, projection });
  return projection;
}

function humanInterventionSession(run: AutoDeliverRun): string {
  return run.targetImplementationSessionName || run.launchedFromSessionName || run.owningMainSessionName;
}

function humanInterventionMessage(run: AutoDeliverRun, reason: string): string {
  return [
    `OpenSpec Auto Deliver needs human input for openspec/changes/${run.changeName}.`,
    '',
    `Run: ${run.runId}`,
    `Status: needs_human`,
    `Reason: ${reason}`,
    `Owning session: ${run.owningMainSessionName}`,
    `Implementation session: ${run.targetImplementationSessionName}`,
    '',
    'Reply in this session with the next instruction. If this is a recoverable audit-fix gate, the daemon may automatically add one audit-fix round after the displayed wait unless you stop the run.',
  ].join('\n');
}

function emitHumanInterventionPrompt(run: AutoDeliverRun, reason: string, options: {
  recoverable?: boolean;
  waitMs?: number;
  eventSuffix?: string;
} = {}): void {
  const sessionName = humanInterventionSession(run);
  const message = humanInterventionMessage(run, reason);
  const eventBase = `openspec-auto:${run.runId}:${options.eventSuffix ?? 'needs-human'}:${run.generation}`;
  timelineEmitter.emit(sessionName, 'assistant.text', {
    text: message,
    streaming: false,
    assistantKind: 'notification',
  }, {
    source: 'daemon',
    confidence: 'high',
    eventId: `${eventBase}:message`,
  });
  timelineEmitter.emit(sessionName, 'ask.question', {
    toolUseId: `${run.runId}:needs-human:${run.generation}`,
    message,
    waitMs: options.waitMs ?? 5 * 60_000,
    questions: [{
      header: 'OpenSpec Auto Deliver',
      question: options.recoverable
        ? `Auto Deliver reached recoverable gate "${reason}". What should happen next in this session?`
        : `Auto Deliver stopped with reason "${reason}". What should happen next in this session?`,
      options: options.recoverable
        ? [
            {
              label: 'Let Auto Deliver add one audit-fix round',
              description: 'Do nothing; if there is no answer before the timer, the daemon starts one more audit-fix round.',
            },
            {
              label: 'Stop and review manually',
              description: 'Send a stop or follow-up instruction before the timer expires.',
            },
          ]
        : [
            {
              label: 'Review the failure and continue manually',
              description: 'Send an instruction to inspect the stopped run, fix the issue, and report back.',
            },
            {
              label: 'Stop here and summarize the current state',
              description: 'Ask the agent to stop active work and provide a concise handoff.',
            },
          ],
    }],
  }, {
    source: 'daemon',
    confidence: 'high',
    eventId: `${eventBase}:ask`,
  });
}

function mergeEvidence(
  existing: OpenSpecAutoDeliverEvidence[] | undefined,
  incoming: OpenSpecAutoDeliverEvidence[],
  options: { staleExisting?: boolean } = {},
): OpenSpecAutoDeliverEvidence[] {
  const seen = new Set<string>();
  const output: OpenSpecAutoDeliverEvidence[] = [];
  const push = (entry: OpenSpecAutoDeliverEvidence) => {
    const normalized: OpenSpecAutoDeliverEvidence = {
      ...entry,
      ...(options.staleExisting && output.length < (existing?.length ?? 0) ? { stale: true } : {}),
    };
    const key = `${normalized.source}\0${normalized.summary}\0${normalized.command ?? ''}\0${normalized.exitCode ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    output.push(normalized);
  };
  for (const entry of existing ?? []) push(entry);
  for (const entry of incoming) push(entry);
  return output.slice(-80);
}

function recordImplementationReportedEvidence(run: AutoDeliverRun, text: string): void {
  const command = run.activeCommandId;
  const summary = text.trim().slice(0, 1000);
  if (!summary) return;
  const retained = command
    ? (run.evidence ?? []).filter((entry) => !(entry.source === 'implementation_reported' && entry.command === command))
    : (run.evidence ?? []);
  run.evidence = mergeEvidence(retained, [{
    source: 'implementation_reported',
    summary,
    ...(command ? { command } : {}),
    stale: false,
  }]);
}

function recordImplementationMarkerEvidence(run: AutoDeliverRun, marker: P2pExecutionMarker): void {
  const details = [
    marker.summary,
    marker.changedFiles?.length ? `changedFiles=${marker.changedFiles.join(',')}` : undefined,
    marker.tests?.length ? `tests=${marker.tests.join(',')}` : undefined,
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  run.evidence = mergeEvidence(run.evidence, [{
    source: 'implementation_reported',
    summary: details.length > 0
      ? `Implementation completion marker accepted: ${details.join('; ')}`
      : 'Implementation completion marker accepted.',
    ...(run.activeCommandId ? { command: run.activeCommandId } : {}),
    stale: false,
  }]);
}

function elapsedLimitExceeded(run: AutoDeliverRun): boolean {
  const maxMinutes = run.materializedLimits.maxElapsedMinutes ?? OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_ELAPSED_MINUTES;
  return Date.now() - run.startedAt > Math.max(1, maxMinutes) * 60_000;
}

function terminalizeAndSend(
  run: AutoDeliverRun,
  status: Extract<AutoDeliverRunStatus, 'passed' | 'needs_human' | 'failed' | 'stopped'>,
  reason: string,
): OpenSpecAutoDeliverProjection {
  const projection = terminalize(run, status, reason);
  send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
  return projection;
}

function enforceElapsedLimit(run: AutoDeliverRun): OpenSpecAutoDeliverProjection | null {
  if (!elapsedLimitExceeded(run)) return null;
  return terminalizeAndSend(run, 'needs_human', 'max_elapsed_time_reached');
}

function completedAuditRoundCount(run: AutoDeliverRun, stage: AuditRepairStage): number {
  const startedCount = auditRoundCount(run, stage);
  const activeInStage = run.activeAudit?.stage === stage ? 1 : 0;
  return Math.max(0, startedCount - activeInStage);
}

function canContinueRun(run: AutoDeliverRun): boolean {
  return isOpenSpecAutoDeliverTerminalStage(run.status) && run.status !== 'passed';
}

function buildProjection(run: AutoDeliverRun): OpenSpecAutoDeliverProjection {
  const specAuditRound = {
    current: completedAuditRoundCount(run, 'spec_audit_repair'),
    total: run.materializedLimits.specAuditRepairRounds,
  };
  const implementationAuditRound = {
    current: completedAuditRoundCount(run, 'implementation_audit_repair'),
    total: run.materializedLimits.implementationAuditRepairRounds,
  };
  return {
    visibility: 'full',
    projectionVersion: run.projectionVersion,
    runId: run.runId,
    changeName: run.changeName,
    presetId: run.presetId,
    materializedLimits: { ...run.materializedLimits },
    status: run.status,
    stage: run.stage,
    resumeStage: run.resumeStage,
    owningMainSessionName: run.owningMainSessionName,
    launchedFromSessionName: run.launchedFromSessionName,
    targetImplementationSessionName: run.targetImplementationSessionName,
    generation: run.generation,
    implementationPromptCount: run.implementationPromptCount,
    elapsedMs: Math.max(0, Date.now() - run.startedAt),
    taskStats: cloneTaskStats(run.taskStats),
    specAuditRepairRound: run.specAuditRepairRound,
    implementationAuditRepairRound: run.implementationAuditRepairRound,
    specAuditRound,
    implementationAuditRound,
    activeP2pRunId: run.activeAudit?.p2pRunId,
    selectedTeamComboId: run.selectedTeamComboId,
    activeOpenSpecPromptId: run.activeAudit?.activeOpenSpecPromptId ?? run.activeAcceptanceAudit?.activeOpenSpecPromptId,
    canStop: !isOpenSpecAutoDeliverTerminalStage(run.status),
    canContinue: canContinueRun(run),
    latestRepairSummary: run.latestRepairSummary,
    latestVerdict: run.latestVerdict,
    moduleScores: run.moduleScores ? run.moduleScores.map((score) => ({ ...score })) : undefined,
    auditBeforeRepair: cloneScoreSnapshot(run.auditBeforeRepair),
    finalAfterRepair: cloneScoreSnapshot(run.finalAfterRepair),
    auditResults: run.auditResults ? run.auditResults.map((result) => ({
      ...result,
      moduleScores: result.moduleScores.map((score) => ({ ...score })),
      uncheckedTasks: [...result.uncheckedTasks],
      requiredChanges: [...result.requiredChanges],
      repairSummaries: result.repairSummaries.map((repair) => ({
        files: [...repair.files],
        reason: repair.reason,
      })),
      evidence: result.evidence.map((entry) => ({ ...entry })),
    })) : undefined,
    evidence: run.evidence ? run.evidence.map((entry) => ({ ...entry })) : undefined,
    lastMessage: run.latestMessage,
    terminalReason: run.terminalReason,
  };
}

function cloneScoreSnapshot(snapshot: OpenSpecAutoDeliverScoreSnapshot | undefined): OpenSpecAutoDeliverScoreSnapshot | undefined {
  if (!snapshot) return undefined;
  return {
    ...snapshot,
    moduleScores: snapshot.moduleScores.map((score) => ({ ...score })),
  };
}

function bumpProjection(run: AutoDeliverRun): OpenSpecAutoDeliverProjection {
  run.projectionVersion += 1;
  run.updatedAt = Date.now();
  const projection = buildProjection(run);
  for (const fingerprint of run.requestIds.keys()) {
    run.requestIds.set(fingerprint, projection);
    requestProjectionByFingerprint.set(fingerprint, projection);
  }
  return projection;
}

function openSpecAutoDeliverLaunchFingerprint(input: {
  requestId: string;
  sessionName: string;
  changeName: string;
  presetId: string;
  selectedTeamComboId: string;
  locale?: string;
  autoCommitPush: boolean;
  materializedLimits: unknown;
}): string {
  return JSON.stringify(input);
}

function forgetRequestProjectionFingerprints(run: AutoDeliverRun): void {
  for (const fingerprint of run.requestIds.keys()) {
    requestProjectionByFingerprint.delete(fingerprint);
  }
  run.requestIds.clear();
}

function effectiveMaxImplementationPrompts(run: AutoDeliverRun): number {
  return run.materializedLimits.maxImplementationPrompts ?? OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS;
}

async function resolveChangeRoot(sessionName: string, changeName: string): Promise<{ ok: true; projectRoot: string; root: string } | { ok: false; error: string }> {
  const record = getSession(sessionName);
  if (!record?.projectDir) return { ok: false, error: 'missing_project_dir' };
  const projectRoot = await realpath(record.projectDir).catch(() => null);
  if (!projectRoot) return { ok: false, error: 'missing_project_dir' };
  const changesRoot = await realpath(join(projectRoot, 'openspec', 'changes')).catch(() => null);
  if (!changesRoot) return { ok: false, error: 'missing_openspec_changes' };
  const candidate = join(changesRoot, changeName);
  const resolved = await realpath(candidate).catch(() => null);
  if (!resolved || !(resolved === changesRoot || resolved.startsWith(`${changesRoot}/`))) {
    return { ok: false, error: 'invalid_change_root' };
  }
  const candidateStat = await stat(resolved).catch(() => null);
  if (!candidateStat?.isDirectory()) return { ok: false, error: 'missing_change_root' };
  const proposalOk = await stat(join(resolved, 'proposal.md')).then((s) => s.isFile()).catch(() => false);
  const tasksOk = await stat(join(resolved, 'tasks.md')).then((s) => s.isFile()).catch(() => false);
  if (!proposalOk || !tasksOk) return { ok: false, error: 'missing_required_artifacts' };
  if (!(await hasOpenSpecDelta(resolved))) return { ok: false, error: 'missing_spec_delta' };
  return { ok: true, projectRoot, root: resolved };
}

async function hasOpenSpecDelta(changeRoot: string): Promise<boolean> {
  const specsRoot = join(changeRoot, 'specs');
  const resolvedSpecsRoot = await realpath(specsRoot).catch(() => null);
  if (!resolvedSpecsRoot || !(resolvedSpecsRoot === changeRoot || resolvedSpecsRoot.startsWith(`${changeRoot}/`))) {
    return false;
  }
  const stack = [specsRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const resolvedCurrent = await realpath(current).catch(() => null);
    if (!resolvedCurrent || !(resolvedCurrent === changeRoot || resolvedCurrent.startsWith(`${changeRoot}/`))) {
      return false;
    }
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === 'spec.md') {
        const resolvedFile = await realpath(fullPath).catch(() => null);
        if (!resolvedFile || !(resolvedFile === changeRoot || resolvedFile.startsWith(`${changeRoot}/`))) {
          return false;
        }
        return true;
      }
    }
  }
  return false;
}

async function readTaskStats(changeRoot: string): Promise<OpenSpecAutoDeliverTaskStats> {
  const raw = await readFile(join(changeRoot, 'tasks.md'), 'utf8');
  return parseOpenSpecTasksMarkdown(raw);
}

async function refreshChangeRoot(run: AutoDeliverRun): Promise<boolean> {
  const resolved = await resolveChangeRoot(run.launchedFromSessionName, run.changeName);
  if (!resolved.ok) {
    run.latestMessage = resolved.error;
    return false;
  }
  if (resolved.projectRoot !== run.projectRoot || resolved.root !== run.changeRootIdentity) {
    run.latestMessage = 'change_root_identity_changed';
    return false;
  }
  run.changeRoot = resolved.root;
  return true;
}

async function readTaskStatsForRun(run: AutoDeliverRun): Promise<OpenSpecAutoDeliverTaskStats> {
  if (!(await refreshChangeRoot(run))) throw new Error(run.latestMessage ?? 'change_root_invalid');
  return readTaskStats(run.changeRoot);
}

async function readProjectFileIfPresent(projectRoot: string, path: string): Promise<{ path: string; content: string } | null> {
  const resolved = await realpath(join(projectRoot, path)).catch(() => null);
  if (!resolved || !(resolved === projectRoot || resolved.startsWith(`${projectRoot}/`))) return null;
  const content = await readFile(resolved, 'utf8').catch(() => null);
  return content == null ? null : { path, content };
}

async function buildValidationEvidence(run: AutoDeliverRun): Promise<OpenSpecAutoDeliverEvidence[]> {
  const files = (await Promise.all([
    readProjectFileIfPresent(run.projectRoot, 'package.json'),
    readProjectFileIfPresent(run.projectRoot, 'package-lock.json'),
    readProjectFileIfPresent(run.projectRoot, 'pnpm-lock.yaml'),
    readProjectFileIfPresent(run.projectRoot, 'yarn.lock'),
    readProjectFileIfPresent(run.projectRoot, 'server/package.json'),
    readProjectFileIfPresent(run.projectRoot, 'web/package.json'),
    readProjectFileIfPresent(run.projectRoot, 'pyproject.toml'),
  ])).filter((entry): entry is { path: string; content: string } => !!entry);
  const recommendations = buildOpenSpecAutoDeliverValidationRecommendations(files);
  const recommended = recommendations.filter((entry) => entry.safety === 'recommended');
  const unsafe = recommendations.filter((entry) => entry.safety === 'unsafe');
  return [
    {
      source: 'daemon',
      summary: recommended.length > 0
        ? `Discovered safe validation command candidates from project manifests: ${recommended.map((entry) => entry.command).join('; ')}. These are hints, not a fixed or exhaustive validation plan.`
        : 'No safe validation command candidates were discovered from project manifests.',
      stale: false,
    },
    ...(unsafe.length > 0
      ? [{
          source: 'daemon' as const,
          summary: `Unsafe validation commands were skipped: ${unsafe.map((entry) => entry.command).join('; ')}.`,
          stale: false,
        }]
      : []),
  ];
}

function uncheckedTaskLabels(stats: OpenSpecAutoDeliverTaskStats): string[] {
  return stats.items.filter((item) => !item.checked).map((item) => item.label);
}

function latestAuditResultForStage(run: AutoDeliverRun, stage: AuditRepairStage): OpenSpecAutoDeliverAuditResult | undefined {
  return [...(run.auditResults ?? [])].reverse().find((result) => result.stage === stage);
}

function bullets(items: string[], limit = 12): string {
  if (items.length === 0) return '- none';
  const visible = items.slice(0, limit).map((item) => `- ${item}`);
  const remaining = items.length - visible.length;
  return remaining > 0 ? [...visible, `- ...and ${remaining} more`].join('\n') : visible.join('\n');
}

/**
 * Concise "must-fix" block shared by the spec AND implementation repair prompts
 * so both stages drive the next repair turn identically. Lists the prior audit's
 * one-line required_changes (each already "file:line — directive") plus a bare
 * `module=score` list — NO evidence dump, no long per-module summaries. The
 * framing ("resolve EACH at the cited file:line; do not rewrite elsewhere and
 * leave these open; the next acceptance audit caps the module at 5") is the same
 * on both stages: this is what stops a repair turn from editing around the
 * flagged items and getting penalized (score drop) on the next acceptance audit.
 * Returns [] when the audit produced no required_changes and no low scores.
 */
function buildPriorAuditMustFixLines(
  audit: OpenSpecAutoDeliverAuditResult | undefined,
  auditNoun: string,
): string[] {
  const mustFix = audit?.requiredChanges ?? [];
  const lowScores = (audit?.moduleScores ?? [])
    .filter((score) => score.score < OPENSPEC_AUTO_DELIVER_MIN_ACCEPTABLE_MODULE_SCORE)
    .map((score) => `${score.module}=${score.score}/10`);
  if (mustFix.length === 0 && lowScores.length === 0) return [];
  return [
    ...(mustFix.length > 0
      ? [
          `Must-fix items flagged by the previous ${auditNoun} — resolve EACH at the cited file:line/heading. Do not rewrite elsewhere and leave these open; the next acceptance audit caps the module at 5 for any unresolved item:`,
          bullets(mustFix),
        ]
      : []),
    ...(lowScores.length > 0 ? [`Modules still below bar: ${lowScores.join(', ')}.`] : []),
  ];
}

const PROMPT_NOISY_EVIDENCE_PREFIXES = [
  'Changed files:',
  'Diff stat:',
  'Fresh changed files:',
  'Fresh diff stat:',
];

function isPromptNoisyEvidenceSummary(summary: string): boolean {
  return PROMPT_NOISY_EVIDENCE_PREFIXES.some((prefix) => summary.startsWith(prefix));
}

function runEvidenceForPrompt(run: AutoDeliverRun): string {
  const entries = (run.evidence ?? []).filter((entry) => !isPromptNoisyEvidenceSummary(entry.summary));
  if (entries.length === 0) return 'Evidence: none.';
  const visible = entries.slice(0, 8).map((entry) => `- ${entry.source}: ${entry.summary}`);
  const remaining = entries.length - visible.length;
  return `Evidence:\n${remaining > 0 ? [...visible, `- ...and ${remaining} more`].join('\n') : visible.join('\n')}`;
}

function validationCommandEvidence(run: AutoDeliverRun): string {
  const validationPrefixes = [
    'Discovered safe validation command candidates',
    'No safe validation command candidates',
    'Unsafe validation commands were skipped',
  ];
  const summaries = [...new Set((run.evidence ?? [])
    .filter((entry) => entry.source === 'daemon' && validationPrefixes.some((prefix) => entry.summary.startsWith(prefix)))
    .map((entry) => entry.summary))];
  return bullets(summaries, 3);
}

function auditGuidanceEvidence(audit: OpenSpecAutoDeliverAuditResult | undefined): string {
  const noisyPrefixes = [
    'Discovered safe validation command candidates',
    'No safe validation command candidates',
    'Unsafe validation commands were skipped',
    'Spec audit discussion completed:',
    'Implementation audit discussion completed:',
    'Dispatching ',
  ];
  const summaries = (audit?.evidence ?? [])
    .map((entry) => entry.summary)
    .filter((summary) => !isPromptNoisyEvidenceSummary(summary))
    .filter((summary) => !noisyPrefixes.some((prefix) => summary.startsWith(prefix)));
  return bullets([...new Set(summaries)], 5);
}

function buildImplementationRepairBlock(run: AutoDeliverRun, repairReason?: string): string | null {
  const audit = latestAuditResultForStage(run, 'implementation_audit_repair');
  const auditDiscussionFilePath = audit?.discussionFilePath ?? run.implementationAuditDiscussionFilePath;
  if (!audit && !repairReason && !auditDiscussionFilePath) return null;
  // Same must-fix checklist + framing as the spec repair prompt (shared helper).
  const mustFixLines = buildPriorAuditMustFixLines(audit, 'implementation audit');
  const requiredFollowupRepair = repairReason === OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_FOLLOWUP_REPAIR_REASON
    ? [
        '',
        'This repair pass is required even when the implementation audit passed and scores are acceptable.',
        'Do a serious final implementation repair pass: read the audit discussion, fix any small gaps or polish issues, tighten tests/tasks where appropriate, run validation, and report exact outcomes.',
        'If no code change is appropriate after inspection, say so explicitly with the validation commands and outcomes.',
      ]
    : [];
  return [
    'Audit findings to repair now:',
    repairReason ? `Reason: ${repairReason}` : undefined,
    audit ? `Previous implementation audit verdict: ${audit.verdict}` : undefined,
    auditDiscussionFilePath ? `Audit discussion file: ${auditDiscussionFilePath}` : undefined,
    ...(mustFixLines.length > 0 ? ['', ...mustFixLines] : []),
    '',
    'Unchecked or falsely-complete tasks reported by the audit:',
    bullets(audit?.uncheckedTasks ?? []),
    '',
    'Concise audit guidance:',
    auditGuidanceEvidence(audit),
    ...requiredFollowupRepair,
    '',
    auditDiscussionFilePath ? 'Before editing, read the audit discussion file above for the full review/plan context; use the discussion findings as the repair source of truth.' : undefined,
    auditDiscussionFilePath ? '' : undefined,
    'Do not write another audit report. Edit the product code, tests, and tasks.md now, then run validation.',
  ].filter((line): line is string => line !== undefined).join('\n');
}

function buildImplementationPrompt(run: AutoDeliverRun, repairReason?: string): string {
  const reference = openSpecChangeReference(run);
  const remaining = uncheckedTaskLabels(run.taskStats);
  const maxImplementationPrompts = effectiveMaxImplementationPrompts(run);
  const basePrompt = repairReason
    ? `OpenSpec Auto Deliver implementation repair for ${reference}.`
    : formatOpenSpecPromptTemplate('implement', reference);
  const validationSummary = validationCommandEvidence(run);
  const remainingBlock = remaining.length > 0
    ? remaining.map((label) => `- ${label}`).join('\n')
    : '- Re-read tasks.md and verify every task remains checked.';
  return [
    basePrompt,
    '',
    `OpenSpec Auto Deliver context for ${reference}.`,
    `Project root: ${run.projectRoot}`,
    `Change root: ${run.changeRootIdentity}`,
    `Run id: ${run.runId}`,
    `Generation: ${run.generation}`,
    `Implementation prompt: ${run.implementationPromptCount}/${maxImplementationPrompts}`,
    '',
    'Implement only this OpenSpec change. Do not commit, push, or stage files. Do not modify unrelated OpenSpec changes or docs.',
    'Before inspecting, editing, validating, or committing anything, work from the project root above. Do not rely on the execution session current directory if it differs.',
    'All relative file paths in this prompt are relative to that project root.',
    'Work through the remaining tasks below. Mark tasks.md checkboxes only after the work is genuinely complete.',
    'Run reasonable local validation for the touched code when available. Treat the validation candidates below as project-specific hints only; choose the actual validation plan from the changed files and project tooling. Report exact commands and outcomes, or explain why validation could not run.',
    '',
    'Remaining tasks:',
    remainingBlock,
    '',
    buildImplementationRepairBlock(run, repairReason) ?? 'No prior implementation-audit findings are pending. Implement the remaining OpenSpec tasks directly.',
    '',
    'Validation candidates:',
    validationSummary,
    '',
    buildImplementationCompletionMarkerBlock(run),
  ].join('\n');
}

function buildImplementationCompletionMarkerBlock(run: AutoDeliverRun): string {
  const active = run.activeImplementationMarker;
  if (!active) return 'Implementation completion marker: unavailable.';
  const completedMarker = stringifyP2pExecutionMarker(buildP2pExecutionMarker(active.spec, 'completed')).trimEnd();
  const failedMarker = stringifyP2pExecutionMarker({
    ...buildP2pExecutionMarker(active.spec, 'failed'),
    error: 'short reason',
  }).trimEnd();
  return [
    'Implementation completion marker (required):',
    `- After you have completed implementation, tasks.md updates, and reasonable validation, write this exact JSON marker to: ${active.markerPath}`,
    '- Keep runId, cycleIndex, cycleTotal, nonce, and status exactly as shown. Do not write the marker before doing the work.',
    '- If you cannot complete the implementation, write the failed marker instead and include a short error field.',
    '- Idling without this marker does not count as implementation completion; Auto Deliver will keep the run in implementation until the marker is present and valid.',
    '',
    'Completed marker:',
    '```json',
    completedMarker,
    '```',
    '',
    'Failed marker:',
    '```json',
    failedMarker,
    '```',
  ].join('\n');
}

function buildSpecRepairPrompt(run: AutoDeliverRun, repairReason: string): string {
  const reference = openSpecChangeReference(run);
  // The previous spec audit (team discussion or acceptance audit) already
  // produced concrete, one-line required_changes plus per-module scores. The
  // earlier repair turn missed these because the prompt only carried a generic
  // reason + "read the discussion file", so the model rewrote elsewhere and left
  // the flagged items open → the next acceptance audit penalized the unresolved
  // findings and the score DROPPED. Inline the SAME concise must-fix checklist
  // the implementation repair path uses (shared helper).
  const previousAudit = latestAuditResultForStage(run, 'spec_audit_repair');
  const mustFixLines = buildPriorAuditMustFixLines(previousAudit, 'spec audit');
  return [
    formatOpenSpecPromptTemplate('audit_spec', reference),
    '',
    `OpenSpec Auto Deliver spec-artifact repair context for ${reference}.`,
    `Project root: ${run.projectRoot}`,
    `Change root: ${run.changeRootIdentity}`,
    `Run id: ${run.runId}`,
    `Generation: ${run.generation}`,
    `Reason: ${repairReason}`,
    previousAudit ? `Previous spec audit verdict: ${previousAudit.verdict}.` : undefined,
    run.specAuditDiscussionFilePath ? `Spec audit discussion file: ${run.specAuditDiscussionFilePath}` : 'Spec audit discussion file: unavailable.',
    ...(mustFixLines.length > 0 ? ['', ...mustFixLines] : []),
    '',
    'Repair only the OpenSpec artifacts under this change: proposal.md, design.md, specs/**/spec.md, and tasks.md.',
    'Read the spec audit discussion file above for full context, but treat the must-fix list as the binding checklist: make the concrete edit for each item and record it in repairs_applied with the file path.',
    'Do not edit product implementation files. Do not write authoritative JSON. Do not assign final module scores in this turn.',
    'After repairing the artifacts, run OpenSpec validation when available and report exact commands/outcomes.',
    'The final spec acceptance score and authoritative JSON will be produced by a separate single-model acceptance audit after this repair turn.',
  ].filter((line): line is string => line !== undefined).join('\n');
}

async function dispatchImplementationPrompt(run: AutoDeliverRun, repairReason?: string): Promise<OpenSpecAutoDeliverProjection> {
  const elapsedProjection = enforceElapsedLimit(run);
  if (elapsedProjection) return elapsedProjection;
  const baselineFailure = await ensureProductBaseline(run);
  if (baselineFailure) return baselineFailure;
  if (!transitionAllowed(run, 'implementation_prompt_dispatched')) {
    return terminalize(run, 'failed', 'invalid_transition_implementation_prompt');
  }
  if (run.implementationPromptCount >= effectiveMaxImplementationPrompts(run)) {
    return terminalize(run, 'needs_human', 'implementation_prompt_limit_reached');
  }
  const runtime = await awaitTransportRuntime(run.targetImplementationSessionName);
  if (!runtime) {
    return terminalize(run, 'failed', 'missing_transport_runtime');
  }
  run.status = 'implementation_task_loop';
  run.stage = 'implementation_task_loop';
  run.implementationPromptCount += 1;
  run.activeCommandId = `${run.runId}:implementation:${run.generation}:${run.implementationPromptCount}`;
  run.activeImplementationMarker = {
    markerPath: await buildImplementationMarkerPath(run, run.generation, run.implementationPromptCount),
    spec: {
      runId: run.runId,
      cycleIndex: run.implementationPromptCount,
      cycleTotal: effectiveMaxImplementationPrompts(run),
      nonce: randomUUID(),
    },
    retryCount: 0,
  };
  const prompt = buildImplementationPrompt(run, repairReason);
  timelineEmitter.emit(run.targetImplementationSessionName, 'user.message', {
    text: prompt,
    allowDuplicate: true,
    commandId: run.activeCommandId,
  }, { source: 'daemon', confidence: 'high', eventId: `openspec-auto:${run.activeCommandId}` });
  try {
    runtime.send(prompt, run.activeCommandId);
  } catch (error) {
    delete run.activeCommandId;
    return terminalize(run, 'failed', error instanceof Error ? `implementation_send_failed:${error.message}` : 'implementation_send_failed');
  }
  run.latestMessage = repairReason
    ? `implementation_repair_prompt_dispatched:${repairReason}`
    : 'implementation_prompt_dispatched';
  return broadcastProjection(run);
}

async function readImplementationCompletionMarker(run: AutoDeliverRun): Promise<P2pExecutionMarkerValidation> {
  const active = run.activeImplementationMarker;
  if (!active) return { ok: false, reason: 'implementation_marker_contract_missing' };
  const content = await readFile(active.markerPath, 'utf8').catch(() => null);
  if (content === null) return { ok: false, reason: 'implementation_marker_missing' };
  return validateP2pExecutionMarkerContent(content, active.spec);
}

function buildImplementationMarkerReminderPrompt(run: AutoDeliverRun, reason: string): string {
  return [
    `OpenSpec Auto Deliver implementation is not complete yet for ${openSpecChangeReference(run)}.`,
    '',
    `Project root: ${run.projectRoot}`,
    `Change root: ${run.changeRootIdentity}`,
    `Run id: ${run.runId}`,
    `Generation: ${run.generation}`,
    `Reason: ${reason}`,
    '',
    'Do not start an audit report. Continue from the current implementation state and finish the required code, test, and tasks.md work.',
    'Run the appropriate validation for the files you touched. If validation fails, fix the failure and validate again.',
    'Write the completed marker only after the implementation is genuinely finished and validated. If you are blocked, write the failed marker with a short reason.',
    'A false idle without this marker is not completion; Auto Deliver will keep the run in implementation.',
    '',
    buildImplementationCompletionMarkerBlock(run),
  ].join('\n');
}

async function dispatchImplementationMarkerReminder(run: AutoDeliverRun, reason: string): Promise<OpenSpecAutoDeliverProjection> {
  const elapsedProjection = enforceElapsedLimit(run);
  if (elapsedProjection) return elapsedProjection;
  const runtime = await awaitTransportRuntime(run.targetImplementationSessionName);
  if (!runtime) return terminalize(run, 'failed', 'missing_transport_runtime');
  if (!run.activeImplementationMarker) {
    return terminalize(run, 'needs_human', `implementation_marker_contract_missing:${reason}`);
  }
  const marker = run.activeImplementationMarker;
  // Bound AND pace the idle -> "marker missing" -> reminder -> idle loop so it
  // cannot re-prompt the agent forever or spam it (previously a reminder fired
  // on every idle, with no count or rate limit; only the hours-long elapsed
  // limit ever stopped it).
  const unchecked = run.taskStats?.unchecked ?? null;
  const progressed = unchecked !== null
    && marker.lastUncheckedCount !== undefined
    && unchecked < marker.lastUncheckedCount;
  // Reset the count whenever the implementation makes task progress between
  // idles, so a genuinely advancing run is never aborted or throttled.
  if (progressed) marker.retryCount = 0;
  if (unchecked !== null) marker.lastUncheckedCount = unchecked;
  // Count cap: escalate to needs_human once the agent stalls without writing
  // the marker for too many consecutive idles, instead of nudging forever.
  if (marker.retryCount >= OPENSPEC_AUTO_DELIVER_MAX_IMPLEMENTATION_MARKER_REMINDERS) {
    clearImplementationReminderTimer(run.runId);
    return terminalize(run, 'needs_human', `implementation_marker_reminders_exhausted:${reason}`);
  }
  // Rate throttle: unless progress was just made, keep at least MIN_INTERVAL
  // between reminders. Defer via a single timer (rather than skipping) so one
  // late idle cannot stall the loop, and dedupe so a burst of idles schedules
  // only one pending reminder.
  if (!progressed) {
    const sinceLast = Date.now() - (marker.lastReminderAt ?? 0);
    if (sinceLast < OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_REMINDER_MIN_INTERVAL_MS) {
      if (!implementationReminderTimers.has(run.runId)) {
        const waitMs = OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_REMINDER_MIN_INTERVAL_MS - sinceLast;
        implementationReminderTimers.set(run.runId, setTimeout(() => {
          implementationReminderTimers.delete(run.runId);
          const current = runsById.get(run.runId);
          if (!current || isOpenSpecAutoDeliverTerminalStage(current.status)) return;
          void advanceAfterImplementationIdle(current).catch((error) => {
            terminalizeAndSend(current, 'failed', error instanceof Error ? error.message : 'implementation_idle_advance_failed');
          });
        }, waitMs));
      }
      return broadcastProjection(run);
    }
  }
  clearImplementationReminderTimer(run.runId);
  marker.retryCount += 1;
  marker.lastReminderAt = Date.now();
  run.activeCommandId = `${run.runId}:implementation-marker:${run.generation}:${run.implementationPromptCount}:${marker.retryCount}`;
  const prompt = buildImplementationMarkerReminderPrompt(run, reason);
  timelineEmitter.emit(run.targetImplementationSessionName, 'user.message', {
    text: prompt,
    allowDuplicate: true,
    commandId: run.activeCommandId,
  }, { source: 'daemon', confidence: 'high', eventId: `openspec-auto:${run.activeCommandId}` });
  try {
    runtime.send(prompt, run.activeCommandId);
  } catch (error) {
    delete run.activeCommandId;
    return terminalize(run, 'failed', error instanceof Error ? `implementation_marker_reminder_send_failed:${error.message}` : 'implementation_marker_reminder_send_failed');
  }
  run.latestMessage = `implementation_marker_missing:${reason}`;
  run.evidence = mergeEvidence(run.evidence, [{
    source: 'daemon',
    summary: `Implementation idle ignored because the completion marker was missing or invalid: ${reason}.`,
    stale: false,
  }]);
  return broadcastProjection(run);
}

function implementationRepairPromptKey(run: AutoDeliverRun, reason: string): string {
  const audit = latestAuditResultForStage(run, 'implementation_audit_repair');
  return audit
    ? `${audit.generation}:${audit.attemptId}:${reason}`
    : `${run.generation}:no-audit:${reason}`;
}

async function dispatchImplementationRepairPrompt(run: AutoDeliverRun, reason: string): Promise<OpenSpecAutoDeliverProjection> {
  run.needsPostRepairAcceptanceAudit = true;
  run.postRepairAcceptanceStage = 'implementation_audit_repair';
  const repairKey = implementationRepairPromptKey(run, reason);
  if (run.lastImplementationRepairPromptKey === repairKey) {
    run.evidence = mergeEvidence(run.evidence, [{
      source: 'daemon',
      summary: `Implementation repair prompt was already dispatched for this audit finding; sending a marker reminder instead: ${reason}.`,
      stale: false,
    }]);
    return dispatchImplementationMarkerReminder(run, `implementation_repair_already_dispatched:${reason}`);
  }
  run.lastImplementationRepairPromptKey = repairKey;
  run.evidence = mergeEvidence(run.evidence, [{
    source: 'daemon',
    summary: `Dispatching implementation repair prompt from audit findings: ${reason}.`,
    stale: false,
  }]);
  return dispatchImplementationPrompt(run, reason);
}

function dispatchSpecRepairPrompt(run: AutoDeliverRun, reason: string): OpenSpecAutoDeliverProjection {
  const elapsedProjection = enforceElapsedLimit(run);
  if (elapsedProjection) return elapsedProjection;
  const runtime = getTransportRuntime(run.targetImplementationSessionName);
  if (!runtime) {
    return terminalize(run, 'failed', 'missing_transport_runtime');
  }
  run.status = 'spec_audit_repair';
  run.stage = 'spec_audit_repair';
  run.needsPostRepairAcceptanceAudit = true;
  run.postRepairAcceptanceStage = 'spec_audit_repair';
  run.activeCommandId = `${run.runId}:spec-repair:${run.generation}:${run.specAuditRepairRound}`;
  run.evidence = mergeEvidence(run.evidence, [{
    source: 'daemon',
    summary: `Dispatching spec artifact repair prompt from audit discussion: ${reason}.`,
    stale: false,
  }]);
  const prompt = buildSpecRepairPrompt(run, reason);
  timelineEmitter.emit(run.targetImplementationSessionName, 'user.message', {
    text: prompt,
    allowDuplicate: true,
    commandId: run.activeCommandId,
  }, { source: 'daemon', confidence: 'high', eventId: `openspec-auto:${run.activeCommandId}` });
  try {
    runtime.send(prompt, run.activeCommandId);
  } catch (error) {
    delete run.activeCommandId;
    return terminalize(run, 'failed', error instanceof Error ? `spec_repair_prompt_send_failed:${error.message}` : 'spec_repair_prompt_send_failed');
  }
  run.latestMessage = `spec_repair_prompt_dispatched:${reason}`;
  return broadcastProjection(run);
}

function acceptanceAuditMetadataFromActive(
  run: AutoDeliverRun,
  active: NonNullable<AutoDeliverRun['activeAcceptanceAudit']>,
): OpenSpecAutoDeliverP2pMetadata {
  return {
    owner: 'openspec_auto_deliver',
    runId: run.runId,
    owningMainSessionName: run.owningMainSessionName,
    executionSessionName: run.targetImplementationSessionName,
    changeName: run.changeName,
    resolvedChangeRootIdentity: run.changeRootIdentity,
    stage: active.stage,
    selectedTeamComboId: active.selectedTeamComboId,
    activeOpenSpecPromptId: active.activeOpenSpecPromptId,
    roundIndex: active.roundIndex,
    attemptId: active.attemptId,
    authoritativeResultPath: active.authoritativeResultPath,
    generation: active.generation,
  };
}

function buildPostRepairAcceptanceAuditPrompt(run: AutoDeliverRun, metadata: OpenSpecAutoDeliverP2pMetadata): string {
  const reference = openSpecChangeReference(run);
  const stage = metadata.stage;
  const specStage = stage === 'spec_audit_repair';
  const previousAudit = latestAuditResultForStage(run, stage);
  const auditDiscussionFilePath = previousAudit?.discussionFilePath ?? (specStage ? run.specAuditDiscussionFilePath : run.implementationAuditDiscussionFilePath);
  const lowScores = (previousAudit?.moduleScores ?? [])
    .filter((score) => score.score < OPENSPEC_AUTO_DELIVER_MIN_ACCEPTABLE_MODULE_SCORE)
    .map((score) => `${score.module}=${score.score}/10 (${score.summary})`);
  const title = specStage
    ? `OpenSpec Auto Deliver final specification acceptance audit for ${reference}.`
    : `OpenSpec Auto Deliver final implementation acceptance audit for ${reference}.`;
  // Audit-standard variant only: this is a scoring pass ("Do not implement
  // fixes in this turn"), so the canonical template's trailing repair
  // directive must not be embedded here.
  const basePrompt = specStage
    ? formatOpenSpecAuditStandardTemplate('audit_spec', reference)
    : formatOpenSpecAuditStandardTemplate('audit_implementation', reference);
  const auditTarget = specStage
    ? 'the repaired OpenSpec artifacts'
    : 'the repaired product code, tests, and tasks.md';
  const passScope = specStage
    ? '- PASS only if the repaired proposal.md, design.md, specs/**/spec.md, and tasks.md are internally consistent, acceptance-ready, and implementation-ready.'
    : '- PASS only if the repaired code/tests/tasks now satisfy the OpenSpec change and the previous audit findings are resolved.';
  const reworkScope = specStage
    ? '- REWORK if any artifact ambiguity, inconsistency, missing acceptance criteria, untestable requirement, or spec-stage repair gap remains.'
    : '- REWORK if any previous finding remains unresolved, new regressions are found, tasks are falsely checked, tests are missing, or validation is insufficient.';
  const scoreScope = specStage
    ? '- module_scores must score the repaired OpenSpec artifact state, not product implementation completeness.'
    : '- module_scores must score the repaired product implementation state, not the previous audit state.';
  return [
    title,
    '',
    'OpenSpec audit prompt:',
    basePrompt,
    '',
    'This is a focused final acceptance audit pass, not a Team/P2P discussion and not a planning round.',
    `Seriously audit ${auditTarget} against the previous Team audit discussion and the OpenSpec change.`,
    'Do not implement fixes in this turn. If anything remains unfixed, return REWORK with concrete required_changes.',
    '',
    `Project root: ${run.projectRoot}`,
    `Resolved change root identity: ${metadata.resolvedChangeRootIdentity}`,
    `Run id: ${metadata.runId}`,
    `Stage: ${metadata.stage}`,
    `Round: ${metadata.roundIndex}/${auditRoundLimit(run, stage)}`,
    `Attempt id: ${metadata.attemptId}`,
    `Authoritative result file: ${metadata.authoritativeResultPath}`,
    '',
    auditDiscussionFilePath ? `Previous audit discussion file: ${auditDiscussionFilePath}` : 'Previous audit discussion file: unavailable.',
    'Team repair scorecard location:',
    auditDiscussionFilePath ? `- File: ${auditDiscussionFilePath}` : '- File: unavailable.',
    '- Heading to find: "repair scorecard".',
    '- You MUST locate the latest matching section before assigning module_scores.',
    '- Treat that section as the binding deduction/recovery table for module_scores.',
    '- If the heading is absent, state that in evidence, set verdict to REWORK, and cap every module score at 6.',
    '',
    previousAudit ? `Previous audit verdict: ${previousAudit.verdict}` : 'Previous audit verdict: unavailable.',
    '',
    'Previous audit required_changes to verify:',
    bullets(previousAudit?.requiredChanges ?? []),
    '',
    'Previous low module scores to verify:',
    bullets(lowScores),
    '',
    'Previous audit unchecked or falsely-complete tasks to verify:',
    bullets(previousAudit?.uncheckedTasks ?? []),
    '',
    'Previous audit guidance:',
    auditGuidanceEvidence(previousAudit),
    '',
    'Write exactly one raw JSON object to the authoritative result file path above. Do not wrap the file content in Markdown fences.',
    'The daemon will read only that file as the authoritative result.',
    '',
    `Verdict scope for this final ${specStage ? 'specification' : 'implementation'} acceptance audit:`,
    passScope,
    reworkScope,
    '- BLOCKED only for external blockers that cannot be repaired in this repository.',
    scoreScope,
    '',
    'Scoring discipline:',
    '- Score from 10 downward based on current repaired evidence; do not start from PASS or assume high scores because a repair prompt completed.',
    '- Treat the repair turn, checked tasks.md, and discussion summaries as claims to verify, not proof. Re-read the repaired files and compare them against every previous required_change, unchecked/falsely-complete task, low-score concern, validation requirement, and repair scorecard item.',
    '- Use the repair scorecard baseline as the STARTING point, not a ceiling. When a deduction item is confirmed fixed by fresh post-repair evidence (you read the changed files / ran or saw validation), you MUST raise that module above its baseline in proportion to what was actually resolved. Withhold the increase only for items still unfixed or unverifiable.',
    '- A module score identical to its pre-repair baseline is correct ONLY when that module had no real repair, or its findings remain genuinely unresolved. If repairs_applied resolved this module\'s deduction items and you verified them, an unchanged (flat) score is WRONG — reflect the improvement; do not park everything at the baseline out of caution.',
    '- Do not inflate beyond the evidence either: do not exceed the repair scorecard full-score conditions, and do not restore points for claims you could not verify.',
    '- Award 9 or 10 only when fresh post-repair evidence shows the relevant module is complete, edge cases are covered, and appropriate validation ran after repair. If validation could not run, the evidence must explain the concrete blocker and the affected module must not receive 9 or 10.',
    specStage
      ? '- For spec-stage scoring, tests means testability of requirements, scenarios, and acceptance criteria. If OpenSpec validation was not run after repair, cap spec, tasks, tests, and risk at 7 even if the text looks clean.'
      : '- For implementation-stage scoring, tests means actual test coverage plus executed validation. If product validation was not run after repair, cap implementation and risk at 7 and cap tests at 6 even if the code looks plausible.',
    '- If any previous finding remains unresolved or only unverified, verdict must be REWORK and the affected module score must be 5 or lower.',
    '- Evidence that only restates the prompt, promises future work, or cites the Team discussion without inspecting repaired files is insufficient for PASS.',
    '',
    'The top-level auto_deliver object must exactly equal this metadata object:',
    JSON.stringify({
      runId: metadata.runId,
      changeName: metadata.changeName,
      resolvedChangeRootIdentity: metadata.resolvedChangeRootIdentity,
      stage: metadata.stage,
      selectedTeamComboId: metadata.selectedTeamComboId,
      activeOpenSpecPromptId: metadata.activeOpenSpecPromptId,
      roundIndex: metadata.roundIndex,
      attemptId: metadata.attemptId,
      authoritativeResultPath: metadata.authoritativeResultPath,
      owningMainSessionName: metadata.owningMainSessionName,
      executionSessionName: metadata.executionSessionName,
      generation: metadata.generation,
    }, null, 2),
    '',
    `Required top-level fields: ${OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_RESULT_FIELDS.join(', ')}.`,
    ...buildAuthoritativeResultSchemaHints(false),
  ].join('\n');
}

function buildTeamRepairScorecardInstructions(stage: AuditRepairStage): string[] {
  const target = stage === 'spec_audit_repair' ? 'artifact' : 'implementation';
  return [
    'repair scorecard',
    `- In the final Team summary, include the exact heading "repair scorecard" for ${target} repair planning. This is not the final authoritative module_scores JSON.`,
    '- For each module (spec, tasks, implementation, tests, risk), provide: baseline score before repair, deduction reasons, concrete recovery conditions, and full-score conditions.',
    '- Phrase recovery conditions as evidence gates, not bonus points. Example: "tests may recover from 6 to 8 only after X test is added and Y validation passes."',
    '- The later single-model final acceptance audit will use this scorecard as a checklist and may restore points only for conditions proven by post-repair evidence.',
  ];
}

/**
 * Hop-level guidance that goes into the DISCUSSION REQUEST text instead of the
 * full scorecard instructions. The full instructions are delivered ONLY to the
 * final-summary turn (via finalSummaryExtraInstruction): when they sat in the
 * request text, every participant hop saw them and wrote its own "repair
 * scorecard" section each round — burning tokens and, worse, corrupting the
 * acceptance audit's binding lookup, which takes the LATEST matching heading
 * in the discussion file.
 */
function buildTeamScorecardHopGuidance(): string[] {
  return [
    'Per-module findings (spec, tasks, implementation, tests, risk) with concrete evidence must be present in the hop outputs so the final Team summary can assemble the repair scorecard.',
    'Do NOT write a "repair scorecard" section in individual hop outputs or intermediate round summaries — ONLY the final Team summary includes it (that turn receives the scorecard format separately). Duplicate scorecard sections corrupt the acceptance audit\'s latest-scorecard lookup.',
  ];
}

function buildPostRepairAcceptanceAuditResultRepairPrompt(
  run: AutoDeliverRun,
  metadata: OpenSpecAutoDeliverP2pMetadata,
  reason: string,
): string {
  const specStage = metadata.stage === 'spec_audit_repair';
  return [
    `OpenSpec Auto Deliver needs the final ${specStage ? 'specification' : 'implementation'} acceptance audit authoritative result file for openspec/changes/${run.changeName}.`,
    '',
    `Problem: ${reason}`,
    `Authoritative result file: ${metadata.authoritativeResultPath}`,
    `Resolved change root identity: ${metadata.resolvedChangeRootIdentity}`,
    '',
    'Do not perform a new audit. Only correct the authoritative JSON file so it satisfies the schema below.',
    'Write exactly one raw JSON object to the authoritative result file path above.',
    'The top-level auto_deliver object must exactly equal this metadata object:',
    JSON.stringify({
      runId: metadata.runId,
      changeName: metadata.changeName,
      resolvedChangeRootIdentity: metadata.resolvedChangeRootIdentity,
      stage: metadata.stage,
      selectedTeamComboId: metadata.selectedTeamComboId,
      activeOpenSpecPromptId: metadata.activeOpenSpecPromptId,
      roundIndex: metadata.roundIndex,
      attemptId: metadata.attemptId,
      authoritativeResultPath: metadata.authoritativeResultPath,
      owningMainSessionName: metadata.owningMainSessionName,
      executionSessionName: metadata.executionSessionName,
      generation: metadata.generation,
    }, null, 2),
    '',
    `Required top-level fields: ${OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_RESULT_FIELDS.join(', ')}.`,
    ...buildAuthoritativeResultSchemaHints(false),
  ].join('\n');
}

async function dispatchPostRepairAcceptanceAuditPrompt(run: AutoDeliverRun): Promise<OpenSpecAutoDeliverProjection> {
  const elapsedProjection = enforceElapsedLimit(run);
  if (elapsedProjection) return elapsedProjection;
  const stage: AuditRepairStage = run.postRepairAcceptanceStage ?? 'implementation_audit_repair';
  const transitionEvent: OpenSpecAutoDeliverTransitionEvent = stage === 'spec_audit_repair'
    ? 'spec_audit_started'
    : 'implementation_audit_started';
  if (!transitionAllowed(run, transitionEvent)) {
    return terminalizeAndSend(run, 'failed', 'invalid_transition_post_repair_acceptance_audit');
  }
  if (!(await refreshChangeRoot(run))) {
    return terminalizeAndSend(run, 'failed', run.latestMessage ?? 'change_root_invalid');
  }
  const runtime = await awaitTransportRuntime(run.targetImplementationSessionName);
  if (!runtime) {
    return terminalizeAndSend(run, 'failed', 'missing_transport_runtime');
  }
  const gitEvidence = await collectGitEvidence(run);
  run.evidence = mergeEvidence(run.evidence, [
    {
      source: 'daemon',
      summary: gitEvidence.changedFiles.length > 0
        ? `Changed files: ${gitEvidence.changedFiles.join(', ')}.`
        : 'Changed files: none reported by git diff.',
      stale: false,
    },
    {
      source: 'daemon',
      summary: gitEvidence.diffStat
        ? `Diff stat: ${gitEvidence.diffStat}`
        : 'Diff stat: none reported by git diff.',
      stale: false,
    },
  ]);
  const activeOpenSpecPromptId = activeOpenSpecPromptIdForAutoDeliverStage(stage);
  const roundIndex = Math.max(1, auditRoundCount(run, stage));
  const attemptId = `${run.runId}:post_repair_acceptance_audit:${run.generation}:${roundIndex}`;
  // 'acceptance' phase → distinct path from the team discussion's audit file at
  // the same (stage, round), so this audit always writes onto an empty path
  // (fresh scores, never re-stamps the discussion's stale verdict) and the team
  // scorecard JSON is preserved for inspection.
  const authoritativeResultPath = await buildAuthoritativeResultPath(run, stage, run.generation, roundIndex, 'acceptance');
  const active: NonNullable<AutoDeliverRun['activeAcceptanceAudit']> = {
    selectedTeamComboId: run.selectedTeamComboId,
    activeOpenSpecPromptId,
    stage,
    attemptId,
    authoritativeResultPath,
    roundIndex,
    generation: run.generation,
  };
  const metadata = acceptanceAuditMetadataFromActive(run, active);
  run.status = stage;
  run.stage = stage;
  run.activeAcceptanceAudit = active;
  run.activeCommandId = `${attemptId}:prompt`;
  const prompt = buildPostRepairAcceptanceAuditPrompt(run, metadata);
  timelineEmitter.emit(run.targetImplementationSessionName, 'user.message', {
    text: prompt,
    allowDuplicate: true,
    commandId: run.activeCommandId,
  }, { source: 'daemon', confidence: 'high', eventId: `openspec-auto:${run.activeCommandId}` });
  try {
    runtime.send(prompt, run.activeCommandId);
  } catch (error) {
    delete run.activeCommandId;
    run.activeAcceptanceAudit = undefined;
    return terminalize(run, 'failed', error instanceof Error ? `post_repair_acceptance_audit_send_failed:${error.message}` : 'post_repair_acceptance_audit_send_failed');
  }
  run.latestMessage = 'post_repair_acceptance_audit_dispatched';
  return broadcastProjection(run);
}

function dispatchPostRepairAcceptanceAuditResultRepairPrompt(
  run: AutoDeliverRun,
  active: NonNullable<AutoDeliverRun['activeAcceptanceAudit']>,
  reason: string,
): OpenSpecAutoDeliverProjection {
  const runtime = getTransportRuntime(run.targetImplementationSessionName);
  if (!runtime) {
    return terminalize(run, 'failed', 'missing_transport_runtime');
  }
  active.resultFileRepairAttempted = true;
  run.activeAcceptanceAudit = active;
  run.activeCommandId = `${active.attemptId}:result-file-repair`;
  const metadata = acceptanceAuditMetadataFromActive(run, active);
  const prompt = buildPostRepairAcceptanceAuditResultRepairPrompt(run, metadata, reason);
  timelineEmitter.emit(run.targetImplementationSessionName, 'user.message', {
    text: prompt,
    allowDuplicate: true,
    commandId: run.activeCommandId,
  }, { source: 'daemon', confidence: 'high', eventId: `openspec-auto:${run.activeCommandId}` });
  try {
    runtime.send(prompt, run.activeCommandId);
  } catch (error) {
    delete run.activeCommandId;
    return terminalize(run, 'failed', error instanceof Error ? `post_repair_result_repair_send_failed:${error.message}` : 'post_repair_result_repair_send_failed');
  }
  run.latestMessage = 'post_repair_result_file_repair_prompt_dispatched';
  return broadcastProjection(run);
}

function auditRoundLimit(run: AutoDeliverRun, stage: AuditRepairStage): number {
  return stage === 'spec_audit_repair'
    ? run.materializedLimits.specAuditRepairRounds
    : run.materializedLimits.implementationAuditRepairRounds;
}

function auditRoundCount(run: AutoDeliverRun, stage: AuditRepairStage): number {
  return stage === 'spec_audit_repair' ? run.specAuditRepairRound : run.implementationAuditRepairRound;
}

const RETRYABLE_AUTHORITATIVE_RESULT_ERROR_CODES = new Set([
  'missing_authoritative_json',
  'multiple_authoritative_json',
  'malformed_authoritative_json',
  'authoritative_input_too_large',
  'authoritative_payload_too_large',
  'invalid_authoritative_json',
  'invalid_audit_verdict',
  'invalid_verdict_payload',
  'invalid_verdict',
  'invalid_module_scores',
  'invalid_module_score',
  'invalid_score_module',
  'invalid_score_value',
  'invalid_max_score',
  'invalid_score_summary',
  'duplicate_score_module',
  'missing_score_module',
  'invalid_string_array',
  'invalid_string_array_item',
  'invalid_repairs_applied',
  'invalid_repair_summary',
  'invalid_repair_reason',
  'invalid_evidence',
  'invalid_evidence_entry',
  'invalid_evidence_summary',
  'invalid_evidence_command',
  'invalid_evidence_exit_code',
  'contradictory_pass_payload',
]);

function isRetryableAuditResultError(reason: string | undefined): boolean {
  const codes = reason?.split(',').map((code) => code.trim()).filter(Boolean) ?? [];
  return codes.length > 0 && codes.every((code) => RETRYABLE_AUTHORITATIVE_RESULT_ERROR_CODES.has(code));
}

function p2pAuditFailureSummary(p2pRun: P2pRun): string {
  const detail = p2pRun.error?.trim();
  return detail
    ? `Team/P2P audit run failed before producing an authoritative result. status=${p2pRun.status}; error=${detail}`
    : `Team/P2P audit run failed before producing an authoritative result. status=${p2pRun.status}`;
}

/**
 * Which phase owns an authoritative result file. The team/P2P discussion audit
 * and the post-repair single-model acceptance audit MUST NOT share a path: they
 * run at the same (stage, round), so a shared path lets the acceptance audit
 * read/re-stamp the discussion's stale scores (→ scores never move after a fix)
 * and clobbers the team scorecard JSON. 'audit' keeps the original basename for
 * backward compatibility; 'acceptance' gets a distinct `.acceptance` segment.
 */
type AutoDeliverResultPhase = 'audit' | 'acceptance';

function safeAutoDeliverResultBasename(
  run: AutoDeliverRun,
  stage: AuditRepairStage,
  generation: number,
  roundIndex: number,
  phase: AutoDeliverResultPhase = 'audit',
): string {
  const phaseSegment = phase === 'acceptance' ? '.acceptance' : '';
  return `${run.runId}.${stage}.g${generation}.r${roundIndex}${phaseSegment}.authoritative.json`
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

function safeImplementationMarkerBasename(run: AutoDeliverRun, generation: number, promptIndex: number): string {
  return `${run.runId}.implementation.g${generation}.p${promptIndex}.marker.json`
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function buildImplementationMarkerPath(run: AutoDeliverRun, generation: number, promptIndex: number): Promise<string> {
  const dir = join(run.projectRoot, '.imc', 'discussions');
  await mkdir(dir, { recursive: true });
  return join(dir, safeImplementationMarkerBasename(run, generation, promptIndex));
}

async function buildAuthoritativeResultPath(
  run: AutoDeliverRun,
  stage: AuditRepairStage,
  generation: number,
  roundIndex: number,
  phase: AutoDeliverResultPhase = 'audit',
): Promise<string> {
  const dir = join(run.projectRoot, '.imc', 'discussions');
  await mkdir(dir, { recursive: true });
  return join(dir, safeAutoDeliverResultBasename(run, stage, generation, roundIndex, phase));
}

function isPathWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

async function validateAuthoritativeResultPath(run: AutoDeliverRun, authoritativeResultPath: string): Promise<boolean> {
  const projectRootReal = await realpath(run.projectRoot).catch(() => null);
  if (!projectRootReal) return false;
  const discussionsPath = join(run.projectRoot, '.imc', 'discussions');
  const discussionsReal = await realpath(discussionsPath).catch(() => null);
  if (!discussionsReal || !isPathWithin(projectRootReal, discussionsReal)) return false;
  const resolvedExpectedDir = resolve(discussionsPath);
  const resolvedCandidate = resolve(authoritativeResultPath);
  if (!isPathWithin(resolvedExpectedDir, resolvedCandidate)) return false;
  const candidateDirReal = await realpath(dirname(resolvedCandidate)).catch(() => null);
  if (!candidateDirReal || !isPathWithin(discussionsReal, candidateDirReal)) return false;
  const candidateStat = await lstat(resolvedCandidate).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    return false;
  });
  if (candidateStat === false) return false;
  if (candidateStat && !candidateStat.isFile() && !candidateStat.isSymbolicLink()) return false;
  const candidateReal = await realpath(resolvedCandidate).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    return false;
  });
  if (candidateReal === false) return false;
  if (candidateReal && !isPathWithin(discussionsReal, candidateReal)) return false;
  return true;
}

function incrementAuditRound(run: AutoDeliverRun, stage: AuditRepairStage): number {
  if (stage === 'spec_audit_repair') {
    run.specAuditRepairRound += 1;
    return run.specAuditRepairRound;
  }
  run.implementationAuditRepairRound += 1;
  return run.implementationAuditRepairRound;
}

async function collectGitEvidence(run: AutoDeliverRun): Promise<{ changedFiles: string[]; diffStat: string }> {
  const runGit = async (args: string[]): Promise<string> => {
    const result = await execFileAsync('git', ['-C', run.projectRoot, ...args], { timeout: 2000, maxBuffer: 128 * 1024 }).catch(() => null);
    return result?.stdout?.toString?.() ?? '';
  };
  const statusFiles = (await runGit(['status', '--porcelain=v1', '--untracked-files=all']))
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .map((line) => line.includes(' -> ') ? line.split(' -> ').at(-1)?.trim() ?? line : line)
    .filter(Boolean);
  const unstagedFiles = (await runGit(['diff', '--name-only']))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const stagedFiles = (await runGit(['diff', '--cached', '--name-only']))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const untrackedFiles = (await runGit(['ls-files', '--others', '--exclude-standard']))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const changedFiles = [...new Set([...statusFiles, ...unstagedFiles, ...stagedFiles, ...untrackedFiles])].slice(0, 120);
  const diffStat = [
    (await runGit(['diff', '--stat', '--', '.'])).trim(),
    (await runGit(['diff', '--cached', '--stat', '--', '.'])).trim(),
    untrackedFiles.length > 0 ? `Untracked files: ${untrackedFiles.slice(0, 80).join(', ')}` : '',
  ].filter(Boolean).join('\n').trim().slice(0, 6000);
  return { changedFiles, diffStat };
}

function isLocalPlanningPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized === 'openspec'
    || normalized.startsWith('openspec/')
    || normalized === 'docs'
    || normalized.startsWith('docs/')
    || normalized === '.imc'
    || normalized.startsWith('.imc/');
}

function productChangedFiles(files: string[]): string[] {
  return files
    .map((file) => file.replace(/\\/g, '/').replace(/^\/+/, '').trim())
    .filter((file) => file.length > 0 && !isLocalPlanningPath(file));
}

async function productFileFingerprint(projectRoot: string, file: string): Promise<string> {
  const projectRootResolved = resolve(projectRoot);
  const candidate = resolve(projectRoot, file);
  if (!isPathWithin(projectRootResolved, candidate)) return 'outside-project';
  const fileStat = await lstat(candidate).catch(() => null);
  if (!fileStat) return 'missing';
  const resolved = await realpath(candidate).catch(() => null);
  if (!resolved || !isPathWithin(projectRootResolved, resolved)) return 'outside-project';
  if (!fileStat.isFile() && !fileStat.isSymbolicLink()) return `${fileStat.isDirectory() ? 'directory' : 'special'}:${fileStat.size}:${fileStat.mtimeMs}`;
  const content = await readFile(resolved).catch(() => null);
  if (!content) return 'unreadable';
  return createHash('sha256').update(content).digest('hex');
}

async function productFileFingerprints(projectRoot: string, files: string[]): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const file of productChangedFiles(files)) {
    output[file] = await productFileFingerprint(projectRoot, file);
  }
  return output;
}

async function currentRunProductFiles(run: AutoDeliverRun, files: string[]): Promise<string[]> {
  const baseline = run.baselineProductFileFingerprints ?? {};
  const candidates: string[] = [];
  for (const file of productChangedFiles(files)) {
    const before = baseline[file];
    if (!before) {
      candidates.push(file);
      continue;
    }
    const after = await productFileFingerprint(run.projectRoot, file);
    if (after !== before) candidates.push(file);
  }
  return [...new Set(candidates)];
}

function parseGitStatusPorcelainZ(stdout: string): string[] {
  const parts = stdout.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3).trim();
    if (path) files.push(path);
    if ((status.includes('R') || status.includes('C')) && index + 1 < parts.length) index += 1;
  }
  return [...new Set(files)];
}

async function gitOutput(projectRoot: string, args: string[], timeout = 10_000): Promise<string> {
  const result = await execFileAsync('git', ['-C', projectRoot, ...args], {
    timeout,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout?.toString?.() ?? '';
}

async function collectAutoCommitProductFiles(projectRoot: string): Promise<string[]> {
  const stdout = await gitOutput(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return productChangedFiles(parseGitStatusPorcelainZ(stdout));
}

async function ensureProductBaseline(run: AutoDeliverRun): Promise<OpenSpecAutoDeliverProjection | null> {
  if (run.baselineProductChangedFiles && run.baselineProductFileFingerprints) return null;
  try {
    const baselineProductChangedFiles = await collectAutoCommitProductFiles(run.projectRoot);
    run.baselineProductChangedFiles = baselineProductChangedFiles;
    run.baselineProductFileFingerprints = await productFileFingerprints(run.projectRoot, baselineProductChangedFiles);
    delete run.productBaselineUnavailableReason;
    return null;
  } catch (error) {
    const reason = describeUnknownError(error);
    run.baselineProductChangedFiles = [];
    run.baselineProductFileFingerprints = {};
    run.productBaselineUnavailableReason = reason;
    run.evidence = mergeEvidence(run.evidence, [{
      source: 'daemon',
      summary: `Product baseline unavailable before implementation; continuing without launch dirty-file filtering: ${reason}.`,
      stale: false,
    }]);
    return null;
  }
}

async function currentUpstreamAheadCount(projectRoot: string): Promise<number | null> {
  const upstream = (await gitOutput(projectRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    .catch(() => '')).trim();
  if (!upstream) return null;
  const aheadBehind = (await gitOutput(projectRoot, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])).trim();
  const [, aheadRaw] = aheadBehind.split(/\s+/);
  const ahead = Number(aheadRaw);
  if (!Number.isFinite(ahead)) throw new Error(`invalid ahead/behind output "${aheadBehind}"`);
  return ahead;
}

function buildAutoCommitPushPrompt(run: AutoDeliverRun, files: string[]): string {
  void run;
  void files;
  return 'commit&push';
}

async function dispatchAutoCommitPushPrompt(run: AutoDeliverRun): Promise<OpenSpecAutoDeliverProjection> {
  const elapsedProjection = enforceElapsedLimit(run);
  if (elapsedProjection) return elapsedProjection;
  if (run.productBaselineUnavailableReason) {
    return terminalizeAndSend(run, 'needs_human', `auto_commit_push_baseline_failed:${run.productBaselineUnavailableReason}`);
  }
  if (!transitionAllowed(run, 'auto_commit_push_dispatched')) {
    return terminalizeAndSend(run, 'failed', 'invalid_transition_auto_commit_push');
  }
  let files: string[];
  try {
    files = await collectAutoCommitProductFiles(run.projectRoot);
  } catch (error) {
    return terminalizeAndSend(run, 'needs_human', `auto_commit_push_git_status_failed:${describeUnknownError(error)}`);
  }
  const candidateFiles = await currentRunProductFiles(run, files);
  if (candidateFiles.length === 0) {
    run.evidence = mergeEvidence(run.evidence, [{
      source: 'daemon',
      summary: files.length > 0
        ? `Auto commit/push enabled: no new product file changes beyond launch baseline. Baseline dirty files remain: ${files.join(', ')}.`
        : 'Auto commit/push enabled: no product file changes to commit.',
      stale: false,
    }]);
    return terminalizeAndSend(run, 'passed', 'final_audit_passed');
  }
  const runtime = await awaitTransportRuntime(run.targetImplementationSessionName);
  if (!runtime) {
    return terminalizeAndSend(run, 'failed', 'missing_transport_runtime');
  }
  try {
    run.autoCommitPushBaselineHead = (await gitOutput(run.projectRoot, ['rev-parse', 'HEAD'])).trim();
    run.autoCommitPushBaselineAhead = await currentUpstreamAheadCount(run.projectRoot) ?? 0;
  } catch (error) {
    return terminalizeAndSend(run, 'needs_human', `auto_commit_push_git_status_failed:${describeUnknownError(error)}`);
  }
  run.autoCommitPushCandidateFiles = candidateFiles;
  run.status = 'commit_push';
  run.stage = 'commit_push';
  run.activeCommandId = `${run.runId}:auto-commit-push:${run.generation}`;
  const prompt = buildAutoCommitPushPrompt(run, files);
  timelineEmitter.emit(run.targetImplementationSessionName, 'user.message', {
    text: prompt,
    allowDuplicate: true,
    commandId: run.activeCommandId,
  }, { source: 'daemon', confidence: 'high', eventId: `openspec-auto:${run.activeCommandId}` });
  try {
    runtime.send(prompt, run.activeCommandId);
  } catch (error) {
    delete run.activeCommandId;
    return terminalizeAndSend(run, 'failed', error instanceof Error ? `auto_commit_push_send_failed:${error.message}` : 'auto_commit_push_send_failed');
  }
  run.latestMessage = 'auto_commit_push_prompt_dispatched';
  run.evidence = mergeEvidence(run.evidence, [{
    source: 'daemon',
    summary: `Auto commit/push prompt dispatched to implementation LLM for current-run product files: ${candidateFiles.join(', ')}.`,
    stale: false,
  }]);
  return broadcastProjection(run);
}

async function verifyAutoCommitPushCompleted(run: AutoDeliverRun): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  let files: string[];
  try {
    files = await collectAutoCommitProductFiles(run.projectRoot);
  } catch (error) {
    return { ok: false, error: `auto_commit_push_git_status_failed:${describeUnknownError(error)}` };
  }
  if (files.length > 0) {
    const candidates = new Set(run.autoCommitPushCandidateFiles ?? []);
    const remainingCurrentRunFiles = (await currentRunProductFiles(run, files)).filter((file) => candidates.has(file));
    if (remainingCurrentRunFiles.length > 0) {
      return { ok: false, error: `auto_commit_push_incomplete:${remainingCurrentRunFiles.slice(0, 30).join(',')}` };
    }
  }
  const head = (await gitOutput(run.projectRoot, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  if (run.autoCommitPushBaselineHead && head === run.autoCommitPushBaselineHead) {
    return { ok: false, error: 'auto_commit_push_no_commit' };
  }
  if (run.autoCommitPushBaselineHead && head) {
    const committedFiles = (await gitOutput(run.projectRoot, ['diff', '--name-only', `${run.autoCommitPushBaselineHead}..HEAD`]).catch(() => ''))
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);
    const forbidden = committedFiles.filter(isLocalPlanningPath);
    if (forbidden.length > 0) {
      return { ok: false, error: `auto_commit_push_forbidden_paths:${forbidden.slice(0, 30).join(',')}` };
    }
    const candidates = new Set(run.autoCommitPushCandidateFiles ?? []);
    const unexpected = productChangedFiles(committedFiles).filter((file) => !candidates.has(file));
    if (unexpected.length > 0) {
      return { ok: false, error: `auto_commit_push_unexpected_files:${unexpected.slice(0, 30).join(',')}` };
    }
  }
  const upstream = (await gitOutput(run.projectRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    .catch(() => '')).trim();
  if (!upstream) {
    return { ok: false, error: 'auto_commit_push_no_upstream' };
  }
  let ahead = 0;
  let behind = 0;
  try {
    const aheadBehind = (await gitOutput(run.projectRoot, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])).trim();
    const [behindRaw, aheadRaw] = aheadBehind.split(/\s+/);
    ahead = Number(aheadRaw);
    behind = Number(behindRaw);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
      return { ok: false, error: `auto_commit_push_git_status_failed:invalid ahead/behind output "${aheadBehind}"` };
    }
  } catch (error) {
    return { ok: false, error: `auto_commit_push_git_status_failed:${describeUnknownError(error)}` };
  }
  const allowedAhead = run.autoCommitPushBaselineAhead ?? 0;
  if (ahead > allowedAhead) {
    return { ok: false, error: `auto_commit_push_not_pushed:${ahead - allowedAhead}` };
  }
  const commit = (await gitOutput(run.projectRoot, ['log', '-1', '--pretty=%h %s']).catch(() => '')).trim();
  const behindText = Number.isFinite(behind) && behind > 0 ? `; local branch is ${behind} commit(s) behind upstream` : '';
  const allowedAheadText = allowedAhead > 0 ? `; preserving ${allowedAhead} pre-existing ahead commit(s)` : '';
  return {
    ok: true,
    summary: `Auto commit/push verified by daemon${commit ? `: ${commit}` : ''}; upstream=${upstream}${behindText}${allowedAheadText}.`,
  };
}

async function advanceAfterAutoCommitPushIdle(run: AutoDeliverRun): Promise<void> {
  if (run.status !== 'commit_push' || !run.activeCommandId) return;
  if (enforceElapsedLimit(run)) return;
  delete run.activeCommandId;
  const verification = await verifyAutoCommitPushCompleted(run);
  run.evidence = mergeEvidence(run.evidence, [{
    source: 'daemon',
    summary: verification.ok ? verification.summary : verification.error,
    stale: false,
  }]);
  if (!verification.ok) {
    terminalizeAndSend(run, 'needs_human', verification.error);
    return;
  }
  terminalizeAndSend(run, 'passed', 'final_audit_passed');
}

function openSpecChangeReference(run: AutoDeliverRun): string {
  return `@openspec/changes/${run.changeName}`;
}

function buildAuthoritativeResultSchemaHints(includeAutoDeliverNesting: boolean): string[] {
  return [
    includeAutoDeliverNesting
      ? 'The top-level auto_deliver object must exactly equal the metadata object below.'
      : `Required auto_deliver fields: ${OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_METADATA_FIELDS.join(', ')}.`,
    `Allowed verdict values: ${OPENSPEC_AUTO_DELIVER_VERDICTS.join(', ')}.`,
    `module_scores must contain exactly one entry for each module: ${OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS.join(', ')}.`,
    `Each module_scores entry uses fields: ${OPENSPEC_AUTO_DELIVER_MODULE_SCORE_FIELDS.join(', ')}; max_score must be 10.`,
    `Each repairs_applied entry uses fields: ${OPENSPEC_AUTO_DELIVER_REPAIR_SUMMARY_FIELDS.join(', ')}.`,
    `Each evidence entry requires fields: ${OPENSPEC_AUTO_DELIVER_EVIDENCE_REQUIRED_FIELDS.join(', ')}; optional fields: ${OPENSPEC_AUTO_DELIVER_EVIDENCE_OPTIONAL_FIELDS.join(', ')}.`,
    'evidence.source is informational only; use any useful label, or "none" when no label is available.',
    'PASS must leave unchecked_tasks and required_changes empty.',
  ];
}

function buildAuditRequestText(run: AutoDeliverRun, metadata: OpenSpecAutoDeliverP2pMetadata): string {
  if (metadata.stage === 'implementation_audit_repair') {
    const unchecked = uncheckedTaskLabels(run.taskStats);
    return [
      `OpenSpec Auto Deliver implementation audit discussion for openspec/changes/${run.changeName}.`,
      '',
      `Change reference: ${openSpecChangeReference(run)}`,
      '',
      'OpenSpec implementation audit prompt:',
      // Discussion turns are audit-only ("Do not write authoritative JSON",
      // repair happens in the execution model's turn) — embed the audit
      // standard without the template's "then fix the code … Do not stop at a
      // report" repair directive, which contradicted the audit-only contract.
      formatOpenSpecAuditStandardTemplate('audit_implementation', openSpecChangeReference(run)),
      '',
      `Project root: ${run.projectRoot}`,
      `Resolved change root identity: ${metadata.resolvedChangeRootIdentity}`,
      `Run id: ${run.runId}`,
      `Stage: ${metadata.stage}`,
      `Generation: ${metadata.generation}`,
      `Attempt id: ${metadata.attemptId}`,
      `Selected Team combo id: ${metadata.selectedTeamComboId}`,
      `Active OpenSpec prompt id: ${metadata.activeOpenSpecPromptId}`,
      `Round: ${metadata.roundIndex}/${auditRoundLimit(run, metadata.stage)}`,
      `Owning main session: ${metadata.owningMainSessionName}`,
      `Execution session: ${metadata.executionSessionName}`,
      'All referenced relative paths are relative to the project root above; do not use the execution session current directory if it differs.',
      '',
      'Read the OpenSpec artifacts from the referenced change folder and audit the current product code, tests, and tasks.md against them.',
      'Use the OpenSpec implementation audit prompt above as the audit-and-repair standard; preserve concrete repair instructions in the discussion output.',
      'Do not write authoritative JSON. Do not assign final module scores.',
      'The execution model will use this discussion file to repair code/tests/tasks, then a separate single-model final implementation acceptance audit will score the repaired state and write the authoritative JSON.',
      '',
      'Audit focus:',
      '- Identify every mismatch, omission, regression risk, edge-case gap, missing test, and falsely checked task.',
      '- Produce concrete repair guidance that the execution model can apply directly.',
      '- In the final Team summary, separate critical fixes, small follow-up fixes, validation requirements, and any blockers.',
      '- Treat high apparent quality as still requiring a repair pass; do not conclude that no implementation repair should run merely because scores would be high.',
      ...buildTeamScorecardHopGuidance(),
      '',
      `Task stats: ${run.taskStats.checked}/${run.taskStats.total} checked.`,
      unchecked.length > 0 ? `Unchecked tasks:\n${unchecked.map((label) => `- ${label}`).join('\n')}` : 'Unchecked tasks: none.',
      run.latestRepairSummary ? `Prior repair summary: ${run.latestRepairSummary}` : 'Prior repair summary: none.',
      runEvidenceForPrompt(run),
    ].join('\n');
  }
  const unchecked = uncheckedTaskLabels(run.taskStats);
  return [
    `OpenSpec Auto Deliver specification audit discussion for openspec/changes/${run.changeName}.`,
    '',
    `Change reference: ${openSpecChangeReference(run)}`,
    '',
    'OpenSpec specification audit prompt:',
    // Audit-only turn — same rationale as the implementation branch above: do
    // not embed "then directly update the change artifacts … Do not stop at
    // review notes" into a turn whose contract is review-only.
    formatOpenSpecAuditStandardTemplate('audit_spec', openSpecChangeReference(run)),
    '',
    `Project root: ${run.projectRoot}`,
    `Resolved change root identity: ${metadata.resolvedChangeRootIdentity}`,
    `Run id: ${run.runId}`,
    `Stage: ${metadata.stage}`,
    `Generation: ${metadata.generation}`,
    `Attempt id: ${metadata.attemptId}`,
    `Selected Team combo id: ${metadata.selectedTeamComboId}`,
    `Active OpenSpec prompt id: ${metadata.activeOpenSpecPromptId}`,
    `Round: ${metadata.roundIndex}/${auditRoundLimit(run, metadata.stage)}`,
    `Owning main session: ${metadata.owningMainSessionName}`,
    `Execution session: ${metadata.executionSessionName}`,
    'All referenced relative paths are relative to the project root above; do not use the execution session current directory if it differs.',
    '',
    'Audit only the OpenSpec artifacts under this change: proposal.md, design.md, specs/**/spec.md, and tasks.md.',
    'Use the OpenSpec specification audit prompt above as the audit-and-repair standard; preserve concrete artifact repair instructions in the discussion output.',
    'Do not write authoritative JSON. Do not assign final module scores.',
    'The execution model will use this discussion file to repair the artifacts, then a separate single-model final specification acceptance audit will score the repaired state and write the authoritative JSON.',
    '',
    'Audit focus:',
    '- Identify ambiguous scope, inconsistent requirements, weak acceptance criteria, untestable scenarios, missing edge cases, failure modes, dependencies, and task gaps.',
    '- Produce concrete artifact repair guidance that the execution model can apply directly.',
    '- In the final Team summary, separate critical artifact fixes, small follow-up fixes, validation requirements, and any blockers.',
    '- Treat high apparent quality as still requiring a repair pass; do not conclude that no spec repair should run merely because scores would be high.',
    ...buildTeamScorecardHopGuidance(),
    '',
    `Task stats: ${run.taskStats.checked}/${run.taskStats.total} checked.`,
    unchecked.length > 0 ? `Unchecked tasks:\n${unchecked.map((label) => `- ${label}`).join('\n')}` : 'Unchecked tasks: none.',
    run.latestRepairSummary ? `Prior repair summary: ${run.latestRepairSummary}` : 'Prior repair summary: none.',
    runEvidenceForPrompt(run),
  ].join('\n');
}

function buildAuditResultFileRepairPrompt(run: AutoDeliverRun, metadata: OpenSpecAutoDeliverP2pMetadata, p2pRun: P2pRun, reason: string): string {
  const stageVerdictScope = metadata.stage === 'spec_audit_repair'
    ? [
        'Spec-stage verdict scope:',
        '- PASS means the OpenSpec artifacts are implementation-ready, even if implementation/test tasks in tasks.md remain unchecked for the next stage.',
        '- Do not put implementation-stage follow-up tasks in unchecked_tasks or required_changes for a spec-stage PASS; record them in repairs_applied/evidence instead.',
        '- REWORK means the OpenSpec artifacts themselves still require another spec-audit repair attempt.',
      ].join('\n')
    : [
        'Implementation-stage verdict scope:',
        '- PASS means implementation, tests, and tasks.md completion satisfy the OpenSpec change.',
        '- REWORK means product/test/task completion still needs implementation repair and a follow-up audit.',
      ].join('\n');
  return [
    `OpenSpec Auto Deliver needs the authoritative audit result file for openspec/changes/${run.changeName}.`,
    '',
    `The audit-repair discussion has already completed; do not redo the full audit from scratch unless you must inspect your prior conclusion.`,
    `Problem: ${reason}`,
    `Discussion file: ${p2pRun.contextFilePath}`,
    `Project root: ${run.projectRoot}`,
    `Authoritative result file: ${metadata.authoritativeResultPath}`,
    `Resolved change root identity: ${metadata.resolvedChangeRootIdentity}`,
    'All referenced relative paths are relative to the project root above; do not use the execution session current directory if it differs.',
    '',
    'Write exactly one raw JSON object to the authoritative result file path above. Do not wrap the file content in Markdown fences. Do not write a second JSON candidate.',
    'The daemon will read only that file as the authoritative result; chat/discussion text is not authoritative.',
    '',
    'The top-level auto_deliver object must exactly equal this metadata object:',
    JSON.stringify({
      runId: metadata.runId,
      changeName: metadata.changeName,
      resolvedChangeRootIdentity: metadata.resolvedChangeRootIdentity,
      stage: metadata.stage,
      selectedTeamComboId: metadata.selectedTeamComboId,
      activeOpenSpecPromptId: metadata.activeOpenSpecPromptId,
      roundIndex: metadata.roundIndex,
      attemptId: metadata.attemptId,
      authoritativeResultPath: metadata.authoritativeResultPath,
      owningMainSessionName: metadata.owningMainSessionName,
      executionSessionName: metadata.executionSessionName,
      generation: metadata.generation,
    }, null, 2),
    '',
    `Required top-level fields: ${OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_RESULT_FIELDS.join(', ')}.`,
    ...buildAuthoritativeResultSchemaHints(true),
    '',
    stageVerdictScope,
  ].join('\n');
}

function dispatchAuditResultFileRepairPrompt(run: AutoDeliverRun, metadata: OpenSpecAutoDeliverP2pMetadata, p2pRun: P2pRun, reason: string): boolean {
  const runtime = getTransportRuntime(run.targetImplementationSessionName);
  if (!runtime) return false;
  const commandId = `${metadata.attemptId}:authoritative-result-file-repair`;
  const prompt = buildAuditResultFileRepairPrompt(run, metadata, p2pRun, reason);
  timelineEmitter.emit(run.targetImplementationSessionName, 'user.message', {
    text: prompt,
    allowDuplicate: true,
    commandId,
  }, { source: 'daemon', confidence: 'high', eventId: `openspec-auto:${commandId}` });
  try {
    runtime.send(prompt, commandId);
  } catch {
    return false;
  }
  run.latestMessage = 'authoritative_result_file_repair_prompt_dispatched';
  broadcastProjection(run);
  return true;
}

function validateAuditMetadata(input: unknown, expected: OpenSpecAutoDeliverP2pMetadata): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  for (const field of OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_RESULT_FIELDS) {
    if (!(field in record)) return false;
  }
  const meta = record.auto_deliver;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const actual = meta as Record<string, unknown>;
  for (const field of OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_METADATA_FIELDS) {
    if (!(field in actual)) return false;
  }
  return actual.runId === expected.runId
    && actual.changeName === expected.changeName
    && actual.resolvedChangeRootIdentity === expected.resolvedChangeRootIdentity
    && actual.stage === expected.stage
    && actual.selectedTeamComboId === expected.selectedTeamComboId
    && actual.activeOpenSpecPromptId === expected.activeOpenSpecPromptId
    && actual.roundIndex === expected.roundIndex
    && actual.attemptId === expected.attemptId
    && actual.authoritativeResultPath === expected.authoritativeResultPath
    && actual.owningMainSessionName === expected.owningMainSessionName
    && actual.executionSessionName === expected.executionSessionName
    && actual.generation === expected.generation;
}

function repairSummaryText(repairs: OpenSpecAutoDeliverRepairSummary[]): string | undefined {
  if (repairs.length === 0) return undefined;
  return repairs.map((repair) => `${repair.files.join(', ') || '(unspecified files)'}: ${repair.reason}`).join('; ');
}

function validateFinalPass(run: AutoDeliverRun, verdict: OpenSpecAutoDeliverVerdictPayload, changedFiles: string[] = []): string | null {
  if (verdict.verdict !== 'PASS') return null;
  if (run.taskStats.total <= 0) return 'tasks_missing_checkboxes';
  if (run.taskStats.unchecked > 0) return 'audit_pass_with_unchecked_tasks';
  if (verdict.unchecked_tasks.length > 0) return 'audit_pass_with_reported_unchecked_tasks';
  if (verdict.required_changes.length > 0) return 'audit_pass_with_required_changes';
  const repairedFiles = new Set(verdict.repairs_applied.flatMap((repair) => repair.files));
  const uncoveredChangedFiles = changedFiles.filter((file) => !repairedFiles.has(file));
  if (uncoveredChangedFiles.length > 0) return 'audit_pass_with_uncovered_changed_files';
  return null;
}

async function consumeAuditResultFile(run: AutoDeliverRun, expected: OpenSpecAutoDeliverP2pMetadata): Promise<OpenSpecAutoDeliverVerdictPayload | null> {
  if (!(await validateAuthoritativeResultPath(run, expected.authoritativeResultPath))) {
    run.latestMessage = OPENSPEC_AUTO_DELIVER_TERMINAL_REASONS.INVALID_AUTHORITATIVE_RESULT_PATH;
    run.lastAuditResultError = run.latestMessage;
    return null;
  }
  const text = await readFile(expected.authoritativeResultPath, 'utf8').catch(() => null);
  if (typeof text !== 'string' || !text.trim()) {
    run.latestMessage = 'missing_authoritative_json';
    run.lastAuditResultError = run.latestMessage;
    return null;
  }
  const parsedPayload = parseOpenSpecAutoDeliverAuthoritativeJsonPayload(text);
  if (!parsedPayload.ok) {
    run.latestMessage = parsedPayload.issues[0]?.code ?? 'invalid_authoritative_json';
    run.lastAuditResultError = run.latestMessage;
    return null;
  }
  const parsed = parsedPayload.value;
  if (!validateAuditMetadata(parsed, expected)) {
    run.latestMessage = 'audit_metadata_mismatch';
    run.lastAuditResultError = run.latestMessage;
    return null;
  }
  const result = validateOpenSpecAutoDeliverVerdictPayload(parsed);
  if (!result.ok) {
    run.latestMessage = result.issues.map((entry) => entry.code).join(',') || 'invalid_audit_verdict';
    run.lastAuditResultError = run.latestMessage;
    return null;
  }
  delete run.lastAuditResultError;
  return result.value;
}

function activeRunForOwner(owner: string): AutoDeliverRun | undefined {
  const activeId = activeRunByOwner.get(owner);
  return activeId ? runsById.get(activeId) : undefined;
}

function latestRunForSession(sessionName: string): AutoDeliverRun | undefined {
  const owner = resolveOpenSpecAutoDeliverOwningMainSession(sessionName);
  return activeRunForOwner(owner) ?? terminalRunByOwner.get(owner);
}

function recordP2pCancelFailureDiagnostic(run: AutoDeliverRun, summary: string): void {
  if (!isOpenSpecAutoDeliverTerminalStage(run.status)) return;
  run.evidence = mergeEvidence(run.evidence, [{
    source: 'daemon',
    summary,
    stale: false,
  }]);
  broadcastProjection(run);
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trackActiveAuditCancellation(run: AutoDeliverRun, active: NonNullable<AutoDeliverRun['activeAudit']>, reason: string): void {
  void cancelP2pRun(active.p2pRunId, run.serverLink, {
    source: 'openspec_auto_deliver_terminalize',
    reason,
    requestedBySession: run.launchedFromSessionName,
  })
    .then((cancelled) => {
      if (cancelled) return;
      setTimeout(() => {
        recordP2pCancelFailureDiagnostic(
          run,
          `P2P cancel diagnostic: cancelP2pRun returned false for active Auto Deliver audit run ${active.p2pRunId}.`,
        );
      }, 0);
    })
    .catch((error) => {
      setTimeout(() => {
        recordP2pCancelFailureDiagnostic(
          run,
          `P2P cancel diagnostic: cancelP2pRun rejected for active Auto Deliver audit run ${active.p2pRunId}: ${describeUnknownError(error)}.`,
        );
      }, 0);
    });
}

function terminalize(run: AutoDeliverRun, status: Extract<AutoDeliverRunStatus, 'passed' | 'needs_human' | 'failed' | 'stopped'>, reason: string): OpenSpecAutoDeliverProjection {
  const previousStage = run.stage;
  if (run.activeAudit) {
    const active = run.activeAudit;
    clearAuditPollTimer(run.runId);
    if (active.p2pRunId) trackActiveAuditCancellation(run, active, reason);
    run.activeAudit = undefined;
  }
  run.activeAcceptanceAudit = undefined;
  clearAuditFixRetryTimer(run.runId);
  clearImplementationReminderTimer(run.runId);
  delete run.activeCommandId;
  delete run.activeImplementationMarker;
  run.resumeStage = status === 'passed' ? undefined : previousStage;
  run.status = status;
  run.stage = status;
  run.terminalReason = reason;
  run.latestMessage = reason;
  run.generation += 1;
  activeRunByOwner.delete(run.owningMainSessionName);
  terminalRunByOwner.set(run.owningMainSessionName, run);
  releaseAutoDeliverP2pLock(run.owningMainSessionName, run.runId);
  forgetRequestProjectionFingerprints(run);
  if (status === 'needs_human') emitHumanInterventionPrompt(run, reason);
  return bumpProjection(run);
}

function recordAuditResult(
  run: AutoDeliverRun,
  stage: AuditRepairStage,
  verdict: OpenSpecAutoDeliverVerdictPayload,
  active: Pick<NonNullable<AutoDeliverRun['activeAudit']>, 'roundIndex' | 'attemptId' | 'generation'> & { discussionFilePath?: string },
): OpenSpecAutoDeliverAuditResult {
  const result: OpenSpecAutoDeliverAuditResult = {
    stage,
    roundIndex: active.roundIndex,
    attemptId: active.attemptId,
    generation: active.generation,
    ...(active.discussionFilePath ? { discussionFilePath: active.discussionFilePath } : {}),
    verdict: verdict.verdict,
    moduleScores: verdict.module_scores.map((score) => ({ ...score })),
    uncheckedTasks: [...verdict.unchecked_tasks],
    requiredChanges: [...verdict.required_changes],
    repairSummaries: verdict.repairs_applied.map((repair) => ({
      files: [...repair.files],
      reason: repair.reason,
    })),
    evidence: verdict.evidence.map((entry) => ({ ...entry })),
    completedAt: Date.now(),
  };
  run.auditResults = [...(run.auditResults ?? []), result].slice(-20);
  return result;
}

function scoreSnapshotFromAuditResult(
  result: OpenSpecAutoDeliverAuditResult,
  phase: OpenSpecAutoDeliverScoreSnapshot['phase'],
  summary: string,
): OpenSpecAutoDeliverScoreSnapshot {
  return {
    phase,
    stage: result.stage,
    roundIndex: result.roundIndex,
    attemptId: result.attemptId,
    generation: result.generation,
    verdict: result.verdict,
    moduleScores: result.moduleScores.map((score) => ({ ...score })),
    summary,
    completedAt: result.completedAt,
  };
}

function lowScoringModules(verdict: OpenSpecAutoDeliverVerdictPayload): OpenSpecAutoDeliverModuleScore[] {
  return verdict.module_scores.filter((score) => score.score < OPENSPEC_AUTO_DELIVER_MIN_ACCEPTABLE_MODULE_SCORE);
}

function isPerfectPass(verdict: OpenSpecAutoDeliverVerdictPayload): boolean {
  return verdict.verdict === 'PASS'
    && verdict.unchecked_tasks.length === 0
    && verdict.required_changes.length === 0
    && verdict.module_scores.every((score) => score.score === score.max_score);
}

function maxRuntimeAuditRoundLimit(stage: AuditRepairStage): number {
  return stage === 'spec_audit_repair'
    ? OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_ROUNDS_MAX
    : OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_ROUNDS_MAX;
}

function extendAuditRoundLimit(run: AutoDeliverRun, stage: AuditRepairStage): void {
  const nextLimit = Math.min(auditRoundCount(run, stage) + 1, maxRuntimeAuditRoundLimit(stage));
  if (stage === 'spec_audit_repair') {
    run.materializedLimits.specAuditRepairRounds = Math.max(run.materializedLimits.specAuditRepairRounds, nextLimit);
    return;
  }
  run.materializedLimits.implementationAuditRepairRounds = Math.max(run.materializedLimits.implementationAuditRepairRounds, nextLimit);
}

/**
 * Ensure there is budget for another audit-repair round. The preset round count
 * is the BASE, not a hard ceiling: when the audit score is still below standard
 * the budget auto-increments toward the runtime MAX (implementation 5, spec 3)
 * so the run keeps converging to a quality delivery instead of giving up after
 * the preset base. Returns false only when even the runtime MAX is spent — that
 * is the genuine escalation point.
 */
function ensureAuditRoundBudget(run: AutoDeliverRun, stage: AuditRepairStage): boolean {
  if (auditRoundCount(run, stage) < auditRoundLimit(run, stage)) return true;
  extendAuditRoundLimit(run, stage);
  return auditRoundCount(run, stage) < auditRoundLimit(run, stage);
}

function scheduleAuditFixRetry(run: AutoDeliverRun, stage: AuditRepairStage, reason: string): void {
  clearAuditFixRetryTimer(run.runId);
  run.status = stage;
  run.stage = stage;
  run.latestMessage = reason;
  emitHumanInterventionPrompt(run, reason, {
    recoverable: true,
    waitMs: OPENSPEC_AUTO_DELIVER_AUDIT_FIX_RETRY_WAIT_MS,
    eventSuffix: 'audit-fix-gate',
  });
  broadcastProjection(run);
  auditFixRetryTimers.set(run.runId, setTimeout(() => {
    auditFixRetryTimers.delete(run.runId);
    const current = runsById.get(run.runId);
    if (!current || isOpenSpecAutoDeliverTerminalStage(current.status)) return;
    if (current.activeAudit) return;
    if (!ensureAuditRoundBudget(current, stage)) {
      terminalizeAndSend(current, 'needs_human', stage === 'spec_audit_repair'
        ? 'spec_audit_rounds_exhausted'
        : 'implementation_audit_rounds_exhausted');
      return;
    }
    void startAuditRepairStageFailClosed(current, stage);
  }, OPENSPEC_AUTO_DELIVER_AUDIT_FIX_RETRY_WAIT_MS));
}

function shouldRunAnotherConfiguredAuditRound(
  run: AutoDeliverRun,
  stage: AuditRepairStage,
  verdict?: OpenSpecAutoDeliverVerdictPayload,
): boolean {
  if (verdict && isPerfectPass(verdict)) return false;
  return auditRoundCount(run, stage) < auditRoundLimit(run, stage);
}

async function advanceAfterAuditVerdict(
  run: AutoDeliverRun,
  stage: AuditRepairStage,
  verdict: OpenSpecAutoDeliverVerdictPayload,
  active: Pick<NonNullable<AutoDeliverRun['activeAudit']>, 'roundIndex' | 'attemptId' | 'generation'> & {
    discussionFilePath?: string;
    postRepairVerification?: boolean;
  },
): Promise<void> {
  if (enforceElapsedLimit(run)) return;
  run.latestVerdict = verdict.verdict;
  run.moduleScores = verdict.module_scores.map((score) => ({ ...score }));
  const auditResult = recordAuditResult(run, stage, verdict, active);
  run.evidence = mergeEvidence(run.evidence, verdict.evidence.map((entry) => ({ ...entry })), {
    staleExisting: verdict.repairs_applied.length > 0,
  });
  run.latestRepairSummary = repairSummaryText(verdict.repairs_applied) ?? run.latestRepairSummary;
  try {
    run.taskStats = await readTaskStatsForRun(run);
  } catch {
    terminalizeAndSend(run, 'needs_human', 'tasks_unreadable');
    return;
  }

  const postRepairVerification = active.postRepairVerification === true;
  const lowScores = lowScoringModules(verdict);
  if (lowScores.length > 0) {
    const reason = `quality_gate_low_score:${lowScores.map((score) => `${score.module}=${score.score}`).join(',')}`;
    if (postRepairVerification) {
      run.finalAfterRepair = scoreSnapshotFromAuditResult(auditResult, 'final_after_repair', reason);
      scheduleAuditFixRetry(run, stage, reason);
      return;
    }
    if (stage === 'implementation_audit_repair') {
      run.auditBeforeRepair = scoreSnapshotFromAuditResult(auditResult, 'audit_before_repair', reason);
      await dispatchImplementationRepairPrompt(run, reason);
      return;
    }
    scheduleAuditFixRetry(run, stage, reason);
    return;
  }

  if (stage === 'spec_audit_repair') {
    if (verdict.verdict === 'BLOCKED') {
      const projection = terminalize(run, 'needs_human', 'spec_audit_blocked');
      send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
      return;
    }
    if (verdict.verdict === 'REWORK') {
      if (postRepairVerification) {
        run.finalAfterRepair = scoreSnapshotFromAuditResult(auditResult, 'final_after_repair', 'spec_audit_rework_requires_repair');
        scheduleAuditFixRetry(run, stage, 'spec_audit_rework_requires_repair');
        return;
      }
      if (shouldRunAnotherConfiguredAuditRound(run, stage)) {
        await startAuditRepairStageFailClosed(run, stage);
        return;
      }
      scheduleAuditFixRetry(run, stage, 'spec_audit_rework_requires_repair');
      return;
    }
    if (postRepairVerification) {
      run.finalAfterRepair = scoreSnapshotFromAuditResult(auditResult, 'final_after_repair', 'spec_audit_passed');
      run.moduleScores = run.finalAfterRepair.moduleScores.map((score) => ({ ...score }));
      run.needsPostRepairAcceptanceAudit = false;
      run.postRepairAcceptanceStage = undefined;
    } else if (shouldRunAnotherConfiguredAuditRound(run, stage, verdict)) {
      await startAuditRepairStageFailClosed(run, stage);
      return;
    }
    run.latestMessage = 'spec_audit_passed';
    run.evidence = mergeEvidence(run.evidence, await buildValidationEvidence(run));
    await dispatchImplementationPrompt(run);
    return;
  }

  if (verdict.verdict === 'BLOCKED') {
    run.auditBeforeRepair = scoreSnapshotFromAuditResult(auditResult, 'audit_before_repair', 'implementation_audit_blocked');
    const projection = terminalize(run, 'needs_human', 'implementation_audit_blocked');
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }

  if (verdict.verdict === 'REWORK') {
    if (postRepairVerification) {
      run.finalAfterRepair = scoreSnapshotFromAuditResult(auditResult, 'final_after_repair', 'implementation_audit_rework_requires_repair');
      scheduleAuditFixRetry(run, stage, 'implementation_audit_rework_requires_repair');
      return;
    }
    run.auditBeforeRepair = scoreSnapshotFromAuditResult(auditResult, 'audit_before_repair', 'implementation_audit_rework_requires_repair');
    await dispatchImplementationRepairPrompt(run, 'implementation_audit_rework_requires_repair');
    return;
  }

  if (verdict.verdict === 'PASS') {
    const gitEvidence = await collectGitEvidence(run);
    const currentRunChangedFiles = await currentRunProductFiles(run, gitEvidence.changedFiles);
    run.evidence = mergeEvidence(run.evidence, [
      {
        source: 'daemon',
        summary: gitEvidence.changedFiles.length > 0
          ? `Fresh changed files: ${gitEvidence.changedFiles.join(', ')}.`
          : 'Fresh changed files: none reported by git.',
        stale: false,
      },
      {
        source: 'daemon',
        summary: gitEvidence.diffStat ? `Fresh diff stat: ${gitEvidence.diffStat}` : 'Fresh diff stat: none reported by git.',
        stale: false,
      },
    ]);
    if (currentRunChangedFiles.length > 0 && verdict.repairs_applied.length === 0) {
      run.auditBeforeRepair = scoreSnapshotFromAuditResult(auditResult, 'audit_before_repair', 'audit_pass_with_changed_files_without_repairs');
      await dispatchImplementationRepairPrompt(run, 'audit_pass_with_changed_files_without_repairs');
      return;
    }
    const finalFailure = validateFinalPass(run, verdict, currentRunChangedFiles);
    if (finalFailure) {
      run.auditBeforeRepair = scoreSnapshotFromAuditResult(auditResult, 'audit_before_repair', finalFailure);
      await dispatchImplementationRepairPrompt(run, finalFailure);
      return;
    }
    if (!postRepairVerification) {
      run.auditBeforeRepair = scoreSnapshotFromAuditResult(auditResult, 'audit_before_repair', OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_FOLLOWUP_REPAIR_REASON);
      await dispatchImplementationRepairPrompt(run, OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_FOLLOWUP_REPAIR_REASON);
      return;
    }
    run.finalAfterRepair = scoreSnapshotFromAuditResult(auditResult, 'final_after_repair', 'final_audit_passed');
    run.moduleScores = run.finalAfterRepair.moduleScores.map((score) => ({ ...score }));
    run.needsPostRepairAcceptanceAudit = false;
    run.postRepairAcceptanceStage = undefined;
    if (run.autoCommitPush) {
      await dispatchAutoCommitPushPrompt(run);
      return;
    }
    const projection = terminalize(run, 'passed', 'final_audit_passed');
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }
}

async function handleAuditPoll(runId: string, expected: OpenSpecAutoDeliverP2pMetadata): Promise<void> {
  const run = runsById.get(runId);
  if (!run || isOpenSpecAutoDeliverTerminalStage(run.status)) return;
  if (enforceElapsedLimit(run)) return;
  const active = run.activeAudit;
  if (
    !active
    || active.attemptId !== expected.attemptId
    || active.stage !== expected.stage
    || active.selectedTeamComboId !== expected.selectedTeamComboId
    || active.activeOpenSpecPromptId !== expected.activeOpenSpecPromptId
    || active.generation !== expected.generation
  ) {
    return;
  }
  const p2pRun = getP2pRun(active.p2pRunId);
  if (!p2pRun || !P2P_TERMINAL_RUN_STATUSES.has(p2pRun.status)) {
    auditPollTimers.set(runId, setTimeout(() => { void handleAuditPoll(runId, expected); }, 1000));
    return;
  }
  clearAuditPollTimer(runId);
  // The Team audit discussion's by-design post-summary execution gate may end
  // with a `failed` marker (or a gate timeout) when the agent could not finish
  // ALL the repair in a single hop — even though it produced the full audit
  // analysis and repair guidance in the discussion file. The auto-deliver flow
  // does NOT depend on that gate: the repair is a SEPARATE dispatch and the
  // SCORE comes from the acceptance audit. So treat a post-summary gate failure
  // as "discussion usable" and proceed to repair + scoring below. Re-running the
  // discussion instead would loop forever — incrementing rounds without ever
  // producing a score. Genuine failures (dispatch_failed, the discussion itself
  // timing out, cancellation, etc.) still escalate to needs_human.
  const usableGateFailure = p2pRun.status !== 'completed'
    && (expected.stage === 'spec_audit_repair' || expected.stage === 'implementation_audit_repair')
    && isPostSummaryExecutionGateFailure(p2pRun.error);
  if (p2pRun.status !== 'completed' && !usableGateFailure) {
    run.evidence = mergeEvidence(run.evidence, [{
      source: 'daemon',
      summary: p2pAuditFailureSummary(p2pRun),
      stale: false,
    }]);
    run.activeAudit = undefined;
    const projection = terminalize(run, 'needs_human', 'audit_p2p_failed');
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }
  if (usableGateFailure) {
    run.evidence = mergeEvidence(run.evidence, [{
      source: 'daemon',
      summary: `Audit discussion analysis is usable; its post-summary execution gate did not complete (${p2pRun.error ?? 'no completion marker'}). Proceeding to repair + acceptance scoring instead of re-running the discussion.`,
      stale: false,
    }]);
  }
  if (expected.stage === 'spec_audit_repair' || expected.stage === 'implementation_audit_repair') {
    run.activeAudit = undefined;
    if (expected.stage === 'spec_audit_repair') {
      run.specAuditDiscussionFilePath = p2pRun.contextFilePath;
    } else {
      run.implementationAuditDiscussionFilePath = p2pRun.contextFilePath;
    }
    run.evidence = mergeEvidence(run.evidence, [{
      source: 'daemon',
      summary: expected.stage === 'spec_audit_repair'
        ? `Spec audit discussion completed: ${p2pRun.contextFilePath}. Artifact repair will use this discussion before final acceptance scoring.`
        : `Implementation audit discussion completed: ${p2pRun.contextFilePath}. Execution repair will use this discussion before final acceptance scoring.`,
      stale: false,
    }]);
    const projection = expected.stage === 'spec_audit_repair'
      ? dispatchSpecRepairPrompt(run, 'spec_audit_followup_repair')
      : await dispatchImplementationRepairPrompt(run, OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_FOLLOWUP_REPAIR_REASON);
    if (isOpenSpecAutoDeliverTerminalStage(projection.status)) {
      send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    }
    return;
  }
  const verdict = await consumeAuditResultFile(run, expected);
  if (!verdict) {
    const reason = run.latestMessage ?? 'invalid_audit_result';
    if (isRetryableAuditResultError(reason) && !active.resultFileRepairAttempted) {
      active.resultFileRepairAttempted = true;
      run.activeAudit = active;
      if (dispatchAuditResultFileRepairPrompt(run, expected, p2pRun, reason)) {
        auditPollTimers.set(runId, setTimeout(() => { void handleAuditPoll(runId, expected); }, 1000));
        return;
      }
    }
    run.activeAudit = undefined;
    const projection = terminalize(run, 'needs_human', reason);
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }
  const completedAudit = { ...active, discussionFilePath: p2pRun.contextFilePath };
  run.activeAudit = undefined;
  await advanceAfterAuditVerdict(run, expected.stage, verdict, completedAudit).catch((error) => {
    terminalizeAndSend(run, 'failed', error instanceof Error ? error.message : 'audit_advance_failed');
  });
}

async function startAuditRepairStage(run: AutoDeliverRun, stage: AuditRepairStage): Promise<OpenSpecAutoDeliverProjection> {
  const elapsedProjection = enforceElapsedLimit(run);
  if (elapsedProjection) return elapsedProjection;
  const event: OpenSpecAutoDeliverTransitionEvent = stage === 'spec_audit_repair'
    ? 'spec_audit_started'
    : 'implementation_audit_started';
  if (!transitionAllowed(run, event)) {
    return terminalizeAndSend(run, 'failed', `invalid_transition_${stage}`);
  }
  if (!ensureAuditRoundBudget(run, stage)) {
    const reason = stage === 'spec_audit_repair'
      ? 'spec_audit_rounds_exhausted'
      : 'implementation_audit_rounds_exhausted';
    return terminalizeAndSend(run, 'needs_human', reason);
  }
  if (!(await refreshChangeRoot(run))) {
    return terminalizeAndSend(run, 'failed', run.latestMessage ?? 'change_root_invalid');
  }
  const activeOpenSpecPromptId = activeOpenSpecPromptIdForAutoDeliverStage(stage);
  const compatibility = evaluateOpenSpecAutoDeliverComboCompatibility(run.selectedTeamComboId, stage, activeOpenSpecPromptId);
  if (!compatibility.ok) {
    return terminalizeAndSend(run, 'failed', compatibility.reason ?? 'selected_combo_unavailable');
  }
  const targetSelection = await resolveConfiguredP2pTargets({
    initiatorSession: run.targetImplementationSessionName,
    mode: run.selectedTeamComboId,
    serverLink: run.serverLink,
  });
  if (!targetSelection.ok) {
    return terminalizeAndSend(run, 'needs_human', targetSelection.error);
  }
  const hopTimeoutMs = targetSelection.savedConfig?.hopTimeoutMinutes != null
    ? Math.min(targetSelection.savedConfig.hopTimeoutMinutes * 60_000, 600_000)
    : undefined;
  const roundIndex = incrementAuditRound(run, stage);
  const attemptId = `${run.runId}:${stage}:${run.generation}:${roundIndex}`;
  const authoritativeResultPath = await buildAuthoritativeResultPath(run, stage, run.generation, roundIndex);
  const metadata: OpenSpecAutoDeliverP2pMetadata = {
    owner: 'openspec_auto_deliver',
    runId: run.runId,
    owningMainSessionName: run.owningMainSessionName,
    executionSessionName: run.targetImplementationSessionName,
    changeName: run.changeName,
    resolvedChangeRootIdentity: run.changeRootIdentity,
    stage,
    selectedTeamComboId: run.selectedTeamComboId,
    activeOpenSpecPromptId,
    roundIndex,
    attemptId,
    authoritativeResultPath,
    generation: run.generation,
  };
  run.status = stage;
  run.stage = stage;
  run.latestMessage = `${stage}_started`;
  if (stage === 'implementation_audit_repair') {
    const gitEvidence = await collectGitEvidence(run);
    run.evidence = [
      ...(run.evidence ?? []),
      {
        source: 'daemon',
        summary: gitEvidence.changedFiles.length > 0
          ? `Changed files: ${gitEvidence.changedFiles.join(', ')}.`
          : 'Changed files: none reported by git diff.',
        stale: false,
      },
      {
        source: 'daemon',
        summary: gitEvidence.diffStat
          ? `Diff stat: ${gitEvidence.diffStat}`
          : 'Diff stat: none reported by git diff.',
        stale: false,
      },
    ];
  }
  run.activeAudit = {
    p2pRunId: '',
    selectedTeamComboId: run.selectedTeamComboId,
    activeOpenSpecPromptId,
    stage,
    attemptId,
    authoritativeResultPath,
    roundIndex,
    generation: run.generation,
  };
  registerAutoDeliverP2pLock({
    runId: run.runId,
    owningMainSessionName: run.owningMainSessionName,
    generation: run.generation,
    stage,
    roundIndex,
    selectedTeamComboId: run.selectedTeamComboId,
    activeOpenSpecPromptId,
  });
  const p2pRun = await startP2pRun({
    initiatorSession: run.targetImplementationSessionName,
    targets: targetSelection.targets,
    userText: buildAuditRequestText(run, metadata),
    fileContents: [],
    serverLink: run.serverLink,
    modeOverride: run.selectedTeamComboId,
    rounds: 1,
    hopTimeoutMs,
    locale: run.locale,
    // Hop prompts never embed the request text, and the post-summary execution
    // gate (whose full request restatement used to smuggle these requirements
    // into the final summary turn) is skipped for Auto Deliver runs — so the
    // scorecard output contract must be restated on the final summary
    // explicitly, or the discussion ships without the "repair scorecard"
    // section the acceptance audit hard-depends on.
    finalSummaryExtraInstruction: buildTeamRepairScorecardInstructions(stage).join('\n'),
    launchOrigin: {
      kind: 'openspec_auto_deliver',
      commandId: attemptId,
      autoDeliver: {
        runId: run.runId,
        changeName: run.changeName,
        owningMainSessionName: run.owningMainSessionName,
        generation: run.generation,
        stage,
        roundIndex,
        attemptId,
        authoritativeResultPath,
        selectedTeamComboId: run.selectedTeamComboId,
        activeOpenSpecPromptId,
      },
    },
  });
  run.activeAudit = {
    ...run.activeAudit,
    p2pRunId: p2pRun.id,
  };
  run.latestMessage = `${stage}_p2p_started`;
  auditPollTimers.set(run.runId, setTimeout(() => { void handleAuditPoll(run.runId, metadata); }, 1000));
  return broadcastProjection(run);
}

async function startAuditRepairStageFailClosed(run: AutoDeliverRun, stage: AuditRepairStage): Promise<OpenSpecAutoDeliverProjection> {
  try {
    return await startAuditRepairStage(run, stage);
  } catch (error) {
    return terminalizeAndSend(run, 'failed', error instanceof Error ? error.message : `${stage}_start_failed`);
  }
}

async function advanceAfterImplementationIdle(run: AutoDeliverRun): Promise<void> {
  if (run.status !== 'implementation_task_loop' || !run.activeCommandId) return;
  if (enforceElapsedLimit(run)) return;
  try {
    run.taskStats = await readTaskStatsForRun(run);
  } catch {
    delete run.activeCommandId;
    terminalizeAndSend(run, 'needs_human', 'tasks_unreadable');
    return;
  }
  if (run.taskStats.total <= 0) {
    delete run.activeCommandId;
    const projection = terminalize(run, 'needs_human', 'tasks_missing_checkboxes');
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }
  if (run.taskStats.unchecked <= 0) {
    const markerState = await readImplementationCompletionMarker(run);
    if (!markerState.ok) {
      if (markerState.failedByAgent) {
        run.evidence = mergeEvidence(run.evidence, [{
          source: 'implementation_reported',
          summary: `Implementation completion marker reported failure: ${markerState.reason}`,
          command: run.activeCommandId,
          stale: false,
        }]);
        const projection = terminalize(run, 'needs_human', `implementation_marker_failed:${markerState.reason}`);
        send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
        return;
      }
      const projection = await dispatchImplementationMarkerReminder(run, markerState.reason);
      if (isOpenSpecAutoDeliverTerminalStage(projection.status)) {
        send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
      }
      return;
    }
    recordImplementationMarkerEvidence(run, markerState.marker);
    clearImplementationReminderTimer(run.runId);
    delete run.activeCommandId;
    delete run.activeImplementationMarker;
    if (run.needsPostRepairAcceptanceAudit || run.auditBeforeRepair || run.implementationAuditDiscussionFilePath) {
      await dispatchPostRepairAcceptanceAuditPrompt(run);
      return;
    }
    if (run.materializedLimits.implementationAuditRepairRounds <= 0) {
      const projection = terminalize(run, 'needs_human', 'implementation_audit_required');
      send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
      return;
    }
    await startAuditRepairStageFailClosed(run, 'implementation_audit_repair');
    return;
  }
  const projection = await dispatchImplementationMarkerReminder(run, 'implementation_tasks_still_unchecked');
  if (isOpenSpecAutoDeliverTerminalStage(projection.status)) {
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
  }
}

async function advanceAfterSpecRepairIdle(run: AutoDeliverRun): Promise<void> {
  if (run.status !== 'spec_audit_repair' || !run.activeCommandId || run.activeAcceptanceAudit) return;
  if (enforceElapsedLimit(run)) return;
  delete run.activeCommandId;
  try {
    run.taskStats = await readTaskStatsForRun(run);
  } catch {
    terminalizeAndSend(run, 'needs_human', 'tasks_unreadable');
    return;
  }
  await dispatchPostRepairAcceptanceAuditPrompt(run);
}

async function advanceAfterPostRepairAcceptanceAuditIdle(run: AutoDeliverRun): Promise<void> {
  if (!run.activeAcceptanceAudit || run.status !== run.activeAcceptanceAudit.stage || !run.activeCommandId) return;
  if (enforceElapsedLimit(run)) return;
  delete run.activeCommandId;
  const active = run.activeAcceptanceAudit;
  const metadata = acceptanceAuditMetadataFromActive(run, active);
  const verdict = await consumeAuditResultFile(run, metadata);
  if (!verdict) {
    const reason = run.latestMessage ?? 'invalid_audit_result';
    if (isRetryableAuditResultError(reason) && !active.resultFileRepairAttempted) {
      const projection = dispatchPostRepairAcceptanceAuditResultRepairPrompt(run, active, reason);
      if (isOpenSpecAutoDeliverTerminalStage(projection.status)) {
        send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
      }
      return;
    }
    run.activeAcceptanceAudit = undefined;
    const projection = terminalize(run, 'needs_human', reason);
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }
  run.activeAcceptanceAudit = undefined;
  await advanceAfterAuditVerdict(run, active.stage, verdict, {
    roundIndex: active.roundIndex,
    attemptId: active.attemptId,
    generation: active.generation,
    postRepairVerification: true,
  }).catch((error) => {
    terminalizeAndSend(run, 'failed', error instanceof Error ? error.message : 'post_repair_acceptance_audit_advance_failed');
  });
}

function ensureTimelineListener(): void {
  if (timelineUnsubscribe) return;
  timelineUnsubscribe = timelineEmitter.on((event) => {
    if (event.type === 'assistant.text') {
      const run = Array.from(runsById.values()).find((candidate) =>
        !isOpenSpecAutoDeliverTerminalStage(candidate.status)
        && candidate.targetImplementationSessionName === event.sessionId
        && (candidate.status === 'implementation_task_loop' || candidate.status === 'commit_push')
        && !!candidate.activeCommandId
      );
      const text = typeof event.payload.text === 'string' ? event.payload.text.trim() : '';
      const eventCommandId = typeof (event.payload as Record<string, unknown>).commandId === 'string'
        ? (event.payload as Record<string, unknown>).commandId
        : undefined;
      const streaming = (event.payload as Record<string, unknown>).streaming === true;
      const memoryExcluded = (event.payload as Record<string, unknown>).memoryExcluded === true;
      if (run && text.length > 0 && !streaming && !memoryExcluded && (!eventCommandId || eventCommandId === run.activeCommandId)) {
        recordImplementationReportedEvidence(run, text);
      }
      return;
    }
    if (event.type === 'user.message') return;
    if (event.type !== 'session.state') return;
    if ((event.payload as Record<string, unknown>).state !== 'idle') return;
    const activeCandidates = Array.from(runsById.values()).filter((candidate) =>
      !isOpenSpecAutoDeliverTerminalStage(candidate.status)
      && candidate.targetImplementationSessionName === event.sessionId
    );
    const commitPushRun = activeCandidates.find((candidate) =>
      candidate.status === 'commit_push'
      && !!candidate.activeCommandId
    );
    if (commitPushRun) {
      void advanceAfterAutoCommitPushIdle(commitPushRun).catch((error) => {
        terminalizeAndSend(commitPushRun, 'failed', error instanceof Error ? error.message : 'auto_commit_push_idle_advance_failed');
      });
      return;
    }
    const acceptanceAuditRun = activeCandidates.find((candidate) =>
      candidate.status === candidate.activeAcceptanceAudit?.stage
      && !!candidate.activeCommandId
      && !!candidate.activeAcceptanceAudit
    );
    if (acceptanceAuditRun) {
      void advanceAfterPostRepairAcceptanceAuditIdle(acceptanceAuditRun).catch((error) => {
        terminalizeAndSend(acceptanceAuditRun, 'failed', error instanceof Error ? error.message : 'post_repair_acceptance_audit_idle_advance_failed');
      });
      return;
    }
    const specRepairRun = activeCandidates.find((candidate) =>
      candidate.status === 'spec_audit_repair'
      && !!candidate.activeCommandId
      && !candidate.activeAcceptanceAudit
    );
    if (specRepairRun) {
      void advanceAfterSpecRepairIdle(specRepairRun).catch((error) => {
        terminalizeAndSend(specRepairRun, 'failed', error instanceof Error ? error.message : 'spec_repair_idle_advance_failed');
      });
      return;
    }
    const run = activeCandidates.find((candidate) =>
      candidate.status === 'implementation_task_loop'
      && !!candidate.activeCommandId
    );
    if (!run) return;
    void advanceAfterImplementationIdle(run).catch((error) => {
      terminalizeAndSend(run, 'failed', error instanceof Error ? error.message : 'implementation_idle_advance_failed');
    });
  });
}

async function launch(request: OpenSpecAutoDeliverLaunchRequest, serverLink: ServerLink): Promise<LaunchResult> {
  ensureTimelineListener();
  const launchValidation = validateOpenSpecAutoDeliverLaunchRequest(request);
  if (!launchValidation.ok) {
    const first = launchValidation.issues[0];
    if (first?.path === 'changeName') return { ok: false, error: 'invalid_change_name' };
    if (first?.path === 'requestId') return { ok: false, error: 'invalid_request_id' };
    return { ok: false, error: first?.code ?? 'invalid_launch_request' };
  }
  const requestId = validateOpenSpecAutoDeliverRequestId(launchValidation.value.requestId);
  if (!requestId.ok) return { ok: false, error: 'invalid_request_id' };

  const change = validateOpenSpecAutoDeliverChangeSlug(launchValidation.value.changeName);
  if (!change.ok) return { ok: false, error: 'invalid_change_name' };
  const sessionName = launchValidation.value.sessionName;
  const session = sessionName ? getSession(sessionName) : undefined;
  if (!session) return { ok: false, error: 'missing_session' };
  if (session.runtimeType !== 'transport') return { ok: false, error: 'unsupported_runtime' };

  const owner = resolveOpenSpecAutoDeliverOwningMainSession(sessionName);
  const presetId = launchValidation.value.presetId;
  const materializedLimits = launchValidation.value.materializedLimits ?? materializeOpenSpecAutoDeliverPreset(presetId);
  const selectedTeamComboId = launchValidation.value.selectedTeamComboId ?? OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID;
  const locale = launchValidation.value.locale;
  const autoCommitPush = launchValidation.value.autoCommitPush === true;
  const launchFingerprint = openSpecAutoDeliverLaunchFingerprint({
    requestId: requestId.value,
    sessionName,
    changeName: change.value,
    presetId,
    selectedTeamComboId,
    locale,
    autoCommitPush,
    materializedLimits,
  });
  const cached = requestProjectionByFingerprint.get(launchFingerprint);
  if (cached) return { ok: true, projection: cached };
  const existing = activeRunForOwner(owner);
  if (existing && !isOpenSpecAutoDeliverTerminalStage(existing.status)) {
    return { ok: false, error: 'auto_deliver_active', projection: buildProjection(existing) };
  }
  if (hasActiveP2pRunForMainSession(listP2pRuns(), owner)) {
    return { ok: false, error: 'team_lane_busy' };
  }
  const firstAuditStage: AuditRepairStage = materializedLimits.specAuditRepairRounds > 0
    ? 'spec_audit_repair'
    : 'implementation_audit_repair';
  const compatibility = evaluateOpenSpecAutoDeliverComboCompatibility(
    selectedTeamComboId,
    firstAuditStage,
    activeOpenSpecPromptIdForAutoDeliverStage(firstAuditStage),
  );
  if (!compatibility.ok) return { ok: false, error: compatibility.reason ?? 'selected_combo_unavailable' };
  const targetSelection = await resolveConfiguredP2pTargets({
    initiatorSession: sessionName,
    mode: selectedTeamComboId,
    serverLink,
  });
  if (!targetSelection.ok) return { ok: false, error: targetSelection.error };

  registerAutoDeliverP2pLock({
    runId: `launch:${owner}`,
    owningMainSessionName: owner,
    generation: 0,
    selectedTeamComboId,
  });
  const resolved = await resolveChangeRoot(sessionName, change.value);
  if (!resolved.ok) {
    releaseAutoDeliverP2pLock(owner, `launch:${owner}`);
    return { ok: false, error: resolved.error };
  }
  const taskStats = await readTaskStats(resolved.root).catch(() => null);
  if (!taskStats || taskStats.total <= 0) {
    releaseAutoDeliverP2pLock(owner, `launch:${owner}`);
    return { ok: false, error: 'tasks_missing_checkboxes' };
  }
  const now = Date.now();
  const run: AutoDeliverRun = {
    runId: `auto_${randomUUID().slice(0, 12)}`,
    changeName: change.value,
    projectRoot: resolved.projectRoot,
    changeRoot: resolved.root,
    changeRootIdentity: resolved.root,
    owningMainSessionName: owner,
    launchedFromSessionName: sessionName,
    targetImplementationSessionName: sessionName,
    presetId,
    selectedTeamComboId,
    ...(locale ? { locale } : {}),
    autoCommitPush,
    materializedLimits,
    status: 'proposed',
    stage: 'proposed',
    generation: 1,
    projectionVersion: 1,
    startedAt: now,
    updatedAt: now,
    implementationPromptCount: 0,
    specAuditRepairRound: 0,
    implementationAuditRepairRound: 0,
    taskStats,
    latestMessage: taskStats.total === 0 ? 'tasks_missing_checkboxes' : 'ready',
    evidence: [],
    requestIds: new Map(),
    serverLink,
  };
  runsById.set(run.runId, run);
  activeRunByOwner.set(owner, run.runId);
  registerAutoDeliverP2pLock({
    runId: run.runId,
    owningMainSessionName: owner,
    generation: run.generation,
    selectedTeamComboId: run.selectedTeamComboId,
  });
  const projection = buildProjection(run);
  run.requestIds.set(launchFingerprint, projection);
  requestProjectionByFingerprint.set(launchFingerprint, projection);
  return { ok: true, projection };
}

async function stop(request: OpenSpecAutoDeliverStopRequest): Promise<{ ok: boolean; projection?: OpenSpecAutoDeliverProjection; error?: string; terminal?: boolean }> {
  const run = runsById.get(request.runId);
  if (!run) return { ok: false, error: 'run_not_found' };
  if (request.sessionName !== run.owningMainSessionName && request.sessionName !== run.launchedFromSessionName && request.sessionName !== run.targetImplementationSessionName) {
    return { ok: false, error: 'forbidden' };
  }
  if (isOpenSpecAutoDeliverTerminalStage(run.status)) {
    return { ok: true, projection: buildProjection(run), terminal: false };
  }
  const projection = terminalize(run, 'stopped', 'user_stopped');
  return { ok: true, projection, terminal: true };
}

function inferResumeStage(run: AutoDeliverRun): Extract<OpenSpecAutoDeliverStage, 'proposed' | 'spec_audit_repair' | 'implementation_task_loop' | 'implementation_audit_repair' | 'commit_push'> {
  if (
    run.resumeStage === 'proposed'
    || run.resumeStage === 'spec_audit_repair'
    || run.resumeStage === 'implementation_task_loop'
    || run.resumeStage === 'implementation_audit_repair'
    || run.resumeStage === 'commit_push'
  ) {
    return run.resumeStage;
  }
  if (run.terminalReason?.startsWith('spec_audit_')) return 'spec_audit_repair';
  if (run.terminalReason?.startsWith('implementation_audit_')) return 'implementation_audit_repair';
  return run.taskStats.unchecked > 0 ? 'implementation_task_loop' : 'implementation_audit_repair';
}

async function continueRun(request: OpenSpecAutoDeliverContinueRequest): Promise<{ ok: boolean; projection?: OpenSpecAutoDeliverProjection; error?: string; terminal?: boolean }> {
  const run = runsById.get(request.runId);
  if (!run) return { ok: false, error: 'run_not_found' };
  if (request.sessionName !== run.owningMainSessionName && request.sessionName !== run.launchedFromSessionName && request.sessionName !== run.targetImplementationSessionName) {
    return { ok: false, error: 'forbidden' };
  }
  if (!canContinueRun(run)) return { ok: false, error: 'run_not_continuable', projection: buildProjection(run), terminal: false };
  const active = activeRunByOwner.get(run.owningMainSessionName);
  if (active && active !== run.runId) return { ok: false, error: 'auto_deliver_active', projection: buildProjection(run), terminal: false };
  try {
    run.taskStats = await readTaskStatsForRun(run);
  } catch {
    run.latestMessage = 'tasks_unreadable';
    return { ok: false, error: 'tasks_unreadable', projection: buildProjection(run), terminal: false };
  }

  const resumeStage = inferResumeStage(run);
  delete run.terminalReason;
  run.resumeStage = undefined;
  run.status = resumeStage;
  run.stage = resumeStage;
  run.latestMessage = 'continue_requested';
  activeRunByOwner.set(run.owningMainSessionName, run.runId);
  terminalRunByOwner.delete(run.owningMainSessionName);
  registerAutoDeliverP2pLock({
    runId: run.runId,
    owningMainSessionName: run.owningMainSessionName,
    generation: run.generation,
    selectedTeamComboId: run.selectedTeamComboId,
  });

  if (resumeStage === 'spec_audit_repair') {
    if (auditRoundCount(run, 'spec_audit_repair') >= auditRoundLimit(run, 'spec_audit_repair')) extendAuditRoundLimit(run, 'spec_audit_repair');
    const projection = await startAuditRepairStageFailClosed(run, 'spec_audit_repair');
    return { ok: true, projection };
  }
  if (resumeStage === 'implementation_audit_repair') {
    if (auditRoundCount(run, 'implementation_audit_repair') >= auditRoundLimit(run, 'implementation_audit_repair')) extendAuditRoundLimit(run, 'implementation_audit_repair');
    const projection = await startAuditRepairStageFailClosed(run, 'implementation_audit_repair');
    return { ok: true, projection };
  }
  if (resumeStage === 'commit_push') {
    await dispatchAutoCommitPushPrompt(run);
    return { ok: true, projection: buildProjection(run) };
  }
  if (resumeStage === 'proposed' && run.materializedLimits.specAuditRepairRounds > 0) {
    const projection = await startAuditRepairStageFailClosed(run, 'spec_audit_repair');
    return { ok: true, projection };
  }
  if (run.taskStats.unchecked <= 0) {
    if (auditRoundCount(run, 'implementation_audit_repair') >= auditRoundLimit(run, 'implementation_audit_repair')) extendAuditRoundLimit(run, 'implementation_audit_repair');
    const projection = await startAuditRepairStageFailClosed(run, 'implementation_audit_repair');
    return { ok: true, projection };
  }
  return { ok: true, projection: await dispatchImplementationPrompt(run) };
}

async function status(request: OpenSpecAutoDeliverStatusRequest): Promise<OpenSpecAutoDeliverProjection | null> {
  const run = latestRunForSession(request.sessionName);
  if (!run) return null;
  if (!isOpenSpecAutoDeliverTerminalStage(run.status)) {
    try {
      run.taskStats = await readTaskStatsForRun(run);
    } catch {
      return terminalizeAndSend(run, 'needs_human', 'tasks_unreadable');
    }
    return bumpProjection(run);
  }
  return buildProjection(run);
}

export async function handleOpenSpecAutoDeliverCommand(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const type = cmd.type;
  if (type === OPENSPEC_AUTO_DELIVER_MSG.LAUNCH) {
    const result = await launch(cmd as unknown as OpenSpecAutoDeliverLaunchRequest, serverLink);
    if (result.ok) {
      send(serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ACK, requestId: cmd.requestId, projection: result.projection });
      send(serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.PROJECTION, projection: result.projection });
      const run = runsById.get(result.projection.runId);
      if (run && run.stage === 'proposed' && !isOpenSpecAutoDeliverTerminalStage(run.status)) {
        if (run.materializedLimits.specAuditRepairRounds > 0) {
          await startAuditRepairStageFailClosed(run, 'spec_audit_repair');
        } else {
          run.evidence = await buildValidationEvidence(run);
          await dispatchImplementationPrompt(run);
        }
      }
    } else {
      send(serverLink, {
        type: OPENSPEC_AUTO_DELIVER_MSG.LAUNCH_ERROR,
        requestId: cmd.requestId,
        error: result.error,
        ...(result.projection ? { projection: result.projection } : {}),
      });
    }
    return;
  }
  if (type === OPENSPEC_AUTO_DELIVER_MSG.CONTINUE) {
    const result = await continueRun(cmd as unknown as OpenSpecAutoDeliverContinueRequest);
    send(serverLink, {
      type: OPENSPEC_AUTO_DELIVER_MSG.CONTINUE_ACK,
      requestId: cmd.requestId,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.projection ? { projection: result.projection } : {}),
    });
    if (result.projection && result.terminal !== false) {
      send(serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.PROJECTION, projection: result.projection });
    }
    return;
  }
  if (type === OPENSPEC_AUTO_DELIVER_MSG.STOP) {
    const result = await stop(cmd as unknown as OpenSpecAutoDeliverStopRequest);
    send(serverLink, {
      type: OPENSPEC_AUTO_DELIVER_MSG.STOP_ACK,
      requestId: cmd.requestId,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.projection ? { projection: result.projection } : {}),
    });
    if (result.projection && result.terminal !== false) {
      send(serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...result.projection, terminal: true } });
    }
    return;
  }
  if (type === OPENSPEC_AUTO_DELIVER_MSG.STATUS_REQUEST) {
    const projection = await status(cmd as unknown as OpenSpecAutoDeliverStatusRequest);
    send(serverLink, {
      type: OPENSPEC_AUTO_DELIVER_MSG.STATUS_PROJECTION,
      requestId: cmd.requestId,
      projection,
    });
  }
}

export function handleOpenSpecAutoDeliverDaemonRestartCleanup(serverLink?: ServerLink): void {
  for (const run of runsById.values()) {
    if (isOpenSpecAutoDeliverTerminalStage(run.status)) continue;
    if (!transitionAllowed(run, 'restart_cleanup')) {
      releaseAutoDeliverP2pLock(run.owningMainSessionName, run.runId);
      continue;
    }
    const projection = terminalize(run, 'failed', 'daemon_restart_cleared');
    const link = serverLink ?? run.serverLink;
    send(link, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
  }
}

export function getActiveOpenSpecAutoDeliverRunsBlockingDaemonUpgrade(): OpenSpecAutoDeliverUpgradeBlockReason[] {
  return Array.from(runsById.values())
    .filter((run) => !isOpenSpecAutoDeliverTerminalStage(run.status))
    .map((run) => ({
      runId: run.runId,
      changeName: run.changeName,
      status: run.status,
      stage: run.stage,
      owningMainSessionName: run.owningMainSessionName,
      launchedFromSessionName: run.launchedFromSessionName,
      targetImplementationSessionName: run.targetImplementationSessionName,
    }));
}

export function clearOpenSpecAutoDeliverRunsForTests(): void {
  for (const timer of auditPollTimers.values()) clearTimeout(timer);
  auditPollTimers.clear();
  for (const timer of auditFixRetryTimers.values()) clearTimeout(timer);
  auditFixRetryTimers.clear();
  for (const timer of implementationReminderTimers.values()) clearTimeout(timer);
  implementationReminderTimers.clear();
  for (const run of runsById.values()) {
    releaseAutoDeliverP2pLock(run.owningMainSessionName, run.runId);
  }
  runsById.clear();
  activeRunByOwner.clear();
  terminalRunByOwner.clear();
  requestProjectionByFingerprint.clear();
}
