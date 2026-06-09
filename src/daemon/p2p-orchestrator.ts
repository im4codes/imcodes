/**
 * P2P Quick Discussion orchestrator.
 *
 * Flow: initiator(initial) → sub1 → sub2 → ... → initiator(summary)
 * All output written to a per-run temp file — not the screen.
 * Completion = file grew + agent idle.
 */

import { appendFile, readdir, stat, writeFile, readFile, unlink, copyFile, open } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { ensureImcDir } from '../util/imc-dir.js';
import { randomUUID } from 'node:crypto';
import { sendKeysDelayedEnter } from '../agent/tmux.js';
import { detectStatusAsync } from '../agent/detect.js';
import { getSession } from '../store/session-store.js';
import type { SessionRecord } from '../store/session-store.js';
import { getTransportRuntime, launchTransportSession, stopTransportRuntimeSession } from '../agent/session-manager.js';
import {
  P2P_BASELINE_PROMPT,
  getLegacyExecutionRoundCount,
  getLegacyModeForExecutionRound,
  getLegacyModeKeyForExecutionRound,
  getP2pMode,
  isComboMode,
  parseModePipeline,
  roundPrompt,
  type P2pMode,
} from '../../shared/p2p-modes.js';
import {
  resolveP2pRoundPlan,
  type P2pAdvancedRound,
  type P2pContextReducerConfig,
  type P2pHelperDiagnostic,
  type P2pParticipantSnapshotEntry,
  type P2pResolvedPlan,
  type P2pResolvedRound,
} from '../../shared/p2p-advanced.js';
import type {
  SharedActorEnvelope,
  ShareTarget,
  ShareAuthorizationSnapshot,
} from '../../shared/tab-sharing.js';
import type {
  P2pBindRuntimeContext,
  P2pBoundWorkflow,
  StartP2pRunAdvancedSource,
} from '../../shared/p2p-workflow-types.js';
import { recheckDangerousNodeCapabilities } from './p2p-workflow-policy-recheck.js';
import { loadDaemonP2pStaticPolicy, getCurrentDaemonWorkflowCapabilities } from './p2p-workflow-static-policy.js';
// Audit:R2-N1 / N5 — script-node production wiring. `runP2pScriptNode` was
// shipped in PR-§12.1 but had ZERO production callers. The orchestrator now
// invokes it for every compiled node with `nodeKind === 'script'`. Reverse-
// regression #32 locks this so a future refactor can't reopen the gap.
import { runP2pScriptNode } from './p2p-workflow-script-runner.js';
import { acquireScriptSlot, releaseScriptSlot } from './p2p-workflow-script-concurrency.js';
// Audit:R2-N2 — artifact runtime production wiring. `freezeP2pArtifactIdentity`
// + `captureP2pArtifactBaseline` + `verifyP2pArtifactBaselineDelta` were
// shipped in PR-§12.2 but had ZERO production callers. envelope_compiled runs
// with `openspec_convention` artifacts now flow through the new helpers.
import {
  clearPersistedFrozenP2pArtifactIdentity,
  freezeP2pArtifactIdentity,
  captureP2pArtifactBaseline,
  verifyP2pArtifactBaselineDelta,
  loadPersistedFrozenP2pArtifactIdentities,
  type P2pArtifactBaseline,
  type P2pFrozenArtifactIdentity,
} from './p2p-workflow-artifact-runtime.js';
import { makeP2pWorkflowDiagnostic, type P2pWorkflowDiagnostic } from '../../shared/p2p-workflow-diagnostics.js';
import { evaluateP2pLogic } from '../../shared/p2p-workflow-logic-evaluator.js';
import type { P2pWorkflowVariableValue } from '../../shared/p2p-workflow-types.js';
import { OPENSPEC_AUTO_DELIVER_VERDICT_JSON_MAX_BYTES } from '../../shared/openspec-auto-deliver-constants.js';
import {
  P2P_ROUTING_HISTORY_RETENTION_COUNT,
  P2P_SCRIPT_RETRIABLE_DIAGNOSTIC_CODES,
  P2P_SCRIPT_RETRY_DEFAULT_ATTEMPTS,
  P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENTS,
  P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENT_BYTES,
  P2P_WORKFLOW_VARIABLE_NAME_PATTERN,
} from '../../shared/p2p-workflow-constants.js';
import { dropP2pDiscussionWriteQueue, enqueueP2pDiscussionWrite, flushP2pDiscussionWriteQueue } from './p2p-discussion-writer.js';
import { formatP2pParticipantIdentity, shortP2pSessionName } from '../../shared/p2p-participant.js';
import {
  P2P_TERMINAL_HOP_STATUSES,
  P2P_TERMINAL_RUN_STATUSES,
  type P2pActivePhase,
  type P2pHopCounts,
  type P2pHopProgress,
  type P2pHopStatus,
  type P2pRunPhase,
  type P2pRunStatus,
  type P2pRunUpdatePayload,
  type P2pSummaryPhase,
} from '../../shared/p2p-status.js';
import {
  buildP2pExecutionMarker,
  stringifyP2pExecutionMarker,
  validateP2pExecutionMarkerContent,
  type P2pExecutionMarker,
  type P2pExecutionMarkerSpec,
} from '../../shared/p2p-execution-marker.js';
import enLocale from '../../web/src/i18n/locales/en.json' with { type: 'json' };
import zhCNLocale from '../../web/src/i18n/locales/zh-CN.json' with { type: 'json' };
import zhTWLocale from '../../web/src/i18n/locales/zh-TW.json' with { type: 'json' };
import jaLocale from '../../web/src/i18n/locales/ja.json' with { type: 'json' };
import koLocale from '../../web/src/i18n/locales/ko.json' with { type: 'json' };
import esLocale from '../../web/src/i18n/locales/es.json' with { type: 'json' };
import ruLocale from '../../web/src/i18n/locales/ru.json' with { type: 'json' };
import logger from '../util/logger.js';
import type { ServerLink } from './server-link.js';
import { timelineEmitter } from './timeline-emitter.js';
import {
  evaluateP2pLaunchAdmission,
  sanitizeP2pLaunchOriginForProjection,
  type P2pLaunchOrigin,
} from './p2p-launch-admission.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type { P2pRunStatus } from '../../shared/p2p-status.js';

export interface P2pTarget {
  session: string; // full tmux session name e.g. deck_myapp_w2
  mode: string;    // mode key e.g. 'audit'
}

export interface StartP2pRunOptions {
  initiatorSession: string;
  targets: P2pTarget[];
  userText: string;
  locale?: string;
  fileContents: Array<{ path: string; content: string }>;
  serverLink: ServerLink | null;
  rounds?: number;
  extraPrompt?: string;
  modeOverride?: string;
  hopTimeoutMs?: number;
  /**
   * Source of the advanced rounds (audit:V-1 / N-H1 / Q1). When supplied,
   * `advanced.kind === 'envelope_compiled'` carries the bound workflow whose
   * `bindContext.capabilitySnapshot` and `currentDaemonPolicy` are stored on
   * the run state for downstream `recheckDangerousNodeCapabilities` calls.
   * Pass `kind: 'supervision_internal'` to make the supervision escape hatch
   * explicit in source review and reverse-regression checks.
   *
   * Older callers (cron / tests) may continue to pass the legacy
   * `advancedPresetKey` / `advancedRounds` fields directly; v1b deletes them.
   */
  advanced?: StartP2pRunAdvancedSource;
  /** @deprecated v1a passthrough — prefer `advanced` for new call sites. Removed in v1b. */
  advancedPresetKey?: string;
  /** @deprecated v1a passthrough — prefer `advanced` for new call sites. Removed in v1b. */
  advancedRounds?: P2pAdvancedRound[];
  /** @deprecated v1a passthrough — prefer `advanced` for new call sites. Removed in v1b. */
  advancedRunTimeoutMs?: number;
  /** @deprecated v1a passthrough — prefer `advanced` for new call sites. Removed in v1b. */
  contextReducer?: P2pContextReducerConfig;
  sharedActor?: SharedActorEnvelope;
  shareScope?: SharedP2pRunScope;
  launchOrigin?: P2pLaunchOrigin;
}

export interface SharedP2pRunScope {
  target: ShareTarget;
  historyCutoffAt: ShareAuthorizationSnapshot['historyCutoffAt'];
  primaryShareId: ShareAuthorizationSnapshot['primaryShareId'];
  coveringShareIds: ShareAuthorizationSnapshot['coveringShareIds'];
}

interface P2pHopRuntime extends P2pHopProgress {
  section_header: string;
  artifact_path: string;
  working_path: string | null;
  baseline_size: number;
  baseline_content: string;
}

export interface P2pRun {
  id: string;
  discussionId: string;
  mainSession: string;
  initiatorSession: string;
  currentTargetSession: string | null;
  finalReturnSession: string;
  /** Compatibility-only projection for legacy consumers; advanced runs drain this per execution round. */
  remainingTargets: P2pTarget[];
  /** Total number of hop targets (excluding initiator phases). Fixed at creation time. */
  totalTargets: number;
  mode: string;
  status: P2pRunStatus;
  runPhase: P2pRunPhase;
  summaryPhase: P2pSummaryPhase | null;
  activePhase: P2pActivePhase;
  contextFilePath: string;
  /** Original user request text — used in Phase 3 so initiator can execute final instructions. */
  userText: string;
  /** Selected UI locale for i18n-aware final synthesis reminders. */
  locale?: string;
  timeoutMs: number;
  resultSummary: string | null;
  strictAuthoritativeResult: string | null;
  /** Compatibility-only projection for legacy consumers; advanced loop retries may repeat sessions here. */
  completedHops: P2pTarget[];
  /** Compatibility-only projection for legacy consumers; advanced loop retries may repeat sessions here. */
  skippedHops: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Total number of rounds for this run. */
  rounds: number;
  /** Current round (1-based). */
  currentRound: number;
  /** Full set of targets for repeating across rounds. */
  allTargets: P2pTarget[];
  /** User-defined extra prompt appended to every participant's system prompt. */
  extraPrompt: string;
  /** Epoch ms when the current hop/phase started — used by the UI for hop-level elapsed timer. */
  hopStartedAt: number;
  /** Post-summary original-request execution proof, reset for each cycle/final execution gate. */
  executionAttempt?: number;
  executionCycleCurrent?: number | null;
  executionCycleTotal?: number | null;
  executionMarkerPath?: string | null;
  /** Parallel hop runtime state across all rounds. */
  hopStates: P2pHopRuntime[];
  activeTargetSessions: string[];
  advancedP2pEnabled: boolean;
  resolvedRounds?: P2pResolvedRound[];
  helperEligibleSnapshot: P2pParticipantSnapshotEntry[];
  sharedActor?: SharedActorEnvelope;
  shareScope?: SharedP2pRunScope;
  contextReducer?: P2pContextReducerConfig;
  advancedRunTimeoutMs?: number;
  /**
   * Bind-time capability snapshot (audit:V-1 / N-H1). Present iff the run was
   * started via `advanced: { kind: 'envelope_compiled', bound }` — i.e. the
   * bound workflow flowed all the way through `prepareAdvancedWorkflowLaunch`.
   * Stored on the run so dangerous-node executors can call
   * `recheckDangerousNodeCapabilities` against the live daemon policy at
   * execution time.
   */
  capabilitySnapshot?: P2pBindRuntimeContext['capabilitySnapshot'];
  /**
   * Bind-time daemon policy snapshot (audit:H3 / R3 PR-α). Full
   * `P2pStaticPolicy` shape so `recheckDangerousNodeCapabilities` can compare
   * `allowedExecutables` / `allowImplementationPermission` /
   * `allowInterpreterScripts` field-for-field against the live daemon policy
   * at executor time.
   */
  policySnapshot?: P2pBindRuntimeContext['policySnapshot'];
  /**
   * Full bound workflow (audit:R3 PR-α / N-M1). Holds
   * `compiled.derivedRequiredCapabilities` plus the original bind context;
   * required for v1b dangerous-node recheck because the helper must know what
   * the run was bound for, not what the current draft would re-derive.
   *
   * MUST NOT be serialized to web/DB — `serializeP2pRun()` and
   * `sanitizeP2pOrchestrationRunForBridge` allowlists exclude it. See
   * reverse-regression #17 / #18.
   */
  boundWorkflow?: import('../../shared/p2p-workflow-types.js').P2pBoundWorkflow;
  /**
   * Discriminant of the advanced source used at start time. `'envelope_compiled'`
   * marks runs that came from a validated workflow envelope; `'supervision_internal'`
   * marks daemon-internal supervision audits (escape hatch); `undefined` is the
   * legacy passthrough (cron / tests). Helps audit/projection code distinguish
   * runs that obey the full v1 contract from legacy ones.
   */
  advancedSourceKind?: StartP2pRunAdvancedSource['kind'];
  /**
   * Admission/provenance metadata for the launch path that created this run.
   * Kept daemon-local until the shared Auto Deliver contracts land; projection
   * uses an allowlist sanitizer so raw prompts/provider internals never leak.
   */
  launchOrigin?: P2pLaunchOrigin;
  deadlineAt?: number | null;
  currentRoundId?: string | null;
  currentExecutionStep: number;
  currentRoundAttempt: number;
  roundAttemptCounts: Record<string, number>;
  roundJumpCounts: Record<string, number>;
  /**
   * R3 PR-β (Cx1-H2 / W4) — per-compiled-edge usage counter for envelope_compiled
   * runs. Independent from `roundJumpCounts` because compiled edges have
   * per-edge `loopBudgets` (vs the round-aggregated jump budget on the
   * legacy adapter projection). Test-only reset: see `__resetP2pRunArtifactRootCacheForTests`.
   */
  compiledEdgeUseCounts?: Record<string, number>;
  /**
   * R3 v2 PR-ζ (M2) — Per-script-round retry counter, independent of
   * `roundAttemptCounts`. Decoupling ensures: (1) jump-rebound to the
   * same round.id does not consume the script retry budget meant for
   * transient errors only; (2) reset on jump can target this map without
   * touching the canonical attempt history. `dispatchScriptRoundOrFail`
   * reads + increments this on each retriable failure.
   */
  scriptRetryCounts?: Record<string, number>;
  /**
   * R3 v1b follow-up — mutable run variable state. Initialised from
   * `bound.compiled.variables` (declared defaults) and patched by script
   * nodes via `result.machineOutput.finalFrame.variables`. Logic nodes
   * read from this map to evaluate their declarative rules.
   */
  runVariables?: Record<string, unknown>;
  routingHistory: Array<{
    fromRoundId?: string | null;
    toRoundId?: string | null;
    trigger?: string | null;
    atStep: number;
    atAttempt?: number | null;
    timestamp: number;
  }>;
  helperDiagnostics: P2pHelperDiagnostic[];
  /** Internal: set to true when cancel requested */
  _cancelled: boolean;
}

// ── In-memory store ───────────────────────────────────────────────────────

