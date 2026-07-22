import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSession } from '../store/session-store.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import { PROVIDER_ERROR_CODES } from '../agent/transport-provider.js';
import type { ServerLink } from './server-link.js';
import { timelineEmitter } from './timeline-emitter.js';
import {
  supervisionBroker,
  type SupervisionProviderFailure,
} from './supervision-broker.js';
import { getCachedGlobalCustomInstructions } from './supervisor-defaults-cache.js';
import logger from '../util/logger.js';
import {
  SUPERVISION_CONTRACT_IDS,
  SUPERVISION_AUDIT_TARGET_RECOVERY_AUTOMATION_KIND,
  SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_STREAK,
  SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_TOTAL,
  SUPERVISION_MODE,
  SUPERVISION_UNAVAILABLE_REASONS,
  extractSessionSupervisionSnapshot,
  resolveSupervisionCustomInstructionsDetail,
  type SessionSupervisionSnapshot,
  type SupervisionUnavailableReason,
  type TaskRunTerminalState,
} from '../../shared/supervision-config.js';
import {
  buildSupervisionContinuePrompt,
  buildReworkBriefPrompt,
} from './supervision-prompts.js';
import {
  AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER,
  buildAgentDelegationReplyInstruction,
  buildAgentDelegationOrchestrationPrompt,
  buildQuickAgentDelegationTask,
} from '../../shared/agent-delegation.js';
import {
  PEER_AUDIT_DEADLINE_MS,
  PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS,
  parsePeerAuditOrchestratedResult,
  type PeerAuditTerminalOutcome,
} from '../../shared/peer-audit.js';
import { TIMELINE_EVENT_FILE_CHANGE, type FileChangePatch } from '../../shared/file-change.js';
import { peerAuditService } from './peer-audit-service.js';
import { emitPeerAuditResult } from './peer-audit-result.js';
import { isWorkingSessionState } from '../../shared/session-activity-types.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';

/**
 * Merge the daemon-cached global custom instructions into a session snapshot
 * when the snapshot's own `globalCustomInstructions` mirror is empty. The
 * web client only updates the mirror for the currently-edited session on
 * save, so snapshots for other sessions can be stale — this function is
 * the runtime fallback that makes the user's saved defaults actually reach
 * every session's supervisor. See `supervisor-defaults-cache.ts`.
 *
 * Returns a new snapshot (does not mutate) when augmentation happens; returns
 * the original reference otherwise so the fast path stays allocation-free.
 */
function enrichSnapshotWithGlobalDefaults(
  snapshot: SessionSupervisionSnapshot,
): SessionSupervisionSnapshot {
  const existing = snapshot.globalCustomInstructions?.trim();
  if (existing) return snapshot;
  const cached = getCachedGlobalCustomInstructions();
  if (!cached) return snapshot;
  return { ...snapshot, globalCustomInstructions: cached };
}

type TaskRunPhase = 'execution' | 'auditing' | 'finalizing';

const SUPERVISION_WAITING_LABEL = 'Supervised: analyzing completion...';
const SUPERVISION_AUDIT_WAITING_LABEL = 'Supervised: peer audit running; commit/push paused until the result.';
const SUPERVISION_COMPLETE_LABEL = 'Supervised: task looks complete.';
const SUPERVISION_CONTINUE_LABEL = 'Supervised: sent a continue prompt.';
const SUPERVISION_FINALIZING_LABEL = 'Supervised: audit passed; running post-audit finalization.';
const SUPERVISION_NEEDS_INPUT_LABEL = 'Supervised: returned control to you.';
const SUPERVISION_AUDIT_PASS_LABEL = 'Supervised: audit passed.';
const SUPERVISION_REWORK_LABEL = 'Supervised: audit requested rework; brief sent.';
const SUPERVISION_BLOCKED_LABEL = 'Supervised: stopped because the session is blocked.';
const AUDIT_TARGET_RECOVERY_DELAY_MS = 1_500;
const AUDIT_TARGET_MAX_RECOVERY_CONTINUES = 2;

interface ActiveTaskRunState {
  generation: number;
  sessionName: string;
  commandId: string;
  snapshot: SessionSupervisionSnapshot;
  hasLiveSnapshotUpdate: boolean;
  userText: string;
  phase: TaskRunPhase;
  continueLoops: number;
  continueStreakCount: number;
  lastContinueBucket?: string;
  evaluating: boolean;
  sawAssistantOutput: boolean;
  lastAssistantText?: string;
  terminalState?: TaskRunTerminalState;
  auditAttemptId?: string;
  auditStartedAt?: number;
  auditReplyObserved: boolean;
  auditDeadlineTimer?: NodeJS.Timeout;
  auditTargetSessionInstanceId?: string;
  auditTargetDispatchObservedAt?: number;
  auditTargetObservedActive: boolean;
  auditTargetRecoveryAttempts: number;
  auditTargetRecoveryLimitNotified: boolean;
  auditTargetRecoveryTimer?: NodeJS.Timeout;
  // When a reply-backed audit settles from the assistant-text fallback (that
  // is, before the provider emits the trailing idle for the audit turn), the
  // deferred finalization/rework prompt may already be dispatched by the time
  // that old idle arrives. Ignore exactly that pre-activity idle so it cannot
  // terminate or evaluate the newly-started phase with stale audit output.
  ignoreIdleUntilPostAuditTurnActivity?: boolean;
  deferredFinalization?: {
    reason: string;
    nextAction: string;
    gap?: string;
  };
  // Number of rework briefs that have been dispatched back into the session
  // since the run started. `maxAuditLoops = N` permits up to N rework dispatches
  // per supervised-task-audit-loop spec; see `handleOrchestratedAuditCompletion`.
  reworkDispatches: number;
  startedAt: number;
}

interface PendingTaskIntent {
  commandId: string;
  text: string;
  snapshot: SessionSupervisionSnapshot;
}

interface RecentTaskCandidate {
  commandId: string;
  text: string;
  sequence: number;
}

interface LatestAssistantText {
  text: string;
  sequence: number;
}

function isDelegatedAuditReplyText(text: string | undefined): boolean {
  if (!text) return false;
  // Ordinary reply-enabled @agent delegation returns the bounded Task/Result
  // envelope. Main→main replies do not carry sharedActor metadata, so the
  // envelope—not actor decoration—is the cross-runtime authority available to
  // this ordinary delegation path. Requiring both fields prevents unrelated
  // chat text from opening the automatic-audit verdict gate.
  return /^Task:\s*\S/im.test(text) && /^Result:\s*\S/im.test(text);
}

interface AuditBaseline {
  kind: 'openspec' | 'contextual';
  userText: string;
  fileContents: Array<{ path: string; content: string }>;
  changeDir?: string;
}

interface TimelineAuditArtifacts {
  changedFiles: Array<{ path: string; content: string }>;
  validationOutputs: Array<{ path: string; content: string }>;
}

type DirEntryLike = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

function trimString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeContinueBucketText(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyContinueBucket(decision: { nextAction?: string; gap?: string; reason: string }): string {
  const text = normalizeContinueBucketText([
    decision.nextAction,
    decision.gap,
    decision.reason,
  ].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).join(' '));
  if (!text) return 'generic';

  const categories: Array<{ key: string; pattern: RegExp }> = [
    { key: 'commit_push', pattern: /\b(commit|push|git push|git commit|merge|sync|提交|推送|合并)\b/iu },
    { key: 'test_verify', pattern: /\b(test|tests|testing|verify|verification|validate|validation|regression|vitest|pytest|jest|检查|验证|测试|回归)\b/iu },
    { key: 'audit_review', pattern: /\b(audit|review|审计|审核|评审)\b/iu },
    { key: 'fix_repair', pattern: /\b(fix|repair|bug|regression|修复|返工|rework)\b/iu },
    { key: 'implement_code', pattern: /\b(implement|code|edit|change|update|refactor|write|add|实现|修改|编写|补充|重构)\b/iu },
    { key: 'docs_spec', pattern: /\b(doc|docs|documentation|spec|openspec|proposal|design|文档|规范|设计|proposal)\b/iu },
    { key: 'deploy_restart', pattern: /\b(deploy|release|restart|daemon|发布|部署|重启)\b/iu },
    { key: 'investigate', pattern: /\b(check|inspect|investigate|diagnose|analyze|look into|查看|排查|分析|调查)\b/iu },
  ];
  const matched = categories.find((entry) => entry.pattern.test(text));
  if (matched) return matched.key;
  return text.slice(0, 120);
}

