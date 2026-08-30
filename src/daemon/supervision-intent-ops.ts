/**
 * MCP intent operations for the supervision registry.
 *
 * Models invoke INTENTS ("I am starting", "I am opening an audit"). They never
 * submit a lifecycle status: the daemon owns the transition table, so an
 * arbitrary or misspelled status string is not merely rejected, it is
 * unexpressible in the tool schema. Every published schema uses a JSON `enum`
 * drawn from the same constants the transition table uses, so the wire contract
 * and the state machine cannot drift.
 */
import {
  isSupervisionTaskLifecycleStatus,
  SUPERVISION_TASK_LIFECYCLE_STATUSES,
  SUPERVISION_TASK_RECOVERY_TARGET_STATUSES,
  type SupervisionTaskLifecycleStatus,
} from '../../shared/supervision-config.js';
import {
  SUPERVISION_CONSOLE_VALIDATION_STATES,
  type SupervisionConsoleValidationState,
} from '../../shared/supervision-task-console.js';

export const SUPERVISION_INTENTS = [
  'start', 'claim', 'heartbeat', 'record_validation',
  'open_audit', 'checkpoint', 'finish', 'cancel',
] as const;
export type SupervisionIntent = typeof SUPERVISION_INTENTS[number];

/**
 * Daemon-owned structured integration finalization path. A generic `finish`
 * intent cannot traverse this chain; supervision_task_finish must first pass
 * the exact audit/manifest/Git/CI gate and then persists every edge atomically.
 */
export const SUPERVISION_INTEGRATION_FINALIZATION_STATUS_PATH = [
  'ready_for_integration', 'integrating', 'final_audit', 'passed',
  'finalizing', 'committed', 'pushed', 'finalized',
] as const satisfies readonly SupervisionTaskLifecycleStatus[];

/**
 * Allowed source statuses and the resulting status per intent.
 *
 * `to: null` means the intent records information without moving the lifecycle
 * (heartbeat, validation, checkpoint). Keeping those in the same table means a
 * reader can see the full set of things a model can ask for in one place.
 */
export const SUPERVISION_INTENT_TRANSITIONS: Readonly<Record<SupervisionIntent, {
  from: readonly SupervisionTaskLifecycleStatus[];
  to: SupervisionTaskLifecycleStatus | null;
}>> = Object.freeze({
  start: { from: ['planned', 'delegated', 'rework'], to: 'implementing' },
  claim: { from: ['planned', 'delegated'], to: 'implementing' },
  heartbeat: { from: [...SUPERVISION_TASK_LIFECYCLE_STATUSES], to: null },
  // A passed validation is a lifecycle edge, not merely an annotation. The
  // resolver keeps failed/unavailable observations non-advancing below.
  record_validation: { from: ['implementing', 'retrying_external_ci', 'rework'], to: 'validated' },
  open_audit: { from: ['implementing', 'validated'], to: 'ready_for_audit' },
  checkpoint: { from: [...SUPERVISION_TASK_LIFECYCLE_STATUSES], to: null },
  finish: { from: ['integrating', 'finalizing', 'committed', 'pushed'], to: 'finalized' },
  cancel: {
    from: SUPERVISION_TASK_LIFECYCLE_STATUSES.filter(
      // Repeated cancel is an idempotent cleanup request. This matters for
      // durable registries upgraded from versions that marked the task
      // cancelled but left assignment leases and file claims behind.
      (status) => !['finalized', 'pushed'].includes(status),
    ),
    to: 'cancelled',
  },
});

export type SupervisionIntentRefusal =
  | 'unknown_intent'
  | 'unknown_task'
  | 'illegal_transition'
  | 'invalid_validation_state'
  | 'model_supplied_status';

export interface SupervisionIntentRequest {
  intent: string;
  taskId: string;
  assignmentId?: string;
  /** Only for record_validation; must be a fixed enum member. */
  validationState?: string;
  note?: string;
  /**
   * Present ONLY to be rejected. A model that tries to set a raw status is a
   * contract violation worth surfacing loudly rather than silently ignoring.
   */
  status?: unknown;
}

export interface SupervisionIntentOutcome {
  ok: boolean;
  intent?: SupervisionIntent;
  fromStatus?: SupervisionTaskLifecycleStatus;
  toStatus?: SupervisionTaskLifecycleStatus | null;
  validationState?: SupervisionConsoleValidationState;
  refusal?: SupervisionIntentRefusal;
  detail?: string;
}

