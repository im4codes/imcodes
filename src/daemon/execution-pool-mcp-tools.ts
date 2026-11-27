import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SupervisorDefaultsMutation } from './supervisor-defaults-cache.js';
import type { McpRuntimeCaller } from './memory-mcp-caller.js';
import { HookAuthorityUnavailableError } from './hook-port.js';
import { HookRateLimitError } from './shared-machine-authority.js';
import { DAEMON_MEMORY_WORKER_STALE_RUNTIME_ERROR } from './memory-mcp-error-codes.js';
import { HOOK_SESSION_CREDENTIAL_ERROR } from '../../shared/hook-session-credential.js';
import {
  EXECUTION_POOL_MCP_TOOLS,
  EXECUTION_POOL_MCP_LIMITS,
  configFromExecutionPoolEntry,
  executionPoolEntryFromConfig,
  validateExecutionPoolMcpPatch,
  type ExecutionPoolMcpPatch,
} from '../../shared/execution-pool-mcp.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import {
  SUPERVISION_MODE,
  normalizeSupervisorDefaultConfig,
  type SupervisorDefaultConfig,
} from '../../shared/supervision-config.js';
import {
  MODEL_TIERS,
  buildExecutionPoolRecommendations,
  classifySdkModelTiers,
  type LearnedModelTierRecord,
  type SupervisionExecutionPoolsConfig,
} from '../../shared/supervision-execution-pool.js';
import { loadModelTierKnowledge, upsertModelTierKnowledge, type LearnedModelTierInput } from './model-tier-knowledge.js';
import { probeExecutionPoolSdks, type ExecutionPoolSdkProbeResult } from './sdk-execution-pool-probe.js';

type ToolResult = Record<string, unknown>;
type ToolHandler = (input?: unknown) => Promise<ToolResult>;

export interface ExecutionPoolMcpToolDeps {
  getDefaults?: (caller: McpRuntimeCaller) => Promise<SupervisorDefaultConfig | null> | SupervisorDefaultConfig | null;
  /** Must serialize read → mutate → persist across handler instances. */
  setDefaults?: (caller: McpRuntimeCaller, mutate: SupervisorDefaultsMutation) => Promise<SupervisorDefaultConfig | null> | SupervisorDefaultConfig | null;
  isProjectBrain?: (caller: McpRuntimeCaller) => boolean;
  probeSdks?: (caller: McpRuntimeCaller) => Promise<ExecutionPoolSdkProbeResult> | ExecutionPoolSdkProbeResult;
  loadKnowledge?: () => Promise<LearnedModelTierRecord[]> | LearnedModelTierRecord[];
  saveKnowledge?: (updates: readonly LearnedModelTierInput[]) => Promise<LearnedModelTierRecord[]> | LearnedModelTierRecord[];
  /** Production stdio seam: execute execution_pool_get/set inside the main daemon so cached pools update synchronously. */
  invokeDaemonTool?: (
    name: typeof EXECUTION_POOL_MCP_TOOLS[keyof typeof EXECUTION_POOL_MCP_TOOLS],
    input?: unknown,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Shared/external-CLI participant turn check so HTTP/in-process MCP refuses restricted turns consistently with stdio. */
  participantTurnRequired?: () => Promise<boolean>;
}

const poolEntrySchema = z.strictObject({
  model: z.string().min(1),
  provider: z.string().min(1),
  role: z.enum(['executor', 'auditor', 'both']).optional(),
  enabled: z.boolean().optional(),
});

const schemas = {
  [EXECUTION_POOL_MCP_TOOLS.GET]: z.strictObject({}),
  [EXECUTION_POOL_MCP_TOOLS.SET]: z.strictObject({
    entries: z.array(poolEntrySchema).optional(),
    pool: z.enum(['primary', 'economy']).optional(),
    primaryEntries: z.array(poolEntrySchema).optional(),
    economyEntries: z.array(poolEntrySchema).optional(),
    learnedModelTiers: z.array(z.strictObject({
      provider: z.string().min(1),
      model: z.string().min(1),
      tier: z.enum(MODEL_TIERS),
      source: z.string().min(1).max(200).optional(),
    })).max(EXECUTION_POOL_MCP_LIMITS.MAX_LEARNED_MODEL_TIERS).optional(),
    autoPairingEnabled: z.boolean().optional(),
    auditByDefault: z.boolean().optional(),
    concurrencyCap: z.number().int().min(1).max(EXECUTION_POOL_MCP_LIMITS.MAX_CONCURRENCY).optional(),
  }),
};

function result(value: ToolResult): CallToolResult {
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }], isError: value.status === 'error' };
}
function error(message: string, reason: string = MCP_ERROR_REASONS.VALIDATION_FAILED): ToolResult {
  return { status: 'error', reason, message };
}

