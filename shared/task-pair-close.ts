import { MACHINE_CONFIG_REQUEST_ERROR } from './machine-config-request.js';

export const TASK_PAIR_CLOSE_MSG = {
  REQUEST: 'task_pair.close_request',
  RESPONSE: 'task_pair.close_response',
} as const;

export const TASK_PAIR_CLOSE_ACTIONS = ['cancel', 'done'] as const;
export type TaskPairCloseAction = (typeof TASK_PAIR_CLOSE_ACTIONS)[number];

export const TASK_PAIR_CLOSE_TIMEOUT_MS = 15_000 as const;

export const TASK_PAIR_CLOSE_ERROR = {
  INVALID_REQUEST: 'invalid_request',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  ALREADY_TERMINAL: 'already_terminal',
  REJECTED: 'rejected',
  DAEMON_OFFLINE: MACHINE_CONFIG_REQUEST_ERROR.DAEMON_OFFLINE,
  TIMEOUT: MACHINE_CONFIG_REQUEST_ERROR.TIMEOUT,
} as const;
export type TaskPairCloseError = (typeof TASK_PAIR_CLOSE_ERROR)[keyof typeof TASK_PAIR_CLOSE_ERROR];

export interface TaskPairCloseRequestBody {
  action: TaskPairCloseAction;
  force?: boolean;
  integration?: string;
}

export interface TaskPairCloseResponse {
  ok: boolean;
  taskId?: string;
  status?: string;
  effect?: string;
  projectName?: string;
  brainSession?: string;
  title?: string;
  updatedAt?: number;
  endedAt?: number;
  error?: TaskPairCloseError | string;
  detail?: string;
}

export function readTaskPairCloseBody(raw: unknown): TaskPairCloseRequestBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const action = obj.action;
  if (action !== 'cancel' && action !== 'done') return null;
  const body: TaskPairCloseRequestBody = { action };
  if (typeof obj.force === 'boolean') body.force = obj.force;
  if (typeof obj.integration === 'string') {
    const trimmed = obj.integration.trim();
    if (trimmed.length > 64) return null;
    if (trimmed) body.integration = trimmed;
  }
  return body;
}
