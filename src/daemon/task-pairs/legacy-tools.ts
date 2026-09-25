/**
 * Legacy supervised-task MCP tools on the `pairs` engine (design D8).
 *
 * Models trained on the old tools keep calling them. On a `pairs` project none
 * of them refuses: each records the closest marker event (source
 * `legacy_tool`), returns `ok`, and names the marker to use instead. Legacy
 * tools never change a pair's roles (D2 ²): an executor's call can only move
 * status on a pair that already exists, exactly like its own marker would.
 */
import { randomUUID } from 'node:crypto';
import { MEMORY_MCP_TOOL_NAMES } from '../../../shared/memory-mcp-contracts.js';
import { SUPERVISION_MCP_TOOLS } from '../../../shared/supervision-mcp-tools.js';
import {
  AUDIT_SEVERITY_LEVELS,
} from '../../../shared/audit-convergence.js';
import {
  TASK_PAIR_CONTRACT_ID,
  TASK_PAIR_INFER_TASK_ID,
  TASK_PAIR_MARKER_TAG,
  parseTaskPairBindingId,
  taskPairRoleOf,
  type TaskPairState,
  type TaskPairVerb,
} from '../../../shared/task-pair.js';
import { getTaskPairStore, type StoredTaskPair } from './store.js';
import { isPairsEngineSession, projectOfSession } from './engine.js';
import { taskPairService } from './service.js';

/** Legacy tools answered by the pairs engine. */
export const TASK_PAIR_LEGACY_TOOL_NAMES: readonly string[] = [
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_PREFLIGHT,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_FINALIZE,
  MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY,
  SUPERVISION_MCP_TOOLS.INTENT,
  SUPERVISION_MCP_TOOLS.LIST,
  SUPERVISION_MCP_TOOLS.GET,
  SUPERVISION_MCP_TOOLS.RECOVER,
  SUPERVISION_MCP_TOOLS.HOUSEKEEPING,
];

type Handler = (args: unknown, ...rest: never[]) => Promise<unknown>;

function hint(taskId?: string): string {
  const id = taskId ?? '<taskId>';
  return `This project uses marker-driven task pairs (${TASK_PAIR_CONTRACT_ID}). Instead of this tool, write a marker line such as <!-- ${TASK_PAIR_MARKER_TAG} READY_FOR_AUDIT ${id} --> in your reply.`;
}

function coordinatorStartHint(taskId: string): string {
  return `This project uses marker-driven task pairs (${TASK_PAIR_CONTRACT_ID}). Send the brief to the executor with send_message and task: { taskId: "${taskId}" }; that opens the pair and the daemon assigns an auditor unless you name one. Or write <!-- ${TASK_PAIR_MARKER_TAG} DISPATCH ${taskId} executor=<session> auditor=<session> --> in your reply.`;
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const FINDING_LINE_RE = /^\s*(?:[-*•]|\d+[.)])?\s*\[(P[0-4])\]/;

/**
 * Severity counts from findings text: one finding per line that starts (after
 * optional list punctuation) with its `[Pn]` tag, as audit_convergence_v1
 * requires. Prose that merely mentions a level ("no P0 finding") is not a finding.
 */