function buildRecommendationsForOutput(
  probe: ExecutionPoolSdkProbeResult | null,
  knowledge: readonly LearnedModelTierRecord[],
): Record<string, unknown> {
  if (!probe) return {};
  const reEvaluatedSdks = probe.sdks.map((sdk) => {
    const classified = classifySdkModelTiers(sdk.provider, sdk.models, knowledge);
    return {
      ...sdk,
      models: classified.models,
      tiers: classified.tiers,
      unknownModels: classified.unknownModels,
    };
  });
  const recs = buildExecutionPoolRecommendations({
    currentBrain: probe.currentBrain,
    availableSdks: reEvaluatedSdks,
    learnedKnowledge: knowledge,
  });
  return {
    currentBrain: recs.currentBrain,
    availableSdks: recs.availableSdks,
    unknownModels: recs.unknownModels,
    needsModelResearch: recs.needsModelResearch,
    recommendedPresets: recs.recommendedPresets,
    customAllowed: recs.customAllowed,
    ...(recs.brainModelHint ? { brainModelHint: recs.brainModelHint } : {}),
  };
}

const UNCONFIGURED_POOL_AUTO_GUIDANCE =
  'No execution pool is configured. For code/development tasks, reuse already classified models, verify only unknownModels online and save learnedModelTiers if possible, auto-apply the recommended: true preset with execution_pool_set without waiting for approval, notify the user of the active models and how to change them in chat or Settings → Execution Pool ONLY after execution_pool_set succeeds, and continue the task.';

const UNCONFIGURED_POOL_ASK_ONLY_GUIDANCE =
  'No execution pool is configured and no usable recommended preset is available yet. If unknownModels exist, attempt online verification and save learnedModelTiers; if recommendedPresets remains empty, do NOT guess or announce an active pool — ask the user which models to configure and call execution_pool_set only after confirmation.';

function poolOutput(
  defaults: SupervisorDefaultConfig | null,
  probe: ExecutionPoolSdkProbeResult | null,
  knowledge: readonly LearnedModelTierRecord[],
  extra?: Record<string, unknown>,
): ToolResult {
  const recommendations = buildRecommendationsForOutput(probe, knowledge);
  const hasUsablePreset = Array.isArray(recommendations.recommendedPresets) && recommendations.recommendedPresets.length > 0;
  const unconfiguredGuidance = hasUsablePreset ? UNCONFIGURED_POOL_AUTO_GUIDANCE : UNCONFIGURED_POOL_ASK_ONLY_GUIDANCE;
  if (!defaults) {
    return {
      status: 'ok',
      configured: false,
      entries: [],
      autoPairingEnabled: false,
      auditByDefault: false,
      concurrencyCap: null,
      askUser: unconfiguredGuidance,
      ...recommendations,
      ...extra,
    };
  }
  const pools = defaults.executionPools;
  const entries = [
    ...pools.primaryDevelopmentPool.configs.map((config) => ({ ...executionPoolEntryFromConfig(config), pool: 'primary' as const })),
    ...pools.economyTaskPool.configs.map((config) => ({ ...executionPoolEntryFromConfig(config), pool: 'economy' as const })),
  ];
  const autoPairingEnabled = defaults.pairEngine === 'pairs'
    || (defaults.pairEngine === undefined && (defaults.mode === SUPERVISION_MODE.SUPERVISED || defaults.mode === SUPERVISION_MODE.SUPERVISED_AUDIT));
  const auditByDefault = defaults.mode === SUPERVISION_MODE.SUPERVISED_AUDIT;
  const configured = pools.state === 'configured' && entries.length > 0;
  return {
    status: 'ok',
    configured,
    entries,
    autoPairingEnabled,
    auditByDefault,
    concurrencyCap: defaults.pairMaxConcurrency ?? pools.primaryDevelopmentPool.controls.maxConcurrency,
    ...(configured ? {} : { askUser: unconfiguredGuidance }),
    ...recommendations,
    ...extra,
  };
}

