import { z } from 'zod';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
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
  MEMORY_MCP_CAPS,
  pickAllowedMcpArgs,
  advertisedMcpToolNames,
  type MemoryMcpToolName,
} from '../../shared/memory-mcp-contracts.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import {
  NODE_ROLE,
  ENROLLMENT_OSES,
  REMOTE_EXEC_OUTCOMES,
  REMOTE_EXEC_MIN_TIMEOUT_MS,
  REMOTE_EXEC_SHELLS,
  REMOTE_EXEC_MAX_COMMAND_BYTES,
  REMOTE_EXEC_MAX_OUTPUT_BYTES,
  REMOTE_EXEC_MAX_ERROR_BYTES,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
  MACHINE_LIST_MAX_ITEMS,
  utf8ByteLength,
  type NodeRole,
  type EnrollmentOs,
  type RemoteExecShell,
  type RemoteExecOutcome,
  type RemoteExecOutputChunk,
} from '../../shared/remote-exec.js';
import {
  COMPUTER_USE_DOC_TOPICS,
  COMPUTER_USE_DRAG_DURATION_MAX_MS,
  COMPUTER_USE_DRAG_DURATION_MIN_MS,
  COMPUTER_USE_TOOLS,
  COMPUTER_USE_OUTCOMES,
  COMPUTER_USE_MIN_TIMEOUT_MS,
  COMPUTER_USE_SHELL_SESSION1_MAX_TIMEOUT_MS,
  COMPUTER_USE_MAX_ARGUMENT_BYTES,
  COMPUTER_USE_MAX_TEXT_BYTES,
  COMPUTER_USE_MAX_IMAGE_BASE64_BYTES,
  COMPUTER_USE_MAX_ERROR_BYTES,
  COMPUTER_USE_IMAGE_MIME_TYPES,
  computerUseDocs,
  computerUseMaxTimeoutMs,
  type ComputerUseDocTopic,
  type ComputerUseToolName,
  type ComputerUseOutcome,
  type ComputerUseResult,
} from '../../shared/computer-use.js';
import { FILE_TRANSFER_LIMITS, FILE_TRANSFER_PATH_MAX_BYTES } from '../../shared/transport/file-transfer.js';
import { isValidMachineName, isValidMachineTarget, normalizeMachineTarget } from '../../shared/machine-reference.js';
import { MEMORY_PROJECT_SCOPE_REASON } from '../../shared/memory-project-scope.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import { resolveEffectiveProjectName, resolveRuntimeScope } from '../../shared/session-scope.js';
import {
  MCP_FEATURE_FLAGS_BY_NAME,
  isMcpFeatureEnabled,
  type MCPFeatureFlagValues,
} from '../../shared/memory-mcp-feature-flags.js';
import { MEMORY_MCP_DEGRADED_REASON } from '../../shared/memory-ws.js';
import type { ContextNamespace, ProcessedContextProjection } from '../../shared/context-types.js';
import { LEGACY_DAEMON_LOCAL_USER_ID } from '../../shared/memory-namespace.js';
import { EXECUTION_CLONE_KIND, EXECUTION_CLONE_PARENT_STAGES, isExecutionCloneParentStage } from '../../shared/execution-clone.js';
import { deriveMemoryToolCaller, type McpRuntimeCaller } from './memory-mcp-caller.js';
import { memoryGetSources } from '../context/memory-read-tools.js';
import { getMemorySourcesOrchestrated, type GetSourcesOrchestratorResult, type OrchestratorDeps } from './memory-get-sources-orchestrator.js';
import { listMcpMemorySummaries, searchMcpMemoryRecall, type MemoryMcpListProjectionClass, type MemoryMcpSearchHit, type MemoryMcpSearchResult } from './memory-mcp-search.js';
import type { MemorySearchQuery } from '../context/memory-search.js';
import { saveObservation, savePreference } from '../context/memory-write-tools.js';
import { serializeContextNamespace } from '../context/context-keys.js';
import { publishRuntimeMemoryCacheInvalidation } from '../context/runtime-memory-cache-bus.js';
import { getMemoryFeatureConfigStoreDiagnostics, getPersistedMemoryFeatureFlagValues, getRuntimeMemoryFeatureFlagValues } from '../store/memory-feature-config-store.js';
import { getContextStoreClient } from '../store/context-store-worker-client.js';
import { listSessions as listStoredSessions, loadStore, type SessionRecord } from '../store/session-store.js';
import { dispatchDestroyExecutionClone, dispatchSendMessage, dispatchSendStop, listSendTargets, type SendMessageCloneRequest, type SendToolDeps } from './send-tool.js';
import { cronMcpCreate, cronMcpCreateSelf, cronMcpDelete, cronMcpList, cronMcpUpdate, cronMcpUpdateSelf, type CronMcpClientOptions } from './cron-mcp-client.js';
import { registerMemoryShortRef, resolveMemoryShortRef } from '../context/memory-short-ref.js';
import { GitOriginRepositoryIdentityService } from '../agent/repository-identity-service.js';
import { ALIAS_MCP_TOOLS, toAliasMetadata, type AliasMcpToolName } from '../../shared/alias-types.js';
import {
  aliasMcpList,
  aliasMcpResolve,
  aliasMcpUpsert,
  aliasMcpDelete,
  type AliasMcpClientOptions,
} from './alias-mcp-client.js';

type ToolResult = Record<string, unknown>;
export interface MemoryMcpToolContext {
  signal?: AbortSignal;
  onProgress?: (chunk: RemoteExecOutputChunk) => void | Promise<void>;
}
export type MemoryMcpToolHandler = (input?: unknown, context?: MemoryMcpToolContext) => Promise<ToolResult> | ToolResult;
type MemoryMcpSearch = (query: MemorySearchQuery) => Promise<MemoryMcpSearchResult> | MemoryMcpSearchResult;
type MemoryMcpListSummaries = (query: {
  namespace?: MemorySearchQuery['namespace'];
  currentEnterpriseId?: string;
  repo?: string;
  userId?: string;
  includeLegacyPersonalOwner?: boolean;
  projectionClass?: MemoryMcpListProjectionClass;
  limit?: number;
}) => Promise<MemoryMcpSearchResult> | MemoryMcpSearchResult;

const repositoryIdentityService = new GitOriginRepositoryIdentityService();

export interface MemoryMcpToolDeps {
  featureFlags?: MCPFeatureFlagValues;
  isMemoryFeatureEnabled?: (flag: MemoryFeatureFlag) => boolean;
  searchMemory?: MemoryMcpSearch;
  listMemorySummaries?: MemoryMcpListSummaries;
  /**
   * @deprecated kept for tests that want to short-circuit local lookups.
   * Production code uses the orchestrator which itself delegates to
   * `memoryGetSources` for the same-server path.
   */
  getMemorySources?: typeof memoryGetSources;
  /**
   * Orchestrator override. Tests inject a fake to exercise local-vs-remote
   * branching without going through the cache or HTTP. When absent, the
   * real `getMemorySourcesOrchestrated` is used.
   */
  getMemorySourcesOrchestrator?: (
    projectionId: string,
    caller: Parameters<typeof memoryGetSources>[1],
    deps?: OrchestratorDeps,
  ) => Promise<GetSourcesOrchestratorResult>;
  /** Deps forwarded to the orchestrator (fetchImpl, loadCredentials, cache). */
  orchestratorDeps?: OrchestratorDeps;
  saveObservation?: typeof saveObservation;
  savePreference?: typeof savePreference;
  getProcessedProjectionById?: (id: string) => Promise<ProcessedContextProjection | undefined> | ProcessedContextProjection | undefined;
  archiveMemory?: (id: string) => Promise<boolean> | boolean;
  restoreArchivedMemory?: (id: string) => Promise<boolean> | boolean;
  deleteMemory?: (id: string) => Promise<boolean> | boolean;
  updateProcessedProjectionSummary?: (input: {
    projectionId: string;
    summary: string;
    ownerUserId?: string;
    updatedByUserId?: string;
  }) => Promise<ProcessedContextProjection | null> | ProcessedContextProjection | null;
  recordMemoryHits?: (ids: string[]) => Promise<void> | void;
  sendDeps?: SendToolDeps;
  cronOptions?: CronMcpClientOptions;
  cronCreate?: typeof cronMcpCreate;
  cronCreateSelf?: typeof cronMcpCreateSelf;
  cronUpdateSelf?: typeof cronMcpUpdateSelf;
  cronUpdate?: typeof cronMcpUpdate;
  cronDelete?: typeof cronMcpDelete;
  cronList?: typeof cronMcpList;
  /**
   * Machine remote-exec tools (list_machines / exec_remote). Absent on a node
   * that cannot control machines — the handlers then return a typed
   * feature-disabled error rather than throwing. The production default is
   * wired in `mergeDefaultToolDeps` (relays via the daemon's own credential).
   */
  machineDeps?: MachineToolDeps;
  /**
   * The node's own role. Only FULL nodes advertise the machine tools; a
   * controlled node excludes them from its tool surface (10.12). Defaults to
   * FULL — a controlled node structurally never starts this MCP server anyway,
   * so this is the explicit belt-and-suspenders gate the spec requires.
   */
  nodeRole?: NodeRole;
}

/** One machine in the `list_machines` result (agent-facing, ref_name-keyed). */
export interface MachineSummaryForTool {
  name: string;
  displayName?: string;
  os?: EnrollmentOs;
  online: boolean;
  execEnabled: boolean;
  /** Node role — always `controlled` for controllable machines (spec: list returns role). */
  role: typeof NODE_ROLE.CONTROLLED;
}

/** The end-to-end outcome of `exec_remote`, preserving the discriminated union. */
export interface MachineExecToolResult {
  outcome: RemoteExecOutcome;
  ok?: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  truncated?: boolean;
  durationMs?: number;
  error?: string;
  /** Set when the target is unusable — surfaced as a typed shared MCP error reason. */
  reason?: MCPErrorReason;
}

export interface ComputerUseToolResult {
  outcome: ComputerUseOutcome;
  result?: ComputerUseResult;
  reason?: MCPErrorReason;
  error?: string;
}

export type MachineFileToolResult =
  | { ok: true; size: number; attachmentId: string; remotePath?: string; destinationPath?: string }
  | { ok: false; reason: MCPErrorReason; error?: string };

