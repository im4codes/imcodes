/**
 * P2P Quick Discussion orchestrator.
 *
 * Flow: initiator(initial) → sub1 → sub2 → ... → initiator(summary)
 * All output written to a per-run temp file — not the screen.
 * Completion = file grew + agent idle.
 */

import { stat, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sendKeysDelayedEnter } from '../agent/tmux.js';
import { detectStatus } from '../agent/detect.js';
import { capturePane } from '../agent/tmux.js';
import { getSession, type SessionRecord } from '../store/session-store.js';
import { getP2pMode, type P2pMode } from '../shared/p2p-modes.js';
import logger from '../util/logger.js';
import type { ServerLink } from './server-link.js';

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
  mode: string;
  status: P2pRunStatus;
  contextFilePath: string;
  timeoutMs: number;
  resultSummary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Internal: set to true when cancel requested */
  _cancelled: boolean;
}

// ── In-memory store ───────────────────────────────────────────────────────

const activeRuns = new Map<string, P2pRun>();

export function getP2pRun(id: string): P2pRun | undefined { return activeRuns.get(id); }
export function listP2pRuns(): P2pRun[] { return [...activeRuns.values()]; }

// ── Constants ─────────────────────────────────────────────────────────────

const P2P_TMP_DIR = join(tmpdir(), 'imcodes-p2p');
let IDLE_POLL_MS = 3_000;

/** Override poll interval for tests. */
export function _setIdlePollMs(ms: number): void { IDLE_POLL_MS = ms; }

// ── Start a P2P run ───────────────────────────────────────────────────────

