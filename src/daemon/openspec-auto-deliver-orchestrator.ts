import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { P2P_TERMINAL_RUN_STATUSES } from '../../shared/p2p-status.js';
import { getSession } from '../store/session-store.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import type { ServerLink } from './server-link.js';
import { timelineEmitter } from './timeline-emitter.js';
import {
  resolveOpenSpecAutoDeliverCombo,
} from '../../shared/openspec-auto-deliver-combos.js';
import {
  OPENSPEC_AUTO_DELIVER_COMBO_IDS,
  OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_ELAPSED_MINUTES,
  OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS,
  OPENSPEC_AUTO_DELIVER_MSG,
  isOpenSpecAutoDeliverTerminalStage,
  materializeOpenSpecAutoDeliverPreset,
  type OpenSpecAutoDeliverComboId,
  type OpenSpecAutoDeliverPresetId,
  type OpenSpecAutoDeliverStage,
  type OpenSpecAutoDeliverVerdict,
} from '../../shared/openspec-auto-deliver-constants.js';
import type {
  OpenSpecAutoDeliverEvidence,
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
  parseOpenSpecAutoDeliverAuthoritativeJsonPayload,
  parseOpenSpecTasksMarkdown,
  validateOpenSpecAutoDeliverChangeSlug,
  validateOpenSpecAutoDeliverComboDescriptor,
  validateOpenSpecAutoDeliverLaunchRequest,
  validateOpenSpecAutoDeliverRequestId,
  validateOpenSpecAutoDeliverVerdictPayload,
} from '../../shared/openspec-auto-deliver-validators.js';
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

type AutoDeliverRunStatus = Extract<OpenSpecAutoDeliverStage,
  'proposed' | 'spec_audit_repair' | 'implementation_task_loop' | 'implementation_audit_repair' | 'passed' | 'needs_human' | 'failed' | 'stopped'>;

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
  | 'out_of_band_input'
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
    out_of_band_input: 'needs_human',
    stop: 'stopped',
    restart_cleanup: 'failed',
    runtime_error: 'failed',
  },
  implementation_audit_repair: {
    implementation_audit_started: 'implementation_audit_repair',
    implementation_audit_pass: 'passed',
    implementation_audit_rework: 'implementation_audit_repair',
    implementation_audit_blocked: 'needs_human',
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
    comboId: OpenSpecAutoDeliverComboId;
    stage: AuditRepairStage;
    attemptId: string;
    roundIndex: number;
    generation: number;
  };
  latestVerdict?: OpenSpecAutoDeliverVerdict;
  moduleScores?: OpenSpecAutoDeliverModuleScore[];
  latestRepairSummary?: string;
  evidence?: OpenSpecAutoDeliverEvidence[];
  requestIds: Map<string, OpenSpecAutoDeliverProjection>;
  serverLink: ServerLink;
}

type LaunchResult =
  | { ok: true; projection: OpenSpecAutoDeliverProjection }
  | { ok: false; error: string; projection?: OpenSpecAutoDeliverProjection };

const runsById = new Map<string, AutoDeliverRun>();
const activeRunByOwner = new Map<string, string>();
const terminalRunByOwner = new Map<string, AutoDeliverRun>();
const requestProjectionById = new Map<string, OpenSpecAutoDeliverProjection>();
const auditPollTimers = new Map<string, ReturnType<typeof setTimeout>>();
let timelineUnsubscribe: (() => void) | null = null;
const execFileAsync = promisify(execFile);

