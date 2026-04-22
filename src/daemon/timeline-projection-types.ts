import type { TimelineEvent, TimelineEventType } from './timeline-event.js';

export type ProjectionSessionStatus = 'missing' | 'building' | 'ready' | 'stale' | 'corrupt';

export interface ProjectionSessionMeta {
  sessionId: string;
  lastProjectedAppendOrdinal: number;
  sourceFileSizeBytes: number;
  sourceFileMtimeMs: number;
  projectionVersion: number;
  status: ProjectionSessionStatus;
  lastRebuiltAt: number | null;
}

export interface TimelineProjectionQuery {
  sessionId: string;
  limit?: number;
  afterTs?: number;
  beforeTs?: number;
  types?: TimelineEventType[];
}

export interface TimelineProjectionQueryResult {
  source: 'sqlite';
  events: TimelineEvent[];
}

export interface TimelineProjectionCompletedText {
  source: 'sqlite';
  events: TimelineEvent[];
}

export interface ProjectionWorkerRequestMap {
  recordAppendedEvent: { event: TimelineEvent };
  queryHistory: TimelineProjectionQuery;
  queryByTypes: Required<Pick<TimelineProjectionQuery, 'sessionId' | 'types'>> & Omit<TimelineProjectionQuery, 'types'>;
  queryCompletedTextTail: { sessionId: string; limit?: number };
  queryLatest: { sessionId: string };
  rebuildSession: { sessionId: string };
  pruneSessionToAuthoritative: { sessionId: string; keepLast: number };
  deleteSession: { sessionId: string };
  checkpointIfNeeded: Record<string, never>;
  shutdown: Record<string, never>;
}

export interface ProjectionWorkerResponseMap {
  recordAppendedEvent: boolean;
  queryHistory: TimelineProjectionQueryResult;
  queryByTypes: TimelineProjectionQueryResult;
  queryCompletedTextTail: TimelineProjectionCompletedText;
  queryLatest: { epoch: number; seq: number } | null;
  rebuildSession: boolean;
  pruneSessionToAuthoritative: boolean;
  deleteSession: boolean;
  checkpointIfNeeded: boolean;
  shutdown: true;
}

export type ProjectionWorkerRequestType = keyof ProjectionWorkerRequestMap;

export interface ProjectionWorkerEnvelope<T extends ProjectionWorkerRequestType = ProjectionWorkerRequestType> {
  id: number;
  type: T;
  payload: ProjectionWorkerRequestMap[T];
}

export interface ProjectionWorkerSuccess<T extends ProjectionWorkerRequestType = ProjectionWorkerRequestType> {
  id: number;
  ok: true;
  type: T;
  result: ProjectionWorkerResponseMap[T];
}

export interface ProjectionWorkerFailure<T extends ProjectionWorkerRequestType = ProjectionWorkerRequestType> {
  id: number;
  ok: false;
  type: T;
  error: string;
  code?: string;
}

export type ProjectionWorkerResponse = ProjectionWorkerSuccess | ProjectionWorkerFailure;
