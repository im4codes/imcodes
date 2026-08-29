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
import { FILE_TRANSFER_PATH_MAX_BYTES } from './transport/file-transfer.js';
import { MACHINE_FILE_TRANSFER_TRANSPORT } from './machine-direct-file-transfer.js';
import {
  MACHINE_TARGET_MAX,
  MACHINE_TARGET_PATTERN,
} from './machine-reference.js';
import {
  CONTROLLED_NODE_ID_LENGTH,
  CONTROLLED_NODE_ID_PATTERN_SOURCE,
} from './controlled-node-identity.js';
import {
  PEER_AUDIT_FINDINGS_BYTES,
  PEER_AUDIT_VALIDATION_COUNT,
  PEER_AUDIT_VALIDATION_ITEM_BYTES,
  PEER_AUDIT_VALIDATION_KINDS,
  PEER_AUDIT_VALIDATION_OUTCOMES,
} from './peer-audit.js';
import { CRON_COMPLETION_POLICY } from './cron-types.js';
import {
  AGENT_DELEGATION_PURPOSES,
  AGENT_DELEGATION_REPLY_RESULT_BYTES,
} from './agent-delegation.js';
import {
  SUPERVISION_TASK_CLASSIFICATIONS,
  SUPERVISION_TASK_FILE_OPERATIONS,
} from './supervision-config.js';
import { SUPERVISION_EXECUTION_POOL_KINDS } from './supervision-execution-pool.js';
import {
  MEMORY_MCP_SEND_DELIVERY_MODES,
  type MemoryMcpSendDeliveryMode,
} from './session-send-delivery.js';
export {
  MEMORY_MCP_SEND_DELIVERY_MODES,
  type MemoryMcpSendDeliveryMode,
};

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
  DELEGATION_REPLY: 'delegation_reply',
  SEND_LIST_TARGETS: 'send_list_targets',
  SESSION_RUNTIME_IDENTITY_GET: 'session_runtime_identity_get',
  SEND_MESSAGE: 'send_message',
  SUPERVISION_TASK_START: 'supervision_task_start',
  SUPERVISION_TASK_UPDATE: 'supervision_task_update',
  SUPERVISION_TASK_FINISH: 'supervision_task_finish',
  SUPERVISION_TASK_FILE_EVENT: 'supervision_task_file_event',
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
  MEMORY_MCP_TOOL_NAMES.DELEGATION_REPLY,
  MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS,
  MEMORY_MCP_TOOL_NAMES.SESSION_RUNTIME_IDENTITY_GET,
  MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH,
  MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT,
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
    description: 'Search caller-bound memory when prior project or user context may matter. Returns compact hits with a typed sourceLookup; use those fields for source expansion when a summary is not enough. Query is text; vectorization is internal.',
    inputSchema: objectSchema({
      query: stringSchema('Required text query to search for. Do not send embeddings, vectors, identity, or namespace fields.'),
      limit: numberSchema(`Optional maximum hit count; defaults to ${MEMORY_MCP_CAPS.SEARCH_MEMORY_DEFAULT_LIMIT} and is clamped to ${MEMORY_MCP_CAPS.SEARCH_MEMORY_MAX_LIMIT}.`, { minimum: 1, maximum: MEMORY_MCP_CAPS.SEARCH_MEMORY_MAX_LIMIT }),
    }, ['query']),
    outputSchema: objectSchema({
      status: stringSchema('ok, disabled, or error.'),
      reason: stringSchema('Optional machine-readable reason when an empty result is caused by project scoping, policy, or feature availability.'),
      items: { type: 'array', description: 'Compact same-namespace memory hits. Each item includes ref plus sourceLookup with a logical tool name, kind, and projectionId or observationId for exact source expansion; use the exact callable identifier from the current tool list.', items: { type: 'object', additionalProperties: true } },
    }),
  },
  [MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES]: {
    name: MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES,
    description: 'List recent caller-project memory summaries without a query. Each item includes a compact ref and sourceLookup for optional source expansion.',
    inputSchema: objectSchema({
      projectionClass: { type: 'string', enum: ['recent_summary', 'durable_memory_candidate'], description: 'Optional processed memory class to list. Defaults to recent_summary for the newest task summaries; durable_memory_candidate lists promoted durable facts.' },
      limit: numberSchema(`Optional maximum summary count; defaults to ${MEMORY_MCP_CAPS.LIST_MEMORY_SUMMARIES_DEFAULT_LIMIT} and is clamped to ${MEMORY_MCP_CAPS.LIST_MEMORY_SUMMARIES_MAX_LIMIT}.`, { minimum: 1, maximum: MEMORY_MCP_CAPS.LIST_MEMORY_SUMMARIES_MAX_LIMIT }),
    }),
    outputSchema: objectSchema({
      status: stringSchema('ok, disabled, or error.'),
      reason: stringSchema('Optional machine-readable reason when an empty result is caused by project scoping, policy, or feature availability.'),
      items: { type: 'array', description: 'Newest compact processed memory summaries. Each item includes ref plus sourceLookup with a logical tool name, projection kind, and projectionId for exact source expansion; use the exact callable identifier from the current tool list.', items: { type: 'object', additionalProperties: true } },
    }),
  },
  [MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]: {
    name: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
    description: 'Fetch source snippets by projection id, observation id, or compact ref, after a memory-search result or startup memory. Missing and cross-namespace ids both return an empty list. An ambiguous ref sets ambiguousRef with empty sources and up to four candidates; candidateCount and truncated say how many exist. That empty sources is not no memory: pick a candidate and cite its own id.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Projection id from a memory-search result sourceLookup. Caller identity and namespace are runtime-bound.'),
      observationId: stringSchema('Observation id from a memory-search result sourceLookup. Caller identity and namespace are runtime-bound.'),
      ref: stringSchema('Compact ref shown in memory-search results or startup memory, such as obs:abc123 or proj:abc123. It resolves after the ref was observed by this daemon and is cached locally across daemon restarts.'),
      kind: { type: 'string', enum: ['projection', 'observation'], description: 'Optional lookup kind copied from sourceLookup; provide exactly one matching id.' },
    }),
    outputSchema: objectSchema({
      projectionId: stringSchema('Requested projection id when expanding a projection hit.'),
      observationId: stringSchema('Requested observation id when expanding an observation hit.'),
      sources: { type: 'array', description: 'Source snippets visible to the caller namespace.', items: { type: 'object', additionalProperties: true } },
      projectionSource: { type: 'object', description: 'Processed projection summary snippet, included when available so callers can cite compacted memories even when raw source events are unavailable or less informative.', additionalProperties: true },
      status: stringSchema('Result status.'),
      ref: stringSchema('The compact ref that was expanded, echoed back.'),
      sourceEventCount: { type: 'number', description: 'Number of source events backing the requested record.' },
      partial: { type: 'boolean', description: 'Set when some source events could not be returned.' },
      originServerId: stringSchema('Server that owns the record, when it was fetched remotely.'),
      ambiguousRef: { type: 'boolean', description: 'Set when the supplied ref denotes more than one record, so `candidates` carries the matches instead of `sources` carrying one. Decide which candidate answers the question, then cite it by its own projectionId / observationId.' },
      candidateCount: { type: 'number', description: 'How many records the ambiguous ref covers in total, which may exceed the expanded `candidates`.' },
      truncated: { type: 'boolean', description: 'Set when `candidates` holds only part of candidateCount because expansion is bounded.' },
      candidates: { type: 'array', description: 'Up to four of the records the ambiguous ref resolves to, each with its own id and expanded sources. Not necessarily exhaustive — compare against candidateCount / truncated.', items: { type: 'object', additionalProperties: true } },
    }),
  },
  [MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY]: {
    name: MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY,
    description: 'Archive a caller-project projection so search, recall, and startup context omit it. Identity and scope are runtime-bound; pass its projectionId or proj: ref.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Projection id from memory search or recent-summary listing for the memory to archive. Caller identity and namespace are runtime-bound.'),
      ref: stringSchema('Optional compact projection ref such as proj:abc123 returned by memory search or recent-summary listing. Do not combine with projectionId.'),
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
  [MEMORY_MCP_TOOL_NAMES.DELEGATION_REPLY]: {
    name: MEMORY_MCP_TOOL_NAMES.DELEGATION_REPLY,
    description: 'Reply to a reply-enabled delegation using only the id and capability from its brief. The same capability may submit multiple replies until it expires; the daemon notifies the origin. Do not also send_message for the same reply.',
    inputSchema: objectSchema({
      delegationId: stringSchema('Opaque delegation id supplied by the reply-enabled brief.'),
      replyCapability: stringSchema('Bounded reply capability supplied by the brief. It remains valid until expiry; never repeat it inside result.'),
      result: stringSchema(`One complete delegation reply, at most ${AGENT_DELEGATION_REPLY_RESULT_BYTES} UTF-8 bytes.`),
    }, ['delegationId', 'replyCapability', 'result']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]: {
    name: MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS,
    description: 'List sendable caller-project siblings. With no executionPool, preserves the complete scoped discovery surface for ordinary messages and discussion. Set executionPool=primary or economy only when selecting new supervised implementation/audit work; that filter is fail-closed against the caller current configured pool and canonical observed identity. The current caller session and stopped sessions are excluded; if this returns no items for a requested pool, no currently discovered sibling satisfies that pool. Availability, limitGroup, replyCapable, eligiblePools and dispatchMode are machine evidence; send_message revalidates task/audit targets and never trusts the list as authority.',
    inputSchema: objectSchema({
      query: stringSchema('Optional case-insensitive text filter over target display labels, names, agent types, and model metadata, such as "cc", "codex", "gpt-5", "reviewer", or a session label mentioned by the user.'),
      limit: numberSchema('Optional maximum number of targets to return; implementations may clamp it.'),
      executionPool: {
        type: 'string',
        enum: [...SUPERVISION_EXECUTION_POOL_KINDS],
        description: 'Optional supervision pool filter. Omit to list every scoped/discoverable sibling for ordinary messaging. A legacy-unconfigured caller gets an empty result when a pool filter is requested.',
      },
    }),
    outputSchema: objectSchema({
      status: stringSchema('ok, disabled, or error.'),
      reason: stringSchema('Machine-readable reason for disabled/error results.'),
      error: stringSchema('Sanitized error detail for error results.'),
      executionPoolsState: {
        type: 'string',
        enum: ['configured', 'legacy_unconfigured'],
        description: 'Caller execution-pool configuration state on an ok result.',
      },
      appliedExecutionPool: {
        type: 'string',
        enum: [...SUPERVISION_EXECUTION_POOL_KINDS],
        description: 'Echoed only when the caller requested an executionPool filter.',
      },
      items: {
        type: 'array',
        description: 'Scoped target projections after optional pool, query, and limit filtering.',
        items: objectSchema({
          target: stringSchema('Exact target accepted by send_message.'),
          label: { type: ['string', 'null'], description: 'Human display label when present.' },
          sessionName: stringSchema('Canonical target session name.'),
          role: stringSchema('Observed session role.'),
          agentType: stringSchema('Observed runtime agent type.'),
          model: stringSchema('Effective model when known.'),
          status: stringSchema('Observed session runtime state.'),
          lastActiveAt: numberSchema('Last observed session activity timestamp.'),
          providerFamily: stringSchema('Observed provider family used by audit/task policy.'),
          availability: stringSchema('Authoritative delegation availability.'),
          eligiblePools: {
            type: 'array',
            items: { type: 'string', enum: [...SUPERVISION_EXECUTION_POOL_KINDS] },
            description: 'Configured pools whose canonical identity constraints match this target. Absent for legacy-unconfigured callers.',
          },
          dispatchMode: {
            type: 'string',
            enum: ['new_work', 'queue_only', 'unavailable'],
            description: 'Configured-caller new-work disposition derived from availability.',
          },
          limitGroup: stringSchema('Provider quota group shared by sibling sessions.'),
          replyCapable: booleanSchema('Whether the runtime supports structured replies.'),
        }),
      },
    }),
  },
  [MEMORY_MCP_TOOL_NAMES.SESSION_RUNTIME_IDENTITY_GET]: {
    name: MEMORY_MCP_TOOL_NAMES.SESSION_RUNTIME_IDENTITY_GET,
    description: 'Runtime identity of the bound MCP caller only. No arguments, cannot enumerate peers. Model metadata is evidence, not authorization; schedulers revalidate the live SessionRecord before assigning.',
    inputSchema: objectSchema({}),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]: {
    name: MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
    description: 'Send plain text to an exact send_list_targets target. Callers and labels are invalid targets. append (default) joins the active turn, with durable FIFO fallback when unsupported or racing; queue always uses FIFO. Not a Team/P2P run. Files are project-root paths, not bytes. Returns ids and delivered/queued/failed status.',
    inputSchema: objectSchema({
      target: stringSchema('Exact target session. May be omitted only when task.autoProvision=true, which authorizes the daemon to reuse/provision from the configured pool.'),
      message: stringSchema(`Required complete task/request text to deliver, up to ${MEMORY_MCP_CAPS.SEND_MESSAGE_MAX_BYTES} UTF-8 bytes. Include the desired role and output, such as audit findings, discussion input, plan, implementation request, or verification result.`),
      deliveryMode: {
        type: 'string',
        enum: [...Object.values(MEMORY_MCP_SEND_DELIVERY_MODES)],
        description: 'Optional delivery policy. append (default) attempts a non-preemptive active-turn append with durable queue fallback; queue always uses ordinary durable FIFO and never inserts into the active turn.',
      },
      files: {
        type: 'array',
        description: `Optional file path references under the caller project root; at most ${MEMORY_MCP_CAPS.SEND_FILES_MAX_COUNT}; contents are not read or transferred by MCP.`,
        items: stringSchema(`Relative path or in-root absolute path reference, at most ${MEMORY_MCP_CAPS.SEND_FILE_PATH_MAX_CHARS} characters and without control characters.`),
        maxItems: MEMORY_MCP_CAPS.SEND_FILES_MAX_COUNT,
      },
      reply: booleanSchema('Optional request for correlated replies to the runtime-bound caller session. Set true for audit/review reports or discussion invites; the target receives an opaque delegation id and bounded capability that may send multiple replies until expiry, and each structured reply is delivered through the caller provider’s active-turn notification path when supported. Do not poll session state, logs, transcripts, or the target after a reply-enabled send.'),
      task: {
        ...objectSchema({
          taskId: stringSchema('Optional existing visible task id to bind; omitted creates a task. Missing or inaccessible ids fail and are never silently reminted.'),
          topLevelTaskId: stringSchema('Optional top-level task id.'),
          sliceId: stringSchema('Optional slice id.'),
          classification: { type: 'string', enum: [...SUPERVISION_TASK_CLASSIFICATIONS], description: 'Task classification.' },
          objective: stringSchema('Task objective/title.'),
          acceptance: { type: 'array', items: stringSchema('Acceptance item.'), description: 'Acceptance criteria.' },
          ownedFiles: { type: 'array', items: stringSchema('Repo-relative owned path.'), description: 'Owned files.' },
          sharedFiles: { type: 'array', items: stringSchema('Repo-relative shared path.'), description: 'Shared files.' },
          dependencies: { type: 'array', items: stringSchema('Task dependencies.'), description: 'Dependencies.' },
          integrationOwner: stringSchema('Integration owner assignment/session reference.'),
          baseRevision: stringSchema('Base revision.'),
          currentRevision: stringSchema('Current revision.'),
          auditAttemptId: stringSchema('Matching audit attempt id.'),
          auditRevision: stringSchema('Matching audit revision.'),
          executionPool: { type: 'string', enum: ['primary', 'economy'], description: 'Configured execution pool.' },
          autoProvision: { type: 'boolean', description: 'When true, reuse or provision a pool-selected sub-session if target is omitted.' },
          requestedExecutionType: objectSchema({
            capabilityId: stringSchema('Exact configured capability id.'),
            agentType: stringSchema('Configured SDK agent type.'),
            providerFamily: stringSchema('Canonical provider family.'),
            runtimeType: { type: 'string', enum: ['process', 'transport'] },
            model: stringSchema('Canonical selected model.'),
            ccPresetId: stringSchema('Optional canonical Claude Code preset identity.', { minLength: 1 }),
          }, ['capabilityId', 'agentType', 'providerFamily', 'runtimeType', 'model']),
        }),
        description: 'Optional daemon-authoritative supervision task metadata. When present, accepted result returns taskId and assignmentId; idempotency replay must reuse both.',
      },
      audit: {
        ...objectSchema({
          kind: {
            type: 'string',
            enum: [AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT],
            description: 'Exact supervision-audit purpose. Ordinary reply-enabled delegations must omit this object.',
          },
          attemptId: stringSchema('Exact automatic supervision audit attempt id supplied by the orchestration request.'),
          auditedSessionName: stringSchema('Exact session being audited, chosen by the Supervisor Brain. The daemon never infers it.'),
          strictCrossVendor: booleanSchema('Set true only when the user explicitly requires cross-vendor and forbids same-family degradation.'),
        }, ['kind', 'attemptId', 'auditedSessionName']),
        description: 'Strict automatic-supervision metadata. Requires reply=true, one exact target, no broadcast, and no clone.',
      },
      broadcast: booleanSchema('Optional project-scoped broadcast request; unavailable for unscoped callers. Use targeted sends for singular requests like "ask a reviewer"; use broadcast only when the user asks every/all available sessions.'),
      idempotencyKey: stringSchema(`Optional retry key; duplicate sends within ${MEMORY_MCP_CAPS.SEND_MESSAGE_IDEMPOTENCY_WINDOW_MS} ms reuse the original ids.`),
      clone: {
        ...objectSchema({
          kind: { type: 'string', enum: [EXECUTION_CLONE_KIND], description: 'Must be the literal execution-clone kind discriminant.' },
          ephemeral: booleanSchema('Must be true — managed execution clones are always ephemeral.'),
          parentRunId: stringSchema('Non-empty id of the parent run that owns the created clone.'),
          parentStage: { type: 'string', enum: [...EXECUTION_CLONE_PARENT_STAGES], description: 'Execution entry-point stage creating the clone; one of the fixed parent stages.' },
        }, ['kind', 'ephemeral', 'parentRunId', 'parentStage']),
        description: 'Optional execution-clone request. Routes to a fresh ephemeral clone of the resolved target, never the target itself, and returns clone.target. Cannot be combined with broadcast.',
      },
    }, ['message']),
    outputSchema: statusSchema,
  },

  [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]: {
    name: MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START,
    description: 'Start or bind a daemon-authoritative supervision task assignment. Creates durable SQLite task/assignment state; free text is not a completion signal.',
    inputSchema: objectSchema({
      taskId: stringSchema('Optional stable task id. Omit to let daemon generate one.'),
      topLevelTaskId: stringSchema('Optional top-level task id. Defaults to taskId.'),
      classification: { type: 'string', enum: [...SUPERVISION_TASK_CLASSIFICATIONS], description: 'Task classification.' },
      role: { type: 'string', enum: ['coordinator', 'integration_owner', 'implementer', 'auditor'], description: 'Assignment role for the caller session.' },
      objective: stringSchema('Short objective/title.'),
      acceptance: { type: 'array', items: stringSchema('Acceptance item.'), description: 'Acceptance criteria.' },
      scopeFiles: { type: 'array', items: stringSchema('Repo-relative owned/shared path.'), description: 'Assignment scope paths.' },
      claimMode: { type: 'string', enum: ['exclusive', 'shared', 'read_only'], description: 'File claim mode. Auditors are forced read_only.' },
      idempotencyKey: stringSchema('Retry key; replay returns the same taskId/assignmentId.'),
    }, ['role', 'objective']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE]: {
    name: MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE,
    description: 'Heartbeat or update the caller bound assignment. The daemon derives lifecycle status from a semantic intent; callers cannot name a target status. Gates, revision and audit-attempt checks are enforced by the registry.',
    inputSchema: objectSchema({
      assignmentId: stringSchema('Assignment id bound to this caller runtime.'),
      revision: stringSchema('Current/audit revision for stale-update rejection.'),
      auditAttemptId: stringSchema('Matching audit attempt id, when updating audit state.'),
      auditRevision: stringSchema('Matching audit revision.'),
      verdict: stringSchema('Audit verdict when applicable.'),
      blocker: stringSchema('Blocker reason when applicable.'),
      externalRunId: stringSchema('External run id, e.g. CI run.'),
      externalHeadSha: stringSchema('External run head SHA.'),
      externalTaskId: stringSchema('External task/workflow id.'),
    }, ['assignmentId']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]: {
    name: MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH,
    description: 'Finish only the caller’s assignment (validated/ready_for_audit/ready_for_integration/blocked/cancelled/etc.); it never closes the whole task by prose and does not automatically scan files or Git state.',
    inputSchema: objectSchema({
      assignmentId: stringSchema('Assignment id bound to this caller runtime.'),
      revision: stringSchema('Current revision.'),
      evidence: stringSchema('Bounded evidence summary.'),
    }, ['assignmentId']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT]: {
    name: MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT,
    description: 'Record a caller-reported file event for the caller assignment. Nothing is auto-detected: no editor hook, no filesystem or Git scanner. The path must already be in the claim scope; outside-scope reports block the task. Unreported writes stay invisible.',
    inputSchema: objectSchema({
      assignmentId: stringSchema('Assignment id bound to this caller runtime.'),
      filePath: stringSchema('Normalized repo-relative path.'),
      operation: { type: 'string', enum: [...SUPERVISION_TASK_FILE_OPERATIONS], description: 'File operation.' },
      beforeHash: stringSchema('Optional before content hash.'),
      afterHash: stringSchema('Optional after content hash.'),
      tool: stringSchema('Tool name, e.g. apply_patch/Edit/Write/shell.'),
      source: stringSchema('Caller/tool source.'),
      idempotencyKey: stringSchema('Retry key for duplicate caller-reported delivery.'),
    }, ['assignmentId', 'filePath', 'operation']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SEND_STOP]: {
    name: MEMORY_MCP_TOOL_NAMES.SEND_STOP,
    description: 'Immediately stop a sibling\'s active turn using its exact target. Use for stuck or wrong work. The caller is invalid. Existing queued user messages remain; only the active turn is interrupted.',
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
    description: `Preferred self-wakeup method: schedule a message for the current session. New jobs default to recurring and stay scheduled after each run; choose until_complete only for a bounded goal. Identity is automatic; runs must be at least ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes apart.`,
    inputSchema: objectSchema({
      cronExpr: stringSchema(`Cron expression; minimum interval is ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes.`),
      message: stringSchema('Message delivered to the current session.'),
      name: stringSchema('Optional job name; derived from message when omitted.'),
      timezone: stringSchema('Optional cron timezone.'),
      expiresAt: stringSchema(`Optional epoch-ms or offset-ISO expiration, up to ${MEMORY_MCP_CAPS.CRON_EXPIRES_AT_MAX_DAYS} days ahead.`),
      completionPolicy: stringSchema('Lifecycle policy. recurring keeps the schedule after each occurrence; until_complete permits self-cancel only after the overall goal is complete.', {
        enum: [CRON_COMPLETION_POLICY.RECURRING, CRON_COMPLETION_POLICY.UNTIL_COMPLETE],
      }),
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
      completionPolicy: stringSchema('Optional lifecycle policy.', {
        enum: [CRON_COMPLETION_POLICY.RECURRING, CRON_COMPLETION_POLICY.UNTIL_COMPLETE],
      }),
      force: booleanSchema('Required when an agent changes a recurring job to until_complete.'),
    }, ['id']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF,
    description: 'Cancel a current session self-wakeup job by id or unique name, or all=true for every one. Recurring jobs need force=true, only on explicit user request. until_complete jobs may self-cancel when done.',
    inputSchema: objectSchema({
      id: stringSchema('Exact job id; exclusive with name and all.'),
      name: stringSchema('Unique exact job name; exclusive with id and all.'),
      all: booleanSchema('Cancel all current-session jobs; exclusive with id and name.'),
      force: booleanSchema('Required to delete recurring jobs. Use only when the user explicitly asked to remove the schedule.'),
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
      completionPolicy: stringSchema('Optional lifecycle policy; defaults to recurring.', {
        enum: [CRON_COMPLETION_POLICY.RECURRING, CRON_COMPLETION_POLICY.UNTIL_COMPLETE],
      }),
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
      completionPolicy: stringSchema('Optional lifecycle policy.', {
        enum: [CRON_COMPLETION_POLICY.RECURRING, CRON_COMPLETION_POLICY.UNTIL_COMPLETE],
      }),
      force: booleanSchema('Required when an agent changes a recurring job to until_complete.'),
    }, ['id']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_DELETE]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_DELETE,
    description: 'Delete a cron job by id. Agent deletion of recurring jobs requires force=true. Use cron_cancel_self for current-session jobs.',
    inputSchema: objectSchema({
      id: stringSchema('Job id.'),
      force: booleanSchema('Required for agent deletion of a recurring job.'),
    }, ['id']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.LIST_MACHINES]: {
    name: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES,
    description:
      'Discover canonical controlled-node nodeIds or inspect advisory availability; do not call it as a preflight when an exact nodeId or ^^(nodeId) is known. Action routes check live state. FULL nodes only.',
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
          name: stringSchema('Canonical controlled-node nodeId for machine tools and ^^(nodeId).', { minLength: CONTROLLED_NODE_ID_LENGTH, maxLength: CONTROLLED_NODE_ID_LENGTH, pattern: CONTROLLED_NODE_ID_PATTERN_SOURCE }),
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
      'Run one command on a controlled node. Pass its canonical 10-digit nodeId or complete ^^(nodeId) marker without list_machines. A deprecated noncanonical legacy ref_name remains accepted only for migration compatibility. not_dispatched is retry-safe; dispatched_no_result may have run, so never auto-retry non-idempotent work. FULL nodes only.',
    inputSchema: objectSchema({
      machine: stringSchema('Canonical nodeId or complete ^^(nodeId) marker; deprecated noncanonical legacy ref_name is also accepted.', { minLength: 1, maxLength: MACHINE_TARGET_MAX, pattern: MACHINE_TARGET_PATTERN.source }),
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
    description: 'Direct→relay file send to a canonical 10-digit nodeId or ^^(nodeId), with deprecated noncanonical legacy ref_name compatibility only. Resolve without list_machines. Reports mode; Relay≤2GiB; unsafe/credential paths rejected.',
    inputSchema: objectSchema({
      machine: stringSchema('Canonical nodeId or complete ^^(nodeId) marker; deprecated noncanonical legacy ref_name is also accepted.', { minLength: 1, maxLength: MACHINE_TARGET_MAX, pattern: MACHINE_TARGET_PATTERN.source }),
      sourcePath: stringSchema(`Path ≤${FILE_TRANSFER_PATH_MAX_BYTES} UTF-8 bytes.`),
    }, ['machine', 'sourcePath']),
    outputSchema: objectSchema({
      status: stringSchema('', { enum: ['ok'] }),
      machine: stringSchema(''),
      remotePath: stringSchema(''),
      attachmentId: stringSchema(''),
      size: numberSchema('', { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      transport: stringSchema('', { enum: Object.values(MACHINE_FILE_TRANSFER_TRANSPORT) }),
    }, ['status', 'machine', 'remotePath', 'attachmentId', 'size', 'transport']),
  },
  [MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE]: {
    name: MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE,
    description: 'Direct-then-relay file fetch from a canonical 10-digit nodeId or ^^(nodeId), without list_machines; deprecated noncanonical legacy ref_name is compatibility-only. Reports mode; atomic commit; overwrite=false. FULL nodes only.',
    inputSchema: objectSchema({
      machine: stringSchema('Canonical nodeId or complete ^^(nodeId) marker; deprecated noncanonical legacy ref_name is also accepted.', { minLength: 1, maxLength: MACHINE_TARGET_MAX, pattern: MACHINE_TARGET_PATTERN.source }),
      sourcePath: stringSchema(`Explicit controlled-node regular-file path, up to ${FILE_TRANSFER_PATH_MAX_BYTES} UTF-8 bytes.`),
      destinationPath: stringSchema(`Explicit local destination path, up to ${FILE_TRANSFER_PATH_MAX_BYTES} UTF-8 bytes.`),
      overwrite: booleanSchema('Replace an existing regular destination file; default false.'),
    }, ['machine', 'sourcePath', 'destinationPath']),
    outputSchema: objectSchema({
      status: stringSchema('Always ok for a successful transfer.', { enum: ['ok'] }),
      machine: stringSchema('Resolved canonical nodeId or deprecated legacy ref_name.'),
      destinationPath: stringSchema('Exact committed local destination path.'),
      attachmentId: stringSchema('Relay attachment id or direct transfer id.'),
      size: numberSchema('Transferred byte count.', { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
      transport: stringSchema('Actual mode.', { enum: Object.values(MACHINE_FILE_TRANSFER_TRANSPORT) }),
    }, ['status', 'machine', 'destinationPath', 'attachmentId', 'size', 'transport']),
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
    description: 'GUI/browser control on this host (machine=local) or a controlled machine. Prefer machine=local with browser_open/browser_snapshot over installing Playwright; includeImage=true only when you must see it. Pass a canonical 10-digit nodeId or ^^(nodeId) without list_machines; deprecated noncanonical legacy ref_name is compatibility-only. exec_remote is SYSTEM, shell_session1 is active-user. GUI/browser max 120000, shell_session1 max 900000. FULL nodes only.',
    inputSchema: objectSchema({
      machine: stringSchema('Canonical nodeId, complete ^^(nodeId) marker, deprecated noncanonical legacy ref_name, or local/localhost/self/this.', { minLength: 1, maxLength: MACHINE_TARGET_MAX, pattern: MACHINE_TARGET_PATTERN.source }),
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
