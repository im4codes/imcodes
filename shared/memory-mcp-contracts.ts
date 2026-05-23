import { MCP_ERROR_REASONS, isRecoverableMcpErrorReason, type MCPErrorReason } from './memory-mcp-errors.js';
import { MEMORY_FEATURE_FLAGS_BY_NAME } from './feature-flags.js';
import { MCP_FEATURE_FLAGS_BY_NAME } from './memory-mcp-feature-flags.js';
import { MEMORY_MCP_SOURCE_FIELDS } from './memory-mcp-provenance.js';
import { PREFERENCE_MAX_BYTES } from './preference-ingest.js';

export const MEMORY_MCP_TOOL_NAMES = {
  SEARCH_MEMORY: 'search_memory',
  GET_MEMORY_SOURCES: 'get_memory_sources',
  SAVE_OBSERVATION: 'save_observation',
  SAVE_PREFERENCE: 'save_preference',
  SEND_LIST_TARGETS: 'send_list_targets',
  SEND_MESSAGE: 'send_message',
  CRON_CREATE: 'cron_create',
  CRON_LIST: 'cron_list',
  CRON_UPDATE: 'cron_update',
  CRON_DELETE: 'cron_delete',
} as const;

export type MemoryMcpToolName = (typeof MEMORY_MCP_TOOL_NAMES)[keyof typeof MEMORY_MCP_TOOL_NAMES];

export const MEMORY_MCP_TOOL_NAME_LIST = [
  MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY,
  MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
  MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION,
  MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE,
  MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS,
  MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
  MEMORY_MCP_TOOL_NAMES.CRON_CREATE,
  MEMORY_MCP_TOOL_NAMES.CRON_LIST,
  MEMORY_MCP_TOOL_NAMES.CRON_UPDATE,
  MEMORY_MCP_TOOL_NAMES.CRON_DELETE,
] as const satisfies readonly MemoryMcpToolName[];

