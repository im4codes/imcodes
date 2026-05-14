import type { TimelineEvent, TimelineEventType } from './timeline-event.js';
import type { TimelineHistoryDetailCandidate } from './timeline-history-sanitize.js';
import type { TimelineHistoryWorkerErrorReason } from '../../shared/timeline-history-errors.js';
import type { TimelineResponseSource } from '../../shared/timeline-protocol.js';

export type { TimelineHistoryWorkerErrorReason };
export type TimelineHistoryWorkerDetailCandidate = TimelineHistoryDetailCandidate;

export const DEFAULT_TIMELINE_HISTORY_WORKERS_TARGET = 2;
export const MIN_TIMELINE_HISTORY_WORKERS_TARGET = 1;
export const HARD_MAX_TIMELINE_HISTORY_WORKERS = 3;
export const DEFAULT_TIMELINE_HISTORY_POOL_QUEUE_CAP = 16;

export type TimelineHistoryWorkerRequestId = number;
export type TimelineHistoryWorkerSlotId = number;
export type TimelineHistoryWorkerGeneration = number;

export interface TimelineHistoryWorkerIdentity {
  workerRequestId: TimelineHistoryWorkerRequestId;
  workerSlotId: TimelineHistoryWorkerSlotId;
  workerGeneration: TimelineHistoryWorkerGeneration;
}

export interface TimelineHistoryBuildJobInput {
  sessionName: string;
  limit: number;
  afterTs?: number;
  beforeTs?: number;
  maxResponseBytes?: number;
  contentTypes: TimelineEventType[];
  stateTypes: TimelineEventType[];
}

export interface TimelineHistoryWorkerRequest extends TimelineHistoryBuildJobInput, TimelineHistoryWorkerIdentity {}

export interface TimelineHistoryWorkerSuccess extends TimelineHistoryWorkerIdentity {
  kind: 'success';
  source: TimelineResponseSource;
  events: TimelineEvent[];
  detailCandidates: TimelineHistoryWorkerDetailCandidate[];
  eventsRead: number;
  payloadBytes: number;
  droppedEvents: number;
  truncatedEvents: number;
  readMs: number;
  sanitizeMs: number;
}

export interface TimelineHistoryWorkerError extends TimelineHistoryWorkerIdentity {
  kind: 'error';
  reason: TimelineHistoryWorkerErrorReason;
  sanitized: true;
}

export type TimelineHistoryWorkerResult = TimelineHistoryWorkerSuccess | TimelineHistoryWorkerError;

export function withTimelineHistoryWorkerIdentity(
  input: TimelineHistoryBuildJobInput,
  identity: TimelineHistoryWorkerIdentity,
): TimelineHistoryWorkerRequest {
  return { ...input, ...identity };
}

export function isTimelineHistoryWorkerResultFor(
  result: TimelineHistoryWorkerResult,
  identity: TimelineHistoryWorkerIdentity,
): boolean {
  return result.workerRequestId === identity.workerRequestId
    && result.workerSlotId === identity.workerSlotId
    && result.workerGeneration === identity.workerGeneration;
}
