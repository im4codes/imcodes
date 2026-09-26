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
  TASK_PAIR_NO_AUDITOR,
  type TaskPairFlag,
  type TaskPairState,
  type TaskPairStatus,
} from '../../../shared/task-pair.js';
import { normalizeAuditBlockingSeverities, type AuditSeverity } from '../../../shared/audit-convergence.js';
import { resolveSupervisionAuditBlockingSeverities } from '../../../shared/supervision-config.js';
import { isSupervisionPassVerdict } from '../../../shared/supervision-durable-identity.js';
import type { SupervisionTaskSnapshot } from '../supervision-state-store.js';
import { listSessions } from '../../store/session-store.js';
import { resolveProjectAuthoritativeSupervisionSnapshot } from '../supervision-snapshot.js';
import { getTaskPairStore, type StoredTaskPair } from './store.js';
import { isPairsEngineProject, projectBrainSession } from './engine.js';
import { sendTaskPairMessage } from './delivery.js';
import { buildLegacyImportCorrectionBrainLine, buildLegacyImportCorrectionMessage } from './messages.js';
import { emitTaskPairDaemonEvent } from './service.js';

const TERMINAL_LEGACY: readonly SupervisionTaskLifecycleStatus[] = ['pushed', 'finalized', 'cancelled'];
/**
 * Parked legacy states are never imported: `blocked` is legacy-terminal (an
 * operator decision) and `recovered` is a Brain-forced, deliberately
 * non-success state that must never become a PASS. Brain is told once which
 * ones stayed behind so it can re-dispatch them as pairs if still wanted.
 */
const PARKED_LEGACY: readonly SupervisionTaskLifecycleStatus[] = ['blocked', 'recovered'];

export function mapLegacyStatus(
  status: SupervisionTaskLifecycleStatus,
  hasLegacyPass = false,
): { status: TaskPairStatus } | undefined {
  switch (status) {
    case 'planned': case 'delegated': return { status: 'queued' };
    case 'implementing': case 'retrying_external_ci': return { status: 'working' };
    case 'rework': return { status: 'rework' };
    // `final_audit` is an audit still running, whatever an earlier round said.
    case 'validated': case 'ready_for_audit': case 'auditing': case 'final_audit': return { status: 'in_audit' };
    // Finished work waiting on integration means PASS only with a legacy PASS
    // receipt: an integration slice gets here straight from implementation
    // finish (its audit is the later combined one), so without a receipt the
    // work was never audited.
    case 'ready_for_integration': case 'integrating':
      return { status: hasLegacyPass ? 'passed' : 'in_audit' };
    // Only statuses that imply a real audit PASS map to `passed` unconditionally.
    case 'passed': case 'finalizing': case 'committed':
      return { status: 'passed' };
    case 'pushed': case 'finalized': return { status: 'done' };
    case 'cancelled': return { status: 'cancelled' };
    // `blocked` and `recovered` are parked, never imported (see PARKED_LEGACY).
    default: return undefined;
  }
}

/** The task's latest final legacy audit receipt is a PASS. */
export function hasLegacyPassReceipt(task: Pick<SupervisionTaskSnapshot, 'auditReceipts'>): boolean {
  const finals = (task.auditReceipts ?? [])
    .filter((receipt) => receipt.receiptKind === 'final')
    .sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence);
  return isSupervisionPassVerdict(finals.at(-1)?.verdict);
}

function liveSession(task: SupervisionTaskSnapshot, roles: ReadonlyArray<'coordinator' | 'integration_owner' | 'implementer' | 'auditor'>): string | undefined {
  const live = task.assignments.filter((assignment) => roles.includes(assignment.role) && !TERMINAL_LEGACY.includes(assignment.status));
  return (live.at(-1) ?? task.assignments.filter((assignment) => roles.includes(assignment.role)).at(-1))?.identity.sessionName || undefined;
}