const activeRuns = new Map<string, P2pRun>();

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function extractFinalSummarySection(content: string): string {
  let finalSummaryIndex = -1;
  for (const match of content.matchAll(/^## .*Final Summary.*$/gmi)) {
    finalSummaryIndex = match.index ?? finalSummaryIndex;
  }
  return finalSummaryIndex >= 0 ? content.slice(finalSummaryIndex) : content;
}

export function extractOpenSpecAutoDeliverStrictSegment(content: string): string | null {
  const authoritativeSection = extractFinalSummarySection(content);
  if (byteLength(authoritativeSection) > OPENSPEC_AUTO_DELIVER_VERDICT_JSON_MAX_BYTES) return null;
  const matches = [...authoritativeSection.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (matches.length !== 1) return null;
  const segment = matches[0]?.[0] ?? '';
  return byteLength(segment) <= OPENSPEC_AUTO_DELIVER_VERDICT_JSON_MAX_BYTES ? segment : null;
}

/**
 * Audit fix (94b9b837-822 / N1) — module-level registry of "currently
 * running script aborter" per active P2P run. Lets `cancelP2pRun` and the
 * deadline watchdog terminate hung script-node child processes by calling
 * the AbortController stored here, instead of relying on `run._cancelled`
 * which a blocking `await runP2pScriptNode(...)` will never see.
 *
 * Without this, a script with `argv: ['/bin/sleep', '9999']` and no
 * `script.timeoutMs` set would block `executeAdvancedChain` forever; the
 * outer `ensureRunDeadline` check on the next loop iteration would not
 * fire because the loop never advances. The result was that `failRun`
 * never executed, `transition()` never ran, `scheduleP2pRunTerminalCleanup`
 * never scheduled, and the `P2pRun` object stayed reachable in
 * `activeRuns` until daemon restart (the underlying OOM trigger).
 */
const currentScriptAborters = new Map<string, () => void>();

/** Test-only: clear the abort registry between tests. */
export function __resetCurrentScriptAbortersForTests(): void {
  currentScriptAborters.clear();
}

const P2P_POST_SUMMARY_EXECUTE_TEMPLATES: Record<string, string> = {
  en: enLocale.p2p.post_summary_execute_prompt,
  'zh-CN': zhCNLocale.p2p.post_summary_execute_prompt,
  'zh-TW': zhTWLocale.p2p.post_summary_execute_prompt,
  ja: jaLocale.p2p.post_summary_execute_prompt,
  ko: koLocale.p2p.post_summary_execute_prompt,
  es: esLocale.p2p.post_summary_execute_prompt,
  ru: ruLocale.p2p.post_summary_execute_prompt,
};

const P2P_PREVIOUS_CYCLE_AUDIT_SCOPE_TAIL_BYTES = 12 * 1024;
const P2P_PREVIOUS_CYCLE_AUDIT_SCOPE_MAX_CHARS = 8_000;

export interface PostSummaryExecutionPromptSpec extends P2pExecutionMarkerSpec {
  markerPath: string;
}

function buildPostSummaryExecutionBasePrompt(run: Pick<P2pRun, 'contextFilePath' | 'userText' | 'locale'>): string {
  const template = P2P_POST_SUMMARY_EXECUTE_TEMPLATES[run.locale ?? ''] ?? P2P_POST_SUMMARY_EXECUTE_TEMPLATES.en;
  return template
    .replaceAll('{{discussionFile}}', run.contextFilePath)
    .replaceAll('{{request}}', run.userText);
}

function buildPostSummaryExecutionProofBlock(
  markerSpec: PostSummaryExecutionPromptSpec,
  options: { attempt?: number; deadlineAt?: number } = {},
): string {
  const successMarker = stringifyP2pExecutionMarker(buildP2pExecutionMarker(markerSpec, 'completed')).trimEnd();
  const failureMarker = stringifyP2pExecutionMarker({
    ...buildP2pExecutionMarker(markerSpec, 'failed'),
    error: 'short reason',
  }).trimEnd();
  const deadlineLine = typeof options.deadlineAt === 'number'
    ? `\nDeadline: ${new Date(options.deadlineAt).toISOString()}`
    : '';
  const attemptLine = options.attempt && options.attempt > 1
    ? `\nThis is retry attempt ${options.attempt}; the required marker has not been observed yet.`
    : '';

  return `Execution proof required before the P2P workflow can continue:
- After you have directly executed the original request, write this exact JSON marker to: ${markerSpec.markerPath}
- Keep runId, cycleIndex, cycleTotal, nonce, and status exactly as shown. Do not write the marker before doing the work.
- If you cannot complete the request, write the failed marker instead and include a short error field.
- The daemon will retry this prompt while the marker is missing; idling without the marker does not count as success.${deadlineLine}${attemptLine}

Completed marker:
\`\`\`json
${successMarker}
\`\`\`

Failed marker:
\`\`\`json
${failureMarker}
\`\`\``;
}

function buildInlinePostSummaryExecutionInstruction(
  run: Pick<P2pRun, 'contextFilePath' | 'userText' | 'locale'>,
  markerSpec: PostSummaryExecutionPromptSpec,
): string {
  return `After writing the required summary or plan, continue in the same turn and directly execute the user's original request. Do not wait for a separate follow-up prompt.

${buildPostSummaryExecutionBasePrompt(run)}

${buildPostSummaryExecutionProofBlock(markerSpec)}`;
}

function buildPostSummaryExecutionConfirmationPrompt(
  run: Pick<P2pRun, 'contextFilePath' | 'userText' | 'locale'>,
  executionSpec: PostSummaryExecutionPromptSpec,
  executionMarker: P2pExecutionMarker,
  markerSpec: PostSummaryExecutionPromptSpec,
  options: { attempt?: number; deadlineAt?: number } = {},
): string {
  const langLine = buildP2pLanguageInstruction(run.locale);
  const markerSummary = [
    `Execution marker file: ${executionSpec.markerPath}`,
    `Execution marker status: ${executionMarker.status}`,
    executionMarker.summary ? `Execution summary: ${executionMarker.summary}` : null,
    executionMarker.changedFiles?.length ? `Changed files: ${executionMarker.changedFiles.join(', ')}` : null,
    executionMarker.tests?.length ? `Tests: ${executionMarker.tests.join(', ')}` : null,
  ].filter((line): line is string => line !== null).join('\n');

  const prompt = `Team execution follow-up verification.

Discussion file: ${run.contextFilePath}
Original user request: "${run.userText}"

${markerSummary}

Re-check the original request, the discussion evidence, and the work you just completed. If anything is incomplete, missing, or only partially done, finish it now in this same session. Only after you have verified the request is genuinely complete should you write the completed confirmation marker. If you cannot complete it, write the failed marker with a short reason.

Do not just say it is done. Verify it against the request and complete any missing work.

${buildPostSummaryExecutionProofBlock(markerSpec, options)}`;

  return langLine ? `${prompt}\n\n${langLine}` : prompt;
}

export function buildPostSummaryExecutionPrompt(
  run: Pick<P2pRun, 'contextFilePath' | 'userText' | 'locale'>,
  markerSpec?: PostSummaryExecutionPromptSpec,
  options: { attempt?: number; deadlineAt?: number } = {},
): string {
  const basePrompt = buildPostSummaryExecutionBasePrompt(run);
  const langLine = buildP2pLanguageInstruction(run.locale);
  const appendLanguageInstruction = (prompt: string) => langLine ? `${prompt}\n\n${langLine}` : prompt;
  if (!markerSpec) return appendLanguageInstruction(basePrompt);

  return appendLanguageInstruction(`${basePrompt}

${buildPostSummaryExecutionProofBlock(markerSpec, options)}`);
}

const P2P_SUPPORTED_I18N_LOCALES = new Set(['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko']);

/**
 * Build the per-run discussion-language reminder. It intentionally uses the
 * selected i18n locale code and is appended at the END of P2P prompts, so it
 * is not buried in the middle of the task body or localized into an easily
 * missed side instruction.
 */
export function buildP2pLanguageInstruction(locale: string | undefined): string {
  if (!locale) return '';
  if (!P2P_SUPPORTED_I18N_LOCALES.has(locale)) return '';
  return `You shall use ${locale} to reply and use ${locale} to discuss.`;
}

export function getP2pRun(id: string): P2pRun | undefined { return activeRuns.get(id); }
export function listP2pRuns(): P2pRun[] { return [...activeRuns.values()]; }

export function serializeP2pRun(run: P2pRun): P2pRunUpdatePayload {
  const isTerminalRun = P2P_TERMINAL_RUN_STATUSES.has(run.status);
  const projectedCurrentRound = Math.min(Math.max(1, run.currentRound), Math.max(1, run.rounds));
  const completedHopCount = run.hopStates.filter((hop) => hop.status === 'completed').length;
  const currentRoundCompletedHopCount = run.hopStates.filter(
    (hop) => hop.round_index === projectedCurrentRound && hop.status === 'completed',
  ).length;
  const activeHopStates = run.hopStates.filter((hop) =>
    hop.round_index === projectedCurrentRound &&
    (hop.status === 'running' || hop.status === 'dispatched'),
  );
  const currentHopState = activeHopStates[0] ?? null;
  const currentHop = isTerminalRun
    ? null
    : currentHopState?.session
      ?? run.activeTargetSessions[0]
      ?? run.currentTargetSession
      ?? (run.activePhase === 'initial' || run.activePhase === 'summary' || run.activePhase === 'execution'
        ? run.initiatorSession
        : null);
  const hopCounts = countHopStates(run.hopStates);
  const legacyPipelineLength = !run.advancedP2pEnabled && isComboMode(run.mode)
    ? Math.max(1, parseModePipeline(run.mode).length)
    : 1;
  const legacyFlowCycleCurrent = !run.advancedP2pEnabled
    ? Math.max(1, Math.ceil(projectedCurrentRound / legacyPipelineLength))
    : null;
  const legacyFlowCycleTotal = !run.advancedP2pEnabled
    ? Math.max(1, Math.ceil(Math.max(1, run.rounds) / legacyPipelineLength))
    : null;
  const legacyFlowStepCurrent = !run.advancedP2pEnabled
    ? (((projectedCurrentRound - 1) % legacyPipelineLength) + 1)
    : null;
  const legacyFlowStepTotal = !run.advancedP2pEnabled ? legacyPipelineLength : null;
  const routingHistory = Array.isArray(run.routingHistory) ? run.routingHistory : [];
  const latestStepByRoundId = routingHistory.reduce<Record<string, number>>((acc, entry) => {
    if (typeof entry.toRoundId === 'string' && typeof entry.atStep === 'number') {
      acc[entry.toRoundId] = entry.atStep;
    }
    return acc;
  }, {});

  const payload: P2pRunUpdatePayload = {
    id: run.id,
    discussion_id: run.discussionId,
    server_id: '', // filled by bridge from auth context
    main_session: run.mainSession,
    initiator_session: run.initiatorSession,
    current_target_session: currentHop,
    final_return_session: run.finalReturnSession,
    remaining_targets: JSON.stringify(run.remainingTargets),
    mode_key: run.mode,
    current_round_mode: isComboMode(run.mode) ? getLegacyModeKeyForExecutionRound(run.mode, projectedCurrentRound) : run.mode,
    status: run.status,
    run_phase: run.runPhase,
    summary_phase: run.summaryPhase,
    request_message_id: null,
    callback_message_id: null,
    context_ref: JSON.stringify({ type: 'file', path: run.contextFilePath }),
    timeout_ms: run.timeoutMs,
    result_summary: run.resultSummary,
    error: run.error,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    completed_at: run.completedAt,
    // UI-ready progress fields (avoids client-side JSON parsing)
    total_count: run.totalTargets + 2, // +2 for Phase 1 (initial) + Phase 3 (summary)
    total_hops: run.totalTargets,
    remaining_count: run.remainingTargets.length,
    completed_hops_count: completedHopCount,
    completed_round_hops_count: currentRoundCompletedHopCount,
    current_round: projectedCurrentRound,
    total_rounds: run.rounds,
    flow_cycle_current: legacyFlowCycleCurrent ?? undefined,
    flow_cycle_total: legacyFlowCycleTotal ?? undefined,
    flow_step_current: legacyFlowStepCurrent ?? undefined,
    flow_step_total: legacyFlowStepTotal ?? undefined,
    skipped_hops: run.skippedHops,
    ...(isTerminalRun ? {} : { active_phase: run.activePhase }),
    execution_attempt: run.executionAttempt ?? null,
    execution_cycle_current: run.executionCycleCurrent ?? null,
    execution_cycle_total: run.executionCycleTotal ?? null,
    hop_started_at: run.hopStartedAt || null,
    active_hop_number: currentHopState ? currentHopState.hop_index : null,
    active_round_hop_number: currentHopState && run.totalTargets > 0
      ? (((currentHopState.hop_index - 1) % run.totalTargets) + 1)
      : null,
    // Agent metadata for display
    current_target_label: (() => {
      if (!currentHop) return null;
      const rec = getSession(currentHop);
      return formatP2pParticipantIdentity({
        session: currentHop,
        label: rec?.label,
        agentType: rec?.agentType,
        ccPreset: rec?.ccPreset,
      });
    })(),
    initiator_label: (() => {
      const rec = getSession(run.initiatorSession);
      return formatP2pParticipantIdentity({
        session: run.initiatorSession,
        label: rec?.label,
        agentType: rec?.agentType,
        ccPreset: rec?.ccPreset,
      });
    })(),
    hop_states: run.hopStates.map((hop) => ({
      hop_index: hop.hop_index,
      round_index: hop.round_index,
      session: hop.session,
      mode: hop.mode,
      status: hop.status,
      started_at: hop.started_at,
      completed_at: hop.completed_at,
      error: hop.error,
      output_path: hop.output_path ?? null,
    })),
    hop_counts: hopCounts,
    terminal_reason: run.status === 'completed' || run.status === 'timed_out' || run.status === 'failed' || run.status === 'cancelled'
      ? run.status
      : null,
    advanced_p2p_enabled: run.advancedP2pEnabled || undefined,
    current_round_id: run.currentRoundId ?? null,
    current_execution_step: run.currentExecutionStep || null,
    current_round_attempt: run.currentRoundAttempt || null,
    ...(run.sharedActor ? { sharedActor: run.sharedActor } : {}),
    ...(run.shareScope ? { shareScope: run.shareScope } : {}),
    round_attempt_counts: run.advancedP2pEnabled ? { ...run.roundAttemptCounts } : undefined,
    round_jump_counts: run.advancedP2pEnabled ? { ...run.roundJumpCounts } : undefined,
    routing_history: run.advancedP2pEnabled ? [...routingHistory] : undefined,
    helper_diagnostics: run.advancedP2pEnabled && run.helperDiagnostics.length > 0 ? [...run.helperDiagnostics] : undefined,
    advanced_nodes: run.advancedP2pEnabled && run.resolvedRounds
      ? run.resolvedRounds.map((round) => ({
        id: round.id,
        title: round.title,
        preset: round.preset,
        status: (() => {
          if (run.currentRoundId === round.id) {
            return P2P_TERMINAL_RUN_STATUSES.has(run.status) ? (run.status === 'completed' ? 'done' : 'skipped') : 'active';
          }
          if ((run.roundAttemptCounts[round.id] ?? 0) > 0) return 'done';
          return 'pending';
        })(),
        attempt: run.roundAttemptCounts[round.id] ?? 0,
        step: latestStepByRoundId[round.id],
      }))
      : undefined,
    // Full node list for segmented progress display — compatibility projection
    all_nodes: (() => {
      type NodeInfo = {
        session: string;
        label: string;
        displayLabel: string;
        agentType: string;
        ccPreset: string | null;
        mode: string;
        phase: 'initial' | 'hop' | 'summary' | 'execution';
        status: 'done' | 'active' | 'pending' | 'skipped';
      };
      const nodes: NodeInfo[] = [];
      const getInfo = (s: string, mode: string, phase: 'initial' | 'hop' | 'summary' | 'execution') => {
        const r = getSession(s);
        const label = r?.label || shortName(s);
        const agentType = r?.agentType ?? 'unknown';
        const ccPreset = r?.ccPreset ?? null;
        return {
          label,
          displayLabel: formatP2pParticipantIdentity({
            session: s,
            label: r?.label,
            agentType: r?.agentType,
            ccPreset: r?.ccPreset,
          }),
          agentType,
          ccPreset,
          mode,
          phase,
        };
      };

      // For combo pipelines, resolve the display mode per round
      const combo = isComboMode(run.mode);
      const pipeline = combo ? parseModePipeline(run.mode) : null;
      const resolveMode = (round: number) => {
        if (!pipeline) return run.mode;
        return pipeline[(Math.max(1, round) - 1) % Math.max(1, pipeline.length)] ?? run.mode;
      };

      const initMode = resolveMode(1);
      const init = getInfo(run.initiatorSession, initMode, 'initial');
      const phase1Done = run.currentRound > 1 || hopCounts.completed > 0 || run.status === 'completed';
      const phase1Active = run.activePhase === 'initial';
      nodes.push({ session: run.initiatorSession, ...init, status: phase1Active ? 'active' : phase1Done ? 'done' : 'pending' });

      for (const hop of run.hopStates.filter((item) => item.status === 'completed' || item.status === 'timed_out' || item.status === 'failed' || item.status === 'cancelled')) {
        const t = { session: hop.session, mode: hop.mode };
        const hopRound = hop.round_index;
        const hopMode = combo ? resolveMode(hopRound) : t.mode;
        const info = getInfo(t.session, hopMode, 'hop');
        const status = hop.status === 'completed' ? 'done' : 'skipped';
        nodes.push({ session: t.session, ...info, status });
      }
      const activeSessions = new Set(activeHopStates.map((hop) => hop.session));
      for (const activeHop of activeHopStates) {
        const curMode = combo ? resolveMode(run.currentRound) : (
          run.allTargets.find((t) => t.session === activeHop.session)?.mode
          ?? run.remainingTargets.find((t) => t.session === activeHop.session)?.mode
          ?? run.mode
        );
        const info = getInfo(activeHop.session, curMode, 'hop');
        nodes.push({ session: activeHop.session, ...info, status: 'active' });
      }
      for (const t of run.remainingTargets) {
        if (activeSessions.has(t.session)) continue;
        const pendingMode = combo ? resolveMode(run.currentRound) : t.mode;
        const info = getInfo(t.session, pendingMode, 'hop');
        nodes.push({ session: t.session, ...info, status: 'pending' });
      }

      const summaryDone = run.status === 'completed' || run.summaryPhase === 'completed';
      const summaryActive = run.activePhase === 'summary' && !summaryDone;
      const lastMode = combo ? resolveMode(run.rounds) : run.mode;
      const summary = getInfo(run.initiatorSession, lastMode, 'summary');
      nodes.push({ session: run.initiatorSession, ...summary, status: summaryDone ? 'done' : summaryActive ? 'active' : 'pending' });
      const executionActive = run.activePhase === 'execution' && !isTerminal(run.status);
      if (executionActive || run.executionCycleCurrent != null || run.status === 'completed') {
        const execution = getInfo(run.initiatorSession, lastMode, 'execution');
        const executionDone = run.status === 'completed' || !isTerminal(run.status);
        nodes.push({ session: run.initiatorSession, ...execution, status: executionActive ? 'active' : executionDone ? 'done' : 'skipped' });
      }
      return nodes;
    })(),
  };
  const launchOrigin = sanitizeP2pLaunchOriginForProjection(run.launchOrigin);
  if (launchOrigin) {
    (payload as Record<string, unknown>).launch_origin = launchOrigin;
  }
  return payload;
}

// ── Constants ─────────────────────────────────────────────────────────────

let IDLE_POLL_MS = 1_000;
let GRACE_PERIOD_DEFAULT_MS = 45_000; // Complex analysis can be slow, but blank/idle hops should not stall for minutes.
let MIN_PROCESSING_MS = 8_000; // Give the agent a short startup window before trusting idle detection.
let FILE_SETTLE_CYCLES = 2; // File must stop growing for 2 poll cycles (2s) to be "settled".
let MARKER_PROMPT_RETRY_AFTER_MS = 30_000; // Marker prompts may be retried, but only after queue-aware idle.
let POST_SUMMARY_CONFIRMATION_DELAY_MS = 3_000; // Let the execution marker/status settle before the follow-up check.
let QUEUE_STUCK_STOP_AFTER_MS = 120_000; // Generic stale queue recovery stays conservative.
let QUEUED_PROMPT_STOP_AFTER_MS = 20_000; // P2P-owned queued prompt should be recovered quickly.
let ROUND_HOP_CLEANUP_DELAY_MS = 0;

/** Override poll interval for tests. */
export function _setIdlePollMs(ms: number): void { IDLE_POLL_MS = ms; }
/** Override grace period for tests. */
export function _setGracePeriodMs(ms: number): void { GRACE_PERIOD_DEFAULT_MS = ms; }
/** Override min processing time for tests. */
export function _setMinProcessingMs(ms: number): void { MIN_PROCESSING_MS = ms; }
/** Override file settle cycles for tests. */
export function _setFileSettleCycles(n: number): void { FILE_SETTLE_CYCLES = n; }
/** Override marker retry delay for tests. */
export function _setMarkerPromptRetryAfterMs(ms: number): void { MARKER_PROMPT_RETRY_AFTER_MS = ms; }
/** Override follow-up confirmation delay for tests. */
export function _setPostSummaryConfirmationDelayMs(ms: number): void { POST_SUMMARY_CONFIRMATION_DELAY_MS = ms; }
/** Override stale queue watchdog threshold for tests. */
export function _setQueueStuckStopAfterMs(ms: number): void { QUEUE_STUCK_STOP_AFTER_MS = ms; }
/** Override queued P2P prompt watchdog threshold for tests. */
export function _setQueuedPromptStopAfterMs(ms: number): void { QUEUED_PROMPT_STOP_AFTER_MS = ms; }
/** Override round hop artifact cleanup delay for tests. */
export function _setRoundHopCleanupDelayMs(ms: number): void { ROUND_HOP_CLEANUP_DELAY_MS = ms; }

async function maybeStopStaleP2pTransportQueue(args: {
  run: P2pRun;
  session: string;
  dispatchStartedAt: number;
  alreadyStopped: boolean;
  reason: string;
  staleAfterMs?: number;
}): Promise<boolean> {
  if (args.alreadyStopped) return true;
  const runtime = getTransportRuntime(args.session);
  if (!runtime) return false;

  const now = Date.now();
  if (runtime.drainPendingIfIdle(`p2p-${args.reason}`)) {
    logger.info(
      { runId: args.run.id, session: args.session, reason: args.reason },
      'P2P: drained queued transport prompt after observing idle runtime',
    );
    return false;
  }

  const snapshot = runtime.getDiagnosticSnapshot(now);
  const blocked = snapshot.sending || snapshot.pendingCount > 0 || snapshot.activeDispatchCount > 0;
  if (!blocked) return false;

  const staleAfterMs = args.staleAfterMs ?? QUEUE_STUCK_STOP_AFTER_MS;
  const dispatchAgeMs = Math.max(0, now - args.dispatchStartedAt);
  if (dispatchAgeMs < staleAfterMs || snapshot.lastActivityAgeMs < staleAfterMs) {
    return false;
  }

  const cancelStarted = runtime.cancelStaleActiveTurnWithPending({
    reason: `p2p-${args.reason}`,
    nowMs: now,
    staleMs: staleAfterMs,
  });
  if (cancelStarted) {
    logger.warn(
      {
        runId: args.run.id,
        session: args.session,
        reason: args.reason,
        dispatchAgeMs,
        queueStuckStopAfterMs: staleAfterMs,
        status: snapshot.status,
        sending: snapshot.sending,
        pendingCount: snapshot.pendingCount,
        activeDispatchCount: snapshot.activeDispatchCount,
        lastActivityAgeMs: snapshot.lastActivityAgeMs,
      },
      'P2P: stale active transport turn has queued prompt — requested runtime recovery cancel',
    );
    return true;
  }

  logger.warn(
    {
      runId: args.run.id,
      session: args.session,
      reason: args.reason,
      dispatchAgeMs,
      queueStuckStopAfterMs: staleAfterMs,
      status: snapshot.status,
      sending: snapshot.sending,
      pendingCount: snapshot.pendingCount,
      activeDispatchCount: snapshot.activeDispatchCount,
      lastActivityAgeMs: snapshot.lastActivityAgeMs,
    },
    'P2P: transport queue appears stale — stopping active turn once to allow queued work to drain',
  );

  try {
    await runtime.cancel();
    return true;
  } catch (err) {
    logger.warn({ runId: args.run.id, session: args.session, err }, 'P2P: stale transport queue stop failed');
    return true;
  }
}

async function dispatchP2pPromptToSession(args: {
  run: P2pRun;
  session: string;
  prompt: string;
  allowDuplicate?: boolean;
  reason: string;
}): Promise<'sent' | 'queued' | 'tmux'> {
  const transportRuntime = await getOrRestoreP2pTransportRuntime(args.session);
  if (transportRuntime) {
    timelineEmitter.emit(args.session, 'user.message', {
      text: args.prompt,
      ...(args.allowDuplicate ? { allowDuplicate: true } : {}),
    });
    const result = transportRuntime.send(args.prompt);
    if (result === 'queued') {
      emitP2pTransportQueuedState(args.run, args.session, transportRuntime, args.reason);
      transportRuntime.drainPendingIfIdle(`p2p-${args.reason}-post-send`);
    }
    return result;
  }
  const record = getSession(args.session);
  if (record?.runtimeType === 'transport') {
    throw new Error(`missing_transport_runtime:${args.session}`);
  }
  await sendKeysDelayedEnter(args.session, args.prompt);
  return 'tmux';
}

async function getOrRestoreP2pTransportRuntime(sessionName: string): Promise<ReturnType<typeof getTransportRuntime>> {
  const existing = getTransportRuntime(sessionName);
  if (existing) return existing;
  const record = getSession(sessionName);
  if (record?.runtimeType !== 'transport') return undefined;

  await restoreP2pTransportRuntime(record, 'missing_runtime');
  return getTransportRuntime(sessionName);
}

async function restoreP2pTransportRuntime(record: SessionRecord, reason: 'missing_runtime'): Promise<void> {
  logger.warn({ session: record.name, reason }, 'P2P: restoring transport runtime before prompt dispatch');
  await stopTransportRuntimeSession(record.name).catch(() => undefined);
  await launchTransportSession({
    name: record.name,
    projectName: record.projectName,
    role: record.role,
    agentType: record.agentType as any,
    projectDir: record.projectDir,
    label: record.label,
    description: record.description,
    requestedModel: record.requestedModel,
    effort: record.effort,
    transportConfig: record.transportConfig,
    ccPreset: (record.agentType === 'claude-code-sdk' || record.agentType === 'qwen') ? record.ccPreset : undefined,
    ...(record.agentType === 'claude-code-sdk' && record.ccSessionId ? { ccSessionId: record.ccSessionId } : {}),
    ...(record.agentType === 'codex-sdk' && record.codexSessionId ? { codexSessionId: record.codexSessionId } : {}),
    ...((record.agentType === 'cursor-headless' || record.agentType === 'copilot-sdk' || record.agentType === 'kimi-sdk') && record.providerResumeId
      ? { providerResumeId: record.providerResumeId } : {}),
    ...(record.agentType === 'openclaw' && record.providerSessionId ? { bindExistingKey: record.providerSessionId } : {}),
    ...(record.agentType === 'qwen' && record.providerSessionId ? { bindExistingKey: record.providerSessionId } : {}),
    ...(record.parentSession ? { parentSession: record.parentSession } : {}),
    ...(record.userCreated ? { userCreated: true } : {}),
  });
}

function emitP2pTransportQueuedState(
  run: P2pRun,
  session: string,
  runtime: NonNullable<ReturnType<typeof getTransportRuntime>>,
  reason: string,
): void {
  logger.warn(
    {
      runId: run.id,
      session,
      reason,
      pendingCount: runtime.pendingCount,
      pendingVersion: runtime.pendingVersion,
    },
    'P2P: transport prompt queued behind active turn',
  );
  timelineEmitter.emit(session, 'session.state', {
    state: 'queued',
    pendingCount: runtime.pendingCount,
    pendingMessages: runtime.pendingMessages,
    pendingMessageEntries: runtime.pendingEntries,
    pendingMessageVersion: runtime.pendingVersion,
  }, { source: 'daemon', confidence: 'high' });
}

// ── Idle event registry (callback-driven, no polling) ─────────────────────

type IdleResolver = () => void;
const idleWaiters = new Map<string, Set<IdleResolver>>();

/**
 * Called by lifecycle hook when a session becomes idle.
 * Resolves any P2P waiters for that session immediately.
 */
export function notifySessionIdle(sessionName: string): void {
  const waiters = idleWaiters.get(sessionName);
  if (waiters && waiters.size > 0) {
    logger.info({ session: sessionName, waiters: waiters.size }, 'P2P: idle event received, resolving waiters');
    for (const resolve of waiters) resolve();
    waiters.clear();
  }
}

interface IdleWaiterHandle {
  promise: Promise<boolean>;
  cancel: () => void;
}

function waitForIdleEvent(session: string, timeoutMs: number): IdleWaiterHandle {
  let cancelFn: () => void = () => {};
  const promise = new Promise<boolean>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; cleanup(); resolve(false); }
    }, timeoutMs);

    const resolver: IdleResolver = () => {
      if (!resolved) { resolved = true; clearTimeout(timer); cleanup(); resolve(true); }
    };

    cancelFn = () => {
      if (!resolved) { resolved = true; clearTimeout(timer); cleanup(); resolve(false); }
    };

    function cleanup() {
      const set = idleWaiters.get(session);
      if (set) {
        set.delete(resolver);
        if (set.size === 0) idleWaiters.delete(session);
      }
    }

    let set = idleWaiters.get(session);
    if (!set) {
      set = new Set();
      idleWaiters.set(session, set);
    }
    set.add(resolver);
  });
  return { promise, cancel: cancelFn };
}

// ── Start a P2P run ───────────────────────────────────────────────────────

function buildHelperEligibleSnapshot(initiatorSession: string, targets: P2pTarget[]): P2pParticipantSnapshotEntry[] {
  const seen = new Set<string>();
  const names = [initiatorSession, ...targets.map((target) => target.session)];
  const snapshot: P2pParticipantSnapshotEntry[] = [];
  for (const sessionName of names) {
    if (seen.has(sessionName)) continue;
    seen.add(sessionName);
    const record = getSession(sessionName);
    snapshot.push({
      sessionName,
      agentType: record?.agentType ?? 'unknown',
      parentSession: record?.parentSession ?? null,
    });
  }
  return snapshot;
}

function normalizeStartP2pRunArgs(
  args: [
    StartP2pRunOptions
  ] | [
    string,
    P2pTarget[],
    string,
    Array<{ path: string; content: string }>,
    ServerLink | null,
    number | undefined,
    string | undefined,
    string | undefined,
    number | undefined,
  ],
): StartP2pRunOptions {
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && 'initiatorSession' in args[0]) {
    return args[0] as StartP2pRunOptions;
  }
  const [
    initiatorSession,
    targets,
    userText,
    fileContents,
    serverLink,
    rounds,
    extraPrompt,
    modeOverride,
    hopTimeoutMs,
  ] = args as [
    string,
    P2pTarget[],
    string,
    Array<{ path: string; content: string }>,
    ServerLink | null,
    number | undefined,
    string | undefined,
    string | undefined,
    number | undefined,
  ];
  return {
    initiatorSession,
    targets,
    userText,
    fileContents,
    serverLink,
    rounds,
    extraPrompt,
    modeOverride,
    hopTimeoutMs,
  };
}

