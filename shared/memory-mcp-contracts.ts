import { MCP_ERROR_REASONS, isRecoverableMcpErrorReason, type MCPErrorReason } from './memory-mcp-errors.js';
import { MEMORY_FEATURE_FLAGS_BY_NAME } from './feature-flags.js';
import { MCP_FEATURE_FLAGS_BY_NAME } from './memory-mcp-feature-flags.js';
import { MEMORY_MCP_SOURCE_FIELDS } from './memory-mcp-provenance.js';
import { PREFERENCE_MAX_BYTES } from './preference-ingest.js';
import { EXECUTION_CLONE_KIND, EXECUTION_CLONE_PARENT_STAGES } from './execution-clone.js';
import {
  NODE_ROLE,
  ENROLLMENT_OSES,
  type NodeRole,
  REMOTE_EXEC_SHELLS,
  REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
  REMOTE_EXEC_MIN_TIMEOUT_MS,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
  REMOTE_EXEC_MAX_COMMAND_BYTES,
  REMOTE_EXEC_OUTCOMES,
  MACHINE_LIST_MAX_ITEMS,
} from './remote-exec.js';
import {
  COMPUTER_USE_DOC_TOPICS,
  COMPUTER_USE_DRAG_DURATION_MAX_MS,
  COMPUTER_USE_DRAG_DURATION_MIN_MS,
  COMPUTER_USE_MAX_ARGUMENT_BYTES,
  COMPUTER_USE_MAX_TIMEOUT_MS,
  COMPUTER_USE_MIN_TIMEOUT_MS,
  COMPUTER_USE_SHELL_SESSION1_MAX_TIMEOUT_MS,
  COMPUTER_USE_OUTCOMES,
  COMPUTER_USE_TOOLS,
} from './computer-use.js';
import { FILE_TRANSFER_LIMITS, FILE_TRANSFER_PATH_MAX_BYTES } from './transport/file-transfer.js';
import {
  MACHINE_NAME_PATTERN,
  MACHINE_REF_NAME_MAX,
  MACHINE_TARGET_MAX,
  MACHINE_TARGET_PATTERN,
} from './machine-reference.js';
import {
  PEER_AUDIT_FINDINGS_BYTES,
  PEER_AUDIT_VALIDATION_COUNT,
  PEER_AUDIT_VALIDATION_ITEM_BYTES,
  PEER_AUDIT_VALIDATION_KINDS,
  PEER_AUDIT_VALIDATION_OUTCOMES,
} from './peer-audit.js';

export const MEMORY_MCP_TOOL_NAMES = {
  SEARCH_MEMORY: 'search_memory',
  LIST_MEMORY_SUMMARIES: 'list_memory_summaries',
  GET_MEMORY_SOURCES: 'get_memory_sources',
  ARCHIVE_MEMORY: 'archive_memory',
  RESTORE_MEMORY: 'restore_memory',
  DELETE_MEMORY: 'delete_memory',
  UPDATE_MEMORY: 'update_memory',
  MEMORY_FEEDBACK: 'memory_feedback',
  SAVE_OBSERVATION: 'save_observation',
  SAVE_PREFERENCE: 'save_preference',
  PEER_AUDIT_REPLY: 'peer_audit_reply',
  SEND_LIST_TARGETS: 'send_list_targets',
  SEND_MESSAGE: 'send_message',
  SEND_STOP: 'send_stop',
  DESTROY_EXECUTION_CLONE: 'destroy_execution_clone',
  CRON_CREATE_SELF: 'cron_create_self',
  CRON_UPDATE_SELF: 'cron_update_self',
  CRON_CANCEL_SELF: 'cron_cancel_self',
  CRON_CREATE: 'cron_create',
  CRON_LIST: 'cron_list',
  CRON_UPDATE: 'cron_update',
  CRON_DELETE: 'cron_delete',
  // Machine remote-exec surface — FULL-only (see FULL_ONLY_MCP_TOOLS).
  LIST_MACHINES: 'list_machines',
  EXEC_REMOTE: 'exec_remote',
  SEND_FILE_TO_MACHINE: 'send_file_to_machine',
  FETCH_FILE_FROM_MACHINE: 'fetch_file_from_machine',
  COMPUTER_USE_DOCS: 'computer_use_docs',
  COMPUTER_USE_CALL: 'computer_use_call',
} as const;

export type MemoryMcpToolName = (typeof MEMORY_MCP_TOOL_NAMES)[keyof typeof MEMORY_MCP_TOOL_NAMES];

export const MEMORY_MCP_TOOL_NAME_LIST = [
  MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY,
  MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES,
  MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
  MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY,
  MEMORY_MCP_TOOL_NAMES.RESTORE_MEMORY,
  MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY,
  MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY,
  MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK,
  MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION,
  MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE,
  MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY,
  MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS,
  MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
  MEMORY_MCP_TOOL_NAMES.SEND_STOP,
  MEMORY_MCP_TOOL_NAMES.DESTROY_EXECUTION_CLONE,
  MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF,
  MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF,
  MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF,
  MEMORY_MCP_TOOL_NAMES.CRON_CREATE,
  MEMORY_MCP_TOOL_NAMES.CRON_LIST,
  MEMORY_MCP_TOOL_NAMES.CRON_UPDATE,
  MEMORY_MCP_TOOL_NAMES.CRON_DELETE,
  MEMORY_MCP_TOOL_NAMES.LIST_MACHINES,
  MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE,
  MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE,
  MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE,
  MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS,
  MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL,
] as const satisfies readonly MemoryMcpToolName[];