const REPOSITORY_FINALIZATION_ACTION_RE = /(?:\b(?:git\s+(?:add|commit|push)|commit|push|stage|staging)\b|提交|推送|暂存)/iu;
const SUBSTANTIVE_PRE_AUDIT_ACTION_RE = /(?:\b(?:test|tests|testing|typecheck|lint|build|verify|verification|validate|validation|fix|repair|implement|edit|modify|update|write|refactor|deploy|release|restart)\b|测试|类型检查|构建|验证|修复|实现|修改|更新|编写|重构|部署|发布|重启)/iu;
const COMPLETED_PRE_AUDIT_WORK_RE = /(?:\b(?:implementation|fix(?:es)?|coding|changes?|tests?|testing|typecheck|lint|build|verification|validation)\b[\s\S]{0,80}\b(?:complete|completed|done|finished|pass(?:ed)?)\b|(?:修复|实现|代码|改动|测试|验证|检查|类型检查|构建)[\s\S]{0,60}(?:已完成|已经完成|均已完成|全部完成|完成并通过|已通过|验证通过|测试通过))/iu;
const PENDING_PRE_AUDIT_WORK_RE = /(?:\b(?:still|yet|remaining|pending|missing|failed?|incomplete|need(?:s)?\s+to|must)\b[\s\S]{0,50}\b(?:implementation|fix(?:es)?|tests?|testing|typecheck|lint|build|verification|validation)\b|\b(?:implementation|fix(?:es)?|tests?|testing|typecheck|lint|build|verification|validation)\b[\s\S]{0,50}\b(?:remain(?:s|ing)?|pending|missing|fail(?:ed|ing)?|incomplete|not\s+(?:done|complete)|need(?:s)?|required)\b|(?:仍|还|尚|待|未|缺少|失败)[\s\S]{0,30}(?:测试|验证|修复|实现|构建|类型检查)|(?:测试|验证|修复|实现|构建|类型检查)[\s\S]{0,30}(?:未完成|仍需|还需|待处理|失败|缺失|未通过))/iu;
const POST_AUDIT_REPOSITORY_FINALIZATION_ACTION = 'Peer-audit has passed. Finalize only the already-audited repository changes: stage the intended task files, commit them, and push the current branch. Do not request or start another audit.';

type RepositoryFinalizationClassification = 'none' | 'finalization_only' | 'completion_evidenced_mixed';

/**
 * `supervised_audit` must review the implementation before repository
 * finalization. Only hold an action whose imperative next step is purely
 * stage/commit/push work. Any instruction that also asks for tests, fixes,
 * implementation, build, deployment, or another substantive mutation stays
 * in the normal pre-audit continue loop. Audit/review words are deliberately
 * not substantive here: "commit after peer-audit PASS" describes the gate
 * this function is deciding to start, rather than work the target session
 * must perform before that gate.
 */
function isRepositoryFinalizationOnly(decision: { nextAction?: string }): decision is { nextAction: string } {
  const action = decision.nextAction?.trim();
  return Boolean(action
    && REPOSITORY_FINALIZATION_ACTION_RE.test(action)
    && !SUBSTANTIVE_PRE_AUDIT_ACTION_RE.test(action));
}

function hasRepositoryFinalizationAction(decision: { nextAction?: string }): boolean {
  return Boolean(decision.nextAction?.trim() && REPOSITORY_FINALIZATION_ACTION_RE.test(decision.nextAction));
}

/**
 * Supervisors occasionally violate the prompt contract by combining a
 * commit/push instruction with generic wording such as "finish remaining
 * validation", even though both their rationale and the completed assistant
 * turn say that implementation and validation already passed. Treating that
 * contradiction as substantive work sends a vague `supervision_continue_v1`
 * instead of the dedicated audit prompt; the agent then manually delegates an
 * audit while the daemon remains in `execution`, and the next idle repeats the
 * same request forever.
 *
 * Require matching completion evidence from both the supervisor decision and
 * the actual assistant turn, and reject either side if it names concrete
 * pending pre-audit work. This keeps real "run tests/fix failures, then
 * commit" decisions in the execution loop while deterministically promoting
 * the documented completed-work contradiction into the one-shot audit phase.
 */
function classifyRepositoryFinalization(
  decision: { reason: string; nextAction?: string; gap?: string },
  assistantResponse: string | undefined,
): RepositoryFinalizationClassification {
  if (!hasRepositoryFinalizationAction(decision)) return 'none';
  if (isRepositoryFinalizationOnly(decision)) return 'finalization_only';

  const decisionEvidence = [decision.reason, decision.gap]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .join(' ');
  const assistantEvidence = assistantResponse?.trim() ?? '';
  if (!COMPLETED_PRE_AUDIT_WORK_RE.test(decisionEvidence)
    || !COMPLETED_PRE_AUDIT_WORK_RE.test(assistantEvidence)
    || PENDING_PRE_AUDIT_WORK_RE.test(decisionEvidence)
    || PENDING_PRE_AUDIT_WORK_RE.test(assistantEvidence)) {
    return 'none';
  }
  return 'completion_evidenced_mixed';
}

function formatUnavailableReason(
  reason: SupervisionUnavailableReason | undefined,
  providerFailure?: SupervisionProviderFailure,
  providerMessage?: string,
  providerSelection?: { backend?: string; model?: string },
): string | null {
  switch (reason) {
    case SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_NOT_CONNECTED:
      return 'Automation could not reach the configured supervisor provider. Manual continuation is required.';
    case SUPERVISION_UNAVAILABLE_REASONS.INVALID_SNAPSHOT:
      return 'Automation configuration is invalid. Repair the Auto settings before continuing.';
    case SUPERVISION_UNAVAILABLE_REASONS.QUEUE_TIMEOUT:
      return 'Automation timed out waiting for supervisor capacity. Manual continuation is required.';
    case SUPERVISION_UNAVAILABLE_REASONS.DECISION_TIMEOUT:
      return 'Automation timed out waiting for a supervisor decision. Manual continuation is required.';
    case SUPERVISION_UNAVAILABLE_REASONS.INVALID_OUTPUT:
      return 'Automation could not parse a valid supervisor decision. Manual continuation is required.';
    case SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_ERROR: {
      const attemptText = providerFailure && providerFailure.attempts > 1
        ? ` after ${providerFailure.attempts} attempts`
        : '';
      const selectionText = providerSelection?.backend && providerSelection.model
        ? ` ${providerSelection.backend}/${providerSelection.model}`
        : '';
      switch (providerFailure?.code) {
        case PROVIDER_ERROR_CODES.AUTH_FAILED:
          return `Automation could not authenticate supervisor model${selectionText}. Check the provider credentials in Auto settings.`;
        case PROVIDER_ERROR_CODES.CONFIG_ERROR:
        case PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND:
          return `Automation could not start supervisor model${selectionText}. Repair the Auto settings before continuing.`;
        case PROVIDER_ERROR_CODES.RATE_LIMITED:
          return `Automation could not obtain a decision from supervisor model${selectionText}${attemptText} because the provider is rate-limited. Manual continuation is required.`;
        default: {
          const safeDetail = sanitizeMcpErrorMessage(providerMessage, 'provider error');
          return `Automation could not obtain a decision from supervisor model${selectionText}${attemptText}: ${safeDetail}. Manual continuation is required.`;
        }
      }
    }
    default:
      return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readMarkdownTree(root: string, maxFiles = 50): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];
  const queue: Array<{ absPath: string; relPath: string }> = [{ absPath: root, relPath: path.basename(root) }];

  while (queue.length > 0 && results.length < maxFiles) {
    const item = queue.shift()!;
    let entries: DirEntryLike[];
    try {
      entries = (await readdir(item.absPath, { withFileTypes: true })) as unknown as DirEntryLike[];
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const absPath = path.join(item.absPath, entry.name);
      const relPath = path.join(item.relPath, entry.name);
      if (entry.isDirectory()) {
        queue.push({ absPath, relPath });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      try {
        const content = await readFile(absPath, 'utf8');
        results.push({ path: relPath.replaceAll(path.sep, '/'), content });
      } catch {
        // Ignore unreadable files; audit can still proceed with the rest.
      }
    }
  }

  return results;
}

function stringifyAuditValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => stringifyAuditValue(entry))
      .filter((entry): entry is string => !!entry);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value, null, 2);
      return text === '{}' ? null : text;
    } catch {
      return null;
    }
  }
  return null;
}

