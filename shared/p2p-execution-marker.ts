export const P2P_EXECUTION_MARKER_SCHEMA_VERSION = 1 as const;

export type P2pExecutionMarkerStatus = 'completed' | 'failed';

/**
 * Error tokens emitted by the P2P post-summary execution gate when its final hop
 * either writes a `failed` execution marker (`post_summary_execution_failed`) or
 * times out (`post_summary_execution_timeout`). Consumers (e.g. OpenSpec Auto
 * Deliver) treat these as recoverable "could not finish in this turn" outcomes,
 * distinct from infrastructure failures such as `dispatch_failed`.
 */
export const POST_SUMMARY_EXECUTION_FAILURE_REASON_PREFIX = 'post_summary_execution';
export const POST_SUMMARY_EXECUTION_FAILED_ERROR_TYPE = 'post_summary_execution_failed';
export const POST_SUMMARY_EXECUTION_TIMEOUT_REASON = 'post_summary_execution_timeout';

/**
 * True when a terminated P2P run's error string indicates the post-summary
 * execution gate could not complete (agent-authored `failed` marker or gate
 * timeout), as opposed to an infrastructure/dispatch failure such as
 * `dispatch_failed`.
 */
export function isPostSummaryExecutionGateFailure(p2pError: string | null | undefined): boolean {
  return typeof p2pError === 'string' && p2pError.includes(POST_SUMMARY_EXECUTION_FAILURE_REASON_PREFIX);
}

export interface P2pExecutionMarkerSpec {
  runId: string;
  cycleIndex: number;
  cycleTotal: number;
  nonce: string;
}

export interface P2pExecutionMarker extends P2pExecutionMarkerSpec {
  schemaVersion: typeof P2P_EXECUTION_MARKER_SCHEMA_VERSION;
  status: P2pExecutionMarkerStatus;
  summary?: string;
  changedFiles?: string[];
  tests?: string[];
  error?: string;
  completedAt?: string;
}

export type P2pExecutionMarkerValidation =
  | { ok: true; marker: P2pExecutionMarker }
  | { ok: false; reason: string; marker?: Partial<P2pExecutionMarker>; failedByAgent?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === 'string') ? [...value] : undefined;
}

export function buildP2pExecutionMarker(spec: P2pExecutionMarkerSpec, status: P2pExecutionMarkerStatus): P2pExecutionMarker {
  return {
    schemaVersion: P2P_EXECUTION_MARKER_SCHEMA_VERSION,
    runId: spec.runId,
    cycleIndex: spec.cycleIndex,
    cycleTotal: spec.cycleTotal,
    nonce: spec.nonce,
    status,
  };
}

export function stringifyP2pExecutionMarker(marker: P2pExecutionMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

export function validateP2pExecutionMarkerContent(content: string, spec: P2pExecutionMarkerSpec): P2pExecutionMarkerValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'not_object' };

  const status = parsed.status;
  const partial: Partial<P2pExecutionMarker> = {
    schemaVersion: parsed.schemaVersion as typeof P2P_EXECUTION_MARKER_SCHEMA_VERSION,
    runId: optionalString(parsed.runId) ?? '',
    cycleIndex: typeof parsed.cycleIndex === 'number' ? parsed.cycleIndex : 0,
    cycleTotal: typeof parsed.cycleTotal === 'number' ? parsed.cycleTotal : 0,
    nonce: optionalString(parsed.nonce) ?? '',
    status: status === 'completed' || status === 'failed' ? status : undefined,
    summary: optionalString(parsed.summary),
    changedFiles: optionalStringArray(parsed.changedFiles),
    tests: optionalStringArray(parsed.tests),
    error: optionalString(parsed.error),
    completedAt: optionalString(parsed.completedAt),
  };

  if (parsed.schemaVersion !== P2P_EXECUTION_MARKER_SCHEMA_VERSION) {
    return { ok: false, reason: 'schema_version_mismatch', marker: partial };
  }
  if (parsed.runId !== spec.runId) return { ok: false, reason: 'run_id_mismatch', marker: partial };
  if (parsed.cycleIndex !== spec.cycleIndex) return { ok: false, reason: 'cycle_index_mismatch', marker: partial };
  if (parsed.cycleTotal !== spec.cycleTotal) return { ok: false, reason: 'cycle_total_mismatch', marker: partial };
  if (parsed.nonce !== spec.nonce) return { ok: false, reason: 'nonce_mismatch', marker: partial };
  if (status !== 'completed' && status !== 'failed') return { ok: false, reason: 'status_mismatch', marker: partial };
  if (parsed.changedFiles !== undefined && partial.changedFiles === undefined) {
    return { ok: false, reason: 'changed_files_invalid', marker: partial };
  }
  if (parsed.tests !== undefined && partial.tests === undefined) {
    return { ok: false, reason: 'tests_invalid', marker: partial };
  }

  const marker: P2pExecutionMarker = {
    schemaVersion: P2P_EXECUTION_MARKER_SCHEMA_VERSION,
    runId: spec.runId,
    cycleIndex: spec.cycleIndex,
    cycleTotal: spec.cycleTotal,
    nonce: spec.nonce,
    status,
    ...(partial.summary !== undefined ? { summary: partial.summary } : {}),
    ...(partial.changedFiles !== undefined ? { changedFiles: partial.changedFiles } : {}),
    ...(partial.tests !== undefined ? { tests: partial.tests } : {}),
    ...(partial.error !== undefined ? { error: partial.error } : {}),
    ...(partial.completedAt !== undefined ? { completedAt: partial.completedAt } : {}),
  };

  if (status === 'failed') {
    return { ok: false, reason: marker.error ?? marker.summary ?? 'agent_reported_failure', marker, failedByAgent: true };
  }
  return { ok: true, marker };
}
