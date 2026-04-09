/**
 * P2P Quick Discussion orchestrator.
 *
 * Flow: initiator(initial) → sub1 → sub2 → ... → initiator(summary)
 * All output written to a per-run temp file — not the screen.
 * Completion = file grew + agent idle.
 */

import { appendFile, readdir, stat, writeFile, readFile, unlink, copyFile } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { ensureImcDir } from '../util/imc-dir.js';
import { randomUUID } from 'node:crypto';
import { sendKeysDelayedEnter } from '../agent/tmux.js';
import { detectStatusAsync } from '../agent/detect.js';
import { getSession } from '../store/session-store.js';
import { getTransportRuntime, launchTransportSession, stopTransportRuntimeSession } from '../agent/session-manager.js';
import { P2P_BASELINE_PROMPT, getP2pMode, getModeForRound, isComboMode, parseModePipeline, roundPrompt, type P2pMode } from '../../shared/p2p-modes.js';
import {
  resolveP2pRoundPlan,
  type P2pAdvancedRound,
  type P2pContextReducerConfig,
  type P2pHelperDiagnostic,
  type P2pParticipantSnapshotEntry,
  type P2pResolvedPlan,
  type P2pResolvedRound,
} from '../../shared/p2p-advanced.js';
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
import logger from '../util/logger.js';
import type { ServerLink } from './server-link.js';
import { timelineEmitter } from './timeline-emitter.js';

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
  fileContents: Array<{ path: string; content: string }>;
  serverLink: ServerLink | null;
  rounds?: number;
  extraPrompt?: string;
  modeOverride?: string;
  hopTimeoutMs?: number;
  advancedPresetKey?: string;
  advancedRounds?: P2pAdvancedRound[];
  advancedRunTimeoutMs?: number;
  contextReducer?: P2pContextReducerConfig;
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
  timeoutMs: number;
  resultSummary: string | null;
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
  /** Parallel hop runtime state across all rounds. */
  hopStates: P2pHopRuntime[];
  activeTargetSessions: string[];
  advancedP2pEnabled: boolean;
  resolvedRounds?: P2pResolvedRound[];
  helperEligibleSnapshot: P2pParticipantSnapshotEntry[];
  contextReducer?: P2pContextReducerConfig;
  advancedRunTimeoutMs?: number;
  deadlineAt?: number | null;
  currentRoundId?: string | null;
  currentExecutionStep: number;
  currentRoundAttempt: number;
  roundAttemptCounts: Record<string, number>;
  roundJumpCounts: Record<string, number>;
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

export function getP2pRun(id: string): P2pRun | undefined { return activeRuns.get(id); }
export function listP2pRuns(): P2pRun[] { return [...activeRuns.values()]; }

