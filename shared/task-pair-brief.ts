import { MACHINE_CONFIG_REQUEST_ERROR } from './machine-config-request.js';

export const TASK_PAIR_BRIEF_MSG = {
  REQUEST: 'task_pair.brief_request',
  RESPONSE: 'task_pair.brief_response',
} as const;

export const TASK_PAIR_BRIEF_TIMEOUT_MS = 10_000 as const;

export const TASK_PAIR_BRIEF_ERROR = {
  INVALID_REQUEST: 'invalid_request',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  REQUEST_FAILED: 'request_failed',
  DAEMON_OFFLINE: MACHINE_CONFIG_REQUEST_ERROR.DAEMON_OFFLINE,
  TIMEOUT: MACHINE_CONFIG_REQUEST_ERROR.TIMEOUT,
} as const;
export type TaskPairBriefError = (typeof TASK_PAIR_BRIEF_ERROR)[keyof typeof TASK_PAIR_BRIEF_ERROR];

export interface TaskPairBriefChecklistSummary {
  total: number;
  implemented: number;
  audited: number;
}

export interface TaskPairBriefResponse {
  ok: boolean;
  taskId?: string;
  brief?: string;
  briefRevision?: string;
  checklist?: TaskPairBriefChecklistSummary;
  updatedAt?: number;
  error?: TaskPairBriefError | string;
}
