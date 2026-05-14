import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TimelineEvent } from './timeline-event.js';
import { shapeTimelineEventsForTransport } from './timeline-response-shaper.js';
import {
  TIMELINE_HISTORY_DETAIL_CANDIDATE_RESPONSE_MAX_BYTES,
  collectTimelineHistoryDetailCandidates,
} from './timeline-history-sanitize.js';
import type {
  TimelineHistoryWorkerDetailCandidate,
  TimelineHistoryWorkerError,
  TimelineHistoryWorkerRequest,
  TimelineHistoryWorkerResult,
  TimelineHistoryWorkerSuccess,
} from './timeline-history-worker-types.js';
import { TIMELINE_HISTORY_WORKER_ERROR_REASONS } from '../../shared/timeline-history-errors.js';
import { TIMELINE_RESPONSE_SOURCES } from '../../shared/timeline-protocol.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const EXPECTED_TIMELINE_PROJECTION_VERSION = 1;
const dbPath = typeof workerData?.dbPath === 'string' && workerData.dbPath
  ? workerData.dbPath
  : join(homedir(), '.imcodes', 'timeline.sqlite');

let db: DatabaseSyncInstance | null = null;

function ensureDb(): DatabaseSyncInstance {
  if (db) return db;
  const instance = new DatabaseSync(dbPath, { readOnly: true });
  db = instance;
  return instance;
}

function workerError(message: TimelineHistoryWorkerRequest, reason: TimelineHistoryWorkerError['reason']): TimelineHistoryWorkerError {
  return {
    workerRequestId: message.workerRequestId,
    workerSlotId: message.workerSlotId,
    workerGeneration: message.workerGeneration,
    kind: 'error',
    reason,
    sanitized: true,
  };
}

function sessionProjectionReady(sessionName: string): boolean {
  try {
    const row = ensureDb().prepare(`
      SELECT status, projection_version
      FROM timeline_projection_sessions
      WHERE session_id = ?
    `).get(sessionName) as Record<string, unknown> | undefined;
    return !!row
      && String(row.status) === 'ready'
      && Number(row.projection_version) === EXPECTED_TIMELINE_PROJECTION_VERSION;
  } catch {
    return false;
  }
}

function rowToEvent(row: Record<string, unknown>): TimelineEvent {
  const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
  return {
    eventId: String(row.event_id),
    sessionId: String(row.session_id),
    ts: Number(row.ts),
    seq: Number(row.seq),
    epoch: Number(row.epoch),
    source: String(row.source) as TimelineEvent['source'],
    confidence: String(row.confidence) as TimelineEvent['confidence'],
    type: String(row.type) as TimelineEvent['type'],
    payload,
    ...(Number(row.hidden) === 1 ? { hidden: true } : {}),
  };
}

function buildRangeSql(base: string, afterTs?: number, beforeTs?: number): { sql: string; params: unknown[] } {
  const clauses = [base];
  const params: unknown[] = [];
  if (afterTs !== undefined) {
    clauses.push('AND ts > ?');
    params.push(afterTs);
  }
  if (beforeTs !== undefined) {
    clauses.push('AND ts < ?');
    params.push(beforeTs);
  }
  return { sql: clauses.join(' '), params };
}

function queryByTypes(
  sessionName: string,
  types: readonly string[],
  limit: number,
  afterTs?: number,
  beforeTs?: number,
): TimelineEvent[] {
  if (types.length === 0) return [];
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 10_000));
  const placeholders = types.map(() => '?').join(', ');
  const { sql, params } = buildRangeSql(
    `SELECT * FROM timeline_projection_events WHERE session_id = ? AND type IN (${placeholders})`,
    afterTs,
    beforeTs,
  );
  const rows = ensureDb().prepare(`${sql} ORDER BY ts DESC, append_ordinal DESC LIMIT ?`)
    .all(...([sessionName, ...types, ...params, boundedLimit] as any[])) as Array<Record<string, unknown>>;
  return rows.reverse().map(rowToEvent);
}

