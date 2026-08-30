import { z } from 'zod';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
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
  MEMORY_MCP_SEND_DELIVERY_MODES,
  pickAllowedMcpArgs,
  advertisedMcpToolNames,
  type MemoryMcpSendDeliveryMode,
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
import { MACHINE_FILE_TRANSFER_TRANSPORT, type MachineFileTransferTransport } from '../../shared/machine-direct-file-transfer.js';
import { isValidMachineTarget, normalizeMachineTarget } from '../../shared/machine-reference.js';
import { isControlledNodeId } from '../../shared/controlled-node-identity.js';
import { MEMORY_PROJECT_SCOPE_REASON } from '../../shared/memory-project-scope.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import { resolveEffectiveProjectName, resolveRuntimeScope } from '../../shared/session-scope.js';
import { isDiscoverableInterAgentSession } from '../../shared/session-scope.js';
import { isDelegationReplyCapableAgentType } from '../../shared/agent-delegation.js';
import { getSessionRuntimeType } from '../../shared/agent-types.js';
import { resolveEffectiveSessionModel } from '../../shared/session-model.js';
import { DAEMON_VERSION } from '../util/version.js';
import { resolvePeerAuditNormalizedModelId, resolvePeerAuditProviderFamily } from './peer-audit-candidates.js';
import {
  MCP_FEATURE_FLAGS_BY_NAME,
  isMcpFeatureEnabled,
  type MCPFeatureFlagValues,
} from '../../shared/memory-mcp-feature-flags.js';
import { MEMORY_MCP_DEGRADED_REASON } from '../../shared/memory-ws.js';
import type { ContextNamespace, ProcessedContextProjection } from '../../shared/context-types.js';
import { LEGACY_DAEMON_LOCAL_USER_ID } from '../../shared/memory-namespace.js';
import {
  CRON_COMPLETION_POLICY,
  normalizeCronCompletionPolicy,
  type CronCompletionPolicy,
} from '../../shared/cron-types.js';
import { EXECUTION_CLONE_KIND, EXECUTION_CLONE_PARENT_STAGES, isExecutionCloneParentStage } from '../../shared/execution-clone.js';
import {
  PEER_AUDIT_VALIDATION_KINDS,
  PEER_AUDIT_VALIDATION_OUTCOMES,
  type PeerAuditReplyEnvelope,
} from '../../shared/peer-audit.js';
import {
  SUPERVISION_TASK_CLASSIFICATIONS,
  SUPERVISION_TASK_FILE_OPERATIONS,
  SUPERVISION_TASK_LIFECYCLE_STATUSES,
  type SupervisionTaskMetadata,
} from '../../shared/supervision-config.js';
import {
  SUPERVISION_EXECUTION_POOL_KINDS,
  normalizeSupervisionEconomyTaskPolicy,
  normalizeSupervisionExecutionConfig,
  type SupervisionExecutionPoolKind,
} from '../../shared/supervision-execution-pool.js';
import {
  AGENT_DELEGATION_PURPOSES,
  AGENT_DELEGATION_REPLY_VERSION,
  decodeAgentDelegationReplyEnvelope,
  isAgentDelegationOpaqueId,
  type AgentDelegationAuditRequest,
  type AgentDelegationReplyEnvelope,
} from '../../shared/agent-delegation.js';
import type { CapabilityService } from '../../shared/capability-management.js';
import type { CapabilityRuntimeIdentity } from './capability-mcp-tools.js';
import { decodePeerAuditReplyCommandStructure } from './peer-audit-reply-ingress.js';
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
import { getSupervisionTaskRegistry, type PersistedSupervisionTaskAssignmentIdentity } from './supervision-state-store.js';
import { cronMcpCreate, cronMcpCreateSelf, cronMcpDelete, cronMcpList, cronMcpUpdate, cronMcpUpdateSelf, type CronMcpClientOptions } from './cron-mcp-client.js';
import {
  registerMemoryShortRef,
  resolveMemoryShortRefCandidatesWithStore,
  resolveMemoryShortRefWithStore,
} from '../context/memory-short-ref.js';

/** Upper bound on records expanded for one colliding handle. */
const AMBIGUOUS_REF_CANDIDATE_CAP = 4;
import { GitOriginRepositoryIdentityService } from '../agent/repository-identity-service.js';
import { ALIAS_DESCRIPTION_MAX, ALIAS_MCP_TOOLS, toAliasMetadata, type AliasMcpToolName } from '../../shared/alias-types.js';
import { mapLegacySupervisionUpdate, mapLegacySupervisionFinish } from './supervision-compat-shims.js';
import { resolveSupervisionIntent } from './supervision-intent-ops.js';
import { supervisionCallerParticipates } from './supervision-mcp-tools.js';
import {
  aliasMcpList,
  aliasMcpResolve,
  aliasMcpUpsert,
  aliasMcpDelete,
  type AliasMcpClientOptions,
} from './alias-mcp-client.js';

type ToolResult = Record<string, unknown>;

const integrationManifestEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const integrationFinalizationSchema = z.object({
  assignmentId: z.string().min(1),
  revision: z.string().min(1),
  auditAttemptId: z.string().min(1),
  auditRevision: z.string().min(1),
  verdict: z.literal('PASS'),
  ownedFiles: z.array(z.string().min(1)).min(1),
  integrationManifest: z.array(integrationManifestEntrySchema).min(1),
  integrationOwner: z.string().min(1),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  pushResult: z.enum(['pushed', 'already_present']),
  pushRemoteRef: z.string().min(1),
  stagedPaths: z.array(z.string().min(1)).min(1),
  conflictedPaths: z.array(z.string()),
  untrackedOtherOwnerPaths: z.array(z.string()),
  externalRunId: z.string().min(1),
  externalHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  externalTaskId: z.string().min(1).optional(),
  ciResult: z.literal('success'),
  evidence: z.string().optional(),
}).strict();

const legacySupervisionFinishSchema = z.object({
  assignmentId: z.string(), revision: z.string().optional(), evidence: z.string().optional(),
}).strict();

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
  /** Registered-node AI-managed MCP/Skill service. Capability tools are absent when unavailable. */
  capabilityService?: CapabilityService;
  /** Caller context resolver used only when activating binding-scoped Skill instructions. */
  resolveCapabilityIdentity?: (caller: McpRuntimeCaller) => Promise<CapabilityRuntimeIdentity | null>;
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
  peerAuditReply?: (envelope: PeerAuditReplyEnvelope) => Promise<Record<string, unknown>> | Record<string, unknown>;
  delegationReply?: (envelope: AgentDelegationReplyEnvelope) => Promise<Record<string, unknown>> | Record<string, unknown>;
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

/** One machine in the `list_machines` result (agent-facing, canonical-nodeId keyed). */
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
  | { ok: true; size: number; attachmentId: string; transport: MachineFileTransferTransport; remotePath?: string; destinationPath?: string }
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

const controlledNodeIdRuntimeSchema = z.string().refine(isControlledNodeId, {
  message: 'must be a canonical controlled-node nodeId',
});