export function severityCountsFromFindings(findings: string | undefined): Record<string, string> {
  const counts = new Map<string, number>();
  for (const line of (findings ?? '').split(/\r?\n/u)) {
    const level = line.match(FINDING_LINE_RE)?.[1];
    if (level && (AUDIT_SEVERITY_LEVELS as readonly string[]).includes(level)) counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  const attrs: Record<string, string> = {};
  for (const [level, count] of counts) attrs[level.toLowerCase()] = String(count);
  return attrs;
}

function projectPairs(project: string): StoredTaskPair[] {
  return getTaskPairStore().listActivePairs(project);
}

function summarize(state: TaskPairState): Record<string, unknown> {
  return {
    taskId: state.taskId,
    title: state.title,
    status: state.status,
    brain: state.brain,
    executor: state.executor,
    auditor: state.auditor,
    round: state.round,
    flags: state.flags,
    blocking: state.blocking,
    ...(state.lastVerdict ? { lastVerdict: state.lastVerdict } : {}),
  };
}

function legacyVerb(tool: string, args: Record<string, unknown>): { verb?: TaskPairVerb; attrs: Record<string, string> } {
  switch (tool) {
    case MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START: {
      const role = str(args, 'role');
      if (role === 'implementer' || role === 'integration_owner') return { verb: 'STARTED', attrs: {} };
      return { attrs: {} };
    }
    case SUPERVISION_MCP_TOOLS.INTENT: {
      switch (str(args, 'intent')) {
        case 'start': case 'claim': case 'heartbeat': case 'checkpoint':
          return { verb: 'WORKING', attrs: {} };
        case 'record_validation': case 'open_audit':
          return { verb: 'READY_FOR_AUDIT', attrs: {} };
        case 'finish':
          return { verb: 'DONE', attrs: {} };
        case 'cancel':
          return { verb: 'CANCEL', attrs: {} };
        default:
          return { attrs: {} };
      }
    }
    case MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE: {
      const blocker = str(args, 'blocker');
      if (blocker) return { verb: 'BLOCKED', attrs: { note: blocker.slice(0, 500) } };
      return { verb: 'WORKING', attrs: {} };
    }
    case MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH:
    case MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_FINALIZE:
      return { verb: 'DONE', attrs: {} };
    case MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY: {
      const verdict = str(args, 'verdict') === 'PASS' ? 'PASS' : 'REWORK';
      return { verb: verdict, attrs: severityCountsFromFindings(str(args, 'findings')) };
    }
    default:
      return { attrs: {} };
  }
}

export async function handleLegacyToolOnPairs(tool: string, callerSession: string, rawArgs: unknown): Promise<Record<string, unknown>> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const project = projectOfSession(callerSession);
  if (!project) return { status: 'ok', engine: 'pairs', applied: 'none', hint: hint() };
  const store = getTaskPairStore();

  if (tool === SUPERVISION_MCP_TOOLS.LIST) {
    const own = projectPairs(project).filter((pair) => (
      pair.state.brain === callerSession || pair.state.executor === callerSession || pair.state.auditor === callerSession
    ));
    return { status: 'ok', engine: 'pairs', tasks: own.map((pair) => summarize(pair.state)), hint: hint() };
  }
  if (tool === SUPERVISION_MCP_TOOLS.GET) {
    const taskId = str(args, 'taskId') ?? parseTaskPairBindingId(str(args, 'assignmentId'))?.taskId;
    const pair = taskId ? store.getPair(project, taskId) : undefined;
    return pair
      ? { status: 'ok', engine: 'pairs', task: summarize(pair.state), events: store.listEvents(project, pair.state.taskId, 20) }
      : { status: 'ok', engine: 'pairs', task: null, hint: hint(taskId) };
  }

  // The legacy way to open a task: Brain starts it as coordinator, then sends
  // the brief with that task id. A pair needs its executor, so a start opens
  // nothing yet; it hands back the id, and the brief's send_message carrying it
  // opens the pair (the daemon picks the auditor when none is named).
  if (tool === MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START && str(args, 'role') === 'coordinator') {
    const idempotencyKey = str(args, 'idempotencyKey');
    const taskId = str(args, 'taskId')
      ?? taskPairService.mintTaskId(project, idempotencyKey ? `${callerSession}\0${idempotencyKey}` : undefined);
    const existing = store.getPair(project, taskId)?.state;
    return {
      status: 'ok',
      engine: 'pairs',
      applied: 'task_id',
      taskId,
      ...(existing ? { pairStatus: existing.status } : {}),
      hint: coordinatorStartHint(taskId),
    };
  }

  const { verb, attrs } = legacyVerb(tool, args);
  // A pairs receipt's assignmentId is a pair binding id; it names the task too.
  const requested = str(args, 'taskId') ?? parseTaskPairBindingId(str(args, 'assignmentId'))?.taskId;
  const taskId = requested && store.getPair(project, requested) ? requested : taskPairService.resolveTaskId(project, callerSession, TASK_PAIR_INFER_TASK_ID);
  if (!verb || !taskId || taskId === TASK_PAIR_INFER_TASK_ID) {
    return { status: 'ok', engine: 'pairs', applied: 'none', ...(taskId ? { taskId } : {}), hint: hint(taskId ?? requested) };
  }
  // Status-only legacy calls (heartbeat/claim/checkpoint/update) from anyone
  // but the executor are progress pings, not transitions: auditors call them
  // mid-audit and must not pull an in_audit pair back to working.
  const existing = store.getPair(project, taskId)?.state;
  if ((verb === 'WORKING' || verb === 'STARTED') && existing && existing.executor !== callerSession) {
    store.recordEvent({
      id: `legacy:${tool}:${callerSession}:${randomUUID()}`, project, taskId, writer: callerSession,
      role: taskPairRoleOf(existing, callerSession), verb, attrs, effect: 'recorded', unusual: false,
      source: 'legacy_tool', fromStatus: existing.status, toStatus: existing.status, at: Date.now(),
    });
    taskPairService.recordPairProgress(project, taskId, callerSession, Date.now());
    return { status: 'ok', engine: 'pairs', applied: 'recorded', taskId, pairStatus: existing.status, hint: hint(taskId) };
  }
  const transition = taskPairService.applyMarker({
    project,
    writer: callerSession,
    marker: { verb, knownVerb: verb, taskId, attrs },
    source: 'legacy_tool',
    eventId: `legacy:${tool}:${callerSession}:${randomUUID()}`,
  });
  const after = store.getPair(project, taskId)?.state;
  return {
    status: 'ok',
    engine: 'pairs',
    applied: transition.effect,
    taskId,
    ...(after ? { pairStatus: after.status } : {}),
    hint: hint(taskId),
  };
}

