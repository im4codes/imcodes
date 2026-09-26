export const TIMELINE_MESSAGES = {
  /** Browser → server: subscribe one socket to one session's live timeline. */
  SUBSCRIBE: 'timeline.subscribe',
  /** Browser → server: stop live timeline delivery for one session/socket. */
  UNSUBSCRIBE: 'timeline.unsubscribe',
  /** Server → browser: a bounded live queue/coalescing gap needs history backfill. */
  SEQ_GAP: 'timeline.seq_gap',
  HISTORY_REQUEST: 'timeline.history_request',
  HISTORY: 'timeline.history',
  /** Server → daemon: the server abandoned this history/page request (timeout
   *  or requester gone). The daemon drops its reply if still queued unsent.
   *  Only sent to daemons advertising TIMELINE_HISTORY_CANCEL_CAPABILITY. */
  HISTORY_CANCEL: 'timeline.history_cancel',
  REPLAY_REQUEST: 'timeline.replay_request',
  REPLAY: 'timeline.replay',
  PAGE_REQUEST: 'timeline.page_request',
  PAGE: 'timeline.page',
  DETAIL_REQUEST: 'timeline.detail_request',
  DETAIL: 'timeline.detail',
  EVENT: 'timeline.event',
  /** Web → daemon: globally delete (hide) one timeline message for every viewer,
   *  durably across refresh/restart. Acked via the normal `command.ack`. */
  DELETE: 'timeline.delete',
} as const;

export type TimelineMessageType = (typeof TIMELINE_MESSAGES)[keyof typeof TIMELINE_MESSAGES];

/** Delivery quality for a browser socket/session pair. */
export const TIMELINE_SUBSCRIPTION_MODES = {
  /** Visible/pinned window: all timeline frames, including streaming deltas.
   * A healthy full subscriber is never coalesced or delayed for load. */
  FULL: 'full',
  /** Hidden/minimized window: durable events and latest-value summaries only. */
  SUMMARY: 'summary',
} as const;

export type TimelineSubscriptionMode =
  (typeof TIMELINE_SUBSCRIPTION_MODES)[keyof typeof TIMELINE_SUBSCRIPTION_MODES];

export interface TimelineSubscribeRequest {
  type: typeof TIMELINE_MESSAGES.SUBSCRIBE;
  sessionName: string;
  mode: TimelineSubscriptionMode;
  /** Optional cursor used when switching mode or reconnecting. */
  epoch?: number;
  afterSeq?: number;
  requestId?: string;
}

export interface TimelineUnsubscribeRequest {
  type: typeof TIMELINE_MESSAGES.UNSUBSCRIBE;
  sessionName: string;
  requestId?: string;
}

export interface TimelineSeqGap {
  type: typeof TIMELINE_MESSAGES.SEQ_GAP;
  sessionId: string;
  epoch: number;
  fromSeq: number;
  toSeq: number;
  reason: 'backpressure' | 'coalesced' | 'transport' | string;
  /** Client should issue HISTORY_REQUEST with cursor.afterSeq = toSeq. */
  backfill: true;
}

export const TIMELINE_RESPONSE_STATUS = {
  OK: 'ok',
  PARTIAL: 'partial',
  DEFERRED: 'deferred',
  ERROR: 'error',
  CANCELED: 'canceled',
} as const;

export type TimelineResponseStatus =
  (typeof TIMELINE_RESPONSE_STATUS)[keyof typeof TIMELINE_RESPONSE_STATUS];

export const TIMELINE_RESPONSE_SOURCES = {
  RING_BUFFER: 'ring_buffer',
  WORKER_SQLITE: 'worker_sqlite',
  MAIN_SQLITE: 'main_sqlite',
  JSONL_TAIL: 'jsonl_tail',
  RING_BUFFER_JSONL: 'ring_buffer_jsonl',
  OPENCODE_EXPORT: 'opencode_export',
  CACHE: 'cache',
  DEFERRED: 'deferred',
  ERROR: 'error',
} as const;

export type TimelineResponseSource =
  (typeof TIMELINE_RESPONSE_SOURCES)[keyof typeof TIMELINE_RESPONSE_SOURCES];

export const TIMELINE_CURSOR_DIRECTIONS = {
  NEWER: 'newer',
  OLDER: 'older',
} as const;

export type TimelineCursorDirection =
  (typeof TIMELINE_CURSOR_DIRECTIONS)[keyof typeof TIMELINE_CURSOR_DIRECTIONS];

export interface TimelineCursor {
  epoch: number;
  afterSeq?: number;
  beforeTs?: number;
  afterTs?: number;
  direction: TimelineCursorDirection;
}

export const TIMELINE_PROTOCOL_REVISION = 1 as const;
export const TIMELINE_PROTOCOL_CAPABILITY = 'timeline.protocol.v1' as const;
/** Daemon understands TIMELINE_MESSAGES.HISTORY_CANCEL. */
export const TIMELINE_HISTORY_CANCEL_CAPABILITY = 'timeline.history_cancel.v1' as const;

export interface TimelineProtocolCapability {
  capability: typeof TIMELINE_PROTOCOL_CAPABILITY;
  revision: typeof TIMELINE_PROTOCOL_REVISION | number;
}

export const TIMELINE_DETAIL_FIELD_PATHS = {
  PAYLOAD_TEXT: 'payload.text',
  PAYLOAD_OUTPUT: 'payload.output',
  PAYLOAD_ERROR: 'payload.error',
  PAYLOAD_DETAIL_OUTPUT: 'payload.detail.output',
} as const;