export function serializeP2pRun(run: P2pRun): P2pRunUpdatePayload {
  const completedHopCount = run.hopStates.filter((hop) => hop.status === 'completed').length;
  const currentRoundCompletedHopCount = run.hopStates.filter(
    (hop) => hop.round_index === run.currentRound && hop.status === 'completed',
  ).length;
  const activeHopStates = run.hopStates.filter((hop) =>
    hop.round_index === run.currentRound &&
    (hop.status === 'running' || hop.status === 'dispatched'),
  );
  const currentHopState = activeHopStates[0] ?? null;
  const currentHop = currentHopState?.session ?? run.activeTargetSessions[0] ?? run.currentTargetSession;
  const hopCounts = countHopStates(run.hopStates);
  const routingHistory = Array.isArray(run.routingHistory) ? run.routingHistory : [];
  const latestStepByRoundId = routingHistory.reduce<Record<string, number>>((acc, entry) => {
    if (typeof entry.toRoundId === 'string' && typeof entry.atStep === 'number') {
      acc[entry.toRoundId] = entry.atStep;
    }
    return acc;
  }, {});

  return {
    id: run.id,
    discussion_id: run.discussionId,
    server_id: '', // filled by bridge from auth context
    main_session: run.mainSession,
    initiator_session: run.initiatorSession,
    current_target_session: currentHop,
    final_return_session: run.finalReturnSession,
    remaining_targets: JSON.stringify(run.remainingTargets),
    mode_key: run.mode,
    current_round_mode: isComboMode(run.mode) ? (getModeForRound(run.mode, run.currentRound)?.key ?? run.mode) : run.mode,
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
    current_round: run.currentRound,
    total_rounds: run.rounds,
    skipped_hops: run.skippedHops,
    active_phase: run.activePhase,
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
        phase: 'initial' | 'hop' | 'summary';
        status: 'done' | 'active' | 'pending' | 'skipped';
      };
      const nodes: NodeInfo[] = [];
      const getInfo = (s: string, mode: string, phase: 'initial' | 'hop' | 'summary') => {
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
        return pipeline[Math.min(round - 1, pipeline.length - 1)];
      };

      const initMode = resolveMode(1);
      const init = getInfo(run.initiatorSession, initMode, 'initial');
      const phase1Done = run.currentRound > 1 || hopCounts.completed > 0 || run.status === 'completed';
      const phase1Active = run.activePhase === 'initial';
      nodes.push({ session: run.initiatorSession, ...init, status: phase1Done ? 'done' : phase1Active ? 'active' : 'pending' });

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

      const summaryDone = run.status === 'completed';
      const summaryActive = run.activePhase === 'summary' && !summaryDone;
      const lastMode = combo ? resolveMode(run.rounds) : run.mode;
      const summary = getInfo(run.initiatorSession, lastMode, 'summary');
      nodes.push({ session: run.initiatorSession, ...summary, status: summaryDone ? 'done' : summaryActive ? 'active' : 'pending' });
      return nodes;
    })(),
  };
}

// ── Constants ─────────────────────────────────────────────────────────────

let IDLE_POLL_MS = 3_000;
let GRACE_PERIOD_DEFAULT_MS = 180_000; // 3 min — complex analysis (subagent research + write) takes time
let MIN_PROCESSING_MS = 30_000; // Don't trust idle detection until 30s after dispatch
let FILE_SETTLE_CYCLES = 3; // File must stop growing for 3 poll cycles (9s) to be "settled"
let ROUND_HOP_CLEANUP_DELAY_MS = 0;

/** Override poll interval for tests. */
export function _setIdlePollMs(ms: number): void { IDLE_POLL_MS = ms; }
/** Override grace period for tests. */
export function _setGracePeriodMs(ms: number): void { GRACE_PERIOD_DEFAULT_MS = ms; }
/** Override min processing time for tests. */
export function _setMinProcessingMs(ms: number): void { MIN_PROCESSING_MS = ms; }
/** Override file settle cycles for tests. */
export function _setFileSettleCycles(n: number): void { FILE_SETTLE_CYCLES = n; }
/** Override round hop artifact cleanup delay for tests. */
export function _setRoundHopCleanupDelayMs(ms: number): void { ROUND_HOP_CLEANUP_DELAY_MS = ms; }

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
  const {
    initiatorSession,
    targets,
    userText,
    fileContents,
    serverLink,
    rounds,
    extraPrompt,
    modeOverride,
    hopTimeoutMs,
    advancedPresetKey,
    advancedRounds,
    advancedRunTimeoutMs,
    contextReducer,
  } = normalizeStartP2pRunArgs(args);
  // Validate same domain
  const mainSession = extractMainSession(initiatorSession);
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
    : Math.min(P2P_MAX_ROUNDS, Math.max(1, rounds ?? 1));
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
    timeoutMs: Math.min(hopTimeoutMs ?? modeConfig?.defaultTimeoutMs ?? 300_000, 600_000),
    resultSummary: null,
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
    hopStates: [],
    activeTargetSessions: [],
    advancedP2pEnabled: resolvedPlan.advanced,
    resolvedRounds: resolvedPlan.advanced ? resolvedPlan.rounds : undefined,
    helperEligibleSnapshot: resolvedPlan.helperEligibleSnapshot ?? helperEligibleSnapshot,
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
    routingHistory: [],
    helperDiagnostics: [],
    _cancelled: false,
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

export async function cancelP2pRun(runId: string, serverLink: ServerLink | null): Promise<boolean> {
  const run = activeRuns.get(runId);
  if (!run) return false;

  run._cancelled = true;
  run.runPhase = 'cancelled';

  if (run.status === 'queued') {
    run.activePhase = 'queued';
    transition(run, 'cancelled', serverLink);
    activeRuns.delete(runId);
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
    return true;
  }

  activeRuns.delete(runId);
  return true;
}

