import {
  GLOBAL_TASK_FLEET_SNAPSHOT_MSG,
  GLOBAL_TASK_RECENT_FINISHED_LIMIT,
  GLOBAL_TASK_TERMINAL_WINDOW_MS,
  isGlobalTaskTerminalStatus,
  isNoAuditorSentinel,
  type GlobalTaskFleetSnapshotFrame,
  type GlobalTaskFleetSnapshotPair,
} from '../../../shared/global-task-mode.js';
import { buildGlobalTaskAuditSummary } from '../../../shared/task-pair-brief.js';
import { TASK_PAIR_NO_AUDITOR } from '../../../shared/task-pair.js';
import { isInternalSessionDisplayValue } from '../../../shared/session-display.js';
import { taskPairChecklistCounts } from '../../../shared/task-pair-checklist.js';
import { getSession } from '../../store/session-store.js';
import { getTaskPairStore, type StoredTaskPair } from './store.js';

function sessionLabel(sessionName: string | undefined): string | undefined {
  if (!sessionName || sessionName === TASK_PAIR_NO_AUDITOR) return undefined;
  const sess = getSession(sessionName);
  const label = sess?.label?.trim();
  if (label && !isInternalSessionDisplayValue(label, sessionName)) return label;
  const roleMatch = /^w(\d+)$/i.exec(sess?.role?.trim() ?? '') ?? /_w(\d+)$/i.exec(sessionName);
  if (roleMatch) return `W${roleMatch[1]}`;
  return undefined;
}

function sessionModel(sessionName: string | undefined, fallback?: string): string | undefined {
  if (!sessionName || isNoAuditorSentinel(sessionName)) return undefined;
  const sess = getSession(sessionName);
  const raw = sess?.modelDisplay?.trim()
    || sess?.activeModel?.trim()
    || sess?.requestedModel?.trim()
    || sess?.qwenModel?.trim()
    || fallback?.trim();
  if (!raw || isNoAuditorSentinel(raw)) return undefined;
  return raw;
}

export function toGlobalTaskFleetSnapshotPair(stored: StoredTaskPair): GlobalTaskFleetSnapshotPair {
  const { state, project } = stored;
  const checklist = state.brief ? taskPairChecklistCounts(state.brief) : { total: 0, implemented: 0, audited: 0 };
  const executorLabel = sessionLabel(state.executor);
  const auditorLabel = sessionLabel(state.auditor);
  const executorModel = sessionModel(state.executor, state.executorModel);
  const auditorModel = sessionModel(state.auditor, state.auditorModel);
  const lastAudit = buildGlobalTaskAuditSummary(state.lastVerdict, state.blocking);
  // Keep independent blockedNote; fall back to compact audit summary for legacy clients while avoiding dumping raw noticeText when structured lastAudit is present.
  const liveSummary = state.blockedNote?.trim()
    || lastAudit?.summary
    || state.lastVerdict?.noticeText?.trim()
    || undefined;
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
    ...(executorModel ? { executorModel } : {}),
    ...(auditorModel ? { auditorModel } : {}),
    ...(state.auditor ? { auditor: state.auditor } : {}),
    ...(liveSummary ? { liveSummary: liveSummary.slice(0, 240) } : {}),
    ...(lastAudit ? { lastAudit } : {}),
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
