import {
  GLOBAL_TASK_FLEET_SNAPSHOT_MSG,
  GLOBAL_TASK_RECENT_FINISHED_LIMIT,
  GLOBAL_TASK_TERMINAL_WINDOW_MS,
  isGlobalTaskTerminalStatus,
  type GlobalTaskFleetSnapshotFrame,
  type GlobalTaskFleetSnapshotPair,
} from '../../../shared/global-task-mode.js';
import { TASK_PAIR_NO_AUDITOR } from '../../../shared/task-pair.js';
import { taskPairChecklistCounts } from '../../../shared/task-pair-checklist.js';
import { getSession } from '../../store/session-store.js';
import { getTaskPairStore, type StoredTaskPair } from './store.js';

function sessionLabel(sessionName: string | undefined): string | undefined {
  if (!sessionName || sessionName === TASK_PAIR_NO_AUDITOR) return undefined;
  const label = getSession(sessionName)?.label?.trim();
  return label || undefined;
}

export function toGlobalTaskFleetSnapshotPair(stored: StoredTaskPair): GlobalTaskFleetSnapshotPair {
  const { state, project } = stored;
  const checklist = state.brief ? taskPairChecklistCounts(state.brief) : { total: 0, implemented: 0, audited: 0 };
  const executorLabel = sessionLabel(state.executor);
  const auditorLabel = sessionLabel(state.auditor);
  const liveSummary = state.blockedNote?.trim() || state.lastVerdict?.noticeText?.trim() || undefined;
  const startedAt = typeof state.startedAt === 'number' && Number.isFinite(state.startedAt) && state.startedAt > 0
    ? state.startedAt
    : undefined;
  const rawEndedAt = state.workspace?.endedAt;
  const endedAt = typeof rawEndedAt === 'number' && Number.isFinite(rawEndedAt) && rawEndedAt > 0
    ? rawEndedAt
    : (isGlobalTaskTerminalStatus(state.status) ? (state.updatedAt || state.createdAt || undefined) : undefined);
  return {
    taskId: state.taskId,
    brain: state.brain,
    projectName: project,
    title: state.title?.trim() ?? '',
    status: state.status,
    flags: [...state.flags],
    round: state.round,
    checklist,
    ...(executorLabel ? { executorLabel } : {}),
    ...(auditorLabel ? { auditorLabel } : {}),
    ...(state.auditor ? { auditor: state.auditor } : {}),
    ...(liveSummary ? { liveSummary: liveSummary.slice(0, 240) } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt || state.createdAt || 0,
  };
}

export function buildGlobalTaskFleetSnapshotPayload(now: number = Date.now()): GlobalTaskFleetSnapshotFrame {
  const store = getTaskPairStore();
  const active = store.listActivePairs();
  const recentTerminal = store.listRecentTerminalPairs(
    now - GLOBAL_TASK_TERMINAL_WINDOW_MS,
    GLOBAL_TASK_RECENT_FINISHED_LIMIT,
  );
  const seen = new Set<string>();
  const pairs: GlobalTaskFleetSnapshotPair[] = [];
  for (const stored of [...active, ...recentTerminal]) {
    const key = `${stored.project}\u0000${stored.state.taskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(toGlobalTaskFleetSnapshotPair(stored));
  }
  return {
    type: GLOBAL_TASK_FLEET_SNAPSHOT_MSG,
    pairs,
  };
}
