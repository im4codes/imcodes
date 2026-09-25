/**
 * One-time import of in-flight legacy supervised tasks into pairs (design D8).
 *
 * Runs at every daemon start; each legacy task is imported at most once
 * (keyed by its legacy task id), so the first start of this release imports
 * everything in flight and a later switch of a project back to `pairs`
 * imports only what is new. Legacy rows are never modified.
 */
import logger from '../../util/logger.js';
import type { SupervisionTaskLifecycleStatus } from '../../../shared/supervision-config.js';
import {
  type TaskPairFlag,
  type TaskPairState,
  type TaskPairStatus,
} from '../../../shared/task-pair.js';
import { normalizeAuditBlockingSeverities } from '../../../shared/audit-convergence.js';
import type { SupervisionTaskSnapshot } from '../supervision-state-store.js';
import { getTaskPairStore } from './store.js';
import { isPairsEngineProject, projectBrainSession } from './engine.js';
import { sendTaskPairMessage } from './delivery.js';

const TERMINAL_LEGACY: readonly SupervisionTaskLifecycleStatus[] = ['pushed', 'finalized', 'cancelled'];
/**
 * Parked legacy states are never imported: `blocked` is legacy-terminal (an
 * operator decision) and `recovered` is a Brain-forced, deliberately
 * non-success state that must never become a PASS. Brain is told once which
 * ones stayed behind so it can re-dispatch them as pairs if still wanted.
 */
const PARKED_LEGACY: readonly SupervisionTaskLifecycleStatus[] = ['blocked', 'recovered'];

export function mapLegacyStatus(status: SupervisionTaskLifecycleStatus): { status: TaskPairStatus } | undefined {
  switch (status) {
    case 'planned': case 'delegated': return { status: 'queued' };
    case 'implementing': case 'retrying_external_ci': return { status: 'working' };
    case 'rework': return { status: 'rework' };
    case 'validated': case 'ready_for_audit': case 'auditing': return { status: 'in_audit' };
    // Only statuses that imply a real audit PASS map to `passed`.
    case 'passed': case 'ready_for_integration': case 'integrating': case 'final_audit':
    case 'finalizing': case 'committed':
      return { status: 'passed' };
    case 'pushed': case 'finalized': return { status: 'done' };
    case 'cancelled': return { status: 'cancelled' };
    // `blocked` and `recovered` are parked, never imported (see PARKED_LEGACY).
    default: return undefined;
  }
}

function liveSession(task: SupervisionTaskSnapshot, roles: ReadonlyArray<'coordinator' | 'integration_owner' | 'implementer' | 'auditor'>): string | undefined {
  const live = task.assignments.filter((assignment) => roles.includes(assignment.role) && !TERMINAL_LEGACY.includes(assignment.status));
  return (live.at(-1) ?? task.assignments.filter((assignment) => roles.includes(assignment.role)).at(-1))?.identity.sessionName || undefined;
}