const machineTargetRuntimeSchema = z.string().refine(isValidMachineTarget, {
  message: 'must be a canonical nodeId/^^(nodeId) or deprecated noncanonical legacy alias',
});

const machineSummaryShape = {
  name: controlledNodeIdRuntimeSchema,
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

function sendDeliveryModeArg(value: unknown): MemoryMcpSendDeliveryMode | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return Object.values(MEMORY_MCP_SEND_DELIVERY_MODES).includes(value as MemoryMcpSendDeliveryMode)
    ? value as MemoryMcpSendDeliveryMode
    : 'invalid';
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


const TASK_ARG_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'taskId', 'assignmentId', 'topLevelTaskId', 'sliceId', 'classification', 'objective', 'acceptance',
  'ownedFiles', 'sharedFiles', 'dependencies', 'integrationOwner', 'baseRevision',
  'currentRevision', 'auditAttemptId', 'auditRevision', 'executionPool',
  'autoProvision', 'requestedExecutionType', 'economyPolicy',
]);

function parseTaskArg(value: unknown): SupervisionTaskMetadata | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !TASK_ARG_ALLOWED_KEYS.has(key))) return 'invalid';
  const stringField = (key: string): string | undefined => typeof record[key] === 'string' && record[key].trim() ? record[key].trim() : undefined;
  const arrayField = (key: string): string[] | undefined => Array.isArray(record[key]) ? (record[key] as unknown[]).filter((item): item is string => typeof item === 'string') : undefined;
  const requestedExecutionType = normalizeSupervisionExecutionConfig(record.requestedExecutionType);
  const economyPolicy = normalizeSupervisionEconomyTaskPolicy(record.economyPolicy);
  if (record.requestedExecutionType != null && !requestedExecutionType) return 'invalid';
  if (record.economyPolicy != null && !economyPolicy) return 'invalid';
  if (record.executionPool != null && record.executionPool !== 'primary' && record.executionPool !== 'economy') return 'invalid';
  if (record.autoProvision !== undefined && record.autoProvision !== true) return 'invalid';
  return {
    taskId: stringField('taskId'),
    assignmentId: stringField('assignmentId'),
    topLevelTaskId: stringField('topLevelTaskId'),
    sliceId: stringField('sliceId'),
    classification: typeof record.classification === 'string' ? record.classification as never : undefined,
    objective: stringField('objective'),
    acceptance: arrayField('acceptance'),
    ownedFiles: arrayField('ownedFiles'),
    sharedFiles: arrayField('sharedFiles'),
    dependencies: arrayField('dependencies'),
    integrationOwner: stringField('integrationOwner'),
    baseRevision: stringField('baseRevision'),
    currentRevision: stringField('currentRevision'),
    auditAttemptId: stringField('auditAttemptId'),
    auditRevision: stringField('auditRevision'),
    executionPool: record.executionPool as 'primary' | 'economy' | undefined,
    autoProvision: record.autoProvision === true ? true : undefined,
    ...(requestedExecutionType ? { requestedExecutionType } : {}),
    ...(economyPolicy ? { economyPolicy } : {}),
  };
}

const AUDIT_ARG_ALLOWED_KEYS: ReadonlySet<string> = new Set(['kind', 'attemptId', 'auditedSessionName', 'strictCrossVendor']);

/**
 * Parse the strict supervision-audit envelope.
 *
 * `auditedSessionName` is REQUIRED and must be a real session name. It is not
 * defaulted from the caller or the target: a Supervisor Brain dispatching an
 * audit is neither the auditor nor the audited, so any such default silently
 * mislabels the subject. Absent or malformed fails closed as 'invalid'.
 */