function clearAuditPollTimer(runId: string): void {
  const timer = auditPollTimers.get(runId);
  if (timer) clearTimeout(timer);
  auditPollTimers.delete(runId);
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

function buildProjection(run: AutoDeliverRun): OpenSpecAutoDeliverProjection {
  return {
    projectionVersion: run.projectionVersion,
    runId: run.runId,
    changeName: run.changeName,
    presetId: run.presetId,
    materializedLimits: {
      maxImplementationPrompts: OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS,
      maxElapsedMinutes: OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_ELAPSED_MINUTES,
      ...run.materializedLimits,
    },
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
    activeP2pRunId: run.activeAudit?.p2pRunId,
    latestRepairSummary: run.latestRepairSummary,
    latestVerdict: run.latestVerdict,
    moduleScores: run.moduleScores ? run.moduleScores.map((score) => ({ ...score })) : undefined,
    evidence: run.evidence ? run.evidence.map((entry) => ({ ...entry })) : undefined,
    activeComboId: run.activeAudit?.comboId,
    lastMessage: run.latestMessage,
    terminalReason: run.terminalReason,
  };
}

function bumpProjection(run: AutoDeliverRun): OpenSpecAutoDeliverProjection {
  run.projectionVersion += 1;
  run.updatedAt = Date.now();
  const projection = buildProjection(run);
  for (const requestId of run.requestIds.keys()) {
    run.requestIds.set(requestId, projection);
    requestProjectionById.set(requestId, projection);
  }
  return projection;
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
  return { ok: true, projectRoot, root: resolved };
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
  ])).filter((entry): entry is { path: string; content: string } => !!entry);
  const recommendations = buildOpenSpecAutoDeliverValidationRecommendations(files);
  const recommended = recommendations.filter((entry) => entry.safety === 'recommended');
  const unsafe = recommendations.filter((entry) => entry.safety === 'unsafe');
  return [
    {
      source: 'daemon',
      summary: recommended.length > 0
        ? `Recommended validation commands: ${recommended.map((entry) => entry.command).join('; ')}.`
        : 'No safe validation commands were discovered from project manifests.',
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
  const remaining = uncheckedTaskLabels(run.taskStats);
  const validationSummary = run.evidence?.filter((entry) => entry.source === 'daemon').map((entry) => `- ${entry.summary}`).join('\n')
    || '- No daemon validation recommendations are available.';
  const remainingBlock = remaining.length > 0
    ? remaining.map((label) => `- ${label}`).join('\n')
    : '- Re-read tasks.md and verify every task remains checked.';
  return [
    `Continue OpenSpec Auto Deliver for openspec/changes/${run.changeName}.`,
    '',
    `Run id: ${run.runId}`,
    `Generation: ${run.generation}`,
    `Implementation prompt: ${run.implementationPromptCount + 1}/${OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS}`,
    '',
    'Implement only this OpenSpec change. Do not commit, push, or stage files. Do not modify unrelated OpenSpec changes or docs.',
    'Work through the remaining tasks below. Mark tasks.md checkboxes only after the work is genuinely complete.',
    'Run reasonable local validation for touched code when available. Report exact commands and outcomes, or explain why validation could not run.',
    '',
    'Remaining tasks:',
    remainingBlock,
    '',
    'Validation recommendations:',
    validationSummary,
  ].join('\n');
}

function dispatchImplementationPrompt(run: AutoDeliverRun): OpenSpecAutoDeliverProjection {
  const elapsedProjection = enforceElapsedLimit(run);
  if (elapsedProjection) return elapsedProjection;
  if (!transitionAllowed(run, 'implementation_prompt_dispatched')) {
    return terminalize(run, 'failed', 'invalid_transition_implementation_prompt');
  }
  if (run.implementationPromptCount >= OPENSPEC_AUTO_DELIVER_DEFAULT_MAX_IMPLEMENTATION_PROMPTS) {
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

function auditComboIdForStage(stage: AuditRepairStage): OpenSpecAutoDeliverComboId {
  return stage === 'spec_audit_repair'
    ? OPENSPEC_AUTO_DELIVER_COMBO_IDS.SPEC_AUDIT_REPAIR
    : OPENSPEC_AUTO_DELIVER_COMBO_IDS.IMPLEMENTATION_AUDIT_REPAIR;
}

function auditRoundLimit(run: AutoDeliverRun, stage: AuditRepairStage): number {
  return stage === 'spec_audit_repair'
    ? run.materializedLimits.specAuditRepairRounds
    : run.materializedLimits.implementationAuditRepairRounds;
}

function auditRoundCount(run: AutoDeliverRun, stage: AuditRepairStage): number {
  return stage === 'spec_audit_repair' ? run.specAuditRepairRound : run.implementationAuditRepairRound;
}

function incrementAuditRound(run: AutoDeliverRun, stage: AuditRepairStage): number {
  if (stage === 'spec_audit_repair') {
    run.specAuditRepairRound += 1;
    return run.specAuditRepairRound;
  }
  run.implementationAuditRepairRound += 1;
  return run.implementationAuditRepairRound;
}

async function buildAuditFileContents(run: AutoDeliverRun): Promise<Array<{ path: string; content: string }>> {
  if (!(await refreshChangeRoot(run))) return [];
  const candidates = [
    'proposal.md',
    'design.md',
    'tasks.md',
  ];
  const specsRoot = join(run.changeRoot, 'specs');
  const specEntries = await readdir(specsRoot, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of specEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const parentPath = 'parentPath' in entry && typeof entry.parentPath === 'string' ? entry.parentPath : specsRoot;
    const absolute = join(parentPath, entry.name);
    const rel = absolute.slice(run.changeRoot.length + 1);
    candidates.push(rel);
  }
  const files: Array<{ path: string; content: string }> = [];
  for (const file of candidates) {
    const resolved = await realpath(join(run.changeRoot, file)).catch(() => null);
    if (!resolved || !(resolved === run.changeRoot || resolved.startsWith(`${run.changeRoot}/`))) {
      run.latestMessage = 'change_artifact_outside_root';
      continue;
    }
    const content = await readFile(resolved, 'utf8').catch(() => null);
    if (content != null) files.push({ path: `openspec/changes/${run.changeName}/${file}`, content });
  }
  return files;
}

async function collectGitEvidence(run: AutoDeliverRun): Promise<{ changedFiles: string[]; diffStat: string }> {
  const runGit = async (args: string[]): Promise<string> => {
    const result = await execFileAsync('git', ['-C', run.projectRoot, ...args], { timeout: 2000, maxBuffer: 128 * 1024 }).catch(() => null);
    return result?.stdout?.toString?.() ?? '';
  };
  const statusFiles = (await runGit(['status', '--porcelain=v1']))
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

function buildAuditRequestText(run: AutoDeliverRun, metadata: OpenSpecAutoDeliverP2pMetadata): string {
  const auditFocus = metadata.stage === 'spec_audit_repair'
    ? 'Audit and repair only the OpenSpec change artifacts for proposal/design/specs/tasks consistency. Do not edit product files.'
    : 'Audit and repair product/test/tasks.md implementation against the OpenSpec change. Do not commit, push, stage files, or edit unrelated OpenSpec changes/docs.';
  const unchecked = uncheckedTaskLabels(run.taskStats);
  const payloadSkeleton = {
    auto_deliver: {
      runId: metadata.runId,
      changeName: metadata.changeName,
      resolvedChangeRootIdentity: metadata.resolvedChangeRootIdentity,
      stage: metadata.stage,
      designatedComboId: metadata.designatedComboId,
      roundIndex: metadata.roundIndex,
      attemptId: metadata.attemptId,
      owningMainSessionName: metadata.owningMainSessionName,
      executionSessionName: metadata.executionSessionName,
      generation: metadata.generation,
    },
    verdict: 'PASS | REWORK | BLOCKED',
    module_scores: [
      { module: 'spec', score: 0, max_score: 10, summary: '...' },
      { module: 'tasks', score: 0, max_score: 10, summary: '...' },
      { module: 'implementation', score: 0, max_score: 10, summary: '...' },
      { module: 'tests', score: 0, max_score: 10, summary: '...' },
      { module: 'risk', score: 0, max_score: 10, summary: '...' },
    ],
    unchecked_tasks: [],
    required_changes: [],
    repairs_applied: [],
    evidence: [],
  };
  const changedFiles = run.evidence?.find((entry) => entry.source === 'daemon' && entry.summary.startsWith('Changed files:'))?.summary ?? 'Changed files: unavailable.';
  const diffStat = run.evidence?.find((entry) => entry.source === 'daemon' && entry.summary.startsWith('Diff stat:'))?.summary ?? 'Diff stat: unavailable.';
  return [
    `OpenSpec Auto Deliver audit-repair for openspec/changes/${run.changeName}.`,
    '',
    auditFocus,
    '',
    `Run id: ${run.runId}`,
    `Stage: ${metadata.stage}`,
    `Generation: ${metadata.generation}`,
    `Attempt id: ${metadata.attemptId}`,
    `Designated combo id: ${metadata.designatedComboId}`,
    `Round: ${metadata.roundIndex}/${auditRoundLimit(run, metadata.stage)}`,
    `Owning main session: ${metadata.owningMainSessionName}`,
    `Execution session: ${metadata.executionSessionName}`,
    `Resolved change root identity: ${metadata.resolvedChangeRootIdentity}`,
    '',
    `Task stats: ${run.taskStats.checked}/${run.taskStats.total} checked.`,
    unchecked.length > 0 ? `Unchecked tasks:\n${unchecked.map((label) => `- ${label}`).join('\n')}` : 'Unchecked tasks: none.',
    run.latestRepairSummary ? `Prior repair summary: ${run.latestRepairSummary}` : 'Prior repair summary: none.',
    run.evidence?.length ? `Evidence:\n${run.evidence.map((entry) => `- ${entry.source}: ${entry.summary}`).join('\n')}` : 'Evidence: none.',
    metadata.stage === 'implementation_audit_repair' ? changedFiles : '',
    metadata.stage === 'implementation_audit_repair' ? diffStat : '',
    '',
    'Return exactly one authoritative fenced JSON payload in your final result. Do not include another JSON fence.',
    'The JSON must preserve the auto_deliver metadata exactly and must include canonical module scores.',
    '',
    'Required JSON object shape, shown inline to avoid seeding an extra authoritative fence:',
    JSON.stringify(payloadSkeleton, null, 2),
  ].join('\n');
}

function validateAuditMetadata(input: unknown, expected: OpenSpecAutoDeliverP2pMetadata): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  const meta = record.auto_deliver;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const actual = meta as Record<string, unknown>;
  return actual.runId === expected.runId
    && actual.changeName === expected.changeName
    && actual.resolvedChangeRootIdentity === expected.resolvedChangeRootIdentity
    && actual.stage === expected.stage
    && actual.designatedComboId === expected.designatedComboId
    && actual.roundIndex === expected.roundIndex
    && actual.attemptId === expected.attemptId
    && actual.owningMainSessionName === expected.owningMainSessionName
    && actual.executionSessionName === expected.executionSessionName
    && actual.generation === expected.generation;
}

function repairSummaryText(repairs: OpenSpecAutoDeliverRepairSummary[]): string | undefined {
  if (repairs.length === 0) return undefined;
  return repairs.map((repair) => `${repair.files.join(', ') || '(unspecified files)'}: ${repair.reason}`).join('; ');
}

function validateFinalPass(run: AutoDeliverRun, verdict: OpenSpecAutoDeliverVerdictPayload): string | null {
  if (verdict.verdict !== 'PASS') return null;
  if (run.taskStats.total <= 0) return 'tasks_missing_checkboxes';
  if (run.taskStats.unchecked > 0) return 'audit_pass_with_unchecked_tasks';
  if (verdict.unchecked_tasks.length > 0) return 'audit_pass_with_reported_unchecked_tasks';
  if (verdict.required_changes.length > 0) return 'audit_pass_with_required_changes';
  return null;
}

async function consumeAuditDiscussion(run: AutoDeliverRun, p2pRun: P2pRun, expected: OpenSpecAutoDeliverP2pMetadata): Promise<OpenSpecAutoDeliverVerdictPayload | null> {
  const strictResult = (p2pRun as P2pRun & { strictAuthoritativeResult?: string | null }).strictAuthoritativeResult;
  const text = typeof strictResult === 'string' && strictResult.trim()
    ? strictResult
    : typeof p2pRun.resultSummary === 'string' && p2pRun.resultSummary.trim()
      ? p2pRun.resultSummary
      : '';
  const parsed = parseOpenSpecAutoDeliverAuthoritativeJsonPayload(text);
  if (!parsed.ok) {
    run.latestMessage = parsed.issues.map((entry) => entry.code).join(',') || 'invalid_authoritative_json';
    return null;
  }
  if (!validateAuditMetadata(parsed.value, expected)) {
    run.latestMessage = 'audit_metadata_mismatch';
    return null;
  }
  const result = validateOpenSpecAutoDeliverVerdictPayload(parsed.value);
  if (!result.ok) {
    run.latestMessage = result.issues.map((entry) => entry.code).join(',') || 'invalid_audit_verdict';
    return null;
  }
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

function terminalize(run: AutoDeliverRun, status: Extract<AutoDeliverRunStatus, 'passed' | 'needs_human' | 'failed' | 'stopped'>, reason: string): OpenSpecAutoDeliverProjection {
  if (run.activeAudit) {
    const active = run.activeAudit;
    clearAuditPollTimer(run.runId);
    void cancelP2pRun(active.p2pRunId, run.serverLink).catch(() => undefined);
    run.activeAudit = undefined;
  }
  run.status = status;
  run.stage = status;
  run.terminalReason = reason;
  run.latestMessage = reason;
  run.generation += 1;
  activeRunByOwner.delete(run.owningMainSessionName);
  terminalRunByOwner.set(run.owningMainSessionName, run);
  releaseAutoDeliverP2pLock(run.owningMainSessionName, run.runId);
  return bumpProjection(run);
}

async function advanceAfterAuditVerdict(run: AutoDeliverRun, stage: AuditRepairStage, verdict: OpenSpecAutoDeliverVerdictPayload): Promise<void> {
  if (enforceElapsedLimit(run)) return;
  run.latestVerdict = verdict.verdict;
  run.moduleScores = verdict.module_scores.map((score) => ({ ...score }));
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

  if (verdict.verdict === 'BLOCKED') {
    const projection = terminalize(run, 'needs_human', 'audit_blocked');
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }

  if (stage === 'spec_audit_repair') {
    if (verdict.verdict === 'PASS') {
      run.latestMessage = 'spec_audit_passed';
      run.evidence = mergeEvidence(run.evidence, await buildValidationEvidence(run));
      dispatchImplementationPrompt(run);
      return;
    }
    if (auditRoundCount(run, stage) < auditRoundLimit(run, stage)) {
      await startAuditRepairStageFailClosed(run, 'spec_audit_repair');
      return;
    }
    const projection = terminalize(run, 'needs_human', 'spec_audit_rework_rounds_exhausted');
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }

  if (verdict.verdict === 'PASS') {
    const gitEvidence = await collectGitEvidence(run);
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
    const finalFailure = validateFinalPass(run, verdict);
    if (finalFailure) {
      const projection = terminalize(run, 'needs_human', finalFailure);
      send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
      return;
    }
    const projection = terminalize(run, 'passed', 'final_audit_passed');
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }

  if (auditRoundCount(run, stage) < auditRoundLimit(run, stage)) {
    await startAuditRepairStageFailClosed(run, 'implementation_audit_repair');
    return;
  }
  const projection = terminalize(run, 'needs_human', 'implementation_audit_rework_rounds_exhausted');
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
    || active.comboId !== expected.designatedComboId
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
  run.activeAudit = undefined;
  if (p2pRun.status !== 'completed') {
    const projection = terminalize(run, 'needs_human', `audit_p2p_${p2pRun.status}`);
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }
  const verdict = await consumeAuditDiscussion(run, p2pRun, expected);
  if (!verdict) {
    const projection = terminalize(run, 'needs_human', run.latestMessage ?? 'invalid_audit_result');
    send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
    return;
  }
  await advanceAfterAuditVerdict(run, expected.stage, verdict).catch((error) => {
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
  const comboId = auditComboIdForStage(stage);
  const descriptor = resolveOpenSpecAutoDeliverCombo(comboId);
  const descriptorValidation = validateOpenSpecAutoDeliverComboDescriptor(descriptor);
  if (!descriptor || !descriptorValidation.ok || descriptor.capability.stage !== stage) {
    return terminalizeAndSend(run, 'failed', 'designated_combo_unavailable');
  }
  const roundIndex = incrementAuditRound(run, stage);
  const attemptId = `${run.runId}:${stage}:${run.generation}:${roundIndex}`;
  const metadata: OpenSpecAutoDeliverP2pMetadata = {
    owner: 'openspec_auto_deliver',
    runId: run.runId,
    owningMainSessionName: run.owningMainSessionName,
    executionSessionName: run.targetImplementationSessionName,
    changeName: run.changeName,
    resolvedChangeRootIdentity: run.changeRootIdentity,
    stage,
    designatedComboId: comboId,
    roundIndex,
    attemptId,
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
    comboId,
    stage,
    attemptId,
    roundIndex,
    generation: run.generation,
  };
  const p2pRun = await startP2pRun({
    initiatorSession: run.targetImplementationSessionName,
    targets: [],
    userText: buildAuditRequestText(run, metadata),
    fileContents: await buildAuditFileContents(run),
    serverLink: run.serverLink,
    modeOverride: 'audit',
    advanced: {
      kind: 'supervision_internal',
      advancedPresetKey: comboId,
      advancedRounds: descriptor.rounds,
      advancedRunTimeoutMs: Math.max(1, descriptor.rounds[0]?.timeoutMinutes ?? 10) * 60_000,
    },
    launchOrigin: {
      kind: 'openspec_auto_deliver',
      commandId: attemptId,
      autoDeliver: {
        runId: run.runId,
        changeName: run.changeName,
        owningMainSessionName: run.owningMainSessionName,
        generation: run.generation,
        stage,
        attemptId,
        comboId,
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
        && candidate.status === 'implementation_task_loop'
        && !!candidate.activeCommandId
      );
      const text = typeof event.payload.text === 'string' ? event.payload.text.trim() : '';
      const eventCommandId = typeof (event.payload as Record<string, unknown>).commandId === 'string'
        ? (event.payload as Record<string, unknown>).commandId
        : undefined;
      if (run && text.length > 0 && (!eventCommandId || eventCommandId === run.activeCommandId)) {
        run.evidence = [
          ...(run.evidence ?? []),
          {
            source: 'implementation_reported',
            summary: text.slice(0, 1000),
            stale: false,
          },
        ];
      }
      return;
    }
    if (event.type === 'user.message') {
      const run = [...runsById.values()].find((candidate) =>
        candidate.targetImplementationSessionName === event.sessionId
        && candidate.status === 'implementation_task_loop'
        && !!candidate.activeCommandId
      );
      const eventId = event.eventId;
      if (run && (typeof eventId !== 'string' || !eventId.startsWith(`openspec-auto:${run.activeCommandId}`))) {
        if (!transitionAllowed(run, 'out_of_band_input')) return;
        const projection = terminalize(run, 'needs_human', 'out_of_band_target_session_input');
        send(run.serverLink, { type: OPENSPEC_AUTO_DELIVER_MSG.TERMINAL, projection: { ...projection, terminal: true } });
      }
      return;
    }
    if (event.type !== 'session.state') return;
    if ((event.payload as Record<string, unknown>).state !== 'idle') return;
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
  const cached = requestProjectionById.get(requestId.value);
  if (cached) return { ok: true, projection: cached };

  const change = validateOpenSpecAutoDeliverChangeSlug(launchValidation.value.changeName);
  if (!change.ok) return { ok: false, error: 'invalid_change_name' };
  const sessionName = launchValidation.value.sessionName;
  const session = sessionName ? getSession(sessionName) : undefined;
  if (!session) return { ok: false, error: 'missing_session' };
  if (session.runtimeType !== 'transport') return { ok: false, error: 'unsupported_runtime' };

  const owner = resolveOpenSpecAutoDeliverOwningMainSession(sessionName);
  const existing = activeRunForOwner(owner);
  if (existing && !isOpenSpecAutoDeliverTerminalStage(existing.status)) {
    return { ok: false, error: 'auto_deliver_active', projection: buildProjection(existing) };
  }
  if (hasActiveP2pRunForMainSession(listP2pRuns(), owner)) {
    return { ok: false, error: 'team_lane_busy' };
  }

  const resolved = await resolveChangeRoot(sessionName, change.value);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const taskStats = await readTaskStats(resolved.root).catch(() => null);
  if (!taskStats || taskStats.total <= 0) return { ok: false, error: 'tasks_missing_checkboxes' };
  const presetId = launchValidation.value.presetId;
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
    materializedLimits: materializeOpenSpecAutoDeliverPreset(presetId),
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
    allowedComboIds: [
      OPENSPEC_AUTO_DELIVER_COMBO_IDS.SPEC_AUDIT_REPAIR,
      OPENSPEC_AUTO_DELIVER_COMBO_IDS.IMPLEMENTATION_AUDIT_REPAIR,
    ],
  });
  const projection = buildProjection(run);
  run.requestIds.set(requestId.value, projection);
  requestProjectionById.set(requestId.value, projection);
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

export function clearOpenSpecAutoDeliverRunsForTests(): void {
  for (const timer of auditPollTimers.values()) clearTimeout(timer);
  auditPollTimers.clear();
  for (const run of runsById.values()) {
    releaseAutoDeliverP2pLock(run.owningMainSessionName, run.runId);
  }
  runsById.clear();
  activeRunByOwner.clear();
  terminalRunByOwner.clear();
  requestProjectionById.clear();
}