export function legacyTaskToPair(task: SupervisionTaskSnapshot, now: number): TaskPairState | undefined {
  const mapped = mapLegacyStatus(task.status);
  if (!mapped) return undefined;
  const executor = liveSession(task, ['implementer', 'integration_owner']);
  const auditor = task.assignments.find((assignment) => assignment.role === 'auditor' && !TERMINAL_LEGACY.includes(assignment.status))?.identity.sessionName;
  const brain = liveSession(task, ['coordinator']) ?? projectBrainSession(task.projectName);
  const flags: TaskPairFlag[] = [];
  if (!auditor) flags.push('needs_auditor');
  const inAudit = mapped.status === 'in_audit' || mapped.status === 'rework' || mapped.status === 'passed';
  return {
    taskId: task.taskId,
    brain,
    ...(executor ? { executor } : {}),
    ...(auditor ? { auditor } : {}),
    title: task.objective.split('\n')[0]!.slice(0, 120),
    status: mapped.status,
    flags,
    flagSides: {},
    round: inAudit ? 1 : 0,
    ...(mapped.status === 'passed' ? { passRound: 1 } : {}),
    blocking: normalizeAuditBlockingSeverities(undefined),
    previousAuditors: [],
    capCounts: {},
    capRound: inAudit ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
}

export interface LegacyImportRegistry {
  list(filter?: { includeArchived?: boolean; cursor?: string; limit?: number }): SupervisionTaskSnapshot[];
}

/** Import every not-yet-imported non-terminal legacy task of a `pairs` project. */
/** Parked-task notices in flight, so a notice still being delivered is not queued twice. */
const parkedNoticesInFlight = new Set<string>();

/** Delivers one Brain notice; true once it was sent or durably queued. */
export type LegacyImportBrainNotifier = (brain: string, text: string) => boolean | Promise<boolean>;

const defaultNotifier: LegacyImportBrainNotifier = async (brain, text) => {
  const result = await sendTaskPairMessage(brain, 'legacy-import', 'brain-legacy-import', text);
  return result === 'sent' || result === 'queued';
};

export function importLegacyTasks(
  registry: LegacyImportRegistry,
  now = Date.now(),
  notifyBrain: LegacyImportBrainNotifier = defaultNotifier,
): number {
  const store = getTaskPairStore();
  let imported = 0;
  const parkedByBrain = new Map<string, Array<{ key: string; label: string }>>();
  let cursor: string | undefined;
  const pageSize = 200;
  do {
    const page = registry.list({ cursor, limit: pageSize });
    for (const task of page) {
      if (TERMINAL_LEGACY.includes(task.status) || task.archivedAt) continue;
      if (!task.projectName || !isPairsEngineProject(task.projectName)) continue;
      if (store.getPairByLegacyTaskId(task.taskId)) continue;
      if (PARKED_LEGACY.includes(task.status)) {
        const noticeKey = `legacy_parked_notified:${task.taskId}`;
        if (!store.getMeta(noticeKey) && !parkedNoticesInFlight.has(noticeKey)) {
          const brain = liveSession(task, ['coordinator']) ?? projectBrainSession(task.projectName);
          const list = parkedByBrain.get(brain) ?? [];
          list.push({ key: noticeKey, label: `${task.taskId} (${task.status})` });
          parkedByBrain.set(brain, list);
        }
        continue;
      }
      const pair = legacyTaskToPair(task, now);
      if (!pair) continue;
      // Progress time 0: every imported pair gets one nudge on the next tick.
      store.savePair(task.projectName, pair, {
        legacyTaskId: task.taskId,
        liveness: { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 0, progressAuditorAt: 0, lastTickAt: now, notified: [] },
      });
      store.recordEvent({
        id: `legacy_import:${task.taskId}`, project: task.projectName, taskId: task.taskId, writer: 'daemon', role: 'daemon',
        verb: 'IMPORT', attrs: { legacyStatus: task.status }, effect: 'imported', unusual: false, source: 'legacy_import',
        toStatus: pair.status, at: now,
      });
      imported += 1;
    }
    cursor = page.length === pageSize ? page[page.length - 1]?.taskId : undefined;
  } while (cursor);
  if (imported > 0) logger.info({ imported }, 'task-pair: imported in-flight legacy tasks');
  for (const [brain, tasks] of parkedByBrain) {
    const text = `[IM.codes task pairs] ${tasks.length} parked legacy task(s) were not imported: ${tasks.map((entry) => entry.label).join(', ')}. Re-dispatch any that are still wanted with <!-- IMCODES_TASK DISPATCH <taskId> executor=<session> auditor=<session> -->.`;
    for (const entry of tasks) parkedNoticesInFlight.add(entry.key);
    // Marked as notified only once delivered, so a missing Brain gets it on a later pass.
    void Promise.resolve(notifyBrain(brain, text))
      .then((delivered) => { if (delivered) for (const entry of tasks) store.setMeta(entry.key, String(now)); })
      .catch(() => undefined)
      .finally(() => { for (const entry of tasks) parkedNoticesInFlight.delete(entry.key); });
  }
  return imported;
}