export function parseAuditArg(value: unknown): AgentDelegationAuditRequest | undefined | 'invalid' {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const record = value as Record<string, unknown>;
  const auditedSessionName = typeof record.auditedSessionName === 'string'
    ? record.auditedSessionName.trim() : '';
  if (Object.keys(record).some((key) => !AUDIT_ARG_ALLOWED_KEYS.has(key))
    || record.kind !== AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT
    || !isAgentDelegationOpaqueId(record.attemptId)
    || !auditedSessionName
    || auditedSessionName !== record.auditedSessionName
    || (record.strictCrossVendor !== undefined && record.strictCrossVendor !== true)) return 'invalid';
  return {
    kind: AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT,
    attemptId: record.attemptId,
    auditedSessionName,
    ...(record.strictCrossVendor === true ? { strictCrossVendor: true } : {}),
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

async function defaultSessionAuthorityActive(session: SessionRecord): Promise<boolean> {
  if (session.state === 'stopped' || session.state === 'error') return false;
  const runtimeType = session.runtimeType ?? getSessionRuntimeType(session.agentType);
  if (runtimeType === 'transport') {
    const { getTransportRuntime } = await import('../agent/session-manager.js');
    return Boolean(getTransportRuntime(session.name));
  }
  const { sessionExists } = await import('../agent/tmux.js');
  return sessionExists(session.name).catch(() => false);
}

async function mergeAuthoritativelyActiveSendSessions(
  current: SessionRecord[],
  priorCandidates: SessionRecord[],
  active: (session: SessionRecord) => boolean | Promise<boolean>,
): Promise<SessionRecord[]> {
  const byName = new Map(current.map((session) => [session.name, session]));
  for (const candidate of priorCandidates) {
    // An explicit current record is authoritative, including stopped/error.
    // Only absence is eligible for recovery from a prior directory snapshot.
    if (byName.has(candidate.name)) continue;
    if (candidate.state === 'stopped' || candidate.state === 'error') continue;
    if (await active(candidate)) byName.set(candidate.name, candidate);
  }
  return [...byName.values()];
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
  completionPolicy: CronCompletionPolicy;
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
    const completionPolicy = normalizeCronCompletionPolicy(row.completion_policy ?? row.completionPolicy);
    return id && name ? [{ id, name, projectName, targetRole, targetSessionName, completionPolicy }] : [];
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

function selfCronControlMetadata(jobId: string, completionPolicy: CronCompletionPolicy): Record<string, unknown> {
  const recurring = completionPolicy === CRON_COMPLETION_POLICY.RECURRING;
  return {
    preferredCronInterface: true,
    jobId,
    completionPolicy,
    controls: {
      update: { tool: MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF, args: { id: jobId } },
      cancel: {
        tool: MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF,
        args: { id: jobId },
        ...(recurring ? { forceRequired: true } : {}),
      },
    },
    lifecycleInstruction: recurring
      ? `This recurring job remains scheduled after each occurrence. Do not call ${MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF} after a successful run. Only an explicit user request may remove it, using force=true.`
      : `When the overall scheduled goal—not merely one occurrence—is complete, call ${MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF} with this jobId.`,
  };
}

function cronCompletionPolicyArg(value: unknown): CronCompletionPolicy | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (value === CRON_COMPLETION_POLICY.RECURRING || value === CRON_COMPLETION_POLICY.UNTIL_COMPLETE) return value;
  return 'invalid';
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

async function resolveProjectionRefArg(
  args: Record<string, unknown>,
  namespace: ContextNamespace,
): Promise<string | ToolResult> {
  const projectionId = stringArg(args, 'projectionId');
  const ref = stringArg(args, 'ref');
  if (projectionId && ref) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'ref cannot be combined with projectionId');
  if (projectionId) return projectionId;
  if (!ref) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'projectionId or ref is required');
  const resolved = await resolveMemoryShortRefWithStore(ref, namespace);
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
  const sendSessions = async (): Promise<SessionRecord[]> => {
    // Keep the in-memory directory before disk refresh. A valid but stale
    // sessions.json snapshot can omit one live SDK/tmux session without being
    // empty or malformed; replacing the whole store made that target vanish
    // from both list and send until a later writer restored it.
    const beforeRefresh = deps.sendDeps?.listSessions
      ? []
      : listStoredSessions();
    if (!deps.sendDeps?.listSessions) await loadStore({ probe: false });
    const current = deps.sendDeps?.listSessions
      ? deps.sendDeps.listSessions()
      : listStoredSessions();
    const priorCandidates = [...beforeRefresh, ...(lastGoodSendSessions ?? [])];
    const selected = await mergeAuthoritativelyActiveSendSessions(
      current,
      priorCandidates,
      deps.sendDeps?.isSessionAuthoritativelyActive ?? defaultSessionAuthorityActive,
    );
    if (hasSendCaller(caller, selected) || sendVisibleSiblingCount(caller, selected) > 0) {
      lastGoodSendSessions = selected;
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


  const supervisionTaskIdentity = async (): Promise<PersistedSupervisionTaskAssignmentIdentity | undefined> => {
    if (!caller.sessionName) return undefined;
    const sessions = await sendSessions();
    const record = sessions.find((session) => session.name === caller.sessionName);
    if (!record?.sessionInstanceId || !record.runtimeEpoch) return undefined;
    return {
      sessionName: record.name,
      sessionInstanceId: record.sessionInstanceId,
      runtimeEpoch: record.runtimeEpoch,
      agentType: record.agentType,
      providerFamily: resolvePeerAuditProviderFamily(record),
    };
  };

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
        const candidates = await resolveMemoryShortRefCandidatesWithStore(ref, scopedCaller.namespace);
        if (candidates.length === 0) return { status: 'ok', ref, sourceEventCount: 0, sources: [] };
        // A digest collision (two records deriving one handle) should never
        // happen at 65 bits. If it does, answering with one of them would be a
        // silently wrong memory — but refusing outright throws away information
        // the caller can use. Expand every candidate and let the caller judge,
        // flagged so it is never mistaken for a single authoritative answer.
        if (candidates.length > 1) {
          // The single-candidate path below rejects a kind that disagrees with
          // the ref; the ambiguous path must enforce the same contract rather
          // than quietly ignoring the caller's constraint.
          if (kind && candidates.some((candidate) => candidate.kind !== kind)) {
            return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'source lookup kind does not match the supplied ref');
          }
          const expanded = [];
          for (const candidate of candidates.slice(0, AMBIGUOUS_REF_CANDIDATE_CAP)) {
            const identity = candidate.kind === 'observation'
              ? { kind: candidate.kind, observationId: candidate.id }
              : { kind: candidate.kind, projectionId: candidate.id };
            try {
              if (candidate.kind === 'observation') {
                expanded.push({ ...identity, ...(await memoryGetSources({ observationId: candidate.id, kind: 'observation' }, scopedCaller)) });
                continue;
              }
              const candidateResult = await orchestrator(candidate.id, scopedCaller);
              if (candidateResult.status === 'error') {
                expanded.push({ ...identity, unavailable: candidateResult.message });
                continue;
              }
              const { status: _candidateStatus, ...candidatePayload } = candidateResult;
              expanded.push({ ...identity, ...candidatePayload });
            } catch {
              expanded.push({ ...identity, unavailable: 'expansion failed' });
            }
          }
          return {
            status: 'ok',
            ref,
            ambiguousRef: true,
            // Expansion is bounded, so say how many records the handle actually
            // covers. Reporting only the expanded subset while calling it every
            // match would send the caller away believing it had seen them all.
            candidateCount: candidates.length,
            truncated: candidates.length > expanded.length,
            candidates: expanded,
            sourceEventCount: 0,
            sources: [],
          };
        }
        const resolved = candidates[0]!;
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
      const projectionId = await resolveProjectionRefArg(args, scopedCaller.namespace);
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
      const projectionId = await resolveProjectionRefArg(args, scopedCaller.namespace);
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
      const projectionId = await resolveProjectionRefArg(args, scopedCaller.namespace);
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
      const projectionId = await resolveProjectionRefArg(args, scopedCaller.namespace);
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
      const projectionId = await resolveProjectionRefArg(args, scopedCaller.namespace);
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
    [MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY]: async (input) => {
      if (!deps.peerAuditReply) return error(MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, 'peer audit reply ingress is unavailable');
      // This is deliberately structure-only. Evidence policy runs only after
      // the daemon ingress has bound the exact assignment and live sender/destination.
      const decoded = decodePeerAuditReplyCommandStructure(input);
      if (!decoded.ok) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, decoded.error);
      const result = await deps.peerAuditReply(decoded.value);
      return result.ok === false
        ? error(MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, String(result.error ?? 'peer audit reply rejected'))
        : { status: 'ok', accepted: true };
    },
    [MEMORY_MCP_TOOL_NAMES.DELEGATION_REPLY]: async (input) => {
      if (!deps.delegationReply) return error(MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, 'delegation reply ingress is unavailable');
      const record = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
      const decoded = decodeAgentDelegationReplyEnvelope({
        ...record,
        version: AGENT_DELEGATION_REPLY_VERSION,
      });
      if (!decoded.ok) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, decoded.error);
      const result = await deps.delegationReply(decoded.value);
      return result.ok === false
        ? error(MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, String(result.error ?? 'delegation reply rejected'))
        : {
            status: 'ok',
            accepted: true,
            delivered: result.delivered === true,
            ...(result.pending === true ? { pending: true } : {}),
          };
    },
    [MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['query', 'limit', 'executionPool']);
      const rawExecutionPool = args.executionPool;
      if (rawExecutionPool !== undefined
        && (typeof rawExecutionPool !== 'string'
          || !(SUPERVISION_EXECUTION_POOL_KINDS as readonly string[]).includes(rawExecutionPool))) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'executionPool must be primary or economy');
      }
      const executionPoolValue = rawExecutionPool as SupervisionExecutionPoolKind | undefined;
      const sessions = await sendSessions();
      return listSendTargets(caller, {
        query: stringArg(args, 'query'),
        limit: numberArg(args, 'limit'),
        executionPool: executionPoolValue,
      }, sendDepsWithSessions(sessions, {
        isDispatchEnabled: () => deps.sendDeps?.isDispatchEnabled?.() ?? true,
      })) as unknown as ToolResult;
    },
    [MEMORY_MCP_TOOL_NAMES.SESSION_RUNTIME_IDENTITY_GET]: async (input) => {
      if (input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input as Record<string, unknown>).length > 0) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'session_runtime_identity_get takes no arguments');
      if (!caller.sessionName) return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'bound caller session is unavailable');
      const sessions = await sendSessions();
      const session = sessions.find((candidate) => candidate.name === caller.sessionName);
      if (!session || !session.sessionInstanceId || !session.runtimeEpoch) return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'live caller runtime identity is unavailable');
      const effectiveModel = resolveEffectiveSessionModel(session);
      const normalizedModelId = resolvePeerAuditNormalizedModelId(session);
      const modelSource = session.activeModel ? 'active_model'
        : session.requestedModel ? 'requested_model'
          : session.modelDisplay ? 'model_display'
            : session.qwenModel ? 'qwen_model' : 'unknown';
      return {
        status: 'ok',
        identity: {
          sessionName: session.name,
          sessionInstanceId: session.sessionInstanceId,
          runtimeEpoch: session.runtimeEpoch,
          agentType: session.agentType,
          runtimeType: session.runtimeType ?? getSessionRuntimeType(session.agentType),
          providerId: session.providerId ?? null,
          providerFamily: resolvePeerAuditProviderFamily(session),
          normalizedModelId: normalizedModelId === 'unknown' ? null : normalizedModelId,
          effectiveModelId: effectiveModel ?? null,
          activeModel: session.activeModel ?? null,
          requestedModel: session.requestedModel ?? null,
          modelDisplay: session.modelDisplay ?? null,
          qwenModel: session.qwenModel ?? null,
          modelMetadataState: effectiveModel ? 'known' : 'unknown',
          modelMetadataSource: modelSource,
          modelMetadataConfidence: session.activeModel ? 'daemon_observed' : effectiveModel ? 'configured' : 'none',
          ...(effectiveModel ? {} : { unknownReason: 'no_daemon_model_metadata' }),
          daemonVersion: DAEMON_VERSION,
          daemonBuildRevision: process.env.IMCODES_BUILD_REVISION ?? process.env.GIT_COMMIT ?? null,
          state: session.state,
          replyCapable: isDelegationReplyCapableAgentType(session.agentType),
          discoverable: isDiscoverableInterAgentSession(session),
          projectName: resolveEffectiveProjectName(session, sessions) ?? null,
        },
      };
    },
    [MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]: async (input) => {
      const sessions = await sendSessions();
      const args = pickAllowedMcpArgs(input, ['target', 'message', 'files', 'reply', 'audit', 'task', 'broadcast', 'idempotencyKey', 'deliveryMode', 'clone']);
      const clone = parseCloneArg(args.clone);
      if (clone === 'invalid') return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'clone request is invalid');
      const audit = parseAuditArg(args.audit);
      if (audit === 'invalid') return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'audit request is invalid');
      const task = parseTaskArg(args.task);
      if (task === 'invalid') return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'task metadata is invalid');
      const deliveryMode = sendDeliveryModeArg(args.deliveryMode);
      if (deliveryMode === 'invalid') return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'deliveryMode is invalid');
      return dispatchSendMessage(caller, {
        target: stringArg(args, 'target'),
        message: stringArg(args, 'message'),
        files: stringArrayArg(args, 'files'),
        reply: boolArg(args, 'reply'),
        ...(audit ? { audit } : {}),
        ...(task ? { task } : {}),
        broadcast: boolArg(args, 'broadcast'),
        idempotencyKey: stringArg(args, 'idempotencyKey'),
        ...(deliveryMode ? { deliveryMode } : {}),
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

    [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['taskId', 'topLevelTaskId', 'classification', 'role', 'objective', 'acceptance', 'scopeFiles', 'claimMode', 'idempotencyKey']);
      const identity = await supervisionTaskIdentity();
      if (!identity) return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'supervision task caller identity is unavailable');
      const registry = getSupervisionTaskRegistry();
      const projectName = caller.projectName?.trim();
      if (!projectName) return error(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, 'supervision task caller project is unavailable');
      const requestedTaskId = stringArg(args, 'taskId')?.trim();
      const existing = requestedTaskId ? registry.get(requestedTaskId) : undefined;
      // taskId is a reference, never a create hint. Missing, cross-project and
      // non-participant tasks share one refusal so this tool cannot probe the
      // registry or silently mint a replacement task.
      if (requestedTaskId && (
        !existing
        || existing.projectName !== projectName
        || !supervisionCallerParticipates(existing, identity.sessionName)
      )) {
        return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'task is not visible to this caller');
      }
      const requestedRole = typeof args.role === 'string' ? args.role : 'implementer';
      const task = existing
        ? { ok: true as const, value: existing, replay: true as const }
        : registry.createOrGet({
            projectName,
            topLevelTaskId: stringArg(args, 'topLevelTaskId'),
            classification: typeof args.classification === 'string' ? args.classification as never : undefined,
            objective: stringArg(args, 'objective'),
            acceptance: stringArrayArg(args, 'acceptance'),
            idempotencyKey: stringArg(args, 'idempotencyKey'),
          });
      if (!task.ok) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, `task_start rejected: ${task.reason}`);
      if (existing && requestedRole === 'implementer') {
        const active = existing.assignments.filter((assignment) => (
          assignment.role === 'implementer'
          && !['cancelled', 'blocked', 'ready_for_audit', 'ready_for_integration', 'committed', 'pushed', 'finalized']
            .includes(assignment.status)
        ));
        if (active.length > 0) {
          const requestedScope = [...new Set(stringArrayArg(args, 'scopeFiles'))].sort();
          const same = active.length === 1
            && active[0]!.identity.sessionName === identity.sessionName
            && active[0]!.identity.sessionInstanceId === identity.sessionInstanceId
            && active[0]!.identity.runtimeEpoch === identity.runtimeEpoch
            && active[0]!.identity.agentType === identity.agentType
            && active[0]!.identity.providerFamily === identity.providerFamily
            && JSON.stringify([...active[0]!.scopeFiles].sort()) === JSON.stringify(requestedScope);
          return same
            ? {
                status: 'ok', taskId: task.value.taskId,
                assignmentId: active[0]!.assignmentId, idempotentReplay: true,
              }
            : error(
                MCP_ERROR_REASONS.VALIDATION_FAILED,
                'existing task continuation must use send_message deliveryMode=append; task_start cannot mint another implementer assignment',
              );
        }
      }
      const assignment = registry.createAssignment({
        taskId: task.value.taskId,
        role: requestedRole as never,
        identity,
        scopeFiles: stringArrayArg(args, 'scopeFiles'),
        claimMode: typeof args.claimMode === 'string' ? args.claimMode as never : undefined,
        idempotencyKey: stringArg(args, 'idempotencyKey'),
      });
      if (!assignment.ok) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, `assignment rejected: ${assignment.reason}`);
      return { status: 'ok', taskId: task.value.taskId, assignmentId: assignment.value.assignmentId, idempotentReplay: task.replay === true || assignment.replay === true };
    },
    [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE]: async (input) => {
      // Intent-only compatibility shim: the caller supplies metadata, never a
      // lifecycle destination. The daemon derives the status from the intent.
      const mapped = mapLegacySupervisionUpdate(input);
      if (!mapped.ok) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, mapped.detail);
      const identity = await supervisionTaskIdentity();
      if (!identity) return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'supervision task caller identity is unavailable');
      const registry = getSupervisionTaskRegistry();
      const existing = registry.getAssignment(mapped.assignmentId);
      if (!existing) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'task_update rejected: not_found');
      const outcome = resolveSupervisionIntent({
        request: { intent: mapped.intent, taskId: existing.taskId, assignmentId: mapped.assignmentId },
        currentStatus: existing.status,
      });
      if (!outcome.ok) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, `task_update rejected: ${outcome.refusal}`);
      const updated = registry.updateAssignment({
        assignmentId: mapped.assignmentId, identity,
        status: (outcome.toStatus ?? existing.status) as never,
        revision: mapped.metadata.revision,
        auditAttemptId: mapped.metadata.auditAttemptId,
        auditRevision: mapped.metadata.auditRevision,
        verdict: mapped.metadata.verdict,
        blocker: mapped.metadata.blocker,
        externalRunId: mapped.metadata.externalRunId,
        externalHeadSha: mapped.metadata.externalHeadSha,
        externalTaskId: mapped.metadata.externalTaskId,
      });
      return updated.ok ? { status: 'ok', item: updated.value } : error(MCP_ERROR_REASONS.VALIDATION_FAILED, `task_update rejected: ${updated.reason}`);
    },
    [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]: async (input) => {
      // Legacy assignment-only finish remains compatible; it can never close
      // a whole integration task from evidence prose.
      const mapped = mapLegacySupervisionFinish(input);
      if (!mapped.ok) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, mapped.detail);
      const identity = await supervisionTaskIdentity();
      if (!identity) return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'supervision task caller identity is unavailable');
      const registry = getSupervisionTaskRegistry();
      const existing = registry.getAssignment(mapped.assignmentId);
      if (!existing) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'task_finish rejected: not_found');
      const updated = registry.finishAssignment({
        assignmentId: mapped.assignmentId,
        identity,
        revision: mapped.metadata.revision,
        evidence: mapped.metadata.evidence,
      });
      return updated.ok ? { status: 'ok', item: updated.value } : error(MCP_ERROR_REASONS.VALIDATION_FAILED, `task_finish rejected: ${updated.reason}`);
    },
    [MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_FINALIZE]: async (input) => {
      const parsed = integrationFinalizationSchema.safeParse(input);
      if (!parsed.success) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'integration_finalize rejected: invalid structured finalization');
      }
      const identity = await supervisionTaskIdentity();
      if (!identity) return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'supervision task caller identity is unavailable');
      const finalized = getSupervisionTaskRegistry().finalizeIntegration({ ...parsed.data, identity });
      return finalized.ok
        ? { status: 'ok', item: finalized.value, idempotentReplay: finalized.replay === true }
        : error(MCP_ERROR_REASONS.VALIDATION_FAILED, `integration_finalize rejected: ${finalized.reason}`);
    },
    [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['assignmentId', 'filePath', 'operation', 'beforeHash', 'afterHash', 'tool', 'source', 'idempotencyKey']);
      const identity = await supervisionTaskIdentity();
      if (!identity) return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'supervision task caller identity is unavailable');
      const assignmentId = stringArg(args, 'assignmentId');
      const path = stringArg(args, 'filePath');
      const operation = stringArg(args, 'operation');
      if (!assignmentId || !path || !operation) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'assignmentId, filePath and operation are required');
      const recorded = getSupervisionTaskRegistry().recordFileEvent({ assignmentId, path, operation: operation as never, identity, beforeHash: stringArg(args, 'beforeHash'), afterHash: stringArg(args, 'afterHash'), tool: stringArg(args, 'tool'), source: stringArg(args, 'source'), idempotencyKey: stringArg(args, 'idempotencyKey') });
      return recorded.ok ? { status: 'ok', item: recorded.value } : error(MCP_ERROR_REASONS.VALIDATION_FAILED, `task_file_event rejected: ${recorded.reason}`);
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
      const args = pickAllowedMcpArgs(input, ['cronExpr', 'message', 'name', 'timezone', 'expiresAt', 'completionPolicy']);
      const cronExpr = stringArg(args, 'cronExpr');
      const message = stringArg(args, 'message');
      if (!cronExpr) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'cronExpr is required');
      if (!message) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'message is required');
      const expiresAt = parseExpiresAt(args.expiresAt);
      if (Number.isNaN(expiresAt)) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'expiresAt must be a timestamp or ISO string');
      const completionPolicy = cronCompletionPolicyArg(args.completionPolicy);
      if (completionPolicy === 'invalid') return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'completionPolicy must be recurring or until_complete');
      const effectiveCompletionPolicy = completionPolicy ?? CRON_COMPLETION_POLICY.RECURRING;
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
        completionPolicy: effectiveCompletionPolicy,
      }, cronOptions);
      if (result.status !== 'ok') return result as unknown as ToolResult;
      const jobId = cronResultJobId(result);
      return {
        ...result,
        ...(jobId ? selfCronControlMetadata(jobId, effectiveCompletionPolicy) : {}),
      } as unknown as ToolResult;
    },
    [MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['id', 'cronExpr', 'message', 'name', 'timezone', 'expiresAt', 'completionPolicy', 'force']);
      const id = stringArg(args, 'id');
      if (!id) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'id is required');
      const hasUpdate = ['cronExpr', 'message', 'name', 'timezone'].some((key) => stringArg(args, key) !== undefined)
        || args.expiresAt !== undefined
        || args.completionPolicy !== undefined;
      if (!hasUpdate) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'at least one update field is required');
      if (args.message !== undefined && !stringArg(args, 'message')) {
        return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'message must not be empty');
      }
      const expiresAt = parseExpiresAt(args.expiresAt);
      if (Number.isNaN(expiresAt)) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'expiresAt must be a timestamp or ISO string');
      const completionPolicy = cronCompletionPolicyArg(args.completionPolicy);
      if (completionPolicy === 'invalid') return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'completionPolicy must be recurring or until_complete');
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
        completionPolicy,
        force: boolArg(args, 'force') === true,
      }, cronOptions);
      if (result.status !== 'ok') return result as unknown as ToolResult;
      return {
        ...result,
        ...selfCronControlMetadata(id, completionPolicy ?? job.completionPolicy),
      } as unknown as ToolResult;
    },
    [MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['id', 'name', 'all', 'force']);
      const id = stringArg(args, 'id');
      const name = stringArg(args, 'name');
      const all = boolArg(args, 'all') === true;
      const force = boolArg(args, 'force') === true;
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
      const protectedRecurring = matches.filter((job) => job.completionPolicy === CRON_COMPLETION_POLICY.RECURRING);
      if (protectedRecurring.length > 0 && !force) {
        return {
          ...error(
            MCP_ERROR_REASONS.VALIDATION_FAILED,
            'recurring jobs require force=true and may be removed only after an explicit user request',
          ),
          protected: protectedRecurring.map((job) => ({ id: job.id, name: job.name })),
        };
      }
      const deleted: Array<{ id: string; name: string }> = [];
      for (const job of matches) {
        const result = await cronDelete(job.id, cronOptions, force);
        if (result.status !== 'ok') {
          return { ...result, deleted } as unknown as ToolResult;
        }
        deleted.push({ id: job.id, name: job.name });
      }
      return { status: 'ok', count: deleted.length, deleted };
    },
    [MEMORY_MCP_TOOL_NAMES.CRON_CREATE]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['name', 'cronExpr', 'projectName', 'targetRole', 'targetSessionName', 'action', 'timezone', 'expiresAt', 'completionPolicy']);
      const expiresAt = parseExpiresAt(args.expiresAt);
      if (Number.isNaN(expiresAt)) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'expiresAt must be a timestamp or ISO string');
      const completionPolicy = cronCompletionPolicyArg(args.completionPolicy);
      if (completionPolicy === 'invalid') return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'completionPolicy must be recurring or until_complete');
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
        completionPolicy,
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
      const args = pickAllowedMcpArgs(input, ['id', 'name', 'cronExpr', 'projectName', 'targetRole', 'targetSessionName', 'action', 'timezone', 'expiresAt', 'completionPolicy', 'force']);
      const id = stringArg(args, 'id');
      if (!id) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'id is required');
      const expiresAt = parseExpiresAt(args.expiresAt);
      if (Number.isNaN(expiresAt)) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'expiresAt must be a timestamp or ISO string');
      const completionPolicy = cronCompletionPolicyArg(args.completionPolicy);
      if (completionPolicy === 'invalid') return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'completionPolicy must be recurring or until_complete');
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
        completionPolicy,
        force: boolArg(args, 'force') === true,
      }, cronOptions) as unknown as Promise<ToolResult>;
    },
    [MEMORY_MCP_TOOL_NAMES.CRON_DELETE]: async (input) => {
      const args = pickAllowedMcpArgs(input, ['id', 'force']);
      const id = stringArg(args, 'id');
      if (!id) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'id is required');
      const cronOptions = cronOptionsForCaller(caller, deps);
      if ('status' in cronOptions) return cronOptions;
      return cronDelete(id, cronOptions, boolArg(args, 'force') === true) as unknown as Promise<ToolResult>;
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
      if (!machine) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'machine must be a canonical nodeId or deprecated legacy alias');
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
      if (!machine || !sourcePath) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'a canonical nodeId (or deprecated legacy alias) and sourcePath are required');
      if (utf8ByteLength(sourcePath) > FILE_TRANSFER_PATH_MAX_BYTES) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'sourcePath is too long');
      const result = await deps.machineDeps.sendFileToMachine({
        machine,
        sourcePath,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      if (!result.ok) return error(result.reason, result.error);
      if (!result.remotePath) return error(MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, 'machine file transfer returned no destination path');
      if (!result.transport) return error(MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, 'machine file transfer returned no transport mode');
      return { status: 'ok', machine, remotePath: result.remotePath, attachmentId: result.attachmentId, size: result.size, transport: result.transport };
    },
    [MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE]: async (input, context) => {
      if (!deps.machineDeps?.fetchFileFromMachine) return error(MCP_ERROR_REASONS.FEATURE_DISABLED, 'machine file transfer is not available on this node');
      const args = pickAllowedMcpArgs(input, ['machine', 'sourcePath', 'destinationPath', 'overwrite']);
      const machine = machineArg(args);
      const sourcePath = stringArg(args, 'sourcePath');
      const destinationPath = stringArg(args, 'destinationPath');
      const overwrite = boolArg(args, 'overwrite') ?? false;
      if (!machine || !sourcePath || !destinationPath) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'a canonical nodeId (or deprecated legacy alias), sourcePath, and destinationPath are required');
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
      if (!result.transport) return error(MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE, 'machine file transfer returned no transport mode');
      return {
        status: 'ok',
        machine,
        destinationPath: result.destinationPath,
        attachmentId: result.attachmentId,
        size: result.size,
        transport: result.transport,
      };
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
      if (!machine) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'machine must be a canonical nodeId, deprecated legacy alias, or local alias');
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