function summarizeFileChangePatch(patch: FileChangePatch): string {
  const header = [
    `${patch.operation.toUpperCase()} ${patch.filePath}`,
    patch.oldPath ? `(from ${patch.oldPath})` : '',
    `[${patch.confidence}]`,
  ].filter(Boolean).join(' ');
  const body = patch.unifiedDiff
    ?? patch.afterText
    ?? patch.beforeText
    ?? stringifyAuditValue(patch.raw)
    ?? '(no diff payload)';
  return `${header}\n${body}`.trim();
}

function collectTimelineAuditArtifacts(sessionName: string): TimelineAuditArtifacts {
  const events = timelineEmitter.replay(sessionName, 0).events.slice(-200);
  const changedFileEntries: string[] = [];
  const validationEntries: string[] = [];

  for (const event of events) {
    if (event.type === TIMELINE_EVENT_FILE_CHANGE) {
      const batch = event.payload.batch as { patches?: FileChangePatch[] } | undefined;
      for (const patch of batch?.patches ?? []) {
        changedFileEntries.push(summarizeFileChangePatch(patch));
      }
      continue;
    }
    if (event.type === 'tool.result') {
      const text = stringifyAuditValue(
        event.payload.output
        ?? event.payload.result
        ?? event.payload.text
        ?? event.payload.content,
      );
      if (text) validationEntries.push(text);
      continue;
    }
    if (event.type === 'command.ack' && typeof event.payload.error === 'string' && event.payload.error.trim()) {
      validationEntries.push(`Command error: ${event.payload.error.trim()}`);
    }
  }

  return {
    changedFiles: changedFileEntries.length > 0
      ? [{ path: 'changed-files.txt', content: changedFileEntries.join('\n\n---\n\n') }]
      : [],
    validationOutputs: validationEntries.length > 0
      ? [{ path: 'validation-output.txt', content: validationEntries.join('\n\n---\n\n') }]
      : [],
  };
}

function resolveReferencedOpenSpecChangeName(
  run: ActiveTaskRunState,
  changeNames: string[],
): string | null {
  const haystack = `${run.userText}\n${run.lastAssistantText ?? ''}`;
  const explicitPathMatches = changeNames.filter((changeName) => haystack.includes(`openspec/changes/${changeName}`));
  if (explicitPathMatches.length === 1) return explicitPathMatches[0]!;
  if (explicitPathMatches.length > 1) return null;

  const directNameMatches = changeNames.filter((changeName) => {
    const escaped = changeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
  });
  return directNameMatches.length === 1 ? directNameMatches[0]! : null;
}

async function resolveAuditBaseline(sessionName: string, run: ActiveTaskRunState): Promise<AuditBaseline> {
  const timelineArtifacts = collectTimelineAuditArtifacts(sessionName);
  const record = getSession(sessionName);
  const projectDir = record?.projectDir?.trim();
  const openspecChangesDir = projectDir ? path.join(projectDir, 'openspec', 'changes') : undefined;
  const changeCandidates: Array<{ dir: string; mdFiles: Array<{ path: string; content: string }> }> = [];

  if (openspecChangesDir && await fileExists(openspecChangesDir)) {
    let entries: DirEntryLike[];
    try {
      entries = (await readdir(openspecChangesDir, { withFileTypes: true })) as unknown as DirEntryLike[];
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const changeDir = path.join(openspecChangesDir, entry.name);
      const tasksMd = path.join(changeDir, 'tasks.md');
      const proposalMd = path.join(changeDir, 'proposal.md');
      const designMd = path.join(changeDir, 'design.md');
      if (!(await fileExists(tasksMd)) || !(await fileExists(proposalMd)) || !(await fileExists(designMd))) continue;
      const mdFiles = await readMarkdownTree(changeDir);
      changeCandidates.push({ dir: changeDir, mdFiles });
    }
  }

  const referencedChangeName = resolveReferencedOpenSpecChangeName(
    run,
    changeCandidates.map((candidate) => path.basename(candidate.dir)),
  );
  if (referencedChangeName) {
    const candidate = changeCandidates.find((entry) => path.basename(entry.dir) === referencedChangeName);
    if (!candidate) {
      throw new Error(`Referenced OpenSpec change not found: ${referencedChangeName}`);
    }
    const changeName = path.basename(candidate.dir);
    return {
      kind: 'openspec',
      changeDir: candidate.dir,
      fileContents: [...candidate.mdFiles, ...timelineArtifacts.changedFiles, ...timelineArtifacts.validationOutputs],
      userText: [
        `OpenSpec implementation audit for change: ${changeName}`,
        `Audit verdict contract: ${SUPERVISION_CONTRACT_IDS.OPENSPEC_IMPLEMENTATION_AUDIT}`,
        '',
        `The completed implementation claims the task is ${run.terminalState ?? 'complete'}. Audit the implementation-only path against proposal, design, tasks, and specs.`,
        'Do not rerun discussion or proposal phases.',
      ].join('\n'),
    };
  }

  const summary = [
    `Contextual implementation audit for session ${sessionName}.`,
    `Audit verdict contract: ${SUPERVISION_CONTRACT_IDS.CONTEXTUAL_AUDIT}`,
    `Task request: ${run.userText}`,
    `Last assistant output: ${run.lastAssistantText ?? '(none)'}`,
    `Task terminal state: ${run.terminalState ?? 'missing'}`,
  ].join('\n');

  return {
    kind: 'contextual',
    userText: summary,
    fileContents: [
      { path: 'contextual-audit-summary.md', content: summary },
      ...timelineArtifacts.changedFiles,
      ...timelineArtifacts.validationOutputs,
    ],
  };
}

function buildReworkBrief(run: ActiveTaskRunState, verdictText: string): string {
  return buildReworkBriefPrompt(run.sessionName, run.userText, run.lastAssistantText, verdictText);
}

function isFinalAssistantPayload(payload: Record<string, unknown>): boolean {
  return payload.streaming === false || payload.streaming === undefined;
}

class SupervisionAutomation {
  private activeRuns = new Map<string, ActiveTaskRunState>();
  private pendingTaskIntents = new Map<string, PendingTaskIntent>();
  private recentTaskCandidates = new Map<string, RecentTaskCandidate>();
  private latestAssistantTexts = new Map<string, LatestAssistantText>();
  private lastObservedSessionStates = new Map<string, string>();
  private initialized = false;
  private eventSequence = 0;

  private emitWarning(sessionName: string, text: string): void {
    timelineEmitter.emit(
      sessionName,
      'assistant.text',
      { text: `⚠️ ${text}`, streaming: false, automation: true, automationKind: 'supervision-warning', memoryExcluded: true },
      { source: 'daemon', confidence: 'high', eventId: `supervision-warning:${randomUUID()}` },
    );
  }

  private emitAutomationNote(sessionName: string, text: string, kind: string): void {
    timelineEmitter.emit(
      sessionName,
      'assistant.text',
      { text, streaming: false, automation: true, automationKind: kind, memoryExcluded: true },
      { source: 'daemon', confidence: 'high', eventId: `supervision-note:${sessionName}` },
    );
  }

  private emitStatus(sessionName: string, status: string, label: string): void {
    timelineEmitter.emit(
      sessionName,
      'agent.status',
      { status, label },
      { source: 'daemon', confidence: 'high', eventId: `supervision-status:${sessionName}:${status}` },
    );
  }

  private clearStatus(sessionName: string): void {
    timelineEmitter.emit(
      sessionName,
      'agent.status',
      { status: null, label: null },
      { source: 'daemon', confidence: 'high', eventId: `supervision-status:${sessionName}:clear` },
    );
  }