export interface MachineToolDeps {
  listMachines: (input: { includeOffline?: boolean }) => Promise<MachineSummaryForTool[]> | MachineSummaryForTool[];
  execRemote: (input: {
    machine: string;
    command: string;
    shell?: RemoteExecShell;
    timeoutMs?: number;
    signal?: AbortSignal;
    onOutput?: (chunk: RemoteExecOutputChunk) => void | Promise<void>;
  }) => Promise<MachineExecToolResult> | MachineExecToolResult;
  sendFileToMachine?: (input: {
    machine: string;
    sourcePath: string;
    signal?: AbortSignal;
  }) => Promise<MachineFileToolResult> | MachineFileToolResult;
  fetchFileFromMachine?: (input: {
    machine: string;
    sourcePath: string;
    destinationPath: string;
    overwrite?: boolean;
    signal?: AbortSignal;
  }) => Promise<MachineFileToolResult> | MachineFileToolResult;
  computerUseCall?: (input: {
    machine: string;
    tool: ComputerUseToolName;
    arguments?: Record<string, unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<ComputerUseToolResult> | ComputerUseToolResult;
}

export interface MachineListToolSuccess extends Record<string, unknown> {
  status: 'ok';
  machines: MachineSummaryForTool[];
}

interface MachineExecTerminalFields {
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export type MachineExecToolSuccess = Record<string, unknown> & (
  | { status: 'ok'; outcome: 'not_dispatched' | 'dispatched_no_result' }
  | ({ status: 'ok'; outcome: 'completed'; ok: true; exitCode: number; timedOut: false } & MachineExecTerminalFields)
  | ({ status: 'ok'; outcome: 'node_timeout'; ok: false; exitCode: null; timedOut: true; error: string } & MachineExecTerminalFields)
  | ({ status: 'ok'; outcome: 'spawn_error'; ok: false; exitCode: null; timedOut: false; error: string } & MachineExecTerminalFields)
);

const machineRefNameRuntimeSchema = z.string().refine(isValidMachineName, {
  message: 'must be a valid bare stable machine ref_name',
});

const machineTargetRuntimeSchema = z.string().refine(isValidMachineTarget, {
  message: 'must be a valid stable machine ref_name or complete ^^(ref_name) marker',
});

const machineSummaryShape = {
  name: machineRefNameRuntimeSchema,
  displayName: z.string().optional(),
  os: z.enum(ENROLLMENT_OSES).optional(),
  online: z.boolean(),
  execEnabled: z.boolean(),
  role: z.literal(NODE_ROLE.CONTROLLED),
} as const;

const machineSummaryRuntimeSchema: z.ZodType<MachineSummaryForTool> = z.strictObject(machineSummaryShape);
const machineListDependencyResultSchema = z.array(machineSummaryRuntimeSchema).max(MACHINE_LIST_MAX_ITEMS);

const boundedUtf8String = (maxBytes: number) => z.string().refine(
  (value) => utf8ByteLength(value) <= maxBytes,
  { message: `must be at most ${maxBytes} UTF-8 bytes` },
);

const mcpReasonSchema = z.enum(Object.values(MCP_ERROR_REASONS) as [MCPErrorReason, ...MCPErrorReason[]]);
const machineExecDependencyTerminalBase = {
  stdout: boundedUtf8String(REMOTE_EXEC_MAX_OUTPUT_BYTES),
  stderr: boundedUtf8String(REMOTE_EXEC_MAX_OUTPUT_BYTES),
  truncated: z.boolean(),
  durationMs: z.number().int().safe().nonnegative(),
} as const;
const machineExecDependencyResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('not_dispatched'),
    reason: mcpReasonSchema.optional(),
    error: boundedUtf8String(REMOTE_EXEC_MAX_ERROR_BYTES).optional(),
  }),
  z.strictObject({ outcome: z.literal('dispatched_no_result') }),
  z.strictObject({
    ...machineExecDependencyTerminalBase,
    outcome: z.literal('completed'),
    ok: z.literal(true),
    exitCode: z.number().int().safe(),
    timedOut: z.literal(false),
  }),
  z.strictObject({
    ...machineExecDependencyTerminalBase,
    outcome: z.literal('node_timeout'),
    ok: z.literal(false),
    exitCode: z.null(),
    timedOut: z.literal(true),
    error: boundedUtf8String(REMOTE_EXEC_MAX_ERROR_BYTES).refine((value) => value.length > 0),
  }),
  z.strictObject({
    ...machineExecDependencyTerminalBase,
    outcome: z.literal('spawn_error'),
    ok: z.literal(false),
    exitCode: z.null(),
    timedOut: z.literal(false),
    error: boundedUtf8String(REMOTE_EXEC_MAX_ERROR_BYTES).refine((value) => value.length > 0),
  }),
]).superRefine((result, ctx) => {
  if (result.outcome === 'not_dispatched' && result.error !== undefined && result.reason === undefined) {
    ctx.addIssue({ code: 'custom', message: 'not_dispatched error requires a typed reason' });
  }
});

const computerUseContentItemSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: boundedUtf8String(COMPUTER_USE_MAX_TEXT_BYTES) }),
  z.strictObject({ type: z.literal('image'), data: boundedUtf8String(COMPUTER_USE_MAX_IMAGE_BASE64_BYTES), mimeType: z.enum(COMPUTER_USE_IMAGE_MIME_TYPES) }),
]);

const computerUseResultSchema = z.strictObject({
  correlationId: z.string().min(8).max(128),
  ok: z.boolean(),
  tool: z.enum(COMPUTER_USE_TOOLS),
  content: z.array(computerUseContentItemSchema),
  durationMs: z.number().int().safe().nonnegative(),
  error: boundedUtf8String(COMPUTER_USE_MAX_ERROR_BYTES).optional(),
  timedOut: z.boolean().optional(),
  truncated: z.boolean().optional(),
}).superRefine((result, ctx) => {
  if (result.ok && result.error !== undefined) ctx.addIssue({ code: 'custom', message: 'ok result forbids error' });
  if (!result.ok && result.error === undefined) ctx.addIssue({ code: 'custom', message: 'failed result requires error' });
});

const computerUseDependencyResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('not_dispatched'), reason: mcpReasonSchema.optional(), error: boundedUtf8String(COMPUTER_USE_MAX_ERROR_BYTES).optional() }),
  z.strictObject({ outcome: z.literal('dispatched_no_result') }),
  z.strictObject({ outcome: z.literal('completed'), result: computerUseResultSchema }),
  z.strictObject({ outcome: z.literal('tool_error'), result: computerUseResultSchema }),
]);

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

function machineArg(args: Record<string, unknown>): string | undefined {
  const value = args.machine;
  return typeof value === 'string' ? normalizeMachineTarget(value) ?? undefined : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolArg(args: Record<string, unknown>, key: string): boolean | undefined {
  return typeof args[key] === 'boolean' ? args[key] : undefined;
}

function listProjectionClassArg(args: Record<string, unknown>): MemoryMcpListProjectionClass | undefined {
  const value = args.projectionClass;
  return value === 'recent_summary' || value === 'durable_memory_candidate' ? value : undefined;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/** Allowed keys on a strict `send_message.clone` object — anything else is forged. */
const CLONE_ARG_ALLOWED_KEYS: ReadonlySet<string> = new Set(['kind', 'ephemeral', 'parentRunId', 'parentStage']);

/**
 * Parse + strictly validate a `send_message.clone` argument. Returns `undefined`
 * when absent, a typed {@link SendMessageCloneRequest} when valid, or the
 * sentinel `'invalid'` when malformed (forged kind, `ttlMs`/extra keys, missing
 * fields, bad parent stage). Mirrors the strict zod schema for the direct
 * in-process handler path.
 */
function parseCloneArg(value: unknown): SendMessageCloneRequest | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CLONE_ARG_ALLOWED_KEYS.has(key)) return 'invalid';
  }
  if (record.kind !== EXECUTION_CLONE_KIND) return 'invalid';
  if (record.ephemeral !== true) return 'invalid';
  if (typeof record.parentRunId !== 'string' || record.parentRunId.trim().length === 0) return 'invalid';
  if (!isExecutionCloneParentStage(record.parentStage)) return 'invalid';
  return {
    kind: EXECUTION_CLONE_KIND,
    ephemeral: true,
    parentRunId: record.parentRunId,
    parentStage: record.parentStage,
  };
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

function localUnavailableToolFields(result: Pick<MemoryMcpSearchResult, 'degradedReasons'>): { reason: string; degradedReasons: string[] } {
  const degradedReasons = result.degradedReasons && result.degradedReasons.length > 0
    ? result.degradedReasons
    : [MEMORY_MCP_DEGRADED_REASON.LOCAL_CONTEXT_STORE_UNAVAILABLE];
  return { reason: degradedReasons[0] ?? MEMORY_MCP_DEGRADED_REASON.LOCAL_CONTEXT_STORE_UNAVAILABLE, degradedReasons };
}

const SEND_SESSION_SNAPSHOT_FALLBACK_TTL_MS = 30_000;

function sendVisibleSiblingCount(caller: McpRuntimeCaller, sessions: SessionRecord[]): number {
  if (!caller.sessionName) return 0;
  const callerProjectName = resolveRuntimeScope(caller, sessions).projectName;
  if (!callerProjectName) return 0;
  return sessions.filter((session) => (
    session.state !== 'stopped'
    && session.name !== caller.sessionName
    && session.executionCloneMetadata?.kind !== EXECUTION_CLONE_KIND
    && resolveEffectiveProjectName(session, sessions) === callerProjectName
  )).length;
}

function hasSendCaller(caller: McpRuntimeCaller, sessions: SessionRecord[]): boolean {
  return Boolean(caller.sessionName && sessions.some((session) => session.name === caller.sessionName));
}