export function isSupervisionIntent(value: unknown): value is SupervisionIntent {
  return typeof value === 'string' && (SUPERVISION_INTENTS as readonly string[]).includes(value);
}

/**
 * Resolve an intent against the current durable status.
 *
 * Pure: the caller persists the outcome transactionally. Refuses before
 * anything else if the request carries a status field at all.
 */
export function resolveSupervisionIntent(input: {
  request: SupervisionIntentRequest;
  currentStatus: string | undefined;
}): SupervisionIntentOutcome {
  const { request } = input;
  // Checked first: a caller that supplies a status is not to be partially
  // honoured, even if the rest of the request would have been legal.
  if (request.status !== undefined) {
    return { ok: false, refusal: 'model_supplied_status', detail: 'Lifecycle status is daemon-owned; send an intent instead.' };
  }
  if (!isSupervisionIntent(request.intent)) {
    return { ok: false, refusal: 'unknown_intent', detail: `Unknown intent ${String(request.intent)}.` };
  }
  const current = input.currentStatus;
  if (!current || !isSupervisionTaskLifecycleStatus(current)) {
    return { ok: false, refusal: 'unknown_task', detail: 'Task has no known durable status.' };
  }
  const rule = SUPERVISION_INTENT_TRANSITIONS[request.intent];
  if (!rule.from.includes(current)) {
    return {
      ok: false, refusal: 'illegal_transition', intent: request.intent, fromStatus: current,
      detail: `Intent ${request.intent} is not legal from ${current}.`,
    };
  }
  if (request.intent === 'record_validation') {
    const state = request.validationState;
    if (typeof state !== 'string'
      || !(SUPERVISION_CONSOLE_VALIDATION_STATES as readonly string[]).includes(state)) {
      return { ok: false, refusal: 'invalid_validation_state', intent: request.intent, fromStatus: current };
    }
    return {
      ok: true, intent: request.intent, fromStatus: current,
      toStatus: state === 'passed' ? rule.to : null,
      validationState: state as SupervisionConsoleValidationState,
    };
  }
  return { ok: true, intent: request.intent, fromStatus: current, toStatus: rule.to };
}

/**
 * Published MCP tool schemas.
 *
 * Enums are derived from the same constants the transition table uses, so a new
 * status or validation state cannot appear in one without the other.
 */
export const SUPERVISION_MCP_TOOL_SCHEMAS = Object.freeze({
  supervision_task_intent: {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'taskId'],
    properties: {
      intent: { type: 'string', enum: [...SUPERVISION_INTENTS] },
      taskId: { type: 'string' },
      assignmentId: { type: 'string' },
      validationState: { type: 'string', enum: [...SUPERVISION_CONSOLE_VALIDATION_STATES] },
      note: { type: 'string' },
    },
  },
  supervision_task_list: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: [...SUPERVISION_TASK_LIFECYCLE_STATUSES] },
      topLevelTaskId: { type: 'string' },
      ownerSessionName: { type: 'string' },
      includeArchived: { type: 'boolean' },
      history: { type: 'boolean' },
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  supervision_task_get: {
    type: 'object', additionalProperties: false, required: ['taskId'],
    properties: { taskId: { type: 'string' } },
  },
  supervision_task_recover: {
    type: 'object', additionalProperties: false,
    properties: {
      taskId: { type: 'string' },
      toStatus: { type: 'string', enum: [...SUPERVISION_TASK_RECOVERY_TARGET_STATUSES] },
      assignmentId: { type: 'string' },
      rebindSessionName: { type: 'string' },
      reason: { type: 'string' },
    },
  },
  supervision_task_housekeeping: {
    type: 'object', additionalProperties: false, required: ['mode'],
    properties: {
      mode: { type: 'string', enum: ['dryRun', 'apply'] },
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
} as const);

/** Every schema that accepts a status must expose it as a closed enum. */
export function supervisionSchemaStatusEnums(): string[][] {
  const found: string[][] = [];
  const visit = (node: unknown, key?: string): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.enum) && ['intent', 'status', 'validationState', 'toStatus'].includes(key ?? '')) {
      found.push(record.enum.map(String));
    }
    for (const [childKey, value] of Object.entries(record)) visit(value, childKey);
  };
  visit(SUPERVISION_MCP_TOOL_SCHEMAS);
  return found;
}
