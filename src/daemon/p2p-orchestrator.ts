/**
 * P2P Quick Discussion orchestrator.
 *
 * Flow: initiator(initial) → sub1 → sub2 → ... → initiator(summary)
 * All output written to a per-run temp file — not the screen.
 * Completion = file grew + agent idle.
 */

import { stat, writeFile, readFile, unlink, copyFile } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { ensureImcDir } from '../util/imc-dir.js';
import { randomUUID } from 'node:crypto';
import { sendKeysDelayedEnter } from '../agent/tmux.js';
import { detectStatusAsync } from '../agent/detect.js';
import { getSession } from '../store/session-store.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import { P2P_BASELINE_PROMPT, getP2pMode, getModeForRound, isComboMode, parseModePipeline, roundPrompt, type P2pMode } from '../../shared/p2p-modes.js';
import { formatP2pParticipantIdentity, shortP2pSessionName } from '../../shared/p2p-participant.js';
import logger from '../util/logger.js';
import type { ServerLink } from './server-link.js';
import { timelineEmitter } from './timeline-emitter.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type P2pRunStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'awaiting_next_hop'
  | 'completed'
  | 'timed_out'
  | 'failed'
  | 'interrupted'
  | 'cancelling'
  | 'cancelled';

export interface P2pTarget {
  session: string; // full tmux session name e.g. deck_myapp_w2
  mode: string;    // mode key e.g. 'audit'
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
  /** Internal: set to true when cancel requested */
  _cancelled: boolean;
}

// ── In-memory store ───────────────────────────────────────────────────────

const activeRuns = new Map<string, P2pRun>();

export function getP2pRun(id: string): P2pRun | undefined { return activeRuns.get(id); }
export function listP2pRuns(): P2pRun[] { return [...activeRuns.values()]; }