/**
 * Tools available ONLY to FULL nodes. A controlled node never advertises these
 * (and structurally never even starts the memory MCP server) — the explicit gate
 * here is the shared role check the spec requires (10.12).
 */
export const FULL_ONLY_MCP_TOOLS: ReadonlySet<MemoryMcpToolName> = new Set([
  MEMORY_MCP_TOOL_NAMES.LIST_MACHINES,
  MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE,
  MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE,
  MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE,
  MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS,
  MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL,
]);

/** Whether a tool is available to a node of the given role. */
export function isToolAvailableForRole(name: MemoryMcpToolName, role: NodeRole): boolean {
  if (role === NODE_ROLE.CONTROLLED && FULL_ONLY_MCP_TOOLS.has(name)) return false;
  return true;
}

/** The advertised tool-name list for a node of the given role (controlled excludes FULL-only tools). */
export function advertisedMcpToolNames(role: NodeRole): readonly MemoryMcpToolName[] {
  return MEMORY_MCP_TOOL_NAME_LIST.filter((name) => isToolAvailableForRole(name, role));
}

export const MEMORY_MCP_CAPS = {
  SEARCH_MEMORY_DEFAULT_LIMIT: 20,
  SEARCH_MEMORY_MAX_LIMIT: 100,
  LIST_MEMORY_SUMMARIES_DEFAULT_LIMIT: 20,
  LIST_MEMORY_SUMMARIES_MAX_LIMIT: 100,
  OBSERVATION_CONTENT_MAX_BYTES: 16 * 1024,
  OBSERVATION_TAGS_MAX_COUNT: 8,
  OBSERVATION_TAG_MAX_CHARS: 64,
  PREFERENCE_MAX_BYTES,
  SEND_MESSAGE_IDEMPOTENCY_WINDOW_MS: 5_000,
  SEND_MESSAGE_MAX_BYTES: 64 * 1024,
  SEND_FILES_MAX_COUNT: 32,
  SEND_FILE_PATH_MAX_CHARS: 512,
  CRON_MIN_INTERVAL_MINUTES: 5,
  CRON_EXPIRES_AT_MAX_DAYS: 90,
  CRON_LIST_MAX_LIMIT: 100,
} as const;

export const MEMORY_MCP_DISABLED_FLAGS = {
  MEMORY_SURFACE: MCP_FEATURE_FLAGS_BY_NAME.memorySurface,
  QUICK_SEARCH: MEMORY_FEATURE_FLAGS_BY_NAME.quickSearch,
  OBSERVATION_STORE: MEMORY_FEATURE_FLAGS_BY_NAME.observationStore,
  PREFERENCES: MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
  SEND_DISPATCH: MCP_FEATURE_FLAGS_BY_NAME.sendDispatch,
  CRON_READ: MCP_FEATURE_FLAGS_BY_NAME.cronRead,
  CRON_WRITE: MCP_FEATURE_FLAGS_BY_NAME.cronWrite,
} as const;

export type MemoryMcpDisabledFlag = (typeof MEMORY_MCP_DISABLED_FLAGS)[keyof typeof MEMORY_MCP_DISABLED_FLAGS];

export const MEMORY_MCP_FORBIDDEN_ARG_NAMES = [
  'userId',
  'namespace',
  'projectId',
  'canonicalRepoId',
  'workspaceId',
  'orgId',
  'path',
  'actorId',
  'fingerprint',
  'state',
  'origin',
  'scope',
  'serverId',
  'sessionName',
  'projectRoot',
  MEMORY_MCP_SOURCE_FIELDS.SOURCE_SESSION_NAME,
  MEMORY_MCP_SOURCE_FIELDS.SOURCE_PROJECT_NAME,
  MEMORY_MCP_SOURCE_FIELDS.SOURCE_SERVER_ID,
  'token',
] as const;

export type MemoryMcpForbiddenArgName = (typeof MEMORY_MCP_FORBIDDEN_ARG_NAMES)[number];

const FORBIDDEN_ARG_SET: ReadonlySet<string> = new Set(MEMORY_MCP_FORBIDDEN_ARG_NAMES);

type JsonSchema = {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly enum?: readonly unknown[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly maxItems?: number;
  readonly anyOf?: readonly JsonSchema[];
};

export interface MemoryMcpToolContract {
  name: MemoryMcpToolName;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

const stringSchema = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: 'string',
  description,
  ...extra,
});

const numberSchema = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: 'number',
  description,
  ...extra,
});

const booleanSchema = (description: string): JsonSchema => ({
  type: 'boolean',
  description,
});

const objectSchema = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

const statusSchema = objectSchema({
  status: stringSchema('Machine status for the tool result.'),
});