/** Config the Brain has configured for this project, resolved once per import pass. */
export function resolveLegacyImportProjectBlocking(projectName: string): AuditSeverity[] {
  return resolveSupervisionAuditBlockingSeverities(
    resolveProjectAuthoritativeSupervisionSnapshot(projectName, listSessions()),
  );
}

/**
 * A legacy task never carried its own blocking set (that concept postdates
 * the legacy engine), so an imported pair's `blocking` always comes from the
 * Brain's current config -- `projectBlocking` defaults to the P0-only
 * fallback so direct unit tests of this pure function need not set up a
 * session store.
 */
export function legacyTaskToPair(
  task: SupervisionTaskSnapshot,
  now: number,
  projectBlocking: readonly AuditSeverity[] = normalizeAuditBlockingSeverities(undefined),
): TaskPairState | undefined {
  const mapped = mapLegacyStatus(task.status, hasLegacyPassReceipt(task));
  if (!mapped) return undefined;
  const executor = liveSession(task, ['implementer', 'integration_owner']);
  const auditor = task.assignments.find((assignment) => assignment.role === 'auditor' && !TERMINAL_LEGACY.includes(assignment.status))?.identity.sessionName;
  const brain = liveSession(task, ['coordinator']) ?? projectBrainSession(task.projectName);
  const flags: TaskPairFlag[] = [];
  // A passed pair's audit is over; it never needs an auditor again.
  if (!auditor && mapped.status !== 'passed') flags.push('needs_auditor');
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
    blocking: normalizeAuditBlockingSeverities(projectBlocking),
    blockingSource: 'config',
    previousAuditors: [],
    capCounts: {},
    capRound: inAudit ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Page size asked of the registry; it may return fewer rows without being done. */
const LEGACY_IMPORT_PAGE_SIZE = 100;
const LEGACY_IMPORT_EVENT_PREFIX = 'legacy_import:';
const LEGACY_IMPORT_CORRECTION_EVENT_PREFIX = 'legacy_import_correction:';
/** Verdicts or progress after the import that make a pair's current status real. */
const POST_IMPORT_ADVANCING_VERBS: readonly string[] = ['PASS', 'REWORK', 'DONE', 'READY_FOR_AUDIT'];

/**
 * One-time correction of pairs an earlier release imported as `passed` although
 * the legacy task had no PASS (an integration slice waiting for its combined
 * audit). Such a pair told its executor to commit unaudited work and never got
 * an auditor. It is moved to the status the current mapping gives (in_audit,
 * round 1) unless something real happened since the import: a verdict, DONE or
 * a resubmission keeps the pair as it is, and so does any terminal status.
 * Idempotent: the correction event is written once per task.
 *
 * Returns the pair's Brain when the pair was corrected.
 */
function correctUnauditedPassedImport(stored: StoredTaskPair, task: SupervisionTaskSnapshot, now: number): string | undefined {
  const store = getTaskPairStore();
  const { project, state } = stored;
  if (state.status !== 'passed') return undefined;
  const correctionId = `${LEGACY_IMPORT_CORRECTION_EVENT_PREFIX}${state.taskId}`;
  if (store.hasEvent(correctionId)) return undefined;
  const events = store.listEvents(project, state.taskId, 1_000);
  const importEvent = events.find((event) => event.id === `${LEGACY_IMPORT_EVENT_PREFIX}${state.taskId}`);
  if (!importEvent || importEvent.toStatus !== 'passed') return undefined;
  if (events.some((event) => event.at >= importEvent.at && event.id !== importEvent.id
    && POST_IMPORT_ADVANCING_VERBS.includes(event.verb))) return undefined;
  const importedStatus = (importEvent.attrs.legacyStatus ?? task.status) as SupervisionTaskLifecycleStatus;
  const corrected = mapLegacyStatus(importedStatus, hasLegacyPassReceipt(task));
  if (!corrected || corrected.status === 'passed') return undefined;
  const hasAuditor = !!state.auditor && state.auditor !== TASK_PAIR_NO_AUDITOR;
  const flags: TaskPairFlag[] = state.flags.filter((flag) => flag !== 'executor_silent' && flag !== 'needs_auditor');
  if (!hasAuditor) flags.push('needs_auditor');
  const next: TaskPairState = {
    ...state,
    status: corrected.status,
    flags,
    round: Math.max(1, state.round),
    passRound: undefined,
    lastVerdict: undefined,
    capCounts: {},
    capRound: Math.max(1, state.round),
    updatedAt: now,
  };
  store.savePair(project, next, {
    liveness: {
      ...stored.liveness,
      silenceExecutor: 0,
      silenceAuditor: 0,
      progressAuditorAt: 0,
      notified: stored.liveness.notified.filter((key) => !key.startsWith('needs_auditor:')),
    },
  });
  store.recordEvent({
    id: correctionId, project, taskId: state.taskId, writer: 'daemon', role: 'daemon',
    verb: 'CORRECT', attrs: { legacyStatus: importedStatus, reason: 'no_legacy_pass_receipt' },
    effect: 'import_corrected', unusual: true, source: 'legacy_import',
    fromStatus: 'passed', toStatus: next.status, at: now,
  });
  emitTaskPairDaemonEvent(next, {
    eventId: correctionId, verb: 'CORRECT', effect: 'import_corrected', source: 'legacy_import',
    fromStatus: 'passed', toStatus: next.status, unusual: true,
  });
  if (next.executor) {
    void sendTaskPairMessage(next.executor, next.taskId, 'import-correction', buildLegacyImportCorrectionMessage(next));
  }
  return next.brain;
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
  const correctedByBrain = new Map<string, string[]>();
  let cursor: string | undefined;
  // Page until the registry runs dry. The registry caps a page below any size
  // asked for and filters rows after its LIMIT, so a short page is not the end;
  // archived rows are listed too so every page advances the cursor.
  for (;;) {
    const page = registry.list({ cursor, limit: LEGACY_IMPORT_PAGE_SIZE, includeArchived: true });
    const last = page.at(-1)?.taskId;
    if (!last || (cursor !== undefined && last <= cursor)) break;
    cursor = last;
    for (const task of page) {
      if (TERMINAL_LEGACY.includes(task.status) || task.archivedAt) continue;
      if (!task.projectName || !isPairsEngineProject(task.projectName)) continue;
      const existing = store.getPairByLegacyTaskId(task.taskId);
      if (existing) {
        const brain = correctUnauditedPassedImport(existing, task, now);
        if (brain) correctedByBrain.set(brain, [...(correctedByBrain.get(brain) ?? []), task.taskId]);
        continue;
      }
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
      const pair = legacyTaskToPair(task, now, resolveLegacyImportProjectBlocking(task.projectName));
      if (!pair) continue;
      // Progress time 0: every imported pair gets one nudge on the next tick.
      store.savePair(task.projectName, pair, {
        legacyTaskId: task.taskId,
        liveness: { silenceExecutor: 0, silenceAuditor: 0, progressExecutorAt: 0, progressAuditorAt: 0, lastTickAt: now, notified: [] },
      });
      store.recordEvent({
        id: `${LEGACY_IMPORT_EVENT_PREFIX}${task.taskId}`, project: task.projectName, taskId: task.taskId, writer: 'daemon', role: 'daemon',
        verb: 'IMPORT', attrs: { legacyStatus: task.status }, effect: 'imported', unusual: false, source: 'legacy_import',
        toStatus: pair.status, at: now,
      });
      imported += 1;
    }
  }
  if (correctedByBrain.size > 0) {
    logger.info({ corrected: [...correctedByBrain.values()].flat() }, 'task-pair: corrected legacy imports that were passed without an audit');
  }
  for (const [brain, taskIds] of correctedByBrain) {
    void sendTaskPairMessage(brain, 'legacy-import', 'brain-legacy-import-correction', buildLegacyImportCorrectionBrainLine(taskIds));
  }
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
