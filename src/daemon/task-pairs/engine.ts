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
 *
 * That is the SUPERVISION AUTOMATION gate (heartbeat, nudges, escalations, reminders, queue sweeps): predicate {@link isPairsEngineProject}.
 * It is deliberately not the gate of the MANUAL pair lifecycle (owner decision, tsk_fb01f25f17: "supervision mode off must not stop a
 * manually started pair, it only means no heartbeat"): that one is {@link isTaskPairsAvailable}, true for every project that has a Brain
 * session unless the owner explicitly rolled the project back to `legacy`.
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
  const choice = explicitTaskPairEngineChoice(project, env);
  if (choice === 'pairs') return TASK_PAIR_DEFAULT_ENGINE;
  // A persisted/global legacy value is migration input only. It resolves to
  // inert/off rather than silently opting the project into marker supervision.
  if (choice === 'legacy') return 'off';
  if (!project) return 'off';
  // No explicit engine choice anywhere: `pairs` only when the Brain has
  // explicitly turned automatic supervision on (mode supervised or
  // supervised_audit) -- that is the project opting in, even if only to
  // supervision and not to pairs by name. No saved snapshot, no Brain
  // session, or an explicit mode=off snapshot are all inert.
  const mode = brainSupervisionSettings(project)?.mode;
  if (mode === SUPERVISION_MODE.SUPERVISED || mode === SUPERVISION_MODE.SUPERVISED_AUDIT) {
    return TASK_PAIR_DEFAULT_ENGINE;
  }
  return 'off';
}

/**
 * The engine the owner chose by name, if any: the env override, the Brain's saved `pairEngine`, then the stored per-project setting
 * (first one present wins). `legacy` is the retired rollback value: it never runs anything, and it also withholds the manual pair
 * lifecycle ({@link isTaskPairsAvailable}) because the owner explicitly asked for no pairs here.
 */
function explicitTaskPairEngineChoice(project: string | undefined, env: NodeJS.ProcessEnv): TaskPairEngine | undefined {
  const override = env[TASK_PAIR_ENGINE_ENV]?.trim();
  if (override === 'pairs' || override === 'legacy') return override;
  if (!project) return undefined;
  const fromBrain = brainSupervisionSettings(project)?.pairEngine;
  if (fromBrain === 'pairs' || fromBrain === 'legacy') return fromBrain;
  try {
    const stored = getTaskPairStore().getProjectSettings(project).engine;
    if (stored === 'pairs' || stored === 'legacy') return stored;
  } catch {
    // no stored setting
  }
  return undefined;
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
export function brainSupervisionSettings(project: string): Pick<SessionSupervisionSnapshot, 'mode' | 'pairEngine' | 'pairMaxConcurrency'> | undefined {
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
 * (A) "Pairs available": the manual pair lifecycle works. True for every project that has a Brain session, in EVERY supervision
 * mode: supervision mode `off` only means "no supervision heartbeat" (no automatic nudges, escalations, queue sweeps, reminders or
 * auto-audit), never "the Brain may not start a pair by hand". Everything an explicit actor does (pair_create/dispatch/reassign/
 * next_round/close/verdict, pair_task_*, IMCODES_TASK markers, delivery, workspaces, the console view) is gated on THIS predicate.
 *
 * The other predicate, {@link isPairsEngineProject}, is (B) "supervision automation active": the heartbeat and every daemon-initiated
 * action key on it, unchanged. Whenever a project is (B) it is also (A).
 */
export function isTaskPairsAvailable(project: string | undefined): boolean {
  if (!project) return false;
  const choice = explicitTaskPairEngineChoice(project, process.env);
  if (choice === 'legacy') return false; // the owner explicitly rolled this project back: no pairs
  if (choice === 'pairs' || resolveTaskPairEngineState(project) === 'pairs') return true;
  return listSessions().some((session: SessionRecord) => session.projectName === project && session.role === 'brain');
}

/** Session-scoped counterpart of {@link isTaskPairsAvailable}. */
export function isTaskPairsAvailableForSession(sessionName: string): boolean {
  return isTaskPairsAvailable(projectOfSession(sessionName));
}

/**
 * What the owner can expect of a pair created in `project` right now: `supervision` is the Brain's supervision setting, and
 * `heartbeat` is whether the daemon watches the pair on its own (nudges, escalations, reminders, queue sweeps). With
 * `heartbeat: false` the pair runs only through explicit calls and markers.
 */
export function taskPairSupervisionStatus(project: string): { supervision: 'on' | 'off'; heartbeat: boolean } {
  const heartbeat = resolveTaskPairEngineState(project) === 'pairs';
  const mode = brainSupervisionSettings(project)?.mode;
  const supervision = mode === SUPERVISION_MODE.SUPERVISED || mode === SUPERVISION_MODE.SUPERVISED_AUDIT ? 'on' : 'off';
  return { supervision, heartbeat };
}

/**
 * The engine state that decides which CONTRACT a session's prompt carries. A Brain of a project where pairs are available
 * (supervision off included) is taught the manual-only pairs contract (`automaticSupervision:false` is decided separately), and so
 * is a participant of an open pair (it needs the marker protocol); other sessions of an uncovered project keep the inert prompt.
 */
export function resolveTaskPairPromptEngineState(sessionName: string): TaskPairEngineState {
  const project = projectOfSession(sessionName);
  const state = resolveTaskPairEngineState(project);
  if (state !== 'off' || !project) return state;
  const session = getSession(sessionName);
  if (!isTaskPairsAvailable(project)) return state;
  if (session?.role === 'brain') return 'pairs';
  try {
    return getTaskPairStore().isParticipantOfOpenPair(sessionName) ? 'pairs' : state;
  } catch {
    return state;
  }
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

/**
 * True when the LEGACY supervision registry must not dispatch anything (audit, rework, integration) for `project`: the
 * pairs engine owns it, or neither engine is active. One predicate for every legacy dispatch loop. Without it a legacy
 * task a pairs project left behind in `ready_for_integration` / `rework` was retried by every 60 s tick forever: on 215
 * 26 such tasks applied integration bundles (hundreds of synchronous `git` forks of the 1 GB daemon) each minute, a
 * 2.4 s main-thread freeze that held every keystroke echo.
 */
export function isLegacyDispatchInertProject(project: string | undefined): boolean {
  return isPairsEngineProject(project) || !isTaskPairEngineActive(project);
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
