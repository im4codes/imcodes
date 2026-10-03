/** Shared live-work predicate for status, pair scheduling, and heartbeat snapshots. */
import { getTransportRuntime } from '../agent/session-manager.js';
import { getSession } from '../store/session-store.js';
import type { TransportRuntimeDiagnosticSnapshot } from '../agent/transport-session-runtime.js';

export interface SessionWorkingDeps {
  getSession?: typeof getSession;
  getDiagnosticSnapshot?: (sessionName: string) => TransportRuntimeDiagnosticSnapshot | undefined;
}

export interface SessionWorkReport {
  working: boolean;
  /** Every busy signal found, e.g. `state_running`, `pending_messages(2)`, `background_work(1)`. */
  reasons: string[];
  /** Only leftover background/tool counters were present and the session has been quiet too long to trust them. */
  staleResidualIgnored: boolean;
}

export interface SessionWorkOptions {
  /**
   * When set, background-work and open-tool counters alone (no turn in
   * progress, nothing queued) are ignored once the session has produced no
   * output and no activity for this many ms.
   */
  staleResidualAfterMs?: number;
}

/**
 * Why a session counts as working, if it does. Turn-level signals (a running
 * state, a send in flight, queued messages, blocking work, a thinking/tool/
 * permission status) always count. Residual signals (provider background work
 * such as an SDK subagent, tool counters) count while fresh; see
 * {@link SessionWorkOptions.staleResidualAfterMs}.
 */
export function describeSessionWork(
  sessionName: string,
  deps: SessionWorkingDeps = {},
  options: SessionWorkOptions = {},
): SessionWorkReport {
  const idle: SessionWorkReport = { working: false, reasons: [], staleResidualIgnored: false };
  const session = (deps.getSession ?? getSession)(sessionName);
  if (!session) return idle;
  const turn: string[] = [];
  if (session.state === 'running') turn.push('state_running');
  const activity = deps.getDiagnosticSnapshot
    ? deps.getDiagnosticSnapshot(sessionName)
    : getTransportRuntime(sessionName)?.getDiagnosticSnapshot();
  const residual: string[] = [];
  if (activity) {
    if (activity.sending) turn.push('sending');
    if (activity.activeDispatchCount > 0) turn.push(`active_dispatch(${activity.activeDispatchCount})`);
    if (activity.blockingWorkCount > 0) turn.push(`blocking_work(${activity.blockingWorkCount})`);
    if (activity.pendingCount > 0) turn.push(`pending_messages(${activity.pendingCount})`);
    if (activity.status === 'thinking' || activity.status === 'streaming' || activity.status === 'tool_running' || activity.status === 'permission') {
      turn.push(`status_${activity.status}`);
    }
    if (activity.backgroundWorkCount > 0) residual.push(`background_work(${activity.backgroundWorkCount})`);
    if (activity.activeToolCount > 0) residual.push(`active_tools(${activity.activeToolCount})`);
  }
  if (turn.length > 0) return { working: true, reasons: [...turn, ...residual], staleResidualIgnored: false };
  if (residual.length === 0) return idle;
  const quietMs = activity ? Math.min(activity.lastActivityAgeMs, activity.lastProviderOutputAgeMs ?? Number.POSITIVE_INFINITY) : 0;
  if (options.staleResidualAfterMs !== undefined && quietMs > options.staleResidualAfterMs) {
    return { working: false, reasons: residual, staleResidualIgnored: true };
  }
  return { working: true, reasons: residual, staleResidualIgnored: false };
}

/**
 * A participant is working while a turn is running or any provider-owned work
 * remains unfinished. In particular, a settled parent turn does not make a
 * Claude SDK subagent, native task, Codex background item, or open tool call
 * idle.
 */
export function isSessionWorking(sessionName: string, deps: SessionWorkingDeps = {}): boolean {
  return describeSessionWork(sessionName, deps).working;
}