function applyPatch(current: SupervisorDefaultConfig, patch: ExecutionPoolMcpPatch): SupervisorDefaultConfig {
  const targetPool = patch.pool ?? 'primary';
  const batchMode = patch.primaryEntries !== undefined || patch.economyEntries !== undefined;
  const nextPrimary = batchMode
    ? (patch.primaryEntries !== undefined
      ? {
          ...current.executionPools.primaryDevelopmentPool,
          configs: patch.primaryEntries.filter((entry) => entry.enabled).map(configFromExecutionPoolEntry),
        }
      : current.executionPools.primaryDevelopmentPool)
    : (patch.entries !== undefined && targetPool === 'primary'
      ? {
          ...current.executionPools.primaryDevelopmentPool,
          configs: patch.entries.filter((entry) => entry.enabled).map(configFromExecutionPoolEntry),
        }
      : current.executionPools.primaryDevelopmentPool);
  const nextEconomy = batchMode
    ? (patch.economyEntries !== undefined
      ? {
          ...current.executionPools.economyTaskPool,
          configs: patch.economyEntries.filter((entry) => entry.enabled).map(configFromExecutionPoolEntry),
        }
      : current.executionPools.economyTaskPool)
    : (patch.entries !== undefined && targetPool === 'economy'
      ? {
          ...current.executionPools.economyTaskPool,
          configs: patch.entries.filter((entry) => entry.enabled).map(configFromExecutionPoolEntry),
        }
      : current.executionPools.economyTaskPool);
  const entriesChanged = patch.entries !== undefined || patch.primaryEntries !== undefined || patch.economyEntries !== undefined;
  const nextPools: SupervisionExecutionPoolsConfig = {
    ...current.executionPools,
    state: entriesChanged ? (nextPrimary.configs.length > 0 || nextEconomy.configs.length > 0 ? 'configured' : 'legacy_unconfigured') : current.executionPools.state,
    ...(nextPrimary !== current.executionPools.primaryDevelopmentPool ? { primaryDevelopmentPool: nextPrimary } : {}),
    ...(nextEconomy !== current.executionPools.economyTaskPool ? { economyTaskPool: nextEconomy } : {}),
  };
  const autoPairingEnabled = patch.autoPairingEnabled ?? (current.pairEngine === 'pairs'
    || (current.pairEngine === undefined && (current.mode === SUPERVISION_MODE.SUPERVISED || current.mode === SUPERVISION_MODE.SUPERVISED_AUDIT)));
  const auditByDefault = patch.auditByDefault ?? (current.mode === SUPERVISION_MODE.SUPERVISED_AUDIT);
  const next: Partial<SupervisorDefaultConfig> = { ...current, executionPools: nextPools };
  if (patch.autoPairingEnabled !== undefined || patch.auditByDefault !== undefined) {
    next.pairEngine = autoPairingEnabled ? 'pairs' : 'legacy';
    next.mode = autoPairingEnabled ? (auditByDefault ? SUPERVISION_MODE.SUPERVISED_AUDIT : SUPERVISION_MODE.SUPERVISED) : SUPERVISION_MODE.OFF;
  }
  if (patch.concurrencyCap !== undefined) next.pairMaxConcurrency = patch.concurrencyCap;
  return normalizeSupervisorDefaultConfig(next);
}