export const MEMORY_MCP_CAPS = {
  SEARCH_MEMORY_DEFAULT_LIMIT: 10,
  SEARCH_MEMORY_MAX_LIMIT: 100,
  OBSERVATION_CONTENT_MAX_BYTES: 16 * 1024,
  OBSERVATION_TAGS_MAX_COUNT: 8,
  OBSERVATION_TAG_MAX_CHARS: 64,
  PREFERENCE_MAX_BYTES,
  SEND_MESSAGE_IDEMPOTENCY_WINDOW_MS: 5_000,
  SEND_MESSAGE_MAX_BYTES: 64 * 1024,
  SEND_FILES_MAX_COUNT: 32,
  SEND_FILE_PATH_MAX_CHARS: 512,
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
    description: 'Search the caller-bound memory namespace with a text query. Use it before answering when prior project or user context may matter; returns compact hits with projection ids and summaries for optional source lookup. If a relevant summary may affect the answer but is not enough, call get_memory_sources with its projection id. The query is text only; embeddings and vectors are computed internally when available.',
    inputSchema: objectSchema({
      query: stringSchema('Required text query to search for. Do not send embeddings, vectors, identity, or namespace fields.'),
      limit: numberSchema(`Optional maximum hit count; defaults to ${MEMORY_MCP_CAPS.SEARCH_MEMORY_DEFAULT_LIMIT} and is clamped to ${MEMORY_MCP_CAPS.SEARCH_MEMORY_MAX_LIMIT}.`, { minimum: 1, maximum: MEMORY_MCP_CAPS.SEARCH_MEMORY_MAX_LIMIT }),
    }, ['query']),
    outputSchema: objectSchema({
      status: stringSchema('ok, disabled, or error.'),
      items: { type: 'array', description: 'Compact same-namespace memory hits.', items: { type: 'object', additionalProperties: true } },
    }),
  },
  [MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]: {
    name: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
    description: 'Fetch source event snippets for a projection id returned by memory search. Use it after search_memory for exact prior instructions, decisions, preferences, bug details, commit/deployment facts, or provenance-sensitive answers; missing or cross-namespace ids return an empty source list without revealing which case occurred.',
    inputSchema: objectSchema({
      projectionId: stringSchema('Required projection id from search_memory. Caller identity and namespace are runtime-bound.'),
    }, ['projectionId']),
    outputSchema: objectSchema({
      projectionId: stringSchema('Requested projection id.'),
      sources: { type: 'array', description: 'Source snippets visible to the caller namespace.', items: { type: 'object', additionalProperties: true } },
    }),
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
    description: 'List sibling sessions in the caller project that send_message may address. Use it before sending when the target name is unclear; copy the returned target field exactly into send_message. Labels are display-only metadata and are not valid MCP targets.',
    inputSchema: objectSchema({
      query: stringSchema('Optional text filter over target labels and names.'),
      limit: numberSchema('Optional maximum number of targets to return; implementations may clamp it.'),
    }),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]: {
    name: MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
    description: 'Send a plain message to a caller-project sibling session using the exact target value returned by send_list_targets. Optional files are sanitized path references under the caller project root, not file bytes; accepted sends return shared dispatch and message ids plus per-target delivery status.',
    inputSchema: objectSchema({
      target: stringSchema('Required exact target value returned by send_list_targets.target. Do not use label or agentType values.'),
      message: stringSchema(`Required message text to deliver, up to ${MEMORY_MCP_CAPS.SEND_MESSAGE_MAX_BYTES} UTF-8 bytes.`),
      files: {
        type: 'array',
        description: `Optional file path references under the caller project root; at most ${MEMORY_MCP_CAPS.SEND_FILES_MAX_COUNT}; contents are not read or transferred by MCP.`,
        items: stringSchema(`Relative path or in-root absolute path reference, at most ${MEMORY_MCP_CAPS.SEND_FILE_PATH_MAX_CHARS} characters and without control characters.`),
        maxItems: MEMORY_MCP_CAPS.SEND_FILES_MAX_COUNT,
      },
      reply: booleanSchema('Optional request for the target to reply to the runtime-bound caller session.'),
      broadcast: booleanSchema('Optional project-scoped broadcast request; unavailable for unscoped callers.'),
      idempotencyKey: stringSchema(`Optional retry key; duplicate sends within ${MEMORY_MCP_CAPS.SEND_MESSAGE_IDEMPOTENCY_WINDOW_MS} ms reuse the original ids.`),
    }, ['target', 'message']),
    outputSchema: statusSchema,
  },
  [MEMORY_MCP_TOOL_NAMES.CRON_CREATE]: {
    name: MEMORY_MCP_TOOL_NAMES.CRON_CREATE,
    description: 'Create a scheduled structured send job through the bound server. Use it for future reminders or delegated messages; caller identity and server binding are runtime-bound and actions must be structured sends.',
    inputSchema: objectSchema({
      name: stringSchema('Required human-readable scheduled job name.'),
      cronExpr: stringSchema('Required cron expression accepted by the cron service.'),
      projectName: stringSchema('Optional project name; when supplied it must equal the runtime-bound caller project.'),
      targetRole: stringSchema('Optional target role stored on the scheduled job row.'),
      targetSessionName: stringSchema('Optional direct target session stored on the scheduled job row.'),
      action: { type: 'object', description: 'Required structured send action with type send, target, and message.', additionalProperties: true },
      timezone: stringSchema('Optional cron timezone for schedule evaluation.'),
      expiresAt: stringSchema(`Optional ISO timestamp no later than ${MEMORY_MCP_CAPS.CRON_EXPIRES_AT_MAX_DAYS} days from creation.`),
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
    description: 'Update an owned cron job through the bound server. Use it to change schedule fields or keep an MCP-created action as a structured send action; identity and server are runtime-bound.',
    inputSchema: objectSchema({
      id: stringSchema('Required cron job id to update.'),
      name: stringSchema('Optional replacement human-readable scheduled job name.'),
      cronExpr: stringSchema('Optional replacement cron expression accepted by the cron service.'),
      projectName: stringSchema('Optional replacement project name; when supplied it must equal the runtime-bound caller project.'),
      targetRole: stringSchema('Optional replacement target role stored on the scheduled job row.'),
      targetSessionName: stringSchema('Optional replacement direct target session stored on the scheduled job row.'),
      action: { type: 'object', description: 'Optional structured send action replacement; non-send actions are not accepted for MCP writes.', additionalProperties: true },
      timezone: stringSchema('Optional replacement cron timezone for schedule evaluation.'),
      expiresAt: stringSchema(`Optional ISO timestamp no later than ${MEMORY_MCP_CAPS.CRON_EXPIRES_AT_MAX_DAYS} days from update.`),
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
