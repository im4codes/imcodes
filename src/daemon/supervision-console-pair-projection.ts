/**
 * Console rows for `pairs`-engine projects, and the per-scope view that lets a
 * single pair change be sent as a one-pair delta instead of a rebuilt snapshot.
 *
 * Pure of I/O apart from the injected presentation resolver: the producer owns
 * the store reads, this module owns row shape and the diff against what the
 * viewer was last sent.
 */
import { createHash } from 'node:crypto';
import {
  compareQueuedTaskPairs,
  isTerminalTaskPairStatus,
  TASK_PAIR_CONSOLE_LEGACY_STATUS,
  TASK_PAIR_NO_AUDITOR,
} from '../../shared/task-pair.js';
import { taskPairChecklistCounts } from '../../shared/task-pair-checklist.js';
import {
  supervisionConsoleStatusGroup,
  type SupervisionConsoleSessionState,
  type SupervisionConsoleSessionStateSource,
  type SupervisionTaskConsoleAssignmentRow,
  type SupervisionTaskConsolePairUpsert,
  type SupervisionTaskConsoleTaskRow,
} from '../../shared/supervision-task-console.js';
import type { StoredTaskPair } from './task-pairs/store.js';

export interface PairPresentation {
  label?: string;
  model?: string;
  state: SupervisionConsoleSessionState;
  source: SupervisionConsoleSessionStateSource;
  observedAt: number;
}
export type PairPresentationResolver = (sessionName: string, at: number) => PairPresentation | undefined;

/** Opaque, content-derived: equal iff the brief text is equal. */
export function taskPairBriefRevision(brief: string): string {
  return createHash('sha1').update(brief).digest('hex').slice(0, 16);
}

/** Queue positions among the given queued pairs, per Brain, in scheduler order. */
export function computePairQueuePositions(pairs: readonly StoredTaskPair[]): Map<string, number> {
  const positions = new Map<string, number>();
  const byBrain = new Map<string, StoredTaskPair[]>();
  for (const stored of pairs) {
    if (stored.state.status !== 'queued') continue;
    const group = byBrain.get(stored.state.brain) ?? [];
    group.push(stored);
    byBrain.set(stored.state.brain, group);
  }
  for (const queued of byBrain.values()) {
    queued.sort(compareQueuedTaskPairs).forEach((stored, index) => positions.set(stored.state.taskId, index + 1));
  }
  return positions;
}

/**
 * One pair's console task row + participant rows.
 *
 * `inlineBrief` is the legacy shape (the whole brief on every row). Otherwise
 * the row carries only `briefRevision` and the checklist counts; the text is
 * fetched on demand.
 */
