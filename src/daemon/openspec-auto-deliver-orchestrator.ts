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
  OPENSPEC_AUTO_DELIVER_EVIDENCE_OPTIONAL_FIELDS,
  OPENSPEC_AUTO_DELIVER_EVIDENCE_REQUIRED_FIELDS,
  OPENSPEC_AUTO_DELIVER_MIN_ACCEPTABLE_MODULE_SCORE,
  OPENSPEC_AUTO_DELIVER_MSG,
  OPENSPEC_AUTO_DELIVER_MODULE_SCORE_FIELDS,
  OPENSPEC_AUTO_DELIVER_REPAIR_SUMMARY_FIELDS,
  OPENSPEC_AUTO_DELIVER_SCORE_MODULE_IDS,
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
  OpenSpecAutoDeliverLaunchRequest,
  OpenSpecAutoDeliverModuleScore,
  OpenSpecAutoDeliverRepairSummary,
  OpenSpecAutoDeliverP2pMetadata,
  OpenSpecAutoDeliverProjection,
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
import { formatOpenSpecPromptTemplate } from '../../shared/openspec-prompt-templates.js';
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
    spec_audit_rework: 'implementation_task_loop',
    spec_audit_blocked: 'implementation_task_loop',
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
    implementation_audit_started: 'implementation_audit_repair',
    implementation_audit_pass: 'passed',
    implementation_audit_rework: 'passed',
    implementation_audit_blocked: 'passed',
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
  latestMessage?: string;
  activeCommandId?: string;
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
  latestVerdict?: OpenSpecAutoDeliverVerdict;
  moduleScores?: OpenSpecAutoDeliverModuleScore[];
  auditResults?: OpenSpecAutoDeliverAuditResult[];
  latestRepairSummary?: string;
  lastAuditResultError?: string;
  evidence?: OpenSpecAutoDeliverEvidence[];
  baselineProductChangedFiles?: string[];
  baselineProductFileFingerprints?: Record<string, string>;
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
let timelineUnsubscribe: (() => void) | null = null;
const execFileAsync = promisify(execFile);
const OPENSPEC_AUTO_DELIVER_AUDIT_FIX_RETRY_WAIT_MS = process.env.NODE_ENV === 'test' ? 50 : 5 * 60_000;

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
    activeOpenSpecPromptId: run.activeAudit?.activeOpenSpecPromptId,
    canStop: !isOpenSpecAutoDeliverTerminalStage(run.status),
    latestRepairSummary: run.latestRepairSummary,
    latestVerdict: run.latestVerdict,
    moduleScores: run.moduleScores ? run.moduleScores.map((score) => ({ ...score })) : undefined,
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

function buildImplementationPrompt(run: AutoDeliverRun): string {
  const reference = openSpecChangeReference(run);
  const remaining = uncheckedTaskLabels(run.taskStats);
  const maxImplementationPrompts = effectiveMaxImplementationPrompts(run);
  const validationSummary = run.evidence?.filter((entry) => entry.source === 'daemon').map((entry) => `- ${entry.summary}`).join('\n')
    || '- No daemon validation recommendations are available.';
  const remainingBlock = remaining.length > 0
    ? remaining.map((label) => `- ${label}`).join('\n')
    : '- Re-read tasks.md and verify every task remains checked.';
  return [
    formatOpenSpecPromptTemplate('implement', reference),
    '',
    `OpenSpec Auto Deliver context for ${reference}.`,
    `Run id: ${run.runId}`,
    `Generation: ${run.generation}`,
    `Implementation prompt: ${run.implementationPromptCount + 1}/${maxImplementationPrompts}`,
    '',
    'Implement only this OpenSpec change. Do not commit, push, or stage files. Do not modify unrelated OpenSpec changes or docs.',
    'Work through the remaining tasks below. Mark tasks.md checkboxes only after the work is genuinely complete.',
    'Run reasonable local validation for the touched code when available. Treat the discovered commands below as project-specific candidates only; choose the actual validation plan from the changed files and project tooling. Report exact commands and outcomes, or explain why validation could not run.',
    '',
    'Remaining tasks:',
    remainingBlock,
    '',
    'Validation command candidates:',
    validationSummary,
  ].join('\n');
}