function shouldUsePreviousSendSessions(
  caller: McpRuntimeCaller,
  current: SessionRecord[],
  previous: SessionRecord[] | null,
  previousAt: number,
  now: number,
): previous is SessionRecord[] {
  if (!previous || previous.length === 0) return false;
  if (now - previousAt > SEND_SESSION_SNAPSHOT_FALLBACK_TTL_MS) return false;
  if (hasSendCaller(caller, previous) && !hasSendCaller(caller, current)) return true;
  return sendVisibleSiblingCount(caller, previous) > 0 && sendVisibleSiblingCount(caller, current) === 0;
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

function compactSearchHit(item: MemoryMcpSearchHit, namespace: Parameters<typeof registerMemoryShortRef>[0]['namespace']) {
  if (item.observationId) {
    const observationId = item.observationId;
    const ref = registerMemoryShortRef({ kind: 'observation', id: observationId, namespace });
    return {
      observationId,
      ref,
      recordKind: 'observation',
      sourceLookup: {
        tool: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
        kind: 'observation',
        observationId,
      },
      summary: item.summary,
      observationClass: item.observationClass,
      observationState: item.observationState,
      matchKind: item.matchKind,
      projectId: item.projectId,
      scope: item.scope,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      relevanceScore: item.relevanceScore,
      source: item.source,
    };
  }
  const ref = registerMemoryShortRef({ kind: 'projection', id: item.projectionId, namespace });
  return {
    projectionId: item.projectionId,
    ref,
    recordKind: 'projection',
    sourceLookup: {
      tool: MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
      kind: 'projection',
      projectionId: item.projectionId,
    },
    summary: item.summary,
    projectionClass: item.projectionClass,
    matchKind: item.matchKind,
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

function fallbackProjectIdFromRoot(projectRoot: string | null | undefined): string | undefined {
  const root = projectRoot?.trim();
  if (!root) return undefined;
  return repositoryIdentityService.resolve({ cwd: root }).key;
}

function projectScopedNamespace(
  caller: McpRuntimeCaller,
  session: SessionRecord | undefined,
  projectRoot: string | null,
): ContextNamespace {
  const sessionProjectId = session?.contextNamespace?.projectId?.trim();
  const callerProjectId = caller.namespace.projectId?.trim();
  const fallbackProjectId = fallbackProjectIdFromRoot(projectRoot);
  const projectId = sessionProjectId ?? callerProjectId ?? fallbackProjectId;
  const base = sessionProjectId ? (session?.contextNamespace ?? caller.namespace) : caller.namespace;
  if (!projectId) return base;
  const scope = base.scope === 'user_private' ? 'personal' : base.scope;
  const userId = base.userId?.trim() || caller.userId;
  return {
    ...base,
    scope,
    projectId,
    ...(scope === 'personal' ? { userId } : {}),
  };
}

function scopedCallerForDeps(caller: McpRuntimeCaller, deps: MemoryMcpToolDeps): McpRuntimeCaller {
  const sessions = deps.sendDeps?.listSessions ? deps.sendDeps.listSessions() : listStoredSessions();
  const session = caller.sessionName
    ? sessions.find((candidate) => candidate.name === caller.sessionName)
    : undefined;
  const scope = resolveRuntimeScope(caller, sessions);
  return {
    ...caller,
    namespace: projectScopedNamespace(caller, session, scope.projectRoot),
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

interface CronSelfBinding {
  scopedCaller: McpRuntimeCaller;
  projectName: string;
  targetRole: string;
  targetSessionName: string | null;
}

function isCronSelfBinding(value: CronSelfBinding | ToolResult): value is CronSelfBinding {
  return 'scopedCaller' in value && 'projectName' in value && 'targetRole' in value;
}

function resolveCronSelfBinding(caller: McpRuntimeCaller, deps: MemoryMcpToolDeps, toolName: string): CronSelfBinding | ToolResult {
  const scopedCaller = scopedCallerForDeps(caller, deps);
  const sessionName = scopedCaller.sessionName?.trim();
  if (!sessionName) return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, `${toolName} requires a runtime-bound caller session`);
  const projectName = resolveCronProjectName(caller, deps, {}, toolName);
  if (typeof projectName !== 'string') return projectName;
  const sessions = deps.sendDeps?.listSessions ? deps.sendDeps.listSessions() : listStoredSessions();
  const session = sessions.find((candidate) => candidate.name === sessionName);
  if (session?.parentSession || sessionName.startsWith('deck_sub_')) {
    return { scopedCaller, projectName, targetRole: 'brain', targetSessionName: sessionName };
  }
  const role = session?.role ?? sessionName.match(/_(brain|w\d+)$/)?.[1];
  if (!role || !/^(brain|w\d+)$/.test(role)) {
    return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, `${toolName} cannot resolve the current session role`);
  }
  return { scopedCaller, projectName, targetRole: role, targetSessionName: null };
}

interface CronListJob {
  id: string;
  name: string;
  projectName: string;
  targetRole: string;
  targetSessionName: string | null;
}

function cronJobsFromListBody(body: unknown): CronListJob[] {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { jobs?: unknown }).jobs)) return [];
  return (body as { jobs: unknown[] }).jobs.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const row = value as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : '';
    const name = typeof row.name === 'string' ? row.name : '';
    const projectName = typeof row.project_name === 'string'
      ? row.project_name
      : typeof row.projectName === 'string' ? row.projectName : '';
    const targetRole = typeof row.target_role === 'string'
      ? row.target_role
      : typeof row.targetRole === 'string' ? row.targetRole : '';
    const rawTargetSessionName = row.target_session_name ?? row.targetSessionName;
    const targetSessionName = typeof rawTargetSessionName === 'string' && rawTargetSessionName ? rawTargetSessionName : null;
    return id && name ? [{ id, name, projectName, targetRole, targetSessionName }] : [];
  });
}

function cronJobTargetsSelf(job: CronListJob, binding: CronSelfBinding): boolean {
  if (job.projectName !== binding.projectName) return false;
  return binding.targetSessionName
    ? job.targetSessionName === binding.targetSessionName
    : job.targetSessionName === null && job.targetRole === binding.targetRole;
}

function defaultSelfCronName(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  let name = '';
  for (const char of compact) {
    if ((name + char).length > 100) break;
    name += char;
  }
  return name;
}

function selfCronControlMetadata(jobId: string): Record<string, unknown> {
  return {
    preferredCronInterface: true,
    jobId,
    controls: {
      update: { tool: MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF, args: { id: jobId } },
      cancel: { tool: MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF, args: { id: jobId } },
    },
    lifecycleInstruction: `When the scheduled work is complete, call ${MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF} with this jobId.`,
  };
}

function cronResultJobId(result: { body?: unknown }, fallback?: string): string | undefined {
  if (result.body && typeof result.body === 'object') {
    const id = (result.body as Record<string, unknown>).id;
    if (typeof id === 'string' && id) return id;
  }
  return fallback;
}

function callerProjectId(caller: { namespace: Pick<ContextNamespace, 'projectId'> }): string | undefined {
  const projectId = caller.namespace.projectId?.trim();
  return projectId || undefined;
}

function canManageProjectionNamespace(projectionNamespace: ContextNamespace, callerNamespace: ContextNamespace, callerUserId: string): boolean {
  if (serializeContextNamespace(projectionNamespace) === serializeContextNamespace(callerNamespace)) return true;
  if (projectionNamespace.scope !== 'personal' || callerNamespace.scope !== 'personal') return false;
  if (!projectionNamespace.projectId || projectionNamespace.projectId !== callerNamespace.projectId) return false;
  if ((projectionNamespace.enterpriseId ?? undefined) !== (callerNamespace.enterpriseId ?? undefined)) return false;
  if ((projectionNamespace.workspaceId ?? undefined) !== (callerNamespace.workspaceId ?? undefined)) return false;
  const projectionUserId = projectionNamespace.userId?.trim();
  return !projectionUserId || projectionUserId === LEGACY_DAEMON_LOCAL_USER_ID || projectionUserId === callerUserId;
}

function resolveProjectionRefArg(args: Record<string, unknown>, namespace: ContextNamespace): string | ToolResult {
  const projectionId = stringArg(args, 'projectionId');
  const ref = stringArg(args, 'ref');
  if (projectionId && ref) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'ref cannot be combined with projectionId');
  if (projectionId) return projectionId;
  if (!ref) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'projectionId or ref is required');
  const resolved = resolveMemoryShortRef(ref, namespace);
  if (!resolved || resolved.kind !== 'projection') {
    return error(MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE, 'projection is not available in the caller namespace');
  }
  return resolved.id;
}

async function loadManageableProjection(
  projectionId: string,
  scopedCaller: McpRuntimeCaller,
  getProcessedProjectionById: (id: string) => Promise<ProcessedContextProjection | undefined> | ProcessedContextProjection | undefined,
): Promise<ProcessedContextProjection | ToolResult> {
  const projectId = callerProjectId(scopedCaller);
  if (!projectId) return error(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, MEMORY_PROJECT_SCOPE_REASON.UNAVAILABLE);
  const projection = await getProcessedProjectionById(projectionId);
  if (!projection || !canManageProjectionNamespace(projection.namespace, scopedCaller.namespace, scopedCaller.userId)) {
    return error(MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE, 'projection is not available in the caller namespace');
  }
  if (projection.namespace.projectId !== projectId) {
    return error(MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE, 'projection is not available in the caller project');
  }
  return projection;
}

function isToolResultValue(value: ProcessedContextProjection | ToolResult): value is ToolResult {
  return !('namespace' in value);
}

