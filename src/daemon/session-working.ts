/** Shared live-work predicate for status, pair scheduling, and heartbeat snapshots. */
import { getTransportRuntime } from '../agent/session-manager.js';
import { getSession } from '../store/session-store.js';
import type { TransportRuntimeDiagnosticSnapshot } from '../agent/transport-session-runtime.js';

export interface SessionWorkingDeps {
  getSession?: typeof getSession;
  getDiagnosticSnapshot?: (sessionName: string) => TransportRuntimeDiagnosticSnapshot | undefined;
}

/**
 * A participant is working while a turn is running or any provider-owned work
 * remains unfinished. In particular, a settled parent turn does not make a
 * Claude SDK subagent, native task, Codex background item, or open tool call
 * idle.
 */
export function isSessionWorking(sessionName: string, deps: SessionWorkingDeps = {}): boolean {
  const session = (deps.getSession ?? getSession)(sessionName);
  if (!session) return false;
  if (session.state === 'running') return true;

  const activity = deps.getDiagnosticSnapshot
    ? deps.getDiagnosticSnapshot(sessionName)
    : getTransportRuntime(sessionName)?.getDiagnosticSnapshot();
  if (!activity) return false;
  return activity.sending
    || activity.activeDispatchCount > 0
    || activity.blockingWorkCount > 0
    || activity.backgroundWorkCount > 0
    || activity.activeToolCount > 0
    || activity.pendingCount > 0
    || activity.status === 'thinking'
    || activity.status === 'streaming'
    || activity.status === 'tool_running'
    || activity.status === 'permission';
}