export type TimelineDetailFieldPath =
  (typeof TIMELINE_DETAIL_FIELD_PATHS)[keyof typeof TIMELINE_DETAIL_FIELD_PATHS];

export interface TimelineDetailRef {
  detailId: string;
  sessionName?: string;
  epoch?: number;
  detailStoreGeneration?: string;
  eventId?: string;
  fieldPath: TimelineDetailFieldPath | string;
  completeness?: TimelineEventCompleteness;
  previewBytes?: number;
  expiresAt?: number | string;
  label?: string;
  mediaType?: string;
}

export type TimelineDetailRefV1 = TimelineDetailRef & {
  epoch: number;
  detailStoreGeneration: string;
  eventId: string;
  fieldPath: TimelineDetailFieldPath;
};

export type TimelineEventCompleteness = 'preview' | 'full' | 'hydrated';

export interface TimelineDetailRequestLegacy {
  type: typeof TIMELINE_MESSAGES.DETAIL_REQUEST;
  sessionName: string;
  requestId?: string;
  detailId: string;
  epoch?: number;
  detailStoreGeneration?: string;
  eventId?: string;
  fieldPath?: TimelineDetailFieldPath | string;
}

export interface TimelineDetailRequestV1 {
  type: typeof TIMELINE_MESSAGES.DETAIL_REQUEST;
  sessionName: string;
  requestId?: string;
  detailId: string;
  epoch: number;
  detailStoreGeneration: string;
  eventId: string;
  fieldPath: TimelineDetailFieldPath;
}

export type TimelineDetailRequest = TimelineDetailRequestLegacy | TimelineDetailRequestV1;

export interface TimelineHistoryRequest {
  type: typeof TIMELINE_MESSAGES.HISTORY_REQUEST;
  sessionName: string;
  requestId?: string;
  limit?: number;
  afterTs?: number;
  beforeTs?: number;
  cursor?: TimelineCursor | null;
  includeDetails?: boolean;
  budgetBytes?: number;
}

export interface TimelineReplayRequest {
  type: typeof TIMELINE_MESSAGES.REPLAY_REQUEST;
  sessionName: string;
  requestId?: string;
  afterSeq: number;
  epoch: number;
}

export interface TimelinePageRequest extends Omit<TimelineHistoryRequest, 'type'> {
  type: typeof TIMELINE_MESSAGES.PAGE_REQUEST;
}

export type TimelineProtocolClientRequest =
  | TimelineSubscribeRequest
  | TimelineUnsubscribeRequest
  | TimelineHistoryRequest
  | TimelineReplayRequest
  | TimelinePageRequest
  | TimelineDetailRequest;

export interface TimelinePayloadMetadata {
  status?: TimelineResponseStatus;
  errorReason?: string;
  source?: TimelineResponseSource | string;
  /**
   * Internal shaped event-array estimate. This is useful for daemon-side
   * accounting but is not a replacement for final wire envelope size.
   */
  payloadBytes?: number;
  /**
   * Byte length of the fully encoded response envelope at the boundary that
   * created it. Daemon, bridge, and HTTP wrappers each compute their own value.
   */
  actualPayloadBytes?: number;
  payloadTruncated?: boolean;
  hasMore?: boolean;
  nextCursor?: TimelineCursor | null;
  cursorReset?: boolean;
  droppedEvents?: number;
  truncatedEvents?: number;
  detailRefs?: TimelineDetailRef[];
  recoverable?: boolean;
}

export type TimelineProtocolEvent = Record<string, unknown> & {
  eventId?: string;
  sessionId?: string;
  ts?: number;
  seq?: number;
  epoch?: number;
  type?: string;
  payload?: Record<string, unknown>;
};

export type TimelineEventsResponseType =
  | typeof TIMELINE_MESSAGES.HISTORY
  | typeof TIMELINE_MESSAGES.REPLAY
  | typeof TIMELINE_MESSAGES.PAGE;

export interface TimelineEventsResponse<TEvent = TimelineProtocolEvent> extends TimelinePayloadMetadata {
  type: TimelineEventsResponseType;
  sessionName: string;
  requestId?: string;
  events: TEvent[];
  epoch: number;
  truncated?: boolean;
}

export interface TimelineHistoryResponse<TEvent = TimelineProtocolEvent> extends TimelineEventsResponse<TEvent> {
  type: typeof TIMELINE_MESSAGES.HISTORY;
}

export interface TimelineReplayResponse<TEvent = TimelineProtocolEvent> extends TimelineEventsResponse<TEvent> {
  type: typeof TIMELINE_MESSAGES.REPLAY;
  truncated?: boolean;
}

export interface TimelinePageResponse<TEvent = TimelineProtocolEvent> extends TimelineEventsResponse<TEvent> {
  type: typeof TIMELINE_MESSAGES.PAGE;
}

export interface TimelineDetailResponse extends TimelinePayloadMetadata {
  type: typeof TIMELINE_MESSAGES.DETAIL;
  sessionName?: string;
  requestId?: string;
  detailId?: string;
  eventId?: string;
  fieldPath?: TimelineDetailFieldPath | string;
  value?: unknown;
  detail?: unknown;
  content?: unknown;
  epoch?: number;
  detailStoreGeneration?: string;
  mediaType?: string;
}

export type TimelineProtocolResponse<TEvent = TimelineProtocolEvent> =
  | TimelineHistoryResponse<TEvent>
  | TimelineReplayResponse<TEvent>
  | TimelinePageResponse<TEvent>
  | TimelineDetailResponse;
