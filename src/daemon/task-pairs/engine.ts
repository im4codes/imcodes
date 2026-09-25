/**
 * Which supervision engine a project uses, and which sessions belong to it.
 *
 * `pairs` is the default for every project. `legacy` exists only as a manual
 * per-project rollback (settings) or a global override
 * (`IMCODES_SUPERVISION_ENGINE=legacy`).
 */
import { getSession, listSessions, type SessionRecord } from '../../store/session-store.js';
import { extractSessionSupervisionSnapshot, type SessionSupervisionSnapshot } from '../../../shared/supervision-config.js';
import {
  TASK_PAIR_DEFAULT_ENGINE,
  TASK_PAIR_ENGINE_ENV,
  TASK_PAIR_ENGINES,
  type TaskPairAllowlistEntry,
  type TaskPairEngine,
} from '../../../shared/task-pair.js';
import { getTaskPairStore } from './store.js';

export function resolveTaskPairEngine(project: string | undefined, env: NodeJS.ProcessEnv = process.env): TaskPairEngine {
  const override = env[TASK_PAIR_ENGINE_ENV]?.trim();
  if (override && (TASK_PAIR_ENGINES as readonly string[]).includes(override)) return override as TaskPairEngine;
  if (!project) return TASK_PAIR_DEFAULT_ENGINE;
  const configured = brainSupervisionSettings(project)?.pairEngine;
  if (configured) return configured;
  try {
    return getTaskPairStore().getProjectSettings(project).engine ?? TASK_PAIR_DEFAULT_ENGINE;
  } catch {
    return TASK_PAIR_DEFAULT_ENGINE;
  }
}

/** The pair settings the owner saved on the project Brain's supervision settings, if any. */
export function brainSupervisionSettings(project: string): Pick<SessionSupervisionSnapshot, 'pairEngine' | 'pairAllowlist' | 'pairMaxConcurrency'> | undefined {
  const brain = listSessions().find((session: SessionRecord) => session.projectName === project && session.role === 'brain');
  const snapshot = brain ? extractSessionSupervisionSnapshot(brain.transportConfig ?? null) : null;
  return snapshot ?? undefined;
}

/** Allowlist for daemon picks: Brain settings, else the stored project value, else the default. */
export function resolveTaskPairAllowlist(project: string): TaskPairAllowlistEntry[] {
  return brainSupervisionSettings(project)?.pairAllowlist ?? getTaskPairStore().getProjectSettings(project).allowlist;
}

/** Brain's open-pair limit: the value fixed in settings wins over `QUEUE - max=`. */
export function resolveTaskPairMaxConcurrency(brain: string): number {
  const project = getSession(brain)?.projectName;
  return (project ? brainSupervisionSettings(project)?.pairMaxConcurrency : undefined)
    ?? getTaskPairStore().getMaxConcurrency(brain);
}

export function projectOfSession(sessionName: string): string | undefined {
  return getSession(sessionName)?.projectName || undefined;
}

export function isPairsEngineSession(sessionName: string): boolean {
  const project = projectOfSession(sessionName);
  return !!project && resolveTaskPairEngine(project) === 'pairs';
}

export function isPairsEngineProject(project: string | undefined): boolean {
  return !!project && resolveTaskPairEngine(project) === 'pairs';
}

/** The project's Brain session: the escalation recipient for pairs without a dispatcher. */
export function projectBrainSession(project: string): string {
  const brain = listSessions().find((session: SessionRecord) => session.projectName === project && session.role === 'brain');
  return brain?.name ?? `deck_${project}_brain`;
}

/**
 * True while the pair heartbeat covers this session: it is the executor or
 * auditor of an open pair on a `pairs` project. Session-mode heartbeats and
 * nudges stand down only then, so every session keeps exactly one source.
 */
export function isSessionCoveredByPairHeartbeat(sessionName: string): boolean {
  if (!isPairsEngineSession(sessionName)) return false;
  try {
    return getTaskPairStore().isParticipantOfOpenPair(sessionName);
  } catch {
    return false;
  }
}