  private emitTerminalStatus(sessionName: string, status: string, label: string): void {
    this.emitStatus(sessionName, status, label);
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    timelineEmitter.on((event) => {
      this.handleTimelineEvent(event);
    });
  }

  setServerLink(_serverLink: ServerLink | null): void {
    // Kept as a compatibility hook for lifecycle wiring. Lightweight peer
    // audit dispatch is daemon-local and does not use the P2P server link.
  }

  cancelSession(sessionName: string): void {
    const state = this.activeRuns.get(sessionName);
    if (state?.phase === 'auditing' && state.auditAttemptId) {
      this.clearAuditDeadline(state);
      this.clearAuditTargetRecovery(state);
      this.emitOrchestratedAuditResult(state, 'cancelled', 'session_supervision_cancelled');
    }
    this.activeRuns.delete(sessionName);
    this.pendingTaskIntents.delete(sessionName);
    this.recentTaskCandidates.delete(sessionName);
    this.latestAssistantTexts.delete(sessionName);
    this.lastObservedSessionStates.delete(sessionName);
    this.clearStatus(sessionName);
  }

  applySnapshotUpdate(sessionName: string, snapshot: SessionSupervisionSnapshot | null | undefined): void {
    peerAuditService.applyAutomaticConfiguration(
      sessionName,
      Boolean(snapshot && snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
        && snapshot.auditTargetSessionName),
    );
    if (!snapshot || snapshot.mode === SUPERVISION_MODE.OFF) {
      this.cancelSession(sessionName);
      return;
    }
    const active = this.activeRuns.get(sessionName);
    if (active) {
      active.snapshot = snapshot;
      active.hasLiveSnapshotUpdate = true;
    }
    const pending = this.pendingTaskIntents.get(sessionName);
    if (pending) {
      this.pendingTaskIntents.set(sessionName, { ...pending, snapshot });
    }
    // Regression fix: if supervision was freshly enabled on an already-idle
    // session (user flipped Auto ON after the assistant had already finished a
    // turn), we must evaluate the most recent turn NOW. Waiting for the next
    // idle boundary would mean "nothing ever happens" until the user sends
    // another message — which is exactly the symptom reported as
    // "idle 后依旧不触发任何动作和效果".
    //
    // We reuse the same implicit-idle preconditions as `handleTimelineEvent`
    // (recent task candidate + newer assistant response) so the guardrails
    // against stale turns stay identical.
    if (!active && this.isSessionIdle(sessionName)) {
      if (!this.tryStartImplicitRun(sessionName, snapshot)) {
        this.failClosedImplicitCandidate(sessionName, snapshot);
      }
    }
  }

  private isSessionIdle(sessionName: string): boolean {
    const observed = this.lastObservedSessionStates.get(sessionName);
    if (observed) return observed === 'idle';
    return getSession(sessionName)?.state === 'idle';
  }

  private isEligibleAssistantCompletionPayload(payload: Record<string, unknown>): boolean {
    return isFinalAssistantPayload(payload)
      && payload.automation !== true
      && payload.memoryExcluded !== true;
  }

  private emitCheckingState(sessionName: string): void {
    this.emitStatus(sessionName, 'supervision_waiting', SUPERVISION_WAITING_LABEL);
    this.emitAutomationNote(sessionName, 'Auto: checking whether the task is complete...', 'supervision-status');
  }