// ── Resume after daemon restart ───────────────────────────────────────────

export async function resumePendingOrchestrations(serverLink: ServerLink | null): Promise<void> {
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
  for (; run.currentRound <= run.rounds; run.currentRound++) {
    if (run._cancelled || isTerminal(run.status)) return;
    run.runPhase = 'round_execution';
    run.summaryPhase = null;

    // For combo pipelines, resolve this round's mode; for single modes, use the fixed config
    const roundModeConfig = combo ? getModeForRound(run.mode, run.currentRound) : modeConfig;
    const roundModeKey = combo ? (parseModePipeline(run.mode)[Math.min(run.currentRound - 1, parseModePipeline(run.mode).length - 1)]) : run.mode;
    const rp = roundPrompt(run.currentRound, run.rounds, combo ? roundModeKey : undefined);
    const roundLabel = run.rounds > 1 ? ` (round ${run.currentRound}/${run.rounds})` : '';

    // Restore full target list for this round (skipped sessions are not retried)
    if (run.currentRound > 1) {
      run.remainingTargets = [...run.allTargets];
      logger.info({ runId: run.id, round: run.currentRound, totalRounds: run.rounds, roundMode: roundModeKey }, 'P2P: starting new round');
    }

    const targets = [...run.remainingTargets];

    // ── Phase 1: Initiator initial analysis (first round only) ──
    if (run.currentRound === 1) {
      if (run._cancelled) return;
      run.activePhase = 'initial';
      const initialHeader = `${discussionParticipantNameWithMode(run.initiatorSession, roundModeKey)} — Initial Analysis${roundLabel}`;
      const initialPrompt = buildHopPrompt(run, roundModeConfig, {
        session: run.initiatorSession,
        sectionHeader: initialHeader,
        instruction: 'Read the discussion file and provide your initial analysis. Append your output to the file.\nIMPORTANT: This is ANALYSIS ONLY. Do NOT implement fixes, do NOT edit code files, do NOT run commands. Only write your analysis into this discussion file.',
        isInitial: true,
      }, rp);
      const initialOk = await dispatchHop(run, run.initiatorSession, initialPrompt, serverLink, { sectionHeader: initialHeader, required: true });
      if (!initialOk) return;
      if (run._cancelled || isTerminal(run.status)) return;
    }

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
        const hopPrompt = buildHopPrompt(run, hopModeConfig, {
          session: target.session,
          sectionHeader: hopLabel,
          instruction: `Read the discussion file and provide your ${hopMode} analysis. Append your output to the file.\nIMPORTANT: This is ANALYSIS ONLY. Do NOT implement fixes, do NOT edit code files, do NOT run commands. Only write your analysis into this discussion file.`,
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
      const summaryModeConfig = isLastRound && combo
        ? getModeForRound(run.mode, run.rounds) // last pipeline mode for final summary
        : roundModeConfig;
      const roundSummaryHeader = isLastRound
        ? `${discussionParticipantNameWithMode(run.initiatorSession, roundModeKey)} — Final Summary`
        : `${discussionParticipantNameWithMode(run.initiatorSession, roundModeKey)} — Round ${run.currentRound}/${run.rounds} Summary`;
      const roundSummaryInstruction = isLastRound
        ? `${summaryModeConfig?.summaryPrompt ?? 'Synthesize a final summary that captures the consensus, key decisions, and any remaining disagreements across all rounds.'}\nBefore writing the summary, use the hop evidence already appended into the discussion file for this round. If the user context clearly specifies a destination file for the final plan, write the complete plan there. Otherwise, write the complete plan at the end of the discussion file.`
        : `Synthesize the key points, areas of agreement, and open questions from this round. Then assign specific focus areas or questions for each participant in the next round (round ${run.currentRound + 1}). Append to the file.\nIMPORTANT: This is ANALYSIS ONLY. Do NOT implement fixes, do NOT edit code files, do NOT run commands. Only write your analysis into this discussion file.`;
      const roundSummaryPrompt = buildHopPrompt(run, summaryModeConfig, {
        session: run.initiatorSession,
        sectionHeader: roundSummaryHeader,
        instruction: `${roundSummaryInstruction}\nThe orchestrator has already appended each completed hop's evidence into the discussion file. If you write the final plan to another file, still append a short completion note under the new final-summary heading in the discussion file that records the chosen output file path.`,
        isInitial: false,
      }, rp);
      logger.info({ runId: run.id, round: run.currentRound, isLastRound, roundMode: roundModeKey }, isLastRound ? 'P2P: Final summary — initiator' : 'P2P: Round summary — initiator');
      const summaryOk = await dispatchHop(run, run.initiatorSession, roundSummaryPrompt, serverLink, {
        sectionHeader: roundSummaryHeader,
        required: true,
      });
      if (!summaryOk) return;
      run.summaryPhase = 'completed';
      if (run._cancelled || isTerminal(run.status)) return;
    } finally {
      scheduleRoundHopArtifactCleanup(roundHops);
    }
  }
  if (run._cancelled || isTerminal(run.status)) return;

  // ── Done ──
  let fullContent = '';
  try {
    fullContent = await readFile(run.contextFilePath, 'utf8');
    run.resultSummary = fullContent.slice(-2000); // last 2000 chars as summary
  } catch { /* ignore */ }

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
  setTimeout(() => {
    activeRuns.delete(run.id);
  }, 60_000);
}

function addHelperDiagnostic(run: P2pRun, diagnostic: Omit<P2pHelperDiagnostic, 'timestamp'>): void {
  run.helperDiagnostics.push({ ...diagnostic, timestamp: Date.now() });
}

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

async function captureArtifactBaseline(run: P2pRun, round: P2pResolvedRound): Promise<Map<string, string | null>> {
  const baseline = new Map<string, string | null>();
  const record = getSession(run.initiatorSession);
  const projectDir = record?.projectDir ?? process.cwd();
  if (round.artifactConvention === 'openspec_convention') {
    const target = join(projectDir, 'openspec', 'changes');
    try {
      const entries = await readdir(target);
      baseline.set(target, entries.join('\n'));
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
    const target = [...baseline.keys()][0];
    const before = baseline.get(target) ?? null;
    try {
      const afterEntries = (await readdir(target)).join('\n');
      if (afterEntries === before) throw new Error('openspec_convention artifacts were not observably updated');
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

    const artifactBaseline = await captureArtifactBaseline(run, round);
    const reducerSummary = await reduceAdvancedContext(run, round, serverLink);
    if (run._cancelled || isTerminal(run.status)) return;

    let authoritativeSegment = '';
    if (round.dispatchStyle === 'initiator_only') {
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
      if (!ok) return;
      authoritativeSegment = await readAppendedContent(run.contextFilePath, baselineBuffer.length);
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
          if (!ok) return;
          authoritativeSegment = await readAppendedContent(run.contextFilePath, baselineBuffer.length);
          run.summaryPhase = 'completed';
        }
      } finally {
        scheduleRoundHopArtifactCleanup(roundHops);
      }
    }

    await validateArtifactOutputsForRound(run, round, artifactBaseline).catch((err) => {
      failRun(run, 'failed', err instanceof Error ? err.message : String(err), serverLink);
    });
    if (run._cancelled || isTerminal(run.status)) return;

    const verdict = round.requiresVerdict ? parseVerdictFromContent(authoritativeSegment) : null;
    const effectiveVerdict = round.requiresVerdict
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

    const jump = round.allowRouting && round.jumpRule
      ? (() => {
        const jumpCount = run.roundJumpCounts[round.id] ?? 0;
        const belowMax = jumpCount < round.jumpRule!.maxTriggers;
        if (!belowMax) return null;
        if (round.verdictPolicy === 'forced_rework') {
          if (jumpCount < round.jumpRule.minTriggers) return round.jumpRule.targetRoundId;
          return effectiveVerdict === (round.jumpRule.marker ?? 'REWORK') ? round.jumpRule.targetRoundId : null;
        }
        return effectiveVerdict === (round.jumpRule.marker ?? 'REWORK') ? round.jumpRule.targetRoundId : null;
      })()
      : null;

    if (jump) {
      run.roundJumpCounts[round.id] = (run.roundJumpCounts[round.id] ?? 0) + 1;
      run.routingHistory.push({
        fromRoundId: round.id,
        toRoundId: jump,
        trigger: effectiveVerdict,
        atStep: run.currentExecutionStep,
        atAttempt: run.currentRoundAttempt,
        timestamp: Date.now(),
      });
      roundIndex = rounds.findIndex((entry) => entry.id === jump);
      continue;
    }

    roundIndex += 1;
  }

  if (!ensureRunDeadline(run, serverLink) || run._cancelled || isTerminal(run.status)) return;
  run.runPhase = 'summarizing';
  run.summaryPhase = 'running';
  run.activePhase = 'summary';
  const finalRound = rounds[Math.max(rounds.length - 1, 0)];
  run.timeoutMs = finalRound?.timeoutMs ?? run.timeoutMs;
  const finalPrompt = buildHopPrompt(run, getP2pMode(finalRound?.modeKey ?? run.mode), {
    session: run.initiatorSession,
    sectionHeader: `${discussionParticipantNameWithMode(run.initiatorSession, finalRound?.modeKey ?? run.mode)} — Final Summary`,
    instruction: `${getP2pMode(finalRound?.modeKey ?? run.mode)?.summaryPrompt ?? 'Synthesize a final summary that captures the consensus, key decisions, and any remaining disagreements across all rounds.'}\nBefore writing the summary, use the hop evidence already appended into the discussion file for this round. If the user context clearly specifies a destination file for the final plan, write the complete plan there. Otherwise, write the complete plan at the end of the discussion file.`,
    isInitial: false,
  });
  const summaryOk = await dispatchHop(run, run.initiatorSession, finalPrompt, serverLink, {
    sectionHeader: `${discussionParticipantNameWithMode(run.initiatorSession, finalRound?.modeKey ?? run.mode)} — Final Summary`,
    required: true,
  });
  if (!summaryOk) return;
  run.summaryPhase = 'completed';

  let fullContent = '';
  try {
    fullContent = await readFile(run.contextFilePath, 'utf8');
    run.resultSummary = fullContent.slice(-2000);
  } catch { /* ignore */ }
  run.completedAt = new Date().toISOString();
  transition(run, 'completed', serverLink);
  setTimeout(() => { activeRuns.delete(run.id); }, 60_000);
}

// ── Single hop dispatch + wait ────────────────────────────────────────────

interface DispatchHopOptions {
  sectionHeader: string;
  filePath?: string;
  hop?: P2pHopRuntime | null;
  required?: boolean;
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
  const MAX_RETRIES = 1;

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

    try {
      const transportRuntime = getTransportRuntime(session);
      if (transportRuntime) {
        timelineEmitter.emit(session, 'user.message', { text: prompt });
        transportRuntime.send(prompt);
      } else {
        await sendKeysDelayedEnter(session, prompt);
      }
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
    const idleWaiter = waitForIdleEvent(session, run.timeoutMs);
    idleWaiter.promise.then((ok) => { idleEventReceived = ok; });

    const GRACE_PERIOD_MS = GRACE_PERIOD_DEFAULT_MS;
    const dispatchTime = Date.now();
    const deadline = dispatchTime + run.timeoutMs;
    const hardDeadline = deadline + 60_000;
    let fileGrew = false;
    let lastSize = sizeBefore;
    let lastGrowthAt = 0;
    let headingFound = false;
    let headingFoundAt = 0;

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
          const norm = (s: string) => s.toLowerCase().replace(/[–—]/g, '-').replace(/--/g, '-');
          if (norm(content).includes(norm(`## ${sectionHeader}`))) {
            headingFound = true;
            headingFoundAt = Date.now();
            if (!fileGrew) {
              fileGrew = true;
              if (run.status === 'dispatched') transition(run, 'running', serverLink);
              updateHopStatus(run, hop, 'running');
            }
          }
        }
      } catch {}

      if (headingFound && (Date.now() - headingFoundAt) >= 2_000) {
        logger.info({ runId: run.id, session, sectionHeader }, 'P2P: heading found in file, completing hop');
        idleWaiter.cancel();
        await finishHop('completed');
        pushState(run, serverLink);
        return true;
      }

      const settleForGrowth = IDLE_POLL_MS * FILE_SETTLE_CYCLES;
      if (!headingFound && fileGrew && (lastSize - sizeBefore) > 500 &&
          lastGrowthAt > 0 && (Date.now() - lastGrowthAt) >= settleForGrowth &&
          (Date.now() - dispatchTime) > MIN_PROCESSING_MS) {
        logger.info({ runId: run.id, session, growth: lastSize - sizeBefore }, 'P2P: content growth fallback — completing hop without heading');
        idleWaiter.cancel();
        await finishHop('completed');
        pushState(run, serverLink);
        return true;
      }

      const canCheckIdle = (Date.now() - dispatchTime) > MIN_PROCESSING_MS;
      if (!canCheckIdle) continue;

      const pastGrace = (Date.now() - dispatchTime) > GRACE_PERIOD_MS;
      const settleMs = IDLE_POLL_MS * FILE_SETTLE_CYCLES;
      const fileSettled = fileGrew && lastGrowthAt > 0 && (Date.now() - lastGrowthAt) >= settleMs;

      if (fileSettled || (pastGrace && !fileGrew)) {
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

        if (!fileGrew && pastGrace && idleConfirmed) {
          if (attempt < MAX_RETRIES) {
            logger.warn({ runId: run.id, session, attempt }, 'P2P: agent went idle without writing to file, retrying');
            idleWaiter.cancel();
            break;
          }
          logger.warn({ runId: run.id, session }, 'P2P: agent idle without file change after retry');
          idleWaiter.cancel();
          await finishHop('failed', 'idle_without_file_change');
          if (required) failRun(run, 'dispatch_failed', 'idle_without_file_change', serverLink);
          else pushState(run, serverLink);
          return false;
        }
      }
    }

    idleWaiter.cancel();

    if (!fileGrew && attempt < MAX_RETRIES && Date.now() < hardDeadline) continue;

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
  // Final summary may include execution instructions — use different framing
  // so the LLM writes the summary first, then acts on the user's request.
  const isFinalSummary = opts.sectionHeader.includes('Final Summary');
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
    parts.push(``);
    parts.push(`User's original request: "${run.userText}"`);
  } else {
    parts.push(`This is a dedicated discussion file for multi-agent analysis: ${filePath}`);
    parts.push(`All output MUST go into this file. Do NOT modify any other files or run any commands.`);
    parts.push(`Your identity for this discussion run is "${discussionParticipantName(opts.session)}". When later rounds refer to this code name, they mean you.`);
    parts.push(``);
    parts.push(`Steps:`);
    parts.push(`1. Read the discussion file`);
    parts.push(`2. ${opts.instruction}`);
    parts.push(`3. Add a new heading "## ${opts.sectionHeader}" at the end of this file and write your analysis below it`);
    parts.push(``);
    parts.push(`Rules: ALL analysis goes into this same file. Do NOT edit code files. Do NOT implement fixes.`);
    parts.push(`For this task, if the discussion file does not explicitly provide the relevant code, diff, or file paths, treat the current project codebase in your working directory as the referenced context for the audit.`);
    parts.push(`You MUST inspect the relevant source files in the current project codebase directly and base your analysis on that code.`);
    parts.push(`Do NOT respond that code context is missing if the working-directory project codebase is available.`);
  }
  parts.push(`Do NOT ask for confirmation. Do NOT explain your plan. Start immediately.`);
  parts.push(`After writing to the file, print a brief response summary of what you wrote, then say: Done`);

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

  return parts.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────

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
  logger.warn({ runId: run.id, errorType, message }, 'P2P run failed');
  pushState(run, serverLink);
}

function pushState(run: P2pRun, serverLink: ServerLink | null): void {
  if (!serverLink) return;
  const s = run.status as string;
  const type = s === 'completed' ? 'p2p.run_complete'
    : (s === 'failed' || s === 'timed_out' || s === 'cancelled') ? 'p2p.run_error'
      : 'p2p.run_save';
  try {
    serverLink.send({ type, run: serializeP2pRun(run) });
  } catch { /* not connected */ }
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