function computerUseTopLevelContent(result: ToolResult): CallToolResult['content'] {
  if (result.status !== 'ok' || !('result' in result) || !result.result || typeof result.result !== 'object') {
    return [{ type: 'text', text: JSON.stringify(result) }];
  }
  const computerResult = result.result as { content?: unknown };
  if (!Array.isArray(computerResult.content)) return [{ type: 'text', text: JSON.stringify(result) }];
  const images = computerResult.content.filter((item): item is { type: 'image'; data: string; mimeType: string } => (
    Boolean(item)
    && typeof item === 'object'
    && !Array.isArray(item)
    && (item as { type?: unknown }).type === 'image'
    && typeof (item as { data?: unknown }).data === 'string'
    && typeof (item as { mimeType?: unknown }).mimeType === 'string'
  ));
  if (images.length === 0) return [{ type: 'text', text: JSON.stringify(result) }];

  // MCP clients only treat top-level ImageContent as model-visible vision
  // input. Keep the complete typed result in structuredContent, but do not
  // duplicate multi-megabyte base64 into the text block.
  const textResult = {
    ...result,
    result: {
      ...(result.result as Record<string, unknown>),
      content: computerResult.content.map((item) => (
        images.includes(item as { type: 'image'; data: string; mimeType: string })
          ? { type: 'image', mimeType: (item as { mimeType: string }).mimeType, attached: true }
          : item
      )),
    },
  };

  return [
    { type: 'text', text: JSON.stringify(textResult) },
    ...images.map((item) => ({ type: 'image' as const, data: item.data, mimeType: item.mimeType })),
  ];
}

