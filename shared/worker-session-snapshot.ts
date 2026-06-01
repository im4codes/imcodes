import { isSessionAgentType } from './agent-types.js';
import { isTransportEffortLevel, type TransportEffortLevel } from './effort-levels.js';

export const WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT = 'session-snapshot';
export const WORKER_SESSION_SNAPSHOT_VERSION = 1;

export const WORKER_SESSION_SYNC_STATUS = {
  FAILED: 'failed',
  DEGRADED: 'degraded',
  APPLIED: 'applied',
} as const;

export const WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON = {
  QUERY_FAILED: 'query_failed',
  INVALID_ROW: 'invalid_row',
  LEGACY_RESPONSE: 'legacy_response',
  SERVER_ID_MISMATCH: 'server_id_mismatch',
  INCOMPLETE_RESPONSE: 'incomplete_response',
} as const;

export type WorkerSessionSyncStatus =
  typeof WORKER_SESSION_SYNC_STATUS[keyof typeof WORKER_SESSION_SYNC_STATUS];

export const WORKER_SESSION_STATES = ['running', 'idle', 'error', 'stopped'] as const;
export type WorkerSessionState = typeof WORKER_SESSION_STATES[number];

export interface WorkerSessionSnapshot {
  name: string;
  project_name: string;
  role: 'brain' | `w${number}`;
  agent_type: string;
  project_dir: string;
  state: WorkerSessionState;
  label?: string | null;
  requested_model?: string | null;
  active_model?: string | null;
  effort?: TransportEffortLevel | null;
  transport_config?: Record<string, unknown> | null;
}

export interface WorkerSubSessionSnapshot {
  id: string;
  type: string;
  cwd?: string | null;
  parent_session?: string | null;
  label?: string | null;
  requested_model?: string | null;
  active_model?: string | null;
  effort?: TransportEffortLevel | null;
  transport_config?: Record<string, unknown> | null;
}

export interface WorkerSessionSnapshotCompleteResponse {
  version: typeof WORKER_SESSION_SNAPSHOT_VERSION;
  complete: true;
  serverId: string;
  generatedAt: number;
  snapshotId: string;
  counts: {
    sessions: number;
    subSessions: number;
  };
  sessions: WorkerSessionSnapshot[];
  subSessions: WorkerSubSessionSnapshot[];
  deletedNames?: string[];
  deletedSubSessionNames?: string[];
}

export interface WorkerSessionSnapshotIncompleteResponse {
  version: typeof WORKER_SESSION_SNAPSHOT_VERSION;
  complete: false;
  serverId: string;
  generatedAt: number;
  reason: string;
}

export type WorkerSessionSnapshotResponse =
  | WorkerSessionSnapshotCompleteResponse
  | WorkerSessionSnapshotIncompleteResponse;

export interface NormalizedRows<T> {
  ok: boolean;
  rows: T[];
  issues: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown, field: string, issues: string[]): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return value;
  issues.push(`${field}: expected string|null`);
  return undefined;
}

function parseTransportConfig(value: unknown, field: string, issues: string[]): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed === null) return null;
      if (isRecord(parsed)) return parsed;
      issues.push(`${field}: parsed JSON must be an object|null`);
      return undefined;
    } catch {
      issues.push(`${field}: invalid JSON`);
      return undefined;
    }
  }
  if (isRecord(value)) return value;
  issues.push(`${field}: expected object|string|null`);
  return undefined;
}

function isWorkerSessionState(value: unknown): value is WorkerSessionState {
  return typeof value === 'string' && (WORKER_SESSION_STATES as readonly string[]).includes(value);
}

function isWorkerSessionRole(value: unknown): value is WorkerSessionSnapshot['role'] {
  return typeof value === 'string' && (value === 'brain' || /^w\d+$/.test(value));
}

function normalizeEffort(value: unknown, field: string, issues: string[]): TransportEffortLevel | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (isTransportEffortLevel(value)) return value;
  issues.push(`${field}: invalid effort`);
  return undefined;
}

