/**
 * Pair participants must not write git state (reset, checkout, cherry-pick,
 * commit, ...) in the project's main checkout: that is Brain's integration
 * space and the owner's checkout, and a pair works in its own worktree. Owner
 * report (tsk_cd_reassigned_executor_workspace): a codex executor that could
 * not reach its worktree cherry-picked, reset dev and built evidence from the
 * main checkout. The older MainCheckoutGuard only noticed dirty files after the
 * fact.
 *
 * Scope is deliberately narrow: only a session that is the executor or auditor
 * of an OPEN pair, on a `pairs` project, acting in that role. Brain sessions,
 * and the owner's own sessions without an open pair, are never blocked or
 * reported (Brain merges in the main checkout). Read-only git (status, log,
 * diff, ...) and anything the classifier cannot resolve are never reported.
 *
 * Two enforcement points share this evaluation:
 *  - refuse before it runs, where the provider has a pre-tool hook
 *    (claude-code-sdk PreToolUse -> `evaluatePairMainCheckoutGitWrite` + deny);
 *  - otherwise, the timeline `tool.call` event reports it to the participant and
 *    its Brain at once (`inspectToolCallForPairMainCheckoutWrite`).
 * Cost per tool call: one regex over the command text (see the shared
 * classifier); everything else runs only for the rare command that names a git
 * write verb.
 */
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findMainCheckoutGitWrite, type MainCheckoutGitWrite } from '../../../shared/main-checkout-git-guard.js';
import { TASK_PAIR_PARTICIPANT_STATUSES, type TaskPairState } from '../../../shared/task-pair.js';
import { getSession, listSessions } from '../../store/session-store.js';
import { isPairsEngineProject } from './engine.js';
import { getTaskPairStore } from './store.js';
import { resetTaskPairDeliveryInFlightForTests, sendTaskPairMessage } from './delivery.js';
import { buildMainCheckoutWriteBrainLine, buildMainCheckoutWriteParticipantNotice } from './messages.js';

/** Environment switch to turn the guard off (any value but `off` keeps it on). */
export const PAIR_MAIN_CHECKOUT_GUARD_ENV = 'IMCODES_PAIR_MAIN_CHECKOUT_GUARD';

const SHELL_TOOL_NAMES = /^(bash|shell|run_shell_command|exec_command|execute_command|local_shell|terminal|powershell|exec)$/i;
const NOTICE_WINDOW_MS = 5 * 60_000;
const MAX_TRACKED_NOTICES = 256;

export interface PairMainCheckoutWrite extends MainCheckoutGitWrite {
  session: string;
  taskId: string;
  role: 'executor' | 'auditor';
  brain: string;
  command: string;
}

const lastNotice = new Map<string, number>();

function commandOf(input: unknown): string | readonly string[] | undefined {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const value = record.command ?? record.cmd;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value as string[];
  return undefined;
}

function cwdOf(input: unknown, detail: unknown): string | undefined {
  const pick = (source: unknown): string | undefined => {
    if (!source || typeof source !== 'object') return undefined;
    const record = source as Record<string, unknown>;
    const value = record.cwd ?? record.workdir ?? record.working_directory ?? record.dir_path;
    return typeof value === 'string' && value ? value : undefined;
  };
  const value = pick(input) ?? pick((detail as { input?: unknown } | undefined)?.input);
  if (!value) return undefined;
  if (value.startsWith('file://')) {
    try { return fileURLToPath(value); } catch { return undefined; }
  }
  return value;
}

function openPairOf(sessionName: string): { pair: TaskPairState; role: 'executor' | 'auditor' } | undefined {
  for (const stored of getTaskPairStore().listActivePairs()) {
    const pair = stored.state;
    if (!TASK_PAIR_PARTICIPANT_STATUSES.includes(pair.status)) continue;
    if (pair.executor === sessionName) return { pair, role: 'executor' };
    if (pair.auditor === sessionName) return { pair, role: 'auditor' };
  }
  return undefined;
}

/**
 * Does this tool call, made by `sessionName`, write git state in a main
 * checkout while the session holds an open pair? `undefined` for everything
 * else (including Brain and sessions without an open pair).
 */