export async function startP2pRun(...args:
  [StartP2pRunOptions] | [
    string,
    P2pTarget[],
    string,
    Array<{ path: string; content: string }>,
    ServerLink | null,
    number | undefined,
    string | undefined,
    string | undefined,
    number | undefined,
  ]
): Promise<P2pRun> {
  const opts = normalizeStartP2pRunArgs(args);
  // Audit:V-1 / N-H1 — when the caller supplies `advanced` (envelope-compiled
  // or supervision-internal), unpack the rounds/preset/timeout from there.
  // Otherwise fall back to the legacy `advancedPresetKey` / `advancedRounds`
  // top-level fields. This keeps cron and existing test fixtures working
  // while letting `prepareAdvancedWorkflowLaunch` and `supervision-automation`
  // funnel through the typed discriminated union.
  const advancedSource: StartP2pRunAdvancedSource | undefined = opts.advanced;
  const advancedPresetKey = advancedSource?.kind === 'supervision_internal'
    ? advancedSource.advancedPresetKey
    : opts.advancedPresetKey;
  const advancedRounds = advancedSource
    ? advancedSource.advancedRounds
    : opts.advancedRounds;
  const advancedRunTimeoutMs = advancedSource?.advancedRunTimeoutMs
    ?? opts.advancedRunTimeoutMs;
  const contextReducer = advancedSource?.kind === 'envelope_compiled'
    ? advancedSource.contextReducer
    : opts.contextReducer;
  const {
    initiatorSession,
    targets,
    userText,
    locale,
    fileContents,
    serverLink,
    rounds,
    extraPrompt,
    modeOverride,
    hopTimeoutMs,
  } = opts;
  // Validate same domain
  const mainSession = extractMainSession(initiatorSession);
  const admission = evaluateP2pLaunchAdmission({
    mainSession,
    origin: opts.launchOrigin,
    activeRuns: listP2pRuns(),
  });
  if (!admission.ok) {
    throw new Error(`p2p_launch_blocked:${admission.reason}:${admission.activeAutoDeliverRunId}`);
  }
  for (const t of targets) {
    if (extractMainSession(t.session) !== mainSession) {
      throw new Error(`Cross-domain P2P not supported: ${t.session} is not in ${mainSession}`);
    }
  }

  const helperEligibleSnapshot = buildHelperEligibleSnapshot(initiatorSession, targets);
  const resolvedPlan: P2pResolvedPlan = resolveP2pRoundPlan({
    modeOverride: modeOverride ?? targets[0]?.mode ?? 'discuss',
    roundsOverride: rounds,
    hopTimeoutMinutes: hopTimeoutMs != null ? Math.ceil(hopTimeoutMs / 60_000) : undefined,
    advancedPresetKey,
    advancedRounds,
    advancedRunTimeoutMinutes: advancedRunTimeoutMs != null ? Math.ceil(advancedRunTimeoutMs / 60_000) : undefined,
    contextReducer,
    participants: helperEligibleSnapshot,
  });
  const mode = modeOverride ?? targets[0]?.mode ?? 'discuss';
  const modeConfig = getP2pMode(isComboMode(mode) ? parseModePipeline(mode)[0] : mode);
  const runId = randomUUID().slice(0, 12);
  const discussionId = `dsc_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  // Create temp context file under project .imc/discussions/
  const record = getSession(initiatorSession);
  const projectDir = record?.projectDir || process.cwd();
  const p2pDir = await ensureImcDir(projectDir, 'discussions');
  await cleanupOrphanHopArtifacts(p2pDir);
  const contextFilePath = join(p2pDir, `${runId}.md`);

  let seed = `# P2P Discussion: ${runId}\n\n`;
  seed += `## User Request\n\n${userText}\n\n`;
  if (fileContents.length > 0) {
    seed += `## Referenced Files\n\n`;
    for (const f of fileContents) {
      if (f.content) {
        seed += `### ${f.path}\n\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
      } else {
        // Binary file (image, etc.) — include path so agents can read it with their tools
        seed += `### ${f.path}\n\n*(Binary file — read with your file viewer tool)*\n\n`;
      }
    }
  }
  await writeFile(contextFilePath, seed, 'utf8');

  const P2P_MAX_ROUNDS = 6;
  const totalRounds = resolvedPlan.advanced
    ? resolvedPlan.rounds.length
    : getLegacyExecutionRoundCount(mode, Math.min(P2P_MAX_ROUNDS, Math.max(1, rounds ?? 1)));
  const run: P2pRun = {
    id: runId,
    discussionId,
    mainSession,
    initiatorSession,
    currentTargetSession: null,
    finalReturnSession: initiatorSession,
    remainingTargets: [...targets],
    totalTargets: targets.length,
    mode,
    status: 'queued',
    runPhase: 'preparing',
    summaryPhase: null,
    activePhase: 'queued',
    contextFilePath,
    userText,
    locale,
    timeoutMs: Math.min(hopTimeoutMs ?? modeConfig?.defaultTimeoutMs ?? 300_000, 600_000),
    resultSummary: null,
    strictAuthoritativeResult: null,
    completedHops: [],
    skippedHops: [],
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    rounds: totalRounds,
    currentRound: 1,
    allTargets: [...targets],
    extraPrompt: extraPrompt ?? '',
    hopStartedAt: Date.now(),
    executionAttempt: 0,
    executionCycleCurrent: null,
    executionCycleTotal: null,
    executionMarkerPath: null,
    hopStates: [],
    activeTargetSessions: [],
    advancedP2pEnabled: resolvedPlan.advanced,
    resolvedRounds: resolvedPlan.advanced ? resolvedPlan.rounds : undefined,
    helperEligibleSnapshot: resolvedPlan.helperEligibleSnapshot ?? helperEligibleSnapshot,
    sharedActor: opts.sharedActor,
    shareScope: opts.shareScope,
    contextReducer: resolvedPlan.contextReducer,
    advancedRunTimeoutMs: resolvedPlan.advanced && resolvedPlan.overallRunTimeoutMinutes != null
      ? resolvedPlan.overallRunTimeoutMinutes * 60_000
      : undefined,
    deadlineAt: resolvedPlan.advanced && resolvedPlan.overallRunTimeoutMinutes != null
      ? Date.now() + (resolvedPlan.overallRunTimeoutMinutes * 60_000)
      : null,
    currentRoundId: resolvedPlan.advanced ? (resolvedPlan.rounds[0]?.id ?? null) : null,
    currentExecutionStep: 0,
    currentRoundAttempt: 1,
    roundAttemptCounts: {},
    roundJumpCounts: {},
    // R3 v1b follow-up — initialise mutable variable state from the
    // compiled workflow's declared variables so logic-node rules can read
    // defaults even before any script node has patched the map. We store
    // raw `value` because `P2pWorkflowVariableValue` widens to string |
    // number | boolean | string[].
    // R3 v2 PR-ζ (B1 / A5) — `runVariables` uses a null-prototype map so
    // any later write of `__proto__` / `constructor` / `prototype` becomes
    // a normal own property and does NOT touch the global Object.prototype
    // chain. Defence-in-depth alongside the orchestrator's write-path name
    // validation; even if the regex regresses, prototype pollution is
    // structurally impossible.
    runVariables: (() => {
      const initial = Object.create(null) as Record<string, unknown>;
      if (advancedSource?.kind === 'envelope_compiled') {
        for (const variable of advancedSource.bound.compiled.variables ?? []) {
          initial[variable.name] = variable.value;
        }
      }
      return initial;
    })(),
    routingHistory: [],
    helperDiagnostics: [],
    _cancelled: false,
    // Audit:V-1 / N-H1 / N2 / R3 PR-α — store the bound workflow ON THE RUN
    // so v1b dangerous-node executors can recheck against the live policy at
    // execution time (`recheckDangerousNodeCapabilities`). The
    // `capabilitySnapshot` and `policySnapshot` fields are convenience views;
    // the full `boundWorkflow.bindContext` is the canonical source.
    //
    // For supervision-internal escapes (no bound) and legacy passthrough we
    // leave these undefined; the recheck helper degrades to capability-string
    // comparison only.
    capabilitySnapshot: advancedSource?.kind === 'envelope_compiled'
      ? advancedSource.bound.bindContext.capabilitySnapshot
      : undefined,
    policySnapshot: advancedSource?.kind === 'envelope_compiled'
      ? advancedSource.bound.bindContext.policySnapshot
      : undefined,
    boundWorkflow: advancedSource?.kind === 'envelope_compiled'
      ? advancedSource.bound
      : undefined,
    advancedSourceKind: advancedSource?.kind,
    launchOrigin: opts.launchOrigin,
  };

  activeRuns.set(runId, run);
  pushState(run, serverLink);

  // Start the bookend chain in background
  void executeChain(run, modeConfig, serverLink).catch((err) => {
    logger.error({ err, runId }, 'P2P chain execution failed');
    failRun(run, 'dispatch_failed', String(err), serverLink);
  });

  return run;
}

// ── Cancel ────────────────────────────────────────────────────────────────

export interface P2pCancelOptions {
  source?: string;
  reason?: string;
  requestedBySession?: string | null;
}

export async function cancelP2pRun(runId: string, serverLink: ServerLink | null, options: P2pCancelOptions = {}): Promise<boolean> {
  const run = activeRuns.get(runId);
  const source = options.source ?? 'unknown';
  if (!run) {
    logger.warn({
      runId,
      source,
      reason: options.reason,
      requestedBySession: options.requestedBySession ?? null,
    }, 'P2P cancel requested for missing run');
    return false;
  }

  logger.info({
    runId,
    source,
    reason: options.reason,
    requestedBySession: options.requestedBySession ?? null,
    initiatorSession: run.initiatorSession,
    currentStatus: run.status,
    currentPhase: run.runPhase,
  }, 'P2P cancel requested');

  run._cancelled = true;
  run.runPhase = 'cancelled';

  // Audit fix (94b9b837-822 / N1) — abort any in-flight script-node child
  // process. `_cancelled` is invisible to a blocking `await
  // runP2pScriptNode(...)`; the AbortController sends SIGTERM (then
  // SIGKILL after 5 s grace) to the child process group so the await
  // settles instead of leaving the run stuck in `running` forever.
  const aborter = currentScriptAborters.get(runId);
  if (aborter) {
    try { aborter(); } catch { /* ignore — best effort */ }
  }

  if (run.status === 'queued') {
    run.activePhase = 'queued';
    transition(run, 'cancelled', serverLink);
    activeRuns.delete(runId);
    logger.info({ runId, source, reason: options.reason }, 'P2P queued run cancelled');
    return true;
  }

  if (!isTerminal(run.status)) {
    const targets = new Set(run.activeTargetSessions);
    if (run.currentTargetSession) targets.add(run.currentTargetSession);
    for (const target of targets) {
      try {
        const { sendKey } = await import('../agent/tmux.js');
        await sendKey(target, 'C-c');
      } catch { /* ignore */ }
    }
    run.activeTargetSessions = [];
    transition(run, 'cancelled', serverLink);
    activeRuns.delete(runId);
    logger.info({
      runId,
      source,
      reason: options.reason,
      targetCount: targets.size,
    }, 'P2P active run cancelled');
    return true;
  }

  activeRuns.delete(runId);
  logger.info({ runId, source, reason: options.reason, currentStatus: run.status }, 'P2P terminal run removed after cancel request');
  return true;
}

// ── Resume after daemon restart ───────────────────────────────────────────

export async function resumePendingOrchestrations(serverLink: ServerLink | null): Promise<void> {
  // R3 v1b follow-up — Always rehydrate persisted artifact identities at
  // daemon startup, even when serverLink is null (test harness / disconnected
  // daemon). This restores the spec invariant "identity preserved across
  // retry/re-entry": an in-flight run picked up after restart finds its
  // existing frozen identity and re-uses the same slug-N suffix instead of
  // producing a fresh one.
  try {
    const loaded = await loadPersistedFrozenP2pArtifactIdentities();
    if (loaded > 0) logger.info({ loaded }, 'P2P: rehydrated persisted artifact identities');
  } catch (err) {
    logger.warn({ err }, 'P2P: failed to rehydrate persisted artifact identities');
  }
  if (!serverLink) return;
  try {
    // Query server for active runs — the server handles this via WS request/response
    // For now, we just log. Full implementation needs a WS request pattern.
    logger.info({}, 'P2P: checking for pending orchestrations to resume');
    // TODO: query server for active runs and resume monitoring
  } catch (err) {
    logger.warn({ err }, 'P2P: failed to resume pending orchestrations');
  }
}

// ── Chain execution ───────────────────────────────────────────────────────

function buildRoundHopArtifactPath(run: P2pRun, roundIndex: number, hopIndex: number): string {
  return join(dirname(run.contextFilePath), `${run.id}.round${roundIndex}.hop${hopIndex}.md`);
}

const ORPHAN_ARTIFACT_MIN_AGE_MS = 6 * 60 * 60_000;

async function cleanupOrphanHopArtifacts(discussionsDir: string): Promise<void> {
  try {
    const entries = await readdir(discussionsDir);
    const now = Date.now();
    await Promise.all(entries
      .filter((name) => /\.round\d+\.hop\d+\.md$/.test(name))
      .map(async (name) => {
        const fullPath = join(discussionsDir, name);
        try {
          const info = await stat(fullPath);
          if ((now - info.mtimeMs) < ORPHAN_ARTIFACT_MIN_AGE_MS) return;

          const match = name.match(/^([^.]+)\.round\d+\.hop\d+\.md$/);
          const runId = match?.[1] ?? null;
          if (runId && activeRuns.has(runId)) return;

          if (runId) {
            const mainPath = join(discussionsDir, `${runId}.md`);
            try {
              const mainInfo = await stat(mainPath);
              if ((now - mainInfo.mtimeMs) < ORPHAN_ARTIFACT_MIN_AGE_MS) return;
            } catch {
              // missing main file is acceptable for stale orphan cleanup
            }
          }

          await unlink(fullPath);
        } catch {
          /* ignore */
        }
      }));
  } catch {
    /* ignore */
  }
}

async function createRoundHopStates(run: P2pRun, targets: P2pTarget[], roundModeKey: string): Promise<P2pHopRuntime[]> {
  const baselineBuffer = await readFile(run.contextFilePath);
  const baselineSize = baselineBuffer.length;
  const baselineContent = baselineBuffer.toString('utf8');
  const combo = isComboMode(run.mode);
  const roundHops: P2pHopRuntime[] = [];
  for (let idx = 0; idx < targets.length; idx++) {
    const target = targets[idx];
    const artifactPath = buildRoundHopArtifactPath(run, run.currentRound, idx + 1);
    await copyFile(run.contextFilePath, artifactPath);
    roundHops.push({
      hop_index: ((run.currentRound - 1) * Math.max(run.totalTargets, 1)) + idx + 1,
      round_index: run.currentRound,
      session: target.session,
      mode: combo ? roundModeKey : target.mode,
      status: 'queued',
      started_at: null,
      completed_at: null,
      error: null,
      output_path: artifactPath,
      section_header: '',
      artifact_path: artifactPath,
      working_path: null,
      baseline_size: baselineSize,
      baseline_content: baselineContent,
    });
  }
  run.hopStates = [
    ...run.hopStates.filter((hop) => hop.round_index !== run.currentRound),
    ...roundHops,
  ];
  return roundHops;
}

function extractHeadingSection(content: string, sectionHeader: string): string | null {
  if (!sectionHeader) return null;
  const heading = `## ${sectionHeader}`;
  const start = content.lastIndexOf(heading);
  if (start < 0) return null;
  return content.slice(start);
}

function extractBestEffortEvidence(hop: P2pHopRuntime, content: string): string | null {
  const headingSection = extractHeadingSection(content, hop.section_header);
  if (headingSection?.trim()) return headingSection;

  if (content.startsWith(hop.baseline_content)) {
    const appended = content.slice(hop.baseline_content.length);
    if (appended.trim()) return appended;
  }

  let prefix = 0;
  const limit = Math.min(hop.baseline_content.length, content.length);
  while (prefix < limit && hop.baseline_content[prefix] === content[prefix]) prefix += 1;
  const tail = content.slice(prefix);
  if (tail.trim()) return tail;

  return content.trim() ? content : null;
}

async function appendRoundEvidence(run: P2pRun, roundHops: P2pHopRuntime[]): Promise<void> {
  for (const hop of [...roundHops].sort((a, b) => a.hop_index - b.hop_index)) {
    if (hop.status !== 'completed') continue;
    const buffer = await readFile(hop.artifact_path);
    let evidence: string | null = null;
    if (buffer.length > hop.baseline_size) {
      const exactAppended = buffer.subarray(hop.baseline_size).toString('utf8');
      if (exactAppended.trim()) evidence = exactAppended;
    }
    if (!evidence) {
      const content = buffer.toString('utf8');
      evidence = extractBestEffortEvidence(hop, content);
      if (evidence) {
        logger.warn({ runId: run.id, session: hop.session, artifact: hop.artifact_path }, 'P2P: using best-effort evidence extraction fallback');
      }
    }
    if (!evidence?.trim()) continue;
    await appendFile(run.contextFilePath, evidence.startsWith('\n') ? evidence : `\n${evidence}`, 'utf8');
  }
}

async function cleanupRoundHopArtifacts(roundHops: P2pHopRuntime[]): Promise<void> {
  await Promise.all(roundHops.flatMap((hop) => {
    const paths = [hop.artifact_path];
    if (hop.working_path && hop.working_path !== hop.artifact_path) paths.push(hop.working_path);
    return paths.map(async (path) => {
      try { await unlink(path); } catch { /* ignore */ }
    });
  }));
}

interface PostSummaryExecutionGateOptions {
  cycleIndex: number;
  cycleTotal: number;
  timeoutMs?: number;
  initialPromptAlreadyDispatched?: boolean;
  spec?: PostSummaryExecutionRuntimeSpec;
}

interface PostSummaryExecutionRuntimeSpec extends PostSummaryExecutionPromptSpec {
  markerPath: string;
}

function createPostSummaryExecutionSpec(run: P2pRun, options: PostSummaryExecutionGateOptions): PostSummaryExecutionRuntimeSpec {
  return {
    runId: run.id,
    cycleIndex: options.cycleIndex,
    cycleTotal: options.cycleTotal,
    nonce: randomUUID(),
    markerPath: join(dirname(run.contextFilePath), `${run.id}.cycle${options.cycleIndex}.execution-marker.json`),
  };
}

function createPostSummaryExecutionConfirmationSpec(run: P2pRun, spec: PostSummaryExecutionRuntimeSpec): PostSummaryExecutionRuntimeSpec {
  return {
    runId: run.id,
    cycleIndex: spec.cycleIndex,
    cycleTotal: spec.cycleTotal,
    nonce: randomUUID(),
    markerPath: join(dirname(run.contextFilePath), `${run.id}.cycle${spec.cycleIndex}.execution-confirmation-marker.json`),
  };
}

async function readPostSummaryExecutionMarker(spec: PostSummaryExecutionRuntimeSpec): Promise<ReturnType<typeof validateP2pExecutionMarkerContent> | null> {
  try {
    return validateP2pExecutionMarkerContent(await readFile(spec.markerPath, 'utf8'), spec);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    logger.warn({ markerPath: spec.markerPath, err }, 'P2P: failed to read post-summary execution marker');
    return { ok: false, reason: 'marker_read_failed' };
  }
}

async function appendPostSummaryExecutionAudit(
  run: P2pRun,
  spec: PostSummaryExecutionRuntimeSpec,
  marker: P2pExecutionMarker,
  attempts: number,
  heading = `P2P Original Request Execution Confirmed (cycle ${spec.cycleIndex}/${spec.cycleTotal})`,
): Promise<void> {
  const lines = [
    '',
    `## ${heading}`,
    '',
    `Marker file: ${spec.markerPath}`,
    `Status: ${marker.status}`,
    `Attempts: ${attempts}`,
    marker.summary ? `Summary: ${marker.summary}` : null,
    marker.changedFiles?.length ? `Changed files: ${marker.changedFiles.join(', ')}` : null,
    marker.tests?.length ? `Tests: ${marker.tests.join(', ')}` : null,
    marker.completedAt ? `Completed at: ${marker.completedAt}` : null,
    '',
  ].filter((line): line is string => line !== null);
  try {
    await flushP2pDiscussionWriteQueue(run.contextFilePath);
    await appendFile(run.contextFilePath, `\n${lines.join('\n')}`, 'utf8');
  } catch (err) {
    logger.warn({ runId: run.id, markerPath: spec.markerPath, err }, 'P2P: failed to append post-summary execution audit');
  }
}

async function readDiscussionTail(filePath: string, maxBytes: number): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(filePath, 'r');
    const { size } = await fh.stat();
    if (size <= 0) return '';
    const length = Math.min(maxBytes, size);
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function buildPreviousCycleAuditScopeInstruction(
  run: P2pRun,
  previousCycleIndex: number,
  cycleTotal: number,
): Promise<string> {
  let previousOutputExcerpt = '';
  try {
    previousOutputExcerpt = (await readDiscussionTail(run.contextFilePath, P2P_PREVIOUS_CYCLE_AUDIT_SCOPE_TAIL_BYTES))
      .slice(-P2P_PREVIOUS_CYCLE_AUDIT_SCOPE_MAX_CHARS)
      .trim();
  } catch (err) {
    logger.warn({ runId: run.id, contextFilePath: run.contextFilePath, err }, 'P2P: failed to read previous cycle audit scope');
  }

  const scopeLines = [
    `Previous cycle audit scope:`,
    `- This is a new complete flow cycle. Treat cycle ${previousCycleIndex}/${cycleTotal} outputs as the primary audit scope for this initial analysis.`,
    `- The previous cycle scope includes discussion evidence, the cycle summary, and the original-request execution result already appended to the discussion file.`,
    `- First audit those previous outputs against the user's original request, then identify what the next participants should verify, deepen, or fix.`,
  ];

  if (previousOutputExcerpt) {
    scopeLines.push(
      '',
      `Previous cycle output excerpt:`,
      '```markdown',
      previousOutputExcerpt,
      '```',
    );
  } else {
    scopeLines.push(`- If the excerpt is unavailable, read the full discussion file and audit the latest completed cycle before continuing.`);
  }

  return scopeLines.join('\n');
}

async function dispatchPostSummaryExecutionAttempt(
  run: P2pRun,
  spec: PostSummaryExecutionRuntimeSpec,
  attempt: number,
  deadlineAt: number,
): Promise<boolean> {
  const prompt = buildPostSummaryExecutionPrompt(run, spec, { attempt, deadlineAt });
  return dispatchPostSummaryPrompt(run, prompt, attempt, 'P2P: failed to dispatch post-summary execution prompt');
}

async function dispatchPostSummaryExecutionConfirmationAttempt(
  run: P2pRun,
  executionSpec: PostSummaryExecutionRuntimeSpec,
  executionMarker: P2pExecutionMarker,
  spec: PostSummaryExecutionRuntimeSpec,
  attempt: number,
  deadlineAt: number,
): Promise<boolean> {
  const prompt = buildPostSummaryExecutionConfirmationPrompt(run, executionSpec, executionMarker, spec, { attempt, deadlineAt });
  return dispatchPostSummaryPrompt(run, prompt, attempt, 'P2P: failed to dispatch post-summary execution confirmation prompt');
}

async function dispatchPostSummaryPrompt(
  run: P2pRun,
  prompt: string,
  attempt: number,
  failureLogMessage: string,
): Promise<boolean> {
  const session = run.initiatorSession;
  try {
    await dispatchP2pPromptToSession({
      run,
      session,
      prompt,
      allowDuplicate: true,
      reason: 'post_summary_prompt',
    });
    return true;
  } catch (err) {
    logger.warn({ runId: run.id, session, attempt, err }, failureLogMessage);
    return false;
  }
}