export function createExecutionPoolMcpToolHandlers(caller: McpRuntimeCaller, deps: ExecutionPoolMcpToolDeps = {}): Record<string, ToolHandler> {
  const getDefaults = deps.getDefaults ?? (() => null);
  const setDefaults = deps.setDefaults ?? (() => null);
  const probeSdks = deps.probeSdks ?? (async (c) => probeExecutionPoolSdks({ callerSessionName: c.sessionName ?? undefined }).catch(() => null));
  const loadKnowledge = deps.loadKnowledge ?? (() => loadModelTierKnowledge());
  const saveKnowledge = deps.saveKnowledge ?? ((updates) => upsertModelTierKnowledge(updates));
  const authorized = () => Boolean(caller.sessionName && caller.projectName && deps.isProjectBrain?.(caller));
  const participantTurnForbidden = async (): Promise<boolean> => {
    if (!deps.participantTurnRequired) return false;
    try {
      return await deps.participantTurnRequired();
    } catch {
      return true;
    }
  };

  const readContext = async () => {
    const [probe, knowledge] = await Promise.all([
      Promise.resolve(probeSdks(caller)).catch(() => null),
      Promise.resolve(loadKnowledge()).catch(() => [] as LearnedModelTierRecord[]),
    ]);
    return { probe, knowledge };
  };

  const classifyDaemonRpcError = (err: unknown): {
    kind: 'legacy_404' | 'unreachable_or_timeout' | 'auth_refusal' | 'other';
    message: string;
  } => {
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
    const errCode = (err as { code?: unknown } | null)?.code;
    if (statusCode === 404 || /\bstatus 404\b/i.test(message)) {
      return { kind: 'legacy_404', message };
    }
    if (
      statusCode === 401
      || statusCode === 403
      || statusCode === 409
      || statusCode === 429
      || err instanceof HookRateLimitError
      || message === DAEMON_MEMORY_WORKER_STALE_RUNTIME_ERROR
      || message.startsWith(HOOK_SESSION_CREDENTIAL_ERROR)
      || message === 'daemon_execution_pool_identity_unavailable'
      || /forbidden|unauthorized|invalid caller|scope_forbidden/i.test(message)
    ) {
      return { kind: 'auth_refusal', message };
    }
    if (
      err instanceof HookAuthorityUnavailableError
      || (err instanceof Error && err.name === 'HookAuthorityUnavailableError')
      || (typeof errCode === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH'].includes(errCode))
      || /timed out|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|hook server is unavailable|hook authority/i.test(message)
    ) {
      return { kind: 'unreachable_or_timeout', message };
    }
    return { kind: 'other', message };
  };

  const invokeGetThroughDaemon = async (localFallback: () => Promise<ToolResult>): Promise<ToolResult> => {
    if (!authorized() || await participantTurnForbidden()) {
      return error('execution pool reads require the project Brain/owner session', MCP_ERROR_REASONS.SCOPE_FORBIDDEN);
    }
    if (!deps.invokeDaemonTool) return localFallback();
    try {
      return await deps.invokeDaemonTool(EXECUTION_POOL_MCP_TOOLS.GET, {});
    } catch (err) {
      const classified = classifyDaemonRpcError(err);
      if (classified.kind === 'legacy_404' || classified.kind === 'unreachable_or_timeout') {
        return localFallback();
      }
      if (classified.kind === 'auth_refusal') {
        return error(classified.message, MCP_ERROR_REASONS.SCOPE_FORBIDDEN);
      }
      throw err;
    }
  };

  const invokeSetThroughDaemon = async (input: unknown, localFallback: () => Promise<ToolResult>): Promise<ToolResult> => {
    if (!authorized() || await participantTurnForbidden()) {
      return error('execution pool changes require the project Brain/owner session', MCP_ERROR_REASONS.SCOPE_FORBIDDEN);
    }
    if (!deps.invokeDaemonTool) return localFallback();
    try {
      return await deps.invokeDaemonTool(EXECUTION_POOL_MCP_TOOLS.SET, input);
    } catch (err) {
      const classified = classifyDaemonRpcError(err);
      if (classified.kind === 'legacy_404') {
        return localFallback();
      }
      if (classified.kind === 'auth_refusal') {
        return error(classified.message, MCP_ERROR_REASONS.SCOPE_FORBIDDEN);
      }
      if (classified.kind === 'unreachable_or_timeout') {
        return error(
          `execution pool update could not be confirmed by the main daemon (${classified.message}); read execution_pool_get before retrying`,
          MCP_ERROR_REASONS.INTERNAL_ERROR,
        );
      }
      throw err;
    }
  };

  const localGet = async (): Promise<ToolResult> => {
    if (!authorized() || await participantTurnForbidden()) {
      return error('execution pool reads require the project Brain/owner session', MCP_ERROR_REASONS.SCOPE_FORBIDDEN);
    }
    const [defaults, context] = await Promise.all([
      Promise.resolve(getDefaults(caller)),
      readContext(),
    ]);
    return poolOutput(defaults, context.probe, context.knowledge);
  };

  const localSet = async (input: unknown): Promise<ToolResult> => {
    if (!authorized() || await participantTurnForbidden()) {
      return error('execution pool changes require the project Brain/owner session', MCP_ERROR_REASONS.SCOPE_FORBIDDEN);
    }
    const parsed = validateExecutionPoolMcpPatch(input);
    if ('error' in parsed) return error(parsed.error);

    let updatedKnowledgeCount: number | undefined;
    let latestKnowledge: LearnedModelTierRecord[] | undefined;
    if (parsed.learnedModelTiers && parsed.learnedModelTiers.length > 0) {
      latestKnowledge = await Promise.resolve(saveKnowledge(parsed.learnedModelTiers));
      updatedKnowledgeCount = parsed.learnedModelTiers.length;
    }

    const hasPoolOrPolicyChange = parsed.entries !== undefined
      || parsed.primaryEntries !== undefined
      || parsed.economyEntries !== undefined
      || parsed.autoPairingEnabled !== undefined
      || parsed.auditByDefault !== undefined
      || parsed.concurrencyCap !== undefined;

    let targetDefaults: SupervisorDefaultConfig | null;
    if (hasPoolOrPolicyChange) {
      // The persistence boundary must read + merge inside its shared queue.
      targetDefaults = await setDefaults(caller, (current) => applyPatch(current, parsed));
      if (!targetDefaults) {
        return error('execution pool persistence could not be confirmed; read the current preferences before retrying', MCP_ERROR_REASONS.INTERNAL_ERROR);
      }
    } else {
      targetDefaults = await getDefaults(caller);
    }

    const [probe, loadedKnowledge] = await Promise.all([
      Promise.resolve(probeSdks(caller)).catch(() => null),
      latestKnowledge ? Promise.resolve(latestKnowledge) : Promise.resolve(loadKnowledge()).catch(() => [] as LearnedModelTierRecord[]),
    ]);
    return poolOutput(
      targetDefaults,
      probe,
      loadedKnowledge,
      updatedKnowledgeCount !== undefined ? { learnedModelsUpdated: updatedKnowledgeCount } : undefined,
    );
  };

  return {
    [EXECUTION_POOL_MCP_TOOLS.GET]: () => invokeGetThroughDaemon(localGet),
    [EXECUTION_POOL_MCP_TOOLS.SET]: (input) => invokeSetThroughDaemon(input, () => localSet(input)),
  };
}

export function registerExecutionPoolMcpTools(server: McpServer, caller: McpRuntimeCaller, deps: ExecutionPoolMcpToolDeps = {}): ReadonlyMap<string, RegisteredTool> {
  const handlers = createExecutionPoolMcpToolHandlers(caller, deps);
  const descriptions = {
    [EXECUTION_POOL_MCP_TOOLS.GET]: 'Read execution pool, policy, logged-in SDK catalogs, unknown models, and recommended presets.',
    [EXECUTION_POOL_MCP_TOOLS.SET]: 'Update execution pool (entries/primaryEntries/economyEntries), pairing policy, or learnedModelTiers. Brain/owner only.',
  };
  const registered = new Map<string, RegisteredTool>();
  for (const name of [EXECUTION_POOL_MCP_TOOLS.GET, EXECUTION_POOL_MCP_TOOLS.SET] as const) {
    registered.set(name, server.registerTool(name, { description: descriptions[name], inputSchema: schemas[name] }, async (args: unknown) => result(await handlers[name](args))));
  }
  return registered;
}
