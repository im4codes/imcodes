import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SupervisionAutomationPoolGateReason } from '../../shared/supervision-execution-pool.js';
import { IMCODES_DELEGATION_UNAVAILABLE_MESSAGE } from '../../shared/delegation-availability.js';
import { getSession, listSessions, upsertSession, type SessionRecord } from '../store/session-store.js';
import { resolveAuthoritativeBrainIdentity } from './supervision-brain-authority.js';
import {
  IMPLEMENTATION_HEARTBEAT_RUNTIME_RETRY_LIMIT,
  parkTransientRuntimeExhaustedOnce,
  resolveImplementationHeartbeatDelivery,
} from './supervision-participant-delivery.js';
import { inspectSupervisionAssignmentWorktree } from './supervision-worktree-inspector.js';
import { validateBrainAuditRoute } from './peer-audit-candidates.js';
import {
  getTransportRuntime,
  ensureTransportRuntimeAvailable,
  MAX_RESTARTS,
  RESTART_WINDOW_MS,
} from '../agent/session-manager.js';
import { PROVIDER_ERROR_CODES } from '../agent/transport-provider.js';
import type { ServerLink } from './server-link.js';
import { timelineEmitter } from './timeline-emitter.js';
import { readTailLines, timelineStore } from './timeline-store.js';
import type { TimelineEvent } from './timeline-event.js';
import {
  supervisionBroker,
  type SupervisionDecision,
  type SupervisionProviderFailure,
  type SupervisionRecentEvidence,
} from './supervision-broker.js';
import {
  getCachedSupervisorDefaults,
} from './supervisor-defaults-cache.js';
import logger from '../util/logger.js';
import {
  SUPERVISION_AUDIT_ENABLED_STATUS,
  SUPERVISION_CONTRACT_IDS,
  SUPERVISION_AUDIT_MARKER_CORRECTION_AUTOMATION_KIND,
  SUPERVISION_AUDIT_TARGET_RECOVERY_AUTOMATION_KIND,
  SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND,
  SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_STREAK,
  SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_TOTAL,
  SUPERVISION_MODE,
  SUPERVISION_UNAVAILABLE_REASONS,
  canSessionRoleOwnAutomaticSupervision,
  extractSessionSupervisionSnapshot,
  isAutomaticSupervisionEnabled,
  normalizeSessionSupervisionSnapshot,
  parseSupervisionExecutionStateDetailsFromText,
  resolveSupervisionCustomInstructionsDetail,
  normalizeSupervisionUiLocale,
  type SessionSupervisionSnapshot,
  type SupervisionExecutionState,
  type SupervisionUnavailableReason,
  type TaskRunTerminalState,
  classifySupervisionInterruption,
  SUPERVISION_SUPERVISOR_RETRY_AUTOMATION_KIND,
} from '../../shared/supervision-config.js';
import {
  buildSupervisionContinuePrompt,
  buildReworkBriefPrompt,
  buildAutomaticAuditTaskPrompt,
  buildAuditMarkerCorrectionPrompt,
  buildAuditTargetRecoveryPrompt,
  buildSupervisionWaitingHeartbeatPrompt,
} from './supervision-prompts.js';

import {
  getSupervisionStateStore,
  getSupervisionTaskRegistry,
  SUPERVISION_STATE_VERSION,
  type PersistedSupervisionSessionIdentity,
  type PersistedSupervisionWaitState,
} from './supervision-state-store.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../shared/memory-mcp-contracts.js';
import {
  AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER,
  AGENT_DELEGATION_PURPOSES,
  AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER,
  AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
  buildAgentDelegationReplyInstruction,
  buildAgentDelegationOrchestrationPrompt,
  extractAgentDelegationReplyAuthorityFromInstruction,
} from '../../shared/agent-delegation.js';
import {
  PEER_AUDIT_DEADLINE_MS,
  parsePeerAuditOrchestratedResult,
  sanitizePeerAuditUntrustedText,
  type PeerAuditTerminalOutcome,
} from '../../shared/peer-audit.js';
import { TIMELINE_EVENT_FILE_CHANGE, type FileChangePatch } from '../../shared/file-change.js';
import { peerAuditService } from './peer-audit-service.js';
import type { SupervisionAuditDepth } from './supervision-broker.js';
import { emitPeerAuditResult } from './peer-audit-result.js';
import { isWorkingSessionState } from '../../shared/session-activity-types.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import {
  getDelegationReplyStore,
  type DelegationReplyBoundIdentity,
  type DelegationReplyRecord,
} from './delegation-reply-store.js';
import { onDelegationReplyDelivered } from './delegation-reply-events.js';
import { getSessionRuntimeType } from '../../shared/agent-types.js';
import {
  localizeSupervisionAutomationNote,
  localizeSupervisionStatusLabel,
} from './supervision-i18n.js';

function isBrainOwnedAutomaticSupervision(
  sessionName: string,
  snapshot: SessionSupervisionSnapshot | null | undefined,
): snapshot is SessionSupervisionSnapshot {
  return canSessionRoleOwnAutomaticSupervision(getSession(sessionName)?.role)
    && isAutomaticSupervisionEnabled(snapshot);
}

/**
 * Apply the daemon-cached global supervisor runtime to every session. Session
 * snapshots retain legacy runtime fields as a cold-start fallback, but once
 * user defaults have been fetched they are authoritative for backend/model,
 * optional backup, timeout and global custom instructions.
 */
export function enrichSnapshotWithGlobalDefaults(
  snapshot: SessionSupervisionSnapshot,
): SessionSupervisionSnapshot {
  const cached = getCachedSupervisorDefaults();
  if (!cached) return snapshot;
  return {
    ...snapshot,
    backend: cached.backend,
    model: cached.model,
    timeoutMs: cached.timeoutMs,
    promptVersion: cached.promptVersion,
    ...(cached.preset ? { preset: cached.preset } : { preset: undefined }),
    ...(cached.backupBackend && cached.backupModel ? {
      backupBackend: cached.backupBackend,
      backupModel: cached.backupModel,
      ...(cached.backupPreset ? { backupPreset: cached.backupPreset } : { backupPreset: undefined }),
    } : {
      backupBackend: undefined,
      backupModel: undefined,
      backupPreset: undefined,
    }),
    ...(cached.customInstructions
      ? { globalCustomInstructions: cached.customInstructions }
      : { globalCustomInstructions: undefined }),
  };
}

type TaskRunPhase = 'execution' | 'auditing' | 'finalizing';

const SUPERVISION_WAITING_LABEL = 'Supervised: analyzing completion...';
const SUPERVISION_AUDIT_WAITING_LABEL = 'Supervised: peer audit running; commit/push paused until the result.';
const SUPERVISION_COMPLETE_LABEL = 'Supervised: task looks complete.';
const SUPERVISION_CONTINUE_LABEL = 'Supervised: sent a continue prompt.';
const SUPERVISION_FINALIZING_LABEL = 'Supervised: audit passed; running post-audit finalization.';
const SUPERVISION_NEEDS_INPUT_LABEL = 'Supervised: returned control to you.';

/** Trimmed blocker text, or undefined when the assignment has no live blocker. */
function normalizeBlockerText(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : undefined;
}
const SUPERVISION_AUDIT_PASS_LABEL = 'Supervised: audit passed.';
const SUPERVISION_REWORK_LABEL = 'Supervised: audit requested rework; brief sent.';
const SUPERVISION_BLOCKED_LABEL = 'Supervised: stopped because the session is blocked.';
const AUDIT_TARGET_RECOVERY_DELAY_MS = 1_500;
const SUPERVISION_PARKED_LABEL = 'Supervised: parked until the pending reply arrives.';
const SUPERVISION_AUDIT_ENABLED_LABEL = 'Supervised + audit is enabled.';
/**
 * How long a parked run may sit before automation hands control back.
 *
 * A parked run is woken by the session's NEXT turn (the reply lands, the agent
 * responds, evaluation runs again), so no polling is needed. This bound exists
 * only for the case where that reply never comes — without it, a lost audit
 * would strand the run silently instead of surfacing to the human.
 */
const SUPERVISION_WAITING_HEARTBEAT_MS = 10 * 60_000;
const IMPLEMENTATION_IDLE_REMINDER_MS = 10 * 60_000;
const IMPLEMENTATION_REMINDER_MAX_BACKOFF_MS = 60 * 60_000;
const IMPLEMENTATION_WATCHDOG_TICK_MS = 60_000;
const AUDIT_TARGET_MAX_RECOVERY_CONTINUES = 2;
/**
 * Provider/runtime projections are not guaranteed to publish the final
 * assistant row before the adjacent `idle` edge. Give that row a short,
 * bounded window to arrive instead of permanently discarding the run at the
 * first out-of-order idle event.
 */
const SUPERVISION_CONSUMED_AUDIT_ATTEMPTS_MAX = 10_000;
const SUPERVISION_COMPLETION_GRACE_MS = 2_000;
/** Max time spent waiting while provider activity is UNKNOWN before failing closed. */
const SUPERVISION_COMPLETION_WAIT_MAX_MS = 60_000;
const SUPERVISION_RECENT_EVIDENCE_EVENT_COUNT = 80;
const SUPERVISION_RECENT_EVIDENCE_COUNT = 12;
const SUPERVISION_RECENT_EVIDENCE_TEXT_LENGTH = 4_096;
const SUPERVISION_RECOVERY_RELEVANT_EVENT_LIMIT = 1_000;
const SUPERVISION_RECOVERY_RAW_EVENT_SCAN_LIMIT = 20_000;
const SUPERVISION_RECOVERED_COMPLETION_KEYS_MAX = 256;
const SUPERVISION_EMITTED_AUDIT_RESULTS_MAX = 512;

interface ActiveTaskRunState {
  generation: number;
  sessionName: string;
  commandId: string;
  /** The exact outage signature already recovered on this run, if any. */
  recoveredAuthorityOutage?: string;
  /** Pending daemon-owned retry for a recovery that could not deliver. */
  authorityRecoveryTimer?: ReturnType<typeof setTimeout>;
  snapshot: SessionSupervisionSnapshot;
  hasLiveSnapshotUpdate: boolean;
  userText: string;
  phase: TaskRunPhase;
  // Whether this run still needs a NEW peer-audit dispatch. It becomes false
  // as soon as either automation or the current session delegates the audit,
  // and stays false while waiting for the reply.
  requiresAudit: boolean;
  // Sticky safety gate set by REWORK. A broker decision cannot clear it; only
  // a later matching peer-audit PASS may authorize repository finalization.
  freshAuditRequiredAfterRework: boolean;
  continueLoops: number;
  continueStreakCount: number;
  lastContinueBucket?: string;
  evaluating: boolean;
  sawAssistantOutput: boolean;
  lastAssistantText?: string;
  lastAssistantCompletionKey?: string;
  terminalState?: TaskRunTerminalState;
  auditAttemptId?: string;
  auditDelegationId?: string;
  auditStartedAt?: number;
  auditDeadlineAt?: number;
  auditReplyObserved: boolean;
  /** One bounded self-heal turn when the orchestrator omits/duplicates the marker. */
  auditVerdictCorrectionAttempts: number;
  /** De-duplicates the terminal warning across repeated idle projections. */
  auditMarkerWarningEmitted: boolean;
  auditDeadlineTimer?: NodeJS.Timeout;
  auditTargetSessionInstanceId?: string;
  auditTargetDispatchObservedAt?: number;
  auditTargetObservedActive: boolean;
  auditTargetRecoveryAttempts: number;
  auditTargetRecoveryLimitNotified: boolean;
  auditTargetRecoveryTimer?: NodeJS.Timeout;
  /** Safety net for a parked run whose awaited reply never arrives. */
  waitingTimeoutTimer?: NodeJS.Timeout;
  /** Periodic status request while a reported external reply remains pending. */
  waitingHeartbeatTimer?: NodeJS.Timeout;
  /** Original wait boundary; repeated WAITING replies must not reset it. */
  waitingStartedAt?: number;
  waitingDeadlineAt?: number;
  waitingNextHeartbeatAt?: number;
  waitingEvaluationPending?: boolean;
  /** Bounded wait for a final assistant row that raced behind `idle`. */
  completionGraceTimer?: NodeJS.Timeout;
  /** Wall-clock start of the current no-activity-evidence wait. */
  completionWaitStartedAt?: number;
  /** How much audit this run's change is worth; scopes the delegated brief. */
  auditDepth?: SupervisionAuditDepth;
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
  uiLocale?: SessionSupervisionSnapshot['uiLocale'];
}

interface LatestAssistantText {
  text: string;
  sequence: number;
  completionKey?: string;
}

interface RecoveredImplicitCompletion {
  candidate: RecentTaskCandidate;
  latestAssistant: LatestAssistantText;
  completionKey: string;
}

function persistedSessionIdentity(record: SessionRecord): PersistedSupervisionSessionIdentity | undefined {
  if (!record.sessionInstanceId) return undefined;
  return {
    sessionName: record.name,
    sessionInstanceId: record.sessionInstanceId,
    agentType: record.agentType,
    runtimeType: record.runtimeType ?? getSessionRuntimeType(record.agentType),
    ...(record.runtimeEpoch ? { runtimeEpoch: record.runtimeEpoch } : {}),
    ...(record.providerId ? { providerId: record.providerId } : {}),
    ...(record.providerSessionId ? { providerSessionId: record.providerSessionId } : {}),
    ...(record.providerResumeId ? { providerResumeId: record.providerResumeId } : {}),
  };
}

function persistedIdentityMatches(
  persisted: PersistedSupervisionSessionIdentity,
  current: SessionRecord | undefined,
): boolean {
  if (!current?.sessionInstanceId) return false;
  if (persisted.sessionName !== current.name || persisted.sessionInstanceId !== current.sessionInstanceId) return false;
  if (persisted.agentType !== current.agentType) return false;
  if (persisted.runtimeType !== (current.runtimeType ?? getSessionRuntimeType(current.agentType))) return false;
  // runtimeEpoch is expected to rotate when the daemon/provider authority is
  // recreated. Stable logical/provider session identifiers must still match;
  // model selection is deliberately not identity because it may change within
  // the same conversation.
  if (persisted.providerId !== current.providerId) return false;
  if (persisted.providerSessionId !== current.providerSessionId) return false;
  if (persisted.providerResumeId !== current.providerResumeId) return false;
  return true;
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

function isDelegationCompletionNotificationText(text: string | undefined): boolean {
  return text?.trimStart().startsWith(AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER) === true;
}

function isBareSupervisionContinueText(text: string | undefined): boolean {
  return /^(?:continue|go on|继续|继续吧|继续处理|继续执行|继续做|继续推进)$/iu.test(text?.trim() ?? '');
}


type RecoveryBarrier = 'none' | 'handled' | 'stopped';

const SUPERVISION_RECOVERY_RELEVANT_EVENT_TYPES = new Set<TimelineEvent['type']>([
  'user.message',
  'assistant.text',
  'session.state',
  'peer_audit.result',
  AGENT_DELEGATION_REPLY_TIMELINE_EVENT,
]);

function isRecoveryRelevantTimelineEvent(event: TimelineEvent): boolean {
  if (!SUPERVISION_RECOVERY_RELEVANT_EVENT_TYPES.has(event.type)) return false;
  if (event.type !== 'assistant.text') return true;
  const payload = event.payload as Record<string, unknown>;
  return payload.streaming === false || payload.streaming === undefined;
}

/**
 * Models occasionally omit the hidden orchestration marker even though their
 * user-visible conclusion is explicit. This fallback is consulted only after
 * a correlated reply-enabled audit has actually been delivered, and accepts
 * only a single anchored verdict line — incidental PASS/REWORK words in the
 * findings cannot open the gate.
 */
function parseExplicitAuditVerdict(text: string): 'PASS' | 'REWORK' | null {
  const matches = [...text.matchAll(
    /^\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*{1,2}\s*)?(?:final\s+(?:independent\s+)?(?:audit|review)\s+(?:verdict|recommendation)|(?:independent\s+)?(?:audit|review)(?:\s+(?:verdict|recommendation))?|verdict|recommendation|最终独立复审|最终审计结论|独立审计|审计结论|复审结论|审计|审核|复审|终审|结论)\s*\**\s*[:：-]?\s*\**(PASS|REWORK)\b/gimu,
  )].map((match) => match[1]!.toUpperCase() as 'PASS' | 'REWORK');
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0]! : null;
}

function parseDeliveredAuditVerdict(text: string): 'PASS' | 'REWORK' | null {
  return parsePeerAuditOrchestratedResult(text) ?? parseExplicitAuditVerdict(text);
}

function sanitizeRecentEvidenceText(value: string): string {
  const sanitized = sanitizePeerAuditUntrustedText(value)
    .replace(/<!--\s*IMCODES_AUTOMATIC_AUDIT:[\s\S]*?-->/giu, '[removed audit control marker]')
    .replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (sanitized.length <= SUPERVISION_RECENT_EVIDENCE_TEXT_LENGTH) return sanitized;
  return `${sanitized.slice(0, SUPERVISION_RECENT_EVIDENCE_TEXT_LENGTH - 1)}…`;
}

function isReplyEnabledPeerAuditDelegationText(text: string | undefined, replyToSession: string): boolean {
  if (!text) return false;
  const hasStructuredReplyAuthority = !!extractAgentDelegationReplyAuthorityFromInstruction(text);
  const hasExactReplyRoute = hasStructuredReplyAuthority
    || (text.includes(AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER)
      && text.includes(buildAgentDelegationReplyInstruction(replyToSession)));
  const asksForAudit = /(?:\b(?:independent(?:ly)?\s+)?(?:peer\s+)?audit\b|独立(?:只读)?(?:审计|审核|复审|终审)|(?:审计|审核|复审|终审)(?:当前|本次|这次|最近))/iu.test(text);
  return hasExactReplyRoute && asksForAudit;
}

