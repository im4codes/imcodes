/**
 * Intent-only compatibility shims for the legacy supervision tools.
 *
 * Product contract: the model-facing MCP must never choose a lifecycle status.
 * The legacy supervision_task_update / _finish tools accept one today. Rather
 * than delete two working, authorized, transition-checked tools, these pure
 * mappers convert their surviving arguments into a fixed semantic INTENT, so
 * the destination status is derived by the state machine instead of chosen by
 * the caller.
 *
 * IMPORTANT SCOPE NOTE: this is not a security fix. The underlying registry
 * already enforces owner identity (`owner_mismatch`) and the transition table
 * (`invalid_transition`) — verified empirically, see the pinning tests. This
 * removes DESTINATION AUTHORITY from the model, which is an architecture
 * requirement, not a hole being closed.
 *
 * Pure and I/O-free so it can be written and proven now, while the frozen
 * memory-mcp-tools.ts that will call it is still held by another audit.
 */
import { SUPERVISION_MCP_FORBIDDEN_ARG_NAMES } from '../../shared/supervision-mcp-tools.js';
import { SUPERVISION_CONSOLE_VALIDATION_STATES } from '../../shared/supervision-task-console.js';
import type { SupervisionIntent } from './supervision-intent-ops.js';

/** Non-lifecycle metadata the legacy update tool may still carry. */
export const SUPERVISION_COMPAT_UPDATE_FIELDS: readonly string[] = Object.freeze([
  'assignmentId', 'revision', 'auditAttemptId', 'auditRevision', 'verdict',
  'blocker', 'externalRunId', 'externalHeadSha', 'externalTaskId', 'validationState',
]);

export const SUPERVISION_COMPAT_FINISH_FIELDS: readonly string[] = Object.freeze([
  'assignmentId', 'revision', 'evidence',
]);

export type SupervisionCompatRefusal =
  | 'model_supplied_status'
  | 'missing_assignment'
  | 'unsupported_field'
  | 'invalid_validation_state';

export interface SupervisionCompatMapping {
  ok: true;
  intent: SupervisionIntent;
  assignmentId: string;
  /** Non-lifecycle passthrough; never contains a status. */
  metadata: Record<string, string>;
  validationState?: string;
}

export interface SupervisionCompatRefused {
  ok: false;
  reason: SupervisionCompatRefusal;
  detail: string;
}

export type SupervisionCompatResult = SupervisionCompatMapping | SupervisionCompatRefused;

function findForbidden(args: Record<string, unknown>): string | undefined {
  return SUPERVISION_MCP_FORBIDDEN_ARG_NAMES.find((name) => args[name] !== undefined);
}

function collect(args: Record<string, unknown>, allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowed) {
    if (key === 'assignmentId' || key === 'validationState') continue;
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Map a legacy update call to an intent.
 *
 * `record_validation` when the caller reported a validation outcome, otherwise
 * `heartbeat` — neither of which moves the lifecycle to a caller-named status.
 * A lifecycle field is refused FIRST, before any other validation, so a caller
 * cannot learn anything about the rest of its payload by smuggling one in.
 */
export function mapLegacySupervisionUpdate(input: unknown): SupervisionCompatResult {
  const args = (input ?? {}) as Record<string, unknown>;
  const forbidden = findForbidden(args);
  if (forbidden) {
    return {
      ok: false, reason: 'model_supplied_status',
      detail: `field '${forbidden}' is daemon-owned; send a semantic intent instead`,
    };
  }
  const assignmentId = typeof args.assignmentId === 'string' ? args.assignmentId.trim() : '';
  if (!assignmentId) return { ok: false, reason: 'missing_assignment', detail: 'assignmentId is required' };

  const validationState = args.validationState;
  if (validationState !== undefined) {
    if (typeof validationState !== 'string'
      || !(SUPERVISION_CONSOLE_VALIDATION_STATES as readonly string[]).includes(validationState)) {
      return { ok: false, reason: 'invalid_validation_state', detail: 'validationState must be a fixed enum member' };
    }
    return {
      ok: true, intent: 'record_validation', assignmentId,
      metadata: collect(args, SUPERVISION_COMPAT_UPDATE_FIELDS), validationState,
    };
  }
  return {
    ok: true, intent: 'heartbeat', assignmentId,
    metadata: collect(args, SUPERVISION_COMPAT_UPDATE_FIELDS),
  };
}

/**
 * Map a legacy finish call to the fixed `finish` intent.
 *
 * The destination is whatever the transition table says `finish` leads to; the
 * caller cannot name it. That is the whole point of the shim.
 */
export function mapLegacySupervisionFinish(input: unknown): SupervisionCompatResult {
  const args = (input ?? {}) as Record<string, unknown>;
  const forbidden = findForbidden(args);
  if (forbidden) {
    return {
      ok: false, reason: 'model_supplied_status',
      detail: `field '${forbidden}' is daemon-owned; finish derives its own destination`,
    };
  }
  const assignmentId = typeof args.assignmentId === 'string' ? args.assignmentId.trim() : '';
  if (!assignmentId) return { ok: false, reason: 'missing_assignment', detail: 'assignmentId is required' };
  return {
    ok: true, intent: 'finish', assignmentId,
    metadata: collect(args, SUPERVISION_COMPAT_FINISH_FIELDS),
  };
}

/** Published shapes for the shimmed tools: no lifecycle field is declarable. */
export const SUPERVISION_COMPAT_PUBLISHED_FIELDS = Object.freeze({
  update: SUPERVISION_COMPAT_UPDATE_FIELDS,
  finish: SUPERVISION_COMPAT_FINISH_FIELDS,
});
