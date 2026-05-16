import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  MEMORY_FEATURE_FLAGS,
  MEMORY_FEATURE_FLAGS_BY_NAME,
  memoryFeatureFlagEnvKey,
  resolveEffectiveMemoryFeatureFlags,
  type MemoryFeatureFlag,
  type MemoryFeatureFlagValues,
} from '../../shared/feature-flags.js';
import {
  MEMORY_MCP_DISABLED_FLAGS,
  MEMORY_MCP_TOOL_CONTRACTS,
  MEMORY_MCP_TOOL_NAME_LIST,
  MEMORY_MCP_TOOL_NAMES,
  buildMcpDisabledResult,
  buildMcpErrorResult,
  pickAllowedMcpArgs,
  type MemoryMcpToolName,
} from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import { resolveRuntimeScope } from '../../shared/session-scope.js';
import {
  MCP_FEATURE_FLAGS_BY_NAME,
  isMcpFeatureEnabled,
  type MCPFeatureFlagValues,
} from '../../shared/memory-mcp-feature-flags.js';
import { deriveMemoryToolCaller, type McpRuntimeCaller } from './memory-mcp-caller.js';
import { memoryGetSources } from '../context/memory-read-tools.js';
import { searchMcpMemoryRecall, type MemoryMcpSearchHit, type MemoryMcpSearchResult } from './memory-mcp-search.js';
import type { MemorySearchQuery } from '../context/memory-search.js';
import { saveObservation, savePreference } from '../context/memory-write-tools.js';
import { getMemoryFeatureConfigStoreDiagnostics, getPersistedMemoryFeatureFlagValues, getRuntimeMemoryFeatureFlagValues } from '../store/memory-feature-config-store.js';
import { listSessions as listStoredSessions } from '../store/session-store.js';
import { dispatchSendMessage, listSendTargets, type SendToolDeps } from './send-tool.js';
import { cronMcpCreate, cronMcpDelete, cronMcpList, cronMcpUpdate, type CronMcpClientOptions } from './cron-mcp-client.js';

type ToolResult = Record<string, unknown>;
export type MemoryMcpToolHandler = (input?: unknown) => Promise<ToolResult> | ToolResult;
type MemoryMcpSearch = (query: MemorySearchQuery) => Promise<MemoryMcpSearchResult> | MemoryMcpSearchResult;

export interface MemoryMcpToolDeps {
  featureFlags?: MCPFeatureFlagValues;
  isMemoryFeatureEnabled?: (flag: MemoryFeatureFlag) => boolean;
  searchMemory?: MemoryMcpSearch;
  getMemorySources?: typeof memoryGetSources;
  saveObservation?: typeof saveObservation;
  savePreference?: typeof savePreference;
  sendDeps?: SendToolDeps;
  cronOptions?: CronMcpClientOptions;
  cronCreate?: typeof cronMcpCreate;
  cronUpdate?: typeof cronMcpUpdate;
  cronDelete?: typeof cronMcpDelete;
  cronList?: typeof cronMcpList;
}

function readBooleanEnv(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  return value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : undefined;
}

function readMemoryFeatureEnvironmentDefaults(): MemoryFeatureFlagValues {
  const environmentStartupDefault: MemoryFeatureFlagValues = {};
  for (const flag of MEMORY_FEATURE_FLAGS) {
    const envValue = readBooleanEnv(process.env[memoryFeatureFlagEnvKey(flag)]);
    if (envValue !== undefined) environmentStartupDefault[flag] = envValue;
  }
  return environmentStartupDefault;
}

function defaultMemoryFeatureEnabled(flag: MemoryFeatureFlag): boolean {
  return resolveEffectiveMemoryFeatureFlags({
    runtimeConfigOverride: getRuntimeMemoryFeatureFlagValues(),
    persistedConfig: getPersistedMemoryFeatureFlagValues(),
    environmentStartupDefault: readMemoryFeatureEnvironmentDefaults(),
    readFailed: !!getMemoryFeatureConfigStoreDiagnostics().lastLoadIssue,
  })[flag];
}

