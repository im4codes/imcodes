import {
  SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL,
  SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT,
} from '@shared/session-control-commands.js';
import {
  selectSessionHasLiveQueue,
  type TransportQueueReducerState,
} from '../../shared/transport-queue-reducer.js';

export type SessionLiveStatusMode =
  | 'idle'
  | 'running'
  | 'thinking'
  | 'tool'
  | 'waiting'
  | 'stopping'
  | 'cancelled'
  | 'error'
  | 'result';

export interface SessionLiveStatusInput {
  sessionState?: string | null;
  sessionStateReason?: string | null;
  sessionStateError?: string | null;
  activeThinking?: boolean;
  activeToolCall?: boolean;
  activeTransportTurn?: boolean;
  statusText?: string | null;
  transportActivityDetail?: string | null;
  sessionError?: string | null;
  stopRequested?: boolean;
  isAgentless?: boolean;
  transportQueueState?: TransportQueueReducerState | null;
}

export interface SessionLiveStatus {
  mode: SessionLiveStatusMode | null;
  busy: boolean;
  sweep: boolean;
  controlFeedback: 'stop_requested' | 'compact_requested' | 'cancelled' | null;
  errorDetail: string | null;
  activityDetail: string | null;
  resultLike: boolean;
}

export function isRunningSessionState(sessionState: string | null | undefined): boolean {
  return sessionState === 'running' || sessionState === 'queued';
}

export function isStoppingSessionState(sessionState: string | null | undefined): boolean {
  return sessionState === 'stopping';
}

function normalizeDetail(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  return text;
}

function isResultStatusText(statusText: string | null | undefined): boolean {
  return /^(?:supervised|auto):/i.test(statusText ?? '');
}

export function deriveSessionLiveStatus(input: SessionLiveStatusInput): SessionLiveStatus {
  const state = input.sessionState ?? null;
  const reason = input.sessionStateReason ?? null;
  const isAgentless = input.isAgentless === true;
  const activeThinking = input.activeThinking === true;
  const activeToolCall = input.activeToolCall === true;
  const hasLiveQueue = input.transportQueueState ? selectSessionHasLiveQueue(input.transportQueueState) : false;
  const activeTransportTurn = input.activeTransportTurn === true || hasLiveQueue;
  const stopRequested = input.stopRequested === true;
  const statusText = normalizeDetail(input.statusText);
  const activityDetail = normalizeDetail(input.transportActivityDetail);
  const rawErrorDetail = normalizeDetail(input.sessionStateError)
    ?? (state === 'error' ? normalizeDetail(input.transportActivityDetail) : null)
    ?? normalizeDetail(input.sessionError);
  const errorDetail = rawErrorDetail && !/^error$/i.test(rawErrorDetail) ? rawErrorDetail : null;

  if (isAgentless) {
    return {
      mode: null,
      busy: false,
      sweep: false,
      controlFeedback: null,
      errorDetail: null,
      activityDetail: null,
      resultLike: false,
    };
  }

  const cancelFeedback = reason === SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL;
  const compactFeedback = reason === SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT;
  const stopping = stopRequested || isStoppingSessionState(state) || cancelFeedback;
  const running = isRunningSessionState(state);
  const busy = stopping || running || activeThinking || activeToolCall || activeTransportTurn;
  const resultLike = isResultStatusText(statusText);

  let mode: SessionLiveStatusMode;
  let controlFeedback: SessionLiveStatus['controlFeedback'] = null;
  if (state === 'error') {
    mode = 'error';
  } else if (cancelFeedback || stopRequested || isStoppingSessionState(state)) {
    mode = 'stopping';
    controlFeedback = 'stop_requested';
  } else if (compactFeedback) {
    mode = 'running';
    controlFeedback = 'compact_requested';
  } else if (state === 'idle' && errorDetail && /cancel/i.test(errorDetail)) {
    mode = 'cancelled';
    controlFeedback = 'cancelled';
  } else if (activeToolCall) {
    mode = 'tool';
  } else if (activeThinking) {
    mode = 'thinking';
  } else if (running || activeTransportTurn) {
    mode = 'running';
  } else if (statusText) {
    mode = resultLike ? 'result' : 'waiting';
  } else {
    mode = 'idle';
  }

  return {
    mode,
    busy,
    sweep: running || stopping,
    controlFeedback,
    errorDetail,
    activityDetail,
    resultLike,
  };
}