export function evaluatePairMainCheckoutGitWrite(
  sessionName: string,
  toolName: string,
  input: unknown,
  options: { detail?: unknown; cwd?: string } = {},
): PairMainCheckoutWrite | undefined {
  if (process.env[PAIR_MAIN_CHECKOUT_GUARD_ENV] === 'off') return undefined;
  const command = commandOf(input);
  if (command === undefined || (!SHELL_TOOL_NAMES.test(toolName) && typeof input !== 'object')) return undefined;
  const session = getSession(sessionName);
  if (!session || session.role === 'brain' || !session.projectDir || !isPairsEngineProject(session.projectName)) return undefined;
  // Cheap path first: the classifier's regex rejects nearly every command before the store is touched.
  const roots = [session.projectDir];
  const brainDir = listSessions().find((candidate) => candidate.projectName === session.projectName && candidate.role === 'brain')?.projectDir;
  if (brainDir && brainDir !== session.projectDir) roots.push(brainDir);
  const hit = findMainCheckoutGitWrite({ command, cwd: options.cwd ?? cwdOf(input, options.detail) ?? session.projectDir, roots, home: homedir() });
  if (!hit) return undefined;
  const held = openPairOf(sessionName);
  if (!held || held.pair.brain === sessionName) return undefined;
  return {
    ...hit,
    session: sessionName,
    taskId: held.pair.taskId,
    role: held.role,
    brain: held.pair.brain,
    command: (Array.isArray(command) ? command.join(' ') : String(command)).slice(0, 240),
  };
}

/**
 * Tell the participant and its Brain, once per 5 minutes per session and
 * command. `blocked` says whether the provider refused it before it ran.
 */
export function reportPairMainCheckoutGitWrite(hit: PairMainCheckoutWrite, blocked: boolean): void {
  const key = `${hit.session}\u0000${hit.verb}\u0000${hit.dir}\u0000${hit.command}`;
  const now = Date.now();
  if ((lastNotice.get(key) ?? 0) > now - NOTICE_WINDOW_MS) return;
  lastNotice.set(key, now);
  if (lastNotice.size > MAX_TRACKED_NOTICES) {
    for (const [name, at] of lastNotice) if (at <= now - NOTICE_WINDOW_MS) lastNotice.delete(name);
  }
  // The guard owns the five-minute window.  Include that window and the
  // classified command in delivery coalescing too, so a different write (or
  // the same write after expiry) cannot be hidden behind an earlier pending
  // transport send, while duplicate calls in one window remain coalesced.
  const deliveryScope = `${key}\u0000${Math.floor(now / NOTICE_WINDOW_MS)}`;
  const stored = getTaskPairStore().listActivePairs().find((candidate) => candidate.state.taskId === hit.taskId);
  const workspace = stored?.state.workspace?.status === 'active' ? stored.state.workspace.path : undefined;
  // A refused call already tells the participant through its tool result (mainCheckoutWriteRefusal).
  if (!blocked) void sendTaskPairMessage(hit.session, hit.taskId, 'main-checkout-git-write', buildMainCheckoutWriteParticipantNotice(hit, blocked, workspace), deliveryScope);
  void sendTaskPairMessage(hit.brain, hit.taskId, 'brain-main-checkout-git-write', buildMainCheckoutWriteBrainLine(hit, blocked), deliveryScope);
}

/** Providers whose pre-tool hook refuses the call (see setToolExecutionGuard): the timeline report would only repeat it, wrongly as "already ran". */
const PRE_TOOL_HOOK_AGENT_TYPES = new Set(['claude-code-sdk']);

/** The pre-tool guard for `hit`: reports to Brain and returns the text the refused tool call carries. */
export function mainCheckoutWriteRefusal(hit: PairMainCheckoutWrite): string {
  reportPairMainCheckoutGitWrite(hit, true);
  const stored = getTaskPairStore().listActivePairs().find((candidate) => candidate.state.taskId === hit.taskId);
  const workspace = stored?.state.workspace?.status === 'active' ? stored.state.workspace.path : undefined;
  return buildMainCheckoutWriteParticipantNotice(hit, true, workspace);
}

/** Timeline hook: every `tool.call` event of every session passes through here. */
export function inspectToolCallForPairMainCheckoutWrite(sessionId: string, payload: Record<string, unknown>): void {
  if (PRE_TOOL_HOOK_AGENT_TYPES.has(getSession(sessionId)?.agentType ?? '')) return;
  const toolName = typeof payload.tool === 'string' ? payload.tool : '';
  const hit = evaluatePairMainCheckoutGitWrite(sessionId, toolName, payload.input, { detail: payload.detail });
  if (hit) reportPairMainCheckoutGitWrite(hit, false);
}

export function resetPairMainCheckoutWriteNoticesForTests(): void {
  lastNotice.clear();
  // The guard's test reset also starts a fresh notification window.  Clear the
  // transport's in-process pending gate so a prior async test send cannot hide
  // the first notice in the new window.
  resetTaskPairDeliveryInFlightForTests();
}