async function isPostSummaryMarkerRetryReady(
  run: P2pRun,
  session: string,
  dispatchStartedAt: number,
): Promise<boolean> {
  if (Date.now() - dispatchStartedAt < MARKER_PROMPT_RETRY_AFTER_MS) return false;

  const transportRuntime = getTransportRuntime(session);
  if (transportRuntime) {
    const snapshot = transportRuntime.getDiagnosticSnapshot(Date.now());
    if (snapshot.sending || snapshot.pendingCount > 0 || snapshot.activeDispatchCount > 0) return false;
    return snapshot.status === 'idle' || snapshot.status === 'error';
  }

  if (Date.now() - dispatchStartedAt < MIN_PROCESSING_MS) return false;
  const record = getSession(session);
  const agentType = (record?.agentType ?? 'claude-code') as import('../agent/detect.js').AgentType;
  const useStoreState = agentType === 'gemini';
  try {
    return useStoreState
      ? record?.state === 'idle'
      : await detectStatusAsync(session, agentType) === 'idle';
  } catch (err) {
    logger.debug({ runId: run.id, session, err }, 'P2P: idle detection failed while waiting to retry marker prompt');
    return false;
  }
}

async function runPostSummaryExecutionConfirmationGate(
  run: P2pRun,
  serverLink: ServerLink | null,
  executionSpec: PostSummaryExecutionRuntimeSpec,
  executionMarker: P2pExecutionMarker,
  timeoutMs: number,
): Promise<{ spec: PostSummaryExecutionRuntimeSpec; marker: P2pExecutionMarker; attempts: number } | null> {
  const session = run.initiatorSession;
  const spec = createPostSummaryExecutionConfirmationSpec(run, executionSpec);
  const deadlineAt = Date.now() + timeoutMs;
  let attempt = 0;
  let dispatchStartedAt = Date.now();
  let queueStopSent = false;

  const sendAttempt = async () => {
    attempt += 1;
    dispatchStartedAt = Date.now();
    run.runPhase = 'executing_original_request';
    run.activePhase = 'execution';
    run.hopStartedAt = dispatchStartedAt;
    run.executionAttempt = attempt;
    run.executionCycleCurrent = spec.cycleIndex;
    run.executionCycleTotal = spec.cycleTotal;
    run.executionMarkerPath = spec.markerPath;
    pushState(run, serverLink);
    return dispatchPostSummaryExecutionConfirmationAttempt(run, executionSpec, executionMarker, spec, attempt, deadlineAt);
  };

  if (!await sendAttempt()) {
    failRun(run, 'dispatch_failed', 'post_summary_execution_confirmation_dispatch_failed', serverLink);
    return null;
  }

  while (Date.now() < deadlineAt) {
    if (run._cancelled || isTerminal(run.status)) return null;
    if (!ensureRunDeadline(run, serverLink)) return null;

    const markerState = await readPostSummaryExecutionMarker(spec);
    if (markerState?.ok) {
      logger.info({ runId: run.id, cycleIndex: spec.cycleIndex, cycleTotal: spec.cycleTotal, attempts: attempt }, 'P2P: post-summary execution confirmation marker confirmed');
      return { spec, marker: markerState.marker, attempts: attempt };
    }
    if (markerState && !markerState.ok) {
      if (markerState.failedByAgent) {
        failRun(run, 'post_summary_execution_confirmation_failed', markerState.reason, serverLink);
        return null;
      }
    }

    queueStopSent = await maybeStopStaleP2pTransportQueue({
      run,
      session,
      dispatchStartedAt,
      alreadyStopped: queueStopSent,
      reason: 'confirmation_marker_missing',
    });
    if (await isPostSummaryMarkerRetryReady(run, session, dispatchStartedAt)) {
      logger.warn(
        { runId: run.id, session, attempt, markerPath: spec.markerPath },
        'P2P: confirmation marker still missing after queue-aware idle — retrying confirmation prompt',
      );
      if (await sendAttempt()) queueStopSent = false;
    }
    await sleep(Math.min(IDLE_POLL_MS, Math.max(1, deadlineAt - Date.now())));
  }

  logger.warn({ runId: run.id, session, timeoutMs, markerPath: spec.markerPath }, 'P2P: post-summary execution confirmation marker timed out');
  failRun(run, 'timed_out', 'post_summary_execution_confirmation_timeout', serverLink);
  return null;
}

async function runPostSummaryExecutionGate(
  run: P2pRun,
  serverLink: ServerLink | null,
  options: PostSummaryExecutionGateOptions,
): Promise<boolean> {
  const session = run.initiatorSession;
  const timeoutMs = Math.max(1, options.timeoutMs ?? (run.timeoutMs * 3));
  const deadlineAt = Date.now() + timeoutMs;
  const spec = options.spec ?? createPostSummaryExecutionSpec(run, options);
  let attempt = 0;
  let dispatchStartedAt = Date.now();
  let queueStopSent = false;

  const sendAttempt = async () => {
    attempt += 1;
    dispatchStartedAt = Date.now();
    run.runPhase = 'executing_original_request';
    run.activePhase = 'execution';
    run.hopStartedAt = dispatchStartedAt;
    run.executionAttempt = attempt;
    run.executionCycleCurrent = spec.cycleIndex;
    run.executionCycleTotal = spec.cycleTotal;
    run.executionMarkerPath = spec.markerPath;
    pushState(run, serverLink);
    return dispatchPostSummaryExecutionAttempt(run, spec, attempt, deadlineAt);
  };

  if (options.initialPromptAlreadyDispatched) {
    attempt = 1;
    dispatchStartedAt = Date.now();
    run.runPhase = 'executing_original_request';
    run.activePhase = 'execution';
    run.hopStartedAt = dispatchStartedAt;
    run.executionAttempt = attempt;
    run.executionCycleCurrent = spec.cycleIndex;
    run.executionCycleTotal = spec.cycleTotal;
    run.executionMarkerPath = spec.markerPath;
    pushState(run, serverLink);
  } else if (!await sendAttempt()) {
    failRun(run, 'dispatch_failed', 'post_summary_execution_dispatch_failed', serverLink);
    return false;
  }

  while (Date.now() < deadlineAt) {
    if (run._cancelled || isTerminal(run.status)) return false;
    if (!ensureRunDeadline(run, serverLink)) return false;

    const markerState = await readPostSummaryExecutionMarker(spec);
    if (markerState?.ok) {
      const confirmationDelayMs = Math.min(
        POST_SUMMARY_CONFIRMATION_DELAY_MS,
        Math.max(0, deadlineAt - Date.now() - 1),
      );
      if (confirmationDelayMs > 0) {
        await sleep(confirmationDelayMs);
        if (run._cancelled || isTerminal(run.status)) return false;
        if (!ensureRunDeadline(run, serverLink)) return false;
      }
      const confirmation = await runPostSummaryExecutionConfirmationGate(run, serverLink, spec, markerState.marker, timeoutMs);
      if (!confirmation) return false;
      await appendPostSummaryExecutionAudit(run, spec, markerState.marker, attempt);
      await appendPostSummaryExecutionAudit(
        run,
        confirmation.spec,
        confirmation.marker,
        confirmation.attempts,
        `P2P Original Request Execution Reconfirmed (cycle ${confirmation.spec.cycleIndex}/${confirmation.spec.cycleTotal})`,
      );
      logger.info({ runId: run.id, cycleIndex: spec.cycleIndex, cycleTotal: spec.cycleTotal, attempts: attempt }, 'P2P: post-summary execution marker confirmed');
      return true;
    }
    if (markerState && !markerState.ok) {
      if (markerState.failedByAgent) {
        failRun(run, 'post_summary_execution_failed', markerState.reason, serverLink);
        return false;
      }
    }

    queueStopSent = await maybeStopStaleP2pTransportQueue({
      run,
      session,
      dispatchStartedAt,
      alreadyStopped: queueStopSent,
      reason: 'execution_marker_missing',
    });
    if (await isPostSummaryMarkerRetryReady(run, session, dispatchStartedAt)) {
      logger.warn(
        { runId: run.id, session, attempt, markerPath: spec.markerPath },
        'P2P: execution marker still missing after queue-aware idle — retrying post-summary execution prompt',
      );
      if (await sendAttempt()) queueStopSent = false;
    }
    await sleep(Math.min(IDLE_POLL_MS, Math.max(1, deadlineAt - Date.now())));
  }

  logger.warn({ runId: run.id, session, timeoutMs, markerPath: spec.markerPath }, 'P2P: post-summary execution marker timed out');
  failRun(run, 'timed_out', 'post_summary_execution_timeout', serverLink);
  return false;
}

function scheduleRoundHopArtifactCleanup(roundHops: P2pHopRuntime[]): void {
  if (roundHops.length === 0) return;
  if (ROUND_HOP_CLEANUP_DELAY_MS <= 0) {
    void cleanupRoundHopArtifacts(roundHops);
    return;
  }
  setTimeout(() => { void cleanupRoundHopArtifacts(roundHops); }, ROUND_HOP_CLEANUP_DELAY_MS);
}

function updateHopStatus(run: P2pRun, hop: P2pHopRuntime | null | undefined, status: P2pHopStatus, error: string | null = null): void {
  if (!hop) return;
  hop.status = status;
  hop.error = error;
  if (status === 'dispatched' || status === 'running') {
    hop.started_at = Date.now();
    run.hopStartedAt = hop.started_at;
  }
  if (P2P_TERMINAL_HOP_STATUSES.has(status)) {
    hop.completed_at = new Date().toISOString();
  }
}

async function executeChain(run: P2pRun, modeConfig: P2pMode | undefined, serverLink: ServerLink | null): Promise<void> {
  if (run.advancedP2pEnabled && run.resolvedRounds?.length) {
    await executeAdvancedChain(run, serverLink);
    return;
  }
  const totalHops = run.allTargets.length;

  // ── Multi-round loop ──
  const combo = isComboMode(run.mode);
  const pipelineLength = combo ? Math.max(1, parseModePipeline(run.mode).length) : 1;
  for (; run.currentRound <= run.rounds; run.currentRound++) {
    if (run._cancelled || isTerminal(run.status)) return;
    run.runPhase = 'round_execution';
    run.summaryPhase = null;

    // For combo pipelines, resolve this round's mode; for single modes, use the fixed config
    const roundModeConfig = combo ? getLegacyModeForExecutionRound(run.mode, run.currentRound) : modeConfig;
    const roundModeKey = combo ? getLegacyModeKeyForExecutionRound(run.mode, run.currentRound) : run.mode;
    const rp = roundPrompt(run.currentRound, run.rounds, combo ? roundModeKey : undefined);
    const roundLabel = run.rounds > 1 ? ` (round ${run.currentRound}/${run.rounds})` : '';
    const isFlowCycleStart = ((run.currentRound - 1) % pipelineLength) === 0;
    const currentFlowCycle = Math.ceil(run.currentRound / pipelineLength);
    const flowCycleTotal = Math.ceil(run.rounds / pipelineLength);
    const previousCycleAuditScope = isFlowCycleStart && currentFlowCycle > 1
      ? await buildPreviousCycleAuditScopeInstruction(run, currentFlowCycle - 1, flowCycleTotal)
      : '';

    // Restore full target list for this round (skipped sessions are not retried)
    if (run.currentRound > 1) {
      run.remainingTargets = [...run.allTargets];
      logger.info({ runId: run.id, round: run.currentRound, totalRounds: run.rounds, roundMode: roundModeKey }, 'P2P: starting new round');
    }

    const targets = [...run.remainingTargets];

    // ── Phase 1: Initiator kickoff analysis for this round ──
    // Every round needs an explicit initiator pass. Later rounds are not a
    // repeat of round 1: they audit prior findings plus any execution evidence
    // before participant hops deepen the discussion.
    if (run._cancelled) return;
    run.activePhase = 'initial';
    const initialHeader = `${discussionParticipantNameWithMode(run.initiatorSession, roundModeKey)} — Initial Analysis${roundLabel}`;
    const initialInstruction = run.currentRound === 1
      ? 'Read the discussion file and provide your initial analysis. Append your output to the file.'
      : 'Read the discussion file, review all previous round outputs and any implementation/execution evidence, then provide the initiator kickoff analysis for this round. Call out what prior findings were weak, incomplete, contradicted, or still need deeper investigation. Append your output to the file.';
    const initialPrompt = buildHopPrompt(run, roundModeConfig, {
      session: run.initiatorSession,
      sectionHeader: initialHeader,
      instruction: [
        previousCycleAuditScope,
        `${initialInstruction}\nIMPORTANT: This is ANALYSIS ONLY. Do NOT implement fixes, do NOT edit code files, do NOT run commands. Only write your analysis into this discussion file.`,
      ].filter(Boolean).join('\n\n'),
      isInitial: true,
    }, rp);
    const initialOk = await dispatchHop(run, run.initiatorSession, initialPrompt, serverLink, { sectionHeader: initialHeader, required: true });
    if (!initialOk && (run._cancelled || isTerminal(run.status))) return;
    if (run._cancelled || isTerminal(run.status)) return;

    // ── Phase 2: Sub-session hops ──
    run.activePhase = 'hop';
    const roundHops = await createRoundHopStates(run, targets, roundModeKey);
    try {
      run.activeTargetSessions = roundHops.map((hop) => hop.session);
      const hopResults = await Promise.allSettled(targets.map(async (target, i) => {
        if (run._cancelled) return false;
        const hop = roundHops[i];
        const hopMode = combo ? roundModeKey : target.mode;
        const hopLabel = `${discussionParticipantName(target.session)} — ${capitalize(hopMode)} (hop ${i + 1}/${totalHops}${roundLabel})`;
        hop.section_header = hopLabel;
        const hopModeConfig = combo ? roundModeConfig : (getP2pMode(target.mode) ?? modeConfig);
        const hopInstruction = [
          previousCycleAuditScope,
          `Read the discussion file and provide your ${hopMode} analysis. Append your output to the file.\nIMPORTANT: This is ANALYSIS ONLY. Do NOT implement fixes, do NOT edit code files, do NOT run commands. Only write your analysis into this discussion file.`,
        ].filter(Boolean).join('\n\n');
        const hopPrompt = buildHopPrompt(run, hopModeConfig, {
          session: target.session,
          sectionHeader: hopLabel,
          instruction: hopInstruction,
          isInitial: false,
          filePath: hop.artifact_path,
        }, rp);
        logger.info({ runId: run.id, target: target.session, mode: hopMode, hop: i + 1, totalHops, round: run.currentRound }, 'P2P: Phase 2 — dispatching hop');
        return dispatchHop(run, target.session, hopPrompt, serverLink, {
          sectionHeader: hopLabel,
          hop,
          filePath: hop.artifact_path,
        });
      }));
      run.activeTargetSessions = [];
      run.currentTargetSession = null;
      if (run._cancelled || isTerminal(run.status)) return;
      logger.info({
        runId: run.id,
        round: run.currentRound,
        settled: hopResults.length,
        completed: roundHops.filter((hop) => hop.status === 'completed').length,
      }, 'P2P: Phase 2 — round barrier settled');
      await appendRoundEvidence(run, roundHops);
      if (run._cancelled || isTerminal(run.status)) return;

      run.remainingTargets = [];

      // ── Round summary: Initiator synthesizes this round ──
      if (run._cancelled) return;
      run.runPhase = 'summarizing';
      run.summaryPhase = 'running';
      run.activePhase = 'summary';
      const isLastRound = run.currentRound === run.rounds;
      const isFlowCycleEnd = (run.currentRound % pipelineLength) === 0;
      const shouldRunExecutionGate = isFlowCycleEnd || isLastRound;
      const inlineExecutionSpec = shouldRunExecutionGate
        ? createPostSummaryExecutionSpec(run, {
          cycleIndex: Math.ceil(run.currentRound / pipelineLength),
          cycleTotal: Math.ceil(run.rounds / pipelineLength),
        })
        : null;
      const summaryModeConfig = isLastRound && combo
        ? getLegacyModeForExecutionRound(run.mode, run.rounds) // last pipeline mode for final summary
        : roundModeConfig;
      const roundSummaryHeader = isLastRound
        ? `${discussionParticipantNameWithMode(run.initiatorSession, roundModeKey)} — Final Summary`
        : `${discussionParticipantNameWithMode(run.initiatorSession, roundModeKey)} — Round ${run.currentRound}/${run.rounds} Summary`;
      const inlineExecutionInstruction = inlineExecutionSpec
        ? `\n\n${buildInlinePostSummaryExecutionInstruction(run, inlineExecutionSpec)}`
        : '';
      const nonFinalSummaryGuard = inlineExecutionSpec
        ? 'For the summary/kickoff portion, write analysis only into the discussion file first. After that section is written, follow the execution block below in the same turn.'
        : 'IMPORTANT: This is ANALYSIS ONLY. Do NOT implement fixes, do NOT edit code files, do NOT run commands. Only write your analysis into this discussion file.';
      const roundSummaryInstruction = isLastRound
        ? `${summaryModeConfig?.summaryPrompt ?? 'Synthesize a final summary that captures the consensus, key decisions, and any remaining disagreements across all rounds.'}\nBefore writing the summary, use the hop evidence already appended into the discussion file for this round. If the user context clearly specifies a destination file for the final plan, write the complete plan there. Otherwise, write the complete plan at the end of the discussion file.${inlineExecutionInstruction}`
        : `Synthesize the key points, areas of agreement, and open questions from this round. Then assign specific focus areas or questions for each participant in the next round (round ${run.currentRound + 1}). This summary prepares the next round, but the orchestrator will still dispatch a separate next-round initiator initial-analysis prompt before participant hops. Append to the file.\n${nonFinalSummaryGuard}${inlineExecutionInstruction}`;
      const roundSummaryPrompt = buildHopPrompt(run, summaryModeConfig, {
        session: run.initiatorSession,
        sectionHeader: roundSummaryHeader,
        instruction: `${roundSummaryInstruction}\nThe orchestrator has already appended each completed hop's evidence into the discussion file. If you write the final plan to another file, still append a short completion note under the new final-summary heading in the discussion file that records the chosen output file path.`,
        isInitial: false,
        allowsExecution: inlineExecutionSpec !== null,
      }, rp);
      logger.info({ runId: run.id, round: run.currentRound, isLastRound, roundMode: roundModeKey }, isLastRound ? 'P2P: Final summary — initiator' : 'P2P: Round summary — initiator');
      const summaryOk = await dispatchHop(run, run.initiatorSession, roundSummaryPrompt, serverLink, {
        sectionHeader: roundSummaryHeader,
        required: true,
        executionMarkerSpec: inlineExecutionSpec,
      });
      if (!summaryOk && (run._cancelled || isTerminal(run.status))) return;
      run.summaryPhase = summaryOk ? 'completed' : 'failed';
      if (run._cancelled || isTerminal(run.status)) return;
      if (inlineExecutionSpec) {
        const executionOk = await runPostSummaryExecutionGate(run, serverLink, {
          cycleIndex: inlineExecutionSpec.cycleIndex,
          cycleTotal: inlineExecutionSpec.cycleTotal,
          timeoutMs: run.timeoutMs * 3,
          spec: inlineExecutionSpec,
          initialPromptAlreadyDispatched: true,
        });
        if (run._cancelled || isTerminal(run.status)) return;
        if (!executionOk) return;
      }
    } finally {
      scheduleRoundHopArtifactCleanup(roundHops);
    }
  }
  if (run._cancelled || isTerminal(run.status)) return;

  // ── Done ──
  // Read only the trailing 2 KiB (enough to over-cover the 2000-char
  // summary window once UTF-8 decoded) instead of slurping the whole
  // discussion file — multi-round discussions across several hops can
  // produce megabytes of markdown, and this used to allocate a V8
  // string sized to the full file just to slice off the last 2000
  // chars, exactly the same shape bug we fixed in transport-history.
  try {
    const P2P_TAIL_BYTES = 2 * 1024;
    let fh;
    try {
      fh = await open(run.contextFilePath, 'r');
      const { size } = await fh.stat();
      if (size > 0) {
        const length = Math.min(P2P_TAIL_BYTES, size);
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, size - length);
        // Drop the leading partial UTF-8 sequence if any; 2000 chars
        // downstream further trims to exactly the wanted window.
        const summary = buf.toString('utf8').slice(-2000);
        run.resultSummary = summary;
      }
    } finally {
      if (fh) { try { await fh.close(); } catch { /* best-effort */ } }
    }
  } catch { /* ignore — discussion file may not exist if cancelled early */ }

  run.completedAt = new Date().toISOString();
  transition(run, 'completed', serverLink);

  // Emit discussion result to initiator session timeline (summary only, not full content)
  const skippedNote = run.skippedHops.length > 0
    ? `\n\n**Warning**: ${run.skippedHops.length} hop(s) skipped: ${run.skippedHops.join(', ')}`
    : '';
  timelineEmitter.emit(run.initiatorSession, 'assistant.text', {
    text: `**P2P Discussion Complete** (${run.id})${skippedNote}\n\nFile: \`${run.contextFilePath}\`\n\n${run.resultSummary ?? '(no summary)'}`,
    p2pRunId: run.id,
    p2pDiscussionId: run.discussionId,
    skippedHops: run.skippedHops,
  }, { source: 'daemon' });

  // Keep in memory for a bit so status queries work, then clean up run entry only.
  // Discussion files are kept on disk (in .imc/discussions/) for history access.
  // A3: `activeRuns.delete` is now scheduled by `scheduleP2pRunTerminalCleanup`
  // (called from `transition('completed')` above), so no explicit timer here.
}

// Audit:R3 hardening / task 10.6 — diagnostic retention.
//
// Long-running advanced workflows can accumulate hundreds of helper
// diagnostics (one per round attempt × node × loop). Without bounds the
// `P2pRun` object grows monotonically, the projection blob grows past
// `P2P_SANITIZE_MAX_TOTAL_BYTES` and starts truncating at the sanitizer,
// and the `serializeP2pRun` payload exceeds frontend rendering budgets.
//
// Retention policy (stable ordering):
//  - `P2P_HELPER_DIAGNOSTIC_RETENTION_COUNT` total entries kept per run.
//  - When over count, drop the OLDEST entries first (FIFO). The most-recent
//    entries are most useful for failure forensics; the oldest are usually
//    transient warnings from earlier rounds.
//  - `P2P_HELPER_DIAGNOSTIC_RETENTION_BYTES` total JSON-stringified byte
//    budget. When exceeded, drop additional oldest entries until under
//    budget. Single oversized entries still apply but are themselves
//    truncated by the sanitizer downstream.
//  - Stable ordering: insertion order preserved among retained entries.
const P2P_HELPER_DIAGNOSTIC_RETENTION_COUNT = 100;
const P2P_HELPER_DIAGNOSTIC_RETENTION_BYTES = 64 * 1024; // 64 KiB / run

/**
 * Audit fix (94b9b837-822 / A2) — bound `run.routingHistory` with a FIFO
 * trim, mirroring the count-cap part of `addHelperDiagnostic`. Long-running
 * advanced workflows that loop through compiled-edge jumps push to
 * `routingHistory` on every jump and default-edge advance with no upper
 * bound; combined with the projection-flush spread `[...routingHistory]`
 * per debounce tick this is a real per-run growth source.
 *
 * Stable ordering: the most recent {@link P2P_ROUTING_HISTORY_RETENTION_COUNT}
 * entries are retained — the oldest are dropped first.
 */
function pushRoutingHistory(run: P2pRun, entry: P2pRun['routingHistory'][number]): void {
  run.routingHistory.push(entry);
  while (run.routingHistory.length > P2P_ROUTING_HISTORY_RETENTION_COUNT) {
    run.routingHistory.shift();
  }
}

