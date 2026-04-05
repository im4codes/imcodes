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
import { getTransportRuntime } from '../agent/session-manager.js';
import { P2P_BASELINE_PROMPT, getP2pMode, getModeForRound, isComboMode, parseModePipeline, roundPrompt, type P2pMode } from '../../shared/p2p-modes.js';
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
  /** Sessions whose hops completed successfully. */
  completedHops: P2pTarget[];
  /** Sessions whose hops were skipped (timeout, sendKeys failure, idle without file change). */
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
  const currentHop = run.activeTargetSessions[0] ?? run.currentTargetSession;
  const currentHopState = currentHop
    ? run.hopStates.find((hop) =>
      hop.session === currentHop &&
      hop.round_index === run.currentRound &&
      (hop.status === 'running' || hop.status === 'dispatched'),
    ) ?? null
    : null;
  const hopCounts = countHopStates(run.hopStates);

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
      const skippedSet = new Set(run.skippedHops);
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
      if (currentHopState) {
        const curMode = combo ? resolveMode(run.currentRound) : (
          run.allTargets.find((t) => t.session === currentHopState.session)?.mode
          ?? run.remainingTargets.find((t) => t.session === currentHopState.session)?.mode
          ?? run.mode
        );
        const info = getInfo(currentHopState.session, curMode, 'hop');
        nodes.push({ session: currentHopState.session, ...info, status: 'active' });
      }
      for (const t of run.remainingTargets) {
        if (t.session === currentHop) continue;
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

/** Override poll interval for tests. */
export function _setIdlePollMs(ms: number): void { IDLE_POLL_MS = ms; }
/** Override grace period for tests. */
export function _setGracePeriodMs(ms: number): void { GRACE_PERIOD_DEFAULT_MS = ms; }
/** Override min processing time for tests. */
export function _setMinProcessingMs(ms: number): void { MIN_PROCESSING_MS = ms; }
/** Override file settle cycles for tests. */
export function _setFileSettleCycles(n: number): void { FILE_SETTLE_CYCLES = n; }

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

export async function startP2pRun(
  initiatorSession: string,
  targets: P2pTarget[],
  userText: string,
  fileContents: Array<{ path: string; content: string }>,
  serverLink: ServerLink | null,
  rounds?: number,
  extraPrompt?: string,
  /** Explicit mode override — used for combo pipelines (e.g. "brainstorm>discuss>plan"). */
  modeOverride?: string,
  /** Custom per-hop timeout in ms. Overrides mode default (300s). */
  hopTimeoutMs?: number,
): Promise<P2pRun> {
  // Validate same domain
  const mainSession = extractMainSession(initiatorSession);
  for (const t of targets) {
    if (extractMainSession(t.session) !== mainSession) {
      throw new Error(`Cross-domain P2P not supported: ${t.session} is not in ${mainSession}`);
    }
  }

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
  const totalRounds = Math.min(P2P_MAX_ROUNDS, Math.max(1, rounds ?? 1));
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

  return false;
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
        instruction: 'Read the context file below and provide your initial analysis. Append your output to the file.\nIMPORTANT: This is ANALYSIS ONLY. Do NOT implement fixes, do NOT edit code files, do NOT run commands. Only write your analysis into this discussion file.',
        isInitial: true,
      }, rp);
      const initialOk = await dispatchHop(run, run.initiatorSession, initialPrompt, serverLink, { sectionHeader: initialHeader, required: true });
      if (!initialOk) return;
      if (run._cancelled || isTerminal(run.status)) return;
    }

    // ── Phase 2: Sub-session hops ──
    run.activePhase = 'hop';
    const roundHops = await createRoundHopStates(run, targets, roundModeKey);
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
        instruction: `Read the full context file and provide your ${hopMode} analysis. Append your output to the file.\nIMPORTANT: This is ANALYSIS ONLY. Do NOT implement fixes, do NOT edit code files, do NOT run commands. Only write your analysis into this discussion file.`,
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

    if (run.currentRound === run.rounds) {
      run.remainingTargets = [];
    } else {
      run.remainingTargets = [];
    }

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
      ? `${summaryModeConfig?.summaryPrompt ?? 'Synthesize a final summary that captures the consensus, key decisions, and any remaining disagreements across all rounds.'}\nBefore writing the summary, use the hop evidence already appended into the discussion file for this round. Append only the new summary section.`
      : `Synthesize the key points, areas of agreement, and open questions from this round. Then assign specific focus areas or questions for each participant in the next round (round ${run.currentRound + 1}). Append to the file.\nIMPORTANT: This is ANALYSIS ONLY. Do NOT implement fixes, do NOT edit code files, do NOT run commands. Only write your analysis into this discussion file.`;
    const roundSummaryPrompt = buildHopPrompt(run, summaryModeConfig, {
      session: run.initiatorSession,
      sectionHeader: roundSummaryHeader,
      instruction: `${roundSummaryInstruction}\nThe orchestrator has already appended each completed hop's evidence into the discussion file. Do not re-copy or restructure prior sections; append only your round-summary section.`,
      isInitial: false,
    }, rp);
    logger.info({ runId: run.id, round: run.currentRound, isLastRound, roundMode: roundModeKey }, isLastRound ? 'P2P: Final summary — initiator' : 'P2P: Round summary — initiator');
    const summaryOk = await dispatchHop(run, run.initiatorSession, roundSummaryPrompt, serverLink, {
      sectionHeader: roundSummaryHeader,
      required: true,
    });
    if (!summaryOk) return;
    run.summaryPhase = 'completed';
    setTimeout(() => { void cleanupRoundHopArtifacts(roundHops); }, 30_000);
    if (run._cancelled || isTerminal(run.status)) return;
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
    parts.push(`This is the FINAL round of a multi-agent discussion. Your discussion file is: ${filePath}`);
    parts.push(``);
    parts.push(`Steps:`);
    parts.push(`1. Read the discussion file`);
    parts.push(`2. Add a new heading "## ${opts.sectionHeader}" at the end and write your final synthesis`);
    parts.push(`3. Base the synthesis on the collected hop evidence already appended into the discussion file for this round`);
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
  } else if (status === 'failed' || status === 'timed_out') {
    run.runPhase = 'failed';
  }
  run.updatedAt = new Date().toISOString();
  logger.info({ runId: run.id, status }, 'P2P run state transition');
  pushState(run, serverLink);
}

function failRun(run: P2pRun, errorType: string, message: string, serverLink: ServerLink | null): void {
  run.error = `${errorType}: ${message}`;
  run.updatedAt = new Date().toISOString();
  const status: P2pRunStatus = errorType === 'timed_out' ? 'timed_out' : 'failed';
  run.status = status;
  run.runPhase = 'failed';
  if (run.activePhase === 'summary') run.summaryPhase = 'failed';
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