function isMcpMemorySurfaceEnabled(deps: MemoryMcpToolDeps): boolean {
  return isMcpFeatureEnabled(deps.featureFlags, MCP_FEATURE_FLAGS_BY_NAME.memorySurface);
}

function disabled(disabledFlag: string, extra: Record<string, unknown> = {}): ToolResult {
  return buildMcpDisabledResult(disabledFlag, extra);
}

function error(reason: MCPErrorReason, message?: string): ToolResult {
  return buildMcpErrorResult(reason, message);
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === 'boolean' ? args[key] : undefined;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function parseExpiresAt(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function sanitizeCaughtError(err: unknown): ToolResult {
  return error(MCP_ERROR_REASONS.INTERNAL_ERROR, sanitizeMcpErrorMessage(err));
}

function memoryGate(
  deps: MemoryMcpToolDeps,
  flag: MemoryFeatureFlag,
  disabledFlag: string,
  extra: Record<string, unknown> = {},
): ToolResult | null {
  if (!isMcpMemorySurfaceEnabled(deps)) {
    return disabled(MEMORY_MCP_DISABLED_FLAGS.MEMORY_SURFACE, extra);
  }
  const isEnabled = deps.isMemoryFeatureEnabled ?? defaultMemoryFeatureEnabled;
  if (!isEnabled(flag)) return disabled(disabledFlag, extra);
  return null;
}

function memorySurfaceGate(deps: MemoryMcpToolDeps, extra: Record<string, unknown> = {}): ToolResult | null {
  return isMcpMemorySurfaceEnabled(deps) ? null : disabled(MEMORY_MCP_DISABLED_FLAGS.MEMORY_SURFACE, extra);
}

function compactSearchHit(item: MemoryMcpSearchHit) {
  return {
    projectionId: item.projectionId,
    summary: item.summary,
    projectionClass: item.projectionClass,
    projectId: item.projectId,
    scope: item.scope,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    relevanceScore: item.relevanceScore,
    source: item.source,
    // Surface the originating daemon so callers can locate the raw events
    // for follow-up source resolution. Omitted (not null) when unknown, to
    // keep the wire shape minimal for older clients that ignore the field.
    ...(typeof item.originServerId === 'string' && item.originServerId
      ? { originServerId: item.originServerId }
      : {}),
  };
}

function scopedCallerForDeps(caller: McpRuntimeCaller, deps: MemoryMcpToolDeps): McpRuntimeCaller {
  const sessions = deps.sendDeps?.listSessions ? deps.sendDeps.listSessions() : listStoredSessions();
  const scope = resolveRuntimeScope(caller, sessions);
  return {
    ...caller,
    projectName: scope.projectName,
    projectRoot: scope.projectRoot,
    serverId: scope.serverId,
  };
}

function resolveCronProjectName(caller: McpRuntimeCaller, deps: MemoryMcpToolDeps, args: Record<string, unknown>, toolName: string): string | ToolResult {
  const scopedCaller = scopedCallerForDeps(caller, deps);
  const callerProjectName = typeof scopedCaller.projectName === 'string' && scopedCaller.projectName.trim()
    ? scopedCaller.projectName.trim()
    : undefined;
  const requestedProjectName = stringArg(args, 'projectName');
  if (!callerProjectName) {
    return error(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, `${toolName} requires a project-scoped caller`);
  }
  if (requestedProjectName && requestedProjectName !== callerProjectName) {
    return error(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, `${toolName} cannot target a project outside the caller project`);
  }
  return callerProjectName;
}

function cronOptionsForCaller(caller: McpRuntimeCaller, deps: MemoryMcpToolDeps): CronMcpClientOptions | ToolResult {
  const runtimeServerId = typeof caller.serverId === 'string' && caller.serverId.trim()
    ? caller.serverId.trim()
    : undefined;
  return {
    ...deps.cronOptions,
    ...(runtimeServerId ? { runtimeServerId } : {}),
  };
}

export function createMemoryMcpToolHandlers(caller: McpRuntimeCaller, deps: MemoryMcpToolDeps = {}): Record<MemoryMcpToolName, MemoryMcpToolHandler> {
  const searchMemory = deps.searchMemory ?? searchMcpMemoryRecall;
  const getMemorySources = deps.getMemorySources ?? memoryGetSources;
  const saveObservationTool = deps.saveObservation ?? saveObservation;
  const savePreferenceTool = deps.savePreference ?? savePreference;
  const cronCreate = deps.cronCreate ?? cronMcpCreate;
  const cronUpdate = deps.cronUpdate ?? cronMcpUpdate;
  const cronDelete = deps.cronDelete ?? cronMcpDelete;
  const cronList = deps.cronList ?? cronMcpList;

  const memoryCaller = () => deriveMemoryToolCaller(scopedCallerForDeps(caller, deps));

  return wrapHandlers({
    [MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]: async (input) => {
      const gate = memoryGate(deps, MEMORY_FEATURE_FLAGS_BY_NAME.quickSearch, MEMORY_MCP_DISABLED_FLAGS.QUICK_SEARCH, { items: [] });
      if (gate) return gate;
      const args = pickAllowedMcpArgs(input, ['query', 'limit']);
      const query = stringArg(args, 'query');
      if (!query) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'query is required');
      const limit = numberArg(args, 'limit');
      try {
        const scopedCaller = memoryCaller();
        const result = await searchMemory({
          query,
          namespace: scopedCaller.namespace,
          currentEnterpriseId: scopedCaller.namespace.enterpriseId,
          repo: scopedCaller.namespace.projectId,
          includeLegacyPersonalOwner: true,
          limit,
        });
        const items = result.items.map(compactSearchHit);
        return { status: 'ok', items };
      } catch (err) {
        return sanitizeCaughtError(err);
      }
    },
    [MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]: (input) => {
      const gate = memorySurfaceGate(deps, { sources: [] });
      if (gate) return gate;
      const args = pickAllowedMcpArgs(input, ['projectionId']);
      const projectionId = stringArg(args, 'projectionId');
      if (!projectionId) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'projectionId is required');
      try {
        return { status: 'ok', ...getMemorySources(projectionId, memoryCaller()) };
      } catch (err) {
        return sanitizeCaughtError(err);
      }
    },
    [MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION]: (input) => {
      const gate = memoryGate(deps, MEMORY_FEATURE_FLAGS_BY_NAME.observationStore, MEMORY_MCP_DISABLED_FLAGS.OBSERVATION_STORE);
      if (gate) return gate;
      return saveObservationTool(pickAllowedMcpArgs(input, ['content', 'tags', 'turnId', 'idempotencyKey']), memoryCaller()) as unknown as ToolResult;
    },
    [MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE]: (input) => {
      const gate = memoryGate(deps, MEMORY_FEATURE_FLAGS_BY_NAME.preferences, MEMORY_MCP_DISABLED_FLAGS.PREFERENCES);
      if (gate) return gate;
      return savePreferenceTool(pickAllowedMcpArgs(input, ['text', 'idempotencyKey']), memoryCaller()) as unknown as ToolResult;
    },
    [MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]: (input) => {
      const args = pickAllowedMcpArgs(input, ['query', 'limit']);
      return listSendTargets(caller, {
        query: stringArg(args, 'query'),
        limit: numberArg(args, 'limit'),
      }, {
        ...deps.sendDeps,
        isDispatchEnabled: () => deps.sendDeps?.isDispatchEnabled?.() ?? true,
      }) as unknown as ToolResult;
    },
    [MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['target', 'message', 'files', 'reply', 'broadcast', 'idempotencyKey']);
      return dispatchSendMessage(caller, {
        target: stringArg(args, 'target'),
        message: stringArg(args, 'message'),
        files: stringArrayArg(args, 'files'),
        reply: boolArg(args, 'reply'),
        broadcast: boolArg(args, 'broadcast'),
        idempotencyKey: stringArg(args, 'idempotencyKey'),
      }, {
        ...deps.sendDeps,
        isDispatchEnabled: () => deps.sendDeps?.isDispatchEnabled?.() ?? true,
        exactTargetOnly: true,
      }) as unknown as Promise<ToolResult>;
    },
    [MEMORY_MCP_TOOL_NAMES.CRON_CREATE]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['name', 'cronExpr', 'projectName', 'targetRole', 'targetSessionName', 'action', 'timezone', 'expiresAt']);
      const expiresAt = parseExpiresAt(args.expiresAt);
      if (Number.isNaN(expiresAt)) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'expiresAt must be a timestamp or ISO string');
      const scopedCaller = scopedCallerForDeps(caller, deps);
      const projectName = resolveCronProjectName(caller, deps, args, MEMORY_MCP_TOOL_NAMES.CRON_CREATE);
      if (typeof projectName !== 'string') return projectName;
      const cronOptions = cronOptionsForCaller(caller, deps);
      if ('status' in cronOptions) return cronOptions;
      return cronCreate({
        name: stringArg(args, 'name') ?? '',
        cronExpr: stringArg(args, 'cronExpr') ?? '',
        projectName,
        targetRole: stringArg(args, 'targetRole'),
        targetSessionName: stringArg(args, 'targetSessionName') ?? null,
        action: args.action,
        sourceSessionName: scopedCaller.sessionName ?? undefined,
        sourceProjectName: projectName,
        sourceServerId: scopedCaller.serverId ?? undefined,
        timezone: stringArg(args, 'timezone'),
        expiresAt,
      }, cronOptions) as unknown as Promise<ToolResult>;
    },
    [MEMORY_MCP_TOOL_NAMES.CRON_LIST]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['projectName', 'limit']);
      const projectName = resolveCronProjectName(caller, deps, args, MEMORY_MCP_TOOL_NAMES.CRON_LIST);
      if (typeof projectName !== 'string') return projectName;
      const cronOptions = cronOptionsForCaller(caller, deps);
      if ('status' in cronOptions) return cronOptions;
      return cronList({
        projectName,
        limit: numberArg(args, 'limit'),
      }, cronOptions) as unknown as Promise<ToolResult>;
    },
    [MEMORY_MCP_TOOL_NAMES.CRON_UPDATE]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['id', 'name', 'cronExpr', 'projectName', 'targetRole', 'targetSessionName', 'action', 'timezone', 'expiresAt']);
      const id = stringArg(args, 'id');
      if (!id) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'id is required');
      const expiresAt = parseExpiresAt(args.expiresAt);
      if (Number.isNaN(expiresAt)) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'expiresAt must be a timestamp or ISO string');
      const scopedCaller = scopedCallerForDeps(caller, deps);
      const projectName = resolveCronProjectName(caller, deps, args, MEMORY_MCP_TOOL_NAMES.CRON_UPDATE);
      if (typeof projectName !== 'string') return projectName;
      const cronOptions = cronOptionsForCaller(caller, deps);
      if ('status' in cronOptions) return cronOptions;
      return cronUpdate({
        id,
        name: stringArg(args, 'name'),
        cronExpr: stringArg(args, 'cronExpr'),
        projectName,
        targetRole: stringArg(args, 'targetRole'),
        targetSessionName: stringArg(args, 'targetSessionName') ?? undefined,
        action: args.action,
        sourceSessionName: scopedCaller.sessionName ?? undefined,
        sourceProjectName: projectName,
        sourceServerId: scopedCaller.serverId ?? undefined,
        timezone: stringArg(args, 'timezone'),
        expiresAt,
      }, cronOptions) as unknown as Promise<ToolResult>;
    },
    [MEMORY_MCP_TOOL_NAMES.CRON_DELETE]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['id']);
      const id = stringArg(args, 'id');
      if (!id) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'id is required');
      const cronOptions = cronOptionsForCaller(caller, deps);
      if ('status' in cronOptions) return cronOptions;
      return cronDelete(id, cronOptions) as unknown as Promise<ToolResult>;
    },
  });
}

