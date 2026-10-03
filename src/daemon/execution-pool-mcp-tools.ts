import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpRuntimeCaller } from './memory-mcp-caller.js';
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
import type { SupervisionExecutionPoolsConfig } from '../../shared/supervision-execution-pool.js';

type ToolResult = Record<string, unknown>;
type ToolHandler = (input?: unknown) => Promise<ToolResult>;

export interface ExecutionPoolMcpToolDeps {
  getDefaults?: (caller: McpRuntimeCaller) => Promise<SupervisorDefaultConfig | null> | SupervisorDefaultConfig | null;
  setDefaults?: (caller: McpRuntimeCaller, defaults: SupervisorDefaultConfig) => Promise<SupervisorDefaultConfig | null> | SupervisorDefaultConfig | null;
  isProjectBrain?: (caller: McpRuntimeCaller) => boolean;
}

const schemas = {
  [EXECUTION_POOL_MCP_TOOLS.GET]: z.strictObject({}),
  [EXECUTION_POOL_MCP_TOOLS.SET]: z.strictObject({
    entries: z.array(z.strictObject({
      model: z.string().min(1), provider: z.string().min(1),
      role: z.enum(['executor', 'auditor', 'both']).optional(), enabled: z.boolean().optional(),
    })).optional(),
    pool: z.enum(['primary', 'economy']).optional(),
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

function poolOutput(defaults: SupervisorDefaultConfig | null): ToolResult {
  if (!defaults) return { status: 'ok', configured: false, entries: [], autoPairingEnabled: false, auditByDefault: false, concurrencyCap: null,
    askUser: 'No execution pool is configured. Ask the user which executor and auditor models to use before enabling auto-pairing.' };
  const pools = defaults.executionPools;
  const entries = [
    ...pools.primaryDevelopmentPool.configs.map((config) => ({ ...executionPoolEntryFromConfig(config), pool: 'primary' as const })),
    ...pools.economyTaskPool.configs.map((config) => ({ ...executionPoolEntryFromConfig(config), pool: 'economy' as const })),
  ];
  const autoPairingEnabled = defaults.pairEngine === 'pairs'
    || (defaults.pairEngine === undefined && (defaults.mode === SUPERVISION_MODE.SUPERVISED || defaults.mode === SUPERVISION_MODE.SUPERVISED_AUDIT));
  const auditByDefault = defaults.mode === SUPERVISION_MODE.SUPERVISED_AUDIT;
  const configured = pools.state === 'configured' && entries.length > 0;
  return { status: 'ok', configured, entries, autoPairingEnabled, auditByDefault,
    concurrencyCap: defaults.pairMaxConcurrency ?? pools.primaryDevelopmentPool.controls.maxConcurrency,
    ...(configured ? {} : { askUser: 'No execution pool is configured. Ask the user which executor and auditor models to use before enabling auto-pairing.' }) };
}

function applyPatch(current: SupervisorDefaultConfig, patch: ExecutionPoolMcpPatch): SupervisorDefaultConfig {
  const targetPool = patch.pool ?? 'primary';
  const updatedPool = patch.entries ? {
    ...(targetPool === 'primary' ? current.executionPools.primaryDevelopmentPool : current.executionPools.economyTaskPool),
    configs: patch.entries.filter((entry) => entry.enabled).map(configFromExecutionPoolEntry),
  } : undefined;
  const nextPrimary = targetPool === 'primary' && updatedPool ? updatedPool : current.executionPools.primaryDevelopmentPool;
  const nextEconomy = targetPool === 'economy' && updatedPool ? updatedPool : current.executionPools.economyTaskPool;
  const nextPools: SupervisionExecutionPoolsConfig = { ...current.executionPools,
    state: patch.entries ? (nextPrimary.configs.length > 0 || nextEconomy.configs.length > 0 ? 'configured' : 'legacy_unconfigured') : current.executionPools.state,
    ...(targetPool === 'primary' && updatedPool ? { primaryDevelopmentPool: updatedPool } : {}),
    ...(targetPool === 'economy' && updatedPool ? { economyTaskPool: updatedPool } : {}),
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
  const authorized = () => Boolean(caller.sessionName && caller.projectName && deps.isProjectBrain?.(caller));
  return {
    [EXECUTION_POOL_MCP_TOOLS.GET]: async () => authorized()
      ? poolOutput(await getDefaults(caller))
      : error('execution pool reads require the project Brain/owner session', MCP_ERROR_REASONS.SCOPE_FORBIDDEN),
    [EXECUTION_POOL_MCP_TOOLS.SET]: async (input) => {
      if (!authorized()) return error('execution pool changes require the project Brain/owner session', MCP_ERROR_REASONS.SCOPE_FORBIDDEN);
      const parsed = validateExecutionPoolMcpPatch(input);
      if ('error' in parsed) return error(parsed.error);
      const current = await getDefaults(caller);
      if (!current) return error('execution pool defaults are unavailable', MCP_ERROR_REASONS.INTERNAL_ERROR);
      const saved = await setDefaults(caller, applyPatch(current, parsed));
      return poolOutput(saved ?? applyPatch(current, parsed));
    },
  };
}

export function registerExecutionPoolMcpTools(server: McpServer, caller: McpRuntimeCaller, deps: ExecutionPoolMcpToolDeps = {}): ReadonlyMap<string, RegisteredTool> {
  const handlers = createExecutionPoolMcpToolHandlers(caller, deps);
  const descriptions = {
    [EXECUTION_POOL_MCP_TOOLS.GET]: 'Read the project execution pool, auto-pairing and audit-by-default policy. If unconfigured, ask the user which models to use.',
    [EXECUTION_POOL_MCP_TOOLS.SET]: 'Update the project execution pool and pairing policy. Only the project Brain/owner may change it.',
  };
  const registered = new Map<string, RegisteredTool>();
  for (const name of [EXECUTION_POOL_MCP_TOOLS.GET, EXECUTION_POOL_MCP_TOOLS.SET] as const) {
    registered.set(name, server.registerTool(name, { description: descriptions[name], inputSchema: schemas[name] }, async (args: unknown) => result(await handlers[name](args))));
  }
  return registered;
}