function addHelperDiagnostic(run: P2pRun, diagnostic: Omit<P2pHelperDiagnostic, 'timestamp'>): void {
  run.helperDiagnostics.push({ ...diagnostic, timestamp: Date.now() });
  // Count cap (FIFO trim).
  while (run.helperDiagnostics.length > P2P_HELPER_DIAGNOSTIC_RETENTION_COUNT) {
    run.helperDiagnostics.shift();
  }
  // Byte cap (FIFO trim until under budget OR only newest entry remains).
  let totalBytes = 0;
  for (const d of run.helperDiagnostics) {
    totalBytes += JSON.stringify(d).length;
  }
  while (totalBytes > P2P_HELPER_DIAGNOSTIC_RETENTION_BYTES && run.helperDiagnostics.length > 1) {
    const dropped = run.helperDiagnostics.shift();
    if (dropped) totalBytes -= JSON.stringify(dropped).length;
  }
}

export const P2P_HELPER_DIAGNOSTIC_RETENTION_LIMITS = {
  count: P2P_HELPER_DIAGNOSTIC_RETENTION_COUNT,
  bytes: P2P_HELPER_DIAGNOSTIC_RETENTION_BYTES,
} as const;

function parseVerdictFromContent(content: string): 'PASS' | 'REWORK' | null {
  const matches = [...content.matchAll(/<!--\s*P2P_VERDICT:\s*(PASS|REWORK)\s*-->/g)];
  const verdict = matches.at(-1)?.[1];
  return verdict === 'PASS' || verdict === 'REWORK' ? verdict : null;
}

function helperFallbackCandidates(run: P2pRun, exclude: string[]): string[] {
  const excluded = new Set(exclude);
  return run.helperEligibleSnapshot
    .filter((entry) => entry.sessionName !== run.initiatorSession)
    .filter((entry) => !!entry.parentSession || entry.sessionName.startsWith('deck_sub_'))
    .filter((entry) => !excluded.has(entry.sessionName))
    .map((entry) => entry.sessionName);
}

function ensureRunDeadline(run: P2pRun, serverLink: ServerLink | null): boolean {
  if (!run.advancedRunTimeoutMs || !run.deadlineAt) return true;
  if (Date.now() <= run.deadlineAt) return true;
  failRun(run, 'timed_out', 'advanced_run_timeout', serverLink);
  return false;
}

async function launchClonedHelperSession(run: P2pRun, templateSession: string): Promise<string> {
  const template = getSession(templateSession);
  if (!template || !template.runtimeType || template.runtimeType !== 'transport') {
    throw new Error(`Helper template is not an eligible SDK transport session: ${templateSession}`);
  }
  const helperName = `deck_p2p_helper_${run.id}_${run.currentExecutionStep}_${randomUUID().slice(0, 6)}`;
  await launchTransportSession({
    name: helperName,
    projectName: template.projectName,
    role: 'w1',
    agentType: template.agentType as any,
    projectDir: template.projectDir,
    skipStore: true,
    fresh: true,
    requestedModel: template.requestedModel ?? template.activeModel ?? undefined,
    transportConfig: template.transportConfig ?? undefined,
    description: `P2P helper for ${run.id}`,
    label: helperName,
    effort: template.effort,
    ...(template.ccPreset ? { ccPreset: template.ccPreset } : {}),
  });
  return helperName;
}