export async function startP2pRun(
  initiatorSession: string,
  targets: P2pTarget[],
  userText: string,
  fileContents: Array<{ path: string; content: string }>,
  serverLink: ServerLink | null,
): Promise<P2pRun> {
  // Validate same domain
  const mainSession = extractMainSession(initiatorSession);
  for (const t of targets) {
    if (extractMainSession(t.session) !== mainSession) {
      throw new Error(`Cross-domain P2P not supported: ${t.session} is not in ${mainSession}`);
    }
  }

  const mode = targets[0]?.mode ?? 'discuss';
  const modeConfig = getP2pMode(mode);
  const runId = randomUUID().slice(0, 12);
  const discussionId = `dsc_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  // Create temp context file
  await mkdir(P2P_TMP_DIR, { recursive: true });
  const contextFilePath = join(P2P_TMP_DIR, `${runId}.md`);

  let seed = `# P2P Discussion: ${runId}\n\n`;
  seed += `## User Request\n\n${userText}\n\n`;
  if (fileContents.length > 0) {
    seed += `## Referenced Files\n\n`;
    for (const f of fileContents) {
      seed += `### ${f.path}\n\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
    }
  }
  await writeFile(contextFilePath, seed, 'utf8');

  const run: P2pRun = {
    id: runId,
    discussionId,
    mainSession,
    initiatorSession,
    currentTargetSession: null,
    finalReturnSession: initiatorSession,
    remainingTargets: targets,
    mode,
    status: 'queued',
    contextFilePath,
    timeoutMs: modeConfig?.defaultTimeoutMs ?? 300_000,
    resultSummary: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
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
  const targets = [...run.remainingTargets];
  const totalHops = targets.length;

  // ── Phase 1: Initiator initial analysis ──
  if (run._cancelled) return;
  const initialPrompt = buildHopPrompt(run, modeConfig, {
    session: run.initiatorSession,
    sectionHeader: `${shortName(run.initiatorSession)} — Initial Analysis`,
    instruction: 'Read the context file below and provide your initial analysis. Append your output to the file.',
    isInitial: true,
  });
  await dispatchHop(run, run.initiatorSession, initialPrompt, serverLink);
  if (run._cancelled || isTerminal(run.status)) return;

  // ── Phase 2: Sub-session hops ──
  for (let i = 0; i < targets.length; i++) {
    if (run._cancelled) return;
    const target = targets[i];
    const hopLabel = `${shortName(target.session)} — ${capitalize(target.mode)} (hop ${i + 1}/${totalHops})`;
    const hopModeConfig = getP2pMode(target.mode) ?? modeConfig;
    const hopPrompt = buildHopPrompt(run, hopModeConfig, {
      session: target.session,
      sectionHeader: hopLabel,
      instruction: `Read the full context file and provide your ${target.mode} analysis. Append your output to the file.`,
      isInitial: false,
    });

    // Wait for target to be idle
    await waitForIdle(run, target.session, serverLink);
    if (run._cancelled) return;

    await dispatchHop(run, target.session, hopPrompt, serverLink);
    if (run._cancelled || isTerminal(run.status)) return;
  }

  // ── Phase 3: Initiator summary ──
  if (run._cancelled) return;
  const summaryPrompt = buildHopPrompt(run, modeConfig, {
    session: run.initiatorSession,
    sectionHeader: `${shortName(run.initiatorSession)} — Summary`,
    instruction: 'Read the complete context file with all participants\' contributions. Synthesize a final summary. Append it to the file.',
    isInitial: false,
  });
  await dispatchHop(run, run.initiatorSession, summaryPrompt, serverLink);
  if (run._cancelled || isTerminal(run.status)) return;

  // ── Done ──
  try {
    const content = await readFile(run.contextFilePath, 'utf8');
    run.resultSummary = content.slice(-2000); // last 2000 chars as summary
  } catch { /* ignore */ }

  run.completedAt = new Date().toISOString();
  transition(run, 'completed', serverLink);
  // Keep in memory for a bit so status queries work, then clean up
  setTimeout(() => activeRuns.delete(run.id), 60_000);
}

// ── Single hop dispatch + wait ────────────────────────────────────────────

async function dispatchHop(run: P2pRun, session: string, prompt: string, serverLink: ServerLink | null): Promise<void> {
  run.currentTargetSession = session;
  run.remainingTargets = run.remainingTargets.filter((t) => t.session !== session);
  transition(run, 'dispatched', serverLink);

  // Record file size before dispatch
  let sizeBefore = 0;
  try {
    sizeBefore = (await stat(run.contextFilePath)).size;
  } catch { /* file should exist */ }

  // Send the prompt to the agent
  try {
    await sendKeysDelayedEnter(session, prompt);
  } catch (err) {
    failRun(run, 'dispatch_failed', `sendKeys failed: ${err}`, serverLink);
    return;
  }

  // Wait for: file grows + agent idle
  const deadline = Date.now() + run.timeoutMs;
  let fileGrew = false;

  while (Date.now() < deadline) {
    if (run._cancelled) return;
    await sleep(IDLE_POLL_MS);
    if (run._cancelled) return;

    // Check file growth
    try {
      const currentSize = (await stat(run.contextFilePath)).size;
      if (currentSize > sizeBefore) {
        fileGrew = true;
        if (run.status === 'dispatched') {
          transition(run, 'running', serverLink);
        }
      }
    } catch { /* ignore */ }

    // Check agent idle
    if (fileGrew) {
      try {
        const lines = await capturePane(session);
        const record = getSession(session);
        const agentType = (record?.agentType ?? 'claude-code') as import('../agent/detect.js').AgentType;
        const status = detectStatus(lines, agentType);
        if (status === 'idle') {
          // Hop complete
          if (run.remainingTargets.length > 0 || session !== run.initiatorSession) {
            transition(run, 'awaiting_next_hop', serverLink);
          }
          return;
        }
      } catch { /* ignore */ }
    }
  }

  // Timeout
  if (!run._cancelled) {
    failRun(run, 'timed_out', `Hop timed out after ${run.timeoutMs}ms`, serverLink);
  }
}

// ── Wait for target session to be idle ────────────────────────────────────

async function waitForIdle(run: P2pRun, session: string, serverLink: ServerLink | null): Promise<void> {
  const deadline = Date.now() + run.timeoutMs;
  while (Date.now() < deadline) {
    if (run._cancelled) return;
    try {
      const lines = await capturePane(session);
      const record = getSession(session);
      const agentType = (record?.agentType ?? 'claude-code') as import('../agent/detect.js').AgentType;
      if (detectStatus(lines, agentType) === 'idle') return;
    } catch { /* ignore */ }
    await sleep(IDLE_POLL_MS);
  }
  if (!run._cancelled) {
    failRun(run, 'timed_out', `Target ${session} never became idle`, serverLink);
  }
}

// ── Prompt construction ───────────────────────────────────────────────────

interface HopOpts {
  session: string;
  sectionHeader: string;
  instruction: string;
  isInitial: boolean;
}

function buildHopPrompt(run: P2pRun, mode: P2pMode | undefined, opts: HopOpts): string {
  const parts: string[] = [];

  // Mode role prompt
  if (mode?.prompt) {
    parts.push(mode.prompt);
  }

  // System instructions for P2P collaboration — must be extremely clear and actionable
  parts.push(`\n[P2P TASK — YOU MUST ACT ON THIS IMMEDIATELY]`);
  parts.push(`This is an automated P2P Quick Discussion task (run: ${run.id}). Do NOT reply conversationally. Execute the steps below NOW.`);
  parts.push(``);
  parts.push(`Step 1: Read the context file: ${run.contextFilePath}`);
  parts.push(`Step 2: ${opts.instruction}`);
  parts.push(`Step 3: Append your analysis to the SAME file under the heading "## ${opts.sectionHeader}"`);
  parts.push(``);
  parts.push(`CRITICAL RULES:`);
  parts.push(`- Write output to the FILE at ${run.contextFilePath}, NOT to the chat/screen.`);
  parts.push(`- Use your file editing tools (Edit/Write/Bash) to append to the file.`);
  parts.push(`- Do NOT ask the user for confirmation. Just do it.`);
  parts.push(`- After writing, say "Done" and nothing else.`);
  parts.push(`[END P2P TASK]`);

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
    serverLink.send({
      type,
      run: {
        id: run.id,
        discussion_id: run.discussionId,
        server_id: '', // filled by bridge from auth context
        main_session: run.mainSession,
        initiator_session: run.initiatorSession,
        current_target_session: run.currentTargetSession,
        final_return_session: run.finalReturnSession,
        remaining_targets: JSON.stringify(run.remainingTargets),
        mode_key: run.mode,
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
      },
    });
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
  const parts = session.split('_');
  return parts[parts.length - 1] ?? session;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