export function createMemoryMcpToolHandlers(caller: McpRuntimeCaller, deps: MemoryMcpToolDeps = {}): Record<MemoryMcpToolName, MemoryMcpToolHandler> {
  const searchMemory = deps.searchMemory ?? searchMcpMemoryRecall;
  const listMemorySummaries = deps.listMemorySummaries ?? listMcpMemorySummaries;
  let lastGoodSendSessions: SessionRecord[] | null = null;
  let lastGoodSendSessionsAt = 0;
  const sendSessions = async (): Promise<SessionRecord[]> => {
    if (deps.sendDeps?.listSessions) return deps.sendDeps.listSessions();
    await loadStore({ probe: false });
    const current = listStoredSessions();
    const now = Date.now();
    const selected = shouldUsePreviousSendSessions(
      caller,
      current,
      lastGoodSendSessions,
      lastGoodSendSessionsAt,
      now,
    ) ? lastGoodSendSessions : current;
    if (hasSendCaller(caller, selected) || sendVisibleSiblingCount(caller, selected) > 0) {
      lastGoodSendSessions = selected;
      lastGoodSendSessionsAt = now;
    }
    return selected;
  };
  const sendDepsWithSessions = (sessions: SessionRecord[], extra: Partial<SendToolDeps> = {}): SendToolDeps => ({
    ...deps.sendDeps,
    ...extra,
    listSessions: () => sessions,
  });
  // Orchestrated path is the production wiring; the legacy `getMemorySources`
  // dep is retained for tests that only want to verify the local SQLite
  // branch without involving cache/cloud resolution.
  const orchestrator = deps.getMemorySourcesOrchestrator
    ?? ((projectionId, mcpCaller, orchDeps) => getMemorySourcesOrchestrated(
      projectionId,
      mcpCaller,
      { ...(deps.orchestratorDeps ?? {}), ...(orchDeps ?? {}) },
    ));
  const saveObservationTool = deps.saveObservation ?? saveObservation;
  const savePreferenceTool = deps.savePreference ?? savePreference;
  const contextStoreClient = () => getContextStoreClient();
  const getProcessedProjectionById = deps.getProcessedProjectionById
    ?? ((id: string) => contextStoreClient().run<ProcessedContextProjection | undefined>('getProcessedProjectionById', [id]));
  const archiveMemory = deps.archiveMemory
    ?? ((id: string) => contextStoreClient().run<boolean>('archiveMemory', [id]));
  const restoreArchivedMemory = deps.restoreArchivedMemory
    ?? ((id: string) => contextStoreClient().run<boolean>('restoreArchivedMemory', [id]));
  const deleteMemory = deps.deleteMemory
    ?? ((id: string) => contextStoreClient().run<boolean>('deleteMemory', [id]));
  const updateProcessedProjectionSummary = deps.updateProcessedProjectionSummary
    ?? ((input: Parameters<NonNullable<MemoryMcpToolDeps['updateProcessedProjectionSummary']>>[0]) => (
      contextStoreClient().run<ProcessedContextProjection | null>('updateProcessedProjectionSummary', [input])
    ));
  const recordMemoryHits = deps.recordMemoryHits
    ?? ((ids: string[]) => contextStoreClient().run<void>('recordMemoryHits', [ids]));
  const cronCreate = deps.cronCreate ?? cronMcpCreate;
  const createSelfCron = deps.cronCreateSelf ?? cronMcpCreateSelf;
  const updateSelfCron = deps.cronUpdateSelf ?? cronMcpUpdateSelf;
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
        const projectId = callerProjectId(scopedCaller);
        if (!projectId) return { status: 'ok', reason: MEMORY_PROJECT_SCOPE_REASON.UNAVAILABLE, items: [] };
        const result = await searchMemory({
          query,
          namespace: scopedCaller.namespace,
          currentEnterpriseId: scopedCaller.namespace.enterpriseId,
          repo: projectId,
          includeLegacyPersonalOwner: true,
          limit,
        });
        const items = result.items
          .filter((item) => item.projectId === projectId)
          .map((item) => compactSearchHit(item, scopedCaller.namespace));
        return {
          status: 'ok',
          ...(result.localUnavailable ? localUnavailableToolFields(result) : {}),
          items,
        };
      } catch (err) {
        return sanitizeCaughtError(err);
      }
    },
    [MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES]: async (input) => {
      const gate = memorySurfaceGate(deps, { items: [] });
      if (gate) return gate;
      const args = pickAllowedMcpArgs(input, ['projectionClass', 'limit']);
      const limit = numberArg(args, 'limit');
      const scopedCaller = memoryCaller();
      try {
        const projectId = callerProjectId(scopedCaller);
        if (!projectId) return { status: 'ok', reason: MEMORY_PROJECT_SCOPE_REASON.UNAVAILABLE, items: [] };
        const result = await listMemorySummaries({
          namespace: scopedCaller.namespace,
          currentEnterpriseId: scopedCaller.namespace.enterpriseId,
          repo: projectId,
          userId: scopedCaller.userId,
          includeLegacyPersonalOwner: true,
          projectionClass: listProjectionClassArg(args),
          limit,
        });
        const items = result.items
          .filter((item) => item.projectId === projectId)
          .map((item) => compactSearchHit(item, scopedCaller.namespace));
        return {
          status: 'ok',
          ...(result.localUnavailable ? localUnavailableToolFields(result) : {}),
          items,
        };
      } catch (err) {
        return sanitizeCaughtError(err);
      }
    },
    [MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]: async (input) => {
      const gate = memorySurfaceGate(deps, { sources: [] });
      if (gate) return gate;
      // `serverId` stays in MEMORY_MCP_FORBIDDEN_ARG_NAMES — see
      // shared/memory-mcp-contracts.ts. Callers cannot influence routing
      // by supplying any identity-binding field; the orchestrator resolves
      // `originServerId` from cache or cloud, never from input.
      const args = pickAllowedMcpArgs(input, ['projectionId', 'observationId', 'kind', 'ref']);
      let projectionId = stringArg(args, 'projectionId');
      let observationId = stringArg(args, 'observationId');
      let kind = stringArg(args, 'kind');
      const ref = stringArg(args, 'ref');
      if (kind && kind !== 'projection' && kind !== 'observation') {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'kind must be projection or observation');
      }
      if (ref && (projectionId || observationId)) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'ref cannot be combined with projectionId or observationId');
      }
      const scopedCaller = memoryCaller();
      const projectId = callerProjectId(scopedCaller);
      const emptySources = () => ({
        status: 'ok',
        reason: MEMORY_PROJECT_SCOPE_REASON.UNAVAILABLE,
        ...(ref ? { ref } : {}),
        ...(projectionId ? { projectionId } : {}),
        ...(observationId ? { observationId } : {}),
        sourceEventCount: 0,
        sources: [],
      });
      if (!projectId && !ref && !projectionId && !observationId) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'projectionId, observationId, or ref is required');
      }
      if (!projectId) return emptySources();
      if (ref) {
        const resolved = resolveMemoryShortRef(ref, scopedCaller.namespace);
        if (!resolved) return { status: 'ok', ref, sourceEventCount: 0, sources: [] };
        if (kind && kind !== resolved.kind) {
          return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'source lookup kind does not match the supplied ref');
        }
        kind = resolved.kind;
        if (resolved.kind === 'observation') observationId = resolved.id;
        else projectionId = resolved.id;
      }
      if ((projectionId && observationId) || (!projectionId && !observationId)) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'projectionId, observationId, or ref is required');
      }
      if ((kind === 'observation' && !observationId) || (kind === 'projection' && !projectionId)) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'source lookup kind does not match the supplied id');
      }
      try {
        if (observationId) {
          return { status: 'ok', ...(await memoryGetSources({ observationId, kind: 'observation' }, scopedCaller)) };
        }
        const result = await orchestrator(projectionId!, scopedCaller);
        if (result.status === 'error') {
          // Orchestrator reason values are the same string literals declared
          // in MCP_ERROR_REASONS, so they are valid MCPErrorReason values.
          return error(result.reason as MCPErrorReason, result.message);
        }
        // status === 'ok' branch. Spread directly so output preserves
        // `originServerId`, `partial`, `sources`, etc.
        const { status: _status, ...payload } = result;
        return { status: 'ok', ...payload };
      } catch (err) {
        return sanitizeCaughtError(err);
      }
    },
    [MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY]: async (input) => {
      const gate = memorySurfaceGate(deps);
      if (gate) return gate;
      const args = pickAllowedMcpArgs(input, ['projectionId', 'ref']);
      const scopedCaller = scopedCallerForDeps(caller, deps);
      const projectionId = resolveProjectionRefArg(args, scopedCaller.namespace);
      if (typeof projectionId !== 'string') return projectionId;
      const projection = await loadManageableProjection(projectionId, scopedCaller, getProcessedProjectionById);
      if (isToolResultValue(projection)) return projection;
      const changed = await archiveMemory(projectionId);
      if (changed) publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId, namespace: projection.namespace });
      return { status: 'ok', projectionId, changed };
    },
    [MEMORY_MCP_TOOL_NAMES.RESTORE_MEMORY]: async (input) => {
      const gate = memorySurfaceGate(deps);
      if (gate) return gate;
      const args = pickAllowedMcpArgs(input, ['projectionId', 'ref']);
      const scopedCaller = scopedCallerForDeps(caller, deps);
      const projectionId = resolveProjectionRefArg(args, scopedCaller.namespace);
      if (typeof projectionId !== 'string') return projectionId;
      const projection = await loadManageableProjection(projectionId, scopedCaller, getProcessedProjectionById);
      if (isToolResultValue(projection)) return projection;
      const changed = await restoreArchivedMemory(projectionId);
      if (changed) publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId, namespace: projection.namespace });
      return { status: 'ok', projectionId, changed };
    },
    [MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY]: async (input) => {
      const gate = memorySurfaceGate(deps);
      if (gate) return gate;
      const args = pickAllowedMcpArgs(input, ['projectionId', 'ref']);
      const scopedCaller = scopedCallerForDeps(caller, deps);
      const projectionId = resolveProjectionRefArg(args, scopedCaller.namespace);
      if (typeof projectionId !== 'string') return projectionId;
      const projection = await loadManageableProjection(projectionId, scopedCaller, getProcessedProjectionById);
      if (isToolResultValue(projection)) return projection;
      const changed = await deleteMemory(projectionId);
      if (changed) publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId, namespace: projection.namespace });
      return { status: 'ok', projectionId, changed };
    },
    [MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY]: async (input) => {
      const gate = memorySurfaceGate(deps);
      if (gate) return gate;
      const args = pickAllowedMcpArgs(input, ['projectionId', 'ref', 'text']);
      const text = stringArg(args, 'text');
      if (!text) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'text is required');
      const scopedCaller = scopedCallerForDeps(caller, deps);
      const projectionId = resolveProjectionRefArg(args, scopedCaller.namespace);
      if (typeof projectionId !== 'string') return projectionId;
      const projection = await loadManageableProjection(projectionId, scopedCaller, getProcessedProjectionById);
      if (isToolResultValue(projection)) return projection;
      const updated = await updateProcessedProjectionSummary({
        projectionId,
        summary: text,
        ownerUserId: scopedCaller.userId,
        updatedByUserId: scopedCaller.userId,
      });
      if (!updated) return error(MCP_ERROR_REASONS.PROJECTION_UNAVAILABLE, 'projection is not available in the caller namespace');
      publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId, namespace: updated.namespace });
      return { status: 'ok', projectionId, changed: true };
    },
    [MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK]: async (input) => {
      const gate = memorySurfaceGate(deps);
      if (gate) return gate;
      const args = pickAllowedMcpArgs(input, ['projectionId', 'ref', 'feedback', 'reason']);
      const feedback = stringArg(args, 'feedback');
      if (feedback !== 'not_relevant' && feedback !== 'relevant') {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'feedback must be not_relevant or relevant');
      }
      const scopedCaller = scopedCallerForDeps(caller, deps);
      const projectionId = resolveProjectionRefArg(args, scopedCaller.namespace);
      if (typeof projectionId !== 'string') return projectionId;
      const projection = await loadManageableProjection(projectionId, scopedCaller, getProcessedProjectionById);
      if (isToolResultValue(projection)) return projection;
      if (feedback === 'not_relevant') {
        const changed = await archiveMemory(projectionId);
        if (changed) publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId, namespace: projection.namespace });
        return { status: 'ok', projectionId, feedback, action: 'archived', changed };
      }
      await recordMemoryHits([projectionId]);
      publishRuntimeMemoryCacheInvalidation({ kind: 'projection', projectionId, namespace: projection.namespace });
      return { status: 'ok', projectionId, feedback, action: 'hit_recorded', changed: true };
    },
    [MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION]: async (input) => {
      const gate = memoryGate(deps, MEMORY_FEATURE_FLAGS_BY_NAME.observationStore, MEMORY_MCP_DISABLED_FLAGS.OBSERVATION_STORE);
      if (gate) return gate;
      return await saveObservationTool(pickAllowedMcpArgs(input, ['content', 'tags', 'turnId', 'idempotencyKey']), memoryCaller()) as unknown as ToolResult;
    },
    [MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE]: async (input) => {
      const gate = memoryGate(deps, MEMORY_FEATURE_FLAGS_BY_NAME.preferences, MEMORY_MCP_DISABLED_FLAGS.PREFERENCES);
      if (gate) return gate;
      return await savePreferenceTool(pickAllowedMcpArgs(input, ['text', 'idempotencyKey']), memoryCaller()) as unknown as ToolResult;
    },
    [MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]: async (input) => {
      const sessions = await sendSessions();
      const args = pickAllowedMcpArgs(input, ['query', 'limit']);
      return listSendTargets(caller, {
        query: stringArg(args, 'query'),
        limit: numberArg(args, 'limit'),
      }, sendDepsWithSessions(sessions, {
        isDispatchEnabled: () => deps.sendDeps?.isDispatchEnabled?.() ?? true,
      })) as unknown as ToolResult;
    },
    [MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]: async (input) => {
      const sessions = await sendSessions();
      const args = pickAllowedMcpArgs(input, ['target', 'message', 'files', 'reply', 'broadcast', 'idempotencyKey', 'clone']);
      const clone = parseCloneArg(args.clone);
      if (clone === 'invalid') return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'clone request is invalid');
      return dispatchSendMessage(caller, {
        target: stringArg(args, 'target'),
        message: stringArg(args, 'message'),
        files: stringArrayArg(args, 'files'),
        reply: boolArg(args, 'reply'),
        broadcast: boolArg(args, 'broadcast'),
        idempotencyKey: stringArg(args, 'idempotencyKey'),
        ...(clone ? { clone } : {}),
      }, sendDepsWithSessions(sessions, {
        isDispatchEnabled: () => deps.sendDeps?.isDispatchEnabled?.() ?? true,
        exactTargetOnly: true,
      })) as unknown as Promise<ToolResult>;
    },
    [MEMORY_MCP_TOOL_NAMES.DESTROY_EXECUTION_CLONE]: async (input) => {
      const sessions = await sendSessions();
      const args = pickAllowedMcpArgs(input, ['target', 'idempotencyKey']);
      return dispatchDestroyExecutionClone(caller, {
        target: stringArg(args, 'target'),
        idempotencyKey: stringArg(args, 'idempotencyKey'),
      }, sendDepsWithSessions(sessions, {
        isDispatchEnabled: () => deps.sendDeps?.isDispatchEnabled?.() ?? true,
      })) as unknown as Promise<ToolResult>;
    },
    [MEMORY_MCP_TOOL_NAMES.SEND_STOP]: async (input) => {
      const sessions = await sendSessions();
      const args = pickAllowedMcpArgs(input, ['target', 'broadcast', 'idempotencyKey']);
      return dispatchSendStop(caller, {
        target: stringArg(args, 'target'),
        broadcast: boolArg(args, 'broadcast'),
        idempotencyKey: stringArg(args, 'idempotencyKey'),
      }, sendDepsWithSessions(sessions, {
        isDispatchEnabled: () => deps.sendDeps?.isDispatchEnabled?.() ?? true,
        exactTargetOnly: true,
      })) as unknown as Promise<ToolResult>;
    },
    [MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['cronExpr', 'message', 'name', 'timezone', 'expiresAt']);
      const cronExpr = stringArg(args, 'cronExpr');
      const message = stringArg(args, 'message');
      if (!cronExpr) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'cronExpr is required');
      if (!message) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'message is required');
      const expiresAt = parseExpiresAt(args.expiresAt);
      if (Number.isNaN(expiresAt)) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'expiresAt must be a timestamp or ISO string');
      const binding = resolveCronSelfBinding(caller, deps, MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF);
      if (!isCronSelfBinding(binding)) return binding;
      const cronOptions = cronOptionsForCaller(binding.scopedCaller, deps);
      if ('status' in cronOptions) return cronOptions;
      const result = await createSelfCron({
        name: stringArg(args, 'name') ?? defaultSelfCronName(message),
        cronExpr,
        projectName: binding.projectName,
        targetRole: binding.targetRole,
        targetSessionName: binding.targetSessionName,
        message,
        timezone: stringArg(args, 'timezone'),
        expiresAt,
      }, cronOptions);
      if (result.status !== 'ok') return result as unknown as ToolResult;
      const jobId = cronResultJobId(result);
      return {
        ...result,
        ...(jobId ? selfCronControlMetadata(jobId) : {}),
      } as unknown as ToolResult;
    },
    [MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['id', 'cronExpr', 'message', 'name', 'timezone', 'expiresAt']);
      const id = stringArg(args, 'id');
      if (!id) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'id is required');
      const hasUpdate = ['cronExpr', 'message', 'name', 'timezone'].some((key) => stringArg(args, key) !== undefined)
        || args.expiresAt !== undefined;
      if (!hasUpdate) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'at least one update field is required');
      if (args.message !== undefined && !stringArg(args, 'message')) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'message must not be empty');
      }
      const expiresAt = parseExpiresAt(args.expiresAt);
      if (Number.isNaN(expiresAt)) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'expiresAt must be a timestamp or ISO string');
      const binding = resolveCronSelfBinding(caller, deps, MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF);
      if (!isCronSelfBinding(binding)) return binding;
      const cronOptions = cronOptionsForCaller(binding.scopedCaller, deps);
      if ('status' in cronOptions) return cronOptions;
      const listed = await cronList({ projectName: binding.projectName, limit: MEMORY_MCP_CAPS.CRON_LIST_MAX_LIMIT }, cronOptions);
      if (listed.status !== 'ok') return listed as unknown as ToolResult;
      const job = cronJobsFromListBody(listed.body).find((candidate) => candidate.id === id && cronJobTargetsSelf(candidate, binding));
      if (!job) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'scheduled job is not available for the current session');
      const result = await updateSelfCron({
        id,
        projectName: binding.projectName,
        name: stringArg(args, 'name'),
        cronExpr: stringArg(args, 'cronExpr'),
        message: stringArg(args, 'message'),
        timezone: stringArg(args, 'timezone'),
        expiresAt,
      }, cronOptions);
      if (result.status !== 'ok') return result as unknown as ToolResult;
      return { ...result, ...selfCronControlMetadata(id) } as unknown as ToolResult;
    },
    [MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['id', 'name', 'all']);
      const id = stringArg(args, 'id');
      const name = stringArg(args, 'name');
      const all = boolArg(args, 'all') === true;
      if (Number(Boolean(id)) + Number(Boolean(name)) + Number(all) !== 1) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'provide exactly one of id, name, or all=true');
      }
      const binding = resolveCronSelfBinding(caller, deps, MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF);
      if (!isCronSelfBinding(binding)) return binding;
      const cronOptions = cronOptionsForCaller(binding.scopedCaller, deps);
      if ('status' in cronOptions) return cronOptions;
      const listed = await cronList({ projectName: binding.projectName, limit: MEMORY_MCP_CAPS.CRON_LIST_MAX_LIMIT }, cronOptions);
      if (listed.status !== 'ok') return listed as unknown as ToolResult;
      const ownJobs = cronJobsFromListBody(listed.body).filter((job) => cronJobTargetsSelf(job, binding));
      const matches = all
        ? ownJobs
        : ownJobs.filter((job) => id ? job.id === id : job.name === name);
      if (matches.length === 0) return { status: 'ok', count: 0, deleted: [], matched: false };
      if (name && matches.length > 1) {
        return {
          ...error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'job name is ambiguous; cancel by id instead'),
          matches: matches.map((job) => ({ id: job.id, name: job.name })),
        };
      }
      const deleted: Array<{ id: string; name: string }> = [];
      for (const job of matches) {
        const result = await cronDelete(job.id, cronOptions);
        if (result.status !== 'ok') {
          return { ...result, deleted } as unknown as ToolResult;
        }
        deleted.push({ id: job.id, name: job.name });
      }
      return { status: 'ok', count: deleted.length, deleted };
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
    [MEMORY_MCP_TOOL_NAMES.LIST_MACHINES]: async (input) => {
      if (!deps.machineDeps) return error(MCP_ERROR_REASONS.FEATURE_DISABLED, 'machine control is not available on this node');
      const args = pickAllowedMcpArgs(input, ['includeOffline']);
      const includeOffline = boolArg(args, 'includeOffline') ?? false;
      // Unbound → FEATURE_DISABLED; a real control-plane failure
      // (transport/http/malformed) → CONTROL_PLANE_UNAVAILABLE. Never a silent
      // empty "no machines" list. Kept consistent with the exec path.
      let machines: MachineSummaryForTool[];
      try {
        machines = await deps.machineDeps.listMachines({ includeOffline });
      } catch (err) {
        const kind = (err as { kind?: string }).kind;
        const reason = kind === 'unbound' ? MCP_ERROR_REASONS.FEATURE_DISABLED : MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE;
        return error(reason, err instanceof Error ? err.message : 'machine control plane unavailable');
      }
      const parsedMachines = machineListDependencyResultSchema.safeParse(machines);
      if (!parsedMachines.success) {
        return error(MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, 'machine control plane returned a malformed machine list');
      }
      const success: MachineListToolSuccess = { status: 'ok', machines: parsedMachines.data };
      return success;
    },
    [MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE]: async (input, context) => {
      if (!deps.machineDeps) return error(MCP_ERROR_REASONS.FEATURE_DISABLED, 'machine control is not available on this node');
      const args = pickAllowedMcpArgs(input, ['machine', 'command', 'shell', 'timeoutMs']);
      const machine = machineArg(args);
      const command = stringArg(args, 'command');
      if (!machine) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'machine must be a valid stable ref_name');
      if (!command) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'command is required');
      if (utf8ByteLength(command) > REMOTE_EXEC_MAX_COMMAND_BYTES) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, `command must be at most ${REMOTE_EXEC_MAX_COMMAND_BYTES} UTF-8 bytes`);
      }
      const shellRaw = stringArg(args, 'shell');
      if (shellRaw && !(REMOTE_EXEC_SHELLS as readonly string[]).includes(shellRaw)) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, `shell must be one of ${REMOTE_EXEC_SHELLS.join(', ')}`);
      }
      const timeoutMs = numberArg(args, 'timeoutMs');
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < REMOTE_EXEC_MIN_TIMEOUT_MS || timeoutMs > REMOTE_EXEC_MAX_TIMEOUT_MS)) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, `timeoutMs must be an integer in [${REMOTE_EXEC_MIN_TIMEOUT_MS}, ${REMOTE_EXEC_MAX_TIMEOUT_MS}]`);
      }
      const injectedResult = await deps.machineDeps.execRemote({
        machine,
        command,
        ...(shellRaw ? { shell: shellRaw as RemoteExecShell } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
        ...(context?.onProgress ? { onOutput: context.onProgress } : {}),
      });
      const parsedResult = machineExecDependencyResultSchema.safeParse(injectedResult);
      if (!parsedResult.success) {
        // The request may already have reached the controlled node. Never turn
        // an untrusted/malformed post-dispatch result into a retry-safe error.
        const indeterminate: MachineExecToolSuccess = { status: 'ok', outcome: 'dispatched_no_result' };
        return indeterminate;
      }
      const result = parsedResult.data;
      // A typed reason means the target was unusable (offline/unknown/ambiguous/
      // disabled) — surface it as a shared MCP error, never an ad-hoc string.
      if (result.outcome === 'not_dispatched' && result.reason) return error(result.reason, result.error);
      const success = result.outcome === 'not_dispatched'
        ? { status: 'ok', outcome: result.outcome } as MachineExecToolSuccess
        : { status: 'ok', ...result } as MachineExecToolSuccess;
      return success;
    },
    [MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE]: async (input, context) => {
      if (!deps.machineDeps?.sendFileToMachine) return error(MCP_ERROR_REASONS.FEATURE_DISABLED, 'machine file transfer is not available on this node');
      const args = pickAllowedMcpArgs(input, ['machine', 'sourcePath']);
      const machine = machineArg(args);
      const sourcePath = stringArg(args, 'sourcePath');
      if (!machine || !sourcePath) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'a valid machine ref_name and sourcePath are required');
      if (utf8ByteLength(sourcePath) > FILE_TRANSFER_PATH_MAX_BYTES) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'sourcePath is too long');
      const result = await deps.machineDeps.sendFileToMachine({
        machine,
        sourcePath,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      if (!result.ok) return error(result.reason, result.error);
      if (!result.remotePath) return error(MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, 'machine file transfer returned no destination path');
      return { status: 'ok', machine, remotePath: result.remotePath, attachmentId: result.attachmentId, size: result.size };
    },
    [MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE]: async (input, context) => {
      if (!deps.machineDeps?.fetchFileFromMachine) return error(MCP_ERROR_REASONS.FEATURE_DISABLED, 'machine file transfer is not available on this node');
      const args = pickAllowedMcpArgs(input, ['machine', 'sourcePath', 'destinationPath', 'overwrite']);
      const machine = machineArg(args);
      const sourcePath = stringArg(args, 'sourcePath');
      const destinationPath = stringArg(args, 'destinationPath');
      const overwrite = boolArg(args, 'overwrite') ?? false;
      if (!machine || !sourcePath || !destinationPath) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'a valid machine ref_name, sourcePath, and destinationPath are required');
      if (utf8ByteLength(sourcePath) > FILE_TRANSFER_PATH_MAX_BYTES || utf8ByteLength(destinationPath) > FILE_TRANSFER_PATH_MAX_BYTES) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'file path is too long');
      }
      const result = await deps.machineDeps.fetchFileFromMachine({
        machine,
        sourcePath,
        destinationPath,
        overwrite,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      if (!result.ok) return error(result.reason, result.error);
      if (!result.destinationPath) return error(MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, 'machine file transfer returned no destination path');
      return { status: 'ok', machine, destinationPath: result.destinationPath, attachmentId: result.attachmentId, size: result.size };
    },
    [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['topic']);
      const topicRaw = stringArg(args, 'topic');
      if (!topicRaw || !(COMPUTER_USE_DOC_TOPICS as readonly string[]).includes(topicRaw)) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, `topic must be one of ${COMPUTER_USE_DOC_TOPICS.join(', ')}`);
      }
      return { status: 'ok', topic: topicRaw, text: computerUseDocs(topicRaw as ComputerUseDocTopic) };
    },
    [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL]: async (input, context) => {
      if (!deps.machineDeps?.computerUseCall) return error(MCP_ERROR_REASONS.FEATURE_DISABLED, 'computer use control is not available on this node');
      const args = pickAllowedMcpArgs(input, ['machine', 'tool', 'arguments', 'timeoutMs']);
      const machine = machineArg(args);
      const toolRaw = stringArg(args, 'tool');
      if (!machine) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'machine must be a valid stable ref_name or local alias');
      if (!toolRaw || !(COMPUTER_USE_TOOLS as readonly string[]).includes(toolRaw)) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, `tool must be one of ${COMPUTER_USE_TOOLS.join(', ')}`);
      }
      const toolArgs = args.arguments === undefined ? undefined : args.arguments;
      if (toolArgs !== undefined && (typeof toolArgs !== 'object' || toolArgs === null || Array.isArray(toolArgs))) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'arguments must be an object');
      }
      if (toolArgs !== undefined && utf8ByteLength(JSON.stringify(toolArgs)) > COMPUTER_USE_MAX_ARGUMENT_BYTES) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, `arguments must be at most ${COMPUTER_USE_MAX_ARGUMENT_BYTES} UTF-8 bytes`);
      }
      const timeoutMs = numberArg(args, 'timeoutMs');
      const maxTimeoutMs = computerUseMaxTimeoutMs(toolRaw as ComputerUseToolName);
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < COMPUTER_USE_MIN_TIMEOUT_MS || timeoutMs > maxTimeoutMs)) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, `timeoutMs must be an integer in [${COMPUTER_USE_MIN_TIMEOUT_MS}, ${maxTimeoutMs}] for ${toolRaw}`);
      }
      const injectedResult = await deps.machineDeps.computerUseCall({
        machine,
        tool: toolRaw as ComputerUseToolName,
        ...(toolArgs !== undefined ? { arguments: toolArgs as Record<string, unknown> } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      const parsedResult = computerUseDependencyResultSchema.safeParse(injectedResult);
      if (!parsedResult.success) return { status: 'ok', outcome: 'dispatched_no_result' };
      const result = parsedResult.data;
      if (result.outcome === 'not_dispatched' && result.reason) return error(result.reason, result.error);
      return result.outcome === 'not_dispatched' || result.outcome === 'dispatched_no_result'
        ? { status: 'ok', outcome: result.outcome }
        : { status: 'ok', outcome: result.outcome, result: result.result };
    },
  });
}