export function serializeP2pRun(run: P2pRun): Record<string, unknown> {
  return {
    id: run.id,
    discussion_id: run.discussionId,
    server_id: '', // filled by bridge from auth context
    main_session: run.mainSession,
    initiator_session: run.initiatorSession,
    current_target_session: run.currentTargetSession,
    final_return_session: run.finalReturnSession,
    remaining_targets: JSON.stringify(run.remainingTargets),
    mode_key: run.mode,
    current_round_mode: isComboMode(run.mode) ? (getModeForRound(run.mode, run.currentRound)?.key ?? run.mode) : run.mode,
    status: run.status,
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
    completed_hops_count: run.completedHops.length,
    completed_round_hops_count: Math.max(0, run.completedHops.length - ((run.currentRound - 1) * run.totalTargets)),
    current_round: run.currentRound,
    total_rounds: run.rounds,
    skipped_hops: run.skippedHops,
    active_phase: (() => {
      if (run.currentTargetSession === run.initiatorSession) {
        return run.remainingTargets.length === 0 ? 'summary' : 'initial';
      }
      if (run.currentTargetSession) return 'hop';
      if (run.status === 'completed') return 'summary';
      return 'queued';
    })(),
    active_hop_number: run.currentTargetSession && run.currentTargetSession !== run.initiatorSession
      ? run.completedHops.length + 1
      : null,
    active_round_hop_number: run.currentTargetSession && run.currentTargetSession !== run.initiatorSession && run.totalTargets > 0
      ? ((run.completedHops.length % run.totalTargets) + 1)
      : null,
    // Agent metadata for display
    current_target_label: (() => {
      if (!run.currentTargetSession) return null;
      const rec = getSession(run.currentTargetSession);
      return formatP2pParticipantIdentity({
        session: run.currentTargetSession,
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
    // Full node list for segmented progress display — includes completed, active, pending, skipped
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
      const phase1Done = run.completedHops.length > 0 || run.remainingTargets.length < run.totalTargets || run.status === 'completed';
      const phase1Active = !phase1Done && run.currentTargetSession === run.initiatorSession;
      nodes.push({ session: run.initiatorSession, ...init, status: phase1Done ? 'done' : phase1Active ? 'active' : 'pending' });

      for (let hi = 0; hi < run.completedHops.length; hi++) {
        const t = run.completedHops[hi];
        const hopRound = run.totalTargets > 0 ? Math.floor(hi / run.totalTargets) + 1 : 1;
        const hopMode = combo ? resolveMode(hopRound) : t.mode;
        const info = getInfo(t.session, hopMode, 'hop');
        nodes.push({ session: t.session, ...info, status: skippedSet.has(t.session) ? 'skipped' : 'done' });
      }
      if (run.currentTargetSession && run.currentTargetSession !== run.initiatorSession) {
        const curMode = combo ? resolveMode(run.currentRound) : (
          run.allTargets.find((t) => t.session === run.currentTargetSession)?.mode
          ?? run.remainingTargets.find((t) => t.session === run.currentTargetSession)?.mode
          ?? run.mode
        );
        const info = getInfo(run.currentTargetSession, curMode, 'hop');
        nodes.push({ session: run.currentTargetSession, ...info, status: 'active' });
      }
      for (const t of run.remainingTargets) {
        if (t.session === run.currentTargetSession) continue;
        const pendingMode = combo ? resolveMode(run.currentRound) : t.mode;
        const info = getInfo(t.session, pendingMode, 'hop');
        nodes.push({ session: t.session, ...info, status: 'pending' });
      }

      const summaryDone = run.status === 'completed';
      const summaryActive = run.remainingTargets.length === 0 && !summaryDone && run.currentTargetSession === run.initiatorSession;
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

  if (run.status === 'queued') {
    transition(run, 'cancelled', serverLink);
    activeRuns.delete(runId);
    return true;
  }

  if (['dispatched', 'running', 'awaiting_next_hop'].includes(run.status)) {
    transition(run, 'interrupted', serverLink);
    // Send Ctrl+C to current target if running
    if (run.currentTargetSession) {
      try {
        const { sendKey } = await import('../agent/tmux.js');
        await sendKey(run.currentTargetSession, 'C-c');
      } catch { /* ignore */ }
    }
    transition(run, 'cancelling', serverLink);
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

async function executeChain(run: P2pRun, modeConfig: P2pMode | undefined, serverLink: ServerLink | null): Promise<void> {
  const totalHops = run.allTargets.length;

  // ── Multi-round loop ──
  const combo = isComboMode(run.mode);
  for (; run.currentRound <= run.rounds; run.currentRound++) {
    if (run._cancelled || isTerminal(run.status)) return;

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
      const initialHeader = `${discussionParticipantNameWithMode(run.initiatorSession, roundModeKey)} — Initial Analysis${roundLabel}`;
      const initialPrompt = buildHopPrompt(run, roundModeConfig, {
        session: run.initiatorSession,
        sectionHeader: initialHeader,
        instruction: 'Read the context file below and provide your initial analysis. Append your output to the file.\nIMPORTANT: This is ANALYSIS ONLY. Do NOT implement fixes, do NOT edit code files, do NOT run commands. Only write your analysis into this discussion file.',
        isInitial: true,
      }, rp);
      await dispatchHop(run, run.initiatorSession, initialPrompt, serverLink, undefined, initialHeader);
      if (run._cancelled || isTerminal(run.status)) return;
    }

    // ── Phase 2: Sub-session hops ──
    for (let i = 0; i < targets.length; i++) {
      if (run._cancelled) return;
      const target = targets[i];
      // For combo pipelines, all hops in this round use the round's mode
      const hopMode = combo ? roundModeKey : target.mode;
      const hopLabel = `${discussionParticipantName(target.session)} — ${capitalize(hopMode)} (hop ${i + 1}/${totalHops}${roundLabel})`;
      const hopModeConfig = combo ? roundModeConfig : (getP2pMode(target.mode) ?? modeConfig);

      const hopPrompt = buildHopPrompt(run, hopModeConfig, {
        session: target.session,
        sectionHeader: hopLabel,
        instruction: `Read the full context file and provide your ${hopMode} analysis. Append your output to the file.\nIMPORTANT: This is ANALYSIS ONLY. Do NOT implement fixes, do NOT edit code files, do NOT run commands. Only write your analysis into this discussion file.`,
        isInitial: false,
      }, rp);

      // Dispatch immediately — agent will queue the message and process after current task
      logger.info({ runId: run.id, target: target.session, mode: hopMode, hop: i + 1, totalHops, round: run.currentRound }, 'P2P: Phase 2 — dispatching hop');
      await dispatchHop(run, target.session, hopPrompt, serverLink, null, hopLabel);
      logger.info({ runId: run.id, target: target.session, status: run.status }, 'P2P: Phase 2 — hop dispatch returned');
      if (run._cancelled || isTerminal(run.status)) return;
    }

    // ── Round summary: Initiator synthesizes this round ──
    if (run._cancelled) return;
    const isLastRound = run.currentRound === run.rounds;
    const summaryModeConfig = isLastRound && combo
      ? getModeForRound(run.mode, run.rounds) // last pipeline mode for final summary
      : roundModeConfig;
    const roundSummaryHeader = isLastRound
      ? `${discussionParticipantNameWithMode(run.initiatorSession, roundModeKey)} — Final Summary`
      : `${discussionParticipantNameWithMode(run.initiatorSession, roundModeKey)} — Round ${run.currentRound}/${run.rounds} Summary`;
    const roundSummaryInstruction = isLastRound
      ? (summaryModeConfig?.summaryPrompt ?? 'Synthesize a final summary that captures the consensus, key decisions, and any remaining disagreements across all rounds.')
      : `Synthesize the key points, areas of agreement, and open questions from this round. Then assign specific focus areas or questions for each participant in the next round (round ${run.currentRound + 1}). Append to the file.\nIMPORTANT: This is ANALYSIS ONLY. Do NOT implement fixes, do NOT edit code files, do NOT run commands. Only write your analysis into this discussion file.`;
    const roundSummaryPrompt = buildHopPrompt(run, summaryModeConfig, {
      session: run.initiatorSession,
      sectionHeader: roundSummaryHeader,
      instruction: roundSummaryInstruction,
      isInitial: false,
    }, rp);
    logger.info({ runId: run.id, round: run.currentRound, isLastRound, roundMode: roundModeKey }, isLastRound ? 'P2P: Final summary — initiator' : 'P2P: Round summary — initiator');
    await dispatchHop(run, run.initiatorSession, roundSummaryPrompt, serverLink, undefined, roundSummaryHeader);
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

async function dispatchHop(run: P2pRun, session: string, prompt: string, serverLink: ServerLink | null, _unused?: unknown, sectionHeader?: string): Promise<void> {
  run.currentTargetSession = session;
  // Don't remove from remainingTargets yet — defer until hop actually completes
  transition(run, 'dispatched', serverLink);

  // ── Cross-project file copy for sandboxed agents ──
  // If the target session's project dir differs from where the discussion file lives,
  // copy the file into the target's .imc/discussions/ so sandboxed agents can access it.
  const targetRecord = getSession(session);
  const targetDir = targetRecord?.projectDir || null;
  // contextFilePath = /project/.imc/discussions/runId.md → sourceDir = /project
  const sourceDir = dirname(dirname(dirname(run.contextFilePath))) || null;
  const isCrossProject = targetDir && sourceDir && targetDir !== sourceDir;
  let localCopyPath: string | null = null;

  if (isCrossProject) {
    const targetDiscussDir = await ensureImcDir(targetDir, 'discussions');
    localCopyPath = join(targetDiscussDir, basename(run.contextFilePath));
    try {
      await copyFile(run.contextFilePath, localCopyPath);
      // Rewrite the prompt to reference the local copy path
      prompt = prompt.replace(run.contextFilePath, localCopyPath);
      logger.info({ runId: run.id, session, from: run.contextFilePath, to: localCopyPath }, 'P2P: copied discussion file to target project');
    } catch (err) {
      logger.warn({ runId: run.id, session, err }, 'P2P: failed to copy discussion file to target project');
      localCopyPath = null; // fall back to original path
    }
  }

  const watchPath = localCopyPath ?? run.contextFilePath;
  const MAX_RETRIES = 1;

  /** Helper: clean up hop state on every exit path */
  const finishHop = async (skipped: boolean) => {
    // Copy result back from local copy to source file
    if (localCopyPath && !skipped) {
      try {
        await copyFile(localCopyPath, run.contextFilePath);
        logger.info({ runId: run.id, session }, 'P2P: copied discussion result back to source project');
      } catch (err) {
        logger.warn({ runId: run.id, session, err }, 'P2P: failed to copy discussion result back');
      }
    }
    // Schedule cleanup of local copy
    if (localCopyPath) {
      const copyToClean = localCopyPath;
      setTimeout(async () => { try { await unlink(copyToClean); } catch { /* already deleted */ } }, 30_000);
    }
    run.currentTargetSession = null;
    const target = run.remainingTargets.find((t) => t.session === session);
    run.remainingTargets = run.remainingTargets.filter((t) => t.session !== session);
    if (skipped) {
      run.skippedHops.push(session);
    } else if (target) {
      run.completedHops.push(target);
    }
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (run._cancelled) { await finishHop(false); return; }

    // Record file size before dispatch
    let sizeBefore = 0;
    try { sizeBefore = (await stat(watchPath)).size; } catch { /* file should exist */ }

    // Send the prompt — transport agents use provider runtime, tmux agents use sendKeys
    try {
      const transportRuntime = getTransportRuntime(session);
      if (transportRuntime) {
        timelineEmitter.emit(session, 'user.message', { text: prompt });
        timelineEmitter.emit(session, 'session.state', { state: 'running' }, { source: 'daemon', confidence: 'high' });
        await transportRuntime.send(prompt);
      } else {
        await sendKeysDelayedEnter(session, prompt);
      }
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        logger.warn({ runId: run.id, session, attempt }, 'P2P: dispatch failed, will retry');
        await sleep(2_000);
        continue;
      }
      logger.warn({ runId: run.id, session, err }, 'P2P: hop dispatch failed after retry, skipping');
      await finishHop(true);
      return;
    }

    // Register idle waiter AFTER sendKeys completes — prevents pre-prompt idle from resolving it
    let idleEventReceived = false;
    const idleWaiter = waitForIdleEvent(session, run.timeoutMs);
    idleWaiter.promise.then((ok) => { idleEventReceived = ok; });

    // Wait for completion: file settled (stopped growing) + agent idle.
    // Uses file-settle window + idle confirmation to avoid premature hop completion
    // caused by transient idle events (tool call gaps, status flicker).
    const GRACE_PERIOD_MS = GRACE_PERIOD_DEFAULT_MS;
    const dispatchTime = Date.now();
    const deadline = dispatchTime + run.timeoutMs;
    let fileGrew = false;
    let lastSize = sizeBefore;
    let lastGrowthAt = 0;
    let headingFound = false;
    let headingFoundAt = 0;

    while (Date.now() < deadline) {
      if (run._cancelled) { idleWaiter.cancel(); await finishHop(false); return; }
      await sleep(IDLE_POLL_MS);
      if (run._cancelled) { idleWaiter.cancel(); await finishHop(false); return; }

      // Check file growth — track last growth time for settle detection
      try {
        const currentSize = (await stat(watchPath)).size;
        if (currentSize > lastSize) {
          lastSize = currentSize;
          lastGrowthAt = Date.now();
          if (!fileGrew) {
            fileGrew = true;
            if (run.status === 'dispatched') transition(run, 'running', serverLink);
          }
          // Reset idle flag: transient idle before this growth doesn't count
          idleEventReceived = false;
        }
        // Fast completion check: if the section heading is in the file, the agent has written its output.
        // Runs regardless of fileGrew — stat() can miss growth between polls.
        // Case-insensitive to handle agents that change heading capitalization.
        if (sectionHeader && !headingFound && currentSize > sizeBefore) {
          const content = await readFile(watchPath, 'utf8');
          // Normalize: case-insensitive + dash variants (em-dash, en-dash, double-hyphen)
          const norm = (s: string) => s.toLowerCase().replace(/[–—]/g, '-').replace(/--/g, '-');
          if (norm(content).includes(norm(`## ${sectionHeader}`))) {
            headingFound = true;
            headingFoundAt = Date.now();
            if (!fileGrew) {
              fileGrew = true;
              if (run.status === 'dispatched') transition(run, 'running', serverLink);
            }
          }
        }
      } catch { /* ignore */ }

      // Heading fast-path: once heading is found, wait 2s for final writes then complete
      if (headingFound && (Date.now() - headingFoundAt) >= 2_000) {
        logger.info({ runId: run.id, session, sectionHeader }, 'P2P: heading found in file, completing hop');
        idleWaiter.cancel();
        await finishHop(false);
        if (run.remainingTargets.length > 0 || session !== run.finalReturnSession) {
          transition(run, 'awaiting_next_hop', serverLink);
        }
        return;
      }

      // Content-growth fallback: if file grew significantly and settled, treat as complete
      // even without heading match (covers agents that use different heading format)
      const settleForGrowth = IDLE_POLL_MS * FILE_SETTLE_CYCLES;
      if (!headingFound && fileGrew && (lastSize - sizeBefore) > 500 &&
          lastGrowthAt > 0 && (Date.now() - lastGrowthAt) >= settleForGrowth &&
          (Date.now() - dispatchTime) > MIN_PROCESSING_MS) {
        logger.info({ runId: run.id, session, growth: lastSize - sizeBefore }, 'P2P: content growth fallback — completing hop without heading');
        idleWaiter.cancel();
        await finishHop(false);
        if (run.remainingTargets.length > 0 || session !== run.finalReturnSession) {
          transition(run, 'awaiting_next_hop', serverLink);
        }
        return;
      }

      // Don't trust idle detection until MIN_PROCESSING_MS after dispatch
      const canCheckIdle = (Date.now() - dispatchTime) > MIN_PROCESSING_MS;
      if (!canCheckIdle) continue;

      const pastGrace = (Date.now() - dispatchTime) > GRACE_PERIOD_MS;

      // File must have settled: grew AND stopped growing for multiple poll cycles
      const settleMs = IDLE_POLL_MS * FILE_SETTLE_CYCLES;
      const fileSettled = fileGrew && lastGrowthAt > 0 && (Date.now() - lastGrowthAt) >= settleMs;

      // Check idle — only when file has settled (or past grace with no growth)
      if (fileSettled || (pastGrace && !fileGrew)) {
        let idleConfirmed = false;
        const record = getSession(session);
        const agentType = (record?.agentType ?? 'claude-code') as import('../agent/detect.js').AgentType;

        // For agents with structured watchers (Gemini), prefer session store state
        // over raw terminal detection — the watcher has idle confirmation logic that
        // prevents false idles during tool-call gaps.
        const useStoreState = agentType === 'gemini';

        if (idleEventReceived) {
          // Event-based: confirm agent is STILL idle right now
          try {
            if (useStoreState) {
              idleConfirmed = record?.state === 'idle';
            } else {
              idleConfirmed = await detectStatusAsync(session, agentType) === 'idle';
            }
          } catch { idleConfirmed = true; /* if detection fails, trust event */ }
        } else {
          // Poll fallback
          try {
            if (useStoreState) {
              idleConfirmed = record?.state === 'idle';
            } else {
              idleConfirmed = await detectStatusAsync(session, agentType) === 'idle';
            }
          } catch { /* ignore */ }
        }

        // Success: file settled AND agent confirmed idle
        if (fileSettled && idleConfirmed) {
          // Final confirmation: file size unchanged after idle check
          try {
            const finalSize = (await stat(watchPath)).size;
            if (finalSize > lastSize) {
              // Agent wrote more while we were checking — keep waiting
              lastSize = finalSize;
              lastGrowthAt = Date.now();
              idleEventReceived = false;
              continue;
            }
          } catch { /* ignore */ }
          idleWaiter.cancel();
          await finishHop(false);
          if (run.remainingTargets.length > 0 || session !== run.finalReturnSession) {
            transition(run, 'awaiting_next_hop', serverLink);
          }
          return;
        }

        // Idle but file never grew (past grace) → agent ignored the prompt
        if (!fileGrew && pastGrace && idleConfirmed) {
          if (attempt < MAX_RETRIES) {
            logger.warn({ runId: run.id, session, attempt }, 'P2P: agent went idle without writing to file, retrying');
            idleWaiter.cancel();
            break; // break inner loop to retry outer loop
          }
          logger.warn({ runId: run.id, session }, 'P2P: agent idle without file change after retry, skipping hop');
          idleWaiter.cancel();
          await finishHop(true);
          if (run.remainingTargets.length > 0 || session !== run.finalReturnSession) {
            transition(run, 'awaiting_next_hop', serverLink);
          }
          return;
        }
      }
    }

    idleWaiter.cancel();

    // If we got here from break (retry), continue to next attempt
    if (!fileGrew && attempt < MAX_RETRIES) continue;

    // Timeout — skip (don't fail the whole run)
    logger.warn({ runId: run.id, session }, 'P2P: hop timed out, skipping to next');
    await finishHop(true);
    if (run.remainingTargets.length > 0 || session !== run.finalReturnSession) {
      transition(run, 'awaiting_next_hop', serverLink);
    }
    return;
  }
}

// ── Prompt construction ───────────────────────────────────────────────────

export interface HopOpts {
  session: string;
  sectionHeader: string;
  instruction: string;
  isInitial: boolean;
}

export function buildHopPrompt(run: P2pRun, mode: P2pMode | undefined, opts: HopOpts, roundPrefix = ''): string {
  const parts: string[] = [];
  const filePath = run.contextFilePath;

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
    parts.push(`3. After writing the summary, execute the user's original request based on the discussion consensus`);
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
  run.updatedAt = new Date().toISOString();
  logger.info({ runId: run.id, status }, 'P2P run state transition');
  pushState(run, serverLink);
}

function failRun(run: P2pRun, errorType: string, message: string, serverLink: ServerLink | null): void {
  run.error = `${errorType}: ${message}`;
  run.updatedAt = new Date().toISOString();
  const status: P2pRunStatus = errorType === 'timed_out' ? 'timed_out' : 'failed';
  run.status = status;
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
  return status === 'completed' || status === 'failed' || status === 'timed_out' || status === 'cancelled';
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