function wrapHandlers(handlers: Record<MemoryMcpToolName, MemoryMcpToolHandler>): Record<MemoryMcpToolName, MemoryMcpToolHandler> {
  const wrapped = {} as Record<MemoryMcpToolName, MemoryMcpToolHandler>;
  for (const name of MEMORY_MCP_TOOL_NAME_LIST) {
    wrapped[name] = async (input?: unknown) => {
      try {
        return await handlers[name](input);
      } catch (err) {
        return sanitizeCaughtError(err);
      }
    };
  }
  return wrapped;
}

function toolResult(result: ToolResult): CallToolResult {
  return {
    structuredContent: result,
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: result.status === 'error',
  };
}

const schemas = {
  [MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY]: z.object({
    query: z.string().describe('Required text query to search for.'),
    limit: z.number().int().min(1).max(100).optional().describe('Optional maximum hit count.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]: z.object({
    projectionId: z.string().describe('Projection id returned by search_memory.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION]: z.object({
    content: z.string().describe('Observation text to persist as a candidate memory.'),
    tags: z.array(z.string()).optional().describe('Optional short tags.'),
    turnId: z.string().optional().describe('Optional source turn or event id.'),
    idempotencyKey: z.string().optional().describe('Optional retry key.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE]: z.object({
    text: z.string().describe('Preference text to persist.'),
    idempotencyKey: z.string().optional().describe('Optional retry key.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]: z.object({
    query: z.string().optional().describe('Optional target filter.'),
    limit: z.number().int().min(1).max(100).optional().describe('Optional result limit.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]: z.object({
    target: z.string().describe('Sibling target from send_list_targets.'),
    message: z.string().describe('Message text to send.'),
    files: z.array(z.string()).optional().describe('Project-root file path references; no bytes are transferred.'),
    reply: z.boolean().optional().describe('Ask target to reply to the caller session.'),
    broadcast: z.boolean().optional().describe('Broadcast within the caller project.'),
    idempotencyKey: z.string().optional().describe('Retry key for accepted send replay.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_CREATE]: z.object({
    name: z.string().describe('Cron job name.'),
    cronExpr: z.string().describe('Cron expression accepted by the cron service.'),
    projectName: z.string().optional().describe('Project name; defaults to caller project when available.'),
    targetRole: z.string().optional().describe('Target role for the scheduled job row.'),
    targetSessionName: z.string().nullable().optional().describe('Optional direct target session for the job row.'),
    action: z.record(z.string(), z.unknown()).describe('Structured send action.'),
    timezone: z.string().optional().describe('Optional cron timezone.'),
    expiresAt: z.union([z.number(), z.string(), z.null()]).optional().describe('Optional expiration timestamp or ISO string, capped at 90 days.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_LIST]: z.object({
    projectName: z.string().optional().describe('Optional project filter.'),
    limit: z.number().int().min(1).max(100).optional().describe('Optional page size clamped to 100.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_UPDATE]: z.object({
    id: z.string().describe('Cron job id.'),
    name: z.string().optional().describe('Optional replacement job name.'),
    cronExpr: z.string().optional().describe('Optional replacement cron expression.'),
    projectName: z.string().optional().describe('Optional replacement project name.'),
    targetRole: z.string().optional().describe('Optional replacement target role.'),
    targetSessionName: z.string().nullable().optional().describe('Optional replacement direct target session.'),
    action: z.record(z.string(), z.unknown()).optional().describe('Optional replacement structured send action.'),
    timezone: z.string().optional().describe('Optional replacement timezone.'),
    expiresAt: z.union([z.number(), z.string(), z.null()]).optional().describe('Optional replacement expiration timestamp or ISO string.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_DELETE]: z.object({
    id: z.string().describe('Cron job id to delete.'),
  }),
} as const;

export function listMemoryMcpToolDescriptors() {
  return MEMORY_MCP_TOOL_NAME_LIST.map((name) => MEMORY_MCP_TOOL_CONTRACTS[name]);
}

export function registerMemoryMcpTools(server: McpServer, caller: McpRuntimeCaller, deps: MemoryMcpToolDeps = {}): void {
  const handlers = createMemoryMcpToolHandlers(caller, deps);
  for (const name of MEMORY_MCP_TOOL_NAME_LIST) {
    const contract = MEMORY_MCP_TOOL_CONTRACTS[name];
    server.registerTool(name, {
      title: name,
      description: contract.description,
      inputSchema: schemas[name],
    }, async (args: unknown) => toolResult(await handlers[name](args)));
  }
}