export function collectSelectedDetailCandidates(
  originalEvents: readonly TimelineEvent[],
  selectedEvents: readonly TimelineEvent[],
): TimelineHistoryWorkerDetailCandidate[] {
  if (selectedEvents.length === 0) return [];
  const selectedIds = new Set(selectedEvents.map((event) => event.eventId));
  const candidates: TimelineHistoryWorkerDetailCandidate[] = [];
  const seen = new Set<string>();
  let candidateBytes = 0;

  for (const event of originalEvents) {
    if (!selectedIds.has(event.eventId)) continue;
    for (const candidate of collectTimelineHistoryDetailCandidates(event)) {
      const key = `${candidate.eventId}:${candidate.fieldPath}`;
      if (seen.has(key)) continue;
      if (candidateBytes + candidate.valueBytes > TIMELINE_HISTORY_DETAIL_CANDIDATE_RESPONSE_MAX_BYTES) {
        continue;
      }
      seen.add(key);
      candidateBytes += candidate.valueBytes;
      candidates.push(candidate);
    }
  }
  return candidates;
}

export async function handleTimelineHistoryWorkerRequest(
  message: TimelineHistoryWorkerRequest,
): Promise<TimelineHistoryWorkerResult> {
  const tRead = Date.now();
  try {
    if (!sessionProjectionReady(message.sessionName)) {
      return workerError(message, TIMELINE_HISTORY_WORKER_ERROR_REASONS.PROJECTION_UNAVAILABLE);
    }

    const limit = Math.max(1, Math.min(Math.trunc(message.limit), 2000));
    const substantive = queryByTypes(
      message.sessionName,
      message.contentTypes,
      limit,
      message.afterTs,
      message.beforeTs,
    );
    let stateEvents: TimelineEvent[] = [];
    if (substantive.length > 0) {
      const cutoffTs = substantive[0]!.ts;
      const stateAfterTs = message.afterTs === undefined ? cutoffTs - 1 : Math.max(message.afterTs, cutoffTs - 1);
      stateEvents = queryByTypes(
        message.sessionName,
        message.stateTypes,
        Math.max(limit * 2, 100),
        stateAfterTs,
        message.beforeTs,
      );
    }

    const events = [...substantive, ...stateEvents].sort((a, b) => a.ts - b.ts);
    const readMs = Date.now() - tRead;
    const trimmedSubstantive = substantive.length > limit ? substantive.slice(substantive.length - limit) : substantive;
    let trimmed: TimelineEvent[];
    if (trimmedSubstantive.length > 0 && stateEvents.length > 0) {
      const cutoffTs = trimmedSubstantive[0]!.ts;
      const relevantState = stateEvents.filter((event) => event.ts >= cutoffTs);
      trimmed = [...trimmedSubstantive, ...relevantState].sort((a, b) => a.ts - b.ts);
    } else {
      trimmed = trimmedSubstantive;
    }

    const tSanitize = Date.now();
    const sanitized = shapeTimelineEventsForTransport(trimmed, {
      maxResponseBytes: message.maxResponseBytes,
    });
    const detailCandidates = collectSelectedDetailCandidates(trimmed, sanitized.events);
    const sanitizeMs = Date.now() - tSanitize;

    const response: TimelineHistoryWorkerSuccess = {
      workerRequestId: message.workerRequestId,
      workerSlotId: message.workerSlotId,
      workerGeneration: message.workerGeneration,
      kind: 'success',
      source: TIMELINE_RESPONSE_SOURCES.WORKER_SQLITE,
      events: sanitized.events,
      detailCandidates,
      eventsRead: events.length,
      payloadBytes: sanitized.payloadBytes,
      droppedEvents: sanitized.droppedEvents,
      truncatedEvents: sanitized.truncatedEvents,
      readMs,
      sanitizeMs,
    };
    return response;
  } catch {
    return workerError(message, TIMELINE_HISTORY_WORKER_ERROR_REASONS.INTERNAL_ERROR);
  }
}

if (!parentPort) {
  throw new Error('timeline-history-worker requires parentPort');
}

parentPort.on('message', async (message: TimelineHistoryWorkerRequest) => {
  const response = await handleTimelineHistoryWorkerRequest(message);
  parentPort?.postMessage(response);
});