/** Daemon side of the legacy-tool hook: answer on `pairs`, otherwise decline. */
export async function answerLegacyToolInDaemon(tool: string, callerSession: string, args: unknown): Promise<{ handled: boolean; result?: Record<string, unknown> }> {
  if (!TASK_PAIR_LEGACY_TOOL_NAMES.includes(tool) || !isPairsEngineSession(callerSession)) return { handled: false };
  return { handled: true, result: await handleLegacyToolOnPairs(tool, callerSession, args) };
}

/** MCP child processes hand the call to the daemon, which owns pair state, messages and timeline. */
export type TaskPairLegacyToolForwarder = (tool: string, args: unknown) => Promise<{ handled: boolean; result?: Record<string, unknown> }>;

/**
 * Wrap a handler map so every legacy supervision tool answers from the pairs
 * engine when the caller's project uses it, and behaves exactly as before
 * otherwise. Inside the daemon the decision is local; in an MCP child process
 * `forward` asks the daemon, and the original handler runs when the daemon
 * declines (legacy engine) or cannot be reached.
 */
export function withPairsLegacyTools<T extends object>(
  callerSession: string | null | undefined,
  handlers: T,
  forward?: TaskPairLegacyToolForwarder,
): T {
  if (!callerSession) return handlers;
  const wrapped = { ...handlers } as Record<string, Handler>;
  for (const name of TASK_PAIR_LEGACY_TOOL_NAMES) {
    const original = wrapped[name];
    if (typeof original !== 'function') continue;
    wrapped[name] = (async (args: unknown, ...rest: never[]) => {
      if (forward) {
        try {
          const answer = await forward(name, args);
          if (answer.handled && answer.result) return answer.result;
        } catch {
          // Daemon unreachable: keep the legacy behaviour rather than drop the call.
        }
        return original(args, ...rest);
      }
      return isPairsEngineSession(callerSession)
        ? handleLegacyToolOnPairs(name, callerSession, args)
        : original(args, ...rest);
    }) as Handler;
  }
  return wrapped as T;
}
