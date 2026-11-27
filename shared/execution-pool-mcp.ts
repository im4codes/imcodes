import {
  MODEL_TIERS,
  buildSupervisionExecutionCapabilityId,
  normalizeSupervisionExecutionModel,
  SUPERVISION_EXECUTION_POOL_ROLES,
  type ModelTier,
  type SupervisionExecutionConfig,
  type SupervisionExecutionPoolRole,
} from './supervision-execution-pool.js';
import {
  getSessionRuntimeType,
  isSessionAgentType,
  CLAUDE_CODE_CLI_SDK_AGENT_TYPE,
} from './agent-types.js';
import { resolvePeerAuditProviderFamily } from './peer-audit.js';
import {
  inferSharedContextRuntimeBackend,
  normalizeSharedContextRuntimeBackend,
} from './shared-context-runtime-config.js';
import { AGY_SDK_PROVIDER_ID } from './agy-agent.js';

export const EXECUTION_POOL_MCP_TOOLS = {
  GET: 'execution_pool_get',
  SET: 'execution_pool_set',
} as const;
export const EXECUTION_POOL_SDKS_HOOK_PATH = '/execution-pool-sdks' as const;
export const EXECUTION_POOL_DAEMON_RPC_PATH = '/execution-pool/tool' as const;
export const EXECUTION_POOL_DAEMON_TOOL_NAMES = [
  EXECUTION_POOL_MCP_TOOLS.GET,
  EXECUTION_POOL_MCP_TOOLS.SET,
] as const satisfies readonly ExecutionPoolMcpToolName[];
export type ExecutionPoolMcpToolName = typeof EXECUTION_POOL_MCP_TOOLS[keyof typeof EXECUTION_POOL_MCP_TOOLS];
const EXECUTION_POOL_DAEMON_TOOL_NAME_SET: ReadonlySet<string> = new Set(EXECUTION_POOL_DAEMON_TOOL_NAMES);
export function isExecutionPoolDaemonToolName(value: unknown): value is ExecutionPoolMcpToolName {
  return typeof value === 'string' && EXECUTION_POOL_DAEMON_TOOL_NAME_SET.has(value);
}
export const EXECUTION_POOL_MCP_ROLES = SUPERVISION_EXECUTION_POOL_ROLES;
export type ExecutionPoolMcpRole = SupervisionExecutionPoolRole;
export const EXECUTION_POOL_MCP_LIMITS = Object.freeze({ MAX_CONCURRENCY: 100, MAX_LEARNED_MODEL_TIERS: 100 });

export interface ExecutionPoolMcpEntry {
  model: string;
  provider: string;
  role: ExecutionPoolMcpRole;
  enabled: boolean;
}

export interface ExecutionPoolMcpLearnedModelTier {
  provider: string;
  model: string;
  tier: ModelTier;
  source?: string;
}

export interface ExecutionPoolMcpPatch {
  entries?: ExecutionPoolMcpEntry[];
  pool?: 'primary' | 'economy';
  primaryEntries?: ExecutionPoolMcpEntry[];
  economyEntries?: ExecutionPoolMcpEntry[];
  learnedModelTiers?: ExecutionPoolMcpLearnedModelTier[];
  autoPairingEnabled?: boolean;
  auditByDefault?: boolean;
  concurrencyCap?: number;
}

export function executionPoolEntryFromConfig(config: SupervisionExecutionConfig): ExecutionPoolMcpEntry {
  return {
    model: config.model,
    provider: config.agentType,
    role: config.role === 'executor' || config.role === 'auditor' ? config.role : 'both',
    enabled: true,
  };
}

export function configFromExecutionPoolEntry(entry: ExecutionPoolMcpEntry): SupervisionExecutionConfig {
  const rawProvider = entry.provider.trim();
  const rawModel = entry.model.trim();
  const lowerProvider = rawProvider.toLowerCase();
  let agentType: string;

  // 1. Explicit agent types / backends:
  // When entry.provider explicitly specifies an agentType/backend, preserve that choice.
  if (lowerProvider === 'agy' || lowerProvider === AGY_SDK_PROVIDER_ID) {
    agentType = AGY_SDK_PROVIDER_ID;
  } else if (lowerProvider === 'codex') {
    agentType = 'codex';
  } else if (lowerProvider === 'codex-sdk') {
    agentType = 'codex-sdk';
  } else if (lowerProvider === 'claude-code') {
    agentType = 'claude-code';
  } else if (lowerProvider === 'claude-code-sdk' || lowerProvider === CLAUDE_CODE_CLI_SDK_AGENT_TYPE) {
    agentType = lowerProvider;
  } else if (normalizeSharedContextRuntimeBackend(rawProvider)) {
    agentType = normalizeSharedContextRuntimeBackend(rawProvider)!;
  } else if (isSessionAgentType(lowerProvider)) {
    agentType = lowerProvider;
  } else if (lowerProvider === 'google') {
    // Generic provider-family alias 'google' always maps to Antigravity (agy-sdk).
    agentType = AGY_SDK_PROVIDER_ID;
  } else if (lowerProvider === 'openai') {
    // Generic provider-family alias: 'openai'
    agentType = (inferSharedContextRuntimeBackend(rawModel) === 'codex-sdk' || rawModel.includes('sol') || rawModel.includes('luna'))
      ? 'codex-sdk'
      : 'codex';
  } else {
    agentType = ({ anthropic: 'claude-code-sdk', qwen: 'qwen', deepseek: 'deepseek' } as Record<string, string>)[lowerProvider]
      ?? rawProvider;
  }

  const model = normalizeSupervisionExecutionModel(agentType, rawModel);
  const providerFamily = resolvePeerAuditProviderFamily({ agentType, providerId: rawProvider });
  const runtimeType = getSessionRuntimeType(agentType);
  const base = {
    agentType,
    providerFamily,
    runtimeType,
    model,
    ...(entry.role !== 'both' ? { role: entry.role } : {}),
  };
  return { ...base, capabilityId: buildSupervisionExecutionCapabilityId(base) };
}