export const MEMORY_MCP_TOOL_CONTRACTS: Readonly<Record<MemoryMcpToolName, MemoryMcpToolContract>> = {
  [MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]: {
    name: MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY,
    description: 'Search caller-bound memory when prior project or user context may matter. Returns compact hits with a typed sourceLookup; call get_memory_sources with those fields when a relevant summary is insufficient. The query is text; vectorization is internal.',
    inputSchema: objectSchema({
      query: stringSchema('Required text query to search for. Do not send embeddings, vectors, identity, or namespace fields.'),
      limit: numberSchema(`Optional maximum hit count; defaults to ${MEMORY_MCP_CAPS.SEARCH_MEMORY_DEFAULT_LIMIT} and is clamped to ${MEMORY_MCP_CAPS.SEARCH_MEMORY_MAX_LIMIT}.`, { minimum: 1, maximum: MEMORY_MCP_CAPS.SEARCH_MEMORY_MAX_LIMIT }),
    }, ['query']),
    outputSchema: objectSchema({
      status: stringSchema('ok, disabled, or error.'),
      reason: stringSchema('Optional machine-readable reason when an empty result is caused by project scoping, policy, or feature availability.'),
      items: { type: 'array', description: 'Compact same-namespace memory hits. Each item includes ref plus sourceLookup: { tool: "get_memory_sources", kind, projectionId | observationId } for exact source expansion.', items: { type: 'object', additionalProperties: true } },
    }),
  },
  [MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES]: {
    name: MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES,
    description: 'List recent caller-project memory summaries without a query. Each item includes a compact ref and sourceLookup for optional get_memory_sources expansion.',
    inputSchema: objectSchema({
      projectionClass: { type: 'string', enum: ['recent_summary', 'durable_memory_candidate'], description: 'Optional processed memory class to list. Defaults to recent_summary for the newest task summaries; durable_memory_candidate lists promoted durable facts.' },
      limit: numberSchema(`Optional maximum summary count; defaults to ${MEMORY_MCP_CAPS.LIST_MEMORY_SUMMARIES_DEFAULT_LIMIT} and is clamped to ${MEMORY_MCP_CAPS.LIST_MEMORY_SUMMARIES_MAX_LIMIT}.`, { minimum: 1, maximum: MEMORY_MCP_CAPS.LIST_MEMORY_SUMMARIES_MAX_LIMIT }),
    }),
    outputSchema: objectSchema({
      status: stringSchema('ok, disabled, or error.'),
      reason: stringSchema('Optional machine-readable reason when an empty result is caused by project scoping, policy, or feature availability.'),
      items: { type: 'array', description: 'Newest compact processed memory summaries. Each item includes ref plus sourceLookup: { tool: "get_memory_sources", kind: "projection", projectionId } for exact source expansion.', items: { type: 'object', additionalProperties: true } },
    }),
  },
  [MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]: {
    name: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
    description: 'Fetch source snippets by projection id, observation id, or compact ref. Use it after search_memory or startup memory for exact prior facts and provenance-sensitive answers. Missing and cross-namespace ids return the same empty list.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Projection id from search_memory.sourceLookup for projection hits. Caller identity and namespace are runtime-bound.'),
      observationId: stringSchema('Observation id from search_memory.sourceLookup for observation hits. Caller identity and namespace are runtime-bound.'),
      ref: stringSchema('Compact ref shown in search_memory results or startup memory, such as obs:abc123 or proj:abc123. It resolves after the ref was observed by this daemon and is cached locally across daemon restarts.'),
      kind: { type: 'string', enum: ['projection', 'observation'], description: 'Optional lookup kind copied from sourceLookup; provide exactly one matching id.' },
    }),
    outputSchema: objectSchema({
      projectionId: stringSchema('Requested projection id when expanding a projection hit.'),
      observationId: stringSchema('Requested observation id when expanding an observation hit.'),
      sources: { type: 'array', description: 'Source snippets visible to the caller namespace.', items: { type: 'object', additionalProperties: true } },
      projectionSource: { type: 'object', description: 'Processed projection summary snippet, included when available so callers can cite compacted memories even when raw source events are unavailable or less informative.', additionalProperties: true },
    }),
  },
  [MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY]: {
    name: MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY,
    description: 'Archive a caller-project projection so search, recall, and startup context omit it. Identity and scope are runtime-bound; pass its projectionId or proj: ref.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Projection id from search_memory/list_memory_summaries for the memory to archive. Caller identity and namespace are runtime-bound.'),
      ref: stringSchema('Optional compact projection ref such as proj:abc123 returned by search_memory/list_memory_summaries. Do not combine with projectionId.'),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.RESTORE_MEMORY]: {
    name: MEMORY_MCP_TOOL_NAMES.RESTORE_MEMORY,
    description: 'Restore an archived caller-project projection to search, recall, and startup context. Identity and scope are runtime-bound; pass its projectionId or proj: ref.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Projection id for the archived memory to restore. Caller identity and namespace are runtime-bound.'),
      ref: stringSchema('Optional compact projection ref such as proj:abc123. Do not combine with projectionId.'),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY]: {
    name: MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY,
    description: 'Permanently delete a caller-project projection. Prefer archive_memory merely to hide it from recall. Identity and scope are runtime-bound; pass its projectionId or proj: ref.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Projection id for the memory to permanently delete. Caller identity and namespace are runtime-bound.'),
      ref: stringSchema('Optional compact projection ref such as proj:abc123. Do not combine with projectionId.'),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY]: {
    name: MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY,
    description: 'Correct a caller-project projection summary; identity, scope, owner, and project are runtime-bound and unchanged.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Projection id for the memory to update. Caller identity and namespace are runtime-bound.'),
      ref: stringSchema('Optional compact projection ref such as proj:abc123. Do not combine with projectionId.'),
      text: stringSchema('Replacement memory summary text. Must be non-empty after trimming.'),
    }, ['text']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK]: {
    name: MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK,
    description: 'Record projection relevance. not_relevant archives it from future recall; relevant strengthens ranking. Identity and scope are runtime-bound.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Projection id for the memory receiving feedback. Caller identity and namespace are runtime-bound.'),
      ref: stringSchema('Optional compact projection ref such as proj:abc123. Do not combine with projectionId.'),
      feedback: { type: 'string', enum: ['not_relevant', 'relevant'], description: 'Use not_relevant to stop future recall/search by archiving the memory; use relevant to strengthen ranking through hit-count metadata.' },
      reason: stringSchema('Optional short human-readable reason for audit/debug context. It is not used for identity or authorization.'),
    }, ['feedback']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION]: {
    name: MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION,
    description: 'Save a durable learned fact or decision as candidate private memory. Returns its id and fingerprint; identity, scope, state, origin, and fingerprint are runtime-bound.',
    inputSchema: objectSchema({
      content: stringSchema(`Required observation text, up to ${MEMORY_MCP_CAPS.OBSERVATION_CONTENT_MAX_BYTES} UTF-8 bytes.`),
      tags: { type: 'array', description: `Optional short tags; at most ${MEMORY_MCP_CAPS.OBSERVATION_TAGS_MAX_COUNT}, each at most ${MEMORY_MCP_CAPS.OBSERVATION_TAG_MAX_CHARS} characters.`, items: stringSchema('One caller-supplied tag label.', { maxLength: MEMORY_MCP_CAPS.OBSERVATION_TAG_MAX_CHARS }), maxItems: MEMORY_MCP_CAPS.OBSERVATION_TAGS_MAX_COUNT },
      turnId: stringSchema('Optional source turn or event id to associate with the observation.'),
      idempotencyKey: stringSchema('Optional caller-stable key for safe retries of the same observation.'),
    }, ['content']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE]: {
    name: MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE,
    description: 'Save a stable user instruction or preference as active private preference memory; no text-prefix parsing.',
    inputSchema: objectSchema({
      text: stringSchema(`Required preference text, up to ${MEMORY_MCP_CAPS.PREFERENCE_MAX_BYTES} UTF-8 bytes.`),
      idempotencyKey: stringSchema('Optional caller-stable key for safe retries of the same preference.'),
    }, ['text']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY]: {
    name: MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY,
    description: 'Preferred structured reply for the active lightweight peer audit. Use only when the audit brief supplies an attempt id and one-time capability. This submits directly to daemon ingress; it never sends chat text or terminal keys.',
    inputSchema: objectSchema({
      attemptId: stringSchema('Opaque attempt id supplied by the peer-audit brief.'),
      replyCapability: stringSchema('One-time reply capability supplied by the peer-audit brief. Never repeat it in findings.'),
      verdict: { type: 'string', enum: ['PASS', 'REWORK'], description: 'PASS only with applicable executable validation evidence; otherwise REWORK.' },
      findings: stringSchema(`Concrete findings, at most ${PEER_AUDIT_FINDINGS_BYTES} UTF-8 bytes.`),
      validations: {
        type: 'array',
        maxItems: PEER_AUDIT_VALIDATION_COUNT,
        description: 'Bounded non-destructive validation evidence. PASS requires at least one passed item, or all applicable checks explicitly unavailable.',
        items: objectSchema({
          kind: { type: 'string', enum: [...PEER_AUDIT_VALIDATION_KINDS] },
          label: stringSchema(`Validation label, at most ${PEER_AUDIT_VALIDATION_ITEM_BYTES} UTF-8 bytes.`),
          outcome: { type: 'string', enum: [...PEER_AUDIT_VALIDATION_OUTCOMES] },
          summary: stringSchema(`Exact bounded outcome/unavailability reason, at most ${PEER_AUDIT_VALIDATION_ITEM_BYTES} UTF-8 bytes.`),
        }, ['kind', 'label', 'outcome', 'summary']),
      },
    }, ['attemptId', 'replyCapability', 'verdict', 'findings', 'validations']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]: {
    name: MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS,
    description: 'List sendable caller-project siblings for delegation, for example "ask CC to audit" or "invite a reviewer to discuss". The current caller session and stopped sessions are excluded; if this returns no items, send_message cannot run. Filter by display label or name, then use the exact target; labels are not targets. If no match exists, report that no such running peer session is available.',
    inputSchema: objectSchema({
      query: stringSchema('Optional case-insensitive text filter over target display labels and names, such as "cc", "codex", "reviewer", or a session label mentioned by the user.'),
      limit: numberSchema('Optional maximum number of targets to return; implementations may clamp it.'),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]: {
    name: MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
    description: 'Send a plain-text request to an exact send_list_targets target, for example asking a CC session to audit. The caller session is not a valid target; an empty send_list_targets result means none exists. It does not start a structured Team/P2P discussion run. Files are project-root path references, not bytes. Returns dispatch/message ids and delivery status.',
    inputSchema: objectSchema({
      target: stringSchema('Required exact target session value. For an ordinary peer, use the exact send_list_targets.target value. For a follow-up to an execution clone you created, use the exact result.clone.target from the originating clone send — execution clones are NOT returned by send_list_targets and only their creator may address them. Always use the exact target name; never a label or agentType value.'),
      message: stringSchema(`Required complete task/request text to deliver, up to ${MEMORY_MCP_CAPS.SEND_MESSAGE_MAX_BYTES} UTF-8 bytes. Include the desired role and output, such as audit findings, discussion input, plan, implementation request, or verification result.`),
      files: {
        type: 'array',
        description: `Optional file path references under the caller project root; at most ${MEMORY_MCP_CAPS.SEND_FILES_MAX_COUNT}; contents are not read or transferred by MCP.`,
        items: stringSchema(`Relative path or in-root absolute path reference, at most ${MEMORY_MCP_CAPS.SEND_FILE_PATH_MAX_CHARS} characters and without control characters.`),
        maxItems: MEMORY_MCP_CAPS.SEND_FILES_MAX_COUNT,
      },
      reply: booleanSchema('Optional request for the target to reply to the runtime-bound caller session. Set true when you expect the target to respond or report back, such as audit/review requests or discussion invites; leave false for fire-and-forget notifications. The response is delivered later as a normal incoming message, so do not poll session state, logs, transcripts, or the target after a reply-enabled send.'),
      broadcast: booleanSchema('Optional project-scoped broadcast request; unavailable for unscoped callers. Use targeted sends for singular requests like "ask a reviewer"; use broadcast only when the user asks every/all available sessions.'),
      idempotencyKey: stringSchema(`Optional retry key; duplicate sends within ${MEMORY_MCP_CAPS.SEND_MESSAGE_IDEMPOTENCY_WINDOW_MS} ms reuse the original ids.`),
      clone: {
        ...objectSchema({
          kind: { type: 'string', enum: [EXECUTION_CLONE_KIND], description: 'Must be the literal execution-clone kind discriminant.' },
          ephemeral: booleanSchema('Must be true — managed execution clones are always ephemeral.'),
          parentRunId: stringSchema('Non-empty id of the parent run that owns the created clone.'),
          parentStage: { type: 'string', enum: [...EXECUTION_CLONE_PARENT_STAGES], description: 'Execution entry-point stage creating the clone; one of the fixed parent stages.' },
        }, ['kind', 'ephemeral', 'parentRunId', 'parentStage']),
        description: 'Optional strict execution-clone request. When present, the message is routed to a freshly created ephemeral clone of the resolved target template (never the target directly) and the result includes clone.target; broadcast is not allowed with clone.',
      },
    }, ['target', 'message']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SEND_STOP]: {
    name: MEMORY_MCP_TOOL_NAMES.SEND_STOP,
    description: 'Immediately stop a sibling\'s active turn using its exact target; unlike send_message, this bypasses its queue. Use for stuck or wrong work. The caller is invalid. Queued user messages remain; only the active turn is interrupted.',
    inputSchema: objectSchema({
      target: stringSchema('Exact target session value. Required unless broadcast is true. For an ordinary peer, use the exact send_list_targets.target value. To stop an execution clone you created, use the exact result.clone.target from the originating clone send — execution clones are NOT returned by send_list_targets and only their creator may stop them. Always use the exact target name; never a label or agentType value.'),
      broadcast: booleanSchema('Optional project-scoped request to stop every sendable sibling session; unavailable for unscoped callers.'),
      idempotencyKey: stringSchema(`Optional retry key; duplicate stops within ${MEMORY_MCP_CAPS.SEND_MESSAGE_IDEMPOTENCY_WINDOW_MS} ms reuse the original ids.`),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.DESTROY_EXECUTION_CLONE]: {
    name: MEMORY_MCP_TOOL_NAMES.DESTROY_EXECUTION_CLONE,
    description: 'Destroy an execution clone created by this session via send_message. Only its creator may destroy it; replay after removal returns target_not_found without recreating it.',
    inputSchema: objectSchema({
      target: stringSchema('Required exact execution-clone session name returned by the original clone send (result.clone.target).'),
      idempotencyKey: stringSchema('Optional caller-stable key for safe retries of the same destroy.'),
    }, ['target']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF,
    description: `Preferred self-wakeup method: schedule a message for the current session. Identity is automatic; runs must be at least ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes apart.`,
    inputSchema: objectSchema({
      cronExpr: stringSchema(`Cron expression; minimum interval is ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes.`),
      message: stringSchema('Message delivered to the current session.'),
      name: stringSchema('Optional job name; derived from message when omitted.'),
      timezone: stringSchema('Optional cron timezone.'),
      expiresAt: stringSchema(`Optional epoch-ms or offset-ISO expiration, up to ${MEMORY_MCP_CAPS.CRON_EXPIRES_AT_MAX_DAYS} days ahead.`),
    }, ['cronExpr', 'message']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF,
    description: 'Update the current session\'s self-wakeup job using its returned or injected id.',
    inputSchema: objectSchema({
      id: stringSchema('Current-session cron job id.'),
      cronExpr: stringSchema(`Optional cron expression; minimum interval is ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes.`),
      message: stringSchema('Optional replacement message.'),
      name: stringSchema('Optional replacement name.'),
      timezone: stringSchema('Optional replacement timezone.'),
      expiresAt: stringSchema(`Optional epoch-ms or offset-ISO expiration, up to ${MEMORY_MCP_CAPS.CRON_EXPIRES_AT_MAX_DAYS} days ahead.`),
    }, ['id']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF,
    description: 'Cancel a current-session self-wakeup job when complete, by id or unique name; use all=true to cancel all.',
    inputSchema: objectSchema({
      id: stringSchema('Exact job id; exclusive with name and all.'),
      name: stringSchema('Unique exact job name; exclusive with id and all.'),
      all: booleanSchema('Cancel all current-session jobs; exclusive with id and name.'),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_CREATE]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_CREATE,
    description: `Schedule a cross-session send. Use cron_create_self to wake this session. Minimum interval: ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes.`,
    inputSchema: objectSchema({
      name: stringSchema('Job name.'),
      cronExpr: stringSchema(`Cron expression; minimum interval is ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes.`),
      projectName: stringSchema('Optional caller project.'),
      targetRole: stringSchema('Optional source role; defaults to brain.'),
      targetSessionName: stringSchema('Optional source session used to resolve the sibling target.'),
      action: { type: 'object', description: 'Send action: { type: "send", target, message, reply?, broadcast?, idempotencyKey? }.', additionalProperties: true },
      timezone: stringSchema('Optional cron timezone.'),
      expiresAt: stringSchema(`Optional epoch-ms or offset-ISO expiration, up to ${MEMORY_MCP_CAPS.CRON_EXPIRES_AT_MAX_DAYS} days ahead; stops future sends only.`),
    }, ['name', 'cronExpr', 'action']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_LIST]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_LIST,
    description: 'List cron jobs for the current user, server, and project.',
    inputSchema: objectSchema({
      projectName: stringSchema('Optional caller-project filter.'),
      limit: numberSchema(`Optional limit, up to ${MEMORY_MCP_CAPS.CRON_LIST_MAX_LIMIT}.`, { minimum: 1, maximum: MEMORY_MCP_CAPS.CRON_LIST_MAX_LIMIT }),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_UPDATE]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_UPDATE,
    description: `Update a cross-session cron job. Use cron_update_self for this session. Minimum interval: ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes.`,
    inputSchema: objectSchema({
      id: stringSchema('Job id.'),
      name: stringSchema('Optional replacement name.'),
      cronExpr: stringSchema(`Optional cron expression; minimum interval is ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes.`),
      projectName: stringSchema('Optional caller project.'),
      targetRole: stringSchema('Optional source role.'),
      targetSessionName: stringSchema('Optional source session used to resolve the sibling target.'),
      action: { type: 'object', description: 'Optional replacement send action.', additionalProperties: true },
      timezone: stringSchema('Optional replacement timezone.'),
      expiresAt: stringSchema(`Optional epoch-ms or offset-ISO expiration, up to ${MEMORY_MCP_CAPS.CRON_EXPIRES_AT_MAX_DAYS} days ahead; stops future sends only.`),
    }, ['id']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_DELETE]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_DELETE,
    description: 'Delete a cron job by id. Use cron_cancel_self for current-session jobs.',
    inputSchema: objectSchema({
      id: stringSchema('Job id.'),
    }, ['id']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.LIST_MACHINES]: {
    name: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES,
    description:
      'Discover ref_names or inspect advisory availability; do not call it as a preflight when an exact ref_name or ^^(name) is known. Action routes check live state. FULL nodes only.',
    inputSchema: objectSchema({
      includeOffline: booleanSchema('Include offline and exec-disabled machines; default false. Presence is advisory.'),
    }),
    outputSchema: objectSchema({
      status: stringSchema('Always ok for a successful result.', { enum: ['ok'] }),
      machines: {
        type: 'array',
        description: 'Controllable machines for the account.',
        maxItems: MACHINE_LIST_MAX_ITEMS,
        items: objectSchema({
          name: stringSchema('Stable ref_name for machine tools and ^^(name).', { minLength: 1, maxLength: MACHINE_REF_NAME_MAX, pattern: MACHINE_NAME_PATTERN.source }),
          displayName: stringSchema('Render-only display name (sanitized).'),
          os: stringSchema('Canonical OS (win | mac | linux); advisory, absent if unknown.', { enum: [...ENROLLMENT_OSES] }),
          online: booleanSchema('Advisory DB-heartbeat presence.'),
          execEnabled: booleanSchema('Whether remote exec is enabled for this machine.'),
          role: stringSchema('Node role; always "controlled" for controllable machines.', { enum: [NODE_ROLE.CONTROLLED] }),
        }, ['name', 'online', 'execEnabled', 'role']),
      },
    }, ['status', 'machines']),
  },
  [MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE]: {
    name: MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE,
    description:
      'Run one command on a machine. Pass either the bare ref_name or the complete ^^(ref_name) marker; both normalize to the same target, without list_machines. not_dispatched is retry-safe; dispatched_no_result may have run, so never auto-retry non-idempotent work. FULL nodes only.',
    inputSchema: objectSchema({
      machine: stringSchema('Bare stable ref_name or complete ^^(ref_name) marker.', { minLength: 1, maxLength: MACHINE_TARGET_MAX, pattern: MACHINE_TARGET_PATTERN.source }),
      command: stringSchema(`Command to run, up to ${REMOTE_EXEC_MAX_COMMAND_BYTES} UTF-8 bytes.`),
      shell: stringSchema(`Optional shell; one of ${REMOTE_EXEC_SHELLS.join(', ')}.`, { enum: [...REMOTE_EXEC_SHELLS] }),
      timeoutMs: numberSchema(`Optional timeout in ms; defaults to ${REMOTE_EXEC_DEFAULT_TIMEOUT_MS}, in [${REMOTE_EXEC_MIN_TIMEOUT_MS}, ${REMOTE_EXEC_MAX_TIMEOUT_MS}].`, { minimum: REMOTE_EXEC_MIN_TIMEOUT_MS, maximum: REMOTE_EXEC_MAX_TIMEOUT_MS }),
    }, ['machine', 'command']),
    outputSchema: objectSchema({
      status: stringSchema('Always ok for a successful result.', { enum: ['ok'] }),
      outcome: stringSchema(`Discriminated outcome: ${REMOTE_EXEC_OUTCOMES.join(' | ')}.`, { enum: [...REMOTE_EXEC_OUTCOMES] }),
      ok: booleanSchema('True when the process spawned and exited (any exit code) — inspect exitCode for command success; false on spawn error or timeout.'),
      exitCode: { type: ['number', 'null'], description: 'Process exit code when the command ran; null on timeout/spawn failure.' },
      stdout: stringSchema('Captured stdout (may be truncated).'),
      stderr: stringSchema('Captured stderr (may be truncated).'),
      timedOut: booleanSchema('True only for node_timeout.'),
      truncated: booleanSchema('True when output hit the byte cap and was cut.'),
      durationMs: numberSchema('Wall-clock duration in ms.', { minimum: 0 }),
      error: stringSchema('Required non-empty detail for node_timeout/spawn_error; forbidden otherwise.', { minLength: 1 }),
    }, ['status', 'outcome']),
  },
  [MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE]: {
    name: MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE,
    description: 'Send one regular file to a controlled machine. Pass either its bare ref_name or complete ^^(ref_name) marker without list_machines. Unsafe file types and credential paths are rejected. FULL nodes only.',
    inputSchema: objectSchema({
      machine: stringSchema('Bare stable ref_name or complete ^^(ref_name) marker.', { minLength: 1, maxLength: MACHINE_TARGET_MAX, pattern: MACHINE_TARGET_PATTERN.source }),
      sourcePath: stringSchema(`Explicit local regular-file path, up to ${FILE_TRANSFER_PATH_MAX_BYTES} UTF-8 bytes and ${FILE_TRANSFER_LIMITS.MAX_FILE_SIZE} file bytes.`),
    }, ['machine', 'sourcePath']),
    outputSchema: objectSchema({
      status: stringSchema('Always ok for a successful transfer.', { enum: ['ok'] }),
      machine: stringSchema('Resolved machine ref_name.'),
      remotePath: stringSchema('Exact protected staging path on the controlled node.'),
      attachmentId: stringSchema('Short-lived attachment id.'),
      size: numberSchema('Transferred byte count.', { minimum: 0, maximum: FILE_TRANSFER_LIMITS.MAX_FILE_SIZE }),
    }, ['status', 'machine', 'remotePath', 'attachmentId', 'size']),
  },
  [MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE]: {
    name: MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE,
    description: 'Fetch one regular file from a controlled machine. Pass either its bare ref_name or complete ^^(ref_name) marker without list_machines. Destination commit is atomic; overwrite defaults false. FULL nodes only.',
    inputSchema: objectSchema({
      machine: stringSchema('Bare stable ref_name or complete ^^(ref_name) marker.', { minLength: 1, maxLength: MACHINE_TARGET_MAX, pattern: MACHINE_TARGET_PATTERN.source }),
      sourcePath: stringSchema(`Explicit controlled-node regular-file path, up to ${FILE_TRANSFER_PATH_MAX_BYTES} UTF-8 bytes.`),
      destinationPath: stringSchema(`Explicit local destination path, up to ${FILE_TRANSFER_PATH_MAX_BYTES} UTF-8 bytes.`),
      overwrite: booleanSchema('Replace an existing regular destination file; default false.'),
    }, ['machine', 'sourcePath', 'destinationPath']),
    outputSchema: objectSchema({
      status: stringSchema('Always ok for a successful transfer.', { enum: ['ok'] }),
      machine: stringSchema('Resolved machine ref_name.'),
      destinationPath: stringSchema('Exact committed local destination path.'),
      attachmentId: stringSchema('Short-lived source attachment id.'),
      size: numberSchema('Transferred byte count.', { minimum: 0, maximum: FILE_TRANSFER_LIMITS.MAX_FILE_SIZE }),
    }, ['status', 'machine', 'destinationPath', 'attachmentId', 'size']),
  },
  [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS]: {
    name: MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS,
    description: 'Return one focused Computer Use documentation topic. FULL nodes only.',
    inputSchema: objectSchema({
      topic: stringSchema(`Documentation topic; one of ${COMPUTER_USE_DOC_TOPICS.join(', ')}.`, { enum: [...COMPUTER_USE_DOC_TOPICS] }),
    }, ['topic']),
    outputSchema: objectSchema({
      status: stringSchema('Always ok for a successful result.', { enum: ['ok'] }),
      topic: stringSchema('Returned topic.', { enum: [...COMPUTER_USE_DOC_TOPICS] }),
      text: stringSchema('Focused Computer Use guidance for this topic.'),
    }, ['status', 'topic', 'text']),
  },
  [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL]: {
    name: MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL,
    description: 'Use Computer Use on this daemon host (machine=local) or a controlled machine. Open Computer Use (OCU) provides the integrated cross-platform desktop-app control path; IM.codes provides separate built-in CDP-backed browser_* tools. For browser work, prefer machine=local with browser_open/browser_snapshot instead of probing or installing Playwright through a shell. Browser results expose a loopback cdpEndpoint/host/port so local Python or Node scripts can reuse the same browser; pass includeImage=true only when visual inspection is needed. Pass a controlled machine bare ref_name or complete ^^(ref_name) marker without list_machines. exec_remote is session-0/SYSTEM; shell_session1 is active-user. FULL nodes only.',
    inputSchema: objectSchema({
      machine: stringSchema('Bare stable ref_name, complete ^^(ref_name) marker, or local/localhost/self/this.', { minLength: 1, maxLength: MACHINE_TARGET_MAX, pattern: MACHINE_TARGET_PATTERN.source }),
      tool: stringSchema(`Typed method name; one of ${COMPUTER_USE_TOOLS.join(', ')}.`, { enum: [...COMPUTER_USE_TOOLS] }),
      arguments: { type: 'object', description: `JSON object arguments for the selected method, up to ${COMPUTER_USE_MAX_ARGUMENT_BYTES} UTF-8 bytes. Windows coordinate drag additionally accepts duration_ms=${COMPUTER_USE_DRAG_DURATION_MIN_MS}..${COMPUTER_USE_DRAG_DURATION_MAX_MS}.`, additionalProperties: true },
      timeoutMs: numberSchema(`Optional timeout in ms. GUI/browser methods allow [${COMPUTER_USE_MIN_TIMEOUT_MS}, ${COMPUTER_USE_MAX_TIMEOUT_MS}]; shell_session1 allows [${COMPUTER_USE_MIN_TIMEOUT_MS}, ${COMPUTER_USE_SHELL_SESSION1_MAX_TIMEOUT_MS}].`, { minimum: COMPUTER_USE_MIN_TIMEOUT_MS, maximum: COMPUTER_USE_SHELL_SESSION1_MAX_TIMEOUT_MS }),
    }, ['machine', 'tool']),
    outputSchema: objectSchema({
      status: stringSchema('Always ok for a successful result.', { enum: ['ok'] }),
      outcome: stringSchema(`Discriminated outcome: ${COMPUTER_USE_OUTCOMES.join(' | ')}.`, { enum: [...COMPUTER_USE_OUTCOMES] }),
      result: { type: 'object', description: 'Bounded Computer Use result content when the target method returned.', additionalProperties: true },
    }, ['status', 'outcome']),
  },
};

export interface MemoryMcpErrorResult extends Record<string, unknown> {
  status: 'error';
  reason: MCPErrorReason;
  message?: string;
  recoverable: boolean;
}

export interface MemoryMcpDisabledResult extends Record<string, unknown> {
  status: 'disabled';
  reason: typeof MCP_ERROR_REASONS.FEATURE_DISABLED;
  disabledFlag: string;
  message?: string;
  recoverable: true;
}

export function buildMcpErrorResult(reason: MCPErrorReason, message?: string): MemoryMcpErrorResult {
  return {
    status: 'error',
    reason,
    ...(message ? { message } : {}),
    recoverable: isRecoverableMcpErrorReason(reason),
  };
}

export function buildMcpDisabledResult<T extends Record<string, unknown> = Record<string, never>>(
  disabledFlag: string,
  extra?: T,
): MemoryMcpDisabledResult & T {
  return {
    status: 'disabled',
    reason: MCP_ERROR_REASONS.FEATURE_DISABLED,
    disabledFlag,
    recoverable: true,
    ...(extra ?? {} as T),
  };
}

export function stripForbiddenMcpArgs(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_ARG_SET.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export function pickAllowedMcpArgs(input: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  const stripped = stripForbiddenMcpArgs(input);
  const allowed = new Set(allowedKeys);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stripped)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}