function dispatchImplementationPrompt(run: AutoDeliverRun): OpenSpecAutoDeliverProjection {
  const elapsedProjection = enforceElapsedLimit(run);
  if (elapsedProjection) return elapsedProjection;
  if (!transitionAllowed(run, 'implementation_prompt_dispatched')) {
    return terminalize(run, 'failed', 'invalid_transition_implementation_prompt');
  }
  if (run.implementationPromptCount >= effectiveMaxImplementationPrompts(run)) {
    return terminalize(run, 'needs_human', 'implementation_prompt_limit_reached');
  }
  const runtime = getTransportRuntime(run.targetImplementationSessionName);
  if (!runtime) {
    return terminalize(run, 'failed', 'missing_transport_runtime');
  }
  run.status = 'implementation_task_loop';
  run.stage = 'implementation_task_loop';
  run.implementationPromptCount += 1;
  run.activeCommandId = `${run.runId}:implementation:${run.generation}:${run.implementationPromptCount}`;
  const prompt = buildImplementationPrompt(run);
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
  run.latestMessage = 'implementation_prompt_dispatched';
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
  'invalid_evidence_source',
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

function safeAutoDeliverResultBasename(run: AutoDeliverRun, stage: AuditRepairStage, generation: number, roundIndex: number): string {
  return `${run.runId}.${stage}.g${generation}.r${roundIndex}.authoritative.json`
    .replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function buildAuthoritativeResultPath(run: AutoDeliverRun, stage: AuditRepairStage, generation: number, roundIndex: number): Promise<string> {
  const dir = join(run.projectRoot, '.imc', 'discussions');
  await mkdir(dir, { recursive: true });
  return join(dir, safeAutoDeliverResultBasename(run, stage, generation, roundIndex));
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
  const runtime = getTransportRuntime(run.targetImplementationSessionName);
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

function buildCanonicalOpenSpecAuditPrompt(run: AutoDeliverRun, stage: AuditRepairStage): string {
  return stage === 'spec_audit_repair'
    ? formatOpenSpecPromptTemplate('audit_spec', openSpecChangeReference(run))
    : formatOpenSpecPromptTemplate('audit_implementation', openSpecChangeReference(run));
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
    'PASS must leave unchecked_tasks and required_changes empty.',
  ];
}

function buildAuditRequestText(run: AutoDeliverRun, metadata: OpenSpecAutoDeliverP2pMetadata): string {
  const auditFocus = metadata.stage === 'spec_audit_repair'
    ? 'Audit and repair only the OpenSpec change artifacts under the referenced change folder. Do not edit product files.'
    : 'Audit and repair product/test/tasks.md implementation against the OpenSpec change. Do not commit, push, stage files, or edit unrelated OpenSpec changes/docs.';
  const stageVerdictScope = metadata.stage === 'spec_audit_repair'
    ? [
        'Spec-stage verdict scope:',
        '- Return PASS when proposal.md, design.md, specs/**/spec.md, and tasks.md are internally consistent, acceptance-ready, and implementation-ready.',
        '- Do not return REWORK merely because product implementation or product tests remain unfinished; those belong to the implementation stage.',
        '- If you add or preserve implementation/test follow-up tasks in tasks.md, treat that as successful spec repair once the artifacts are clear. In that case leave unchecked_tasks and required_changes empty and describe the task additions in repairs_applied/evidence.',
        '- Return REWORK only when the OpenSpec artifacts themselves still need another spec-audit repair attempt.',
      ].join('\n')
    : [
        'Implementation-stage verdict scope:',
        '- Return PASS only when implementation, tests, and tasks.md completion satisfy the OpenSpec change.',
        '- Return REWORK when product code, tests, or tasks.md still need another implementation audit-repair attempt.',
      ].join('\n');
  const unchecked = uncheckedTaskLabels(run.taskStats);
  const changedFiles = run.evidence?.find((entry) => entry.source === 'daemon' && entry.summary.startsWith('Changed files:'))?.summary ?? 'Changed files: unavailable.';
  const diffStat = run.evidence?.find((entry) => entry.source === 'daemon' && entry.summary.startsWith('Diff stat:'))?.summary ?? 'Diff stat: unavailable.';
  return [
    `OpenSpec Auto Deliver audit-repair for openspec/changes/${run.changeName}.`,
    '',
    `Change reference: ${openSpecChangeReference(run)}`,
    'Read the OpenSpec artifacts from that folder. This discussion intentionally references only the change folder instead of embedding artifact contents.',
    '',
    'Canonical OpenSpec dropdown prompt for this stage:',
    buildCanonicalOpenSpecAuditPrompt(run, metadata.stage),
    '',
    auditFocus,
    stageVerdictScope,
    `This request is launched through the normal Team/P2P combo flow (${metadata.selectedTeamComboId}), not an Auto Deliver custom combo.`,
    `During the combo audit phase, apply the existing OpenSpec ${metadata.activeOpenSpecPromptId} criteria for this stage.`,
    '',
    `Run id: ${run.runId}`,
    `Stage: ${metadata.stage}`,
    `Generation: ${metadata.generation}`,
    `Attempt id: ${metadata.attemptId}`,
    `Selected Team combo id: ${metadata.selectedTeamComboId}`,
    `Active OpenSpec prompt id: ${metadata.activeOpenSpecPromptId}`,
    `Round: ${metadata.roundIndex}/${auditRoundLimit(run, metadata.stage)}`,
    `Authoritative result file: ${metadata.authoritativeResultPath}`,
    `Owning main session: ${metadata.owningMainSessionName}`,
    `Execution session: ${metadata.executionSessionName}`,
    `Resolved change root identity: ${metadata.resolvedChangeRootIdentity}`,
    '',
    `Task stats: ${run.taskStats.checked}/${run.taskStats.total} checked.`,
    unchecked.length > 0 ? `Unchecked tasks:\n${unchecked.map((label) => `- ${label}`).join('\n')}` : 'Unchecked tasks: none.',
    run.latestRepairSummary ? `Prior repair summary: ${run.latestRepairSummary}` : 'Prior repair summary: none.',
    run.lastAuditResultError
      ? `Previous audit-repair attempt did not produce a usable authoritative JSON result: ${run.lastAuditResultError}. Retry by writing the final raw JSON object to the authoritative result file path above.`
      : 'Previous audit-repair strict result error: none.',
    run.evidence?.length ? `Evidence:\n${run.evidence.map((entry) => `- ${entry.source}: ${entry.summary}`).join('\n')}` : 'Evidence: none.',
    metadata.stage === 'implementation_audit_repair' ? changedFiles : '',
    metadata.stage === 'implementation_audit_repair' ? diffStat : '',
    '',
    'Write the final authoritative result as raw JSON to the exact Authoritative result file path above. Do not wrap that file in Markdown fences.',
    'The daemon will read only that file as the authoritative result. Discussion text and summaries are for humans only and are not authoritative.',
    'The JSON file must preserve the auto_deliver metadata exactly and must include canonical module scores.',
    '',
    `Required top-level fields: ${OPENSPEC_AUTO_DELIVER_AUTHORITATIVE_RESULT_FIELDS.join(', ')}.`,
    ...buildAuthoritativeResultSchemaHints(false),
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
        '- REWORK means product/test/task completion still needs another implementation audit-repair attempt.',
      ].join('\n');
  return [
    `OpenSpec Auto Deliver needs the authoritative audit result file for openspec/changes/${run.changeName}.`,
    '',
    `The audit-repair discussion has already completed; do not redo the full audit from scratch unless you must inspect your prior conclusion.`,
    `Problem: ${reason}`,
    `Discussion file: ${p2pRun.contextFilePath}`,
    `Authoritative result file: ${metadata.authoritativeResultPath}`,
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
  if (run.activeAudit) {
    const active = run.activeAudit;
    clearAuditPollTimer(run.runId);
    if (active.p2pRunId) trackActiveAuditCancellation(run, active, reason);
    run.activeAudit = undefined;
  }
  clearAuditFixRetryTimer(run.runId);
  delete run.activeCommandId;
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
  active: Pick<NonNullable<AutoDeliverRun['activeAudit']>, 'roundIndex' | 'attemptId' | 'generation'>,
): void {
  const result: OpenSpecAutoDeliverAuditResult = {
    stage,
    roundIndex: active.roundIndex,
    attemptId: active.attemptId,
    generation: active.generation,
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
}

function lowScoringModules(verdict: OpenSpecAutoDeliverVerdictPayload): OpenSpecAutoDeliverModuleScore[] {
  return verdict.module_scores.filter((score) => score.score < OPENSPEC_AUTO_DELIVER_MIN_ACCEPTABLE_MODULE_SCORE);
}

function extendAuditRoundLimit(run: AutoDeliverRun, stage: AuditRepairStage): void {
  const nextLimit = auditRoundCount(run, stage) + 1;
  if (stage === 'spec_audit_repair') {
    run.materializedLimits.specAuditRepairRounds = Math.max(run.materializedLimits.specAuditRepairRounds, nextLimit);
    return;
  }
  run.materializedLimits.implementationAuditRepairRounds = Math.max(run.materializedLimits.implementationAuditRepairRounds, nextLimit);
}

function scheduleAuditFixRetry(run: AutoDeliverRun, stage: AuditRepairStage, reason: string): void {
  clearAuditFixRetryTimer(run.runId);
  extendAuditRoundLimit(run, stage);
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
    void startAuditRepairStageFailClosed(current, stage);
  }, OPENSPEC_AUTO_DELIVER_AUDIT_FIX_RETRY_WAIT_MS));
}

function shouldRunAnotherConfiguredAuditRound(run: AutoDeliverRun, stage: AuditRepairStage): boolean {
  return auditRoundCount(run, stage) < auditRoundLimit(run, stage);
}

async function advanceAfterAuditVerdict(
  run: AutoDeliverRun,
  stage: AuditRepairStage,
  verdict: OpenSpecAutoDeliverVerdictPayload,
  active: Pick<NonNullable<AutoDeliverRun['activeAudit']>, 'roundIndex' | 'attemptId' | 'generation'>,
): Promise<void> {
  if (enforceElapsedLimit(run)) return;
  run.latestVerdict = verdict.verdict;
  run.moduleScores = verdict.module_scores.map((score) => ({ ...score }));
  recordAuditResult(run, stage, verdict, active);
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

  const lowScores = lowScoringModules(verdict);
  if (lowScores.length > 0) {
    scheduleAuditFixRetry(
      run,
      stage,
      `quality_gate_low_score:${lowScores.map((score) => `${score.module}=${score.score}`).join(',')}`,
    );
    return;
  }

  if (stage === 'spec_audit_repair') {
    if (shouldRunAnotherConfiguredAuditRound(run, stage)) {
      await startAuditRepairStageFailClosed(run, stage);
      return;
    }
    run.latestMessage = verdict.verdict === 'PASS' ? 'spec_audit_passed' : `spec_audit_${verdict.verdict.toLowerCase()}_scored`;
    run.evidence = mergeEvidence(run.evidence, await buildValidationEvidence(run));
    dispatchImplementationPrompt(run);
    return;
  }

  if (shouldRunAnotherConfiguredAuditRound(run, stage)) {
    await startAuditRepairStageFailClosed(run, stage);
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
      scheduleAuditFixRetry(run, stage, 'audit_pass_with_changed_files_without_repairs');
      return;
    }
    const finalFailure = validateFinalPass(run, verdict, currentRunChangedFiles);
    if (finalFailure) {
      scheduleAuditFixRetry(run, stage, finalFailure);
      return;
    }
    if (run.autoCommitPush) {
      await dispatchAutoCommitPushPrompt(run);
      return;
    }
    const projection = terminalize(run, 'passed', 'final_audit_passed');
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }

  const projection = terminalize(run, 'passed', verdict.verdict === 'BLOCKED' ? 'final_audit_blocked_scored' : 'final_audit_rework_scored');
  send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
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
  if (p2pRun.status !== 'completed') {
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
    if (isRetryableAuditResultError(reason) && auditRoundCount(run, expected.stage) < auditRoundLimit(run, expected.stage)) {
      await startAuditRepairStageFailClosed(run, expected.stage);
      return;
    }
    const projection = terminalize(run, 'needs_human', reason);
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }
  const completedAudit = active;
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
  if (auditRoundCount(run, stage) >= auditRoundLimit(run, stage)) {
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
    locale: run.locale,
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
  delete run.activeCommandId;
  try {
    run.taskStats = await readTaskStatsForRun(run);
  } catch {
    terminalizeAndSend(run, 'needs_human', 'tasks_unreadable');
    return;
  }
  if (run.taskStats.total <= 0) {
    const projection = terminalize(run, 'needs_human', 'tasks_missing_checkboxes');
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }
  if (run.taskStats.unchecked <= 0) {
    if (run.materializedLimits.implementationAuditRepairRounds <= 0) {
      const projection = terminalize(run, 'needs_human', 'implementation_audit_required');
      send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
      return;
    }
    await startAuditRepairStageFailClosed(run, 'implementation_audit_repair');
    return;
  }
  const projection = dispatchImplementationPrompt(run);
  if (isOpenSpecAutoDeliverTerminalStage(projection.status)) {
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
  }
}

function ensureTimelineListener(): void {
  if (timelineUnsubscribe) return;
  timelineUnsubscribe = timelineEmitter.on((event) => {
  if (event.type === 'assistant.text') {
      const run = [...runsById.values()].find((candidate) =>
        candidate.targetImplementationSessionName === event.sessionId
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
    const commitPushRun = [...runsById.values()].find((candidate) =>
      candidate.targetImplementationSessionName === event.sessionId
      && candidate.status === 'commit_push'
      && !!candidate.activeCommandId
    );
    if (commitPushRun) {
      void advanceAfterAutoCommitPushIdle(commitPushRun).catch((error) => {
        terminalizeAndSend(commitPushRun, 'failed', error instanceof Error ? error.message : 'auto_commit_push_idle_advance_failed');
      });
      return;
    }
    const run = [...runsById.values()].find((candidate) =>
      candidate.targetImplementationSessionName === event.sessionId
      && candidate.status === 'implementation_task_loop'
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
  const baselineProductChangedFiles = await collectAutoCommitProductFiles(resolved.projectRoot).catch(() => []);
  const baselineProductFileFingerprints = await productFileFingerprints(resolved.projectRoot, baselineProductChangedFiles).catch(() => ({}));
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
    baselineProductChangedFiles,
    baselineProductFileFingerprints,
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
          dispatchImplementationPrompt(run);
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
  for (const run of runsById.values()) {
    releaseAutoDeliverP2pLock(run.owningMainSessionName, run.runId);
  }
  runsById.clear();
  activeRunByOwner.clear();
  terminalRunByOwner.clear();
  requestProjectionByFingerprint.clear();
}