function toolResult(result: ToolResult, name?: MemoryMcpToolName): CallToolResult {
  return {
    structuredContent: result,
    content: name === MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL
      ? computerUseTopLevelContent(result)
      : [{ type: 'text', text: JSON.stringify(result) }],
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
    projectionId: z.string().optional().describe('Projection hit id from memory search.'),
    observationId: z.string().optional().describe('Observation hit id from memory search.'),
    ref: z.string().optional().describe('Compact search/startup ref (obs:… or proj:…).'),
    kind: z.enum(['projection', 'observation']).optional().describe('Kind from sourceLookup.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY]: z.object({
    projectionId: z.string().optional(),
    ref: z.string().optional().describe('Compact proj: ref.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.RESTORE_MEMORY]: z.object({
    projectionId: z.string().optional(),
    ref: z.string().optional().describe('Compact proj: ref.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY]: z.object({
    projectionId: z.string().optional(),
    ref: z.string().optional().describe('Compact proj: ref.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY]: z.object({
    projectionId: z.string().optional(),
    ref: z.string().optional().describe('Compact proj: ref.'),
    text: z.string().describe('Replacement summary.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK]: z.object({
    projectionId: z.string().optional(),
    ref: z.string().optional().describe('Compact proj: ref.'),
    feedback: z.enum(['not_relevant', 'relevant']).describe('Archive or strengthen ranking.'),
    reason: z.string().optional(),
  }),
  [MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION]: z.object({
    content: z.string().describe('Durable fact or decision.'),
    tags: z.array(z.string()).optional(),
    turnId: z.string().optional().describe('Source turn/event id.'),
    idempotencyKey: z.string().optional().describe('Retry key.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE]: z.object({
    text: z.string().describe('Stable preference text.'),
    idempotencyKey: z.string().optional().describe('Retry key.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.PEER_AUDIT_REPLY]: z.object({
    taskId: z.string(),
    assignmentId: z.string(),
    attemptId: z.string(),
    revision: z.string(),
    receiptKind: z.enum(['progress', 'final']),
    verdict: z.enum(['PASS', 'REWORK']).optional(),
    findings: z.string(),
    validations: z.array(z.object({
      kind: z.enum(PEER_AUDIT_VALIDATION_KINDS),
      label: z.string(),
      outcome: z.enum(PEER_AUDIT_VALIDATION_OUTCOMES),
      summary: z.string(),
    }).strict()),
  }).strict(),
  [MEMORY_MCP_TOOL_NAMES.DELEGATION_REPLY]: z.object({
    delegationId: z.string(),
    result: z.string(),
  }).strict(),
  [MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS]: z.object({
    query: z.string().optional().describe('Name/label filter.'),
    limit: z.number().int().min(1).max(100).optional().describe('Max targets.'),
    executionPool: z.enum(SUPERVISION_EXECUTION_POOL_KINDS).optional()
      .describe('Optional primary/economy filter; omit for all siblings.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.SESSION_RUNTIME_IDENTITY_GET]: z.object({}).strict(),
  [MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE]: z.object({
    target: z.string().optional().describe('Exact target; omit only for autoProvision.'),
    message: z.string().describe('Request and expected output.'),
    deliveryMode: z.enum(Object.values(MEMORY_MCP_SEND_DELIVERY_MODES) as [MemoryMcpSendDeliveryMode, ...MemoryMcpSendDeliveryMode[]])
      .optional(),
    files: z.array(z.string()).optional(),
    reply: z.boolean().optional(),
    task: z.object({
      taskId: z.string().optional(), assignmentId: z.string().optional(), topLevelTaskId: z.string().optional(), sliceId: z.string().optional(), classification: z.enum(SUPERVISION_TASK_CLASSIFICATIONS).optional(),
      objective: z.string().optional(), acceptance: z.array(z.string()).optional(), ownedFiles: z.array(z.string()).optional(), sharedFiles: z.array(z.string()).optional(), dependencies: z.array(z.string()).optional(),
      integrationOwner: z.string().optional(), baseRevision: z.string().optional(), currentRevision: z.string().optional(), auditAttemptId: z.string().optional(), auditRevision: z.string().optional(),
      executionPool: z.enum(['primary', 'economy']).optional(), autoProvision: z.literal(true).optional(),
      requestedExecutionType: z.object({
        capabilityId: z.string(),
        agentType: z.string(),
        providerFamily: z.string(),
        runtimeType: z.enum(['process', 'transport']),
        model: z.string(),
        ccPresetId: z.string().min(1).optional(),
      }).strict().optional(),
    }).strict().optional(),
    audit: z.object({
      kind: z.literal(AGENT_DELEGATION_PURPOSES.SUPERVISION_AUDIT),
      attemptId: z.string().min(1),
      auditedSessionName: z.string().min(1).describe('Audited session.'),
      strictCrossVendor: z.literal(true).optional().describe('Forbid same-family degradation.'),
    }).strict().optional().describe('Audit metadata; requires reply and exact target.'),
    broadcast: z.boolean().optional().describe('All sessions only.'),
    idempotencyKey: z.string().optional().describe('Replay key.'),
    clone: z.object({
      kind: z.literal(EXECUTION_CLONE_KIND),
      ephemeral: z.literal(true),
      parentRunId: z.string().min(1),
      parentStage: z.enum(EXECUTION_CLONE_PARENT_STAGES),
    }).strict().optional().describe('Fresh ephemeral clone; no broadcast.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.DESTROY_EXECUTION_CLONE]: z.object({
    target: z.string().describe('Exact result.clone.target.'),
    idempotencyKey: z.string().optional().describe('Accepted-destroy replay key.'),
  }),

  [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_START]: z.object({
    taskId: z.string().optional(), topLevelTaskId: z.string().optional(), classification: z.enum(SUPERVISION_TASK_CLASSIFICATIONS).optional(),
    role: z.enum(['coordinator', 'integration_owner', 'implementer', 'auditor']), objective: z.string(), acceptance: z.array(z.string()).optional(),
    scopeFiles: z.array(z.string()).optional(), claimMode: z.enum(['exclusive', 'shared', 'read_only']).optional(), idempotencyKey: z.string().optional(),
  }),
  [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_UPDATE]: z.object({ assignmentId: z.string(), revision: z.string().optional(), auditAttemptId: z.string().optional(), auditRevision: z.string().optional(), verdict: z.string().optional(), blocker: z.string().optional(), externalRunId: z.string().optional(), externalHeadSha: z.string().optional(), externalTaskId: z.string().optional() }),
  [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FINISH]: legacySupervisionFinishSchema,
  [MEMORY_MCP_TOOL_NAMES.SUPERVISION_INTEGRATION_FINALIZE]: integrationFinalizationSchema,
  [MEMORY_MCP_TOOL_NAMES.SUPERVISION_TASK_FILE_EVENT]: z.object({ assignmentId: z.string(), filePath: z.string(), operation: z.enum(SUPERVISION_TASK_FILE_OPERATIONS), beforeHash: z.string().optional(), afterHash: z.string().optional(), tool: z.string().optional(), source: z.string().optional(), idempotencyKey: z.string().optional() }),
  [MEMORY_MCP_TOOL_NAMES.SEND_STOP]: z.object({
    target: z.string().optional().describe('Exact target unless broadcast.'),
    broadcast: z.boolean().optional().describe('Stop all siblings.'),
    idempotencyKey: z.string().optional().describe('Replay key.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF]: z.object({
    cronExpr: z.string().describe(`${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES}-minute minimum interval.`),
    message: z.string(),
    name: z.string().optional().describe('Optional job name.'),
    timezone: z.string().optional(),
    expiresAt: z.union([z.number(), z.string(), z.null()]).optional().describe('Epoch-ms/ISO expiry.'),
    completionPolicy: z.enum([
      CRON_COMPLETION_POLICY.RECURRING,
      CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
    ]).optional().describe('recurring or bounded until_complete.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF]: z.object({
    id: z.string().describe('Current-session job id.'),
    cronExpr: z.string().optional().describe(`Schedule; ≥${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES} min.`),
    message: z.string().optional().describe('Wakeup message.'),
    name: z.string().optional(),
    timezone: z.string().optional(),
    expiresAt: z.union([z.number(), z.string(), z.null()]).optional().describe('Epoch-ms/ISO expiry.'),
    completionPolicy: z.enum([
      CRON_COMPLETION_POLICY.RECURRING,
      CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
    ]).optional().describe('Lifecycle policy.'),
    force: z.boolean().optional().describe('Required for recurring→until_complete.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF]: z.object({
    id: z.string().optional().describe('Exact job id.'),
    name: z.string().optional().describe('Exact unique job name.'),
    all: z.boolean().optional().describe('Cancel all self jobs.'),
    force: z.boolean().optional().describe('Required for recurring jobs.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_CREATE]: z.object({
    name: z.string(),
    cronExpr: z.string().describe(`${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES}-minute minimum; every-minute schedules are invalid.`),
    projectName: z.string().optional().describe('Project; defaults to caller project.'),
    targetRole: z.string().optional().describe('Source role; defaults to project brain.'),
    targetSessionName: z.string().nullable().optional().describe('Source session; target resolves among its siblings and cannot be itself.'),
    action: z.record(z.string(), z.unknown()).describe('Send action: {type:"send", target, message, reply?, broadcast?, idempotencyKey?}.'),
    timezone: z.string().optional(),
    expiresAt: z.union([z.number(), z.string(), z.null()]).optional().describe('Epoch-ms/offset-ISO, ≤90 days; affects future sends only.'),
    completionPolicy: z.enum([
      CRON_COMPLETION_POLICY.RECURRING,
      CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
    ]).optional().describe('Lifecycle policy; defaults to recurring.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_LIST]: z.object({
    projectName: z.string().optional().describe('Project filter.'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_UPDATE]: z.object({
    id: z.string(),
    name: z.string().optional(),
    cronExpr: z.string().optional().describe(`Replacement schedule; ${MEMORY_MCP_CAPS.CRON_MIN_INTERVAL_MINUTES}-minute minimum.`),
    projectName: z.string().optional().describe('Replacement project.'),
    targetRole: z.string().optional().describe('Replacement source role.'),
    targetSessionName: z.string().nullable().optional().describe('Replacement source session; target resolves among its siblings.'),
    action: z.record(z.string(), z.unknown()).optional().describe('Replacement send action; other action types are rejected.'),
    timezone: z.string().optional().describe('Replacement schedule timezone only.'),
    expiresAt: z.union([z.number(), z.string(), z.null()]).optional().describe('Replacement epoch-ms/offset-ISO; affects future sends only.'),
    completionPolicy: z.enum([
      CRON_COMPLETION_POLICY.RECURRING,
      CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
    ]).optional().describe('Replacement lifecycle policy.'),
    force: z.boolean().optional().describe('Required to change recurring to until_complete.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.CRON_DELETE]: z.object({
    id: z.string(),
    force: z.boolean().optional().describe('Required for agent deletion of recurring jobs.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.LIST_MACHINES]: z.strictObject({
    includeOffline: z.boolean().optional().describe('Include offline/exec-disabled machines; default false, advisory only.'),
  }),
  [MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE]: z.strictObject({
    machine: machineTargetRuntimeSchema.describe('10-digit nodeId or ^^(nodeId); legacy alias is compatibility-only. No list_machines preflight.'),
    command: z.string(),
    shell: z.enum(REMOTE_EXEC_SHELLS).optional(),
    timeoutMs: z.number().int().min(REMOTE_EXEC_MIN_TIMEOUT_MS).max(REMOTE_EXEC_MAX_TIMEOUT_MS).optional(),
  }),
  [MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE]: z.strictObject({
    machine: machineTargetRuntimeSchema.describe('10-digit nodeId or ^^(nodeId); legacy alias is compatibility-only.'),
    sourcePath: boundedUtf8String(FILE_TRANSFER_PATH_MAX_BYTES),
  }),
  [MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE]: z.strictObject({
    machine: machineTargetRuntimeSchema.describe('10-digit nodeId or ^^(nodeId); legacy alias is compatibility-only.'),
    sourcePath: boundedUtf8String(FILE_TRANSFER_PATH_MAX_BYTES),
    destinationPath: boundedUtf8String(FILE_TRANSFER_PATH_MAX_BYTES),
    overwrite: z.boolean().optional(),
  }),
  [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS]: z.strictObject({
    topic: z.enum(COMPUTER_USE_DOC_TOPICS),
  }),
  [MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL]: z.strictObject({
    machine: machineTargetRuntimeSchema.describe('10-digit nodeId, ^^(nodeId), legacy alias, or local/self; no list_machines preflight.'),
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
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    transport: z.enum([MACHINE_FILE_TRANSFER_TRANSPORT.DIRECT, MACHINE_FILE_TRANSFER_TRANSPORT.RELAY]),
  }),
  [MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE]: z.strictObject({
    status: z.literal('ok'),
    machine: z.string().min(1),
    destinationPath: boundedUtf8String(FILE_TRANSFER_PATH_MAX_BYTES),
    attachmentId: z.string().min(1).max(128),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    transport: z.enum([MACHINE_FILE_TRANSFER_TRANSPORT.DIRECT, MACHINE_FILE_TRANSFER_TRANSPORT.RELAY]),
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

export function registerMemoryMcpTools(
  server: McpServer,
  caller: McpRuntimeCaller,
  deps: MemoryMcpToolDeps = {},
): ReadonlyMap<string, RegisteredTool> {
  const handlers = createMemoryMcpToolHandlers(caller, deps);
  const registered = new Map<string, RegisteredTool>();
  // Role-gate the advertised surface: a controlled node never registers the
  // FULL-only machine tools, so its daemon.hello / tools/list excludes them (10.12).
  for (const name of advertisedMcpToolNames(deps.nodeRole ?? NODE_ROLE.FULL)) {
    const contract = MEMORY_MCP_TOOL_CONTRACTS[name];
    const outputSchema = machineToolOutputSchemas[name];
    registered.set(name, server.registerTool(name, {
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
      return toolResult(await handlers[name](args, context), name);
    }));
  }
  return registered;
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
    description: z.string().optional().describe(`Description, ≤${ALIAS_DESCRIPTION_MAX} code points.`),
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

export function registerAliasMcpTools(
  server: McpServer,
  caller: McpRuntimeCaller,
  deps: AliasMcpToolDeps = {},
): ReadonlyMap<string, RegisteredTool> {
  const handlers = createAliasMcpToolHandlers(caller, deps);
  const registered = new Map<string, RegisteredTool>();
  for (const name of ALIAS_MCP_TOOL_NAME_LIST) {
    registered.set(name, server.registerTool(name, {
      description: ALIAS_MCP_TOOL_DESCRIPTIONS[name],
      inputSchema: aliasSchemas[name],
    }, async (args: unknown) => toolResult(await handlers[name](args))));
  }
  return registered;
}