async function teardownHelperSession(run: P2pRun, sessionName: string): Promise<void> {
  try {
    await stopTransportRuntimeSession(sessionName);
  } catch (err) {
    addHelperDiagnostic(run, {
      code: 'P2P_HELPER_CLEANUP_FAILED',
      attempt: run.currentRoundAttempt,
      sourceSession: sessionName,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function cleanupReducerSummaryFile(
  run: P2pRun,
  summaryPath: string,
  sourceSession?: string | null,
  templateSession?: string | null,
  fallbackSession?: string | null,
): Promise<void> {
  try {
    await unlink(summaryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
    addHelperDiagnostic(run, {
      code: 'P2P_HELPER_CLEANUP_FAILED',
      attempt: run.currentRoundAttempt,
      sourceSession: sourceSession ?? null,
      templateSession: templateSession ?? null,
      fallbackSession: fallbackSession ?? null,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function reduceAdvancedContext(
  run: P2pRun,
  round: P2pResolvedRound,
  serverLink: ServerLink | null,
): Promise<string | null> {
  if (!run.contextReducer) return null;
  const info = await stat(run.contextFilePath).catch(() => null);
  if (!info || info.size < 32_000) return null;

  const summaryPath = join(dirname(run.contextFilePath), `${run.id}.reducer.${run.currentExecutionStep}.md`);
  const sectionHeader = `P2P Helper Summary — ${round.title} (step ${run.currentExecutionStep})`;
  const reducerPrompt = [
    `[P2P Helper Task — ${run.id}]`,
    `Read the discussion file at ${run.contextFilePath}.`,
    `Produce a compact context reduction for the next round.`,
    `Focus on: latest implementation attempt, latest audit findings, declared artifact targets, and only the most relevant unresolved issues.`,
    `Write the result to ${summaryPath}.`,
    `Add a new heading "## ${sectionHeader}" and put the reduced context under it.`,
    `Do not change workflow verdicts, do not route, and do not edit any code files.`,
    `Start immediately.`,
  ].join('\n');

  const readReducedSummary = async () => {
    const content = await readFile(summaryPath, 'utf8').catch(() => '');
    const section = extractHeadingSection(content, sectionHeader) ?? content;
    return section.trim() ? section.trim() : null;
  };

  const attemptWithSession = async (sessionName: string, codeOnFailure: P2pHelperDiagnostic['code'], templateSession?: string | null) => {
    const ok = await dispatchHop(run, sessionName, reducerPrompt, serverLink, {
      sectionHeader,
      filePath: summaryPath,
      required: false,
    });
    if (!ok) {
      addHelperDiagnostic(run, {
        code: codeOnFailure,
        attempt: run.currentRoundAttempt,
        sourceSession: sessionName,
        templateSession: templateSession ?? null,
      });
      return null;
    }
    return readReducedSummary();
  };

  await writeFile(summaryPath, '# Helper Summary\n\n', 'utf8');
  try {
    if (run.contextReducer.mode === 'reuse_existing_session' && run.contextReducer.sessionName) {
      const primaryResult = await attemptWithSession(
        run.contextReducer.sessionName,
        'P2P_HELPER_PRIMARY_FAILED',
        run.contextReducer.sessionName,
      );
      if (primaryResult) return primaryResult;
    } else if (run.contextReducer.mode === 'clone_sdk_session' && run.contextReducer.templateSession) {
      let helperName: string | null = null;
      try {
        helperName = await launchClonedHelperSession(run, run.contextReducer.templateSession);
        const primaryResult = await attemptWithSession(
          helperName,
          'P2P_HELPER_PRIMARY_FAILED',
          run.contextReducer.templateSession,
        );
        if (primaryResult) return primaryResult;
      } catch (err) {
        addHelperDiagnostic(run, {
          code: 'P2P_HELPER_PRIMARY_FAILED',
          attempt: run.currentRoundAttempt,
          templateSession: run.contextReducer.templateSession,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (helperName) await teardownHelperSession(run, helperName);
      }
    }

    const fallbackSession = helperFallbackCandidates(run, [
      run.contextReducer.sessionName ?? '',
      run.contextReducer.templateSession ?? '',
    ])[0];
    if (!fallbackSession) {
      addHelperDiagnostic(run, {
        code: 'P2P_COMPRESSION_SKIPPED_NO_FALLBACK',
        attempt: run.currentRoundAttempt,
        templateSession: run.contextReducer.templateSession ?? null,
        sourceSession: run.contextReducer.sessionName ?? null,
      });
      return null;
    }
    const fallbackResult = await attemptWithSession(fallbackSession, 'P2P_HELPER_FALLBACK_FAILED', fallbackSession);
    if (fallbackResult) return fallbackResult;
    failRun(run, 'failed', `helper_fallback_failed:${fallbackSession}`, serverLink);
    return null;
  } finally {
    await cleanupReducerSummaryFile(
      run,
      summaryPath,
      run.contextReducer.sessionName ?? null,
      run.contextReducer.templateSession ?? null,
    );
  }
}

/**
 * Legacy artifact baseline (oldAdvanced path only).
 *
 * R3 PR-γ (A3) — for envelope_compiled OpenSpec rounds, this function
 * returns an empty baseline because the authoritative gate is now
 * `verifyP2pArtifactBaselineDelta` against the frozen identity (see
 * `executeAdvancedChain` post-round delta block). The legacy
 * `readdir().join('\n')` heuristic violates spec
 * "OpenSpec artifact verification SHALL use per-file sha256 baseline only";
 * keeping it for envelope_compiled would be a fail-open second source.
 *
 * `explicit_paths` artifacts and oldAdvanced runs continue to use the
 * legacy per-file readFile baseline.
 */
async function captureArtifactBaseline(run: P2pRun, round: P2pResolvedRound): Promise<Map<string, string | null>> {
  const baseline = new Map<string, string | null>();
  const record = getSession(run.initiatorSession);
  const projectDir = record?.projectDir ?? process.cwd();
  if (round.artifactConvention === 'openspec_convention') {
    if (run.advancedSourceKind === 'envelope_compiled') {
      // PR-γ — no legacy baseline; the new helper is the only authority.
      return baseline;
    }
    const target = 'openspec/changes';
    try {
      const capture = await captureP2pArtifactBaseline({
        rootPath: target,
        phase: 'baseline',
        repoRoot: projectDir,
      });
      baseline.set(target, JSON.stringify(capture.baseline.files));
    } catch {
      baseline.set(target, null);
    }
    return baseline;
  }
  for (const output of round.artifactOutputs) {
    const absPath = join(projectDir, output);
    try {
      baseline.set(absPath, await readFile(absPath, 'utf8'));
    } catch {
      baseline.set(absPath, null);
    }
  }
  return baseline;
}

async function validateArtifactOutputsForRound(run: P2pRun, round: P2pResolvedRound, baseline: Map<string, string | null>): Promise<void> {
  if (round.artifactConvention === 'none') return;
  if (round.artifactConvention === 'openspec_convention') {
    if (run.advancedSourceKind === 'envelope_compiled') {
      // PR-γ — envelope_compiled OpenSpec validation is owned by the new
      // `verifyP2pArtifactBaselineDelta` gate (per-file sha256). The
      // legacy `readdir().join()` heuristic is bypassed entirely.
      return;
    }
    const target = [...baseline.keys()][0];
    const before = baseline.get(target) ?? null;
    try {
      const record = getSession(run.initiatorSession);
      const projectDir = record?.projectDir ?? process.cwd();
      const capture = await captureP2pArtifactBaseline({
        rootPath: target,
        phase: 'validate',
        repoRoot: projectDir,
      });
      const after = JSON.stringify(capture.baseline.files);
      if (after === before) throw new Error('openspec_convention artifacts were not observably updated');
      return;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }
  for (const [absPath, before] of baseline.entries()) {
    let after: string | null = null;
    try { after = await readFile(absPath, 'utf8'); } catch { after = null; }
    if (after == null) throw new Error(`Expected artifact missing after round: ${absPath}`);
    if (after === before) throw new Error(`Expected artifact not observably updated: ${absPath}`);
  }
}

async function readAppendedContent(filePath: string, baselineSize: number): Promise<string> {
  const buffer = await readFile(filePath);
  return buffer.subarray(Math.min(buffer.length, baselineSize)).toString('utf8');
}

function buildAdvancedRoundPrefix(run: P2pRun, round: P2pResolvedRound): string {
  return `[Advanced Round ${run.currentExecutionStep} — ${round.title} — Attempt ${run.currentRoundAttempt}]`;
}

function buildAdvancedPromptCommon(
  run: P2pRun,
  round: P2pResolvedRound,
  targetSession: string,
  filePath: string,
  sectionHeader: string,
  reducerSummary: string | null,
  instruction: string,
): string {
  const parts: string[] = [];
  parts.push(buildAdvancedRoundPrefix(run, round));
  parts.push('');
  parts.push(P2P_BASELINE_PROMPT);
  if (round.presetPrompt) parts.push(round.presetPrompt);
  parts.push('');
  parts.push(`[P2P Advanced Task — run ${run.id}]`);
  parts.push(`Discussion file: ${filePath}`);
  parts.push(`Your identity for this round is "${discussionParticipantName(targetSession)}".`);
  parts.push(`Round id: ${round.id}`);
  parts.push(`Permission scope: ${round.permissionScope}`);
  if (round.artifactConvention === 'openspec_convention') {
    parts.push('Required artifact contract: write OpenSpec artifacts under repository OpenSpec conventions inside openspec/changes/.');
  } else if (round.artifactOutputs.length > 0) {
    parts.push(`Required artifact outputs: ${round.artifactOutputs.join(', ')}`);
  }
  if (reducerSummary) {
    parts.push('');
    parts.push('Reduced context for this attempt:');
    parts.push(reducerSummary);
  }
  if (round.promptAppend) {
    parts.push('');
    parts.push(`Additional round instructions: ${round.promptAppend}`);
  }
  parts.push('');
  parts.push(instruction);
  parts.push(`Add a new heading "## ${sectionHeader}" at the end of the discussion file and write your result below it.`);
  parts.push('Do not ask for confirmation. Start immediately.');
  if (run.extraPrompt) {
    parts.push('');
    parts.push(`Additional instructions: ${run.extraPrompt}`);
  }
  const langLine = buildP2pLanguageInstruction(run.locale);
  if (langLine) {
    parts.push('');
    parts.push(langLine);
  }
  return parts.join('\n');
}

function buildAdvancedHopPrompt(
  run: P2pRun,
  round: P2pResolvedRound,
  target: P2pTarget,
  filePath: string,
  sectionHeader: string,
  reducerSummary: string | null,
): string {
  const instruction = round.permissionScope === 'analysis_only'
    ? 'Read the discussion file and provide analysis only. Do not edit code or other files.'
    : round.permissionScope === 'artifact_generation'
      ? 'Read the discussion file and produce the required artifacts. You may write only the round outputs and the discussion note for this round.'
      : 'Read the discussion file and perform the implementation work required by this round. You may edit code and tests as needed, then append a concise execution note to the discussion file.';
  return buildAdvancedPromptCommon(run, round, target.session, filePath, sectionHeader, reducerSummary, instruction);
}

function buildAdvancedSynthesisPrompt(
  run: P2pRun,
  round: P2pResolvedRound,
  sectionHeader: string,
  reducerSummary: string | null,
): string {
  const instruction = round.summaryPrompt
    ?? 'Synthesize the evidence appended in this round into one authoritative summary.';
  return buildAdvancedPromptCommon(
    run,
    round,
    run.initiatorSession,
    run.contextFilePath,
    sectionHeader,
    reducerSummary,
    instruction,
  );
}

/**
 * Audit:R3 / tasks 4.7b / 4.8b — a round is "dangerous" iff it asks the
 * dispatcher to extend write authority beyond `analysis_only`. The recheck
 * MUST run before every such round so a daemon policy/capability downgrade
 * mid-run fails the round closed instead of silently bypassing the change.
 */
function isRoundDangerous(round: P2pResolvedRound): boolean {
  if (round.permissionScope === 'implementation' || round.permissionScope === 'artifact_generation') return true;
  // R3 PR-α (A4) — script-node rounds are dangerous regardless of
  // permission scope, because script execution mutates the host environment
  // (argv launch, env policy, file system writes, NDJSON parsing). spec
  // "dangerous nodes SHALL recheck on policy downgrade" requires recheck on
  // every script dispatch. The previous predicate only inspected
  // permissionScope and silently let `analysis_only` script nodes bypass
  // capability-downgrade detection.
  if (round.nodeKind === 'script') return true;
  // OpenSpec / explicit-paths artifact rounds are write-authoritative even
  // under a permissive permissionScope; treat as dangerous when the resolved
  // round carries an artifact convention beyond `none`.
  if (round.artifactConvention && round.artifactConvention !== 'none') return true;
  return false;
}

function recheckDangerousRoundOrFail(
  run: P2pRun,
  round: P2pResolvedRound,
  serverLink: ServerLink | null,
): 'ok' | 'fail_closed' {
  const bound = run.boundWorkflow;
  if (!bound) return 'ok';
  // Source of truth: bound at compile/bind time, NOT recomputed from current draft.
  const requiredCapabilities = bound.compiled.derivedRequiredCapabilities;
  const bindCapabilitySnapshot = bound.bindContext.capabilitySnapshot.capabilities;
  const boundPolicySnapshot = bound.bindContext.policySnapshot;

  // Live state at execute time. When serverLink is null (test harness or
  // disconnected daemon), degrade to bound snapshot — we can't observe a
  // downgrade without a live source, so the recheck becomes a no-op rather
  // than a false fail-closed.
  const stubLink = { getP2pWorkflowCapabilities: () => bindCapabilitySnapshot } as unknown as ServerLink;
  const link = serverLink ?? stubLink;
  const currentDaemonCapabilities = getCurrentDaemonWorkflowCapabilities(link);
  const currentDaemonPolicy = loadDaemonP2pStaticPolicy(link);

  const result = recheckDangerousNodeCapabilities({
    requiredCapabilities,
    bindCapabilitySnapshot,
    currentDaemonCapabilities,
    boundPolicySnapshot,
    currentDaemonPolicy,
    runId: run.id,
    nodeId: round.id,
  });
  if (result.ok) return 'ok';
  // Fail the run closed; the helper diagnostic carries the precise downgrade
  // metadata. Rely on the existing helper-diagnostic retention pipeline.
  addHelperDiagnostic(run, {
    code: 'P2P_DANGEROUS_NODE_RECHECK_FAILED',
    message: result.diagnostic.summary ?? 'dangerous node recheck failed',
    nodeId: round.id,
    severity: 'error' as const,
  } as unknown as Omit<P2pHelperDiagnostic, 'timestamp'>);
  failRun(run, 'capability_downgraded_during_run', result.diagnostic.summary ?? 'recheck failed', serverLink);
  return 'fail_closed';
}

/**
 * Audit:R2-N1 / R3 §12.1 production wiring — when the round's compiled node
 * is `nodeKind: 'script'` AND the run carries an envelope-compiled bound
 * workflow, dispatch via `runP2pScriptNode` instead of the legacy
 * `dispatchHop`. The script's stdout/stderr/machine-output are recorded into
 * the discussion file as a "Script execution" segment so the rest of the
 * round flow (verdict parsing, summary, etc.) sees authoritative content.
 *
 * Returns a synthetic "authoritative segment" string so the caller can keep
 * its existing structure (round verdict / artifact validation / loop
 * routing). On any failure the script-node round is marked failed via
 * `failRun` and the helper returns null.
 */
async function dispatchScriptRoundOrFail(
  run: P2pRun,
  round: P2pResolvedRound,
  serverLink: ServerLink | null,
): Promise<
  | { kind: 'ok'; authoritativeSegment: string; routingKey?: string; variables?: Record<string, unknown> }
  | { kind: 'fail_closed' }
  | { kind: 'retry' }
  | { kind: 'not_a_script_round' }
> {
  const bound = run.boundWorkflow;
  if (!bound) return { kind: 'not_a_script_round' };
  // R3 PR-α (A1) — adapter now preserves `nodeKind` and `script` on the
  // resolved round, so we read them from `round` first and fall back to the
  // sidecar `bound.compiled.nodes.find(...)` only for old fixtures that
  // pre-date the adapter widening. `script` may still live on `bound` even
  // after A1 because compiled `P2pScriptNodeContract` is the authoritative
  // shape.
  const fallbackNode = bound.compiled.nodes.find((node) => node.id === round.id);
  const isScript = round.nodeKind === 'script' || fallbackNode?.nodeKind === 'script';
  const scriptContract = round.script ?? fallbackNode?.script;
  if (!isScript || !scriptContract) {
    return { kind: 'not_a_script_round' };
  }
  const policy = bound.bindContext.policySnapshot;
  if (!policy) {
    failRun(run, 'failed', 'Script-node round dispatch requires bound policySnapshot.', serverLink);
    return { kind: 'fail_closed' };
  }
  // R3 PR-α (B3 / B5 / D-O4) — slot exhaustion now emits a structured
  // workflow diagnostic via `helperDiagnostic.workflowDiagnostic` so web /
  // monitoring can render the i18n key for `daemon_busy` instead of parsing
  // free-form text.
  const slot = acquireScriptSlot();
  if (!slot.ok) {
    const busyDiag = makeP2pWorkflowDiagnostic('daemon_busy', 'execute', {
      nodeId: round.id,
      summary: `Script slot pool exhausted (${slot.inUse}/${slot.capacity}).`,
    });
    addHelperDiagnostic(run, {
      code: 'P2P_SCRIPT_SLOT_EXHAUSTED',
      attempt: run.currentRoundAttempt,
      sourceSession: run.initiatorSession,
      message: busyDiag.summary ?? 'daemon_busy',
      workflowDiagnostic: busyDiag,
    });
    failRun(run, 'failed', `Script slot pool exhausted (${slot.inUse}/${slot.capacity}); see daemon_busy.`, serverLink);
    return { kind: 'fail_closed' };
  }
  // Audit fix (94b9b837-822 / N1) — wire an AbortController so the script
  // child process can be terminated when (a) the user cancels the run,
  // (b) the run's overall `deadlineAt` (default 30 min via the resolver,
  // see `shared/p2p-advanced.ts`) expires while the script is blocked, or
  // (c) the script's own `timeoutMs` is unset and would otherwise let
  // `child.spawn(...)` run unbounded. Stored in the module-level
  // `currentScriptAborters` so `cancelP2pRun` can reach in.
  const ac = new AbortController();
  currentScriptAborters.set(run.id, () => ac.abort());
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (typeof run.deadlineAt === 'number' && Number.isFinite(run.deadlineAt)) {
    const remainingMs = Math.max(0, run.deadlineAt - Date.now());
    if (remainingMs === 0) {
      // Already past deadline — abort before we even launch.
      ac.abort();
    } else {
      deadlineTimer = setTimeout(() => ac.abort(), remainingMs);
      try { (deadlineTimer as { unref?: () => void }).unref?.(); } catch { /* ignore */ }
    }
  }
  if (run._cancelled) ac.abort();
  try {
    const result = await runP2pScriptNode({
      script: scriptContract,
      policy,
      repoRoot: bound.bindContext.repoRoot,
      runId: run.id,
      nodeId: round.id,
      signal: ac.signal,
    });
    // Append a discussion-file segment so downstream verdict parsing /
    // summary generation still sees the round's authoritative output.
    const sectionHeader = `Script: ${round.title} (attempt ${run.currentRoundAttempt})`;
    let segment = `\n\n## ${sectionHeader}\n\n`;
    segment += `Exit code: ${result.exitCode}, signal: ${result.signal}, ok: ${result.ok}\n`;
    if (result.machineOutput?.ok) {
      segment += `\n### Machine output (final frame)\n\n\`\`\`json\n${JSON.stringify(result.machineOutput.finalFrame, null, 2)}\n\`\`\`\n`;
    }
    if (result.diagnostics.length) {
      const codes = result.diagnostics.map((d) => d.code).join(', ');
      segment += `\nDiagnostics: ${codes}\n`;
    }
    // R3 PR-α (B4 / D-O3) + v1b (W2) — discussion file write is now
    // non-blocking via the per-run queue. Spec D-O3: in-memory
    // `authoritativeSegment` is the verdict source-of-truth so the write
    // does NOT gate dispatch latency. Failures still surface via helper
    // diagnostic + logger.warn so audit gaps are visible.
    //
    // Audit fix (94b9b837-822 / A4) — closures below capture `runId` /
    // `contextFilePath` / `attempt` as primitives instead of the full
    // `run` object. The discussion writer's per-file `RunQueue` retains
    // these closures via `onWriteFailure` / `onSegmentDropped`; capturing
    // primitives means a terminal-cleanup activeRuns delete can actually
    // free the P2pRun even if the queue hasn't drained yet. Stale-run
    // failures swallow gracefully (no helper diagnostic destination).
    {
      const runId = run.id;
      const contextFilePath = run.contextFilePath;
      const attemptAtEnqueue = run.currentRoundAttempt;
      const initiatorAtEnqueue = run.initiatorSession;
      enqueueP2pDiscussionWrite(
        contextFilePath,
        segment,
        (error: unknown) => {
          const live = getP2pRun(runId);
          if (!live) return;
          const message = error instanceof Error ? error.message : String(error);
          addHelperDiagnostic(live, {
            code: 'P2P_DISCUSSION_WRITE_FAILED',
            attempt: attemptAtEnqueue,
            sourceSession: initiatorAtEnqueue,
            message: `Failed to append script segment to ${contextFilePath}: ${message}`,
          });
        },
        // R3 v2 PR-ζ (M1) — surface backpressure drops as helper diagnostic.
        (droppedBytes, queuedBytes) => {
          const live = getP2pRun(runId);
          if (!live) return;
          addHelperDiagnostic(live, {
            code: 'P2P_DISCUSSION_WRITE_FAILED',
            attempt: attemptAtEnqueue,
            sourceSession: initiatorAtEnqueue,
            message: `Discussion writer dropped ${droppedBytes}B due to backpressure (queued=${queuedBytes}B)`,
          });
        },
      );
    }
    if (!result.ok) {
      // R3 PR-α (B1 / B5) + v1b follow-up (script retry) — script
      // execution failure either fails the round closed OR triggers a
      // retry when ALL diagnostics are transient (e.g. `script_timeout`,
      // `daemon_busy`) AND the round attempt count is below
      // `P2P_SCRIPT_RETRY_DEFAULT_ATTEMPTS`. The structured workflow
      // diagnostic is preserved via `helperDiagnostic.workflowDiagnostic`.
      const primaryDiag: P2pWorkflowDiagnostic | undefined = result.diagnostics[0];
      const primaryCode = primaryDiag?.code ?? 'script_machine_output_invalid';
      const retriable = result.diagnostics.length > 0
        && result.diagnostics.every((d) => (P2P_SCRIPT_RETRIABLE_DIAGNOSTIC_CODES as readonly string[]).includes(d.code));
      // R3 v2 PR-ζ (M2 / ζ-10) — retry budget uses an independent counter
      // so jump-rebound (via routing/jumpRule) doesn't consume the
      // script transient-failure retry budget. The counter is reset
      // when a jump targets this round (see jump block below).
      if (!run.scriptRetryCounts) run.scriptRetryCounts = {};
      const scriptAttemptsSoFar = run.scriptRetryCounts[round.id] ?? 0;
      const attemptsRemain = scriptAttemptsSoFar < P2P_SCRIPT_RETRY_DEFAULT_ATTEMPTS - 1;
      // pre-increment so the first failure shows as 1 attempt consumed
      run.scriptRetryCounts[round.id] = scriptAttemptsSoFar + 1;
      const attemptsSoFar = scriptAttemptsSoFar + 1;
      for (const wd of result.diagnostics) {
        addHelperDiagnostic(run, {
          code: 'P2P_HELPER_PRIMARY_FAILED',
          attempt: run.currentRoundAttempt,
          sourceSession: run.initiatorSession,
          message: `script:${wd.code} ${wd.summary ?? ''}`.trim(),
          workflowDiagnostic: wd,
        });
      }
      if (retriable && attemptsRemain) {
        // Surface the retry decision but do NOT fail the run; the executor
        // re-enters the same round (attempt count increments at the top).
        logger.warn(
          { runId: run.id, nodeId: round.id, attempt: attemptsSoFar, max: P2P_SCRIPT_RETRY_DEFAULT_ATTEMPTS, primaryCode },
          'P2P: script transient failure, retrying',
        );
        return { kind: 'retry' };
      }
      failRun(
        run,
        'failed',
        `Script node ${round.id} failed (exit=${result.exitCode}, signal=${result.signal ?? 'none'}); primary=${primaryCode}; attempts=${attemptsSoFar}/${P2P_SCRIPT_RETRY_DEFAULT_ATTEMPTS}`,
        serverLink,
      );
      return { kind: 'fail_closed' };
    }
    // R3 PR-β (Cx1-H2) — surface the structured routing key from the
    // machine output frame so the executor can route on the authoritative
    // value instead of parsing free-form discussion text. The frame is
    // the spec's "machine output is authoritative" source.
    //
    // R3 v1b follow-up — also surface the structured `variables` patch so
    // downstream logic nodes can evaluate against the latest run state.
    const finalFrame = result.machineOutput?.ok
      ? (result.machineOutput.finalFrame as { routingKey?: unknown; variables?: Record<string, unknown> } | undefined)
      : undefined;
    const routingKey = typeof finalFrame?.routingKey === 'string' && finalFrame.routingKey.length > 0
      ? finalFrame.routingKey
      : undefined;
    const variables = finalFrame?.variables && typeof finalFrame.variables === 'object' && !Array.isArray(finalFrame.variables)
      ? finalFrame.variables
      : undefined;
    return {
      kind: 'ok',
      authoritativeSegment: segment,
      ...(routingKey ? { routingKey } : {}),
      ...(variables ? { variables } : {}),
    };
  } catch (error) {
    failRun(run, 'failed', error instanceof Error ? error.message : String(error), serverLink);
    return { kind: 'fail_closed' };
  } finally {
    releaseScriptSlot();
    // Audit fix (94b9b837-822 / N1) — drop the aborter handle and any
    // deadline watchdog timer. Calling `ac.abort()` here is intentional:
    // it tears down the runner's listener even if it already settled,
    // which is a no-op but reduces the chance of dangling event-emitter
    // references.
    currentScriptAborters.delete(run.id);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

/**
 * Audit:R2-N2 / R3 §12.2 production wiring — for envelope_compiled runs that
 * declare any `openspec_convention` artifact, lazily freeze the OpenSpec
 * identity once per run (deterministic slug-N collision suffix; identity
 * preserved across retry/re-entry in the in-memory map). Returns the frozen
 * artifact root path the new helpers should baseline against.
 *
 * For runs WITHOUT openspec_convention (or for legacy non-envelope runs),
 * returns null and the orchestrator falls back to the legacy
 * `captureArtifactBaseline` map.
 */
/**
 * R3 PR-α (W1) + PR-β (Cx1-H4) — Narrowed return type with explicit
 * freeze-error signal. The caller no longer needs `!` to assert
 * `run.boundWorkflow` because the helper returns the bound workflow
 * alongside the resolved artifact root.
 *
 * PR-β change: when freeze attempt throws OR returns an identity with no
 * `openspecChangePath`, we now surface `freezeError` (with the helper
 * diagnostics from the freeze attempt when available). The orchestrator's
 * envelope_compiled OpenSpec branch fails closed; oldAdvanced flows still
 * fall back to the legacy baseline path so non-envelope runs are not
 * regressed. The frozen identity is exposed so the post-round delta gate
 * can use `identity.openspecArtifactPaths` (Cx1-H3) instead of the lossy
 * adapter-projected `round.artifactOutputs`.
 */
interface RunArtifactRootResolution {
  rootPath: string;
  bound: P2pBoundWorkflow;
  identity: P2pFrozenArtifactIdentity;
  /**
   * When set, freeze failed for this run's OpenSpec contract. envelope_compiled
   * callers MUST `failRun` instead of silently falling back to legacy
   * `readdir().join()` validation.
   */
  freezeError?: { reason: string; diagnostics: P2pWorkflowDiagnostic[] };
}
const runArtifactRootCache = new Map<string, RunArtifactRootResolution>();
async function getOrFreezeRunArtifactRoot(run: P2pRun): Promise<RunArtifactRootResolution | null> {
  const bound = run.boundWorkflow;
  if (!bound) return null;
  const cached = runArtifactRootCache.get(run.id);
  if (cached) return cached;
  // Pick the first OpenSpec convention artifact to drive identity freeze.
  // The freeze operation is idempotent per `runId` so multiple OpenSpec
  // nodes in the same run still freeze once.
  let openSpecContract: { convention: 'openspec_convention'; paths: string[] } | null = null;
  for (const node of bound.compiled.nodes) {
    const found = node.artifacts?.find((artifact) => artifact.convention === 'openspec_convention');
    if (found) { openSpecContract = found as { convention: 'openspec_convention'; paths: string[] }; break; }
  }
  if (!openSpecContract) return null;
  // Suggest a slug derived from the run id so collision is rare in practice
  // but `freezeP2pArtifactIdentity` still owns the slug-N collision suffix.
  const inferredSlug = `p2p-run-${run.id.slice(0, 8)}`;
  try {
    const identity: P2pFrozenArtifactIdentity = await freezeP2pArtifactIdentity({
      contract: openSpecContract,
      runId: run.id,
      repoRoot: bound.bindContext.repoRoot,
      inferredSlug,
    });
    if (!identity.openspecChangePath) {
      const resolution: RunArtifactRootResolution = {
        rootPath: '',
        bound,
        identity,
        freezeError: {
          reason: 'artifact_identity_freeze_failed',
          diagnostics: identity.diagnostics ?? [],
        },
      };
      runArtifactRootCache.set(run.id, resolution);
      return resolution;
    }
    const resolution: RunArtifactRootResolution = {
      rootPath: identity.openspecChangePath,
      bound,
      identity,
    };
    runArtifactRootCache.set(run.id, resolution);
    return resolution;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Surface the freeze error via the resolution shape so envelope_compiled
    // callers can fail closed. We deliberately cache the error so retries
    // don't re-attempt mkdir storms; the run terminates after the first
    // visit anyway. oldAdvanced callers continue to ignore the resolution
    // entirely (they go through the legacy `captureArtifactBaseline` path).
    const resolution: RunArtifactRootResolution = {
      rootPath: '',
      bound,
      identity: {
        convention: 'openspec_convention',
        openspecArtifactPaths: [],
        frozenAt: new Date().toISOString(),
        collisionResolved: false,
        diagnostics: [],
      },
      freezeError: { reason, diagnostics: [] },
    };
    runArtifactRootCache.set(run.id, resolution);
    return resolution;
  }
}


/** Test-only: clear the per-run artifact-root cache between e2e tests. */
export function __resetP2pRunArtifactRootCacheForTests(): void {
  runArtifactRootCache.clear();
}

async function executeAdvancedChain(run: P2pRun, serverLink: ServerLink | null): Promise<void> {
  const rounds = run.resolvedRounds ?? [];
  let roundIndex = 0;
  while (roundIndex < rounds.length) {
    if (run._cancelled || isTerminal(run.status)) return;
    if (!ensureRunDeadline(run, serverLink)) return;
    const round = rounds[roundIndex];
    run.timeoutMs = round.timeoutMs;
    run.currentRound = roundIndex + 1;
    run.currentRoundId = round.id;
    run.currentExecutionStep += 1;
    run.roundAttemptCounts[round.id] = (run.roundAttemptCounts[round.id] ?? 0) + 1;
    run.currentRoundAttempt = run.roundAttemptCounts[round.id];
    run.runPhase = 'round_execution';
    run.summaryPhase = null;
    run.activePhase = round.dispatchStyle === 'initiator_only' ? 'initial' : 'hop';
    pushState(run, serverLink);

    // Audit:R3 / tasks 4.7b / 4.8b — in-tree dangerous-node recheck.
    // Before executing any round whose semantics extend write authority
    // (`permissionScope === 'implementation'`, OpenSpec artifact-write,
    // script execution), re-check current daemon capabilities + policy
    // against the bound snapshot. A capability/policy downgrade between
    // bind and execute MUST fail the run closed — capability upgrade does
    // NOT broaden the frozen requirement set (helper enforces).
    if (
      run.advancedSourceKind === 'envelope_compiled'
      && run.boundWorkflow
      && isRoundDangerous(round)
    ) {
      const recheck = recheckDangerousRoundOrFail(run, round, serverLink);
      if (recheck === 'fail_closed') return;
    }

    const artifactBaseline = await captureArtifactBaseline(run, round);

    // Audit:R2-N2 / R3 PR-α / PR-β — for envelope_compiled runs that
    // declare OpenSpec artifacts, capture the new-style baseline
    // (size + sha256 + caps) under the frozen artifact root. The narrowed
    // `RunArtifactRootResolution` return removes the `!` non-null assertion
    // (W1) so future refactors can't accidentally drop the bind context.
    //
    // PR-β (Cx1-H4): freeze failure on an envelope_compiled run with
    // declared OpenSpec artifacts MUST fail the run closed. The legacy
    // `readdir().join()` validator is too weak a fallback for the OpenSpec
    // convention (spec "freeze failure SHALL fail the run").
    const artifactRootResolution = await getOrFreezeRunArtifactRoot(run);
    if (
      artifactRootResolution?.freezeError
      && run.advancedSourceKind === 'envelope_compiled'
      && round.artifactConvention === 'openspec_convention'
    ) {
      addHelperDiagnostic(run, {
        code: 'P2P_HELPER_PRIMARY_FAILED',
        attempt: run.currentRoundAttempt,
        sourceSession: run.initiatorSession,
        message: `Artifact identity freeze failed: ${artifactRootResolution.freezeError.reason}`,
        workflowDiagnostic: artifactRootResolution.freezeError.diagnostics[0],
      });
      failRun(
        run,
        'failed',
        `Artifact identity freeze failed for OpenSpec run: ${artifactRootResolution.freezeError.reason}`,
        serverLink,
      );
      return;
    }
    let newArtifactBaseline: P2pArtifactBaseline | null = null;
    if (artifactRootResolution && !artifactRootResolution.freezeError) {
      try {
        const captureResult = await captureP2pArtifactBaseline({
          rootPath: artifactRootResolution.rootPath,
          phase: 'baseline',
          repoRoot: artifactRootResolution.bound.bindContext.repoRoot,
        });
        // R3 v2 PR-ζ (Cx1-A2 / ζ-9) — capture diagnostics with error
        // severity OR `truncated === true` MUST fail the round closed.
        // Pre v2 these were silently ignored, so artifact cap-exceeded /
        // unsafe-root were demoted to "declared path missing" symptoms by
        // the downstream delta verifier.
        const errorDiag = captureResult.diagnostics.find((d) => d.severity === 'error');
        if (errorDiag || captureResult.baseline.truncated) {
          if (errorDiag) {
            addHelperDiagnostic(run, {
              code: 'P2P_HELPER_PRIMARY_FAILED',
              attempt: run.currentRoundAttempt,
              sourceSession: run.initiatorSession,
              message: `Pre-round artifact baseline capture failed: ${errorDiag.code} ${errorDiag.summary ?? ''}`.trim(),
              workflowDiagnostic: errorDiag,
            });
          }
          if (captureResult.baseline.truncated) {
            const truncDiag = makeP2pWorkflowDiagnostic('artifact_baseline_too_large', 'execute', {
              nodeId: round.id,
              summary: 'Artifact baseline truncated due to size cap.',
            });
            addHelperDiagnostic(run, {
              code: 'P2P_HELPER_PRIMARY_FAILED',
              attempt: run.currentRoundAttempt,
              sourceSession: run.initiatorSession,
              message: 'Pre-round artifact baseline truncated (cap exceeded).',
              workflowDiagnostic: truncDiag,
            });
          }
          failRun(
            run,
            'failed',
            `Pre-round artifact baseline capture failed: ${errorDiag?.code ?? 'artifact_baseline_too_large'}`,
            serverLink,
          );
          return;
        }
        newArtifactBaseline = captureResult.baseline;
      } catch {
        // Baseline capture can fail if the frozen root doesn't exist yet
        // (no prior round wrote anything). Treat as empty baseline so the
        // post-round delta sees fresh files.
        newArtifactBaseline = null;
      }
    }

    const reducerSummary = await reduceAdvancedContext(run, round, serverLink);
    if (run._cancelled || isTerminal(run.status)) return;

    // Audit:R2-N1 — script-node dispatch. When the round corresponds to a
    // compiled `nodeKind: 'script'` node, route through the daemon script
    // runner instead of legacy dispatchHop.
    const scriptDispatch = await dispatchScriptRoundOrFail(run, round, serverLink);
    if (scriptDispatch.kind === 'fail_closed') return;
    if (scriptDispatch.kind === 'retry') {
      // R3 v1b follow-up — transient script failure. Re-enter the same
      // round; `roundAttemptCounts[round.id]` will increment on the next
      // iteration's prologue. The retry budget is enforced inside
      // `dispatchScriptRoundOrFail` so we never loop indefinitely.
      continue;
    }

    let authoritativeSegment = '';
    // R3 PR-β (Cx1-H2) — capture the structured routing key emitted by the
    // script's machine output frame so the compiled-edge jump logic can
    // route on it instead of parsing free-form discussion text.
    let scriptRoutingKey: string | undefined;
    // R3 v1b follow-up — capture the structured logic marker emitted by
    // a logic node so `logic_marker_equals` edges route on its value.
    let logicMarker: string | undefined;
    if (scriptDispatch.kind === 'ok') {
      authoritativeSegment = scriptDispatch.authoritativeSegment;
      scriptRoutingKey = scriptDispatch.routingKey;
      // R3 v2 PR-ζ (B1 / A5 / B5) — Apply the structured variables patch
      // to the run state. The orchestrator is the SINGLE write path, so
      // it does its own defence-in-depth even though
      // `parseP2pScriptMachineOutput` already enforced the same shape:
      //   * key MUST match `P2P_WORKFLOW_VARIABLE_NAME_PATTERN`
      //     (lowercase identifier — structurally rejects `__proto__` etc)
      //   * value type ∈ string | number | boolean | string[]
      //   * arrays SHALL be ≤ 64 elements AND every element ≤ 8 KiB
      // Drops surface as `P2P_HELPER_PRIMARY_FAILED` helper diagnostics
      // so users can see why their variable patch was ignored.
      if (scriptDispatch.variables && run.runVariables) {
        for (const [name, value] of Object.entries(scriptDispatch.variables)) {
          if (!P2P_WORKFLOW_VARIABLE_NAME_PATTERN.test(name)) {
            addHelperDiagnostic(run, {
              code: 'P2P_HELPER_PRIMARY_FAILED',
              attempt: run.currentRoundAttempt,
              sourceSession: run.initiatorSession,
              message: `Script variable name rejected (must match ${P2P_WORKFLOW_VARIABLE_NAME_PATTERN.source}): ${name.slice(0, 64)}`,
            });
            continue;
          }
          let acceptable = false;
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            acceptable = true;
          } else if (Array.isArray(value)) {
            if (value.length > P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENTS) {
              addHelperDiagnostic(run, {
                code: 'P2P_HELPER_PRIMARY_FAILED',
                attempt: run.currentRoundAttempt,
                sourceSession: run.initiatorSession,
                message: `Script variable ${name} array length ${value.length} exceeds cap ${P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENTS}`,
              });
              continue;
            }
            const tooBigIndex = value.findIndex((v) => typeof v !== 'string' || Buffer.byteLength(v, 'utf8') > P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENT_BYTES);
            if (tooBigIndex >= 0) {
              addHelperDiagnostic(run, {
                code: 'P2P_HELPER_PRIMARY_FAILED',
                attempt: run.currentRoundAttempt,
                sourceSession: run.initiatorSession,
                message: `Script variable ${name}[${tooBigIndex}] exceeds ${P2P_WORKFLOW_VARIABLE_ARRAY_MAX_ELEMENT_BYTES}B element cap or non-string`,
              });
              continue;
            }
            acceptable = true;
          }
          if (acceptable) run.runVariables[name] = value;
        }
      }
    } else if (round.nodeKind === 'logic') {
      // R3 v1b follow-up — logic node dispatch (envelope_compiled only).
      // Evaluate the contract against current run.variables, append a
      // small audit segment to the discussion file, set logicMarker for
      // routing, and skip every other dispatch path (no agent send, no
      // artifact verify — logic is pure).
      const compiledNode = run.boundWorkflow?.compiled.nodes.find((node) => node.id === round.id);
      const logic = compiledNode?.logic;
      if (!logic) {
        addHelperDiagnostic(run, {
          code: 'P2P_HELPER_PRIMARY_FAILED',
          attempt: run.currentRoundAttempt,
          sourceSession: run.initiatorSession,
          message: `Logic node ${round.id} has no compiled logic contract`,
        });
        failRun(run, 'failed', `Logic node ${round.id} missing logic contract`, serverLink);
        return;
      }
      const evalResult = evaluateP2pLogic(logic, (run.runVariables ?? {}) as Record<string, P2pWorkflowVariableValue | undefined>);
      logicMarker = evalResult.marker;
      const sectionHeader = `Logic: ${round.title} (attempt ${run.currentRoundAttempt})`;
      const segment = `\n\n## ${sectionHeader}\n\nemit: ${evalResult.marker}\nmatchedRuleIndex: ${evalResult.matchedRuleIndex}\n`;
      authoritativeSegment = segment;
      // R3 v1b (W2) + v2 PR-ζ (M1) — non-blocking + drop surfaces helper
      // diagnostic. D-O3: in-memory authoritativeSegment is verdict
      // source-of-truth.
      //
      // Audit fix (94b9b837-822 / A4) — see corresponding script-dispatch
      // call site for rationale; closures capture primitives, not `run`.
      const logicRunId = run.id;
      const logicContextFilePath = run.contextFilePath;
      const logicAttemptAtEnqueue = run.currentRoundAttempt;
      const logicInitiatorAtEnqueue = run.initiatorSession;
      enqueueP2pDiscussionWrite(
        logicContextFilePath,
        segment,
        (error: unknown) => {
          const live = getP2pRun(logicRunId);
          if (!live) return;
          const message = error instanceof Error ? error.message : String(error);
          addHelperDiagnostic(live, {
            code: 'P2P_DISCUSSION_WRITE_FAILED',
            attempt: logicAttemptAtEnqueue,
            sourceSession: logicInitiatorAtEnqueue,
            message: `Failed to append logic segment to ${logicContextFilePath}: ${message}`,
          });
        },
        (droppedBytes, queuedBytes) => {
          const live = getP2pRun(logicRunId);
          if (!live) return;
          addHelperDiagnostic(live, {
            code: 'P2P_DISCUSSION_WRITE_FAILED',
            attempt: logicAttemptAtEnqueue,
            sourceSession: logicInitiatorAtEnqueue,
            message: `Discussion writer dropped ${droppedBytes}B due to backpressure (queued=${queuedBytes}B)`,
          });
        },
      );
    } else if (round.dispatchStyle === 'initiator_only') {
      const sectionHeader = `${discussionParticipantName(run.initiatorSession)} — ${round.title} (attempt ${run.currentRoundAttempt})`;
      const baselineBuffer = await readFile(run.contextFilePath).catch(() => Buffer.from(''));
      const prompt = buildAdvancedHopPrompt(
        run,
        round,
        { session: run.initiatorSession, mode: round.modeKey },
        run.contextFilePath,
        sectionHeader,
        reducerSummary,
      );
      const ok = await dispatchHop(run, run.initiatorSession, prompt, serverLink, {
        sectionHeader,
        required: true,
      });
      if (!ok && (run._cancelled || isTerminal(run.status))) return;
      authoritativeSegment = ok ? await readAppendedContent(run.contextFilePath, baselineBuffer.length) : '';
    } else {
      const targets = [...run.allTargets];
      const roundHops = await createRoundHopStates(run, targets, round.modeKey);
      try {
        run.activeTargetSessions = roundHops.map((hop) => hop.session);
        await Promise.allSettled(targets.map(async (target, index) => {
          const hop = roundHops[index];
          const sectionHeader = `${discussionParticipantName(target.session)} — ${round.title} (hop ${index + 1}/${targets.length}, attempt ${run.currentRoundAttempt})`;
          hop.section_header = sectionHeader;
          const prompt = buildAdvancedHopPrompt(run, round, target, hop.artifact_path, sectionHeader, reducerSummary);
          return dispatchHop(run, target.session, prompt, serverLink, {
            sectionHeader,
            hop,
            filePath: hop.artifact_path,
          });
        }));
        run.activeTargetSessions = [];
        run.currentTargetSession = null;
        if (run._cancelled || isTerminal(run.status)) return;
        await appendRoundEvidence(run, roundHops);
        if (round.synthesisStyle === 'initiator_summary') {
          run.runPhase = 'summarizing';
          run.summaryPhase = 'running';
          run.activePhase = 'summary';
          const sectionHeader = `${discussionParticipantName(run.initiatorSession)} — ${round.title} Synthesis (attempt ${run.currentRoundAttempt})`;
          const baselineBuffer = await readFile(run.contextFilePath).catch(() => Buffer.from(''));
          const prompt = buildAdvancedSynthesisPrompt(run, round, sectionHeader, reducerSummary);
          const ok = await dispatchHop(run, run.initiatorSession, prompt, serverLink, {
            sectionHeader,
            required: true,
          });
          if (!ok && (run._cancelled || isTerminal(run.status))) return;
          authoritativeSegment = ok ? await readAppendedContent(run.contextFilePath, baselineBuffer.length) : '';
          run.summaryPhase = ok ? 'completed' : 'failed';
        }
      } finally {
        scheduleRoundHopArtifactCleanup(roundHops);
      }
    }

    if (run.launchOrigin?.kind === 'openspec_auto_deliver' && authoritativeSegment.trim()) {
      run.strictAuthoritativeResult = authoritativeSegment;
    }

    await validateArtifactOutputsForRound(run, round, artifactBaseline).catch((err) => {
      failRun(run, 'failed', err instanceof Error ? err.message : String(err), serverLink);
    });
    if (run._cancelled || isTerminal(run.status)) return;

    // Audit:R2-N2 / R3 PR-α (B2 / B5 / B7) / PR-β (Cx1-H3) — for
    // envelope_compiled runs with OpenSpec artifacts, run the new-style
    // baseline delta check as a SECOND authoritative gate (legacy
    // `validateArtifactOutputsForRound` above remains as the first gate
    // until PR-γ; either failing fails the round — "double gate").
    // Post-round capture uses `phase: 'validate'` so diagnostics
    // distinguish pre/post phases.
    //
    // PR-β (Cx1-H3) — `declaredFiles` now comes from
    // `identity.openspecArtifactPaths` (the frozen identity's coordinate
    // system) instead of `round.artifactOutputs` (the lossy adapter
    // projection). Mismatched coordinate systems previously caused false
    // missing-file diagnostics for valid OpenSpec writes.
    if (artifactRootResolution && !artifactRootResolution.freezeError && round.artifactConvention === 'openspec_convention') {
      const identityPaths = artifactRootResolution.identity.openspecArtifactPaths;
      // When the frozen identity declared no artifact paths AND the round
      // also declared none, there is nothing to verify; skip silently.
      if (identityPaths.length === 0 && round.artifactOutputs.length === 0) {
        // no-op
      } else {
        try {
          const afterCapture = await captureP2pArtifactBaseline({
            rootPath: artifactRootResolution.rootPath,
            phase: 'validate',
            repoRoot: artifactRootResolution.bound.bindContext.repoRoot,
          });
          // R3 v2 PR-ζ (Cx1-A2 / ζ-9) — post-round capture diagnostics
          // also fail-closed; truncated baseline post-round means the
          // round wrote more than the cap allows.
          const errorDiag = afterCapture.diagnostics.find((d) => d.severity === 'error');
          if (errorDiag || afterCapture.baseline.truncated) {
            if (errorDiag) {
              addHelperDiagnostic(run, {
                code: 'P2P_HELPER_PRIMARY_FAILED',
                attempt: run.currentRoundAttempt,
                sourceSession: run.initiatorSession,
                message: `Post-round artifact baseline capture failed: ${errorDiag.code} ${errorDiag.summary ?? ''}`.trim(),
                workflowDiagnostic: errorDiag,
              });
            }
            if (afterCapture.baseline.truncated) {
              const truncDiag = makeP2pWorkflowDiagnostic('artifact_baseline_too_large', 'execute', {
                nodeId: round.id,
                summary: 'Post-round artifact baseline truncated due to size cap.',
              });
              addHelperDiagnostic(run, {
                code: 'P2P_HELPER_PRIMARY_FAILED',
                attempt: run.currentRoundAttempt,
                sourceSession: run.initiatorSession,
                message: 'Post-round artifact baseline truncated (cap exceeded).',
                workflowDiagnostic: truncDiag,
              });
            }
            failRun(
              run,
              'failed',
              `Post-round artifact baseline capture failed: ${errorDiag?.code ?? 'artifact_baseline_too_large'}`,
              serverLink,
            );
            return;
          }
          const before: P2pArtifactBaseline = newArtifactBaseline ?? {
            rootPath: artifactRootResolution.rootPath,
            files: [],
            capturedAt: new Date().toISOString(),
            truncated: false,
          };
          // Cx1-H3 — prefer frozen identity paths; fall back to the round's
          // adapter-projected outputs only when the identity didn't surface
          // declared paths (defensive).
          const declaredSource = identityPaths.length > 0 ? identityPaths : round.artifactOutputs;
          const declaredFiles = declaredSource.map((p) => ({ relativePath: p }));
          const delta = verifyP2pArtifactBaselineDelta(before, afterCapture.baseline, declaredFiles);
          if (!delta.ok) {
            for (const diagnostic of delta.diagnostics) {
              addHelperDiagnostic(run, {
                code: 'P2P_HELPER_PRIMARY_FAILED',
                attempt: run.currentRoundAttempt,
                message: `Artifact contract not satisfied: ${diagnostic.code} ${diagnostic.fieldPath ?? ''} ${diagnostic.summary ?? ''}`.trim(),
                sourceSession: run.initiatorSession,
                workflowDiagnostic: diagnostic,
              });
            }
            const primary = delta.diagnostics[0];
            failRun(
              run,
              'failed',
              `Artifact contract not satisfied: ${primary?.code ?? 'artifact_contract_not_satisfied'} ${primary?.fieldPath ?? ''}`.trim(),
              serverLink,
            );
            return;
          }
        } catch (error) {
          // Cap-exceeded / IO error during post-round capture: surface as a
          // helper diagnostic so audit can see the gap. We do NOT fail the
          // run here because the legacy `validateArtifactOutputsForRound`
          // already ran and either passed or failed the round; failing
          // again would double-fail. PR-γ collapses these two gates.
          addHelperDiagnostic(run, {
            code: 'P2P_HELPER_PRIMARY_FAILED',
            attempt: run.currentRoundAttempt,
            sourceSession: run.initiatorSession,
            message: `Artifact post-round capture failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }

    // R3 v1b follow-up — script and logic nodes do NOT require a verdict
    // marker in the discussion text. Their authoritative routing input
    // is the structured machine-output frame (script) or the evaluator
    // result (logic). Suppressing the verdict requirement avoids spurious
    // P2P_VERDICT_MISSING diagnostics for structured nodes.
    const verdictRequiredForRound = round.requiresVerdict
      && round.nodeKind !== 'script'
      && round.nodeKind !== 'logic';
    const verdict = verdictRequiredForRound ? parseVerdictFromContent(authoritativeSegment) : null;
    const effectiveVerdict = verdictRequiredForRound
      ? (verdict ?? (() => {
        addHelperDiagnostic(run, {
          code: 'P2P_VERDICT_MISSING',
          attempt: run.currentRoundAttempt,
          sourceSession: run.initiatorSession,
          message: `Missing verdict marker for round ${round.id}`,
        });
        return 'REWORK' as const;
      })())
      : null;

    // R3 PR-β (Cx1-H2 / A7 / A8) — for envelope_compiled runs, route on
    // the COMPILED EDGE CONDITIONS rather than the legacy
    // `verdictPolicy: forced_rework` projection. Conditional edges keep
    // their full semantics:
    //   - `routing_key_equals` is matched against `scriptRoutingKey`
    //     (from the script's machine output frame — never read from text)
    //   - `verdict_marker_equals` is matched against `effectiveVerdict`
    //   - `logic_marker_equals` has no production evaluator yet; compile
    //     should already have rejected such workflows, but if one slips
    //     through we skip routing instead of misrouting silently.
    // Per-edge loop budget is honoured via `bound.compiled.loopBudgets`,
    // not the round-aggregated `roundJumpCounts`.
    let jump: string | null = null;
    let jumpTriggerLabel: string | null = effectiveVerdict;
    let jumpEdgeId: string | null = null;
    if (run.advancedSourceKind === 'envelope_compiled' && run.boundWorkflow) {
      const compiled = run.boundWorkflow.compiled;
      const outgoingConditional = compiled.edges.filter(
        (edge) => edge.fromNodeId === round.id && edge.edgeKind === 'conditional',
      );
      for (const edge of outgoingConditional) {
        if (!edge.condition) continue;
        const useCount = run.compiledEdgeUseCounts?.[edge.id] ?? 0;
        const budget = compiled.loopBudgets[edge.id] ?? Infinity;
        if (useCount >= budget) continue;
        let matched = false;
        let triggerValue: string | null = null;
        if (edge.condition.kind === 'routing_key_equals' && typeof scriptRoutingKey === 'string') {
          matched = scriptRoutingKey === edge.condition.equals;
          triggerValue = scriptRoutingKey;
        } else if (edge.condition.kind === 'verdict_marker_equals' && effectiveVerdict !== null) {
          matched = effectiveVerdict === edge.condition.equals;
          triggerValue = effectiveVerdict;
        } else if (edge.condition.kind === 'logic_marker_equals' && typeof logicMarker === 'string') {
          // R3 v1b follow-up — match the logic node's emitted marker
          // against the conditional edge condition. Authority for logic
          // routing is the evaluator output, never discussion text.
          matched = logicMarker === edge.condition.equals;
          triggerValue = logicMarker;
        } else if (edge.condition.kind === 'logic_marker_equals') {
          // No logic marker available (the source node was not a logic
          // node, or evaluation produced no marker). Skip — compiler is
          // expected to reject mismatched routing authority.
          continue;
        }
        if (matched) {
          jump = edge.toNodeId;
          jumpEdgeId = edge.id;
          jumpTriggerLabel = triggerValue;
          break;
        }
      }
    } else if (round.allowRouting && round.jumpRule) {
      // oldAdvanced legacy routing — preserved unchanged.
      const jumpCount = run.roundJumpCounts[round.id] ?? 0;
      const belowMax = jumpCount < round.jumpRule.maxTriggers;
      if (belowMax) {
        if (round.verdictPolicy === 'forced_rework') {
          if (jumpCount < round.jumpRule.minTriggers) {
            jump = round.jumpRule.targetRoundId;
          } else if (effectiveVerdict === (round.jumpRule.marker ?? 'REWORK')) {
            jump = round.jumpRule.targetRoundId;
          }
        } else if (effectiveVerdict === (round.jumpRule.marker ?? 'REWORK')) {
          jump = round.jumpRule.targetRoundId;
        }
      }
    }

    if (jump) {
      run.roundJumpCounts[round.id] = (run.roundJumpCounts[round.id] ?? 0) + 1;
      if (jumpEdgeId) {
        if (!run.compiledEdgeUseCounts) run.compiledEdgeUseCounts = {};
        run.compiledEdgeUseCounts[jumpEdgeId] = (run.compiledEdgeUseCounts[jumpEdgeId] ?? 0) + 1;
      }
      // R3 v2 PR-ζ (M2 / ζ-10) — jump-rebound resets the script retry
      // budget for the target round so a re-execution after rework
      // starts fresh, not "halfway through" a previous transient-error
      // budget that was consumed during the prior visit.
      if (run.scriptRetryCounts) delete run.scriptRetryCounts[jump];
      pushRoutingHistory(run, {
        fromRoundId: round.id,
        toRoundId: jump,
        trigger: jumpTriggerLabel,
        atStep: run.currentExecutionStep,
        atAttempt: run.currentRoundAttempt,
        timestamp: Date.now(),
      });
      roundIndex = rounds.findIndex((entry) => entry.id === jump);
      continue;
    }

    // R3 v2 PR-η — for envelope_compiled runs, advance via the COMPILED
    // GRAPH instead of the legacy `roundIndex++` array fallback. This
    // closes the Cx1-A1 finding: if the current node has outgoing
    // conditional edges but NONE matched the route AND no default edge
    // exists, the previous code silently moved to the next round in
    // declaration order — potentially executing an implementation /
    // artifact_generation node WITHOUT route authorization. Now we
    // either jump to the unique default edge or `failRun` with
    // `unmatched_edge_route`. oldAdvanced runs keep the legacy
    // `roundIndex++` behaviour.
    if (run.advancedSourceKind === 'envelope_compiled' && run.boundWorkflow) {
      const compiled = run.boundWorkflow.compiled;
      const outgoing = compiled.edges.filter((edge) => edge.fromNodeId === round.id);
      const hadConditional = outgoing.some((edge) => edge.edgeKind === 'conditional');
      const defaults = outgoing.filter((edge) => edge.edgeKind === 'default');
      if (defaults.length === 1) {
        const next = defaults[0];
        if (!run.compiledEdgeUseCounts) run.compiledEdgeUseCounts = {};
        run.compiledEdgeUseCounts[next.id] = (run.compiledEdgeUseCounts[next.id] ?? 0) + 1;
        if (run.scriptRetryCounts) delete run.scriptRetryCounts[next.toNodeId];
        pushRoutingHistory(run, {
          fromRoundId: round.id,
          toRoundId: next.toNodeId,
          trigger: 'default',
          atStep: run.currentExecutionStep,
          atAttempt: run.currentRoundAttempt,
          timestamp: Date.now(),
        });
        roundIndex = rounds.findIndex((entry) => entry.id === next.toNodeId);
        if (roundIndex < 0) {
          // Compiled graph references a node not in legacy rounds —
          // shouldn't happen, but fail closed instead of silent skip.
          failRun(run, 'failed', `Compiled default edge target ${next.toNodeId} missing from resolved rounds`, serverLink);
          return;
        }
        continue;
      }
      if (defaults.length > 1) {
        const diag = makeP2pWorkflowDiagnostic('invalid_workflow_graph', 'execute', {
          nodeId: round.id,
          summary: `Compiled graph has ${defaults.length} default outgoing edges from node ${round.id}; expected at most 1.`,
        });
        addHelperDiagnostic(run, {
          code: 'P2P_HELPER_PRIMARY_FAILED',
          attempt: run.currentRoundAttempt,
          sourceSession: run.initiatorSession,
          message: diag.summary ?? 'Multiple default outgoing edges',
          workflowDiagnostic: diag,
        });
        failRun(run, 'failed', `Compiled graph has multiple default edges from ${round.id}`, serverLink);
        return;
      }
      // No default edge.
      if (hadConditional) {
        // Had conditional outgoing edges, none matched, no default —
        // fail closed per spec "envelope_compiled SHALL fail closed
        // when no conditional edge matches AND no default edge exists".
        const diag = makeP2pWorkflowDiagnostic('unmatched_edge_route', 'execute', {
          nodeId: round.id,
          summary: `No outgoing conditional edge matched from ${round.id} and no default edge exists.`,
        });
        addHelperDiagnostic(run, {
          code: 'P2P_HELPER_PRIMARY_FAILED',
          attempt: run.currentRoundAttempt,
          sourceSession: run.initiatorSession,
          message: diag.summary ?? 'unmatched_edge_route',
          workflowDiagnostic: diag,
        });
        failRun(run, 'failed', diag.summary ?? `unmatched_edge_route at ${round.id}`, serverLink);
        return;
      }
      // No outgoing edges at all → terminal node, complete the run.
      break;
    }

    roundIndex += 1;
  }

  if (!ensureRunDeadline(run, serverLink) || run._cancelled || isTerminal(run.status)) return;
  run.runPhase = 'summarizing';
  run.summaryPhase = 'running';
  run.activePhase = 'summary';
  const finalRound = rounds[Math.max(rounds.length - 1, 0)];
  run.timeoutMs = finalRound?.timeoutMs ?? run.timeoutMs;
  /*
   * R3 v2 PR-μ — Resolution chain for the final-run summary prompt:
   *   1. The final round's `summaryPrompt` (already resolved by
   *      `normalizeAdvancedRound` from
   *      `effectiveSummaryPrompt` → user override → per-preset default).
   *      This is the workflow path; envelope_compiled runs always set it.
   *   2. `BUILT_IN_MODES[finalMode].summaryPrompt` (legacy combo path —
   *      audit/review/plan/discuss/brainstorm have rich per-mode
   *      summary prompts here).
   *   3. Generic one-line fallback (true legacy + custom modes).
   */
  const finalRoundSummaryPrompt = finalRound?.summaryPrompt;
  const legacyModeSummaryPrompt = getP2pMode(finalRound?.modeKey ?? run.mode)?.summaryPrompt;
  const resolvedFinalSummaryPrompt = finalRoundSummaryPrompt
    ?? legacyModeSummaryPrompt
    ?? 'Synthesize a final summary that captures the consensus, key decisions, and any remaining disagreements across all rounds.';
  const inlineExecutionSpec = createPostSummaryExecutionSpec(run, {
    cycleIndex: 1,
    cycleTotal: 1,
  });
  const finalPrompt = buildHopPrompt(run, getP2pMode(finalRound?.modeKey ?? run.mode), {
    session: run.initiatorSession,
    sectionHeader: `${discussionParticipantNameWithMode(run.initiatorSession, finalRound?.modeKey ?? run.mode)} — Final Summary`,
    instruction: `${resolvedFinalSummaryPrompt}\nBefore writing the summary, use the hop evidence already appended into the discussion file for this round. If the user context clearly specifies a destination file for the final plan, write the complete plan there. Otherwise, write the complete plan at the end of the discussion file.\n\n${buildInlinePostSummaryExecutionInstruction(run, inlineExecutionSpec)}`,
    isInitial: false,
    allowsExecution: true,
  });
  const summaryOk = await dispatchHop(run, run.initiatorSession, finalPrompt, serverLink, {
    sectionHeader: `${discussionParticipantNameWithMode(run.initiatorSession, finalRound?.modeKey ?? run.mode)} — Final Summary`,
    required: true,
    executionMarkerSpec: inlineExecutionSpec,
  });
  if (!summaryOk && (run._cancelled || isTerminal(run.status))) return;
  run.summaryPhase = summaryOk ? 'completed' : 'failed';
  if (run._cancelled || isTerminal(run.status)) return;

  const executionOk = await runPostSummaryExecutionGate(run, serverLink, {
    cycleIndex: inlineExecutionSpec.cycleIndex,
    cycleTotal: inlineExecutionSpec.cycleTotal,
    timeoutMs: run.timeoutMs * 3,
    spec: inlineExecutionSpec,
    initialPromptAlreadyDispatched: true,
  });
  if (!executionOk || run._cancelled || isTerminal(run.status)) return;

  // R3 v1b (W2) — flush the discussion write queue before reading so the
  // result summary captures every queued segment instead of an
  // intermediate snapshot.
  await flushP2pDiscussionWriteQueue(run.contextFilePath);
  let fullContent = '';
  try {
    fullContent = await readFile(run.contextFilePath, 'utf8');
    run.resultSummary = fullContent.slice(-2000);
    if (run.launchOrigin?.kind === 'openspec_auto_deliver') {
      run.strictAuthoritativeResult = extractOpenSpecAutoDeliverStrictSegment(fullContent);
    }
  } catch { /* ignore */ }
  run.completedAt = new Date().toISOString();
  transition(run, 'completed', serverLink);
  // A3: `activeRuns.delete` is now scheduled by
  // `scheduleP2pRunTerminalCleanup` (called from `transition('completed')`
  // above), so no explicit timer here.
}

// ── Single hop dispatch + wait ────────────────────────────────────────────

interface DispatchHopOptions {
  sectionHeader: string;
  filePath?: string;
  hop?: P2pHopRuntime | null;
  required?: boolean;
  executionMarkerSpec?: PostSummaryExecutionRuntimeSpec | null;
}

function normalizeDiscussionSectionHeader(value: string): string {
  return value.toLowerCase().replace(/[–—]/g, '-').replace(/--/g, '-');
}

async function discussionFileContainsSectionHeader(filePath: string, sectionHeader: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, 'utf8');
    return normalizeDiscussionSectionHeader(content).includes(
      normalizeDiscussionSectionHeader(`## ${sectionHeader}`),
    );
  } catch {
    return false;
  }
}

async function dispatchHop(
  run: P2pRun,
  session: string,
  prompt: string,
  serverLink: ServerLink | null,
  options: DispatchHopOptions,
): Promise<boolean> {
  const { sectionHeader, hop = null, required = false } = options;
  run.currentTargetSession = session;
  if (hop) {
    run.activeTargetSessions = Array.from(new Set([...run.activeTargetSessions, session]));
    updateHopStatus(run, hop, 'dispatched');
  }
  run.hopStartedAt = Date.now();
  transition(run, 'dispatched', serverLink);

  const targetRecord = getSession(session);
  const targetDir = targetRecord?.projectDir || null;
  const sourcePath = options.filePath ?? run.contextFilePath;
  const sourceDir = dirname(dirname(dirname(sourcePath))) || null;
  const isCrossProject = targetDir && sourceDir && targetDir !== sourceDir;
  let localCopyPath: string | null = null;

  if (isCrossProject) {
    const targetDiscussDir = await ensureImcDir(targetDir, 'discussions');
    localCopyPath = join(targetDiscussDir, basename(sourcePath));
    try {
      await copyFile(sourcePath, localCopyPath);
      prompt = prompt.replace(sourcePath, localCopyPath);
      logger.info({ runId: run.id, session, from: sourcePath, to: localCopyPath }, 'P2P: copied discussion file to target project');
    } catch (err) {
      logger.warn({ runId: run.id, session, err }, 'P2P: failed to copy discussion file to target project');
      localCopyPath = null;
    }
  }

  const watchPath = localCopyPath ?? sourcePath;
  if (hop) hop.working_path = watchPath;
  const MAX_RETRIES = 0;
  // Required legacy hops (initiator initial-analysis + round summaries) get a
  // doubled wait window because they are more important than ordinary
  // participant hops. If they still produce no output, mark that legacy hop
  // skipped and continue with the evidence we have instead of re-sending the
  // same prompt after a successful dispatch. Advanced workflow rounds keep
  // their strict per-round timeout semantics.
  const REQUIRED_HOP_TIMEOUT_MULTIPLIER = 2;
  const effectiveTimeoutMs = required
    ? run.timeoutMs * REQUIRED_HOP_TIMEOUT_MULTIPLIER
    : run.timeoutMs;

  const finishHop = async (status: P2pHopStatus, error: string | null = null) => {
    if (localCopyPath && status === 'completed') {
      try {
        await copyFile(localCopyPath, sourcePath);
        logger.info({ runId: run.id, session }, 'P2P: copied discussion result back to source project');
      } catch (err) {
        logger.warn({ runId: run.id, session, err }, 'P2P: failed to copy discussion result back');
      }
    }
    updateHopStatus(run, hop, status, error);
    run.currentTargetSession = null;
    run.activeTargetSessions = run.activeTargetSessions.filter((item) => item !== session);
    const target = run.remainingTargets.find((t) => t.session === session);
    run.remainingTargets = run.remainingTargets.filter((t) => t.session !== session);
    if (status !== 'completed') {
      run.skippedHops.push(session);
    } else if (target) {
      run.completedHops.push(target);
    }
  };

  if (sectionHeader && await discussionFileContainsSectionHeader(watchPath, sectionHeader)) {
    logger.warn(
      { runId: run.id, session, sectionHeader },
      'P2P: section already exists in discussion file — completing hop without duplicate dispatch',
    );
    await finishHop('completed');
    pushState(run, serverLink);
    return true;
  }

  const abortForOverallTimeout = async () => {
    if (hop) {
      await finishHop('timed_out', 'advanced_run_timeout');
    } else {
      run.currentTargetSession = null;
      run.activeTargetSessions = run.activeTargetSessions.filter((item) => item !== session);
    }
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (run._cancelled) {
      await finishHop('cancelled');
      return false;
    }

    let sizeBefore = 0;
    try { sizeBefore = (await stat(watchPath)).size; } catch {}
    let queuedDispatch = false;

    try {
      const dispatchResult = await dispatchP2pPromptToSession({
        run,
        session,
        prompt,
        reason: sectionHeader ? 'discussion_section_prompt' : 'discussion_prompt',
      });
      queuedDispatch = dispatchResult === 'queued';
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        logger.warn({ runId: run.id, session, attempt }, 'P2P: dispatch failed, will retry');
        await sleep(2_000);
        continue;
      }
      const errorMessage = String(err);
      logger.warn({ runId: run.id, session, err }, 'P2P: hop dispatch failed after retry');
      await finishHop('failed', errorMessage);
      if (required) failRun(run, 'dispatch_failed', errorMessage, serverLink);
      else pushState(run, serverLink);
      return false;
    }

    let idleEventReceived = false;
    const idleWaiter = waitForIdleEvent(session, effectiveTimeoutMs);
    idleWaiter.promise.then((ok) => { idleEventReceived = ok; });

    const GRACE_PERIOD_MS = GRACE_PERIOD_DEFAULT_MS;
    const dispatchTime = Date.now();
    const deadline = dispatchTime + effectiveTimeoutMs;
    const hardDeadline = deadline + 60_000;
    let fileGrew = false;
    let lastSize = sizeBefore;
    let lastGrowthAt = 0;
    let headingFound = false;
    let executionMarkerFound = false;
    let queueStopSent = false;

    while (Date.now() < deadline) {
      if (!ensureRunDeadline(run, serverLink)) {
        idleWaiter.cancel();
        await abortForOverallTimeout();
        return false;
      }
      if (Date.now() >= hardDeadline) {
        logger.warn({ runId: run.id, session }, 'P2P: hard deadline reached, force-skipping hop');
        break;
      }
      if (run._cancelled) {
        idleWaiter.cancel();
        await finishHop('cancelled');
        return false;
      }
      await sleep(IDLE_POLL_MS);
      if (!ensureRunDeadline(run, serverLink)) {
        idleWaiter.cancel();
        await abortForOverallTimeout();
        return false;
      }
      if (Date.now() >= hardDeadline) {
        logger.warn({ runId: run.id, session }, 'P2P: hard deadline reached, force-skipping hop');
        break;
      }
      if (run._cancelled) {
        idleWaiter.cancel();
        await finishHop('cancelled');
        return false;
      }

      try {
        const currentSize = (await stat(watchPath)).size;
        if (currentSize > lastSize) {
          lastSize = currentSize;
          lastGrowthAt = Date.now();
          if (!fileGrew) {
            fileGrew = true;
            if (run.status === 'dispatched') transition(run, 'running', serverLink);
            updateHopStatus(run, hop, 'running');
          }
          idleEventReceived = false;
        }
        if (sectionHeader && !headingFound && currentSize > sizeBefore) {
          const content = await readFile(watchPath, 'utf8');
          if (normalizeDiscussionSectionHeader(content).includes(normalizeDiscussionSectionHeader(`## ${sectionHeader}`))) {
            headingFound = true;
            if (!fileGrew) {
              fileGrew = true;
              if (run.status === 'dispatched') transition(run, 'running', serverLink);
              updateHopStatus(run, hop, 'running');
            }
          }
        }
      } catch {}

      if (options.executionMarkerSpec) {
        const markerState = await readPostSummaryExecutionMarker(options.executionMarkerSpec);
        if (markerState?.ok || markerState?.failedByAgent) {
          executionMarkerFound = true;
          logger.info(
            {
              runId: run.id,
              session,
              markerPath: options.executionMarkerSpec.markerPath,
              markerStatus: markerState.marker?.status,
            },
            'P2P: inline execution marker found; waiting for final answer/idle before completing summary hop',
          );
        }
      }

      const settleForGrowth = IDLE_POLL_MS * FILE_SETTLE_CYCLES;
      if (!headingFound && fileGrew && (lastSize - sizeBefore) > 500 &&
          lastGrowthAt > 0 && (Date.now() - lastGrowthAt) >= settleForGrowth &&
          (Date.now() - dispatchTime) > MIN_PROCESSING_MS) {
        logger.info({ runId: run.id, session, growth: lastSize - sizeBefore }, 'P2P: content growth fallback observed; waiting for final idle before completing hop');
      }

      const canCheckIdle = (Date.now() - dispatchTime) > MIN_PROCESSING_MS;
      if (!canCheckIdle) continue;

      const pastGrace = (Date.now() - dispatchTime) > GRACE_PERIOD_MS;
      const settleMs = IDLE_POLL_MS * FILE_SETTLE_CYCLES;
      const fileSettled = fileGrew && lastGrowthAt > 0 && (Date.now() - lastGrowthAt) >= settleMs;

      if (!fileGrew && !headingFound) {
        queueStopSent = await maybeStopStaleP2pTransportQueue({
          run,
          session,
          dispatchStartedAt: dispatchTime,
          alreadyStopped: queueStopSent,
          reason: 'discussion_section_missing',
          staleAfterMs: queuedDispatch ? QUEUED_PROMPT_STOP_AFTER_MS : undefined,
        });
      }

      if (fileSettled || executionMarkerFound || (pastGrace && !fileGrew)) {
        let idleConfirmed = false;
        const record = getSession(session);
        const agentType = (record?.agentType ?? 'claude-code') as import('../agent/detect.js').AgentType;
        const useStoreState = agentType === 'gemini';

        try {
          if (useStoreState) {
            idleConfirmed = record?.state === 'idle';
          } else {
            idleConfirmed = await detectStatusAsync(session, agentType) === 'idle';
          }
        } catch {
          idleConfirmed = idleEventReceived;
        }

        if (fileSettled && idleConfirmed) {
          try {
            const finalSize = (await stat(watchPath)).size;
            if (finalSize > lastSize) {
              lastSize = finalSize;
              lastGrowthAt = Date.now();
              idleEventReceived = false;
              continue;
            }
          } catch {}
          idleWaiter.cancel();
          await finishHop('completed');
          pushState(run, serverLink);
          return true;
        }

        if (executionMarkerFound && !fileGrew && idleConfirmed) {
          idleWaiter.cancel();
          await finishHop('completed');
          pushState(run, serverLink);
          return true;
        }

        if (!fileGrew && pastGrace && idleConfirmed) {
          // Final race guard before re-sending the prompt:
          //
          // The poll tick above stat'd the file up to IDLE_POLL_MS (3s) ago.
          // A legitimate response that lands in that 3s window would be
          // invisible to `fileGrew` here, so without this second stat() we'd
          // re-dispatch the same prompt on top of a just-started response,
          // producing either a duplicate answer or an agent that gets
          // confused about which prompt it's answering.
          //
          // Re-stat right at the retry decision — if the file has grown we
          // treat it as "already executed" and fall through to the normal
          // completion detection path (continue polling for settle + idle).
          try {
            const freshSize = (await stat(watchPath)).size;
            if (freshSize > sizeBefore) {
              lastSize = freshSize;
              lastGrowthAt = Date.now();
              fileGrew = true;
              idleEventReceived = false;
              if (run.status === 'dispatched') transition(run, 'running', serverLink);
              updateHopStatus(run, hop, 'running');
              logger.info(
                { runId: run.id, session, attempt, grown: freshSize - sizeBefore },
                'P2P: agent wrote to file between last poll and retry decision — skipping reminder',
              );
              continue;
            }
          } catch {}

          // Idle without output is not proof that the prompt was not delivered.
          // Keep waiting until the hop timeout instead of sending a duplicate
          // prompt into a potentially slow/queued model turn.
          continue;
        }
      }
    }

    idleWaiter.cancel();

    if (!fileGrew && attempt < MAX_RETRIES && Date.now() < hardDeadline) {
      // Same race guard as the in-loop retry branch above: the poll tick
      // may have missed growth in the final IDLE_POLL_MS window. Re-stat
      // before re-dispatching — if the agent has responded, treat it as
      // already executed and fall into the next iteration's wait loop
      // instead of firing a duplicate prompt.
      try {
        const freshSize = (await stat(watchPath)).size;
        if (freshSize > sizeBefore) {
          logger.info(
            { runId: run.id, session, attempt, grown: freshSize - sizeBefore },
            'P2P: agent wrote to file between deadline and retry decision — skipping reminder',
          );
          // Fall through to timeout path: we observed growth but no completion
          // signal before the deadline. Treat as failed-to-complete (hop timed
          // out) rather than firing another prompt on top of an in-flight
          // response. The written content is preserved on disk either way.
        } else {
          continue;
        }
      } catch {
        continue;
      }
    }

    // Resilience for non-skippable hops: if the host actually wrote content to
    // the discussion file but never emitted a clean completion signal (e.g.
    // growth stayed under the settle threshold, or it never went idle), do NOT
    // nuke the entire run on the final deadline. The partial analysis/summary
    // is already on disk and is far more useful than a hard failure. Accept it
    // as completed and let the discussion continue.
    if (required && fileGrew) {
      try {
        const finalSize = (await stat(watchPath)).size;
        if (finalSize > sizeBefore) {
          logger.warn(
            { runId: run.id, session, grown: finalSize - sizeBefore },
            'P2P: required hop hit deadline with partial content — accepting partial work instead of failing run',
          );
          await finishHop('completed');
          pushState(run, serverLink);
          return true;
        }
      } catch {}
    }

    if (required && !fileGrew && !run.advancedP2pEnabled) {
      logger.warn(
        { runId: run.id, session, activePhase: run.activePhase },
        'P2P: required hop produced no discussion output — marking hop skipped without failing run',
      );
      await finishHop('failed', 'idle_without_file_change');
      pushState(run, serverLink);
      return false;
    }

    logger.warn({ runId: run.id, session }, 'P2P: hop timed out');
    await finishHop('timed_out', 'timed_out');
    if (required) failRun(run, 'timed_out', session, serverLink);
    else pushState(run, serverLink);
    return false;
  }

  return false;
}

// ── Prompt construction ───────────────────────────────────────────────────

export interface HopOpts {
  session: string;
  sectionHeader: string;
  instruction: string;
  isInitial: boolean;
  filePath?: string;
  allowsExecution?: boolean;
}

export function buildHopPrompt(run: P2pRun, mode: P2pMode | undefined, opts: HopOpts, roundPrefix = ''): string {
  const parts: string[] = [];
  const filePath = opts.filePath ?? run.contextFilePath;

  // Round-aware prefix (empty for single-round runs)
  if (roundPrefix) {
    parts.push(roundPrefix);
  }

  // Shared discussion-quality prompt
  parts.push(P2P_BASELINE_PROMPT);

  // Mode role prompt
  if (mode?.prompt) {
    parts.push(mode.prompt);
  }

  // Prompt: assertive and unambiguous. File path mentioned exactly ONCE to prevent
  // Claude Code from parsing two paths and executing the task twice.
  // Stronger phrasing needed for Gemini/Codex to execute reliably.
  //
  // Summary prompts may include execution instructions — use framing that has
  // the LLM write the discussion section first, then act on the user's request.
  const isFinalSummary = opts.sectionHeader.includes('Final Summary');
  const allowsExecution = opts.allowsExecution === true;
  parts.push(``);
  parts.push(`[P2P Discussion Task — run ${run.id}]`);
  parts.push(``);
  if (isFinalSummary) {
    parts.push(`This is the FINAL round of a multi-agent discussion.`);
    parts.push(`Discussion file: ${run.contextFilePath}`);
    parts.push(``);
    parts.push(`Steps:`);
    parts.push(`1. Read the discussion file and use both the user's original request and the final discussion evidence as source context`);
    parts.push(`2. Infer whether the user context specifies a concrete destination file for the final plan`);
    parts.push(`3. If a concrete destination file is clear from the user context, write the complete plan there. Otherwise, write the complete plan at the end of the discussion file under a new heading "## ${opts.sectionHeader}"`);
    parts.push(`4. If you wrote the plan to another file, still append a short note under "## ${opts.sectionHeader}" in the discussion file that records the destination path and confirms the plan was written`);
    parts.push(``);
    parts.push(`Final summary instructions:`);
    parts.push(opts.instruction);
  } else {
    parts.push(`This is a dedicated discussion file for multi-agent analysis: ${filePath}`);
    if (allowsExecution) {
      parts.push(`Write the required discussion section into this file first. After that section is written, continue with the execution instructions in this same prompt.`);
    } else {
      parts.push(`All output MUST go into this file. Do NOT modify any other files or run any commands.`);
    }
    parts.push(`Your identity for this discussion run is "${discussionParticipantName(opts.session)}". When later rounds refer to this code name, they mean you.`);
    parts.push(``);
    parts.push(`Steps:`);
    parts.push(`1. Read the discussion file`);
    parts.push(`2. ${opts.instruction}`);
    parts.push(`3. Add a new heading "## ${opts.sectionHeader}" at the end of this file and write your analysis below it`);
    parts.push(``);
    if (allowsExecution) {
      parts.push(`Rules: The analysis/summary portion goes into this same file under the requested heading. Do not edit code files before that section is written; then follow the execution block and write the required marker.`);
    } else {
      parts.push(`Rules: ALL analysis goes into this same file. Do NOT edit code files. Do NOT implement fixes.`);
    }
    parts.push(`For this task, if the discussion file does not explicitly provide the relevant code, diff, or file paths, treat the current project codebase in your working directory as the referenced context for the audit.`);
    parts.push(`You MUST inspect the relevant source files in the current project codebase directly and base your analysis on that code.`);
    parts.push(`Do NOT respond that code context is missing if the working-directory project codebase is available.`);
  }
  parts.push(`Do NOT ask for confirmation. Do NOT explain your plan. Start immediately.`);
  parts.push(allowsExecution
    ? `After writing to the file and completing the execution instructions, print a brief response summary of what you did, then say: Done`
    : `After writing to the file, print a brief response summary of what you wrote, then say: Done`);

  // Time budget: let the agent know how long it has for this hop
  const budgetMinutes = Math.floor(run.timeoutMs / 60_000);
  if (budgetMinutes > 0) {
    parts.push(`\nTime budget: You have approximately ${budgetMinutes} minute${budgetMinutes > 1 ? 's' : ''} for this task. Prioritize the most important points and wrap up before the deadline. If you run out of time your work will be skipped.`);
  }

  // User-defined extra prompt (e.g. "使用中文回复", "focus on security")
  if (run.extraPrompt) {
    parts.push('');
    parts.push(`Additional instructions: ${run.extraPrompt}`);
  }

  const langLine = buildP2pLanguageInstruction(run.locale);
  if (langLine) {
    parts.push('');
    parts.push(langLine);
  }

  return parts.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * R3 v2 PR-ζ (A6 / O4) — Single source of truth for run-terminal cleanup.
 * Schedules:
 *   1. Discussion writer queue drop (frees `onWriteFailure` closure that
 *      otherwise pins the run object).
 *   2. Frozen artifact identity in-memory + on-disk clear.
 *   3. `runArtifactRootCache` entry clear.
 * Idempotent: safe to call from both `transition` and `failRun`. Wraps
 * everything in a single 60 s `setTimeout` so a late web read can still
 * see the discussion file / identity for a brief grace window — matching
 * the existing `activeRuns.delete` cadence.
 *
 * Audit fix (94b9b837-822 / A3) — `activeRuns.delete(run.id)` is now
 * funnelled through this single cleanup point. Previously the failed /
 * timed_out paths hit `failRun()` which called this helper but did NOT
 * remove the `P2pRun` from `activeRuns`, so failure/timeout runs leaked
 * indefinitely. Only the success path (line 1278) and the older summary
 * path (line 2710) had their own 60 s `setTimeout` to delete from
 * `activeRuns`, so anything reaching `failed`/`timed_out` stayed forever.
 * Cancel paths still call `activeRuns.delete(runId)` synchronously for
 * immediate UX disappearance — the deferred delete here is then a
 * harmless no-op miss.
 */
const terminalCleanupScheduled = new Set<string>();
function scheduleP2pRunTerminalCleanup(run: P2pRun): void {
  if (!P2P_TERMINAL_RUN_STATUSES.has(run.status)) return;
  if (terminalCleanupScheduled.has(run.id)) return;
  terminalCleanupScheduled.add(run.id);
  setTimeout(() => {
    try {
      void dropP2pDiscussionWriteQueue(run.contextFilePath);
    } catch { /* ignore */ }
    try {
      void clearPersistedFrozenP2pArtifactIdentity(run.id);
    } catch { /* ignore */ }
    try {
      runArtifactRootCache.delete(run.id);
    } catch { /* ignore */ }
    // A3: unified activeRuns delete — covers completed/failed/timed_out/cancelled.
    activeRuns.delete(run.id);
    terminalCleanupScheduled.delete(run.id);
  }, 60_000);
}

/** Test-only: clear the terminal-cleanup scheduling registry between runs. */
export function __resetP2pRunTerminalCleanupForTests(): void {
  terminalCleanupScheduled.clear();
}

function transition(run: P2pRun, status: P2pRunStatus, serverLink: ServerLink | null): void {
  run.status = status;
  if (status === 'completed') {
    run.runPhase = 'completed';
    run.summaryPhase = 'completed';
  } else if (status === 'cancelled') {
    run.runPhase = 'cancelled';
  } else if (status === 'failed') {
    run.runPhase = 'failed';
  }
  if (P2P_TERMINAL_RUN_STATUSES.has(status)) {
    run.completedAt = run.completedAt ?? new Date().toISOString();
    if (run.advancedP2pEnabled) {
      void cleanupRoundHopArtifacts(run.hopStates);
    } else {
      scheduleRoundHopArtifactCleanup(run.hopStates);
    }
    scheduleP2pRunTerminalCleanup(run);
  }
  run.updatedAt = new Date().toISOString();
  logger.info({ runId: run.id, status }, 'P2P run state transition');
  pushState(run, serverLink);
}

function failRun(run: P2pRun, errorType: string, message: string, serverLink: ServerLink | null): void {
  run.error = `${errorType}: ${message}`;
  run.completedAt = run.completedAt ?? new Date().toISOString();
  run.updatedAt = new Date().toISOString();
  const status: P2pRunStatus = errorType === 'timed_out' ? 'timed_out' : 'failed';
  run.status = status;
  if (status === 'failed') {
    run.runPhase = 'failed';
  }
  if (run.activePhase === 'summary') {
    run.summaryPhase = 'failed';
  }
  if (run.advancedP2pEnabled) {
    void cleanupRoundHopArtifacts(run.hopStates);
  } else {
    scheduleRoundHopArtifactCleanup(run.hopStates);
  }
  scheduleP2pRunTerminalCleanup(run);
  logger.warn({ runId: run.id, errorType, message }, 'P2P run failed');
  pushState(run, serverLink);
}

// Audit:R3 hardening / task 10.5 — projection 200 ms debounce. Non-terminal
// updates within the window are coalesced (last-write-wins) so that a long
// streaming round doesn't fire dozens of `p2p.run_save` events per second.
// Terminal statuses (`completed` / `failed` / `timed_out` / `cancelled`) and
// blocking diagnostics (errors) ALWAYS flush immediately — both because the
// UI must reflect them without delay AND because a deferred terminal would
// race with `delete activeRuns.get(runId)` cleanup.
const PROJECTION_DEBOUNCE_MS = 200;
const pendingProjectionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function flushProjection(run: P2pRun, serverLink: ServerLink | null): void {
  if (!serverLink) return;
  const s = run.status as string;
  const type = s === 'completed' ? 'p2p.run_complete'
    : (s === 'failed' || s === 'timed_out' || s === 'cancelled') ? 'p2p.run_error'
      : 'p2p.run_save';
  try {
    serverLink.send({ type, run: serializeP2pRun(run) });
  } catch { /* not connected */ }
}

function pushState(run: P2pRun, serverLink: ServerLink | null): void {
  if (!serverLink) return;
  const existingTimer = pendingProjectionTimers.get(run.id);
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
    pendingProjectionTimers.delete(run.id);
  }
  // Terminal / blocking → flush immediately. Helper status check is
  // intentionally over-broad (any non-running/queued/dispatched) so a future
  // status added to `P2P_TERMINAL_RUN_STATUSES` automatically flushes.
  const isTerminalStatus = isTerminal(run.status);
  const isBlockingDiagnostic = (run.helperDiagnostics ?? []).some((d) => (d as { severity?: string }).severity === 'error');
  if (isTerminalStatus || isBlockingDiagnostic) {
    flushProjection(run, serverLink);
    return;
  }
  // Non-terminal: schedule a coalesced flush.
  const timer = setTimeout(() => {
    pendingProjectionTimers.delete(run.id);
    flushProjection(run, serverLink);
  }, PROJECTION_DEBOUNCE_MS);
  pendingProjectionTimers.set(run.id, timer);
}

/** Test-only: drain any pending throttled projections. */
export function __flushPendingP2pProjectionsForTests(): void {
  for (const [runId, timer] of pendingProjectionTimers) {
    clearTimeout(timer);
    pendingProjectionTimers.delete(runId);
  }
}

function isTerminal(status: P2pRunStatus): boolean {
  return P2P_TERMINAL_RUN_STATUSES.has(status);
}

function extractMainSession(sessionName: string): string {
  // Sub-sessions (deck_sub_*) don't follow the deck_{project}_{role} pattern.
  // Look up the parent session from the store to resolve the correct domain.
  if (sessionName.startsWith('deck_sub_')) {
    const record = getSession(sessionName);
    if (record?.parentSession) {
      return extractMainSession(record.parentSession);
    }
    // No parent found — fall through to name-based extraction
  }
  // deck_myapp_brain → deck_myapp
  const parts = sessionName.split('_');
  if (parts.length >= 3) return parts.slice(0, -1).join('_');
  return sessionName;
}

function shortName(session: string): string {
  return shortP2pSessionName(session);
}

function discussionParticipantName(session: string): string {
  const record = getSession(session);
  return formatP2pParticipantIdentity({
    session,
    label: record?.label,
    agentType: record?.agentType,
    ccPreset: record?.ccPreset,
  });
}

function discussionParticipantNameWithMode(session: string, mode: string): string {
  return `${discussionParticipantName(session)}:${mode}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function countHopStates(hops: P2pHopRuntime[]): P2pHopCounts {
  return {
    total: hops.length,
    queued: hops.filter((hop) => hop.status === 'queued').length,
    dispatched: hops.filter((hop) => hop.status === 'dispatched').length,
    running: hops.filter((hop) => hop.status === 'running').length,
    completed: hops.filter((hop) => hop.status === 'completed').length,
    timed_out: hops.filter((hop) => hop.status === 'timed_out').length,
    failed: hops.filter((hop) => hop.status === 'failed').length,
    cancelled: hops.filter((hop) => hop.status === 'cancelled').length,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