function parseExecutionPoolEntries(rawEntries: unknown, fieldName: string): ExecutionPoolMcpEntry[] | { error: string } {
  if (!Array.isArray(rawEntries)) return { error: `${fieldName} must be an array` };
  const entries: ExecutionPoolMcpEntry[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `each item in ${fieldName} must be an object` };
    const item = raw as Record<string, unknown>;
    if (typeof item.model !== 'string' || !item.model.trim() || typeof item.provider !== 'string' || !item.provider.trim()) {
      return { error: 'each entry requires model and provider' };
    }
    const lowerProvider = item.provider.trim().toLowerCase();
    if (lowerProvider === 'gemini' || lowerProvider === 'gemini-sdk') {
      return { error: `unsupported provider: ${item.provider.trim()}` };
    }
    const role = item.role === undefined ? 'both' : item.role;
    if (!EXECUTION_POOL_MCP_ROLES.includes(role as ExecutionPoolMcpRole)) return { error: `invalid role: ${String(role)}` };
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') return { error: 'enabled must be boolean' };
    entries.push({ model: item.model.trim(), provider: item.provider.trim(), role: role as ExecutionPoolMcpRole, enabled: item.enabled !== false });
  }
  return entries;
}

function parseLearnedModelTiers(rawList: unknown): ExecutionPoolMcpLearnedModelTier[] | { error: string } {
  if (!Array.isArray(rawList)) return { error: 'learnedModelTiers must be an array' };
  if (rawList.length > EXECUTION_POOL_MCP_LIMITS.MAX_LEARNED_MODEL_TIERS) {
    return { error: `learnedModelTiers supports at most ${EXECUTION_POOL_MCP_LIMITS.MAX_LEARNED_MODEL_TIERS} entries` };
  }
  const learned: ExecutionPoolMcpLearnedModelTier[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'each learnedModelTiers item must be an object' };
    const item = raw as Record<string, unknown>;
    if (typeof item.provider !== 'string' || !item.provider.trim() || typeof item.model !== 'string' || !item.model.trim()) {
      return { error: 'each learnedModelTiers item requires provider and model' };
    }
    const lowerProvider = item.provider.trim().toLowerCase();
    if (lowerProvider === 'gemini' || lowerProvider === 'gemini-sdk') {
      return { error: `unsupported provider: ${item.provider.trim()}` };
    }
    if (typeof item.tier !== 'string' || !(MODEL_TIERS as readonly string[]).includes(item.tier)) {
      return { error: `invalid tier: ${String(item.tier)}` };
    }
    if (item.source !== undefined && (typeof item.source !== 'string' || !item.source.trim() || item.source.trim().length > 200)) {
      return { error: 'source must be a non-empty string up to 200 characters' };
    }
    learned.push({
      provider: item.provider.trim(),
      model: item.model.trim(),
      tier: item.tier as ModelTier,
      ...(typeof item.source === 'string' && item.source.trim() ? { source: item.source.trim() } : {}),
    });
  }
  return learned;
}

export function validateExecutionPoolMcpPatch(input: unknown): ExecutionPoolMcpPatch | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'input must be an object' };
  const value = input as Record<string, unknown>;
  const patch: ExecutionPoolMcpPatch = {};
  if (value.entries !== undefined && (value.primaryEntries !== undefined || value.economyEntries !== undefined)) {
    return { error: 'cannot combine entries with primaryEntries or economyEntries' };
  }
  if (value.entries !== undefined) {
    const parsed = parseExecutionPoolEntries(value.entries, 'entries');
    if ('error' in parsed) return parsed;
    patch.entries = parsed;
  }
  if (value.primaryEntries !== undefined) {
    const parsed = parseExecutionPoolEntries(value.primaryEntries, 'primaryEntries');
    if ('error' in parsed) return parsed;
    patch.primaryEntries = parsed;
  }
  if (value.economyEntries !== undefined) {
    const parsed = parseExecutionPoolEntries(value.economyEntries, 'economyEntries');
    if ('error' in parsed) return parsed;
    patch.economyEntries = parsed;
  }
  if (value.learnedModelTiers !== undefined) {
    const parsed = parseLearnedModelTiers(value.learnedModelTiers);
    if ('error' in parsed) return parsed;
    patch.learnedModelTiers = parsed;
  }
  if (value.pool !== undefined) {
    if (value.pool !== 'primary' && value.pool !== 'economy') return { error: 'pool must be primary or economy' };
    patch.pool = value.pool;
  }
  for (const key of ['autoPairingEnabled', 'auditByDefault'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') return { error: `${key} must be boolean` };
      patch[key] = value[key];
    }
  }
  if (value.concurrencyCap !== undefined) {
    if (typeof value.concurrencyCap !== 'number' || !Number.isInteger(value.concurrencyCap) || value.concurrencyCap < 1 || value.concurrencyCap > EXECUTION_POOL_MCP_LIMITS.MAX_CONCURRENCY) {
      return { error: `concurrencyCap must be an integer from 1 to ${EXECUTION_POOL_MCP_LIMITS.MAX_CONCURRENCY}` };
    }
    patch.concurrencyCap = value.concurrencyCap;
  }
  return patch;
}
