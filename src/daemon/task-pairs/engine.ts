/**
 * Which supervision engine a project uses, and which sessions belong to it.
 *
 * `pairs` is active only when the project has explicitly opted in: an
 * explicit `pairEngine` choice (env override, the Brain's saved setting, or
 * a stored per-project setting), or a Brain session whose supervision
 * snapshot explicitly sets mode `supervised`/`supervised_audit`. Owner
 * decision (2026-09-26, tsk_cd_pairs_optin): no saved supervision config, or
 * no Brain session at all, resolves to the inert `off` state -- the same as
 * an explicit mode=off snapshot -- so a project is never silently taken over
 * before its owner has touched supervision settings at all. Legacy settings
 * remain readable for migration, but never reactivate the retired engine.
 */
import { getSession, listSessions, type SessionRecord } from '../../store/session-store.js';
import {
  extractSessionSupervisionSnapshot,
  readTransportConfigUiLocale,
  SUPERVISION_MODE,
  type SessionSupervisionSnapshot,
  type SupervisionUiLocale,
} from '../../../shared/supervision-config.js';
import {
  TASK_PAIR_DEFAULT_ENGINE,
  TASK_PAIR_ENGINE_ENV,
  TASK_PAIR_ENGINES,
  type TaskPairAllowlistEntry,
  type TaskPairEngine,
  type TaskPairEngineState,
} from '../../../shared/task-pair.js';
import { getTaskPairStore } from './store.js';

/**
 * Resolves which engine is active for a project, including the inert `off`
 * state. Prefer this over {@link resolveTaskPairEngine} at any call site that
 * would otherwise treat "not pairs" as "must be legacy" -- that binary
 * assumption is exactly what let a mode-off project fall through into legacy
 * automation instead of staying inert.
 */
export function resolveTaskPairEngineState(project: string | undefined, env: NodeJS.ProcessEnv = process.env): TaskPairEngineState {
  const override = env[TASK_PAIR_ENGINE_ENV]?.trim();
  if (override === 'pairs') return TASK_PAIR_DEFAULT_ENGINE;
  // A persisted/global legacy value is migration input only. It resolves to
  // inert/off rather than silently opting the project into marker supervision.
  if (override === 'legacy') return 'off';
  if (!project) return 'off';
  const settings = brainSupervisionSettings(project);
  if (settings?.pairEngine === 'pairs') return TASK_PAIR_DEFAULT_ENGINE;
  if (settings?.pairEngine === 'legacy') return 'off';
  try {
    const stored = getTaskPairStore().getProjectSettings(project).engine;
    if (stored === 'pairs') return TASK_PAIR_DEFAULT_ENGINE;
    if (stored === 'legacy') return 'off';
  } catch {
    // fall through to the mode-aware default below
  }
  // No explicit engine choice anywhere: `pairs` only when the Brain has
  // explicitly turned automatic supervision on (mode supervised or
  // supervised_audit) -- that is the project opting in, even if only to
  // supervision and not to pairs by name. No saved snapshot, no Brain
  // session, or an explicit mode=off snapshot are all inert.
  if (settings?.mode === SUPERVISION_MODE.SUPERVISED || settings?.mode === SUPERVISION_MODE.SUPERVISED_AUDIT) {
    return TASK_PAIR_DEFAULT_ENGINE;
  }
  return 'off';
}

/**
 * @deprecated Prefer {@link resolveTaskPairEngineState}, which distinguishes
 * the inert `off` state from `legacy`. This narrows that state to `legacy`
 * for callers not yet updated to the tri-state result; new call sites that
 * branch on "pairs vs. something else" MUST use resolveTaskPairEngineState
 * instead, or they will treat a mode-off project as legacy.
 */
export function resolveTaskPairEngine(project: string | undefined, env: NodeJS.ProcessEnv = process.env): TaskPairEngine {
  const state = resolveTaskPairEngineState(project, env);
  return state === 'off' ? 'legacy' : state;
}

/** The pair settings the owner saved on the project Brain's supervision settings, if any. */
export function brainSupervisionSettings(project: string): Pick<SessionSupervisionSnapshot, 'mode' | 'pairEngine' | 'pairAllowlist' | 'pairMaxConcurrency'> | undefined {
  const brain = listSessions().find((session: SessionRecord) => session.projectName === project && session.role === 'brain');
  const snapshot = brain ? extractSessionSupervisionSnapshot(brain.transportConfig ?? null) : null;
  return snapshot ?? undefined;
}

/**
 * The web UI locale the owner last selected, as last synced onto the
 * project's Brain session (see `web/src/components/SessionControls.tsx`,
 * which stamps `uiLocale` from `i18n.resolvedLanguage` on most sends, and
 * `command-handler.ts`'s `handleSend`, which persists it durably). Reads the
 * raw stored field directly (`readTransportConfigUiLocale`), not through
 * `brainSupervisionSettings`/`extractSessionSupervisionSnapshot`: the rest of
 * the Brain's supervision snapshot may be invalid or legacy-repair-only by
 * design, and `uiLocale` must still be readable regardless. Undefined for
 * headless/legacy callers that never synced one -- callers MUST treat that
 * the same way the retired legacy prompts did: no rule/no generation, not a
 * fallback to English.
 */
export function brainUiLocale(project: string): SupervisionUiLocale | undefined {
  const brain = listSessions().find((session: SessionRecord) => session.projectName === project && session.role === 'brain');
  return brain ? readTransportConfigUiLocale(brain.transportConfig ?? null) : undefined;
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
  return !!project && resolveTaskPairEngineState(project) === 'pairs';
}

export function isPairsEngineProject(project: string | undefined): boolean {
  return !!project && resolveTaskPairEngineState(project) === 'pairs';
}

/**
 * True while `project` runs EITHER engine -- pairs or legacy. False only in
 * the inert `off` state (mode `off`, nothing explicit configured).
 *
 * Call sites that branch `isPairsEngineProject ? pairsWork : legacyWork`
 * MUST also gate the legacy branch on this, or they silently run legacy
 * automation (nudges, heartbeats, escalations, registry dispatch) for a
 * project the owner deliberately left uncovered by either engine.
 */
export function isTaskPairEngineActive(project: string | undefined): boolean {
  return !!project && resolveTaskPairEngineState(project) !== 'off';
}

/** Session-scoped counterpart of {@link isTaskPairEngineActive}. */
export function isTaskPairEngineActiveForSession(sessionName: string): boolean {
  return isTaskPairEngineActive(projectOfSession(sessionName));
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