  private failClosedMissingCompletion(sessionName: string): void {
    this.emitTerminalStatus(sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
    this.emitWarning(sessionName, 'Automation stopped because no completed assistant response was available for that turn. Manual continuation is required.');
  }

  private tryStartImplicitRun(
    sessionName: string,
    snapshot: SessionSupervisionSnapshot,
  ): boolean {
    const candidate = this.recentTaskCandidates.get(sessionName);
    const latestAssistant = this.latestAssistantTexts.get(sessionName);
    if (!candidate || !latestAssistant) return false;
    if (latestAssistant.sequence <= candidate.sequence) return false;
    const implicitRun = this.registerTaskIntent(sessionName, candidate.commandId, candidate.text, snapshot);
    if (!implicitRun) return false;
    implicitRun.lastAssistantText = latestAssistant.text;
    implicitRun.sawAssistantOutput = true;
    implicitRun.evaluating = true;
    this.emitCheckingState(sessionName);
    void this.evaluateExecutionTurn(implicitRun).catch((error) => {
      logger.warn({ session: sessionName, err: error }, 'Supervision implicit execution evaluation failed on snapshot update');
      this.clearStatus(sessionName);
      this.emitWarning(sessionName, 'Automation could not determine whether the task is complete. Manual continuation is required.');
      this.finishRun(sessionName, 'needs_input');
    });
    return true;
  }

  private failClosedImplicitCandidate(
    sessionName: string,
    snapshot: SessionSupervisionSnapshot | null | undefined,
  ): void {
    if (!snapshot || snapshot.mode === SUPERVISION_MODE.OFF) return;
    const candidate = this.recentTaskCandidates.get(sessionName);
    if (!candidate) return;
    this.recentTaskCandidates.delete(sessionName);
    this.failClosedMissingCompletion(sessionName);
  }

  queueTaskIntent(
    sessionName: string,
    commandId: string,
    text: string,
    snapshot: SessionSupervisionSnapshot,
  ): void {
    if (snapshot.mode === SUPERVISION_MODE.OFF) return;
    this.cancelSession(sessionName);
    this.pendingTaskIntents.set(sessionName, { commandId, text, snapshot });
  }

  updateQueuedTaskIntent(sessionName: string, commandId: string, text: string): void {
    const pending = this.pendingTaskIntents.get(sessionName);
    if (!pending || pending.commandId !== commandId) return;
    this.pendingTaskIntents.set(sessionName, { ...pending, text });
  }

  removeQueuedTaskIntent(sessionName: string, commandId: string): void {
    const pending = this.pendingTaskIntents.get(sessionName);
    if (!pending || pending.commandId !== commandId) return;
    this.pendingTaskIntents.delete(sessionName);
  }

  registerTaskIntent(
    sessionName: string,
    commandId: string,
    text: string,
    snapshot: SessionSupervisionSnapshot,
  ): ActiveTaskRunState | null {
    if (snapshot.mode === SUPERVISION_MODE.OFF) return null;
    const existing = this.activeRuns.get(sessionName);
    if (existing?.phase === 'auditing' && existing.auditAttemptId) {
      this.clearAuditDeadline(existing);
      this.clearAuditTargetRecovery(existing);
      this.emitOrchestratedAuditResult(existing, 'cancelled', 'new_task_intent_replaced_existing_audit');
    }
    const next: ActiveTaskRunState = {
      generation: (existing?.generation ?? 0) + 1,
      sessionName,
      commandId,
      snapshot,
      hasLiveSnapshotUpdate: false,
      userText: text,
      phase: 'execution',
      continueLoops: 0,
      continueStreakCount: 0,
      evaluating: false,
      sawAssistantOutput: false,
      reworkDispatches: 0,
      auditReplyObserved: false,
      auditTargetObservedActive: false,
      auditTargetRecoveryAttempts: 0,
      auditTargetRecoveryLimitNotified: false,
      startedAt: Date.now(),
    };
    this.recentTaskCandidates.delete(sessionName);
    this.activeRuns.set(sessionName, next);
    return next;
  }

  getActiveRun(sessionName: string): ActiveTaskRunState | undefined {
    return this.activeRuns.get(sessionName);
  }

  private clearAuditTargetRecoveryTimer(run: ActiveTaskRunState): void {
    if (run.auditTargetRecoveryTimer) clearTimeout(run.auditTargetRecoveryTimer);
    run.auditTargetRecoveryTimer = undefined;
  }

  private clearAuditTargetRecovery(run: ActiveTaskRunState): void {
    this.clearAuditTargetRecoveryTimer(run);
    run.auditTargetObservedActive = false;
    run.auditTargetDispatchObservedAt = undefined;
  }

  private isCorrelatedAuditTargetDispatch(
    run: ActiveTaskRunState,
    payload: Record<string, unknown>,
  ): boolean {
    const text = trimString(payload.text);
    if (!text || !run.auditAttemptId || payload.automation === true) return false;
    const sharedActor = payload.sharedActor && typeof payload.sharedActor === 'object'
      ? payload.sharedActor as Record<string, unknown>
      : undefined;
    const exactActor = trimString(sharedActor?.actorUserId) === run.sessionName;
    const exactReplyRoute = text.includes(AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER)
      && text.includes(buildAgentDelegationReplyInstruction(run.sessionName));
    const exactAttempt = text.includes(run.auditAttemptId);
    // Sub-session delegation carries the authoritative shared-actor identity.
    // Main→main delegation does not, so the attempt id embedded in the brief is
    // the fallback authority there. Both paths must retain the exact reply
    // route back to the audited session.
    return exactReplyRoute && (exactActor || exactAttempt);
  }

  private auditTargetRuntimeIsWorking(sessionName: string): boolean {
    const runtime = getTransportRuntime(sessionName);
    if (!runtime) return false;
    const activity = runtime.getDiagnosticSnapshot();
    return isWorkingSessionState(activity.status)
      || activity.sending
      || activity.pendingCount > 0
      || activity.activeDispatchCount > 0
      || activity.blockingWorkCount > 0;
  }

  private handleAuditTargetTimelineEvent(event: {
    sessionId: string;
    type: string;
    payload: Record<string, unknown>;
  }): void {
    for (const run of this.activeRuns.values()) {
      if (
        run.phase !== 'auditing'
        || run.auditReplyObserved
        || !run.auditAttemptId
        || run.snapshot.auditTargetSessionName !== event.sessionId
      ) continue;

      if (event.type === 'user.message' && this.isCorrelatedAuditTargetDispatch(run, event.payload)) {
        const target = getSession(event.sessionId);
        if (!target || target.sessionInstanceId !== run.auditTargetSessionInstanceId) continue;
        run.auditTargetDispatchObservedAt = Date.now();
        // A correlated user.message is emitted only after a direct transport
        // send is accepted, or when a queued send actually drains. It is thus
        // sufficient proof that this audit attempt entered a real target turn,
        // even if the adjacent `running` edge preceded the message.
        run.auditTargetObservedActive = true;
        this.clearAuditTargetRecoveryTimer(run);
        continue;
      }

      if (event.type !== 'session.state' || run.auditTargetDispatchObservedAt === undefined) continue;
      const state = trimString(event.payload.state);
      if (!state) continue;
      const target = getSession(event.sessionId);
      if (!target || target.sessionInstanceId !== run.auditTargetSessionInstanceId) {
        this.clearAuditTargetRecovery(run);
        continue;
      }
      if (isWorkingSessionState(state) || state === 'queued') {
        run.auditTargetObservedActive = true;
        this.clearAuditTargetRecoveryTimer(run);
        continue;
      }
      if (!run.auditTargetObservedActive) continue;

      const runtime = getTransportRuntime(event.sessionId);
      const providerError = runtime?.lastProviderError;
      const providerErrorBelongsToAttempt = Boolean(
        providerError && providerError.at >= run.auditTargetDispatchObservedAt,
      );
      const failed = state === 'error'
        || state === 'stopped'
        || (state === 'idle' && providerErrorBelongsToAttempt);
      if (!failed) {
        if (state === 'idle') run.auditTargetObservedActive = false;
        continue;
      }

      // Consume the active edge before arming the timer. Duplicate error/idle
      // projections for the same failed turn then cannot schedule duplicates;
      // a genuinely resumed turn must first emit running/queued again.
      run.auditTargetObservedActive = false;
      this.scheduleAuditTargetRecovery(run, state);
    }
  }

  private scheduleAuditTargetRecovery(run: ActiveTaskRunState, failedState: string): void {
    if (run.auditTargetRecoveryTimer || run.auditTargetRecoveryAttempts >= AUDIT_TARGET_MAX_RECOVERY_CONTINUES) {
      if (
        run.auditTargetRecoveryAttempts >= AUDIT_TARGET_MAX_RECOVERY_CONTINUES
        && !run.auditTargetRecoveryLimitNotified
      ) {
        run.auditTargetRecoveryLimitNotified = true;
        this.emitWarning(run.sessionName, 'The configured audit session stopped again after the automatic recovery limit. The audit remains pending for manual intervention.');
      }
      return;
    }
    const generation = run.generation;
    const attemptId = run.auditAttemptId;
    const timer = setTimeout(() => {
      const latest = this.activeRuns.get(run.sessionName);
      if (
        !latest
        || latest.generation !== generation
        || latest.phase !== 'auditing'
        || latest.auditAttemptId !== attemptId
        || latest.auditReplyObserved
      ) return;
      latest.auditTargetRecoveryTimer = undefined;
      this.continueFailedAuditTarget(latest, failedState);
    }, AUDIT_TARGET_RECOVERY_DELAY_MS);
    timer.unref?.();
    run.auditTargetRecoveryTimer = timer;
  }

  private continueFailedAuditTarget(run: ActiveTaskRunState, failedState: string): void {
    const targetName = run.snapshot.auditTargetSessionName;
    const target = targetName ? getSession(targetName) : undefined;
    if (
      !targetName
      || !target
      || target.sessionInstanceId !== run.auditTargetSessionInstanceId
    ) {
      this.emitWarning(run.sessionName, 'The configured audit session changed identity while recovery was pending. No continue prompt was sent.');
      return;
    }
    if (this.auditTargetRuntimeIsWorking(targetName)) {
      run.auditTargetObservedActive = true;
      return;
    }
    const runtime = getTransportRuntime(targetName);
    if (!runtime) {
      this.emitWarning(run.sessionName, 'The configured audit session stopped and has no live runtime, so its audit turn could not be continued automatically.');
      return;
    }
    if (run.auditTargetRecoveryAttempts >= AUDIT_TARGET_MAX_RECOVERY_CONTINUES) return;

    const recoveryNumber = run.auditTargetRecoveryAttempts + 1;
    const recoveryPrompt = [
      `[Contract: ${SUPERVISION_CONTRACT_IDS.AUDIT_TARGET_RECOVERY}]`,
      'Continue the in-progress automatic peer audit. The previous audit turn stopped before returning its result because of a runtime or provider failure.',
      `Audited session ID: ${run.sessionName}`,
      `Audit target session ID: ${targetName}`,
      `Automatic audit attempt ID: ${run.auditAttemptId}`,
      `Observed failed state: ${failedState}`,
      'Resume the same audit from the evidence already available in this session. Do not start or delegate a new audit, do not change the implementation, and do not commit or push.',
      buildAgentDelegationReplyInstruction(run.sessionName),
    ].join('\n');
    const clientMessageId = `${SUPERVISION_AUDIT_TARGET_RECOVERY_AUTOMATION_KIND}:${run.auditAttemptId}:${recoveryNumber}`;
    run.auditTargetRecoveryAttempts = recoveryNumber;
    try {
      runtime.send(recoveryPrompt, clientMessageId);
      timelineEmitter.emit(
        targetName,
        'user.message',
        {
          text: recoveryPrompt,
          clientMessageId,
          allowDuplicate: true,
          automation: true,
          automationKind: SUPERVISION_AUDIT_TARGET_RECOVERY_AUTOMATION_KIND,
          memoryExcluded: true,
        },
        { source: 'daemon', confidence: 'high', eventId: clientMessageId },
      );
      this.emitAutomationNote(
        run.sessionName,
        `Auto: the configured audit session stopped unexpectedly, so supervision sent continue (${recoveryNumber}/${AUDIT_TARGET_MAX_RECOVERY_CONTINUES}) for audit attempt ${run.auditAttemptId}.`,
        SUPERVISION_AUDIT_TARGET_RECOVERY_AUTOMATION_KIND,
      );
      this.armAuditDeadline(run);
    } catch (error) {
      logger.warn({ session: run.sessionName, auditorSession: targetName, err: error }, 'Automatic audit-target continue dispatch failed');
      this.emitWarning(run.sessionName, 'The configured audit session stopped, but its automatic continue prompt could not be delivered.');
    }
  }

  private handleTimelineEvent(event: { sessionId: string; type: string; payload: Record<string, unknown> }): void {
    this.handleAuditTargetTimelineEvent(event);
    const sequence = ++this.eventSequence;

    if (event.type === 'user.message') {
      const pending = this.pendingTaskIntents.get(event.sessionId);
      const clientMessageId = trimString(event.payload.clientMessageId);
      const automation = event.payload.automation === true;
      const text = trimString(event.payload.text);
      const activeRun = this.activeRuns.get(event.sessionId);
      const delegatedReply = Boolean(
        !automation
        && activeRun?.phase === 'auditing'
        && isDelegatedAuditReplyText(text),
      );
      if (delegatedReply && activeRun) {
        this.clearAuditTargetRecovery(activeRun);
        activeRun.auditReplyObserved = true;
        activeRun.sawAssistantOutput = false;
        activeRun.lastAssistantText = undefined;
        this.emitStatus(activeRun.sessionName, 'supervision_audit_waiting', SUPERVISION_AUDIT_WAITING_LABEL);
        this.emitAutomationNote(activeRun.sessionName, 'Auto: the delegated audit reply arrived; waiting for this session to produce the final PASS/REWORK judgment.', 'supervision-audit-reply-received');
      }
      if (!automation && !delegatedReply && text && !text.startsWith('/')) {
        this.recentTaskCandidates.set(event.sessionId, {
          commandId: clientMessageId ?? `implicit:${Date.now()}`,
          text,
          sequence,
        });
      }
      if (pending && !automation && clientMessageId === pending.commandId) {
        this.pendingTaskIntents.delete(event.sessionId);
        this.registerTaskIntent(event.sessionId, pending.commandId, pending.text, pending.snapshot);
      }
    }

    if (event.type === 'assistant.text' && this.isEligibleAssistantCompletionPayload(event.payload)) {
      const text = typeof event.payload.text === 'string' ? event.payload.text : '';
      this.latestAssistantTexts.set(event.sessionId, { text, sequence });
      const run = this.activeRuns.get(event.sessionId);
      if (!run) return;
      run.ignoreIdleUntilPostAuditTurnActivity = false;
      run.lastAssistantText = text;
      run.sawAssistantOutput = true;
      // A retained/background transport can emit the final assistant result
      // without producing another session.state=idle edge afterwards. Waiting
      // exclusively for that edge leaves the audit deadline armed even after
      // this session has reported a reply-backed PASS/REWORK, which later
      // creates a false timeout result. Defer the fallback to a microtask so a
      // normal adjacent idle edge keeps the existing ordering (important when
      // PASS starts finalization or REWORK queues another turn); if no edge is
      // emitted, the final assistant payload settles the audit and disarms the
      // deadline. The generation/phase guard makes the two paths exactly-once.
      if (run.phase === 'auditing' && run.auditReplyObserved) {
        const generation = run.generation;
        queueMicrotask(() => {
          const latest = this.activeRuns.get(event.sessionId);
          if (!latest || latest.generation !== generation || latest.phase !== 'auditing' || !latest.auditReplyObserved) return;
          this.handleOrchestratedAuditCompletion(latest, { settledWithoutIdle: true });
        });
      }
      return;
    }

    if (event.type === 'session.state') {
      const run = this.activeRuns.get(event.sessionId);
      const state = trimString(event.payload.state);
      if (state) this.lastObservedSessionStates.set(event.sessionId, state);
      if (state === 'idle' && !run) {
        const candidate = this.recentTaskCandidates.get(event.sessionId);
        const record = getSession(event.sessionId);
        const snapshot = record?.agentType
          ? extractSessionSupervisionSnapshot(record.transportConfig ?? null)
          : null;
        if (candidate && snapshot && snapshot.mode !== SUPERVISION_MODE.OFF) {
          if (!this.tryStartImplicitRun(event.sessionId, snapshot)) {
            this.failClosedImplicitCandidate(event.sessionId, snapshot);
          }
        }
        // Intentionally: do NOT delete the candidate when supervision is OFF
        // at idle. The user may enable Auto afterwards, and
        // `applySnapshotUpdate` uses this candidate to kick off an implicit
        // run against the most recent completed turn. Clearing here was the
        // reason "idle 后依旧不触发任何动作和效果" when Auto was turned on
        // against an already-idle session.
        return;
      }
      if (!run) return;
      if (state && state !== 'idle') {
        run.ignoreIdleUntilPostAuditTurnActivity = false;
      }
      if (state === 'idle' && (run.phase === 'execution' || run.phase === 'finalizing') && !run.evaluating) {
        if (!run.sawAssistantOutput) {
          if (run.ignoreIdleUntilPostAuditTurnActivity) {
            run.ignoreIdleUntilPostAuditTurnActivity = false;
            return;
          }
          this.failClosedMissingCompletion(run.sessionName);
          this.finishRun(run.sessionName, 'needs_input', { preserveStatus: true });
          return;
        }
        this.emitCheckingState(run.sessionName);
        run.evaluating = true;
        void this.evaluateExecutionTurn(run).catch((error) => {
          logger.warn({ session: run.sessionName, err: error }, 'Supervision execution evaluation failed');
          this.clearStatus(run.sessionName);
          this.emitWarning(run.sessionName, 'Automation could not determine whether the task is complete. Manual continuation is required.');
          this.finishRun(run.sessionName, 'needs_input');
        });
      }
      if ((state === 'stopped' || state === 'error') && run.phase === 'execution') {
        this.emitTerminalStatus(run.sessionName, 'supervision_blocked', SUPERVISION_BLOCKED_LABEL);
        this.emitWarning(run.sessionName, 'Supervision stopped because the session entered a blocked state.');
        this.finishRun(run.sessionName, 'blocked', { preserveStatus: true });
      }
      if (state === 'idle' && run.phase === 'auditing' && run.auditReplyObserved && run.sawAssistantOutput) {
        this.handleOrchestratedAuditCompletion(run);
      }
    }
  }

  private async evaluateExecutionTurn(run: ActiveTaskRunState): Promise<void> {
    const current = this.activeRuns.get(run.sessionName);
    if (!current || current.generation !== run.generation || (current.phase !== 'execution' && current.phase !== 'finalizing')) return;
    const evaluatedPhase = current.phase;

    const record = getSession(run.sessionName);
    let decision;
    try {
      decision = await supervisionBroker.decide({
        snapshot: enrichSnapshotWithGlobalDefaults(current.snapshot),
        taskRequest: current.userText,
        assistantResponse: current.lastAssistantText,
        cwd: record?.projectDir,
        description: record?.description,
      });
    } finally {
      this.clearStatus(run.sessionName);
    }

    const latest = this.activeRuns.get(run.sessionName);
    if (!latest || latest.generation !== run.generation || latest.phase !== evaluatedPhase) return;
    latest.evaluating = false;

    switch (decision.decision) {
      case 'complete': {
        latest.terminalState = 'complete';
        if (latest.phase === 'finalizing') {
          this.emitAutomationNote(run.sessionName, 'Auto: peer audit passed and post-audit finalization completed.', 'supervision-post-audit-complete');
          this.emitTerminalStatus(run.sessionName, 'supervision_complete', SUPERVISION_COMPLETE_LABEL);
          this.finishRun(run.sessionName, 'complete', { preserveStatus: true });
        } else if (latest.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT) {
          await this.startAudit(latest);
        } else {
          this.emitAutomationNote(run.sessionName, 'Auto: task looks complete.', 'supervision-complete');
          this.emitTerminalStatus(run.sessionName, 'supervision_complete', SUPERVISION_COMPLETE_LABEL);
          this.finishRun(run.sessionName, 'complete', { preserveStatus: true });
        }
        return;
      }
      case 'continue': {
        const repositoryFinalization = classifyRepositoryFinalization(decision, latest.lastAssistantText);
        if (
          latest.phase === 'execution'
          && latest.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
          && repositoryFinalization !== 'none'
        ) {
          latest.deferredFinalization = {
            reason: decision.reason,
            // A completion-evidenced mixed decision is internally
            // contradictory. Do not replay its generic validation/audit words
            // after PASS: doing so can ask for a second audit. The normalized
            // action contains repository finalization only.
            nextAction: repositoryFinalization === 'finalization_only'
              ? decision.nextAction ?? POST_AUDIT_REPOSITORY_FINALIZATION_ACTION
              : POST_AUDIT_REPOSITORY_FINALIZATION_ACTION,
            ...(decision.gap ? { gap: decision.gap } : {}),
          };
          latest.terminalState = 'complete';
          await this.startAudit(latest);
          return;
        }
        const continueBucket = classifyContinueBucket({
          reason: decision.reason,
          nextAction: decision.nextAction,
          gap: decision.gap,
        });
        const nextStreakCount = latest.lastContinueBucket === continueBucket
          ? latest.continueStreakCount + 1
          : 1;
        const maxAutoContinueStreak = latest.snapshot.maxAutoContinueStreak ?? SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_STREAK;
        const maxAutoContinueTotal = latest.snapshot.maxAutoContinueTotal ?? SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_TOTAL;

        if (maxAutoContinueStreak > 0 && nextStreakCount > maxAutoContinueStreak) {
          this.emitWarning(run.sessionName, `Automation reached the repeated auto-continue limit (${maxAutoContinueStreak}) for ${continueBucket}; handing control back to the human.`);
          this.finishRun(run.sessionName, 'needs_input');
          return;
        }
        if (maxAutoContinueTotal > 0 && latest.continueLoops >= maxAutoContinueTotal) {
          this.emitWarning(run.sessionName, `Automation reached the auto-continue hard limit (${maxAutoContinueTotal}); handing control back to the human.`);
          this.finishRun(run.sessionName, 'needs_input');
          return;
        }
        latest.lastContinueBucket = continueBucket;
        latest.continueStreakCount = nextStreakCount;
        // Forward the full decision so the continue prompt can lead with
        // the supervisor's concrete nextAction. Without this, the target
        // agent only sees the reason and has to infer what to do next —
        // which historically caused the "rewrite same answer" loop.
        const guardedNextAction = latest.phase === 'execution'
          && latest.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
          && hasRepositoryFinalizationAction(decision)
          ? 'Complete only the remaining substantive implementation or validation work described by the supervisor. Do not stage, commit, or push; repository finalization is deferred until peer-audit PASS.'
          : decision.nextAction;
        await this.dispatchContinue(latest, {
          reason: decision.reason,
          nextAction: guardedNextAction,
          gap: decision.gap,
        });
        return;
      }
      case 'ask_human':
      default: {
        const unavailableText = formatUnavailableReason(
          decision.unavailableReason,
          decision.providerFailure,
          decision.reason,
          { backend: run.snapshot.backend, model: run.snapshot.model },
        );
        this.emitTerminalStatus(run.sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
        this.emitWarning(run.sessionName, unavailableText ?? `Automation returned control to the human: ${decision.reason}`);
        this.finishRun(run.sessionName, 'needs_input', { preserveStatus: true });
      }
    }
  }

  private finishRun(
    sessionName: string,
    state: TaskRunTerminalState,
    options: { preserveStatus?: boolean } = {},
  ): void {
    const run = this.activeRuns.get(sessionName);
    if (!run) return;
    this.clearAuditDeadline(run);
    this.clearAuditTargetRecovery(run);
    run.terminalState = state;
    this.activeRuns.delete(sessionName);
    if (!options.preserveStatus) this.clearStatus(sessionName);
  }

  private async startAudit(run: ActiveTaskRunState): Promise<void> {
    if (run.phase !== 'execution' || this.activeRuns.get(run.sessionName)?.generation !== run.generation) return;
    const baseline = await resolveAuditBaseline(run.sessionName, run);
    const current = this.activeRuns.get(run.sessionName);
    if (!current || current.generation !== run.generation) return;

    current.phase = 'auditing';
    current.evaluating = false;
    current.auditReplyObserved = false;
    current.auditAttemptId = randomUUID();
    current.auditStartedAt = Date.now();
    current.auditTargetSessionInstanceId = undefined;
    current.auditTargetDispatchObservedAt = undefined;
    current.auditTargetObservedActive = false;
    current.auditTargetRecoveryAttempts = 0;
    current.auditTargetRecoveryLimitNotified = false;
    this.clearAuditTargetRecoveryTimer(current);
    current.sawAssistantOutput = false;
    current.lastAssistantText = undefined;
    this.emitStatus(current.sessionName, 'supervision_audit_waiting', SUPERVISION_AUDIT_WAITING_LABEL);
    this.emitAutomationNote(current.sessionName, '⏳ Auto is asking this session to prepare and delegate the peer audit. Commit/push is paused until PASS.', 'supervision-audit');

    const record = getSession(current.sessionName);
    // The task-run snapshot can predate a settings change performed while the
    // task is still running. Re-read the persisted configuration at the audit
    // boundary so the latest selected session name is used for delegation.
    const authoritativeSnapshot = record
      ? extractSessionSupervisionSnapshot(record.transportConfig ?? null)
      : null;
    const latestSnapshot = current.hasLiveSnapshotUpdate ? current.snapshot : authoritativeSnapshot;
    let automaticSnapshot = latestSnapshot?.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
      ? latestSnapshot
      : null;
    if (automaticSnapshot) current.snapshot = automaticSnapshot;

    const targetName = automaticSnapshot?.auditTargetSessionName;
    const target = targetName ? getSession(targetName) : undefined;
    const transportRuntime = getTransportRuntime(current.sessionName);
    if (!record || !targetName || !target || !transportRuntime) {
      logger.warn({
        session: current.sessionName,
        hasRecord: Boolean(record),
        hasAutomaticSnapshot: Boolean(automaticSnapshot),
        hasTargetName: Boolean(targetName),
        hasTarget: Boolean(target),
        hasTransportRuntime: Boolean(transportRuntime),
      }, 'Automatic audit preflight could not resolve the selected session');
      this.emitOrchestratedAuditResult(current, 'invalid_configuration', 'invalid_configuration');
      this.emitWarning(current.sessionName, 'Automation peer audit could not resolve the current session or configured auditor. Manual review is required.');
      this.finishRun(current.sessionName, 'needs_input');
      return;
    }

    current.auditTargetSessionInstanceId = target.sessionInstanceId;

    const auditTask = [
      buildQuickAgentDelegationTask('audit'),
      'This is the configured automatic supervision audit. You—not the daemon—must prepare the audit background from your real current-session context and send it to the selected delegate with reply enabled.',
      `Automatic audit attempt ID: ${current.auditAttemptId}. Include this exact attempt ID in the delegated audit brief. The route is fixed: send exactly one reply-enabled audit request to ${targetName}. Do not choose another session or send a second audit while this attempt is pending.`,
      'Do not commit, push, deploy, or modify the implementation while waiting for the audit.',
      baseline.changeDir ? `Relevant OpenSpec change: ${baseline.changeDir}` : '',
      baseline.fileContents.length > 0
        ? `Relevant changed paths observed by supervision: ${baseline.fileContents.map((entry) => entry.path).join(', ')}`
        : '',
      'After the delegated reply returns to this session, evaluate its evidence and state the concrete findings.',
      `End that post-reply final response with exactly one marker: ${PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.PASS} or ${PEER_AUDIT_ORCHESTRATED_RESULT_MARKERS.REWORK}. Do not emit either marker before the delegated reply arrives.`,
    ].filter(Boolean).join(' ');
    const orchestrationPrompt = buildAgentDelegationOrchestrationPrompt({
      targetSession: targetName,
      targetLabel: target.label,
      task: auditTask,
    });
    timelineEmitter.emit(
      current.sessionName,
      'user.message',
      { text: orchestrationPrompt, allowDuplicate: true, automation: true, automationKind: 'supervision-audit-delegation' },
      { source: 'daemon', confidence: 'high', eventId: `supervision-audit-delegation:${current.generation}:${current.auditAttemptId}` },
    );
    try {
      transportRuntime.send(orchestrationPrompt, `supervision-audit-delegation-${current.generation}`);
    } catch (error) {
      logger.warn({ session: current.sessionName, err: error }, 'Automatic audit orchestration dispatch failed');
      this.emitOrchestratedAuditResult(current, 'target_unavailable', 'dispatch_failed');
      this.emitWarning(current.sessionName, 'Automation could not ask the current session to prepare the peer audit. Manual review is required.');
      this.finishRun(current.sessionName, 'needs_input');
      return;
    }
    this.armAuditDeadline(current);
  }

  private armAuditDeadline(run: ActiveTaskRunState): void {
    this.clearAuditDeadline(run);
    const generation = run.generation;
    const attemptId = run.auditAttemptId;
    const timer = setTimeout(() => {
      const latest = this.activeRuns.get(run.sessionName);
      if (
        !latest
        || latest.generation !== generation
        || latest.phase !== 'auditing'
        || latest.auditAttemptId !== attemptId
      ) return;
      this.emitOrchestratedAuditResult(latest, 'timeout', 'deadline_expired');
      this.emitTerminalStatus(latest.sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
      this.finishRun(latest.sessionName, 'needs_input', { preserveStatus: true });
    }, PEER_AUDIT_DEADLINE_MS);
    timer.unref?.();
    run.auditDeadlineTimer = timer;
  }

  private clearAuditDeadline(run: ActiveTaskRunState): void {
    if (run.auditDeadlineTimer) clearTimeout(run.auditDeadlineTimer);
    run.auditDeadlineTimer = undefined;
  }

  private emitOrchestratedAuditResult(
    run: ActiveTaskRunState,
    outcome: PeerAuditTerminalOutcome,
    reason?: string,
    findings?: string,
  ): void {
    if (!run.auditAttemptId) return;
    const targetName = run.snapshot.auditTargetSessionName ?? 'unavailable';
    const target = getSession(targetName);
    emitPeerAuditResult({
      auditedSessionName: run.sessionName,
      attemptId: run.auditAttemptId,
      trigger: 'automatic',
      outcome,
      auditorSessionName: targetName,
      auditorLabel: target?.label,
      elapsedMs: Math.max(0, Date.now() - (run.auditStartedAt ?? Date.now())),
      disposition: 'sent',
      ...(findings ? { findings } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  private handleOrchestratedAuditCompletion(
    current: ActiveTaskRunState,
    options: { settledWithoutIdle?: boolean } = {},
  ): void {
    if (current.phase !== 'auditing' || !current.auditReplyObserved || !current.lastAssistantText) return;
    const verdict = parsePeerAuditOrchestratedResult(current.lastAssistantText);
    if (!verdict) {
      this.emitWarning(current.sessionName, 'The delegated audit reply arrived, but the current session did not report exactly one PASS/REWORK audit marker. Waiting until the audit deadline.');
      return;
    }
    this.clearAuditDeadline(current);
    this.clearAuditTargetRecovery(current);
    this.clearStatus(current.sessionName);
    const findings = current.lastAssistantText;
    if (verdict === 'PASS') {
      this.emitOrchestratedAuditResult(current, 'pass', undefined, findings);
      current.auditAttemptId = undefined;
      if (current.deferredFinalization) {
        current.phase = 'finalizing';
        current.ignoreIdleUntilPostAuditTurnActivity = options.settledWithoutIdle === true;
        current.evaluating = false;
        current.terminalState = undefined;
        void this.dispatchContinue(current, current.deferredFinalization);
      } else {
        this.emitTerminalStatus(current.sessionName, 'supervision_audit_pass', SUPERVISION_AUDIT_PASS_LABEL);
        this.activeRuns.delete(current.sessionName);
      }
      return;
    }
    this.emitOrchestratedAuditResult(current, 'rework', undefined, findings);
    current.auditAttemptId = undefined;
    if (current.reworkDispatches >= current.snapshot.maxAuditLoops) {
      this.emitTerminalStatus(current.sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
      this.activeRuns.delete(current.sessionName);
      return;
    }
    current.reworkDispatches += 1;
    const transportRuntime = getTransportRuntime(current.sessionName);
    if (!transportRuntime) {
      this.emitTerminalStatus(current.sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
      this.activeRuns.delete(current.sessionName);
      return;
    }
    const reworkBrief = buildReworkBrief(current, findings);
    current.phase = 'execution';
    current.ignoreIdleUntilPostAuditTurnActivity = options.settledWithoutIdle === true;
    current.evaluating = false;
    current.sawAssistantOutput = false;
    current.auditReplyObserved = false;
    current.terminalState = undefined;
    current.lastAssistantText = undefined;
    timelineEmitter.emit(
      current.sessionName,
      'user.message',
      { text: reworkBrief, allowDuplicate: true, automation: true, automationKind: 'peer-audit-rework' },
      { source: 'daemon', confidence: 'high', eventId: `peer-audit-rework:${current.generation}:${current.reworkDispatches}:${randomUUID()}` },
    );
    try {
      transportRuntime.send(reworkBrief, `peer-audit-rework-${current.generation}-${current.reworkDispatches}`);
      this.emitTerminalStatus(current.sessionName, 'supervision_rework_sent', SUPERVISION_REWORK_LABEL);
    } catch (error) {
      logger.warn({ session: current.sessionName, err: error }, 'Peer audit rework dispatch failed');
      this.emitTerminalStatus(current.sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
      this.activeRuns.delete(current.sessionName);
    }
  }

  private async dispatchContinue(
    run: ActiveTaskRunState,
    /** Pass the full decision so the target agent receives a concrete
     *  imperative nextAction instead of just a vague reason string — this
     *  is what breaks the supervision loop. */
    decision: { reason: string; nextAction?: string; gap?: string },
  ): Promise<void> {
    const current = this.activeRuns.get(run.sessionName);
    if (!current || current.generation !== run.generation || (current.phase !== 'execution' && current.phase !== 'finalizing')) return;
    const postAuditFinalization = current.phase === 'finalizing';
    const transportRuntime = getTransportRuntime(run.sessionName);
    if (!transportRuntime) {
      this.finishRun(run.sessionName, 'blocked');
      return;
    }

    // Resolve the effective custom instructions (global + session + override)
    // at dispatch time. The session-scoped snapshot mirror can be stale when
    // the user updated defaults from a different session's dialog — the
    // daemon-side cache layer (`supervisor-defaults-cache.ts`) covers that gap.
    // Pass the classified detail (text + source tag) so the continue prompt's
    // heading reflects whether the instruction came from the user's global
    // defaults, a session-specific override, or a merge of both — previously
    // globals were mislabeled as "Session-specific".
    const continuePrompt = buildSupervisionContinuePrompt(
      current.userText,
      current.lastAssistantText,
      // Pass the full structured instructions; the builder leads with
      // nextAction so the agent has something concrete to execute.
      { reason: decision.reason, nextAction: decision.nextAction, gap: decision.gap },
      resolveSupervisionCustomInstructionsDetail(enrichSnapshotWithGlobalDefaults(current.snapshot)),
    );
    current.continueLoops += 1;
    current.sawAssistantOutput = false;
    current.lastAssistantText = undefined;
    current.terminalState = undefined;

    timelineEmitter.emit(
      run.sessionName,
      'user.message',
      {
        text: continuePrompt,
        allowDuplicate: true,
        automation: true,
        automationKind: postAuditFinalization ? 'supervision-post-audit-finalization' : 'supervision-continue',
      },
      { source: 'daemon', confidence: 'high', eventId: `supervision-continue:${run.generation}:${current.continueLoops}:${randomUUID()}` },
    );

    try {
      transportRuntime.send(continuePrompt, `supervision-continue-${run.generation}-${current.continueLoops}`);
      if (postAuditFinalization) {
        this.emitAutomationNote(run.sessionName, '✅ Peer audit passed. Auto is now running the deferred commit/push finalization.', 'supervision-post-audit-finalization-status');
        this.emitTerminalStatus(run.sessionName, 'supervision_post_audit_finalizing', SUPERVISION_FINALIZING_LABEL);
      } else {
        this.emitAutomationNote(run.sessionName, 'Auto: sent a continue prompt to keep the task moving.', 'supervision-continue-status');
        this.emitTerminalStatus(run.sessionName, 'supervision_continue_sent', SUPERVISION_CONTINUE_LABEL);
      }
    } catch (error) {
      logger.warn({ session: run.sessionName, err: error }, 'Supervision continue dispatch failed');
      this.emitWarning(run.sessionName, 'Automation could not continue the task. Manual continuation is required.');
      this.finishRun(run.sessionName, 'blocked');
    }
  }
}

export const supervisionAutomation = new SupervisionAutomation();
