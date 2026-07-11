import { MCP_ERROR_REASONS, isRecoverableMcpErrorReason, type MCPErrorReason } from './memory-mcp-errors.js';
import { MEMORY_FEATURE_FLAGS_BY_NAME } from './feature-flags.js';
import { MCP_FEATURE_FLAGS_BY_NAME } from './memory-mcp-feature-flags.js';
import { MEMORY_MCP_SOURCE_FIELDS } from './memory-mcp-provenance.js';
import { PREFERENCE_MAX_BYTES } from './preference-ingest.js';
import { EXECUTION_CLONE_KIND, EXECUTION_CLONE_PARENT_STAGES } from './execution-clone.js';

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
  SEND_LIST_TARGETS: 'send_list_targets',
  SEND_MESSAGE: 'send_message',
  SEND_STOP: 'send_stop',
  DESTROY_EXECUTION_CLONE: 'destroy_execution_clone',
  CRON_CREATE_SELF: 'cron_create_self',
  CRON_CANCEL_SELF: 'cron_cancel_self',
  CRON_CREATE: 'cron_create',
  CRON_LIST: 'cron_list',
  CRON_UPDATE: 'cron_update',
  CRON_DELETE: 'cron_delete',
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
  MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS,
  MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
  MEMORY_MCP_TOOL_NAMES.SEND_STOP,
  MEMORY_MCP_TOOL_NAMES.DESTROY_EXECUTION_CLONE,
  MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF,
  MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF,
  MEMORY_MCP_TOOL_NAMES.CRON_CREATE,
  MEMORY_MCP_TOOL_NAMES.CRON_LIST,
  MEMORY_MCP_TOOL_NAMES.CRON_UPDATE,
  MEMORY_MCP_TOOL_NAMES.CRON_DELETE,
] as const satisfies readonly MemoryMcpToolName[];

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
  readonly maxLength?: number;
  readonly maxItems?: number;
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
    description: 'Search the caller-bound memory namespace with a text query. Use it before answering when prior project or user context may matter; returns compact hits with ids, summaries, match kind, and a typed sourceLookup object that shows exactly how to fetch details. If a relevant summary may affect the answer but is not enough, call get_memory_sources with the returned sourceLookup fields. The query is text only; embeddings and vectors are computed internally when available.',
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
    description: 'List recent processed memory summaries for the caller-bound project without requiring a text query. Use it when the user asks for recent task summaries, recent project context, or a compact memory digest; each returned item includes a compact ref plus sourceLookup so details can be fetched with get_memory_sources only when needed.',
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
    description: 'Fetch source snippets for a projection id, observation id, or compact ref returned by memory search/startup memory. Use it after search_memory or when startup context gives a ref for exact prior instructions, decisions, preferences, bug details, commit/deployment facts, or provenance-sensitive answers; missing or cross-namespace ids return an empty source list without revealing which case occurred.',
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
    description: 'Archive a processed memory projection in the caller-bound project namespace so normal search, recall, and startup-context injection stop returning it. Caller identity and namespace are runtime-bound; provide only a projectionId or compact proj: ref previously returned by search_memory/list_memory_summaries.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Projection id from search_memory/list_memory_summaries for the memory to archive. Caller identity and namespace are runtime-bound.'),
      ref: stringSchema('Optional compact projection ref such as proj:abc123 returned by search_memory/list_memory_summaries. Do not combine with projectionId.'),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.RESTORE_MEMORY]: {
    name: MEMORY_MCP_TOOL_NAMES.RESTORE_MEMORY,
    description: 'Restore an archived processed memory projection in the caller-bound project namespace so normal search, recall, and startup-context injection can return it again. Caller identity and namespace are runtime-bound; provide only a projectionId or compact proj: ref.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Projection id for the archived memory to restore. Caller identity and namespace are runtime-bound.'),
      ref: stringSchema('Optional compact projection ref such as proj:abc123. Do not combine with projectionId.'),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY]: {
    name: MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY,
    description: 'Permanently delete a processed memory projection in the caller-bound project namespace. This is destructive; prefer archive_memory when the goal is only to stop recall/search from returning a memory. Caller identity and namespace are runtime-bound; provide only a projectionId or compact proj: ref.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Projection id for the memory to permanently delete. Caller identity and namespace are runtime-bound.'),
      ref: stringSchema('Optional compact projection ref such as proj:abc123. Do not combine with projectionId.'),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY]: {
    name: MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY,
    description: 'Update the summary text of a processed memory projection in the caller-bound project namespace. Use this to correct stale or inaccurate compact memory, not to change identity, scope, owner, or project. Caller identity and namespace are runtime-bound.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Projection id for the memory to update. Caller identity and namespace are runtime-bound.'),
      ref: stringSchema('Optional compact projection ref such as proj:abc123. Do not combine with projectionId.'),
      text: stringSchema('Replacement memory summary text. Must be non-empty after trimming.'),
    }, ['text']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK]: {
    name: MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK,
    description: 'Record relevance feedback for a processed memory projection in the caller-bound project namespace. feedback="not_relevant" archives the memory so future recall/search excludes it; feedback="relevant" records a positive hit so relevance ranking can favor it. Caller identity and namespace are runtime-bound.',
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
    description: 'Save an agent-learned observation as a candidate user-private memory. Use it for durable facts or decisions learned during work; result contains the observation id and fingerprint. Identity, scope, state, origin, and fingerprint are fixed by the runtime, not by arguments.',
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
    description: 'Save a user preference as an active user-private preference memory. Use it only for stable user instructions or preferences; this explicit path does not use text-prefix preference parsing.',
    inputSchema: objectSchema({
      text: stringSchema(`Required preference text, up to ${MEMORY_MCP_CAPS.PREFERENCE_MAX_BYTES} UTF-8 bytes.`),
      idempotencyKey: stringSchema('Optional caller-stable key for safe retries of the same preference.'),
    }, ['text']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]: {
    name: MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS,
    description: 'List sendable sibling sessions in the caller project that send_message may address. The current caller session and stopped sessions are excluded; if this returns no items, direct send_message cannot succeed until another sibling session is available. Use it to find another agent or peer session to delegate to or invite, for example "ask CC to audit", "invite a reviewer to discuss", or "ask another session to plan or implement"; optionally filter with the named agent/session hint, match by display label or target name, then copy the returned target field exactly into send_message. If no matching target is returned, report that no such running peer session is available. Labels are display-only metadata and are not valid MCP targets.',
    inputSchema: objectSchema({
      query: stringSchema('Optional case-insensitive text filter over target display labels and names, such as "cc", "codex", "reviewer", or a session label mentioned by the user.'),
      limit: numberSchema('Optional maximum number of targets to return; implementations may clamp it.'),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]: {
    name: MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
    description: 'Use this to ask, delegate to, or invite another caller-project sibling agent/session using the exact target value returned by send_list_targets, for example asking a CC session to audit something or inviting a reviewer to discuss. send_message delivers a plain text invite/request and does not start a structured Team/P2P discussion run by itself; if a structured discussion run is required, use the dedicated discussion-launch path instead. The caller session is not a valid target, and an empty send_list_targets result means there is no direct send target in scope. Optional files are sanitized path references under the caller project root, not file bytes; accepted sends return shared dispatch and message ids plus per-target delivery status.',
    inputSchema: objectSchema({
      target: stringSchema('Required exact target session value. For an ordinary peer, use the exact send_list_targets.target value. For a follow-up to an execution clone you created, use the exact result.clone.target from the originating clone send — execution clones are NOT returned by send_list_targets and only their creator may address them. Always use the exact target name; never a label or agentType value.'),
      message: stringSchema(`Required complete task/request text to deliver, up to ${MEMORY_MCP_CAPS.SEND_MESSAGE_MAX_BYTES} UTF-8 bytes. Include the desired role and output, such as audit findings, discussion input, plan, implementation request, or verification result.`),
      files: {
        type: 'array',
        description: `Optional file path references under the caller project root; at most ${MEMORY_MCP_CAPS.SEND_FILES_MAX_COUNT}; contents are not read or transferred by MCP.`,
        items: stringSchema(`Relative path or in-root absolute path reference, at most ${MEMORY_MCP_CAPS.SEND_FILE_PATH_MAX_CHARS} characters and without control characters.`),
        maxItems: MEMORY_MCP_CAPS.SEND_FILES_MAX_COUNT,
      },
      reply: booleanSchema('Optional request for the target to reply to the runtime-bound caller session. Set true when you expect the target to respond or report back, such as audit/review requests or discussion invites; leave false for fire-and-forget notifications.'),
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
    description: 'Force-stop the active turn of a caller-project sibling session, using the exact target value returned by send_list_targets. Unlike send_message (which queues behind a busy session), this interrupts the session immediately: transport/SDK sessions cancel the in-flight turn on a priority lane, and terminal sessions receive an interrupt (ESC / Ctrl+C). Use it when a sibling is stuck or running the wrong work and a queued message will not reach it. The caller session is not a valid target. Queued user messages are preserved; only the currently active turn is interrupted.',
    inputSchema: objectSchema({
      target: stringSchema('Exact target session value. Required unless broadcast is true. For an ordinary peer, use the exact send_list_targets.target value. To stop an execution clone you created, use the exact result.clone.target from the originating clone send — execution clones are NOT returned by send_list_targets and only their creator may stop them. Always use the exact target name; never a label or agentType value.'),
      broadcast: booleanSchema('Optional project-scoped request to stop every sendable sibling session; unavailable for unscoped callers.'),
      idempotencyKey: stringSchema(`Optional retry key; duplicate stops within ${MEMORY_MCP_CAPS.SEND_MESSAGE_IDEMPOTENCY_WINDOW_MS} ms reuse the original ids.`),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.DESTROY_EXECUTION_CLONE]: {
    name: MEMORY_MCP_TOOL_NAMES.DESTROY_EXECUTION_CLONE,
    description: 'Destroy a dedicated execution-clone sub-session that you created via send_message with a clone request. Only the creator session may destroy its clone; the runtime resolves authorization. A replay after the clone is already gone returns target_not_found and never recreates it.',
    inputSchema: objectSchema({
      target: stringSchema('Required exact execution-clone session name returned by the original clone send (result.clone.target).'),
      idempotencyKey: stringSchema('Optional caller-stable key for safe retries of the same destroy.'),
    }, ['target']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF,
    description: `Create a scheduled message for the current caller session. Session, project, user, and server identity are detected from the MCP runtime, so do not look up or pass a session id. Use this for reminders or recurring work that this same session should receive; schedules must leave at least ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes between runs.`,
    inputSchema: objectSchema({
      cronExpr: stringSchema(`Required cron expression accepted by the cron service. The server rejects schedules whose next two runs are less than ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes apart.`),
      message: stringSchema('Required prompt or instruction delivered directly to the current caller session when the schedule runs.'),
      name: stringSchema('Optional human-readable job name. When omitted, a short name is derived from the message.'),
      timezone: stringSchema('Optional cron timezone for schedule evaluation only. It does not change how expiresAt is parsed.'),
      expiresAt: stringSchema(`Optional absolute expiration time as epoch milliseconds or an ISO timestamp with an explicit offset or Z suffix, no later than ${MEMORY_MCP_CAPS.CRON_EXPIRES_AT_MAX_DAYS} days from creation.`),
    }, ['cronExpr', 'message']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF,
    description: 'Cancel scheduled jobs belonging to the current caller session without supplying session, project, user, or server identity. Select one job by the id returned from creation, select a uniquely named job by name, or explicitly set all=true to remove every job targeting this session.',
    inputSchema: objectSchema({
      id: stringSchema('Optional exact cron job id returned by cron_create_self or cron_list. Cannot be combined with name or all.'),
      name: stringSchema('Optional exact human-readable job name. It must identify exactly one current-session job and cannot be combined with id or all.'),
      all: booleanSchema('Explicitly cancel every cron job targeting the current caller session. Cannot be combined with id or name.'),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_CREATE]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_CREATE,
    description: `Create a scheduled structured send job through the bound server. Use it for future reminders or delegated messages; caller identity and server binding are runtime-bound, actions must be structured sends, and the cron schedule must leave at least ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes between runs.`,
    inputSchema: objectSchema({
      name: stringSchema('Required human-readable scheduled job name.'),
      cronExpr: stringSchema(`Required cron expression accepted by the cron service. The server rejects schedules whose next two runs are less than ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes apart, for example every-minute expressions such as "* * * * *".`),
      projectName: stringSchema('Optional project name; when supplied it must equal the runtime-bound caller project.'),
      targetRole: stringSchema('Optional source role for the scheduled job row when targetSessionName is omitted; defaults to the project brain session.'),
      targetSessionName: stringSchema('Optional direct source session for the scheduled job row. For send actions, action.target is resolved as a sibling of this source session; the source cannot send to itself.'),
      action: { type: 'object', description: 'Required structured send action with shape { type: "send", target, message, reply?, broadcast?, idempotencyKey? }. The target is resolved at execution time from the source session selected by targetSessionName or targetRole, so prefer an exact sibling session name from send_list_targets when available.', additionalProperties: true },
      timezone: stringSchema('Optional cron timezone for schedule evaluation only. It does not change how expiresAt is parsed.'),
      expiresAt: stringSchema(`Optional absolute expiration time as epoch milliseconds or an ISO timestamp with an explicit offset or Z suffix, no later than ${MEMORY_MCP_CAPS.CRON_EXPIRES_AT_MAX_DAYS} days from creation. Expiration prevents future dispatches after that instant; it does not retract messages already dispatched at or before the cutoff.`),
    }, ['name', 'cronExpr', 'action']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_LIST]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_LIST,
    description: 'List cron jobs visible to the bound user, server, and project. Use it to inspect scheduled work; limit is clamped to the shared maximum and results expose sanitized job fields.',
    inputSchema: objectSchema({
      projectName: stringSchema('Optional project filter; when supplied it must equal the runtime-bound caller project.'),
      limit: numberSchema(`Optional page size, clamped to ${MEMORY_MCP_CAPS.CRON_LIST_MAX_LIMIT}.`, { minimum: 1, maximum: MEMORY_MCP_CAPS.CRON_LIST_MAX_LIMIT }),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_UPDATE]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_UPDATE,
    description: `Update an owned cron job through the bound server. Use it to change schedule fields or keep an MCP-created action as a structured send action; identity and server are runtime-bound, and replacement cron schedules must still leave at least ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes between runs.`,
    inputSchema: objectSchema({
      id: stringSchema('Required cron job id to update.'),
      name: stringSchema('Optional replacement human-readable scheduled job name.'),
      cronExpr: stringSchema(`Optional replacement cron expression accepted by the cron service. The server rejects schedules whose next two runs are less than ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} minutes apart.`),
      projectName: stringSchema('Optional replacement project name; when supplied it must equal the runtime-bound caller project.'),
      targetRole: stringSchema('Optional replacement source role stored on the scheduled job row when targetSessionName is omitted.'),
      targetSessionName: stringSchema('Optional replacement direct source session stored on the scheduled job row. For send actions, action.target is resolved as a sibling of this source session.'),
      action: { type: 'object', description: 'Optional structured send action replacement; non-send actions are not accepted for MCP writes. The send target is resolved from the scheduled source session selected by targetSessionName or targetRole.', additionalProperties: true },
      timezone: stringSchema('Optional replacement cron timezone for schedule evaluation only. It does not change how expiresAt is parsed.'),
      expiresAt: stringSchema(`Optional replacement absolute expiration time as epoch milliseconds or an ISO timestamp with an explicit offset or Z suffix, no later than ${MEMORY_MCP_CAPS.CRON_EXPIRES_AT_MAX_DAYS} days from update. Expiration prevents future dispatches after that instant; it does not retract already dispatched messages.`),
    }, ['id']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_DELETE]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_DELETE,
    description: 'Delete an owned cron job by id through the bound server. Use it to cancel scheduled work; caller identity and server binding are runtime-bound.',
    inputSchema: objectSchema({
      id: stringSchema('Required cron job id to delete.'),
    }, ['id']),
    outputSchema: statusSchema,
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