export function normalizeWorkerSessionRows(input: unknown): NormalizedRows<WorkerSessionSnapshot> {
  if (!Array.isArray(input)) return { ok: false, rows: [], issues: ['sessions: expected array'] };
  const rows: WorkerSessionSnapshot[] = [];
  const issues: string[] = [];

  input.forEach((item, index) => {
    const prefix = `sessions[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${prefix}: expected object`);
      return;
    }
    const name = item.name;
    const projectName = item.project_name;
    const role = item.role;
    const agentType = item.agent_type;
    const projectDir = item.project_dir;
    const state = item.state;
    if (typeof name !== 'string' || name.length === 0) issues.push(`${prefix}.name: expected non-empty string`);
    if (typeof projectName !== 'string') issues.push(`${prefix}.project_name: expected string`);
    if (!isWorkerSessionRole(role)) issues.push(`${prefix}.role: invalid role`);
    if (typeof agentType !== 'string' || !isSessionAgentType(agentType)) issues.push(`${prefix}.agent_type: invalid agent type`);
    if (typeof projectDir !== 'string') issues.push(`${prefix}.project_dir: expected string`);
    if (!isWorkerSessionState(state)) issues.push(`${prefix}.state: invalid state`);

    const label = optionalString(item.label, `${prefix}.label`, issues);
    const requestedModel = optionalString(item.requested_model, `${prefix}.requested_model`, issues);
    const activeModel = optionalString(item.active_model, `${prefix}.active_model`, issues);
    const effort = normalizeEffort(item.effort, `${prefix}.effort`, issues);
    const transportConfig = parseTransportConfig(item.transport_config, `${prefix}.transport_config`, issues);

    if (
      typeof name === 'string'
      && typeof projectName === 'string'
      && isWorkerSessionRole(role)
      && typeof agentType === 'string'
      && isSessionAgentType(agentType)
      && typeof projectDir === 'string'
      && isWorkerSessionState(state)
    ) {
      rows.push({
        name,
        project_name: projectName,
        role,
        agent_type: agentType,
        project_dir: projectDir,
        state,
        ...(label !== undefined ? { label } : {}),
        ...(requestedModel !== undefined ? { requested_model: requestedModel } : {}),
        ...(activeModel !== undefined ? { active_model: activeModel } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(transportConfig !== undefined ? { transport_config: transportConfig } : {}),
      });
    }
  });

  return { ok: issues.length === 0, rows, issues };
}

export function normalizeWorkerSubSessionRows(input: unknown): NormalizedRows<WorkerSubSessionSnapshot> {
  if (!Array.isArray(input)) return { ok: false, rows: [], issues: ['subSessions: expected array'] };
  const rows: WorkerSubSessionSnapshot[] = [];
  const issues: string[] = [];

  input.forEach((item, index) => {
    const prefix = `subSessions[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${prefix}: expected object`);
      return;
    }
    const id = item.id;
    const type = item.type;
    if (typeof id !== 'string' || id.length === 0) issues.push(`${prefix}.id: expected non-empty string`);
    if (typeof type !== 'string' || !isSessionAgentType(type)) issues.push(`${prefix}.type: invalid agent type`);

    const cwd = optionalString(item.cwd, `${prefix}.cwd`, issues);
    const parentSession = optionalString(item.parent_session, `${prefix}.parent_session`, issues);
    const label = optionalString(item.label, `${prefix}.label`, issues);
    const requestedModel = optionalString(item.requested_model, `${prefix}.requested_model`, issues);
    const activeModel = optionalString(item.active_model, `${prefix}.active_model`, issues);
    const effort = normalizeEffort(item.effort, `${prefix}.effort`, issues);
    const transportConfig = parseTransportConfig(item.transport_config, `${prefix}.transport_config`, issues);

    if (typeof id === 'string' && id.length > 0 && typeof type === 'string' && isSessionAgentType(type)) {
      rows.push({
        id,
        type,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(parentSession !== undefined ? { parent_session: parentSession } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(requestedModel !== undefined ? { requested_model: requestedModel } : {}),
        ...(activeModel !== undefined ? { active_model: activeModel } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(transportConfig !== undefined ? { transport_config: transportConfig } : {}),
      });
    }
  });

  return { ok: issues.length === 0, rows, issues };
}

export function buildWorkerSessionSnapshotCompleteResponse(args: {
  serverId: string;
  generatedAt?: number;
  sessions: WorkerSessionSnapshot[];
  subSessions: WorkerSubSessionSnapshot[];
}): WorkerSessionSnapshotCompleteResponse {
  const generatedAt = args.generatedAt ?? Date.now();
  return {
    version: WORKER_SESSION_SNAPSHOT_VERSION,
    complete: true,
    serverId: args.serverId,
    generatedAt,
    snapshotId: `${args.serverId}:${generatedAt}`,
    counts: {
      sessions: args.sessions.length,
      subSessions: args.subSessions.length,
    },
    sessions: args.sessions,
    subSessions: args.subSessions,
  };
}

export function buildWorkerSessionSnapshotIncompleteResponse(args: {
  serverId: string;
  reason: string;
  generatedAt?: number;
}): WorkerSessionSnapshotIncompleteResponse {
  return {
    version: WORKER_SESSION_SNAPSHOT_VERSION,
    complete: false,
    serverId: args.serverId,
    generatedAt: args.generatedAt ?? Date.now(),
    reason: args.reason,
  };
}
