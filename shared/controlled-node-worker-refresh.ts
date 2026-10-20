import { DAEMON_MSG } from './daemon-events.js';

/** Capability advertised by runtimes that understand the operator refresh command. */
export const CONTROLLED_NODE_WORKER_REFRESH_CAPABILITY = 'remote.desktop.worker.refresh.v1' as const;

/** Server → controlled-node: request one independent worker refresh attempt. */
export const CONTROLLED_NODE_WORKER_REFRESH_MSG = {
  REQUEST: 'controlled_node.worker_refresh_request',
} as const;

export const CONTROLLED_NODE_WORKER_REFRESH_PHASE = {
  STARTED: 'started',
  DEFERRED: 'deferred',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const;

export type ControlledNodeWorkerRefreshPhase =
  (typeof CONTROLLED_NODE_WORKER_REFRESH_PHASE)[keyof typeof CONTROLLED_NODE_WORKER_REFRESH_PHASE];

export interface ControlledNodeWorkerRefreshStatusMessage {
  type: typeof DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS;
  attemptId: string;
  phase: ControlledNodeWorkerRefreshPhase;
  installedVersion?: string;
  targetVersion?: string;
  artifactSha256?: string;
  reason?: string;
  recordedAt: number;
}

const ATTEMPT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const VERSION_RE = /^[0-9]+(?:\.[0-9]+){1,3}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const PHASES = new Set<string>(Object.values(CONTROLLED_NODE_WORKER_REFRESH_PHASE));

export function validateControlledNodeWorkerRefreshStatusMessage(
  value: unknown,
): { ok: true; value: ControlledNodeWorkerRefreshStatusMessage } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  if (record.type !== DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS
    || typeof record.attemptId !== 'string' || !ATTEMPT_ID_RE.test(record.attemptId)
    || typeof record.phase !== 'string' || !PHASES.has(record.phase)
    || typeof record.recordedAt !== 'number' || !Number.isSafeInteger(record.recordedAt)
    || record.recordedAt < 0) return { ok: false };
  const optionalStrings: Array<[string, RegExp]> = [
    ['installedVersion', VERSION_RE],
    ['targetVersion', VERSION_RE],
    ['artifactSha256', SHA256_RE],
  ];
  for (const [key, pattern] of optionalStrings) {
    if (record[key] !== undefined && (typeof record[key] !== 'string' || !pattern.test(record[key]))) return { ok: false };
  }
  if (record.reason !== undefined && (typeof record.reason !== 'string' || record.reason.length < 1 || record.reason.length > 256)) return { ok: false };
  const allowed = new Set(['type', 'attemptId', 'phase', 'installedVersion', 'targetVersion', 'artifactSha256', 'reason', 'recordedAt']);
  if (Object.keys(record).some((key) => !allowed.has(key))) return { ok: false };
  return { ok: true, value: {
    type: DAEMON_MSG.CONTROLLED_NODE_WORKER_REFRESH_STATUS,
    attemptId: record.attemptId,
    phase: record.phase as ControlledNodeWorkerRefreshPhase,
    ...(typeof record.installedVersion === 'string' ? { installedVersion: record.installedVersion } : {}),
    ...(typeof record.targetVersion === 'string' ? { targetVersion: record.targetVersion } : {}),
    ...(typeof record.artifactSha256 === 'string' ? { artifactSha256: record.artifactSha256 } : {}),
    ...(typeof record.reason === 'string' ? { reason: record.reason.slice(0, 256) } : {}),
    recordedAt: record.recordedAt,
  } };
}