function wrapHandlers(handlers: Record<MemoryMcpToolName, MemoryMcpToolHandler>): Record<MemoryMcpToolName, MemoryMcpToolHandler> {
  const wrapped = {} as Record<MemoryMcpToolName, MemoryMcpToolHandler>;
  for (const name of MEMORY_MCP_TOOL_NAME_LIST) {
    wrapped[name] = async (input?: unknown, context?: MemoryMcpToolContext) => {
      try {
        return await handlers[name](input, context);
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
    query: z.string().describe('Text query; hits include sourceLookup for expansion.'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum hits.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES]: z.object({
    projectionClass: z.enum(['recent_summary', 'durable_memory_candidate']).optional().describe('Summary class; defaults to recent_summary.'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum summaries.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES]: z.object({
    projectionId: z.string().optional().describe('Projection hit id from search_memory.'),
    observationId: z.string().optional().describe('Observation hit id from search_memory.'),
    ref: z.string().optional().describe('Compact search/startup ref (obs:… or proj:…).'),
    kind: z.enum(['projection', 'observation']).optional().describe('Kind from sourceLookup.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY]: z.object({
    projectionId: z.string().optional().describe('Projection id to archive.'),
    ref: z.string().optional().describe('Compact proj: ref.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.RESTORE_MEMORY]: z.object({
    projectionId: z.string().optional().describe('Projection id to restore.'),
    ref: z.string().optional().describe('Compact proj: ref.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY]: z.object({
    projectionId: z.string().optional().describe('Projection id to delete.'),
    ref: z.string().optional().describe('Compact proj: ref.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY]: z.object({
    projectionId: z.string().optional().describe('Projection id to update.'),
    ref: z.string().optional().describe('Compact proj: ref.'),
    text: z.string().describe('Replacement summary.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK]: z.object({
    projectionId: z.string().optional().describe('Projection id.'),
    ref: z.string().optional().describe('Compact proj: ref.'),
    feedback: z.enum(['not_relevant', 'relevant']).describe('Archive or strengthen ranking.'),
    reason: z.string().optional().describe('Short audit reason.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION]: z.object({
    content: z.string().describe('Durable fact or decision.'),
    tags: z.array(z.string()).optional().describe('Short tags.'),
    turnId: z.string().optional().describe('Source turn/event id.'),
    idempotencyKey: z.string().optional().describe('Retry key.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE]: z.object({
    text: z.string().describe('Stable preference text.'),
    idempotencyKey: z.string().optional().describe('Retry key.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]: z.object({
    query: z.string().optional().describe('Case-insensitive name/display-label filter.'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum targets.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]: z.object({
    target: z.string().describe('Exact send_list_targets target; never the caller.'),
    message: z.string().describe('Complete task/request and expected output.'),
    files: z.array(z.string()).optional().describe('Project-root path refs; no file bytes.'),
    reply: z.boolean().optional().describe('Request a reply/report.'),
    broadcast: z.boolean().optional().describe('Only when the user asks every/all sessions.'),
    idempotencyKey: z.string().optional().describe('Accepted-send replay key.'),
    clone: z.object({
      kind: z.literal(EXECUTION_CLONE_KIND).describe('Clone kind.'),
      ephemeral: z.literal(true).describe('Always true.'),
      parentRunId: z.string().min(1).describe('Owning parent run id.'),
      parentStage: z.enum(EXECUTION_CLONE_PARENT_STAGES).describe('Creating parent stage.'),
    }).strict().optional().describe('Route to a new ephemeral target clone; returns clone.target; forbids broadcast.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.DESTROY_EXECUTION_CLONE]: z.object({
    target: z.string().describe('Exact result.clone.target.'),
    idempotencyKey: z.string().optional().describe('Accepted-destroy replay key.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.SEND_STOP]: z.object({
    target: z.string().optional().describe('Exact sibling target; required unless broadcast.'),
    broadcast: z.boolean().optional().describe('Stop all sendable siblings.'),
    idempotencyKey: z.string().optional().describe('Accepted-stop replay key.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF]: z.object({
    cronExpr: z.string().describe(`${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES}-minute minimum interval.`),
    message: z.string().describe('Message to this session.'),
    name: z.string().optional().describe('Job name; derived from message by default.'),
    timezone: z.string().optional().describe('Schedule timezone.'),
    expiresAt: z.union([z.number(), z.string(), z.null()]).optional().describe('Epoch-ms or explicit-offset ISO expiration.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF]: z.object({
    id: z.string().describe('Current-session job id.'),
    cronExpr: z.string().optional().describe(`Replacement schedule; ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES}-minute minimum.`),
    message: z.string().optional().describe('Replacement wake-up message.'),
    name: z.string().optional().describe('Replacement name.'),
    timezone: z.string().optional().describe('Replacement timezone.'),
    expiresAt: z.union([z.number(), z.string(), z.null()]).optional().describe('Replacement epoch-ms/offset-ISO expiration.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF]: z.object({
    id: z.string().optional().describe('Exact current-session job id.'),
    name: z.string().optional().describe('Exact unique current-session job name.'),
    all: z.boolean().optional().describe('Cancel every current-session job.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_CREATE]: z.object({
    name: z.string().describe('Job name.'),
    cronExpr: z.string().describe(`${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES}-minute minimum; every-minute schedules are invalid.`),
    projectName: z.string().optional().describe('Project; defaults to caller project.'),
    targetRole: z.string().optional().describe('Source role; defaults to project brain.'),
    targetSessionName: z.string().nullable().optional().describe('Source session; target resolves among its siblings and cannot be itself.'),
    action: z.record(z.string(), z.unknown()).describe('Send action: {type:"send", target, message, reply?, broadcast?, idempotencyKey?}.'),
    timezone: z.string().optional().describe('Schedule timezone only.'),
    expiresAt: z.union([z.number(), z.string(), z.null()]).optional().describe('Epoch-ms/offset-ISO, ≤90 days; affects future sends only.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_LIST]: z.object({
    projectName: z.string().optional().describe('Project filter.'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_UPDATE]: z.object({
    id: z.string().describe('Job id.'),
    name: z.string().optional().describe('Replacement name.'),
    cronExpr: z.string().optional().describe(`Replacement schedule; ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES}-minute minimum.`),
    projectName: z.string().optional().describe('Replacement project.'),
    targetRole: z.string().optional().describe('Replacement source role.'),
    targetSessionName: z.string().nullable().optional().describe('Replacement source session; target resolves among its siblings.'),
    action: z.record(z.string(), z.unknown()).optional().describe('Replacement send action; other action types are rejected.'),
    timezone: z.string().optional().describe('Replacement schedule timezone only.'),
    expiresAt: z.union([z.number(), z.string(), z.null()]).optional().describe('Replacement epoch-ms/offset-ISO; affects future sends only.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_DELETE]: z.object({
    id: z.string().describe('Job id.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.LIST_MACHINES]: z.strictObject({
    includeOffline: z.boolean().optional().describe('Include offline and exec-disabled machines; default false. Presence is advisory.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE]: z.strictObject({
    machine: machineTargetRuntimeSchema.describe('Bare stable ref_name or complete ^^(ref_name) marker; no list_machines preflight when known.'),
    command: z.string().describe('One shell command.'),
    shell: z.enum(REMOTE_EXEC_SHELLS).optional().describe('Shell.'),
    timeoutMs: z.number().int().min(REMOTE_EXEC_MIN_TIMEOUT_MS).max(REMOTE_EXEC_MAX_TIMEOUT_MS).optional().describe('Timeout ms.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE]: z.strictObject({
    machine: machineTargetRuntimeSchema.describe('Bare stable ref_name or complete ^^(ref_name) marker.'),
    sourcePath: boundedUtf8String(FILE_TRANSFER_PATH_MAX_BYTES),
  }),
  [MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE]: z.strictObject({
    machine: machineTargetRuntimeSchema.describe('Bare stable ref_name or complete ^^(ref_name) marker.'),
    sourcePath: boundedUtf8String(FILE_TRANSFER_PATH_MAX_BYTES),
    destinationPath: boundedUtf8String(FILE_TRANSFER_PATH_MAX_BYTES),
    overwrite: z.boolean().optional(),
  }),
  [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS]: z.strictObject({
    topic: z.enum(COMPUTER_USE_DOC_TOPICS).describe('Documentation topic.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL]: z.strictObject({
    machine: machineTargetRuntimeSchema.describe('Bare stable ref_name, complete ^^(ref_name) marker, or local/localhost/self/this; do not preflight list_machines when known.'),
    tool: z.enum(COMPUTER_USE_TOOLS).describe('Method name.'),
    arguments: z.record(z.string(), z.unknown()).optional().describe(`Method arguments. Windows coordinate drag additionally accepts duration_ms=${COMPUTER_USE_DRAG_DURATION_MIN_MS}..${COMPUTER_USE_DRAG_DURATION_MAX_MS}.`),
    timeoutMs: z.number().int().min(COMPUTER_USE_MIN_TIMEOUT_MS).max(COMPUTER_USE_SHELL_SESSION1_MAX_TIMEOUT_MS).optional().describe('Timeout ms; GUI/browser max 120000, shell_session1 max 900000.'),
  }).superRefine((value, ctx) => {
    if (value.timeoutMs !== undefined && value.timeoutMs > computerUseMaxTimeoutMs(value.tool)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['timeoutMs'], message: `timeoutMs exceeds the maximum for ${value.tool}` });
    }
  }),
} as const;

/**
 * Output schemas for the machine tools ONLY. Registering these publishes the
 * shape to the SDK, which validates non-error `structuredContent` against them —
 * catching field/nullable/outcome drift between the shared descriptor and the
 * runtime result. `exitCode` is nullable (signal/spawn failures have no code).
 */
const machineExecToolOutputRuntimeSchema = z.strictObject({
  status: z.literal('ok'),
  outcome: z.enum(REMOTE_EXEC_OUTCOMES),
  ok: z.boolean().optional(),
  exitCode: z.number().int().safe().nullable().optional(),
  stdout: boundedUtf8String(REMOTE_EXEC_MAX_OUTPUT_BYTES).optional(),
  stderr: boundedUtf8String(REMOTE_EXEC_MAX_OUTPUT_BYTES).optional(),
  timedOut: z.boolean().optional(),
  truncated: z.boolean().optional(),
  durationMs: z.number().int().safe().nonnegative().optional(),
  error: boundedUtf8String(REMOTE_EXEC_MAX_ERROR_BYTES).optional(),
}).superRefine((result, ctx) => {
  const fields = ['ok', 'exitCode', 'stdout', 'stderr', 'timedOut', 'truncated', 'durationMs'] as const;
  const hasAny = fields.some((field) => result[field] !== undefined) || result.error !== undefined;
  if (result.outcome === 'not_dispatched' || result.outcome === 'dispatched_no_result') {
    if (hasAny) ctx.addIssue({ code: 'custom', message: `${result.outcome} forbids command result fields` });
    return;
  }
  if (!fields.every((field) => result[field] !== undefined)) {
    ctx.addIssue({ code: 'custom', message: `${result.outcome} requires every command result field` });
    return;
  }
  if (result.outcome === 'completed') {
    if (result.ok !== true || result.exitCode === null || result.timedOut !== false || result.error !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'completed result fields are inconsistent' });
    }
    return;
  }
  if (result.ok !== false || result.exitCode !== null || typeof result.error !== 'string' || result.error.length === 0) {
    ctx.addIssue({ code: 'custom', message: `${result.outcome} result fields are inconsistent` });
    return;
  }
  if ((result.outcome === 'node_timeout') !== (result.timedOut === true)) {
    ctx.addIssue({ code: 'custom', message: `${result.outcome} timedOut field is inconsistent` });
  }
});

const machineToolOutputSchemas: Partial<Record<MemoryMcpToolName, z.ZodTypeAny>> = {
  [MEMORY_MCP_TOOL_NAMES.LIST_MACHINES]: z.strictObject({
    status: z.literal('ok'),
    machines: z.array(machineSummaryRuntimeSchema).max(MACHINE_LIST_MAX_ITEMS),
  }),
  [MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE]: machineExecToolOutputRuntimeSchema,
  [MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE]: z.strictObject({
    status: z.literal('ok'),
    machine: z.string().min(1),
    remotePath: boundedUtf8String(FILE_TRANSFER_PATH_MAX_BYTES),
    attachmentId: z.string().min(1).max(128),
    size: z.number().int().min(0).max(FILE_TRANSFER_LIMITS.MAX_FILE_SIZE),
  }),
  [MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE]: z.strictObject({
    status: z.literal('ok'),
    machine: z.string().min(1),
    destinationPath: boundedUtf8String(FILE_TRANSFER_PATH_MAX_BYTES),
    attachmentId: z.string().min(1).max(128),
    size: z.number().int().min(0).max(FILE_TRANSFER_LIMITS.MAX_FILE_SIZE),
  }),
  [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS]: z.strictObject({
    status: z.literal('ok'),
    topic: z.enum(COMPUTER_USE_DOC_TOPICS),
    text: z.string(),
  }),
  [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL]: z.strictObject({
    status: z.literal('ok'),
    outcome: z.enum(COMPUTER_USE_OUTCOMES),
    result: computerUseResultSchema.optional(),
  }).superRefine((value, ctx) => {
    if ((value.outcome === 'completed' || value.outcome === 'tool_error') !== (value.result !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'computer_use_call outcome/result mismatch' });
    }
  }),
} as const;

/** Descriptors advertised for a node of the given role (controlled excludes FULL-only tools). */
export function listMemoryMcpToolDescriptors(role: NodeRole = NODE_ROLE.FULL) {
  return advertisedMcpToolNames(role).map((name) => MEMORY_MCP_TOOL_CONTRACTS[name]);
}

export function registerMemoryMcpTools(server: McpServer, caller: McpRuntimeCaller, deps: MemoryMcpToolDeps = {}): void {
  const handlers = createMemoryMcpToolHandlers(caller, deps);
  // Role-gate the advertised surface: a controlled node never registers the
  // FULL-only machine tools, so its daemon.hello / tools/list excludes them (10.12).
  for (const name of advertisedMcpToolNames(deps.nodeRole ?? NODE_ROLE.FULL)) {
    const contract = MEMORY_MCP_TOOL_CONTRACTS[name];
    const outputSchema = machineToolOutputSchemas[name];
    server.registerTool(name, {
      description: contract.description,
      inputSchema: schemas[name],
      // Machine tools publish an output schema so the SDK validates structuredContent
      // shape/nullable/outcome against the shared descriptor (catches drift).
      ...(outputSchema ? { outputSchema } : {}),
    }, async (args: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      const progressToken = extra._meta?.progressToken;
      const context: MemoryMcpToolContext = { signal: extra.signal };
      if (name === MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE && progressToken !== undefined) {
        context.onProgress = async (chunk) => {
          if (extra.signal.aborted) return;
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: chunk.seq + 1,
              message: `[${chunk.stream}] ${chunk.chunk}`,
            },
          }).catch(() => {});
        };
      }
      return toolResult(await handlers[name](args, context));
    });
  }
}

// ---------------------------------------------------------------------------
// Alias MCP tools — full CRUD (resolve_alias / list_aliases / save_alias /
// delete_alias).
//
// Aliases are a separate, precise, server-stored, USER-SCOPED reference store,
// deliberately distinct from memory: memory is fuzzy/recall-ranked; an alias
// resolves to an exact value the user typed. Agents can READ (resolve one value
// / list metadata + search) and WRITE (save = create/edit upsert, delete). The
// server (source of truth, scoped to the daemon's bound owner user via the
// existing daemon→server auth) validates every write authoritatively with the
// SAME shared validators as the web app — the agent cannot bypass them. The web
// app remains the human CRUD surface; these tools give agents parity.
// ---------------------------------------------------------------------------

/** Injectable deps for the alias read tools (tests bypass the network here). */
export interface AliasMcpToolDeps {
  aliasClientOptions?: AliasMcpClientOptions;
  resolveAlias?: typeof aliasMcpResolve;
  listAliases?: typeof aliasMcpList;
  upsertAlias?: typeof aliasMcpUpsert;
  deleteAlias?: typeof aliasMcpDelete;
}

const ALIAS_MCP_TOOL_NAME_LIST: readonly AliasMcpToolName[] = [
  ALIAS_MCP_TOOLS.RESOLVE,
  ALIAS_MCP_TOOLS.LIST,
  ALIAS_MCP_TOOLS.SAVE,
  ALIAS_MCP_TOOLS.DELETE,
] as const;

const ALIAS_MCP_TOOL_DESCRIPTIONS: Readonly<Record<AliasMcpToolName, string>> = {
  [ALIAS_MCP_TOOLS.RESOLVE]:
    'Resolve an exact user-scoped alias value by case-sensitive NFC name; distinct from memory. Unknown names return found:false with alias_not_found. Use list_aliases, save_alias, or delete_alias for other operations.',
  [ALIAS_MCP_TOOLS.LIST]:
    'Search or list user-scoped alias METADATA ONLY (name, description, tags, timestamps); values are excluded. Use resolve_alias for one value.',
  [ALIAS_MCP_TOOLS.SAVE]:
    'Upsert a user-scoped alias name to an exact value with optional metadata. Existing names overwrite; server validation is authoritative. The value is inserted verbatim later and omitted from the response.',
  [ALIAS_MCP_TOOLS.DELETE]:
    'Delete a user-scoped alias by name. Missing names return deleted:false with alias_not_found, not an error.',
} as const;

const aliasSchemas: Record<AliasMcpToolName, z.ZodTypeAny> = {
  [ALIAS_MCP_TOOLS.RESOLVE]: z.object({
    name: z.string().describe('Case-sensitive NFC alias name.'),
  }),
  [ALIAS_MCP_TOOLS.LIST]: z.object({
    query: z.string().optional().describe('Literal NFC name/description substring.'),
  }),
  [ALIAS_MCP_TOOLS.SAVE]: z.object({
    name: z.string().describe('NFC letters/digits/._-, ≤20 code points; overwrites existing.'),
    value: z.string().describe('Exact inserted value; nonempty, ≤500 code points, no NUL.'),
    description: z.string().optional().describe('Description, ≤200 code points.'),
    tags: z.array(z.string()).optional().describe('≤10 tags, each ≤30 chars, no controls.'),
  }),
  [ALIAS_MCP_TOOLS.DELETE]: z.object({
    name: z.string().describe('Case-sensitive NFC alias name.'),
  }),
};

export function createAliasMcpToolHandlers(
  _caller: McpRuntimeCaller,
  deps: AliasMcpToolDeps = {},
): Record<AliasMcpToolName, MemoryMcpToolHandler> {
  const resolveAlias = deps.resolveAlias ?? aliasMcpResolve;
  const listAliases = deps.listAliases ?? aliasMcpList;
  const upsertAlias = deps.upsertAlias ?? aliasMcpUpsert;
  const deleteAlias = deps.deleteAlias ?? aliasMcpDelete;
  const options = deps.aliasClientOptions ?? {};

  const handlers: Record<AliasMcpToolName, MemoryMcpToolHandler> = {
    [ALIAS_MCP_TOOLS.RESOLVE]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['name']);
      const name = stringArg(args, 'name');
      if (!name) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'name is required');
      // `resolveAlias` returns a not-found result (never throws) for missing names.
      return await resolveAlias(name, options) as unknown as ToolResult;
    },
    [ALIAS_MCP_TOOLS.LIST]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['query']);
      const query = stringArg(args, 'query');
      const result = await listAliases(options, query);
      if (result.status !== 'ok') return result as unknown as ToolResult;
      // METADATA-ONLY: never expose alias `value` in a bulk listing — a single
      // list_aliases call would otherwise dump every plaintext value into the
      // agent's context/memory. `resolve_alias` is the only value path.
      return { status: 'ok', aliases: result.aliases.map(toAliasMetadata) } as unknown as ToolResult;
    },
    [ALIAS_MCP_TOOLS.SAVE]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['name', 'value', 'description', 'tags']);
      const name = stringArg(args, 'name');
      if (!name) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'name is required');
      const description = stringArg(args, 'description');
      const rawTags = (args as Record<string, unknown>).tags;
      const tags = Array.isArray(rawTags)
        ? rawTags.filter((t): t is string => typeof t === 'string')
        : undefined;
      // The server re-validates name/value/description/tags authoritatively and
      // rejects invalid input; we never pre-trust the agent-supplied value.
      const result = await upsertAlias(
        {
          name,
          value: stringArg(args, 'value') ?? '',
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags } : {}),
        },
        options,
      );
      if (result.status !== 'ok') return result as unknown as ToolResult;
      // Return metadata of the saved record — never re-echo the value the agent set.
      return { status: 'ok', saved: true, alias: toAliasMetadata(result.alias) } as unknown as ToolResult;
    },
    [ALIAS_MCP_TOOLS.DELETE]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['name']);
      const name = stringArg(args, 'name');
      if (!name) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'name is required');
      // `deleteAlias` returns deleted:false (not an error) for a missing name.
      return await deleteAlias(name, options) as unknown as ToolResult;
    },
  };

  const wrapped = {} as Record<AliasMcpToolName, MemoryMcpToolHandler>;
  for (const name of ALIAS_MCP_TOOL_NAME_LIST) {
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

export function registerAliasMcpTools(server: McpServer, caller: McpRuntimeCaller, deps: AliasMcpToolDeps = {}): void {
  const handlers = createAliasMcpToolHandlers(caller, deps);
  for (const name of ALIAS_MCP_TOOL_NAME_LIST) {
    server.registerTool(name, {
      description: ALIAS_MCP_TOOL_DESCRIPTIONS[name],
      inputSchema: aliasSchemas[name],
    }, async (args: unknown) => toolResult(await handlers[name](args)));
  }
}