const POST_AUDIT_DEFERRED_WORK_RE = /(?:\b(?:after|once|when)\b[\s\S]{0,40}\b(?:audit|review)\b[\s\S]{0,120}\b(?:test|verify|validate|commit|push|merge|release|deploy)\b|(?:审计|审核|复审|终审)(?:[\s\S]{0,20}PASS)?\s*(?:通过)?\s*后[\s\S]{0,120}(?:测试|验证|检查|提交|推送|合并|发布|部署)|PASS\s*(?:通过)?\s*后[\s\S]{0,120}(?:测试|验证|检查|提交|推送|合并|发布|部署))/iu;
const POST_AUDIT_DEFERRED_NEXT_ACTION = 'Peer audit passed. Resume only the validation and repository or delivery finalization explicitly deferred until PASS in the original task. Run the requested post-audit tests before any commit or push. Do not repeat implementation and do not request or start another audit.';
const FINALIZATION_PROHIBITION_RE = /(?:\b(?:do\s+not|don't|never|must\s+not)\b[\s\S]{0,50}\b(?:git\s+(?:add|commit|push|merge)|commit|push|stage|merge|release|deploy|publish)\b|(?:不要|不得|禁止)[\s\S]{0,40}(?:提交|推送|暂存|合并|发布|部署|上线))/iu;
const FINALIZATION_UNTIL_AUDIT_PASS_RE = /(?:\b(?:do\s+not|don't|must\s+not)\b[\s\S]{0,60}\b(?:git\s+(?:add|commit|push|merge)|commit|push|stage|merge|release|deploy|publish)\b[\s\S]{0,80}\buntil\b[\s\S]{0,30}\b(?:audit|review)\b[\s\S]{0,20}\bpass|(?:审计|审核|复审|终审)[\s\S]{0,20}(?:PASS|通过)[\s\S]{0,50}(?:之前|前)[\s\S]{0,30}(?:不要|不得|禁止)[\s\S]{0,30}(?:提交|推送|暂存|合并|发布|部署|上线)|(?:不要|不得|禁止)[\s\S]{0,40}(?:提交|推送|暂存|合并|发布|部署|上线)[\s\S]{0,60}(?:直到|除非)[\s\S]{0,30}(?:审计|审核|复审|终审)[\s\S]{0,20}(?:PASS|通过))/iu;
const POSITIVE_FINALIZATION_REQUIREMENT_RE = /(?:\b(?:always|must|should|need(?:s)?\s+to|required\s+to|please|then|finally)\b[\s\S]{0,50}\b(?:git\s+(?:add|commit|push|merge)|commit|push|stage|merge|release|deploy|publish)\b|\bcommit\s*(?:and|&)\s*push\b|(?:始终|总是|必须|需要|务必|请|完成后|测试后)[\s\S]{0,40}(?:提交|推送|暂存|合并|发布|部署|上线)|(?:提交并推送|提交且推送))/iu;

function hasExplicitRepositoryFinalizationRequirement(text: string | undefined): boolean {
  if (!text?.trim()) return false;
  if (POST_AUDIT_DEFERRED_WORK_RE.test(text) || FINALIZATION_UNTIL_AUDIT_PASS_RE.test(text)) return true;
  return text
    .split(/[\n。；;]+/u)
    .some((clause) => POSITIVE_FINALIZATION_REQUIREMENT_RE.test(clause)
      && !FINALIZATION_PROHIBITION_RE.test(clause));
}

function boundDelegationIdentity(record: ReturnType<typeof getSession>): DelegationReplyBoundIdentity | null {
  const sessionInstanceId = record?.sessionInstanceId?.trim();
  const runtimeEpoch = record?.runtimeEpoch?.trim();
  if (!record || !sessionInstanceId || !runtimeEpoch) return null;
  return {
    sessionName: record.name,
    sessionInstanceId,
    runtimeEpoch,
  };
}

function delegationIdentityMatches(
  expected: DelegationReplyBoundIdentity,
  actual: DelegationReplyBoundIdentity | null,
): boolean {
  return actual?.sessionName === expected.sessionName
    && actual.sessionInstanceId === expected.sessionInstanceId
    && actual.runtimeEpoch === expected.runtimeEpoch;
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

const REPOSITORY_FINALIZATION_ACTION_RE = /(?:\b(?:git\s+(?:add|commit|push|merge)|commit|push|stage|staging|merge|release|deploy|publish)\b|提交|推送|暂存|合并|发布|部署|上线)/iu;
const SUBSTANTIVE_PRE_AUDIT_ACTION_RE = /(?:\b(?:test|tests|testing|typecheck|lint|build|verify|verification|validate|validation|fix|repair|implement|edit|modify|update|write|refactor|restart)\b|测试|类型检查|构建|验证|修复|实现|修改|更新|编写|重构|重启)/iu;
const COMPLETED_PRE_AUDIT_WORK_RE = /(?:\b(?:implementation|fix(?:es)?|coding|changes?|tests?|testing|typecheck|lint|build|verification|validation)\b[\s\S]{0,80}\b(?:complete|completed|done|finished|pass(?:ed)?)\b|(?:修复|实现|代码|改动|测试|验证|检查|类型检查|构建)[\s\S]{0,60}(?:已完成|已经完成|均已完成|全部完成|完成并通过|已通过|验证通过|测试通过))/iu;
const PENDING_PRE_AUDIT_WORK_RE = /(?:\b(?:still|yet|remaining|pending|missing|failed?|incomplete|need(?:s)?\s+to|must)\b[^\n.;]{0,50}\b(?:implementation|fix(?:es)?|tests?|testing|typecheck|lint|build|verification|validation)\b|\b(?:implementation|fix(?:es)?|tests?|testing|typecheck|lint|build|verification|validation)\b[^\n.;]{0,50}\b(?:remain(?:s|ing)?|pending|missing|fail(?:ed|ing)?|incomplete|not\s+(?:done|complete)|need(?:s)?|required)\b|\b(?:current|remaining|open|unresolved|major)\b[^\n.;]{0,30}\b(?:code\s+)?blocker(?:s)?\b|\bnot\s+(?:yet\s+)?(?:actually\s+)?(?:implemented|wired|connected|driven|complete)\b|\bcannot\s+(?:mark|check)[^\n.;]{0,30}\bcomplete\b|(?:仍|还|尚|待|未|缺少|失败)[^\n。；;]{0,30}(?:测试|验证|修复|实现|构建|类型检查)|(?:测试|验证|修复|实现|构建|类型检查)[^\n。；;]{0,30}(?:未完成|仍需|还需|待处理|失败|缺失|未通过)|(?:当前|主要|未解决)[^\n。；;]{0,20}(?:代码|实现|功能)?阻断|(?:尚未|仍未|还未)(?:真正|实际)?(?:驱动|接入|实现|完成|连通|验证)|完成前不能(?:勾选|标记|视为))/iu;
const NEW_AUDIT_DELEGATION_RE = /(?:\b(?:send|dispatch|delegate|construct|prepare)\b[\s\S]{0,100}\b(?:reply[- ]enabled|peer\s+audit|independent\s+(?:audit|review)|audit\s+brief)\b|\b(?:reply[- ]enabled|peer\s+audit|audit\s+brief)\b[\s\S]{0,100}\b(?:send|dispatch|delegate|construct|prepare)\b|(?:发送|补发|构造|准备|委派|发起)[\s\S]{0,80}(?:带回复|可回复|独立)?(?:审计|审核|复审)(?:简报|任务|请求)?)/iu;
const FORBIDS_NEW_AUDIT_RE = /(?:\b(?:do\s+not|don't|never)\b[\s\S]{0,50}\b(?:send|dispatch|delegate|request|start)\b[\s\S]{0,30}\b(?:audit|review)\b|(?:不要|不得|禁止)[\s\S]{0,50}(?:发送|发起|委派|请求|开始)[\s\S]{0,30}(?:审计|审核|复审))/iu;
const WAITING_FOR_PEER_AUDIT_RE = /(?:\b(?:peer[- ]audit|independent\s+(?:audit|review)|audit)\b[\s\S]{0,80}\b(?:pass|verdict|reply|result|receipt)\b|\b(?:pass|verdict|reply|result|receipt)\b[\s\S]{0,80}\b(?:peer[- ]audit|independent\s+(?:audit|review))\b|(?:等待|等候|尚未收到|未收到|阻塞)[\s\S]{0,60}(?:独立)?(?:审计|审核|复审)[\s\S]{0,30}(?:通过|结论|裁决|回复|回执|结果)?)/iu;
const POST_AUDIT_REPOSITORY_FINALIZATION_ACTION = 'Peer-audit has passed. Perform only the already-audited repository or delivery finalization requested for this task (stage/commit/push, merge, release, publish, or deploy as applicable). Do not perform additional implementation work. Do not request or start another audit.';
const SUPERVISED_REPOSITORY_FINALIZATION_ACTION = 'Implementation and validation are complete. Perform only the repository or delivery finalization explicitly requested by the task or user supervision rules; do not invent delivery work.';
const PRE_AUDIT_SELF_RECONCILIATION_ACTION = 'Advance safe unfinished task-owned work from your own context in this same turn; do not stop at a status summary. An integration_slice must finish validation and hand its frozen manifest to the integration owner without starting an audit. Only the complete integration_task or a genuine independent_top_level revision may enter peer audit. If none can be safely advanced, report the exact human blocker. Do not stage, commit, push, merge, release, publish, or deploy before the one overall peer-audit PASS.';
const COMPLETED_REPOSITORY_FINALIZATION_RE = /(?:\bcommit\s*:\s*[0-9a-f]{7,40}\b|\bpush\s*:\s*(?:origin\/)?[^\s]+\s+(?:succeeded|successful|done|complete)|\b(?:committed|pushed|merged|released|published|deployed)\b|(?:已完成并)?(?:提交并推送|提交且推送)|(?:已|成功)(?:提交|推送|合并|发布|部署)|推送成功)/iu;
const AUDIT_WORTHY_TASK_RE = /(?:\b(?:implement|fix|add|remove|delete|change|modify|update|refactor|optimi[sz]e|build|configure|migrate|install|uninstall)\b|(?:修复|实现|新增|添加|删除|修改|改成|调整|重构|优化|美化|配置|迁移|安装|卸载))/iu;
const COMPLETED_ENGINEERING_WORK_RE = /(?:\b(?:implemented|fixed|added|removed|deleted|changed|modified|updated|refactored|optimized|built|configured|migrated|installed|uninstalled)\b|\b(?:implementation|fix(?:es)?|changes?|tests?|typecheck|lint|build|validation|verification)\b[\s\S]{0,60}\b(?:complete|completed|done|passed)\b|(?:已|已经)(?:完成|实现|修复|新增|添加|删除|修改|调整|重构|优化|美化|配置|迁移|安装|卸载)|(?:实现|修复|改动|测试|验证|类型检查|构建)[\s\S]{0,30}(?:完成|通过))/iu;

/**
 * Fail-safe for an arbiter that incorrectly labels a completion report as
 * read-only. The model still decides proportional audit depth, but it cannot
 * waive audit after observable engineering work or repository finalization.
 */
function turnHasDeterministicAuditEvidence(
  taskRequest: string,
  assistantResponse: string | undefined,
): boolean {
  const response = assistantResponse?.trim() ?? '';
  if (!response) return false;
  if (COMPLETED_REPOSITORY_FINALIZATION_RE.test(response)) return true;
  return AUDIT_WORTHY_TASK_RE.test(taskRequest)
    && COMPLETED_ENGINEERING_WORK_RE.test(response);
}

type RepositoryFinalizationClassification = 'none' | 'finalization_only' | 'completion_evidenced_mixed';

/**
 * `supervised_audit` must review the implementation before repository
 * finalization. Only hold an action whose imperative next step is purely
 * stage/commit/push/merge/release/deploy work. Any instruction that also asks
 * for tests, fixes, implementation, build, or another substantive mutation stays
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

function requestsOnlyRedundantAudit(decision: { reason: string; nextAction?: string; gap?: string }): boolean {
  const text = [decision.nextAction, decision.gap, decision.reason]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .join(' ');
  return NEW_AUDIT_DELEGATION_RE.test(text) && !PENDING_PRE_AUDIT_WORK_RE.test(text);
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
  const assistantEvidence = assistantResponse?.trim() ?? '';
  // A finalization-only broker decision is not progress authority. If the
  // executing session explicitly reports unfinished implementation or a real
  // blocker, keep working (or ask for the needed human input) instead of
  // auditing/finalizing a partial revision.
  if (PENDING_PRE_AUDIT_WORK_RE.test(assistantEvidence)) return 'none';
  if (isRepositoryFinalizationOnly(decision)) return 'finalization_only';

  const decisionEvidence = [decision.reason, decision.gap]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .join(' ');
  if (!COMPLETED_PRE_AUDIT_WORK_RE.test(decisionEvidence)
    || !COMPLETED_PRE_AUDIT_WORK_RE.test(assistantEvidence)
    || PENDING_PRE_AUDIT_WORK_RE.test(decisionEvidence)
    || PENDING_PRE_AUDIT_WORK_RE.test(assistantEvidence)) {
    return 'none';
  }
  return 'completion_evidenced_mixed';
}

/** Told to the operator when the durable heartbeat, not the human, will retry. */
const SUPERVISION_RETRY_CONTINUATION_SENTENCE =
  'Supervision stays active and will retry on the next scheduled heartbeat.';

function formatUnavailableReason(
  reason: SupervisionUnavailableReason | undefined,
  providerFailure?: SupervisionProviderFailure,
  providerMessage?: string,
  providerSelection?: { backend?: string; model?: string },
  // What the operator should expect next. Transient failures are retried by the
  // durable heartbeat, so telling the human to continue manually would be a lie.
  continuation: string = 'Manual continuation is required.',
): string | null {
  switch (reason) {
    case SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_NOT_CONNECTED:
      return 'Automation could not reach the configured supervisor provider. ' + continuation;
    case SUPERVISION_UNAVAILABLE_REASONS.INVALID_SNAPSHOT:
      return 'Automation configuration is invalid. Repair the Auto settings before continuing.';
    case SUPERVISION_UNAVAILABLE_REASONS.QUEUE_TIMEOUT:
      return 'Automation timed out waiting for supervisor capacity. ' + continuation;
    case SUPERVISION_UNAVAILABLE_REASONS.DECISION_TIMEOUT:
      return 'Automation timed out waiting for a supervisor decision. ' + continuation;
    case SUPERVISION_UNAVAILABLE_REASONS.INVALID_OUTPUT:
      return 'Automation could not parse a valid supervisor decision. ' + continuation;
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
          return `Automation could not obtain a decision from supervisor model${selectionText}${attemptText} because the provider is rate-limited. ${continuation}`;
        default: {
          const safeDetail = sanitizeMcpErrorMessage(providerMessage, 'provider error');
          return `Automation could not obtain a decision from supervisor model${selectionText}${attemptText}: ${safeDetail}. ${continuation}`;
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

function collectRecentSupervisionEvidence(sessionName: string): SupervisionRecentEvidence[] {
  const events = timelineEmitter
    .replay(sessionName, 0)
    .events
    .slice(-SUPERVISION_RECENT_EVIDENCE_EVENT_COUNT);
  const evidence: SupervisionRecentEvidence[] = [];

  for (const event of events) {
    if (event.type === 'peer_audit.result') {
      const outcome = typeof event.payload.outcome === 'string'
        ? sanitizeRecentEvidenceText(event.payload.outcome)
        : '';
      if (!outcome) continue;
      const auditorSessionName = typeof event.payload.auditorSessionName === 'string'
        ? sanitizeRecentEvidenceText(event.payload.auditorSessionName)
        : undefined;
      const findings = typeof event.payload.findingsPreview === 'string'
        ? sanitizeRecentEvidenceText(event.payload.findingsPreview)
        : undefined;
      const reason = typeof event.payload.reason === 'string'
        ? sanitizeRecentEvidenceText(event.payload.reason)
        : undefined;
      evidence.push({
        kind: 'peer_audit_result',
        outcome,
        ...(auditorSessionName ? { auditorSessionName } : {}),
        ...(findings ? { findings } : {}),
        ...(reason ? { reason } : {}),
      });
      continue;
    }
    if (event.type !== 'user.message' && event.type !== 'assistant.text') continue;
    if (event.payload.streaming === true
      || event.payload.automation === true
      || event.payload.memoryExcluded === true) continue;
    const text = typeof event.payload.text === 'string'
      ? sanitizeRecentEvidenceText(event.payload.text)
      : '';
    if (!text || (event.type === 'user.message' && isDelegationCompletionNotificationText(text))) continue;
    evidence.push({ kind: event.type === 'user.message' ? 'user' : 'assistant', text });
  }

  return evidence.slice(-SUPERVISION_RECENT_EVIDENCE_COUNT);
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
  return buildReworkBriefPrompt(run.sessionName, run.userText, run.lastAssistantText, verdictText, {
    attempt: run.reworkDispatches,
    limit: run.snapshot.maxAuditLoops,
  }, run.snapshot.auditTargetSessionName, run.snapshot.uiLocale);
}

function isFinalAssistantPayload(payload: Record<string, unknown>): boolean {
  return payload.streaming === false || payload.streaming === undefined;
}

/**
 * Exactly one recoverable failure signature. Anything else -- an unknown crash,
 * an identity conflict, an empty reason -- is NOT recoverable here and keeps the
 * existing terminal behaviour.
 */
/**
 * How long to wait before re-attempting a recovery that could not deliver.
 * Short enough that a transient catalog outage clears quickly, long enough
 * that the bounded budget is not burned in a single burst.
 */
const AUTHORITY_RECOVERY_RETRY_MS = 15_000;

function isRecoverableAuthorityOutage(reason: string | undefined): reason is string {
  return reason?.trim() === IMCODES_DELEGATION_UNAVAILABLE_MESSAGE;
}

class SupervisionAutomation {
  private readonly stateStore = getSupervisionStateStore();
  private activeRuns = new Map<string, ActiveTaskRunState>();
  private pendingTaskIntents = new Map<string, PendingTaskIntent>();
  private recentTaskCandidates = new Map<string, RecentTaskCandidate>();
  private latestAssistantTexts = new Map<string, LatestAssistantText>();
  /** Settled audit attempts, kept beyond the emission ring's eviction window. */
  private consumedAuditAttemptIds = new Set<string>();
  private lastObservedSessionStates = new Map<string, string>();
  private implicitCompletionGraceTimers = new Map<string, NodeJS.Timeout>();
  private recoveredImplicitCompletionKeys: string[] = [];
  private recoveredImplicitCompletionKeySet = new Set<string>();
  private recoverySuppressedUntilNextUser = new Set<string>();
  private heartbeatPausedForNeedsInput = new Set<string>();
  private emittedAuditResultAttemptIds: string[] = [];
  private emittedAuditResultAttemptIdSet = new Set<string>();
  private implementationBlockerEscalationsInFlight = new Set<string>();
  private implementationWatchdogTimer?: NodeJS.Timeout;
  /** Monotonic even across cancellation, so an old async verdict cannot match a replacement run. */
  private nextRunGeneration = 0;
  private initialized = false;
  private eventSequence = 0;
  /** Test-only compatibility seam for the retired daemon-owned audit driver. */
  private automaticPeerAuditCompatibilityForTests = false;

  __setAutomaticPeerAuditCompatibilityForTests(enabled: boolean): void {
    if (process.env.NODE_ENV !== 'test') return;
    this.automaticPeerAuditCompatibilityForTests = enabled;
  }

  /** Presentation seam for the console; this is authoritative run state. */
  isWaitingForUserInput(sessionName: string): boolean {
    return this.heartbeatPausedForNeedsInput.has(sessionName);
  }

  private readonly executionPoolWarned = new Set<string>();

  /**
   * Tell the operator, once per session, why an automatic run did not start.
   *
   * Reuses the existing supervision-warning channel and the shared seven-locale
   * guidance rather than inventing a parallel message or status, so the daemon
   * says exactly what the UI and the save entry say. The event id is stable per
   * session and reason, so a refusal does not spam the timeline on every turn.
   */
  warnExecutionPoolUnconfigured(
    sessionName: string,
    reason: SupervisionAutomationPoolGateReason,
    guidance: string,
  ): void {
    const key = `${sessionName}:${reason}`;
    if (this.executionPoolWarned.has(key)) return;
    this.executionPoolWarned.add(key);
    timelineEmitter.emit(
      sessionName,
      'assistant.text',
      {
        text: `⚠️ ${guidance}`,
        streaming: false,
        automation: true,
        automationKind: 'supervision-warning',
        memoryExcluded: true,
      },
      { source: 'daemon', confidence: 'high', eventId: `supervision-warning:execution-pool:${key}` },
    );
  }

  private emitWarning(sessionName: string, text: string): void {
    timelineEmitter.emit(
      sessionName,
      'assistant.text',
      { text: `⚠️ ${text}`, streaming: false, automation: true, automationKind: 'supervision-warning', memoryExcluded: true },
      { source: 'daemon', confidence: 'high', eventId: `supervision-warning:${randomUUID()}` },
    );
  }

  private uiLocaleForSession(sessionName: string): string | undefined {
    const activeLocale = this.activeRuns.get(sessionName)?.snapshot.uiLocale;
    if (activeLocale) return activeLocale;
    const record = getSession(sessionName);
    return record
      ? extractSessionSupervisionSnapshot(record.transportConfig ?? null)?.uiLocale
      : undefined;
  }

  private emitAutomationNote(sessionName: string, text: string, kind: string): void {
    const localizedText = localizeSupervisionAutomationNote(
      kind,
      text,
      this.uiLocaleForSession(sessionName),
    );
    timelineEmitter.emit(
      sessionName,
      'assistant.text',
      { text: localizedText, streaming: false, automation: true, automationKind: kind, memoryExcluded: true },
      { source: 'daemon', confidence: 'high', eventId: `supervision-note:${sessionName}` },
    );
  }

  private emitStatus(sessionName: string, status: string, label: string): void {
    const localizedLabel = localizeSupervisionStatusLabel(
      status,
      label,
      this.uiLocaleForSession(sessionName),
    );
    timelineEmitter.emit(
      sessionName,
      'agent.status',
      { status, label: localizedLabel },
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
    onDelegationReplyDelivered((record) => {
      if (this.automaticPeerAuditCompatibilityForTests) {
        this.handleStructuredDelegationReplyDelivered(record);
      }
    });
    this.restorePersistedWaitStates();
    this.implementationWatchdogTimer = setInterval(() => {
      this.checkImplementationAssignments(Date.now());
    }, IMPLEMENTATION_WATCHDOG_TICK_MS);
    this.implementationWatchdogTimer.unref?.();
  }

  /** Test seam for the durable single-implementer watchdog. */
  __checkImplementationAssignmentsForTests(now: number): void {
    if (process.env.NODE_ENV !== 'test') return;
    this.checkImplementationAssignments(now);
  }

  private checkImplementationAssignments(now: number): void {
    const registry = getSupervisionTaskRegistry();
    // Production housekeeping is inert until an administrator has reviewed a
    // dry-run and explicitly called apply. Once authorized, this advances one
    // bounded cursor page per cooldown tick and remains restart-idempotent.
    try {
      registry.runApprovedHousekeepingBatch(now);
    } catch (error) {
      logger.warn({ err: error }, 'Bounded supervision housekeeping tick failed');
    }
    // Forward convergence rides this same bounded tick. A boot-only sweep
    // cannot close a window that opens later: a task can reach ready_for_audit,
    // or a parent can consume a slice's delivery evidence, at any time.
    // Convergence is called directly (the registry is already in hand) so it
    // cannot be silently skipped if the send path fails to load.
    try {
      registry.convergeLifecycle(now, {
        // Production wiring: a stale coordinator epoch is repaired against the
        // daemon's own live session registry, with no model or heartbeat.
        resolveAuthoritativeBrain: (projectName, sessionName) => resolveAuthoritativeBrainIdentity(
          projectName, undefined, sessionName,
        ),
        inspectAssignmentWorktree: (assignment) => {
          const inspected = inspectSupervisionAssignmentWorktree({
            sessionName: assignment.identity.sessionName,
            assignmentId: assignment.assignmentId,
          });
          return inspected.ok ? inspected.snapshot : undefined;
        },
      });
    } catch (error) {
      logger.warn({ err: error }, 'Supervision lifecycle convergence failed');
    }
    // The audit re-dispatch needs the send path, which is loaded lazily to keep
    // this module free of a static send-tool dependency. It is itself
    // re-entrancy guarded, so a slow dispatch never overlaps the next tick.
    void import('./send-tool.js')
      .then(({ runSupervisionConvergenceTick }) => runSupervisionConvergenceTick())
      .catch((error) => {
        logger.warn({ err: error }, 'Supervision audit re-dispatch tick failed');
      });
    for (const task of registry.list()) {
      const events = registry.listEvents(task.taskId);
      for (const assignment of task.assignments) {
        if (assignment.role !== 'implementer'
          || (assignment.status !== 'delegated' && assignment.status !== 'implementing')) continue;
        // A durable blocker is already the visible, actionable state. The
        // worker has no authority to clear it, so another heartbeat cannot
        // produce progress -- it only burns quota and hides the blocker behind
        // reminder noise. Leave the single blocker standing instead.
        if (normalizeBlockerText(assignment.blocker)) continue;
        const assignmentEvents = events.filter((event) => event.assignmentId === assignment.assignmentId);
        const progressAt = Math.max(
          assignment.updatedAt,
          ...assignmentEvents
            .filter((event) => event.eventType !== 'implementation_heartbeat')
            .map((event) => event.createdAt),
        );
        const reminders = assignmentEvents.filter((event) => (
          event.eventType === 'implementation_heartbeat'
          && event.payload?.source === 'implementation_watchdog'
          && event.createdAt > progressAt
        ));
        const runtimeRetries = assignmentEvents.filter((event) => (
          event.eventType === 'implementation_heartbeat'
          && event.payload?.source === 'implementation_watchdog_runtime_unavailable'
          && event.createdAt > progressAt
        ));
        const attempts = [...reminders, ...runtimeRetries].sort((left, right) => left.createdAt - right.createdAt);
        const latestAttempt = attempts.at(-1);
        const cooldown = latestAttempt
          ? Math.min(
              IMPLEMENTATION_IDLE_REMINDER_MS * (2 ** Math.min(attempts.length - 1, 6)),
              IMPLEMENTATION_REMINDER_MAX_BACKOFF_MS,
            )
          : IMPLEMENTATION_IDLE_REMINDER_MS;
        const dueAt = latestAttempt
          ? latestAttempt.createdAt + cooldown
          : progressAt + IMPLEMENTATION_IDLE_REMINDER_MS;
        if (now < dueAt) continue;

        // A reusable session name is not delivery authority. Resolve the exact
        // live participant and atomically converge permitted epoch/legacy
        // metadata drift before looking up its runtime. Unresolved ownership is
        // parked durably by the shared gate, so later ticks cannot wake-loop.
        try {
          const authority = resolveImplementationHeartbeatDelivery({
            taskId: task.taskId,
            assignmentId: assignment.assignmentId,
            targetSessionName: assignment.identity.sessionName,
            now,
          });
          if (authority.status === 'transient_unavailable') {
            const retryNumber = runtimeRetries.length + 1;
            if (retryNumber >= IMPLEMENTATION_HEARTBEAT_RUNTIME_RETRY_LIMIT) {
              parkTransientRuntimeExhaustedOnce({
                taskId: task.taskId,
                assignmentId: assignment.assignmentId,
                retryCount: retryNumber,
                now,
              });
            } else {
              registry.recordImplementationHeartbeatUnavailable({
                assignmentId: assignment.assignmentId,
                retryNumber,
                now,
              });
            }
            continue;
          }
          if (authority.status !== 'authorized') continue;
        } catch (error) {
          logger.warn({ err: error, taskId: task.taskId, assignmentId: assignment.assignmentId },
            'Supervision implementation heartbeat authority resolution failed');
          continue;
        }
        const rebound = registry.getAssignment(assignment.assignmentId);
        if (!rebound) continue;
        const runtime = getTransportRuntime(rebound.identity.sessionName);
        if (!runtime) continue;
        // Durable FIFO can retain an append while the provider remains busy or
        // disconnected. Never enqueue a second watchdog reminder behind the
        // first one: cooldown controls cadence, this queue check provides the
        // independent hard bound of one pending reminder per assignment.
        const reminderIdPrefix = `supervision-implementation-heartbeat:${assignment.assignmentId}:`;
        if (runtime.pendingEntries.some((entry) => entry.clientMessageId.startsWith(reminderIdPrefix))) continue;
        // One unanswered heartbeat is the bounded liveness probe. A second
        // equivalent prompt would only solicit another refusal/no-op. Convert
        // that state into one durable structured escalation instead; the
        // persisted blocker above stops later ticks and process restarts.
        if (reminders.length > 0) {
          const escalationKey = `${task.taskId}\0${assignment.assignmentId}`;
          if (this.implementationBlockerEscalationsInFlight.has(escalationKey)) continue;
          this.implementationBlockerEscalationsInFlight.add(escalationKey);
          void import('./send-tool.js')
            .then(({ reportImplementationNoProgressBlocker }) => (
              reportImplementationNoProgressBlocker({
                taskId: task.taskId,
                assignmentId: assignment.assignmentId,
              })
            ))
            .then((result) => {
              if (result.status === 'ignored') return;
              const actor = `${result.report.reporter.label} (${result.report.reporter.sessionName})`;
              if (result.status === 'waiting') {
                this.emitStatus(rebound.identity.sessionName, 'supervision_waiting_for_brain',
                  `${actor}: waiting for authoritative Brain repair on the same object.`);
              } else {
                this.emitStatus(rebound.identity.sessionName, 'supervision_needs_input',
                  `${actor}: NEEDS_INPUT — ${result.report.missing ?? 'external information or authorization is missing'}.`);
              }
            })
            .catch((error) => {
              logger.warn({ err: error, taskId: task.taskId, assignmentId: assignment.assignmentId },
                'Supervision implementation blocker escalation failed');
            })
            .finally(() => this.implementationBlockerEscalationsInFlight.delete(escalationKey));
          continue;
        }
        const reminderNumber = reminders.length + 1;
        const clientMessageId = `${reminderIdPrefix}${reminderNumber}`;
        const recorded = registry.recordImplementationHeartbeat({
          assignmentId: assignment.assignmentId,
          reminderNumber,
          clientMessageId,
          now,
        });
        if (!recorded.ok) continue;
        const prompt = JSON.stringify({
          contractRefs: [
            SUPERVISION_CONTRACT_IDS.IMPLEMENTATION_HEARTBEAT,
            SUPERVISION_CONTRACT_IDS.MESSAGING,
            SUPERVISION_CONTRACT_IDS.TASK_FINALIZATION,
          ],
          binding: { mode: 'continue_existing', taskId: task.taskId, assignmentId: assignment.assignmentId },
          action: 'advance_safe_unfinished',
        });
        timelineEmitter.emit(
          rebound.identity.sessionName,
          'user.message',
          {
            text: prompt,
            clientMessageId,
            taskId: task.taskId,
            assignmentId: assignment.assignmentId,
            automation: true,
            automationKind: 'supervision-implementation-heartbeat',
            memoryExcluded: true,
          },
          { source: 'daemon', confidence: 'high', eventId: clientMessageId },
        );
        try {
          runtime.send(prompt, clientMessageId, undefined, undefined, {
            timelineCommitted: true,
            deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
          });
        } catch (error) {
          logger.warn({
            taskId: task.taskId,
            assignmentId: assignment.assignmentId,
            session: rebound.identity.sessionName,
            err: error,
          }, 'Supervision implementation heartbeat dispatch failed');
        }
      }
    }
  }

  setServerLink(_serverLink: ServerLink | null): void {
    // Kept as a compatibility hook for lifecycle wiring. The daemon no longer
    // owns peer-audit lifecycle; Brain dispatches audits explicitly.
  }

  cancelSession(sessionName: string): void {
    const state = this.activeRuns.get(sessionName);
    if (this.automaticPeerAuditCompatibilityForTests
      && state?.phase === 'auditing' && state.auditAttemptId) {
      this.clearAuditDeadline(state);
      this.clearAuditTargetRecovery(state);
      this.emitOrchestratedAuditResult(state, 'cancelled', 'session_supervision_cancelled');
    }
    // A deleted run must not leave any completion timer armed. Generations are
    // monotonic, but clearing eagerly avoids retaining stale run state.
    if (state) {
      this.clearWaitingTimers(state);
      this.clearCompletionGrace(state);
    }
    this.deletePersistedWaitState(sessionName);
    this.clearImplicitCompletionGrace(sessionName);
    this.activeRuns.delete(sessionName);
    this.pendingTaskIntents.delete(sessionName);
    this.recentTaskCandidates.delete(sessionName);
    this.latestAssistantTexts.delete(sessionName);
    this.lastObservedSessionStates.delete(sessionName);
    this.recoverySuppressedUntilNextUser.delete(sessionName);
    this.forgetRecoveredImplicitCompletionKeys(sessionName);
    this.clearStatus(sessionName);
  }

  /**
   * Stand supervision down because the user pressed STOP on `sessionName`.
   *
   * STOP has to mean "everything driving this session stops". Legacy daemon
   * versions may leave an in-memory audit-target reference, so sweep it
   * silently; cancellation/result notices belong to Brain's explicit audit
   * lifecycle and must not be injected into ordinary chat.
   */
  cancelForUserStop(sessionName: string): void {
    this.cancelSession(sessionName);
    this.recoverySuppressedUntilNextUser.add(sessionName);
    for (const run of [...this.activeRuns.values()]) {
      if (run.sessionName === sessionName) continue;
      if (run.snapshot.auditTargetSessionName !== sessionName) continue;
      this.clearAuditDeadline(run);
      this.clearAuditTargetRecovery(run);
      if (this.automaticPeerAuditCompatibilityForTests
        && run.phase === 'auditing' && run.auditAttemptId) {
        this.emitOrchestratedAuditResult(run, 'cancelled', 'audit_target_user_stopped');
      }
      this.clearWaitingTimers(run);
      this.clearCompletionGrace(run);
      this.activeRuns.delete(run.sessionName);
      this.deletePersistedWaitState(run.sessionName);
      this.clearStatus(run.sessionName);
      if (this.automaticPeerAuditCompatibilityForTests) {
        this.emitWarning(
          run.sessionName,
          `Supervision stopped: ${sessionName} was stopped by the user, so its audit cannot complete.`,
        );
      }
    }
  }

  applySnapshotUpdate(sessionName: string, snapshot: SessionSupervisionSnapshot | null | undefined): void {
    // Quick Peer Audit remains user-invoked. Automatic supervision must never
    // enable/disable, start, cancel, or recover its audit controller.
    peerAuditService.applyAutomaticConfiguration(
      sessionName,
      this.automaticPeerAuditCompatibilityForTests
        && Boolean(snapshot && snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
          && snapshot.auditTargetSessionName),
    );
    if (!isBrainOwnedAutomaticSupervision(sessionName, snapshot)) {
      this.heartbeatPausedForNeedsInput.delete(sessionName);
      this.cancelSession(sessionName);
      return;
    }
    if (snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT) {
      this.emitStatus(sessionName, SUPERVISION_AUDIT_ENABLED_STATUS, SUPERVISION_AUDIT_ENABLED_LABEL);
    }
    const active = this.activeRuns.get(sessionName);
    if (active) {
      active.snapshot = active.snapshot.uiLocale
        ? { ...snapshot, uiLocale: active.snapshot.uiLocale }
        : snapshot;
      active.hasLiveSnapshotUpdate = true;
    }
    const pending = this.pendingTaskIntents.get(sessionName);
    if (pending) {
      this.pendingTaskIntents.set(sessionName, {
        ...pending,
        snapshot: pending.snapshot.uiLocale
          ? { ...snapshot, uiLocale: pending.snapshot.uiLocale }
          : snapshot,
      });
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
      if (!this.tryStartImplicitRun(sessionName, snapshot)
        && !this.tryRecoverImplicitRunFromTimeline(sessionName, snapshot)) {
        const candidate = this.recentTaskCandidates.get(sessionName);
        if (candidate) this.armImplicitCompletionGrace(sessionName, snapshot, candidate);
      }
    }
  }

  /**
   * Single source of truth for "is this session still working".
   *
   * For transport sessions the runtime diagnostics are complete and live, so
   * neither the cached timeline state nor the persisted store participates --
   * consulting them was what allowed a stale projection to authorize a
   * termination. `transportRuntimeIsWorking()` cannot be reused here because it
   * folds "no runtime" and "not working" into the same `false`, which is
   * exactly the distinction this tri-state exists to keep.
   */
  private resolveSessionActivity(sessionName: string): 'active' | 'idle' | 'unknown' {
    const observed = this.lastObservedSessionStates.get(sessionName);
    const persisted = getSession(sessionName)?.state;
    const runtime = getTransportRuntime(sessionName);
    // This predicate runs on every idle check, which is a far wider surface
    // than the original narrow call sites. Not every runtime implementation
    // exposes diagnostics, so probe before use and fall back to the event
    // stream rather than throwing inside a timer callback.
    if (runtime && typeof runtime.getDiagnosticSnapshot === 'function') {
      const activity = runtime.getDiagnosticSnapshot();
      if (isWorkingSessionState(activity.status)
        || activity.sending
        || activity.pendingCount > 0
        || activity.activeDispatchCount > 0
        || activity.blockingWorkCount > 0) return 'active';
      // A quiet runtime is necessary but NOT sufficient. When another signal
      // still asserts work is in flight we genuinely do not know which one is
      // stale, and "unknown" must never be silently upgraded to "finished" --
      // that is what let a stale projection authorize a termination. Unknown
      // keeps the watchdog armed and ends at a visible needs_input instead.
      // The observed event stream wins over the persisted projection: when we
      // have seen an edge, that is the freshest thing we know.
      if (observed) return observed === 'idle' ? 'idle' : 'unknown';
      if (persisted === 'running') return 'unknown';
      return 'idle';
    }
    if (observed) return observed === 'idle' ? 'idle' : 'active';
    if (persisted === 'idle') return 'idle';
    if (persisted === 'running') return 'active';
    return 'unknown';
  }

  private isSessionIdle(sessionName: string): boolean {
    return this.resolveSessionActivity(sessionName) === 'idle';
  }

  /**
   * Positive, diagnostics-backed proof that work is in flight right now.
   *
   * Deliberately stricter than `resolveSessionActivity() === 'active'`: that
   * one infers `active` from an observed projection when no runtime exists,
   * which is fine for deciding "not idle yet" but must never be enough to
   * REVOKE the only watchdog a run has. A delayed/reordered `running` row on a
   * session with no diagnostics would otherwise clear the timer and leave the
   * run in `activeRuns` with no timer and no terminal action -- the original
   * permanent-hang bug, reachable again through a different door.
   */
  private hasActiveRuntimeEvidence(sessionName: string): boolean {
    const runtime = getTransportRuntime(sessionName);
    if (!runtime || typeof runtime.getDiagnosticSnapshot !== 'function') return false;
    const activity = runtime.getDiagnosticSnapshot();
    return isWorkingSessionState(activity.status)
      || activity.sending
      || activity.pendingCount > 0
      || activity.activeDispatchCount > 0
      || activity.blockingWorkCount > 0;
  }

  private isEligibleAssistantCompletionPayload(payload: Record<string, unknown>): boolean {
    return isFinalAssistantPayload(payload)
      && payload.automation !== true
      && payload.memoryExcluded !== true;
  }

  private getRecoveryTimelineEvents(sessionName: string): TimelineEvent[] {
    const events: TimelineEvent[] = [];
    const seen = new Set<string>();
    const add = (event: TimelineEvent) => {
      if (!isRecoveryRelevantTimelineEvent(event)) return;
      const key = `${event.epoch}:${event.seq}:${event.eventId}`;
      if (seen.has(key)) return;
      seen.add(key);
      events.push(event);
    };

    const fileEvents: TimelineEvent[] = [];
    for (const line of readTailLines(timelineStore.filePath(sessionName), SUPERVISION_RECOVERY_RAW_EVENT_SCAN_LIMIT)) {
      try {
        const event = JSON.parse(line) as TimelineEvent;
        if (!isRecoveryRelevantTimelineEvent(event)) continue;
        fileEvents.push(event);
        if (fileEvents.length >= SUPERVISION_RECOVERY_RELEVANT_EVENT_LIMIT) break;
      } catch { /* skip corrupt JSONL lines */ }
    }
    for (const event of fileEvents.reverse()) add(event);
    for (const event of timelineEmitter.getBufferedEvents(sessionName)) add(event);
    return events;
  }

  private rememberRecoveredImplicitCompletionKey(key: string): void {
    if (this.recoveredImplicitCompletionKeySet.has(key)) return;
    this.recoveredImplicitCompletionKeySet.add(key);
    this.recoveredImplicitCompletionKeys.push(key);
    while (this.recoveredImplicitCompletionKeys.length > SUPERVISION_RECOVERED_COMPLETION_KEYS_MAX) {
      const evicted = this.recoveredImplicitCompletionKeys.shift();
      if (evicted) this.recoveredImplicitCompletionKeySet.delete(evicted);
    }
  }

  private forgetRecoveredImplicitCompletionKeys(sessionName: string): void {
    const prefix = `${sessionName}:`;
    if (!this.recoveredImplicitCompletionKeys.some((key) => key.startsWith(prefix))) return;
    this.recoveredImplicitCompletionKeys = this.recoveredImplicitCompletionKeys.filter((key) => {
      const keep = !key.startsWith(prefix);
      if (!keep) this.recoveredImplicitCompletionKeySet.delete(key);
      return keep;
    });
  }

  private rememberEmittedAuditResultAttempt(attemptId: string): boolean {
    // Consumed-attempt tombstones are tracked separately from the 512-entry
    // emission ring: the ring exists to de-duplicate result emission and
    // evicts by age, which would silently re-open a settled attempt for
    // adoption.
    //
    // What this provides, precisely: recent same-process duplicate-attempt
    // suppression. NOT global, NOT cross-restart, NOT permanent. That is
    // sufficient because the attempt label is not the deciding authority --
    // adoption still requires a live pending delegation authority (purpose,
    // origin, target, session identity) and the verdict still has to come back
    // from the configured auditor over that authority.
    this.consumedAuditAttemptIds.add(attemptId);
    while (this.consumedAuditAttemptIds.size > SUPERVISION_CONSUMED_AUDIT_ATTEMPTS_MAX) {
      const oldest = this.consumedAuditAttemptIds.values().next().value;
      if (oldest === undefined) break;
      this.consumedAuditAttemptIds.delete(oldest);
    }
    if (this.emittedAuditResultAttemptIdSet.has(attemptId)) return false;
    this.emittedAuditResultAttemptIdSet.add(attemptId);
    this.emittedAuditResultAttemptIds.push(attemptId);
    while (this.emittedAuditResultAttemptIds.length > SUPERVISION_EMITTED_AUDIT_RESULTS_MAX) {
      const evicted = this.emittedAuditResultAttemptIds.shift();
      if (evicted) this.emittedAuditResultAttemptIdSet.delete(evicted);
    }
    return true;
  }

  private timelineCompletionKey(sessionName: string, event: Pick<TimelineEvent, 'epoch' | 'seq' | 'eventId'>): string {
    return `${sessionName}:${event.epoch}:${event.seq}:${event.eventId}`;
  }

  private findRecoverableImplicitCompletion(sessionName: string): RecoveredImplicitCompletion | null {
    const record = getSession(sessionName);
    const createdAt = typeof record?.createdAt === 'number' ? record.createdAt : 0;
    const latestEventTs = Date.now() + 5_000;
    let candidate: RecentTaskCandidate | null = null;
    let latestAssistant: LatestAssistantText | null = null;
    let latestAssistantKey: string | null = null;
    let barrierAfterLatest: RecoveryBarrier = 'none';
    let stoppedBarrierResumed = false;
    let sequence = 0;

    for (const event of this.getRecoveryTimelineEvents(sessionName)) {
      if (createdAt > 0 && event.ts < createdAt) continue;
      if (event.ts > latestEventTs) continue;
      sequence += 1;
      const payload = event.payload as Record<string, unknown>;
      if (event.type === 'user.message') {
        const clientMessageId = trimString(payload.clientMessageId);
        const automation = payload.automation === true;
        const queueAppended = payload.queueAppended === true;
        const text = trimString(payload.text);
        const uiLocale = normalizeSupervisionUiLocale(payload.uiLocale);
        const delegationCompletionNotification = Boolean(
          !automation && isDelegationCompletionNotificationText(text),
        );
        const delegatedReply = Boolean(
          !automation && isDelegatedAuditReplyText(text),
        );
        if (!automation && !queueAppended && (delegatedReply || delegationCompletionNotification)) {
          if (latestAssistant) barrierAfterLatest = 'handled';
          continue;
        }
        if (!automation && !queueAppended && text && !text.startsWith('/')) {
          this.recoverySuppressedUntilNextUser.delete(sessionName);
          // A bare continue is a control-only resume signal in both the live
          // path and durable recovery. It may lift STOP suppression, but it
          // must never replace the original task candidate — including when a
          // previous assistant completion already precedes it in the timeline.
          if (isBareSupervisionContinueText(text)) {
            if (barrierAfterLatest === 'stopped') stoppedBarrierResumed = true;
            continue;
          }
          candidate = {
            commandId: clientMessageId ?? `implicit-recovered:${event.epoch}:${event.seq}:${event.eventId}`,
            text,
            sequence,
            ...(uiLocale ? { uiLocale } : {}),
          };
          latestAssistant = null;
          latestAssistantKey = null;
          barrierAfterLatest = 'none';
          stoppedBarrierResumed = false;
        }
        continue;
      }

      if (event.type === 'assistant.text') {
        if (payload.automation === true) {
          const automationKind = trimString(payload.automationKind);
          if (latestAssistant && automationKind?.startsWith('supervision')) {
            barrierAfterLatest = 'handled';
          }
          continue;
        }
        if (candidate
          && (barrierAfterLatest === 'none' || (barrierAfterLatest === 'stopped' && stoppedBarrierResumed))
          && this.isEligibleAssistantCompletionPayload(payload)) {
          const text = typeof payload.text === 'string' ? payload.text : '';
          latestAssistantKey = this.timelineCompletionKey(sessionName, event);
          latestAssistant = { text, sequence, completionKey: latestAssistantKey };
          barrierAfterLatest = 'none';
          stoppedBarrierResumed = false;
        }
        continue;
      }

      if (latestAssistant && (event.type === 'peer_audit.result' || event.type === AGENT_DELEGATION_REPLY_TIMELINE_EVENT)) {
        barrierAfterLatest = 'handled';
      }
      if (candidate && event.type === 'session.state') {
        const resetReason = trimString(payload.resetReason);
        const reason = trimString(payload.reason);
        if (resetReason === 'command_handler_cancel_idle' || reason === 'stopped') {
          latestAssistant = null;
          latestAssistantKey = null;
          barrierAfterLatest = 'stopped';
          stoppedBarrierResumed = false;
        }
      }
    }

    if (!candidate || !latestAssistant || !latestAssistantKey || barrierAfterLatest !== 'none') return null;
    if (this.recoverySuppressedUntilNextUser.has(sessionName)) return null;
    if (this.recoveredImplicitCompletionKeySet.has(latestAssistantKey)) return null;
    return { candidate, latestAssistant, completionKey: latestAssistantKey };
  }

  private tryRecoverImplicitRunFromTimeline(
    sessionName: string,
    snapshot: SessionSupervisionSnapshot,
  ): boolean {
    if (!isBrainOwnedAutomaticSupervision(sessionName, snapshot)) return false;
    const recovered = this.findRecoverableImplicitCompletion(sessionName);
    if (!recovered) return false;
    this.recentTaskCandidates.set(sessionName, recovered.candidate);
    this.latestAssistantTexts.set(sessionName, recovered.latestAssistant);
    if (this.tryStartImplicitRun(sessionName, snapshot)) return true;
    this.recentTaskCandidates.delete(sessionName);
    this.latestAssistantTexts.delete(sessionName);
    this.rememberRecoveredImplicitCompletionKey(recovered.completionKey);
    return false;
  }

  private emitCheckingState(sessionName: string): void {
    this.emitStatus(sessionName, 'supervision_waiting', SUPERVISION_WAITING_LABEL);
    this.emitAutomationNote(sessionName, 'Auto: checking whether the task is complete...', 'supervision-status');
  }

  private failClosedMissingCompletion(sessionName: string): void {
    this.emitTerminalStatus(sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
    this.emitWarning(sessionName, 'Automation stopped because no completed assistant response was available for that turn. Manual continuation is required.');
  }

  /**
   * Terminal notice for "the reply arrived, the session state did not".
   * Distinct from `failClosedMissingCompletion`: there the assistant response
   * is missing, here it exists and only activity convergence failed. Reusing
   * the other wording sent users to re-run the model instead of looking at
   * provider/runtime state.
   */
  private failClosedUnconfirmedActivity(sessionName: string): void {
    this.emitTerminalStatus(sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
    this.emitWarning(sessionName, 'Automation stopped because the assistant result arrived but this session\'s activity could not be confirmed before the deadline. Check the provider/runtime state; manual continuation is required.');
  }

  private tryStartImplicitRun(
    sessionName: string,
    snapshot: SessionSupervisionSnapshot,
  ): boolean {
    const candidate = this.recentTaskCandidates.get(sessionName);
    const latestAssistant = this.latestAssistantTexts.get(sessionName);
    if (!candidate || !latestAssistant) return false;
    if (latestAssistant.sequence <= candidate.sequence) return false;
    const implicitRun = this.registerTaskIntent(
      sessionName,
      candidate.commandId,
      candidate.text,
      candidate.uiLocale ? { ...snapshot, uiLocale: candidate.uiLocale } : snapshot,
    );
    if (!implicitRun) return false;
    implicitRun.lastAssistantText = latestAssistant.text;
    implicitRun.lastAssistantCompletionKey = latestAssistant.completionKey;
    implicitRun.sawAssistantOutput = true;
    implicitRun.evaluating = true;
    if (latestAssistant.completionKey) this.rememberRecoveredImplicitCompletionKey(latestAssistant.completionKey);
    this.emitCheckingState(sessionName);
    void this.evaluateExecutionTurn(implicitRun).catch((error) => {
      const current = this.activeRuns.get(sessionName);
      if (!current || current.generation !== implicitRun.generation) return;
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
    if (!isBrainOwnedAutomaticSupervision(sessionName, snapshot)) return;
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
    if (!isBrainOwnedAutomaticSupervision(sessionName, snapshot)) return;
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
    if (!isBrainOwnedAutomaticSupervision(sessionName, snapshot)) return null;
    this.heartbeatPausedForNeedsInput.delete(sessionName);
    this.clearImplicitCompletionGrace(sessionName);
    this.recoverySuppressedUntilNextUser.delete(sessionName);
    const existing = this.activeRuns.get(sessionName);
    if (existing?.phase === 'auditing') {
      this.clearAuditDeadline(existing);
      this.clearAuditTargetRecovery(existing);
      if (this.automaticPeerAuditCompatibilityForTests && existing.auditAttemptId) {
        this.emitOrchestratedAuditResult(existing, 'cancelled', 'new_task_intent_replaced_existing_audit');
      }
    }
    if (existing) {
      this.clearWaitingTimers(existing);
      this.clearCompletionGrace(existing);
      this.deletePersistedWaitState(sessionName);
    }
    const generation = ++this.nextRunGeneration;
    const next: ActiveTaskRunState = {
      generation,
      sessionName,
      commandId,
      snapshot,
      hasLiveSnapshotUpdate: false,
      userText: text,
      phase: 'execution',
      requiresAudit: snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT,
      freshAuditRequiredAfterRework: false,
      continueLoops: 0,
      continueStreakCount: 0,
      evaluating: false,
      sawAssistantOutput: false,
      reworkDispatches: 0,
      auditReplyObserved: false,
      auditVerdictCorrectionAttempts: 0,
      auditMarkerWarningEmitted: false,
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

  private clearWaitingTimers(
    run: ActiveTaskRunState,
    options: { preserveWindow?: boolean } = {},
  ): void {
    if (run.waitingTimeoutTimer) clearTimeout(run.waitingTimeoutTimer);
    if (run.waitingHeartbeatTimer) clearTimeout(run.waitingHeartbeatTimer);
    // A pending authority retry must die with the run; otherwise it fires
    // against a finished run and, worse, keeps the process awake.
    if (run.authorityRecoveryTimer) clearTimeout(run.authorityRecoveryTimer);
    run.waitingTimeoutTimer = undefined;
    run.waitingHeartbeatTimer = undefined;
    run.authorityRecoveryTimer = undefined;
    if (!options.preserveWindow) {
      run.waitingStartedAt = undefined;
      run.waitingDeadlineAt = undefined;
      run.waitingNextHeartbeatAt = undefined;
    }
  }

  private deletePersistedWaitState(sessionName: string): void {
    try {
      this.stateStore.delete(sessionName);
    } catch (error) {
      logger.warn({ session: sessionName, err: error }, 'Supervision durable wait-state delete failed');
    }
  }

  private persistWaitState(run: ActiveTaskRunState, phase: PersistedSupervisionWaitState['phase']): void {
    const ownerRecord = getSession(run.sessionName);
    const owner = ownerRecord ? persistedSessionIdentity(ownerRecord) : undefined;
    if (!owner) {
      logger.warn({ session: run.sessionName }, 'Supervision wait state lacks a stable session identity; durable recovery disabled');
      return;
    }
    const targetRecord = run.snapshot.auditTargetSessionName
      ? getSession(run.snapshot.auditTargetSessionName)
      : undefined;
    const auditTarget = targetRecord ? persistedSessionIdentity(targetRecord) : undefined;
    const now = Date.now();
    const state: PersistedSupervisionWaitState = {
      version: SUPERVISION_STATE_VERSION,
      owner,
      commandId: run.commandId,
      snapshot: run.snapshot,
      userText: run.userText,
      phase,
      ...(run.phase === 'finalizing' ? { runPhase: 'finalizing' as const } : {}),
      requiresAudit: run.requiresAudit,
      freshAuditRequiredAfterRework: run.freshAuditRequiredAfterRework,
      continueLoops: run.continueLoops,
      continueStreakCount: run.continueStreakCount,
      ...(run.lastContinueBucket ? { lastContinueBucket: run.lastContinueBucket } : {}),
      reworkDispatches: run.reworkDispatches,
      startedAt: run.startedAt,
      ...(run.auditDepth ? { auditDepth: run.auditDepth } : {}),
      ...(run.deferredFinalization ? { deferredFinalization: run.deferredFinalization } : {}),
      ...(run.waitingStartedAt !== undefined ? { waitingStartedAt: run.waitingStartedAt } : {}),
      ...(run.waitingDeadlineAt !== undefined ? { waitingDeadlineAt: run.waitingDeadlineAt } : {}),
      ...(run.waitingNextHeartbeatAt !== undefined ? { waitingNextHeartbeatAt: run.waitingNextHeartbeatAt } : {}),
      ...(run.auditAttemptId ? { auditAttemptId: run.auditAttemptId } : {}),
      ...(run.auditDelegationId ? { auditDelegationId: run.auditDelegationId } : {}),
      ...(run.auditStartedAt !== undefined ? { auditStartedAt: run.auditStartedAt } : {}),
      ...(run.auditDeadlineAt !== undefined ? { auditDeadlineAt: run.auditDeadlineAt } : {}),
      auditReplyObserved: run.auditReplyObserved,
      ...(auditTarget ? { auditTarget } : {}),
      ...(run.auditTargetDispatchObservedAt !== undefined
        ? { auditTargetDispatchObservedAt: run.auditTargetDispatchObservedAt }
        : {}),
      auditTargetObservedActive: run.auditTargetObservedActive,
      auditTargetRecoveryAttempts: run.auditTargetRecoveryAttempts,
      auditTargetRecoveryLimitNotified: run.auditTargetRecoveryLimitNotified,
      auditVerdictCorrectionAttempts: run.auditVerdictCorrectionAttempts,
      auditMarkerWarningEmitted: run.auditMarkerWarningEmitted,
      ...(run.sawAssistantOutput && run.lastAssistantText !== undefined
        ? { pendingAssistantText: run.lastAssistantText }
        : {}),
      ...(run.sawAssistantOutput && run.lastAssistantCompletionKey
        ? { pendingAssistantCompletionKey: run.lastAssistantCompletionKey }
        : {}),
      updatedAt: now,
    };
    try {
      this.stateStore.upsert(state);
    } catch (error) {
      logger.warn({ session: run.sessionName, phase, err: error }, 'Supervision durable wait-state persist failed');
    }
  }

  private restorePersistedWaitStates(): void {
    let persistedStates: PersistedSupervisionWaitState[];
    try {
      persistedStates = this.stateStore.list();
    } catch (error) {
      logger.warn({ err: error }, 'Supervision durable wait-state restore failed');
      return;
    }
    for (const persisted of persistedStates) {
      if (this.activeRuns.has(persisted.owner.sessionName)) continue;
      const ownerRecord = getSession(persisted.owner.sessionName);
      const snapshot = normalizeSessionSupervisionSnapshot(persisted.snapshot);
      if (!persistedIdentityMatches(persisted.owner, ownerRecord)
        || !isBrainOwnedAutomaticSupervision(persisted.owner.sessionName, snapshot)) {
        this.deletePersistedWaitState(persisted.owner.sessionName);
        continue;
      }
      // Upgrade boundary: old daemons persisted automatic audit attempts.
      // Never recover, cancel, time out, or chat-notify those attempts. Brain
      // owns any still-relevant structured audit state and can resume it
      // explicitly; the automation store is only authoritative for waiting
      // heartbeat state now.
      if (persisted.phase === 'auditing') {
        if (!this.automaticPeerAuditCompatibilityForTests) {
          this.deletePersistedWaitState(persisted.owner.sessionName);
          continue;
        }
        const targetRecord = persisted.auditTarget ? getSession(persisted.auditTarget.sessionName) : undefined;
        if (!persisted.auditAttemptId
          || !persisted.auditTarget
          || !persistedIdentityMatches(persisted.auditTarget, targetRecord)) {
          this.deletePersistedWaitState(persisted.owner.sessionName);
          this.emitTerminalStatus(persisted.owner.sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
          this.emitWarning(persisted.owner.sessionName, 'Supervision could not restore the exact peer-audit session identity after restart. Manual review is required.');
          continue;
        }
      }

      const run: ActiveTaskRunState = {
        generation: ++this.nextRunGeneration,
        sessionName: persisted.owner.sessionName,
        commandId: persisted.commandId,
        snapshot,
        hasLiveSnapshotUpdate: false,
        userText: persisted.userText,
        phase: persisted.phase !== 'waiting'
          ? 'auditing'
          : persisted.runPhase === 'finalizing' ? 'finalizing' : 'execution',
        requiresAudit: persisted.requiresAudit,
        freshAuditRequiredAfterRework: persisted.freshAuditRequiredAfterRework,
        continueLoops: persisted.continueLoops,
        continueStreakCount: persisted.continueStreakCount,
        ...(persisted.lastContinueBucket ? { lastContinueBucket: persisted.lastContinueBucket } : {}),
        evaluating: false,
        sawAssistantOutput: persisted.pendingAssistantText !== undefined,
        ...(persisted.pendingAssistantText !== undefined
          ? { lastAssistantText: persisted.pendingAssistantText }
          : {}),
        ...(persisted.pendingAssistantCompletionKey
          ? { lastAssistantCompletionKey: persisted.pendingAssistantCompletionKey }
          : {}),
        reworkDispatches: persisted.reworkDispatches,
        auditReplyObserved: persisted.auditReplyObserved,
        auditVerdictCorrectionAttempts: persisted.auditVerdictCorrectionAttempts,
        auditMarkerWarningEmitted: persisted.auditMarkerWarningEmitted,
        auditTargetObservedActive: persisted.auditTargetObservedActive,
        auditTargetRecoveryAttempts: persisted.auditTargetRecoveryAttempts,
        auditTargetRecoveryLimitNotified: persisted.auditTargetRecoveryLimitNotified,
        startedAt: persisted.startedAt,
        ...(persisted.auditDepth ? { auditDepth: persisted.auditDepth } : {}),
        ...(persisted.deferredFinalization ? { deferredFinalization: persisted.deferredFinalization } : {}),
        ...(persisted.waitingStartedAt !== undefined ? { waitingStartedAt: persisted.waitingStartedAt } : {}),
        ...(persisted.waitingDeadlineAt !== undefined ? { waitingDeadlineAt: persisted.waitingDeadlineAt } : {}),
        ...(persisted.waitingNextHeartbeatAt !== undefined
          ? { waitingNextHeartbeatAt: persisted.waitingNextHeartbeatAt }
          : {}),
        ...(persisted.phase === 'waiting' && persisted.pendingAssistantText !== undefined
          ? { waitingEvaluationPending: true }
          : {}),
        ...(persisted.auditAttemptId ? { auditAttemptId: persisted.auditAttemptId } : {}),
        ...(persisted.auditDelegationId ? { auditDelegationId: persisted.auditDelegationId } : {}),
        ...(persisted.auditStartedAt !== undefined ? { auditStartedAt: persisted.auditStartedAt } : {}),
        ...(persisted.auditDeadlineAt !== undefined ? { auditDeadlineAt: persisted.auditDeadlineAt } : {}),
        ...(persisted.auditTarget?.sessionInstanceId
          ? { auditTargetSessionInstanceId: persisted.auditTarget.sessionInstanceId }
          : {}),
        ...(persisted.auditTargetDispatchObservedAt !== undefined
          ? { auditTargetDispatchObservedAt: persisted.auditTargetDispatchObservedAt }
          : {}),
      };
      this.activeRuns.set(run.sessionName, run);
      if (persisted.phase === 'auditing') {
        this.emitStatus(run.sessionName, 'supervision_audit_waiting', SUPERVISION_AUDIT_WAITING_LABEL);
        this.armAuditDeadline(run, { preserveDeadline: true });
        if (run.auditReplyObserved && run.sawAssistantOutput) {
          queueMicrotask(() => this.handleOrchestratedAuditCompletion(run, { settledWithoutIdle: true }));
        }
      } else if (run.waitingEvaluationPending) {
        run.evaluating = true;
        this.emitCheckingState(run.sessionName);
        queueMicrotask(() => {
          void this.evaluateExecutionTurn(run).catch((error) => {
            logger.warn({ session: run.sessionName, err: error }, 'Restored supervision waiting evaluation failed');
            this.finishRun(run.sessionName, 'needs_input');
          });
        });
      } else {
        this.emitStatus(run.sessionName, 'supervision_parked', SUPERVISION_PARKED_LABEL);
        this.armWaitingTimers(run, { preserveSchedule: true });
      }
    }
  }

  /** Simulates process-memory loss while retaining SQLite authority. */
  __simulateProcessRestartForTests(): void {
    for (const run of this.activeRuns.values()) {
      this.clearWaitingTimers(run, { preserveWindow: true });
      this.clearAuditDeadline(run);
      this.clearAuditTargetRecoveryTimer(run);
      this.clearCompletionGrace(run);
    }
    this.activeRuns.clear();
    this.pendingTaskIntents.clear();
    this.recentTaskCandidates.clear();
    this.latestAssistantTexts.clear();
    this.implementationBlockerEscalationsInFlight.clear();
    this.restorePersistedWaitStates();
  }

  private clearCompletionGrace(run: ActiveTaskRunState): void {
    if (run.completionGraceTimer) clearTimeout(run.completionGraceTimer);
    run.completionGraceTimer = undefined;
  }

  private clearImplicitCompletionGrace(sessionName: string): void {
    const timer = this.implicitCompletionGraceTimers.get(sessionName);
    if (timer) clearTimeout(timer);
    this.implicitCompletionGraceTimers.delete(sessionName);
  }

  private evaluateIdleRun(run: ActiveTaskRunState): void {
    if (run.evaluating || !run.sawAssistantOutput) return;
    if (run.phase !== 'execution' && run.phase !== 'finalizing') return;
    this.clearCompletionGrace(run);
    if (run.lastAssistantCompletionKey) this.rememberRecoveredImplicitCompletionKey(run.lastAssistantCompletionKey);
    this.emitCheckingState(run.sessionName);
    run.evaluating = true;
    void this.evaluateExecutionTurn(run).catch((error) => {
      const current = this.activeRuns.get(run.sessionName);
      if (!current || current.generation !== run.generation) return;
      logger.warn({ session: run.sessionName, err: error }, 'Supervision execution evaluation failed');
      this.clearStatus(run.sessionName);
      this.emitWarning(run.sessionName, 'Automation could not determine whether the task is complete. Manual continuation is required.');
      this.finishRun(run.sessionName, 'needs_input');
    });
  }

  private armCompletionGrace(run: ActiveTaskRunState): void {
    this.clearCompletionGrace(run);
    const generation = run.generation;
    let timer: NodeJS.Timeout;
    timer = setTimeout(() => {
      const latest = this.activeRuns.get(run.sessionName);
      if (!latest || latest.completionGraceTimer !== timer || latest.generation !== generation) return;
      latest.completionGraceTimer = undefined;
      if (latest.sawAssistantOutput) {
        const activity = this.resolveSessionActivity(latest.sessionName);
        if (activity === 'idle') {
          latest.completionWaitStartedAt = undefined;
          this.evaluateIdleRun(latest);
          return;
        }
        // The budget measures how long we have waited without TRUSTWORTHY
        // evidence, not total turn length, so a genuinely long tool-using turn
        // is never failed. Only diagnostics-backed activity resets the window:
        // an `active` merely inferred from a projection (no runtime, or a
        // stale `running` row) must keep consuming the budget, otherwise such a
        // run re-arms forever and never reaches a terminal state.
        if (this.hasActiveRuntimeEvidence(latest.sessionName)) {
          latest.completionWaitStartedAt = Date.now();
        } else if (latest.completionWaitStartedAt === undefined) {
          latest.completionWaitStartedAt = Date.now();
        }
        if (!this.hasActiveRuntimeEvidence(latest.sessionName)
          && Date.now() - (latest.completionWaitStartedAt ?? Date.now()) >= SUPERVISION_COMPLETION_WAIT_MAX_MS) {
          // Never end without a terminal action: the previous code returned
          // here with no timer and the run left in activeRuns forever.
          this.failClosedUnconfirmedActivity(latest.sessionName);
          this.finishRun(latest.sessionName, 'needs_input', { preserveStatus: true });
          return;
        }
        this.armCompletionGrace(latest);
        return;
      }
      if (!this.isSessionIdle(latest.sessionName) || latest.evaluating) return;
      this.failClosedMissingCompletion(latest.sessionName);
      this.finishRun(latest.sessionName, 'needs_input', { preserveStatus: true });
    }, SUPERVISION_COMPLETION_GRACE_MS);
    timer.unref?.();
    run.completionGraceTimer = timer;
  }

  private armImplicitCompletionGrace(
    sessionName: string,
    snapshot: SessionSupervisionSnapshot,
    candidate: RecentTaskCandidate,
  ): void {
    this.clearImplicitCompletionGrace(sessionName);
    let timer: NodeJS.Timeout;
    timer = setTimeout(() => {
      if (this.implicitCompletionGraceTimers.get(sessionName) !== timer) return;
      this.implicitCompletionGraceTimers.delete(sessionName);
      if (this.activeRuns.has(sessionName) || !this.isSessionIdle(sessionName)) return;
      const latestCandidate = this.recentTaskCandidates.get(sessionName);
      if (!latestCandidate || latestCandidate.sequence !== candidate.sequence) return;
      if (this.tryStartImplicitRun(sessionName, snapshot)) return;
      this.failClosedImplicitCandidate(sessionName, snapshot);
    }, SUPERVISION_COMPLETION_GRACE_MS);
    timer.unref?.();
    this.implicitCompletionGraceTimers.set(sessionName, timer);
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

  private deferExplicitPostAuditWork(run: ActiveTaskRunState): void {
    if (run.deferredFinalization) return;

    // Do not replay work the completed turn already proves was finalized,
    // and let an explicit task-scoped prohibition override a broader account
    // default. A qualified "do not commit until audit PASS" is handled below
    // as a deferred requirement rather than a permanent prohibition.
    if (COMPLETED_REPOSITORY_FINALIZATION_RE.test(run.lastAssistantText ?? '')) return;
    if (
      FINALIZATION_PROHIBITION_RE.test(run.userText)
      && !FINALIZATION_UNTIL_AUDIT_PASS_RE.test(run.userText)
    ) return;

    const customInstructions = resolveSupervisionCustomInstructionsDetail(
      enrichSnapshotWithGlobalDefaults(run.snapshot),
    )?.text;
    const explicitRequirements = [run.userText, customInstructions].filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );

    if (explicitRequirements.some((value) => POST_AUDIT_DEFERRED_WORK_RE.test(value))) {
      run.deferredFinalization = {
        reason: 'The original task or supervision rules explicitly defer validation or repository finalization until peer-audit PASS.',
        nextAction: POST_AUDIT_DEFERRED_NEXT_ACTION,
      };
      return;
    }

    if (!explicitRequirements.some(hasExplicitRepositoryFinalizationRequirement)) return;
    run.deferredFinalization = {
      reason: 'The original task or supervision rules explicitly require repository or delivery finalization after the reviewed work.',
      nextAction: POST_AUDIT_REPOSITORY_FINALIZATION_ACTION,
    };
  }

  private deferRepositoryFinalizationIfPresent(
    run: ActiveTaskRunState,
    decision: { reason: string; gap?: string },
    evidence: string,
  ): void {
    if (!REPOSITORY_FINALIZATION_ACTION_RE.test(evidence) || run.deferredFinalization) return;
    run.deferredFinalization = {
      reason: decision.reason,
      nextAction: POST_AUDIT_REPOSITORY_FINALIZATION_ACTION,
      ...(decision.gap ? { gap: decision.gap } : {}),
    };
  }

  private beginObservedAudit(
    run: ActiveTaskRunState,
    target: NonNullable<ReturnType<typeof getSession>>,
    options: {
      auditAttemptId: string;
      delegationId?: string;
    },
  ): void {
    if (run.phase !== 'execution' && run.phase !== 'auditing') return;
    if (run.phase === 'auditing' && run.auditDelegationId && run.auditDelegationId !== options.delegationId) return;

    // SINGLE CONVERGENCE POINT for both observation callers (structured record
    // and legacy text-pattern), and it runs before ANY mutation below --
    // before deferExplicitPostAuditWork, before phase becomes 'auditing',
    // before the attempt/instance ids are adopted, before the deadline is armed.
    //
    // This is NOT redundant with the startAudit gate. The legacy caller fires on
    // a TEXT PATTERN, so no audit envelope exists and the send-tool gate never
    // ran for it: a session whose message merely looks like an audit delegation
    // could adopt an ineligible auditor and arm a 15-minute deadline against a
    // stopped session, an execution clone, or a non-direct child. Both entry
    // points call the SAME shared validator, so they cannot drift; neither can
    // mask the other, because each guards mutations the other never reaches.
    const route = validateBrainAuditRoute({
      auditedSessionName: run.sessionName,
      targetName: target.name,
      allSessions: listSessions(),
    });
    if (!route.ok) {
      logger.warn({
        session: run.sessionName,
        targetName: target.name,
        refusal: route.refusal,
      }, 'Observed peer audit refused the adopted route');
      this.failUnroutableAudit(
        run,
        `Automation observed a peer audit delegated to an unusable auditor: ${route.detail}. Manual review is required.`,
      );
      return;
    }

    if (run.phase === 'execution') this.deferExplicitPostAuditWork(run);
    run.phase = 'auditing';
    run.requiresAudit = false;
    run.evaluating = false;
    run.terminalState = 'complete';
    run.auditReplyObserved = false;
    run.auditVerdictCorrectionAttempts = 0;
    run.auditMarkerWarningEmitted = false;
    run.auditAttemptId = options.auditAttemptId;
    run.auditDelegationId = options.delegationId;
    run.auditStartedAt = Date.now();
    run.auditDeadlineAt = undefined;
    run.auditTargetSessionInstanceId = target.sessionInstanceId;
    run.auditTargetDispatchObservedAt = Date.now();
    run.auditTargetObservedActive = true;
    run.auditTargetRecoveryAttempts = 0;
    run.auditTargetRecoveryLimitNotified = false;
    run.sawAssistantOutput = false;
    run.lastAssistantText = undefined;
    this.clearAuditTargetRecoveryTimer(run);
    this.emitStatus(run.sessionName, 'supervision_audit_waiting', SUPERVISION_AUDIT_WAITING_LABEL);
    this.emitAutomationNote(
      run.sessionName,
      'Auto: observed the existing reply-enabled peer-audit delegation; waiting for its PASS/REWORK receipt without sending another request.',
      'supervision-audit-delegated',
    );
    this.armAuditDeadline(run);
  }

  /**
   * True when a typed supervision-audit delegation exists for this text but was
   * refused (replay, wrong origin/target, attempt mismatch). Rejecting the
   * structured record must NOT fall through to the heuristic adoption branch:
   * that branch mints `randomUUID()` when no attempt is embedded, so a refused
   * replay would simply be re-adopted under a fresh identity and the guard
   * would be decorative.
   */
  private typedAuditRecordRefused(
    run: ActiveTaskRunState,
    eventSessionId: string,
    text: string | undefined,
  ): boolean {
    if (!text) return false;
    const authority = extractAgentDelegationReplyAuthorityFromInstruction(text);
    if (!authority) return false;
    const record = getDelegationReplyStore().matchPendingAuthority(authority);
    if (!record || record.purpose !== AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT) return false;
    return this.structuredAuditRecord(run, eventSessionId, text) === undefined;
  }

  private structuredAuditRecord(
    run: ActiveTaskRunState,
    eventSessionId: string,
    text: string | undefined,
  ): DelegationReplyRecord | undefined {
    if (!text || run.snapshot.auditTargetSessionName !== eventSessionId) return undefined;
    const authority = extractAgentDelegationReplyAuthorityFromInstruction(text);
    if (!authority) return undefined;
    const record = getDelegationReplyStore().matchPendingAuthority(authority);
    if (!record
      || record.purpose !== AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT
      || !record.auditAttemptId
      || record.origin.sessionName !== run.sessionName
      || record.target.sessionName !== eventSessionId
      // Adopting a worker-prepared typed delegation during `execution` is an
      // intended feature (it is how a self-addressed audit avoids a duplicate
      // daemon dispatch), so the attempt ID is necessarily supplied by the
      // audited session. What must NOT be possible is replaying an attempt that
      // has already settled: that would let the constrained party re-bind an
      // old verdict to new work. Equality is still enforced once the daemon has
      // issued its own attempt.
      || this.consumedAuditAttemptIds.has(record.auditAttemptId)
      || (run.auditAttemptId && run.auditAttemptId !== record.auditAttemptId)
      || !delegationIdentityMatches(record.origin, boundDelegationIdentity(getSession(run.sessionName)))
      || !delegationIdentityMatches(record.target, boundDelegationIdentity(getSession(eventSessionId)))) return undefined;
    return record;
  }

  /**
   * `imcodes send --reply` predates the typed `audit` metadata accepted by the
   * MCP tool. Automatic-audit prompts still name it as the fallback for agents
   * without `send_message`, so bind that ordinary reply authority at the exact
   * configured audit dispatch instead of losing the completion receipt later.
   */
  private legacyAuditRecord(
    run: ActiveTaskRunState,
    eventSessionId: string,
    text: string | undefined,
  ): DelegationReplyRecord | undefined {
    if (!text || run.snapshot.auditTargetSessionName !== eventSessionId) return undefined;
    const authority = extractAgentDelegationReplyAuthorityFromInstruction(text);
    if (!authority) return undefined;
    const record = getDelegationReplyStore().matchPendingAuthority(authority);
    if (!record
      || record.purpose !== undefined
      || record.auditAttemptId !== undefined
      || record.origin.sessionName !== run.sessionName
      || record.target.sessionName !== eventSessionId
      || !delegationIdentityMatches(record.origin, boundDelegationIdentity(getSession(run.sessionName)))
      || !delegationIdentityMatches(record.target, boundDelegationIdentity(getSession(eventSessionId)))) return undefined;
    return record;
  }

  private handleStructuredDelegationReplyDelivered(record: DelegationReplyRecord): void {
    const run = this.activeRuns.get(record.origin.sessionName);
    const typedAudit = record.purpose === AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT
      && record.auditAttemptId === run?.auditAttemptId;
    const boundLegacyAudit = record.purpose === undefined
      && record.auditAttemptId === undefined
      && record.delegationId === run?.auditDelegationId;
    if (!typedAudit && !boundLegacyAudit) return;
    if (!run
      || run.phase !== 'auditing'
      || run.auditDelegationId !== record.delegationId
      || run.snapshot.auditTargetSessionName !== record.target.sessionName
      || !delegationIdentityMatches(record.origin, boundDelegationIdentity(getSession(record.origin.sessionName)))
      || !delegationIdentityMatches(record.target, boundDelegationIdentity(getSession(record.target.sessionName)))) return;
    this.clearAuditTargetRecovery(run);
    run.auditReplyObserved = true;
    run.auditVerdictCorrectionAttempts = 0;
    run.auditMarkerWarningEmitted = false;
    run.sawAssistantOutput = false;
    run.lastAssistantText = undefined;
    this.persistWaitState(run, 'auditing');
    this.emitStatus(run.sessionName, 'supervision_audit_waiting', SUPERVISION_AUDIT_WAITING_LABEL);
    this.emitAutomationNote(
      run.sessionName,
      'Auto: the structured delegated audit reply arrived; waiting for this session to produce the final PASS/REWORK judgment.',
      'supervision-audit-reply-received',
    );
  }

  private isCorrelatedAuditTargetDispatch(
    run: ActiveTaskRunState,
    payload: Record<string, unknown>,
  ): boolean {
    const text = trimString(payload.text);
    if (!text || !run.auditAttemptId || payload.automation === true) return false;
    if (run.auditDelegationId) {
      return extractAgentDelegationReplyAuthorityFromInstruction(text)?.delegationId === run.auditDelegationId;
    }
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

  private transportRuntimeIsWorking(sessionName: string): boolean {
    const runtime = getTransportRuntime(sessionName);
    if (!runtime) return false;
    const activity = runtime.getDiagnosticSnapshot();
    return isWorkingSessionState(activity.status)
      || activity.sending
      || activity.pendingCount > 0
      || activity.activeDispatchCount > 0
      || activity.blockingWorkCount > 0;
  }

  private auditTargetRuntimeIsWorking(sessionName: string): boolean {
    return this.transportRuntimeIsWorking(sessionName);
  }

  private handleAuditTargetTimelineEvent(event: {
    sessionId: string;
    type: string;
    payload: Record<string, unknown>;
  }): void {
    for (const run of this.activeRuns.values()) {
      const targetsConfiguredAuditor = run.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
        && run.snapshot.auditTargetSessionName === event.sessionId;
      if (
        targetsConfiguredAuditor
        && (run.phase === 'execution' || (run.phase === 'auditing' && !run.auditDelegationId))
        && event.type === 'user.message'
      ) {
        const target = getSession(event.sessionId);
        if (!target) continue;
        const text = trimString(event.payload.text);
        const structured = this.structuredAuditRecord(run, event.sessionId, text);
        if (structured) {
          this.beginObservedAudit(run, target, {
            auditAttemptId: structured.auditAttemptId!,
            delegationId: structured.delegationId,
          });
        } else if (run.phase === 'execution' && !this.typedAuditRecordRefused(run, event.sessionId, text)) {
          const sharedActor = event.payload.sharedActor && typeof event.payload.sharedActor === 'object'
            ? event.payload.sharedActor as Record<string, unknown>
            : undefined;
          const exactOriginActor = trimString(sharedActor?.actorUserId) === run.sessionName;
          if (exactOriginActor && isReplyEnabledPeerAuditDelegationText(text, run.sessionName)) {
            const legacy = this.legacyAuditRecord(run, event.sessionId, text);
            const legacyAttempt = text?.match(/Automatic audit attempt ID:\s*([A-Za-z0-9_-]+)/iu)?.[1];
            this.beginObservedAudit(run, target, {
              auditAttemptId: legacyAttempt ?? randomUUID(),
              ...(legacy ? { delegationId: legacy.delegationId } : {}),
            });
          }
        }
      }

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
      const needsRecovery = state === 'error'
        || state === 'stopped'
        // If the audit target returns to idle without delivering the reply, the
        // audit model has either completed without reporting through the
        // required channel or stopped before the report reached this session.
        // Do not wait for the global audit deadline; tick the same audit turn
        // through the bounded recovery path. A real reply arriving during the
        // short backoff clears the timer before the continue is sent.
        || state === 'idle';
      if (!needsRecovery) continue;

      // Consume the active edge before arming the timer. Duplicate error/idle
      // projections for the same failed turn then cannot schedule duplicates;
      // a genuinely resumed turn must first emit running/queued again.
      run.auditTargetObservedActive = false;
      const recoveryState = state === 'idle' && !providerErrorBelongsToAttempt
        ? 'idle_without_audit_reply'
        : state;
      this.scheduleAuditTargetRecovery(run, recoveryState);
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

  /**
   * Keep a parked run observable without turning the heartbeat into normal
   * task advancement. The bounded-rate prompt does not consume continue-loop
   * budgets and its next-send time is persisted across daemon restarts. WAITING
   * remains recurrent until a real NEEDS_INPUT result pauses the lifecycle.
   */
  private armWaitingTimers(
    run: ActiveTaskRunState,
    options: { preserveSchedule?: boolean } = {},
  ): void {
    this.clearWaitingTimers(run, { preserveWindow: true });
    if (!isAutomaticSupervisionEnabled(run.snapshot)) return;
    const now = Date.now();
    run.waitingStartedAt ??= now;
    // There is deliberately no terminal wall-clock deadline. WAITING is a
    // durable state, not an implicit request for human input. Only a real
    // NEEDS_INPUT outcome pauses automatic heartbeats.
    run.waitingDeadlineAt = undefined;
    if (!options.preserveSchedule || run.waitingNextHeartbeatAt === undefined) {
      run.waitingNextHeartbeatAt = now + SUPERVISION_WAITING_HEARTBEAT_MS;
    }
    this.armNextWaitingHeartbeat(run);
    this.persistWaitState(run, 'waiting');
  }

  private armNextWaitingHeartbeat(
    run: ActiveTaskRunState,
    generation = run.generation,
    phase = run.phase,
  ): void {
    if (run.waitingHeartbeatTimer) clearTimeout(run.waitingHeartbeatTimer);
    run.waitingHeartbeatTimer = undefined;
    if (run.waitingNextHeartbeatAt === undefined
      || !isAutomaticSupervisionEnabled(run.snapshot)) return;
    let heartbeatTimer: NodeJS.Timeout;
    heartbeatTimer = setTimeout(() => {
      const latest = this.activeRuns.get(run.sessionName);
      if (!latest || latest.waitingHeartbeatTimer !== heartbeatTimer) return;
      if (latest.generation !== generation || latest.phase !== phase || latest.evaluating) return;
      latest.waitingHeartbeatTimer = undefined;
      this.dispatchWaitingHeartbeat(latest);
    }, Math.max(0, run.waitingNextHeartbeatAt - Date.now()));
    heartbeatTimer.unref?.();
    run.waitingHeartbeatTimer = heartbeatTimer;
  }

  private dispatchWaitingHeartbeat(run: ActiveTaskRunState): void {
    const current = this.activeRuns.get(run.sessionName);
    // WAITING can be reported from either the original implementation phase
    // or from post-audit finalization (`dispatchContinue` on a deferred
    // finalization action, e.g. "push and wait for the integration owner").
    // `phase` records *why* the run is parked, not whether the 10-minute
    // heartbeat watchdog still applies -- excluding 'finalizing' here left
    // the recurring reminder permanently silent (armed once, never re-armed)
    // for any run that parks WAITING while finishing delivery after audit
    // PASS, even though the run itself stayed correctly parked.
    if (!current || current.generation !== run.generation
      || (current.phase !== 'execution' && current.phase !== 'finalizing')) return;
    if (!isAutomaticSupervisionEnabled(current.snapshot)) return;
    const now = Date.now();
    if (!current.waitingStartedAt) return;
    const heartbeatPrompt = buildSupervisionWaitingHeartbeatPrompt(current.snapshot, current.snapshot.uiLocale);
    const heartbeatId = `${SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND}:${current.generation}:${now}`;
    current.waitingNextHeartbeatAt = now + SUPERVISION_WAITING_HEARTBEAT_MS;
    current.sawAssistantOutput = false;
    current.lastAssistantText = undefined;
    current.terminalState = undefined;
    // Persist the next due time before dispatch. A crash after delivery must
    // not replay this heartbeat immediately on process restart.
    this.armNextWaitingHeartbeat(current);
    this.persistWaitState(current, 'waiting');

    timelineEmitter.emit(
      current.sessionName,
      'user.message',
      {
        text: heartbeatPrompt,
        clientMessageId: heartbeatId,
        allowDuplicate: true,
        automation: true,
        automationKind: SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND,
        memoryExcluded: true,
      },
      { source: 'daemon', confidence: 'high', eventId: heartbeatId },
    );
    const runtime = getTransportRuntime(current.sessionName);
    if (!runtime) {
      this.emitWarning(current.sessionName, 'The waiting-status heartbeat could not reach the execution session; the original wait deadline remains active.');
      return;
    }
    try {
      runtime.send(heartbeatPrompt, heartbeatId, undefined, undefined, {
        // The automation row above is already the durable, user-visible
        // projection for this logical clientMessageId. If the runtime is busy,
        // its durable FIFO must retain and deliver the heartbeat without
        // projecting a second `transport-user:<clientMessageId>` row when the
        // queue later drains (often several heartbeats at the same timestamp).
        timelineCommitted: true,
      });
      this.emitAutomationNote(
        current.sessionName,
        'Auto: checked the supervised task state; waiting remains active until a real NEEDS_INPUT result.',
        SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND,
      );
    } catch (error) {
      logger.warn({ session: current.sessionName, err: error }, 'Supervision waiting heartbeat dispatch failed');
      this.emitWarning(current.sessionName, 'The waiting-status heartbeat failed; the original wait deadline remains active.');
    }
  }

  private continueFailedAuditTarget(run: ActiveTaskRunState, failedState: string): void {
    const targetName = run.snapshot.auditTargetSessionName;
    const attemptId = run.auditAttemptId;
    const target = targetName ? getSession(targetName) : undefined;
    if (
      !targetName
      || !attemptId
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
    const recoveryPrompt = buildAuditTargetRecoveryPrompt({
      auditedSession: run.sessionName,
      auditTargetSession: targetName,
      attemptId,
      failedState,
      replyInstruction: buildAgentDelegationReplyInstruction(run.sessionName),
      uiLocale: run.snapshot.uiLocale,
    });
    const clientMessageId = `${SUPERVISION_AUDIT_TARGET_RECOVERY_AUTOMATION_KIND}:${attemptId}:${recoveryNumber}`;
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

  private handleTimelineEvent(event: TimelineEvent): void {
    if (this.automaticPeerAuditCompatibilityForTests) {
      this.handleAuditTargetTimelineEvent(event);
    }
    const sequence = ++this.eventSequence;

    if (event.type === 'user.message') {
      const pending = this.pendingTaskIntents.get(event.sessionId);
      const clientMessageId = trimString(event.payload.clientMessageId);
      const commandId = trimString(event.payload.commandId);
      const automation = event.payload.automation === true;
      const queueAppended = event.payload.queueAppended === true;
      const text = trimString(event.payload.text);
      const uiLocale = normalizeSupervisionUiLocale(event.payload.uiLocale);
      const activeRun = this.activeRuns.get(event.sessionId);
      // Structured delegation replies are injected into the origin session as
      // trusted runtime notifications. They are control-plane input, not a new
      // user task. Brain consumes their structured state; automation neither
      // adopts the audit nor injects lifecycle chat around it.
      const delegationCompletionNotification = Boolean(
        !automation && isDelegationCompletionNotificationText(text),
      );
      const delegatedReply = Boolean(
        this.automaticPeerAuditCompatibilityForTests
        && !automation
        && activeRun?.phase === 'auditing'
        && !activeRun.auditDelegationId
        && isDelegatedAuditReplyText(text),
      );
      if (delegatedReply && activeRun) {
        this.clearAuditTargetRecovery(activeRun);
        activeRun.auditReplyObserved = true;
        activeRun.auditVerdictCorrectionAttempts = 0;
        activeRun.auditMarkerWarningEmitted = false;
        activeRun.sawAssistantOutput = false;
        activeRun.lastAssistantText = undefined;
        this.persistWaitState(activeRun, 'auditing');
        this.emitStatus(activeRun.sessionName, 'supervision_audit_waiting', SUPERVISION_AUDIT_WAITING_LABEL);
        this.emitAutomationNote(activeRun.sessionName, 'Auto: the delegated audit reply arrived; waiting for this session to produce the final PASS/REWORK judgment.', 'supervision-audit-reply-received');
      }
      if (!automation && !queueAppended && !delegatedReply && !delegationCompletionNotification && text && !text.startsWith('/')) {
        const liveSnapshot = extractSessionSupervisionSnapshot(getSession(event.sessionId)?.transportConfig ?? null);
        if (isAutomaticSupervisionEnabled(liveSnapshot)) {
          this.heartbeatPausedForNeedsInput.delete(event.sessionId);
        }
        this.clearImplicitCompletionGrace(event.sessionId);
        this.recoverySuppressedUntilNextUser.delete(event.sessionId);
        if (!isBareSupervisionContinueText(text)) {
          this.recentTaskCandidates.set(event.sessionId, {
            commandId: clientMessageId ?? `implicit:${Date.now()}`,
            text,
            sequence,
            ...(uiLocale ? { uiLocale } : {}),
          });
        }
      }
      if (pending
        && !automation
        && !queueAppended
        && (clientMessageId === pending.commandId || commandId === pending.commandId)) {
        this.pendingTaskIntents.delete(event.sessionId);
        this.registerTaskIntent(event.sessionId, pending.commandId, pending.text, pending.snapshot);
      }
    }

    if (event.type === 'assistant.text' && this.isEligibleAssistantCompletionPayload(event.payload)) {
      // `payload.text` is the trusted assistant-authored boundary. Delegation
      // claims and other host-rendered dispatch metadata remain sibling fields;
      // never concatenate them into marker authority.
      const text = typeof event.payload.text === 'string' ? event.payload.text : '';
      const completionKey = this.timelineCompletionKey(event.sessionId, event);
      this.latestAssistantTexts.set(event.sessionId, { text, sequence, completionKey });
      const run = this.activeRuns.get(event.sessionId);
      if (!run) {
        // Only an observed idle edge proves this is the late-final-row race.
        // The persisted store often still says idle while a newly-started turn
        // is already streaming, so consulting it here starts evaluation early.
        if (this.lastObservedSessionStates.get(event.sessionId) === 'idle') {
          const record = getSession(event.sessionId);
          const snapshot = record?.agentType
            ? extractSessionSupervisionSnapshot(record.transportConfig ?? null)
            : null;
          if (isAutomaticSupervisionEnabled(snapshot)) {
            this.clearImplicitCompletionGrace(event.sessionId);
            if (!this.tryStartImplicitRun(event.sessionId, snapshot)) {
              this.tryRecoverImplicitRunFromTimeline(event.sessionId, snapshot);
            }
          }
        }
        return;
      }
      this.clearCompletionGrace(run);
      run.ignoreIdleUntilPostAuditTurnActivity = false;
      run.lastAssistantText = text;
      run.lastAssistantCompletionKey = completionKey;
      run.sawAssistantOutput = true;
      if (run.phase === 'execution' && run.waitingStartedAt !== undefined) {
        run.waitingEvaluationPending = true;
        this.persistWaitState(run, 'waiting');
      } else if (run.phase === 'auditing' && run.auditReplyObserved) {
        this.persistWaitState(run, 'auditing');
      }
      if ((run.phase === 'execution' || run.phase === 'finalizing') && !run.evaluating) {
        if (this.lastObservedSessionStates.get(event.sessionId) === 'idle') {
          this.evaluateIdleRun(run);
        } else {
          // The final row landed while the cached state is still non-idle. The
          // completion grace is otherwise only armed on an observed idle edge,
          // so a runtime that stops without emitting that edge would leave this
          // run with no watchdog at all and supervision would never look at it
          // again. Arm one here; it re-arms and reconciles the stale
          // observation against the store.
          this.armCompletionGrace(run);
        }
      }
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
          // A provider may finalize several assistant text blocks inside one
          // tool-using turn. Those blocks all have `streaming:false`, but only
          // the trailing idle (or an already-idle retained runtime) proves the
          // orchestrator has finished its audit judgment. Treating every block
          // as final produced one identical marker warning per tool round.
          // An exact marker/anchored verdict is itself a terminal boundary by
          // contract, so it can still settle retained transports that omit the
          // trailing idle event entirely.
          const hasVerdict = latest.lastAssistantText
            ? parseDeliveredAuditVerdict(latest.lastAssistantText) !== null
            : false;
          if (!hasVerdict
            && (!this.isSessionIdle(event.sessionId) || this.transportRuntimeIsWorking(event.sessionId))) return;
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
        if (candidate && isAutomaticSupervisionEnabled(snapshot)) {
          if (!this.tryStartImplicitRun(event.sessionId, snapshot)) {
            this.armImplicitCompletionGrace(event.sessionId, snapshot, candidate);
          }
        } else if (isAutomaticSupervisionEnabled(snapshot)) {
          this.tryRecoverImplicitRunFromTimeline(event.sessionId, snapshot);
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
      // A delayed/reordered non-idle projection must not kill the only
      // watchdog this run has. Clear it only when the runtime confirms work is
      // actually in flight; otherwise a stale `running` row silently wedges the
      // run -- the exact reordering this code exists to tolerate.
      // Once the final assistant row has landed, NOTHING may revoke this run's
      // watchdog -- not even diagnostics-backed activity. Clearing it here left
      // no mechanism to observe the runtime going quiet again, so a provider
      // that stopped without a trailing idle wedged the run forever. Genuine
      // activity is already handled inside the timer callback, which resets the
      // wait window and re-arms. Clearing is only safe before a final row,
      // where it exists to rebase the grace onto a newly started turn.
      if (state && state !== 'idle' && !run.sawAssistantOutput) {
        this.clearCompletionGrace(run);
        run.ignoreIdleUntilPostAuditTurnActivity = false;
      } else if (state && state !== 'idle') {
        run.ignoreIdleUntilPostAuditTurnActivity = false;
      }
      // The session is alive again, so the outage that was recovered is over.
      // Forgetting it here is what lets a genuinely NEW outage later recover
      // again -- still bounded by the durable restart budget, which is never
      // reset by this.
      if (state && state !== 'stopped' && state !== 'error') {
        run.recoveredAuthorityOutage = undefined;
        // Cancel the retry armed for an outage that is now OVER. Leaving it
        // pending means a recovered, healthy run is later torn down by its own
        // stale timer -- the retry exists to rescue the run, never to kill it.
        if (run.authorityRecoveryTimer) {
          clearTimeout(run.authorityRecoveryTimer);
          run.authorityRecoveryTimer = undefined;
        }
      }
      if (state === 'idle' && (run.phase === 'execution' || run.phase === 'finalizing') && !run.evaluating) {
        if (!run.sawAssistantOutput) {
          if (run.ignoreIdleUntilPostAuditTurnActivity) {
            run.ignoreIdleUntilPostAuditTurnActivity = false;
            return;
          }
          this.armCompletionGrace(run);
          return;
        }
        this.evaluateIdleRun(run);
      }
      if ((state === 'stopped' || state === 'error') && run.phase === 'execution') {
        // A precisely-typed, transient authority outage is not a blocked task.
        if (this.tryRecoverAuthorityOutage(run)) return;
        this.emitTerminalStatus(run.sessionName, 'supervision_blocked', SUPERVISION_BLOCKED_LABEL);
        this.emitWarning(run.sessionName, 'Supervision stopped because the session entered a blocked state.');
        this.finishRun(run.sessionName, 'blocked', { preserveStatus: true });
      }
      if (state === 'idle' && run.phase === 'auditing' && run.auditReplyObserved && run.sawAssistantOutput) {
        this.handleOrchestratedAuditCompletion(run);
      }
    }
  }

  /**
   * Recover the SAME run from a transient authority-catalog/MCP outage.
   *
   * Observed live: a Brain turn threw
   * `ImcodesDelegationUnavailableError('authoritative IM delegation unavailable')`,
   * the session went stopped/error, and the caller below treated ANY
   * stopped/error in execution as terminal -- so it emitted
   * `supervision_blocked` and finished the run. The task was wedged for good
   * even though the outage is transient and the session is rehydratable.
   *
   * Deliberately narrow. Only this exact, opaque-by-design message recovers;
   * every other stopped/error reason (and anything without a session record)
   * still falls through to the terminal path, so an unknown crash is never
   * silently restarted.
   *
   * The budget is the session's OWN durable restart window -- the same
   * `restartTimestamps` / MAX_RESTARTS / RESTART_WINDOW_MS loop prevention the
   * session manager already enforces, persisted in the session store. Reusing
   * it means the budget survives a daemon restart instead of resetting into an
   * infinite recovery loop, and there is no second definition to drift.
   * Rehydration itself is `ensureTransportRuntimeAvailable`, which de-duplicates
   * concurrent recoveries, so repeated state edges cannot start it twice.
   */
  private tryRecoverAuthorityOutage(run: ActiveTaskRunState): boolean {
    const record = getSession(run.sessionName);
    if (!record) return false;
    const outage = record.error?.trim();
    if (!isRecoverableAuthorityOutage(outage)) return false;
    // Already recovered from THIS outage. Providers re-emit the same terminal
    // state edge freely (duplicate, reordered, or replayed on reconnect), and
    // each replay would otherwise burn another restart from a 3-restart durable
    // budget and re-deliver the turn again. Suppress the terminal path -- the
    // run is legitimately mid-recovery -- but spend nothing.
    if (run.recoveredAuthorityOutage === outage) return true;
    const now = Date.now();
    const recent = (record.restartTimestamps ?? []).filter((at) => at > now - RESTART_WINDOW_MS);
    if (recent.length >= MAX_RESTARTS) return false;
    run.recoveredAuthorityOutage = outage;
    upsertSession({ ...record, restartTimestamps: [...recent, now], updatedAt: now });
    this.emitAutomationNote(
      run.sessionName,
      '⏳ Auto: the authority catalog is momentarily unavailable; rehydrating this session and continuing the same task.',
      'supervision-authority-recovery',
    );
    void ensureTransportRuntimeAvailable(run.sessionName)
      .then(() => {
        this.redeliverAuthorityOutageTurn(run, outage);
      })
      .catch(() => {
        // Rehydration itself failed. Same rule as the other failure branches:
        // this is not a completed recovery, so it must become a daemon-driven
        // retry rather than a marker left behind for an edge that may never come.
        const current = this.activeRuns.get(run.sessionName);
        if (current && current.generation === run.generation && current.recoveredAuthorityOutage === outage) {
          this.disarmAuthorityOutage(current, 'the session could not be rehydrated');
        }
      });
    return true;
  }

  /**
   * Re-deliver the exact turn the outage consumed.
   *
   * Rebuilding the transport is only half a recovery: the failed turn produced
   * no result and no reply, so without this the run waits for a state edge that
   * a session which died mid-turn may never emit. Re-sending `run.userText` on
   * the SAME session resumes the same task and assignment -- it does not open a
   * new one, and it does not degrade into a generic "continue" that would throw
   * away what was actually asked for.
   */
  private redeliverAuthorityOutageTurn(run: ActiveTaskRunState, outage: string): void {
    const current = this.activeRuns.get(run.sessionName);
    // The run may have been finished, superseded, or moved on while the
    // rehydration promise was in flight. Re-delivering then would inject a
    // stale turn into whatever is running now.
    if (!current || current.generation !== run.generation || current.phase !== 'execution') return;
    if (current.recoveredAuthorityOutage !== outage) return;
    const runtime = getTransportRuntime(run.sessionName);
    if (!runtime) {
      // Rehydration reported success but there is still nothing to deliver into.
      // Leaving the marker armed here is what wedged the run: every later
      // identical error edge matched it, returned "handled", and so spent no
      // budget, retried nothing, and never went terminal -- the task sat in
      // `execution` for ever. Disarm so the NEXT edge re-enters the budgeted
      // path, which either succeeds or exhausts the budget and fails closed.
      this.disarmAuthorityOutage(current, 'no runtime to resume into');
      return;
    }
    const clientMessageId = `supervision-authority-recovery:${run.commandId}:${run.generation}`;
    try {
      runtime.send(run.userText, clientMessageId, undefined, undefined, {
        deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      });
    } catch (error) {
      logger.warn({ session: run.sessionName, err: error }, 'Supervision authority-outage turn redelivery failed');
      // Same reasoning: a turn that was never delivered is not a recovery, so
      // this must stay retryable instead of silently absorbing every later edge.
      this.disarmAuthorityOutage(current, 'the interrupted turn could not be re-delivered');
    }
  }

  /**
   * Mark a recovery attempt as NOT completed, so the next identical error edge
   * re-enters `tryRecoverAuthorityOutage` and spends real budget. The durable
   * restart window is never reset here -- that is what guarantees the retries
   * terminate and the run eventually fails closed rather than looping.
   */
  private disarmAuthorityOutage(run: ActiveTaskRunState, reason: string): void {
    // No outage-identity re-check here: the only caller already compared it and
    // nothing can interleave between that check and this call, so a guard here
    // would be a branch no test could ever distinguish.
    run.recoveredAuthorityOutage = undefined;
    this.emitWarning(
      run.sessionName,
      `The session was rehydrated after an authority outage, but ${reason}; supervision will retry within its restart budget.`,
    );
    this.scheduleAuthorityOutageRetry(run);
  }

  /**
   * Own the retry instead of waiting for the provider to speak again.
   *
   * Disarming the marker alone only made the run retryable BY THE NEXT ERROR
   * EDGE, and a session that died mid-turn may never emit another one -- so a
   * single failed recovery left the run parked in `execution` for ever: no
   * retry, no budget consumed, never terminal. The daemon therefore schedules
   * the next attempt itself.
   *
   * Bounded by construction: one pending timer per run, and each attempt goes
   * through `tryRecoverAuthorityOutage`, which spends the session's OWN durable
   * restart window. When that budget is exhausted the attempt returns false and
   * this fails the run closed, so the retries terminate rather than looping.
   */
  private scheduleAuthorityOutageRetry(run: ActiveTaskRunState): void {
    if (run.authorityRecoveryTimer) return;
    const timer = setTimeout(() => {
      run.authorityRecoveryTimer = undefined;
      const current = this.activeRuns.get(run.sessionName);
      // Finished, superseded, or moved on while the retry was pending.
      if (!current || current.generation !== run.generation || current.phase !== 'execution') return;
      if (this.tryRecoverAuthorityOutage(current)) return;
      // `tryRecoverAuthorityOutage` returns false for TWO very different
      // reasons, and conflating them is what let a healthy run be killed by the
      // timer armed for an outage it had already survived:
      //   * the session is no longer in that exact authoritative outage -- it
      //     recovered, or failed for some other reason that is not ours to
      //     judge from a stale timer. Exit silently; the live handler owns it.
      //   * the outage is STILL exactly this one and the durable budget is
      //     spent. Only THAT is a genuine terminal case.
      const record = getSession(current.sessionName);
      if (!isRecoverableAuthorityOutage(record?.error)) return;
      const now = Date.now();
      const spent = (record?.restartTimestamps ?? []).filter((at) => at > now - RESTART_WINDOW_MS);
      if (spent.length < MAX_RESTARTS) return;
      this.emitTerminalStatus(current.sessionName, 'supervision_blocked', SUPERVISION_BLOCKED_LABEL);
      this.emitWarning(current.sessionName, 'Supervision stopped after the authority outage could not be recovered within its restart budget.');
      this.finishRun(current.sessionName, 'blocked', { preserveStatus: true });
    }, AUTHORITY_RECOVERY_RETRY_MS);
    timer.unref?.();
    run.authorityRecoveryTimer = timer;
  }

  private async evaluateExecutionTurn(run: ActiveTaskRunState): Promise<void> {
    const current = this.activeRuns.get(run.sessionName);
    if (!current || current.generation !== run.generation || (current.phase !== 'execution' && current.phase !== 'finalizing')) return;
    const evaluatedPhase = current.phase;

    // Disarm the park BEFORE awaiting the broker. The awaited reply has already
    // produced this turn, so the run is no longer parked; leaving the timer
    // armed across the await lets it fire mid-decision, finish the run, and
    // silently discard the very verdict it was waiting for.
    this.clearWaitingTimers(current, { preserveWindow: true });

    // Normal execution turns carry one exact, prefixed status marker. Trusting
    // that small protocol avoids a supervisor-model call on every step; absent
    // or conflicting markers deliberately fall through to the broker.
    const executionStatus = parseSupervisionExecutionStateDetailsFromText(current.lastAssistantText ?? '');
    if (executionStatus.state) {
      current.evaluating = false;
      this.clearStatus(run.sessionName);
      await this.handleExecutionStatus(current, executionStatus.state);
      return;
    }

    const record = getSession(run.sessionName);
    let brokerDecision;
    try {
      brokerDecision = await supervisionBroker.decide({
        snapshot: enrichSnapshotWithGlobalDefaults(current.snapshot),
        targetSessionId: record?.sessionInstanceId ?? run.sessionName,
        taskRequest: current.userText,
        assistantResponse: current.lastAssistantText,
        recentEvidence: collectRecentSupervisionEvidence(current.sessionName),
        cwd: record?.projectDir,
        description: record?.description,
      });
    } finally {
      const statusOwner = this.activeRuns.get(run.sessionName);
      if (statusOwner?.generation === run.generation) this.clearStatus(run.sessionName);
    }

    const latest = this.activeRuns.get(run.sessionName);
    if (!latest || latest.generation !== run.generation || latest.phase !== evaluatedPhase) return;
    latest.evaluating = false;
    // A new evaluation means the park (if any) is over; the branch below
    // re-arms it when the decision is still `waiting`.
    this.clearWaitingTimers(latest, { preserveWindow: true });
    const reportedAuditPass = !latest.freshAuditRequiredAfterRework
      && parseExplicitAuditVerdict(latest.lastAssistantText ?? '') === 'PASS';
    const deterministicAuditRequired = latest.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
      && turnHasDeterministicAuditEvidence(latest.userText, latest.lastAssistantText);
    latest.requiresAudit = latest.freshAuditRequiredAfterRework
      || (!reportedAuditPass && (brokerDecision.requiresAudit !== false || deterministicAuditRequired));
    // A rework round re-opens the full surface: the previous verdict already
    // said the narrow read was not enough.
    latest.auditDepth = latest.freshAuditRequiredAfterRework ? 'standard' : brokerDecision.auditDepth ?? 'standard';
    const assistantReportsPendingPreAuditWork = latest.phase === 'execution'
      && latest.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
      && PENDING_PRE_AUDIT_WORK_RE.test(latest.lastAssistantText ?? '');

    const decision: SupervisionDecision = brokerDecision.decision === 'complete' && assistantReportsPendingPreAuditWork
      ? {
        ...brokerDecision,
        decision: 'continue',
        reason: 'The latest result explicitly identifies unfinished task work; the supervisor completion judgment may be stale.',
        gap: 'Reconcile the unfinished work from the current session context before peer audit.',
        nextAction: PRE_AUDIT_SELF_RECONCILIATION_ACTION,
        requiresAudit: true,
      }
      : brokerDecision;

    if (brokerDecision.decision === 'complete' && assistantReportsPendingPreAuditWork) {
      // The broker sees a bounded snapshot and can mistake a passing sub-check
      // for completion of the larger task. The executing session's explicit
      // unfinished-work report is the stronger progress signal. Keep the run in
      // execution and ask it to reconcile/advance what it actually knows rather
      // than starting an audit of an incomplete revision.
      latest.requiresAudit = true;
    }

    switch (decision.decision) {
      case 'complete': {
        latest.terminalState = 'complete';
        if (latest.phase === 'finalizing') {
          this.emitAutomationNote(run.sessionName, 'Auto: peer audit passed and post-audit finalization completed.', 'supervision-post-audit-complete');
          this.emitTerminalStatus(run.sessionName, 'supervision_complete', SUPERVISION_COMPLETE_LABEL);
          this.finishRun(run.sessionName, 'complete', { preserveStatus: true });
        } else if (
          latest.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
          && latest.requiresAudit
        ) {
          await this.continueBrainOwnedLifecycle(latest);
        } else {
          const auditSkipped = latest.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
            && !latest.requiresAudit;
          this.emitAutomationNote(
            run.sessionName,
            this.automaticPeerAuditCompatibilityForTests && auditSkipped
              ? 'Auto: task looks complete; the supervisor determined that no new peer audit is needed.'
              : 'Auto: task looks complete.',
            this.automaticPeerAuditCompatibilityForTests && auditSkipped
              ? 'supervision-audit-skipped'
              : 'supervision-complete',
          );
          this.emitTerminalStatus(run.sessionName, 'supervision_complete', SUPERVISION_COMPLETE_LABEL);
          this.finishRun(run.sessionName, 'complete', { preserveStatus: true });
        }
        return;
      }
      case 'continue': {
        const continueText = [decision.nextAction, decision.gap, decision.reason, latest.lastAssistantText]
          .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
          .join(' ');
        if (
          latest.phase === 'execution'
          && latest.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
          && !reportedAuditPass
          && NEW_AUDIT_DELEGATION_RE.test(continueText)
          && !FORBIDS_NEW_AUDIT_RE.test(continueText)
        ) {
          // Audit routing belongs to Brain, never to daemon automation.
          // Normalize model drift into the same bounded coordinator heartbeat
          // used for every other unfinished lifecycle decision.
          this.deferRepositoryFinalizationIfPresent(latest, decision, continueText);
          latest.terminalState = 'complete';
          await this.continueBrainOwnedLifecycle(latest);
          return;
        }
        // A completed turn can already contain a clearly stated independent
        // audit PASS (for example an agent-native subagent review followed by
        // commit/push). If the supervisor then asks only to dispatch that same
        // audit again, deterministically close the duplicate loop. This does
        // not bypass a REWORK gate and does not suppress concrete remaining
        // implementation/validation work.
        if (reportedAuditPass && requestsOnlyRedundantAudit(decision)) {
          if (this.automaticPeerAuditCompatibilityForTests) {
            this.emitAutomationNote(
              run.sessionName,
              'Auto: the completed turn already reports an independent audit PASS; skipped the duplicate audit request.',
              'supervision-audit-already-passed',
            );
          }
          this.emitTerminalStatus(run.sessionName, 'supervision_complete', SUPERVISION_COMPLETE_LABEL);
          this.finishRun(run.sessionName, 'complete', { preserveStatus: true });
          return;
        }
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
          await this.continueBrainOwnedLifecycle(latest);
          return;
        }
        // Forward the full decision so the continue prompt can lead with
        // the supervisor's concrete nextAction. Without this, the target
        // agent only sees the reason and has to infer what to do next —
        // which historically caused the "rewrite same answer" loop.
        const guardsPreAuditFinalization = latest.phase === 'execution'
          && latest.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
          && hasRepositoryFinalizationAction(decision);
        const guardedNextAction = guardsPreAuditFinalization
          ? PRE_AUDIT_SELF_RECONCILIATION_ACTION
          : decision.nextAction;
        const guardedReason = guardsPreAuditFinalization && assistantReportsPendingPreAuditWork
          ? 'The latest result explicitly identifies unfinished task work. Treat the supervisor finalization hint as advisory, reconcile the real progress from current context, and continue only safe actionable work.'
          : decision.reason;
        const guardedGap = guardsPreAuditFinalization && assistantReportsPendingPreAuditWork
          ? undefined
          : decision.gap;
        await this.dispatchContinueWithinLimits(latest, {
          reason: guardedReason,
          nextAction: guardedNextAction,
          gap: guardedGap,
        });
        return;
      }
      case 'waiting': {
        const waitingText = [decision.reason, decision.gap, latest.lastAssistantText]
          .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
          .join(' ');
        const waitingForUndispatchedAudit = latest.phase === 'execution'
          && latest.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT
          && WAITING_FOR_PEER_AUDIT_RE.test(waitingText);
        if (waitingForUndispatchedAudit) {
          // The model inferred that an external lifecycle action is pending,
          // but daemon automation must not manufacture it. Wake Brain through
          // the bounded coordinator heartbeat instead of parking forever or
          // contacting an auditor itself.
          this.deferRepositoryFinalizationIfPresent(latest, decision, waitingText);
          latest.terminalState = 'complete';
          await this.continueBrainOwnedLifecycle(latest);
          return;
        }
        // Park: no continue contract, no finishRun. The run stays alive so the
        // next assistant turn — which happens when the awaited reply arrives —
        // re-enters evaluation naturally. Re-prompting here is exactly the loop
        // this decision exists to break.
        this.emitStatus(latest.sessionName, 'supervision_parked', SUPERVISION_PARKED_LABEL);
        this.emitAutomationNote(
          latest.sessionName,
          `Auto: parked while waiting — ${decision.reason}`,
          'supervision-parked',
        );
        this.clearCompletionGrace(latest);
        latest.ignoreIdleUntilPostAuditTurnActivity = true;
        latest.waitingEvaluationPending = false;
        latest.sawAssistantOutput = false;
        latest.lastAssistantText = undefined;
        latest.lastAssistantCompletionKey = undefined;
        this.armWaitingTimers(latest, { preserveSchedule: true });
        return;
      }
      case 'ask_human':
      default: {
        // Automatic supervision is the Brain main session's only mechanism for
        // driving a task whose work lives in child sessions. Ending the run
        // means nothing wakes up to read the task registry again, so only a
        // condition a human must personally clear may stop it. Everything else
        // — a decision timeout, a throttled or briefly unreachable supervisor,
        // an unparseable answer — comes back on the next scheduled heartbeat.
        const outcome = classifySupervisionInterruption({
          unavailableReason: decision.unavailableReason,
          providerFailureCode: decision.providerFailure?.code,
        });
        if (outcome.kind === 'resume') {
          const retryText = formatUnavailableReason(
            decision.unavailableReason,
            decision.providerFailure,
            decision.reason,
            { backend: run.snapshot.backend, model: run.snapshot.model },
            SUPERVISION_RETRY_CONTINUATION_SENTENCE,
          );
          // Park exactly the way the waiting decision parks: same durable
          // timer, no re-prompt, no poll loop. The next heartbeat re-enters
          // evaluation on its own.
          this.emitStatus(latest.sessionName, 'supervision_parked', SUPERVISION_PARKED_LABEL);
          this.emitAutomationNote(
            latest.sessionName,
            retryText ?? `Automation deferred the supervisor decision: ${decision.reason}. ${SUPERVISION_RETRY_CONTINUATION_SENTENCE}`,
            SUPERVISION_SUPERVISOR_RETRY_AUTOMATION_KIND,
          );
          this.clearCompletionGrace(latest);
          latest.waitingEvaluationPending = false;
          latest.sawAssistantOutput = false;
          latest.lastAssistantText = undefined;
          latest.lastAssistantCompletionKey = undefined;
          this.armWaitingTimers(latest, { preserveSchedule: true });
          return;
        }
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

  private async handleExecutionStatus(
    run: ActiveTaskRunState,
    state: SupervisionExecutionState,
  ): Promise<void> {
    const current = this.activeRuns.get(run.sessionName);
    if (!current || current.generation !== run.generation) return;

    switch (state) {
      case 'advance':
        await this.dispatchContinueWithinLimits(current, {
          reason: 'The execution status reports safe unfinished work.',
          nextAction: current.phase === 'finalizing'
            ? POST_AUDIT_REPOSITORY_FINALIZATION_ACTION
            : 'Advance the safest unfinished task-owned work from current context now.',
        });
        return;
      case 'audit_ready':
        current.terminalState = 'complete';
        if (current.phase === 'finalizing') {
          this.emitAutomationNote(current.sessionName, 'Auto: audited finalization completed.', 'supervision-post-audit-complete');
          this.emitTerminalStatus(current.sessionName, 'supervision_complete', SUPERVISION_COMPLETE_LABEL);
          this.finishRun(current.sessionName, 'complete', { preserveStatus: true });
        } else if (current.snapshot.mode === SUPERVISION_MODE.SUPERVISED_AUDIT) {
          current.requiresAudit = true;
          current.auditDepth = current.freshAuditRequiredAfterRework ? 'standard' : current.auditDepth ?? 'standard';
          await this.continueBrainOwnedLifecycle(current);
        } else if (hasExplicitRepositoryFinalizationRequirement([
          current.userText,
          resolveSupervisionCustomInstructionsDetail(
            enrichSnapshotWithGlobalDefaults(current.snapshot),
          ).text,
        ].filter(Boolean).join('\n'))) {
          current.terminalState = undefined;
          await this.dispatchContinueWithinLimits(current, {
            reason: 'Implementation and validation are complete; explicit delivery work remains.',
            nextAction: SUPERVISED_REPOSITORY_FINALIZATION_ACTION,
          });
        } else {
          this.emitAutomationNote(current.sessionName, 'Auto: task reported implementation and validation complete.', 'supervision-complete');
          this.emitTerminalStatus(current.sessionName, 'supervision_complete', SUPERVISION_COMPLETE_LABEL);
          this.finishRun(current.sessionName, 'complete', { preserveStatus: true });
        }
        return;
      case 'needs_input':
        this.emitTerminalStatus(current.sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
        this.emitWarning(current.sessionName, 'Automation returned control because the executing session reported a human-input blocker.');
        this.finishRun(current.sessionName, 'needs_input', { preserveStatus: true });
        return;
      case 'waiting':
        this.emitStatus(current.sessionName, 'supervision_parked', SUPERVISION_PARKED_LABEL);
        this.emitAutomationNote(current.sessionName, 'Auto: parked on the executing session\'s reported external reply.', 'supervision-parked');
        this.clearCompletionGrace(current);
        current.ignoreIdleUntilPostAuditTurnActivity = true;
        current.waitingEvaluationPending = false;
        current.sawAssistantOutput = false;
        current.lastAssistantText = undefined;
        current.lastAssistantCompletionKey = undefined;
        this.armWaitingTimers(current, { preserveSchedule: true });
        return;
    }
  }

  private async dispatchContinueWithinLimits(
    run: ActiveTaskRunState,
    decision: { reason: string; nextAction?: string; gap?: string },
  ): Promise<void> {
    const current = this.activeRuns.get(run.sessionName);
    if (!current || current.generation !== run.generation) return;
    const continueBucket = classifyContinueBucket(decision);
    const nextStreakCount = current.lastContinueBucket === continueBucket
      ? current.continueStreakCount + 1
      : 1;
    const maxAutoContinueStreak = current.snapshot.maxAutoContinueStreak ?? SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_STREAK;
    const maxAutoContinueTotal = current.snapshot.maxAutoContinueTotal ?? SUPERVISION_DEFAULT_MAX_AUTO_CONTINUE_TOTAL;

    if (maxAutoContinueStreak > 0 && nextStreakCount > maxAutoContinueStreak) {
      this.emitWarning(current.sessionName, `Automation reached the repeated auto-continue limit (${maxAutoContinueStreak}) for ${continueBucket}; handing control back to the human.`);
      this.finishRun(current.sessionName, 'needs_input');
      return;
    }
    if (maxAutoContinueTotal > 0 && current.continueLoops >= maxAutoContinueTotal) {
      this.emitWarning(current.sessionName, `Automation reached the auto-continue hard limit (${maxAutoContinueTotal}); handing control back to the human.`);
      this.finishRun(current.sessionName, 'needs_input');
      return;
    }
    current.lastContinueBucket = continueBucket;
    current.continueStreakCount = nextStreakCount;
    await this.dispatchContinue(current, decision);
  }

  /**
   * Audit selection, verdict interpretation, REWORK routing and integration
   * are Brain responsibilities. Automation may only keep Brain moving through
   * the existing de-duplicated/rate-limited continue channel.
   */
  private async continueBrainOwnedLifecycle(run: ActiveTaskRunState): Promise<void> {
    const current = this.activeRuns.get(run.sessionName);
    if (!current || current.generation !== run.generation || current.phase !== 'execution') return;
    if (this.automaticPeerAuditCompatibilityForTests) {
      await this.startAudit(current);
      return;
    }
    current.requiresAudit = false;
    current.terminalState = undefined;
    await this.dispatchContinueWithinLimits(current, {
      reason: 'A coordinator-owned lifecycle decision remains after the completed work.',
      nextAction: 'Review the structured task classification and state. For integration_slice, validate/freeze/handoff without audit; for incomplete integration_task, merge and validate all slice manifests first; only then dispatch one audit for the exact combined revision.',
    });
  }

  /**
   * End a run that has no usable audit route.
   *
   * One method for BOTH the missing-route and ineligible-route paths, because
   * they must end identically: invalid_configuration, a visible warning, and a
   * TERMINAL needs-input status. finishRun() clears the status unless told
   * otherwise, so without preserveStatus the run would end at status:null and
   * look indistinguishable from a clean finish. The diagnostic differs; the
   * terminal semantics must not.
   */
  private failUnroutableAudit(current: ActiveTaskRunState, warning: string): void {
    this.emitOrchestratedAuditResult(current, 'invalid_configuration', 'invalid_configuration');
    this.emitWarning(current.sessionName, warning);
    this.emitTerminalStatus(current.sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
    this.finishRun(current.sessionName, 'needs_input', { preserveStatus: true });
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
    this.clearWaitingTimers(run);
    this.clearCompletionGrace(run);
    this.clearImplicitCompletionGrace(sessionName);
    this.deletePersistedWaitState(sessionName);
    run.terminalState = state;
    if (state === 'needs_input') this.heartbeatPausedForNeedsInput.add(sessionName);
    this.activeRuns.delete(sessionName);
    if (!options.preserveStatus) this.clearStatus(sessionName);
  }

  private async startAudit(run: ActiveTaskRunState): Promise<void> {
    if (run.phase !== 'execution' || this.activeRuns.get(run.sessionName)?.generation !== run.generation) return;
    this.clearWaitingTimers(run);
    this.deletePersistedWaitState(run.sessionName);
    // Daemon-owned audits can start directly from a `complete` broker decision,
    // bypassing the `continue` branch that normally captures held repository
    // finalization. Record only explicit task/rule requirements here so PASS
    // always resumes required commit/push work while ordinary audited tasks
    // still terminate without an invented finalization turn.
    this.deferExplicitPostAuditWork(run);
    // Keep the evaluation reservation across the asynchronous baseline scan.
    // Clearing it before walking OpenSpec files lets a repeated idle boundary
    // start a second evaluation and eventually dispatch a duplicate audit.
    // The visible phase remains execution until the handoff is ready, so an
    // `auditing` phase always means the addressed prompt has been emitted.
    run.evaluating = true;

    const baseline = await resolveAuditBaseline(run.sessionName, run);
    const current = this.activeRuns.get(run.sessionName);
    if (
      !current
      || current.generation !== run.generation
      || current.phase !== 'execution'
    ) return;

    current.phase = 'auditing';
    current.requiresAudit = false;
    current.evaluating = false;
    current.auditReplyObserved = false;
    current.auditVerdictCorrectionAttempts = 0;
    current.auditMarkerWarningEmitted = false;
    current.auditAttemptId = randomUUID();
    current.auditDelegationId = undefined;
    current.auditStartedAt = Date.now();
    current.auditDeadlineAt = undefined;
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
    const latestSnapshot = current.hasLiveSnapshotUpdate
      ? current.snapshot
      : authoritativeSnapshot && current.snapshot.uiLocale
        ? { ...authoritativeSnapshot, uiLocale: current.snapshot.uiLocale }
        : authoritativeSnapshot;
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
      this.failUnroutableAudit(current, 'Automation peer audit could not resolve the current session or configured auditor. Manual review is required.');
      return;
    }

    // ELIGIBILITY, not just existence. The check above only proves the target
    // record and runtime exist; a stopped session, an execution clone, a
    // non-direct child, or one lacking the reply-capable runtime contract would sail
    // past it and then get a 15-minute audit deadline armed against it.
    //
    // This calls the SAME authoritative validator the send tool uses. A second
    // approximate rule set here is precisely how a route one boundary refuses
    // becomes one the other accepts.
    const route = validateBrainAuditRoute({
      auditedSessionName: current.sessionName,
      targetName,
      allSessions: listSessions(),
    });
    if (!route.ok) {
      logger.warn({
        session: current.sessionName,
        targetName,
        refusal: route.refusal,
      }, 'Automatic audit preflight refused the configured route');
      this.failUnroutableAudit(
        current,
        `Automation peer audit cannot use the configured auditor: ${route.detail}. Manual review is required.`,
      );
      return;
    }

    current.auditTargetSessionInstanceId = target.sessionInstanceId;

    const auditTask = buildAutomaticAuditTaskPrompt({
      attemptId: current.auditAttemptId,
      targetSession: targetName,
      // The audited session is the one whose work this attempt reviews --
      // never the auditor (targetName) and never the dispatching Brain.
      auditedSessionName: current.sessionName,
      narrow: current.auditDepth === 'narrow',
      ...(baseline.changeDir ? { changeDir: baseline.changeDir } : {}),
      changedPaths: baseline.fileContents.map((entry) => entry.path),
      uiLocale: current.snapshot.uiLocale,
    });
    const orchestrationPrompt = buildAgentDelegationOrchestrationPrompt({
      targetSession: targetName,
      targetLabel: target.label,
      task: auditTask,
      uiLocale: current.snapshot.uiLocale,
    });
    // Persist the exact owner/auditor identities, attempt and original
    // deadline before dispatch. A daemon crash immediately after provider
    // admission must restore this same audit instead of issuing a duplicate.
    this.armAuditDeadline(current);
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
  }

  private armAuditDeadline(
    run: ActiveTaskRunState,
    options: { preserveDeadline?: boolean } = {},
  ): void {
    this.clearAuditDeadline(run);
    const now = Date.now();
    run.auditStartedAt ??= now;
    if (!options.preserveDeadline || run.auditDeadlineAt === undefined) {
      run.auditDeadlineAt = now + PEER_AUDIT_DEADLINE_MS;
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
      ) return;
      this.emitOrchestratedAuditResult(latest, 'timeout', 'deadline_expired');
      this.emitTerminalStatus(latest.sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
      this.finishRun(latest.sessionName, 'needs_input', { preserveStatus: true });
    }, Math.max(0, run.auditDeadlineAt - now));
    timer.unref?.();
    run.auditDeadlineTimer = timer;
    this.persistWaitState(run, 'auditing');
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
    if (!this.rememberEmittedAuditResultAttempt(run.auditAttemptId)) return;
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
    const verdict = parseDeliveredAuditVerdict(current.lastAssistantText);
    if (!verdict) {
      if (this.requestAuditVerdictCorrection(current)) return;
      if (!current.auditMarkerWarningEmitted) {
        current.auditMarkerWarningEmitted = true;
        this.emitWarning(current.sessionName, 'The delegated audit reply arrived, but the current session still did not report exactly one PASS/REWORK audit marker after an automatic correction attempt. Waiting until the audit deadline.');
      }
      return;
    }
    this.clearAuditDeadline(current);
    this.clearAuditTargetRecovery(current);
    this.clearStatus(current.sessionName);
    const findings = current.lastAssistantText;
    if (verdict === 'PASS') {
      this.emitOrchestratedAuditResult(current, 'pass', undefined, findings);
      current.auditAttemptId = undefined;
      current.auditDelegationId = undefined;
      current.freshAuditRequiredAfterRework = false;
      if (current.deferredFinalization) {
        current.phase = 'finalizing';
        current.ignoreIdleUntilPostAuditTurnActivity = options.settledWithoutIdle === true;
        current.evaluating = false;
        current.terminalState = undefined;
        void this.dispatchContinue(current, current.deferredFinalization);
      } else {
        this.emitTerminalStatus(current.sessionName, 'supervision_audit_pass', SUPERVISION_AUDIT_PASS_LABEL);
        // Do not retain a completion timer after the run reaches a terminal state.
        this.clearWaitingTimers(current);
        this.deletePersistedWaitState(current.sessionName);
        this.activeRuns.delete(current.sessionName);
      }
      return;
    }
    this.emitOrchestratedAuditResult(current, 'rework', undefined, findings);
    current.auditAttemptId = undefined;
    current.auditDelegationId = undefined;
    if (current.reworkDispatches >= current.snapshot.maxAuditLoops) {
      this.emitTerminalStatus(current.sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
      // Do not retain a completion timer after the run reaches a terminal state.
      this.clearWaitingTimers(current);
      this.deletePersistedWaitState(current.sessionName);
      this.activeRuns.delete(current.sessionName);
      return;
    }
    current.reworkDispatches += 1;
    const transportRuntime = getTransportRuntime(current.sessionName);
    if (!transportRuntime) {
      this.emitTerminalStatus(current.sessionName, 'supervision_needs_input', SUPERVISION_NEEDS_INPUT_LABEL);
      // Do not retain a completion timer after the run reaches a terminal state.
      this.clearWaitingTimers(current);
      this.deletePersistedWaitState(current.sessionName);
      this.activeRuns.delete(current.sessionName);
      return;
    }
    const reworkBrief = buildReworkBrief(current, findings);
    current.phase = 'execution';
    this.deletePersistedWaitState(current.sessionName);
    current.requiresAudit = true;
    current.freshAuditRequiredAfterRework = true;
    current.ignoreIdleUntilPostAuditTurnActivity = options.settledWithoutIdle === true;
    current.evaluating = false;
    current.sawAssistantOutput = false;
    current.auditReplyObserved = false;
    current.auditVerdictCorrectionAttempts = 0;
    current.auditMarkerWarningEmitted = false;
    current.terminalState = undefined;
    current.lastAssistantText = undefined;
    // A REWORK verdict starts a new substantive revision. Do not carry the
    // preceding revision's same-bucket continue streak into this repair turn;
    // otherwise a legitimate fix/test cycle can immediately hit the repeated
    // auto-continue limit and stall before the fresh audit. The task-wide hard
    // limit remains intact, and maxAuditLoops still bounds audit/rework cycles.
    current.continueStreakCount = 0;
    current.lastContinueBucket = undefined;
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
      // Do not retain a completion timer after the run reaches a terminal state.
      this.clearWaitingTimers(current);
      this.deletePersistedWaitState(current.sessionName);
      this.activeRuns.delete(current.sessionName);
    }
  }

  private requestAuditVerdictCorrection(current: ActiveTaskRunState): boolean {
    if (current.auditVerdictCorrectionAttempts >= 1) return false;
    const transportRuntime = getTransportRuntime(current.sessionName);
    if (!transportRuntime) return false;

    const correctionNumber = current.auditVerdictCorrectionAttempts + 1;
    const correctionPrompt = buildAuditMarkerCorrectionPrompt(current.snapshot.uiLocale);

    current.auditVerdictCorrectionAttempts = correctionNumber;
    current.auditMarkerWarningEmitted = false;
    current.sawAssistantOutput = false;
    current.lastAssistantText = undefined;
    timelineEmitter.emit(
      current.sessionName,
      'user.message',
      {
        text: correctionPrompt,
        allowDuplicate: true,
        automation: true,
        automationKind: SUPERVISION_AUDIT_MARKER_CORRECTION_AUTOMATION_KIND,
      },
      {
        source: 'daemon',
        confidence: 'high',
        eventId: `supervision-audit-marker-correction:${current.generation}:${correctionNumber}:${randomUUID()}`,
      },
    );

    try {
      transportRuntime.send(
        correctionPrompt,
        `supervision-audit-marker-correction-${current.generation}-${correctionNumber}`,
      );
      this.emitAutomationNote(
        current.sessionName,
        'Auto: the audit reply arrived, but the final marker was missing or ambiguous; requested one bounded marker-only correction turn.',
        'supervision-audit-marker-correction-status',
      );
      this.armAuditDeadline(current);
      return true;
    } catch (error) {
      logger.warn({ session: current.sessionName, err: error }, 'Automatic audit marker correction dispatch failed');
      return false;
    }
  }

  private async dispatchContinue(
    run: ActiveTaskRunState,
    /** Pass the broker fields as bounded advisory hints. The standardized
     * execution mode and the target session's fuller context decide how work
     * advances; the supervisor does not remotely author implementation steps. */
    decision: { reason: string; nextAction?: string; gap?: string },
  ): Promise<void> {
    const current = this.activeRuns.get(run.sessionName);
    if (!current || current.generation !== run.generation || (current.phase !== 'execution' && current.phase !== 'finalizing')) return;
    this.clearWaitingTimers(current);
    this.deletePersistedWaitState(current.sessionName);
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
      {
        reason: decision.reason,
        nextAction: decision.nextAction,
        gap: decision.gap,
        executionMode: postAuditFinalization ? 'finalize_audited_work' : 'advance_safe_work',
        uiLocale: current.snapshot.uiLocale,
      },
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
        if (this.automaticPeerAuditCompatibilityForTests) {
          this.emitAutomationNote(run.sessionName, '✅ Peer audit passed. Auto is now running the deferred commit/push finalization.', 'supervision-post-audit-finalization-status');
        }
        this.emitTerminalStatus(run.sessionName, 'supervision_post_audit_finalizing', SUPERVISION_FINALIZING_LABEL);
      } else {
        if (this.automaticPeerAuditCompatibilityForTests) {
          this.emitAutomationNote(run.sessionName, 'Auto: sent a continue prompt to keep the task moving.', 'supervision-continue-status');
        }
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