export function buildPairConsoleRow(
  stored: StoredTaskPair,
  options: { queuePosition?: number; inlineBrief: boolean; resolvePresentation?: PairPresentationResolver },
): SupervisionTaskConsolePairUpsert {
  const pair = stored.state;
  const status = TASK_PAIR_CONSOLE_LEGACY_STATUS[pair.status];
  const phase = supervisionConsoleStatusGroup(status);
  const heartbeatAt = Math.max(stored.liveness.progressExecutorAt, stored.liveness.progressAuditorAt) || undefined;
  const resolve = options.resolvePresentation;
  const task: SupervisionTaskConsoleTaskRow = {
    taskId: pair.taskId,
    title: pair.title ?? pair.taskId,
    status,
    phase,
    ...(pair.executor ? { ownerSessionName: pair.executor } : {}),
    ...(pair.executorPool === 'primary' || pair.executorPool === 'economy' ? { poolKind: pair.executorPool } : {}),
    validationState: 'unknown',
    ...(pair.flags.includes('blocked') ? { blocker: 'blocked' } : {}),
    ...(pair.round > 0 ? { auditRound: String(pair.round) } : {}),
    ...(pair.lastVerdict ? { auditVerdict: pair.lastVerdict.verb } : {}),
    ...(heartbeatAt ? { heartbeatAt } : {}),
    updatedAt: pair.updatedAt,
    lastEventId: 0,
    pair: {
      status: pair.status,
      flags: [...pair.flags],
      ...(pair.executor ? { executor: pair.executor } : {}),
      ...(pair.auditor ? { auditor: pair.auditor } : {}),
      round: pair.round,
      blocking: [...pair.blocking],
      createdAt: pair.createdAt,
      ...(pair.startedAt !== undefined ? { startedAt: pair.startedAt } : {}),
      updatedAt: pair.updatedAt,
      ...(isTerminalTaskPairStatus(pair.status) ? { endedAt: pair.updatedAt } : {}),
      queueOrder: stored.queueOrder,
      ...(options.queuePosition !== undefined ? { queuePosition: options.queuePosition } : {}),
      ...(pair.urgent ? { urgent: true } : {}),
      ...(pair.executor ? (() => { const p = resolve?.(pair.executor!, pair.updatedAt); return { executorLabel: p?.label, executorModel: p?.model ?? pair.executorModel, executorState: p?.state }; })() : pair.executorModel ? { executorModel: pair.executorModel } : {}),
      ...(pair.auditor && pair.auditor !== TASK_PAIR_NO_AUDITOR ? (() => { const p = resolve?.(pair.auditor!, pair.updatedAt); return { auditorLabel: p?.label, auditorModel: p?.model ?? pair.auditorModel, auditorState: p?.state }; })() : pair.auditor === TASK_PAIR_NO_AUDITOR ? { auditorModel: TASK_PAIR_NO_AUDITOR } : pair.auditorModel ? { auditorModel: pair.auditorModel } : {}),
      ...(pair.lastVerdict ? { severityCounts: { ...pair.lastVerdict.counts }, lastVerdict: pair.lastVerdict.verb } : {}),
      ...(pair.flags.includes('waiting_for_capacity') ? { waitingReason: pair.capacityWaitReason ?? null } : {}),
      ...(pair.brief
        ? {
          ...(options.inlineBrief ? { brief: pair.brief } : { briefRevision: taskPairBriefRevision(pair.brief) }),
          checklist: taskPairChecklistCounts(pair.brief),
        }
        : {}),
      ...(stored.liveness.lastNudgedAt !== undefined ? { lastNudgedAt: stored.liveness.lastNudgedAt } : {}),
    },
  };
  const assignments: SupervisionTaskConsoleAssignmentRow[] = [];
  const roles: Array<['implementer' | 'auditor', string | undefined, number]> = [
    ['implementer', pair.executor, stored.liveness.progressExecutorAt],
    ['auditor', pair.auditor === TASK_PAIR_NO_AUDITOR ? undefined : pair.auditor, stored.liveness.progressAuditorAt],
  ];
  for (const [role, session, progressAt] of roles) {
    if (!session) continue;
    const presentation = resolve?.(session, progressAt);
    assignments.push({
      assignmentId: `${pair.taskId}:${role}`,
      taskId: pair.taskId,
      status,
      phase,
      role,
      ownerSessionName: session,
      ownerSessionLabel: presentation?.label,
      observedModel: presentation?.model,
      sessionState: presentation?.state ?? 'unknown',
      sessionStateSource: presentation?.source ?? 'registry',
      sessionStateObservedAt: presentation?.observedAt ?? progressAt,
      validationState: 'unknown',
      ...(role === 'auditor' && pair.lastVerdict ? { auditVerdict: pair.lastVerdict.verb } : {}),
      ...(progressAt ? { heartbeatAt: progressAt } : {}),
      updatedAt: pair.updatedAt,
      lastEventId: 0,
    });
  }
  return { task, assignments };
}

/** What one viewer scope was last sent for a `pairs` project. */
export interface PairScopeView {
  /** Bumped once per non-empty delta; the snapshot reports the current value. */
  revision: number;
  /** `json` is computed lazily: only rows a delta touches are ever compared. */
  rows: Map<string, { json?: string; upsert: SupervisionTaskConsolePairUpsert }>;
}

export function pairRowJson(upsert: SupervisionTaskConsolePairUpsert): string {
  return JSON.stringify(upsert);
}
